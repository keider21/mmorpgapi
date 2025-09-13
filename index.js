  // index.js
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

// ──────────────────────────────
// Config básica
// ──────────────────────────────
const app = express();
const db = new Firestore();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: true }));
app.use(express.json());

// Sirve archivos estáticos (admin.html, etc.) desde /public
app.use(express.static("public"));

// ──────────────────────────────
/**
 * Estructura de Firestore esperada:
 * world_progress (COL)
 *   └── global (DOC)  ->  { current: number, goal: number, stage: number }
 *        └── world_progress (SUBCOL de jugadores)
 *             └── {playerId} (DOC) -> { name: string, level: number }
 */
// ──────────────────────────────
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress";

// Helpers
const globalRef = () => db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);
const playersRef = () => globalRef().collection(PLAYERS_SUBCOLL);

// ──────────────────────────────
// Rutas
// ──────────────────────────────

// Salud/estado
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: ["/world", "/world/progress/increment (POST)"]
  });
});

// Devuelve el estado global + lista de jugadores
app.get("/world", async (_req, res) => {
  try {
    const [globalSnap, playersSnap] = await Promise.all([
      globalRef().get(),
      playersRef().get()
    ]);

    const globalData = globalSnap.exists ? globalSnap.data() : null;
    const players = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ global: globalData, players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error leyendo Firestore", details: err.message });
  }
});

// Incrementa el progreso global y actualiza el jugador
// Body esperado: { playerId: "abc123", name: "Jugador1", amount: 1 }
app.post("/world/progress/increment", async (req, res) => {
  try {
    const { playerId, name, amount } = req.body || {};
    const inc = Number(amount ?? 1);
    if (!playerId || !name) {
      return res.status(400).json({ error: "Faltan 'playerId' y/o 'name'" });
    }
    if (!Number.isFinite(inc)) {
      return res.status(400).json({ error: "'amount' debe ser numérico" });
    }

    // Transacción: incrementa global.current y sube nivel del jugador
    const result = await db.runTransaction(async (tx) => {
      // Global
      const gRef = globalRef();
      const gSnap = await tx.get(gRef);
      if (!gSnap.exists) {
        // inicializa si no existe
        tx.set(gRef, { current: 0, goal: 10000, stage: 0 }, { merge: true });
      }
      tx.update(gRef, { current: FieldValue.increment(inc) });

      // Player
      const pRef = playersRef().doc(playerId);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists) {
        tx.set(pRef, { name, level: 1 }, { merge: true });
      } else {
        tx.update(pRef, { level: FieldValue.increment(inc) });
      }

      return { ok: true };
    });

    res.json({ ok: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error actualizando progreso", details: err.message });
  }
});

// ──────────────────────────────
// Arrancar servidor
// ──────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
