// index.js
const express = require("express");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Inicializa Firebase Admin con credenciales del entorno de Cloud Run
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const app = express();
app.use(express.json()); // para leer JSON en POST

const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
// En tu estructura, la subcolección de jugadores también se llama "world_progress"
const PLAYERS_SUBCOLL = "world_progress";

// Home
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: ["/world", "POST /progress", "POST /players"],
  });
});

// GET /world → estado global + jugadores
app.get("/world", async (_req, res) => {
  try {
    const globalRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);
    const snap = await globalRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "No existe world_progress/global" });
    }

    const globalData = snap.data();

    const playersSnap = await globalRef.collection(PLAYERS_SUBCOLL).get();
    const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json({ global: globalData, players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error leyendo Firestore" });
  }
});

// POST /progress  { amount: number }
// Suma "amount" al campo global.current de forma atómica
app.post("/progress", async (req, res) => {
  try {
    const amount = Number(req.body?.amount ?? 0);
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: "amount debe ser un número distinto de 0" });
    }

    const globalRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(globalRef);
      if (!snap.exists) {
        throw new Error("No existe world_progress/global");
      }
      tx.update(globalRef, { current: FieldValue.increment(amount) });
    });

    // Devuelve el nuevo estado
    const updated = await globalRef.get();
    res.json({ ok: true, global: updated.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /players  { id?: string, name: string, level?: number }
// Crea/actualiza jugador en la subcolección world_progress debajo del doc global
app.post("/players", async (req, res) => {
  try {
    const { id, name, level = 1 } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name es obligatorio (string)" });
    }
    if (!Number.isFinite(Number(level)) || Number(level) < 1) {
      return res.status(400).json({ error: "level debe ser número >= 1" });
    }

    const collRef = db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL);

    const docRef = id ? collRef.doc(String(id)) : collRef.doc(); // crea ID si no viene
    const data = { name, level: Number(level) };

    await docRef.set(data, { merge: true });

    res.json({ ok: true, id: docRef.id, player: { id: docRef.id, ...data } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error guardando jugador" });
  }
});

// Arranque
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`mmorpgapi escuchando en ${PORT}`);
});
