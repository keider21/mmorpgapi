// index.js
import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";

const app = express();

// CORS: permite nuestro header personalizado
app.use(cors({
  origin: true,
  allowedHeaders: ["Content-Type", "x-admin-secret"],
  exposedHeaders: [],
  credentials: false
}));
app.use(express.json());

// servir /admin.html y futuros assets desde /public
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ------------ CONFIG / CONSTANTES ----------------
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const QUESTS_SUBCOLL = "quests";

// ------------ MIDDLEWARE CLAVE -------------------
function requireSecret(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: "admin_secret_not_set" });
  }
  const headerSecret = (req.get("x-admin-secret") || "").trim();
  if (headerSecret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

// ------------ UTILS ------------------------------
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

// ------------ DEBUG ------------------------------
// No revela claves; solo indica si existe la env y si coincide
app.get("/__debug/secret", (req, res) => {
  const headerSecret = (req.get("x-admin-secret") || "").trim();
  res.json({
    hasEnv: !!ADMIN_SECRET,
    headerPresent: headerSecret.length > 0,
    match: ADMIN_SECRET && headerSecret === ADMIN_SECRET
  });
});

// ------------ HOME -------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global                          (req. clave)",
      "GET    /players?limit&startAfter",
      "GET    /players/:name",
      "PUT    /players/:name                   (req. clave)",
      "DELETE /players/:name                   (req. clave)",
      "GET    /leaderboard?limit",
      "GET    /quests",
      "POST   /quests                          (req. clave)",
      "PATCH  /quests/:id                      (req. clave)",
      "DELETE /quests/:id                      (req. clave)",
      "POST   /players/addxp                   (req. clave)",
      "POST   /players/delete                  (req. clave)",
      "GET    /__debug/secret"
    ]
  });
});

// ------------ GLOBAL -----------------------------
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(data.current, 0),
      goal: toInt(data.goal, 0),
      stage: toInt(data.stage, 0)
    });
  } catch (e) {
    console.error("GET /global", e);
    sendErr(res, "failed_get_global");
  }
});

app.patch("/global", requireSecret, async (req, res) => {
  try {
    const { current, goal, stage } = req.body || {};
    const payload = {};
    if (Number.isFinite(Number(current))) payload.current = toInt(current);
    if (Number.isFinite(Number(goal))) payload.goal = toInt(goal);
    if (Number.isFinite(Number(stage))) payload.stage = toInt(stage);

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).set(payload, { merge: true });
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    res.json(snap.data() || {});
  } catch (e) {
    console.error("PATCH /global", e);
    sendErr(res, "failed_patch_global");
  }
});

// ------------ PLAYERS ----------------------------
// lista por nombre (alfabético)
app.get("/players", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 25);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("name")
      .limit(Math.min(Math.max(limit, 1), 100));

    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken = items.length ? (items[items.length - 1].name || items[items.length - 1].id) : null;

    res.json({ items, nextPageToken });
  } catch (e) {
    console.error("GET /players", e);
    sendErr(res, "failed_list_players");
  }
});

app.get("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name);

    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);
    res.json(snap.data());
  } catch (e) {
    console.error("GET /players/:name", e);
    sendErr(res, "failed_get_player");
  }
});

app.put("/players/:name", requireSecret, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name);

    await ref.set({ name, level, xp }, { merge: true });
    const snap = await ref.get();
    res.json(snap.data() || { name, level, xp });
  } catch (e) {
    console.error("PUT /players/:name", e);
    sendErr(res, "failed_upsert_player");
  }
});

app.delete("/players/:name", requireSecret, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name)
      .delete();

    res.json({ ok: true, name });
  } catch (e) {
    console.error("DELETE /players/:name", e);
    sendErr(res, "failed_delete_player");
  }
});

// top N por xp
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);
    const q = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc")
      .limit(Math.min(Math.max(limit, 1), 100));

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ------------ QUESTS -----------------------------
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .orderBy("createdAt", "desc")
      .get();

    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /quests", e);
    sendErr(res, "failed_list_quests");
  }
});

app.post("/quests", requireSecret, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res, "title_required", 400);

    const col = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL);

    let ref;
    const id = String(req.body?.id || "").trim();
    if (id) {
      ref = col.doc(id);
      await ref.set({ title, status, updatedAt: new Date().toISOString() }, { merge: true });
    } else {
      ref = await col.add({ title, status, createdAt: new Date().toISOString() });
    }

    const snap = await ref.get();
    res.json({ id: ref.id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("POST /quests", e);
    sendErr(res, "failed_create_quest");
  }
});

app.patch("/quests/:id", requireSecret, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);

    const payload = {};
    if (typeof req.body?.title === "string") payload.title = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .doc(id);

    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    res.json({ id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PATCH /quests/:id", e);
    sendErr(res, "failed_patch_quest");
  }
});

app.delete("/quests/:id", requireSecret, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);

    await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .doc(id)
      .delete();

    res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /quests/:id", e);
    sendErr(res, "failed_delete_quest");
  }
});

// utilidades admin
app.post("/players/addxp", requireSecret, async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: "name requerido" });
    const delta = Number(xp) || 0;

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name);

    await ref.set({ name }, { merge: true });
    // Firestore JS SDK de servidor no tiene FieldValue aquí, hacemos lectura/actualización manual
    const snap = await ref.get();
    const curr = snap.exists && snap.data()?.xp ? Number(snap.data().xp) : 0;
    const nuevoXP = curr + delta;
    await ref.set({ xp: nuevoXP }, { merge: true });

    res.json({ ok: true, name, xp: nuevoXP });
  } catch (e) {
    console.error("POST /players/addxp", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/players/delete", requireSecret, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name requerido" });

    await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name)
      .delete();

    res.json({ ok: true, deleted: 1, name });
  } catch (e) {
    console.error("POST /players/delete", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------ ARRANQUE ---------------------------
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
