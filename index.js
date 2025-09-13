// index.js — MMORPG API (Express + Firestore + Admin Secret)
// ————————————————————————————————————————————————————————————
// Requisitos en package.json:
// {
//   "type": "module",
//   "scripts": { "start": "node index.js" },
//   "dependencies": {
//     "@google-cloud/firestore": "^7.7.0",
//     "cors": "^2.8.5",
//     "express": "^4.19.2"
//   }
// }

import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Sirve /public (admin.html, etc.)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ——— Configuración y nombres de colecciones —————————————
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123"; // Cambia en Cloud Run → Variables
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID   = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección (jugadores) bajo /world_progress/global
const QUESTS_SUBCOLL  = "quests";         // subcolección (misiones) bajo /world_progress/global

// ——— Helpers ———————————————————————————————————————————————
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

// Middleware: protege rutas de admin con header x-admin-secret
function checkAdmin(req, res, next) {
  const sent = (req.headers["x-admin-secret"] || "").toString();
  if (sent !== ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });
  next();
}

// ——— Home ————————————————————————————————————————————————
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global                          (admin)",
      "GET    /players?limit&startAfter",
      "GET    /players/:name",
      "PUT    /players/:name                   (admin)",
      "DELETE /players/:name                   (admin)",
      "POST   /players/addxp                   (admin) {name,xp}",
      "POST   /players/delete                  (admin) {name}",
      "GET    /leaderboard?limit               (xp desc)",
      "GET    /quests",
      "POST   /quests                          (admin)",
      "PATCH  /quests/:id                      (admin)",
      "DELETE /quests/:id                      (admin)",
      "POST   /dev/seed                        (admin) {count}",
      "POST   /dev/reset                       (admin)"
    ]
  });
});

// ——— GLOBAL ————————————————————————————————————————————————
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(data.current, 0),
      goal:    toInt(data.goal, 0),
      stage:   toInt(data.stage, 0)
    });
  } catch (e) {
    console.error("GET /global", e);
    sendErr(res, "failed_get_global");
  }
});

app.patch("/global", checkAdmin, async (req, res) => {
  try {
    const { current, goal, stage } = req.body || {};
    const payload = {};
    if (Number.isFinite(Number(current))) payload.current = toInt(current);
    if (Number.isFinite(Number(goal)))    payload.goal    = toInt(goal);
    if (Number.isFinite(Number(stage)))   payload.stage   = toInt(stage);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);
    await ref.set(payload, { merge: true });
    res.json((await ref.get()).data() || {});
  } catch (e) {
    console.error("PATCH /global", e);
    sendErr(res, "failed_patch_global");
  }
});

// ——— PLAYERS ———————————————————————————————————————————————
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

app.put("/players/:name", checkAdmin, async (req, res) => {
  try {
    const name  = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const level = toInt(req.body?.level, 1);
    const xp    = toInt(req.body?.xp, 0);

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name);

    await ref.set({ name, level, xp }, { merge: true });
    res.json((await ref.get()).data() || { name, level, xp });
  } catch (e) {
    console.error("PUT /players/:name", e);
    sendErr(res, "failed_upsert_player");
  }
});

app.delete("/players/:name", checkAdmin, async (req, res) => {
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

// Sumar XP rápido
app.post("/players/addxp", checkAdmin, async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return sendErr(res, "name_required", 400);
    const delta = toInt(xp, 0);

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(String(name).trim());

    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);

    await ref.update({ xp: FieldValue.increment(delta) });
    res.json({ ok: true, name, xp: (await ref.get()).data().xp });
  } catch (e) {
    console.error("POST /players/addxp", e);
    sendErr(res, "failed_add_xp");
  }
});

// Borrar jugador por nombre (POST para UI sencilla)
app.post("/players/delete", checkAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(String(name).trim());

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, msg: "not_found" });

    await ref.delete();
    res.json({ ok: true, deleted: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— LEADERBOARD ————————————————————————————————————————————
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);
    const qs = await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();

    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ——— QUESTS (misiones) ——————————————————————————————————————
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .orderBy("createdAt", "desc")
      .get();

    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /quests", e);
    sendErr(res, "failed_list_quests");
  }
});

app.post("/quests", checkAdmin, async (req, res) => {
  try {
    const title  = String(req.body?.title || "").trim();
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
    res.json({ id: ref.id, ...((await ref.get()).data() || {}) });
  } catch (e) {
    console.error("POST /quests", e);
    sendErr(res, "failed_create_quest");
  }
});

app.patch("/quests/:id", checkAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);

    const payload = {};
    if (typeof req.body?.title  === "string") payload.title  = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();

    const ref = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .doc(id);

    await ref.set(payload, { merge: true });
    res.json({ id, ...((await ref.get()).data() || {}) });
  } catch (e) {
    console.error("PATCH /quests/:id", e);
    sendErr(res, "failed_patch_quest");
  }
});

app.delete("/quests/:id", checkAdmin, async (req, res) => {
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

// ——— DEV (semillas y reset) ————————————————————————————————
app.post("/dev/seed", checkAdmin, async (req, res) => {
  try {
    const count = Math.max(1, Math.min(toInt(req.body?.count ?? req.query.count, 25), 200));
    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL);

    // Inserción secuencial (segura para móviles/límites)
    for (let i = 1; i <= count; i++) {
      const name  = `Player${String(i).padStart(3, "0")}`;
      const level = 1 + Math.floor(Math.random() * 50);
      const xp    = Math.floor(Math.random() * 5000);
      await col.doc(name).set({ name, level, xp }, { merge: true });
    }
    res.json({ ok: true, createdOrUpdated: count });
  } catch (e) {
    console.error("POST /dev/seed", e);
    sendErr(res, "failed_seed");
  }
});

app.post("/dev/reset", checkAdmin, async (_req, res) => {
  try {
    const pCol = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL);
    const qCol = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);

    const pSnap = await pCol.get();
    const qSnap = await qCol.get();

    const pBatch = db.batch();
    pSnap.forEach(d => pBatch.delete(d.ref));
    await pBatch.commit();

    const qBatch = db.batch();
    qSnap.forEach(d => qBatch.delete(d.ref));
    await qBatch.commit();

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .set({ current: 0, goal: 10000, stage: 0 }, { merge: true });

    res.json({ ok: true, playersDeleted: pSnap.size, questsDeleted: qSnap.size });
  } catch (e) {
    console.error("POST /dev/reset", e);
    sendErr(res, "failed_reset");
  }
});

// ——— Arranque ——————————————————————————————————————————————
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
