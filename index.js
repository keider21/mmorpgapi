// index.js (API ampliada)
import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Sirve admin.html y futuros assets desde /public (si los agregas)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ---- Nombres de colecciones/documentos ----
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const QUESTS_SUBCOLL = "quests";          // subcolección bajo /world_progress/global

// Util: normaliza enteros
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};

// Util: responde error uniforme
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
      "GET    /leaderboard       ?limit=10             (ordena por xp desc)",
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
      goal: toInt(data.goal, 0),
      stage: toInt(data.stage, 0)
    });
  } catch (e) {
    console.error("GET /global", e);
    sendErr(res, "failed_get_global");
  }
});

app.patch("/global", async (req, res) => {
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

// ---- PLAYERS ----------------------------------------------------------------
// Lista por nombre (alfabético). Paginación simple con startAfter=últimoName.
app.get("/players", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 25);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("name")
      .limit(Math.min(Math.max(limit, 1), 100));

    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken = items.length ? items[items.length - 1].name || items[items.length - 1].id : null;

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

    const ref = db
      .collection(ROOT_COLLECTION)
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

// Crea/actualiza por nombre
app.put("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);

    const ref = db
      .collection(ROOT_COLLECTION)
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

app.delete("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    await db
      .collection(ROOT_COLLECTION)
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

// ---- LEADERBOARD ------------------------------------------------------------
// Top N por xp desc (si empatas xp, opcionalmente ordena por level desc).
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);

    const q = db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc")
      .limit(Math.min(Math.max(limit, 1), 100));

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    // Si Firestore pide índice (por mezcla de orderBy/where), crea el índice y reintenta
    sendErr(res, "failed_leaderboard");
  }
});

// ---- QUESTS (misiones) ------------------------------------------------------
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db
      .collection(ROOT_COLLECTION)
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

// { id?, title, status }  -> si no mandas id, se autogenera
app.post("/quests", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res, "title_required", 400);

    const col = db
      .collection(ROOT_COLLECTION)
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

app.patch("/quests/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);

    const payload = {};
    if (typeof req.body?.title === "string") payload.title = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();

    const ref = db
      .collection(ROOT_COLLECTION)
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

app.delete("/quests/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);

    await db
      .collection(ROOT_COLLECTION)
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
// ================= NUEVAS RUTAS =================

// 1) Borrar jugador por "name"
app.post("/players/delete", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name requerido" });

    const snap = await db
      .collection("world_progress")
      .doc("global")
      .collection("world_progress")
      .where("name", "==", name)
      .get();

    if (snap.empty) return res.status(404).json({ ok: false, msg: "no existe" });

    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    res.json({ ok: true, deleted: snap.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Top 10 por XP
app.get("/leaderboard", async (_req, res) => {
  try {
    const qs = await db
      .collection("world_progress")
      .doc("global")
      .collection("world_progress")
      .orderBy("xp", "desc")
      .limit(10)
      .get();

    const top = qs.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(top);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3) Sumar XP rápido a un jugador
app.post("/players/addxp", async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: "name requerido" });
    const delta = Number(xp) || 0;

    const coll = db.collection("world_progress").doc("global").collection("world_progress");
    const snap = await coll.where("name","==",name).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "jugador no existe" });

    const ref = snap.docs[0].ref;
    await ref.update({ xp: db.constructor.FieldValue.increment(delta) });

    const nuevo = (await ref.get()).data();
    res.json({ ok:true, name, xp:nuevo.xp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- Arranque ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
