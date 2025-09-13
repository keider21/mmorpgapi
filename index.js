// MMORPG API - limpio y estable para Cloud Run (Node 18+)
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static("public")); // sirve /public (admin.html, player.html, etc.)

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// Si pones una variable de entorno ADMIN_SECRET, se exigirá en rutas de admin.
// Si no la pones, esas rutas quedan abiertas (útil para pruebas).
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const requireAdmin = (req, res, next) => {
  if (!ADMIN_SECRET) return next();
  const key = req.header("x-admin-secret") || "";
  if (key === ADMIN_SECRET) return next();
  return res.status(403).json({ error: "forbidden" });
};

// --- nombres en Firestore ---
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección de jugadores
const QUESTS_SUBCOLL = "quests";

const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

// Home
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global {current?, goal?, stage?}",
      "GET    /players?limit&startAfter",
      "GET    /players/:name",
      "PUT    /players/:name {level?, xp?}",
      "DELETE /players/:name",
      "GET    /leaderboard?limit=10",
      "POST   /players/addxp {name, xp}",
      "GET    /quests",
      "POST   /quests {title, status}",
      "PATCH  /quests/:id {title?, status?}",
      "DELETE /quests/:id"
    ]
  });
});

// -------- GLOBAL ----------
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(d.current, 0),
      goal: toInt(d.goal, 10000),
      stage: toInt(d.stage, 0)
    });
  } catch (e) {
    console.error("GET /global", e);
    res.status(500).json({ error: "failed_get_global" });
  }
});

app.patch("/global", requireAdmin, async (req, res) => {
  try {
    const payload = {};
    ["current", "goal", "stage"].forEach(k => {
      if (req.body?.[k] !== undefined) payload[k] = toInt(req.body[k]);
    });
    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).set(payload, { merge: true });
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    res.json(snap.data() || {});
  } catch (e) {
    console.error("PATCH /global", e);
    res.status(500).json({ error: "failed_patch_global" });
  }
});

// -------- PLAYERS ----------
app.get("/players", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 25), 1), 100);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL)
      .orderBy("name").limit(limit);
    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken = items.length ? (items[items.length - 1].name || items[items.length - 1].id) : null;

    res.json({ items, nextPageToken });
  } catch (e) {
    console.error("GET /players", e);
    res.status(500).json({ error: "failed_list_players" });
  }
});

app.get("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });

    res.json(snap.data());
  } catch (e) {
    console.error("GET /players/:name", e);
    res.status(500).json({ error: "failed_get_player" });
  }
});

// Upsert jugador (sin admin para permitir flujo del jugador)
app.put("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name);
    await ref.set({ name, level, xp }, { merge: true });

    const snap = await ref.get();
    res.json({ id: ref.id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PUT /players/:name", e);
    res.status(500).json({ error: "failed_upsert_player" });
  }
});

app.delete("/players/:name", requireAdmin, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name).delete();
    res.json({ ok: true, name });
  } catch (e) {
    console.error("DELETE /players/:name", e);
    res.status(500).json({ error: "failed_delete_player" });
  }
});

// ÚNICO leaderboard (sin duplicados)
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
    const qs = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc").limit(limit).get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    res.status(500).json({ error: "failed_leaderboard" });
  }
});

// Sumar XP rápido
app.post("/players/addxp", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const delta = toInt(req.body?.xp, 0);
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name);
    // asegúralo existente
    await ref.set({ name, level: 1, xp: 0 }, { merge: true });
    await ref.update({ xp: FieldValue.increment(delta) });

    const snap = await ref.get();
    res.json({ ok: true, ...(snap.data() || {}) });
  } catch (e) {
    console.error("POST /players/addxp", e);
    res.status(500).json({ error: "failed_add_xp" });
  }
});

// -------- QUESTS ----------
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL)
      .orderBy("createdAt", "desc").get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /quests", e);
    res.status(500).json({ error: "failed_list_quests" });
  }
});

app.post("/quests", requireAdmin, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return res.status(400).json({ error: "title_required" });

    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);
    const ref = await col.add({ title, status, createdAt: new Date().toISOString() });
    const snap = await ref.get();
    res.json({ id: ref.id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("POST /quests", e);
    res.status(500).json({ error: "failed_create_quest" });
  }
});

app.patch("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const payload = {};
    if (typeof req.body?.title === "string") payload.title = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id);
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    res.json({ id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PATCH /quests/:id", e);
    res.status(500).json({ error: "failed_patch_quest" });
  }
});

app.delete("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id).delete();
    res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /quests/:id", e);
    res.status(500).json({ error: "failed_delete_quest" });
  }
});

// ¡IMPORTANTE! escuchar el puerto
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
