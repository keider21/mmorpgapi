// index.js
// API para mmorpgapi — Express + Firestore (Google Cloud)

// ─────────────────────────────────────────────────────────────────────────────
// Imports
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

// ─────────────────────────────────────────────────────────────────────────────
// App base
const app = express();
app.use(cors({ origin: true }));   // CORS habilitado
app.use(express.json());           // Leer JSON en requests

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// Rutas/colecciones en Firestore
const ROOT_COLLECTION = "world_progress"; // colección raíz
const GLOBAL_DOC_ID   = "global";         // documento global
const PLAYERS_SUBCOLL = "world_progress"; // subcolección de jugadores (dentro de /global)

// Atajos
const globalDocRef  = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);
const playersColRef = globalDocRef.collection(PLAYERS_SUBCOLL);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
const ok = (res, data) => res.status(200).json({ ok: true, ...data });
const fail = (res, code, message, extra = {}) =>
  res.status(code).json({ ok: false, error: message, ...extra });

// Calcula % de progreso
function buildProgress(current, goal, stage) {
  const g = Number(goal) || 0;
  const c = Number(current) || 0;
  const s = Number(stage) || 0;
  const pct = g > 0 ? Math.min(100, Math.max(0, (c / g) * 100)) : 0;
  return {
    current: c,
    goal: g,
    stage: s,
    percent: Number(pct.toFixed(2)),
    remaining: g > c ? g - c : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS

// Home / ping
app.get("/", (_req, res) => {
  ok(res, {
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: ["/world", "/progress", "/players", "/players/:id"],
  });
});

// GET /world  → datos crudos del documento global
app.get("/world", async (_req, res) => {
  try {
    const snap = await globalDocRef.get();
    if (!snap.exists) return fail(res, 404, "Documento global no encontrado");
    ok(res, { id: snap.id, data: snap.data() });
  } catch (e) {
    fail(res, 500, "Error leyendo world", { detail: String(e) });
  }
});

// GET /progress → progreso calculado (porcentaje, restantes, etc.)
app.get("/progress", async (_req, res) => {
  try {
    const snap = await globalDocRef.get();
    if (!snap.exists) return fail(res, 404, "Documento global no encontrado");
    const { current = 0, goal = 0, stage = 0 } = snap.data() || {};
    ok(res, { progress: buildProgress(current, goal, stage) });
  } catch (e) {
    fail(res, 500, "Error leyendo progreso", { detail: String(e) });
  }
});

// POST /progress/increment { delta: number }
// Incrementa el campo "current" de forma atómica
app.post("/progress/increment", async (req, res) => {
  try {
    const delta = Number(req.body?.delta ?? 1);
    if (!Number.isFinite(delta))
      return fail(res, 400, "delta debe ser numérico");

    await globalDocRef.set({ current: FieldValue.increment(delta) }, { merge: true });

    const snap = await globalDocRef.get();
    const { current = 0, goal = 0, stage = 0 } = snap.data() || {};
    ok(res, {
      message: `current incrementado en ${delta}`,
      progress: buildProgress(current, goal, stage),
    });
  } catch (e) {
    fail(res, 500, "Error incrementando progreso", { detail: String(e) });
  }
});

// POST /progress/set  { current?, goal?, stage? }
// Actualiza cualquier combinación de los campos del global
app.post("/progress/set", async (req, res) => {
  try {
    const payload = {};
    ["current", "goal", "stage"].forEach((k) => {
      if (k in req.body) payload[k] = Number(req.body[k]);
    });
    if (Object.keys(payload).length === 0)
      return fail(res, 400, "Envía al menos uno de: current, goal, stage");

    await globalDocRef.set(payload, { merge: true });

    const snap = await globalDocRef.get();
    const { current = 0, goal = 0, stage = 0 } = snap.data() || {};
    ok(res, { message: "Progreso actualizado", progress: buildProgress(current, goal, stage) });
  } catch (e) {
    fail(res, 500, "Error actualizando progreso", { detail: String(e) });
  }
});

// GET /players  → lista de jugadores (limitable por ?limit=)
// Devuelve array [{ id, ...data }]
app.get("/players", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    const snap = await playersColRef.limit(limit).get();
    const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    ok(res, { count: players.length, players });
  } catch (e) {
    fail(res, 500, "Error listando jugadores", { detail: String(e) });
  }
});

// GET /players/:id → jugador por id
app.get("/players/:id", async (req, res) => {
  try {
    const doc = await playersColRef.doc(req.params.id).get();
    if (!doc.exists) return fail(res, 404, "Jugador no encontrado");
    ok(res, { id: doc.id, ...doc.data() });
  } catch (e) {
    fail(res, 500, "Error leyendo jugador", { detail: String(e) });
  }
});

// POST /players  { id?, name, level }
// - Si envías id → hace upsert sobre ese id.
// - Si no envías id → crea uno nuevo.
app.post("/players", async (req, res) => {
  try {
    const { id, name, level } = req.body || {};
    if (!name) return fail(res, 400, "name es obligatorio");
    const lvl = Number(level ?? 1);

    let ref;
    if (id) {
      ref = playersColRef.doc(id);
      await ref.set({ name, level: lvl }, { merge: true });
    } else {
      ref = await playersColRef.add({ name, level: lvl });
    }
    const saved = await ref.get();
    ok(res, { message: "Jugador guardado", id: ref.id, data: saved.data() });
  } catch (e) {
    fail(res, 500, "Error guardando jugador", { detail: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
app.listen(PORT, "0.0.0.0", () => {
  console.log(`mmorpgapi escuchando en :${PORT}`);
});
