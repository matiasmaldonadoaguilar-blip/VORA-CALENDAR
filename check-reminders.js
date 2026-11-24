import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length > 0) return admin.app();

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON en Vercel");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function getDateAndTimeInZone(timeZone) {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  return {
    dateStr: dateFormatter.format(now), // YYYY-MM-DD
    timeStr: timeFormatter.format(now)  // HH:MM
  };
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export default async function handler(req, res) {
  try {
    // Opcional: proteger con secreto si llamas desde un cron externo
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.authorization || "";
      const querySecret = req.query?.secret;
      if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
        return res.status(401).json({ error: "No autorizado" });
      }
    }

    initAdmin();
    const db = admin.firestore();
    const messaging = admin.messaging();

    // 1. Obtener dispositivos registrados
    const devicesSnap = await db.collection("vora_devices").get();
    const devices = [];
    devicesSnap.forEach((doc) => {
      const data = doc.data();
      if (data?.token) {
        devices.push({
          id: doc.id,
          token: data.token,
          timeZone: data.timeZone || "America/La_Paz"
        });
      }
    });

    if (devices.length === 0) {
      return res.status(200).json({ ok: true, message: "No hay dispositivos registrados en vora_devices", sent: 0 });
    }

    // Usamos la zona horaria del primer dispositivo o America/La_Paz por defecto
    const activeTimeZone = devices[0].timeZone || "America/La_Paz";
    const { dateStr, timeStr } = getDateAndTimeInZone(activeTimeZone);
    const currentMinutes = timeToMinutes(timeStr);

    // 2. Buscar tareas de hoy pendientes y no notificadas
    const tasksSnap = await db
      .collection("vora_tasks")
      .where("date", "==", dateStr)
      .where("completed", "==", false)
      .where("notified", "==", false)
      .get();

    let sentCount = 0;

    for (const taskDoc of tasksSnap.docs) {
      const task = taskDoc.data();
      if (!task.time || task.time === "Sin hora") continue;

      const taskMinutes = timeToMinutes(task.time);
      if (Number.isNaN(taskMinutes)) continue;

      // Dispara si ya llegó la hora y no han pasado más de 5 minutos
      const diff = currentMinutes - taskMinutes;
      if (diff >= 0 && diff <= 5) {
        const tokens = devices.map((d) => d.token);

        const response = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: "📌 Toca empezar — VORA",
            body: `${task.title} (${task.time})`
          },
          data: {
            taskId: taskDoc.id,
            time: task.time
          },
          webpush: {
            headers: {
              Urgency: "high"
            },
            notification: {
              title: "📌 Toca empezar — VORA",
              body: `${task.title} (${task.time})`,
              requireInteraction: false
            }
          }
        });

        // Limpiar tokens inválidos si alguno expiró
        response.responses.forEach((r, idx) => {
          if (!r.success) {
            const errCode = r.error?.code || "";
            if (
              errCode === "messaging/registration-token-not-registered" ||
              errCode === "messaging/invalid-registration-token"
            ) {
              db.collection("vora_devices").doc(devices[idx].id).delete().catch(() => {});
            }
          }
        });

        await taskDoc.ref.update({ notified: true });
        sentCount += 1;
      }
    }

    return res.status(200).json({
      ok: true,
      date: dateStr,
      time: timeStr,
      timeZone: activeTimeZone,
      sentTasks: sentCount
    });
  } catch (err) {
    console.error("Error en check-reminders:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}