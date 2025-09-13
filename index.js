// index.js (API limpia y ampliada)
import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Si tienes admin.html en /public, lo servimos:
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ---- Nombres de colecciones/documentos ----
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID   = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const QUESTS_SUBCOLL  = "quests";         // subcolección bajo /world_progress/global

// Helpers
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

// ---- Home -------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global            {current?, goal?, stage?}",
      "GET    /players           ?limit?&startAfter?   (lista por name)",
      "GET    /players/:name",
      "PUT    /players/:name     {level?, xp?}",
      "DELETE /players/:name",
      "POST   /players/addxp     {name, xp}",
      "POST   /players/delete    {name}",
      "GET    /leaderboard       ?limit=10             (xp desc)",
      "GET    /quests",
      "POST   /quests            {id?, title, status}",
      "PATCH  /quests/:id        {title?, status?}",
      "DELETE /quests/:id"
    ]
  });
});

// ---- GLOBAL -----------------------------------------------------------------
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(data.current, 0),
      goal:    toInt(data.goal, 0),
      stage:   toInt(data.stage, 0),
    });
  } catch (e) { console.error("GET /global", e); sendErr(res,"failed_get_global"); }
});

app.patch("/global", async (req, res) => {
  try {
    const { current, goal, stage } = req.body || {};
    const payload = {};
    if (Number.isFinite(Number(current))) payload.current = toInt(current);
    if (Number.isFinite(Number(goal)))    payload.goal    = toInt(goal);
    if (Number.isFinite(Number(stage)))   payload.stage   = toInt(stage);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID);
    await ref.set(payload, { merge: true });
    res.json((await ref.get()).data() || {});
  } catch (e) { console.error("PATCH /global", e); sendErr(res,"failed_patch_global"); }
});

// ---- PLAYERS ----------------------------------------------------------------
app.get("/players", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 25);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("name")
      .limit(Math.min(Math.max(limit,1),100));

    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data()||{}) }));
    const nextPageToken = items.length ? (items[items.length-1].name || items[items.length-1].id) : null;
    res.json({ items, nextPageToken });
  } catch (e) { console.error("GET /players", e); sendErr(res,"failed_list_players"); }
});

app.get("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name||"").trim();
    if (!name) return sendErr(res,"name_required",400);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    const snap = await ref.get();
    if (!snap.exists) return sendErr(res,"not_found",404);
    res.json(snap.data());
  } catch (e) { console.error("GET /players/:name", e); sendErr(res,"failed_get_player"); }
});

app.put("/players/:name", async (req, res) => {
  try {
    const name  = String(req.params.name||"").trim();
    if (!name) return sendErr(res,"name_required",400);
    const level = toInt(req.body?.level, 1);
    const xp    = toInt(req.body?.xp, 0);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    await ref.set({ name, level, xp }, { merge: true });
    res.json((await ref.get()).data() || { name, level, xp });
  } catch (e) { console.error("PUT /players/:name", e); sendErr(res,"failed_upsert_player"); }
});

app.delete("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name||"").trim();
    if (!name) return sendErr(res,"name_required",400);

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name).delete();

    res.json({ ok:true, name });
  } catch (e) { console.error("DELETE /players/:name", e); sendErr(res,"failed_delete_player"); }
});

// Sumar XP rápido a un jugador
app.post("/players/addxp", async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return sendErr(res,"name_required",400);
    const delta = toInt(xp, 0);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(String(name).trim());

    const snap = await ref.get();
    if (!snap.exists) return sendErr(res,"not_found",404);

    await ref.update({ xp: Firestore.FieldValue.increment(delta) });
    res.json({ ok:true, name, xp: (await ref.get()).data().xp });
  } catch (e) { console.error("POST /players/addxp", e); sendErr(res,"failed_add_xp"); }
});

// Borrar jugador por nombre (POST para facilitar desde admin.html)
app.post("/players/delete", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return sendErr(res,"name_required",400);

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(String(name).trim());

    const snap = await ref.get();
    if (!snap.exists) return sendErr(res,"not_found",404);

    await ref.delete();
    res.json({ ok:true, name });
  } catch (e) { console.error("POST /players/delete", e); sendErr(res,"failed_delete_player"); }
});

// ---- LEADERBOARD ------------------------------------------------------------
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);
    const qs = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp","desc")
      .limit(Math.min(Math.max(limit,1),100))
      .get();

    res.json(qs.docs.map(d => ({ id:d.id, ...(d.data()||{}) })));
  } catch (e) { console.error("GET /leaderboard", e); sendErr(res,"failed_leaderboard"); }
});

// ---- QUESTS (misiones) ------------------------------------------------------
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(QUESTS_SUBCOLL)
      .orderBy("createdAt","desc")
      .get();

    res.json(qs.docs.map(d => ({ id:d.id, ...(d.data()||{}) })));
  } catch (e) { console.error("GET /quests", e); sendErr(res,"failed_list_quests"); }
});

app.post("/quests", async (req, res) => {
  try {
    const title  = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res,"title_required",400);

    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);
    let ref;
    const id = String(req.body?.id || "").trim();
    if (id) {
      ref = col.doc(id);
      await ref.set({ title, status, updatedAt: new Date().toISOString() }, { merge:true });
    } else {
      ref = await col.add({ title, status, createdAt: new Date().toISOString() });
    }
    res.json({ id: ref.id, ...((await ref.get()).data()||{}) });
  } catch (e) { console.error("POST /quests", e); sendErr(res,"failed_create_quest"); }
});

app.patch("/quests/:id", async (req, res) => {
  try {
    const id = String(req.params.id||"").trim();
    if (!id) return sendErr(res,"id_required",400);

    const payload = {};
    if (typeof req.body?.title  === "string") payload.title  = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id);
    await ref.set(payload, { merge:true });
    res.json({ id, ...((await ref.get()).data()||{}) });
  } catch (e) { console.error("PATCH /quests/:id", e); sendErr(res,"failed_patch_quest"); }
});

app.delete("/quests/:id", async (req, res) => {
  try {
    const id = String(req.params.id||"").trim();
    if (!id) return sendErr(res,"id_required",400);

    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id).delete();
    res.json({ ok:true, id });
  } catch (e) { console.error("DELETE /quests/:id", e); sendErr(res,"failed_delete_quest"); }
});

// ---- Arranque ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
