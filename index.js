// index.js — API MMORPG (Cloud Run / Firestore)
// Reemplaza TODO tu index.js por este.

import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
const db = new Firestore();

// ====== Config ======
const PORT = process.env.PORT || 8080;
// Cambia tu clave aquí o ponla en una variable de entorno ADMIN_SECRET en Cloud Run
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";

// Rutas/colecciones
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // jugadores: /world_progress/global/world_progress/{name}
const QUESTS_SUBCOLL = "quests";          // quests:    /world_progress/global/quests/{id}

// ====== Middlewares ======
app.use(cors({ origin: true }));
app.use(express.json());
// servir archivos estáticos (paneles) desde /public
app.use(express.static("public"));

// Aux
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

const playersCol = () =>
  db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL);
const questsCol = () =>
  db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);

// Autorización admin por header x-admin-secret
const requireAdmin = (req, res, next) => {
  const got = (req.headers["x-admin-secret"] || "").toString();
  if (!ADMIN_SECRET || got === ADMIN_SECRET) return next();
  return res.status(403).json({ error: "forbidden" });
};

// ====== Home & Salud ======
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global                        {current?, goal?, stage?} (admin)",
      "GET    /players?limit&startAfter",
      "GET    /players/:name",
      "PUT    /players/:name                 {level?, xp?} (admin)",
      "POST   /players/addxp                 {name, xp}   (admin)",
      "DELETE /players/:name                                (admin)",
      "POST   /players/prune?name=...                      (admin)",
      "POST   /players/prune-all                           (admin)",
      "GET    /leaderboard?limit=10",
      "GET    /quests",
      "POST   /quests                        {title, status?, id?} (admin)",
      "PATCH  /quests/:id                    {title?, status?}    (admin)",
      "DELETE /quests/:id                                       (admin)"
    ]
  });
});
app.get("/world", (_req, res) => res.json({ ok: true }));

// ====== GLOBAL ======
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(d.current, 0),
      goal: toInt(d.goal, 0),
      stage: toInt(d.stage, 0),
    });
  } catch (e) {
    console.error("GET /global", e);
    sendErr(res, "failed_get_global");
  }
});

app.patch("/global", requireAdmin, async (req, res) => {
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

// ====== PLAYERS ======
app.get("/players", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 25), 1), 100);
    const startAfter = (req.query.startAfter || "").toString();

    let q = playersCol().orderBy("name").limit(limit);
    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken =
      items.length ? items[items.length - 1].name || items[items.length - 1].id : null;
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
    const ref = playersCol().doc(name);
    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);
    res.json(snap.data());
  } catch (e) {
    console.error("GET /players/:name", e);
    sendErr(res, "failed_get_player");
  }
});

// Crear/Actualizar por name (docId = name)
app.put("/players/:name", requireAdmin, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);
    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);
    const ref = playersCol().doc(name);
    await ref.set({ name, level, xp }, { merge: true });
    const snap = await ref.get();
    res.json(snap.data() || { name, level, xp });
  } catch (e) {
    console.error("PUT /players/:name", e);
    sendErr(res, "failed_upsert_player");
  }
});

app.delete("/players/:name", requireAdmin, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);
    await playersCol().doc(name).delete();
    res.json({ ok: true, name });
  } catch (e) {
    console.error("DELETE /players/:name", e);
    sendErr(res, "failed_delete_player");
  }
});

// Sumar XP rápido (por name)
app.post("/players/addxp", requireAdmin, async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return sendErr(res, "name_required", 400);
    const delta = Number(xp) || 0;
    const ref = playersCol().doc(String(name));
    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);
    await ref.update({ xp: FieldValue.increment(delta) });
    const newSnap = await ref.get();
    res.json({ ok: true, name, ...(newSnap.data() || {}) });
  } catch (e) {
    console.error("POST /players/addxp", e);
    sendErr(res, "failed_addxp");
  }
});

// Limpieza: borra TODOS los docs cuyo campo name == ? aunque el docId no coincida
app.post("/players/prune", requireAdmin, async (req, res) => {
  try {
    const name = (req.query.name || req.body?.name || "").toString().trim();
    if (!name) return sendErr(res, "name_required", 400);
    const snap = await playersCol().where("name", "==", name).get();
    if (snap.empty) return res.json({ ok: true, deleted: 0 });
    const batch = db.batch();
    snap.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    res.json({ ok: true, deleted: snap.size });
  } catch (e) {
    console.error("POST /players/prune", e);
    sendErr(res, "failed_prune");
  }
});

// Normaliza toda la colección: si docId !== name -> mueve a docId=name y borra viejo
app.post("/players/prune-all", requireAdmin, async (_req, res) => {
  try {
    const qs = await playersCol().get();
    let fixes = 0;
    for (const d of qs.docs) {
      const data = d.data() || {};
      const name = String(data.name || "").trim();
      if (!name) continue;
      if (d.id !== name) {
        const target = playersCol().doc(name);
        const targetSnap = await target.get();
        // Unir datos sin pisar XP mayor
        const merged = {
          name,
          level: Math.max(toInt(targetSnap.data()?.level, 1), toInt(data.level, 1)),
          xp: Math.max(toInt(targetSnap.data()?.xp, 0), toInt(data.xp, 0)),
        };
        await target.set(merged, { merge: true });
        await d.ref.delete();
        fixes++;
      }
    }
    res.json({ ok: true, fixed: fixes, total: qs.size });
  } catch (e) {
    console.error("POST /players/prune-all", e);
    sendErr(res, "failed_prune_all");
  }
});

// ====== Leaderboard ======
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
    const qs = await playersCol().orderBy("xp", "desc").limit(limit).get();
    res.json(qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ====== Quests ======
app.get("/quests", async (_req, res) => {
  try {
    const qs = await questsCol().orderBy("createdAt", "desc").get();
    res.json(qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /quests", e);
    sendErr(res, "failed_list_quests");
  }
});

app.post("/quests", requireAdmin, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res, "title_required", 400);

    let ref;
    const id = String(req.body?.id || "").trim();
    if (id) {
      ref = questsCol().doc(id);
      await ref.set({ title, status, updatedAt: new Date().toISOString() }, { merge: true });
    } else {
      ref = await questsCol().add({ title, status, createdAt: new Date().toISOString() });
    }
    const snap = await ref.get();
    res.json({ id: ref.id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("POST /quests", e);
    sendErr(res, "failed_create_quest");
  }
});

app.patch("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);
    const payload = {};
    if (typeof req.body?.title === "string") payload.title = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    payload.updatedAt = new Date().toISOString();
    const ref = questsCol().doc(id);
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    res.json({ id, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PATCH /quests/:id", e);
    sendErr(res, "failed_patch_quest");
  }
});

app.delete("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return sendErr(res, "id_required", 400);
    await questsCol().doc(id).delete();
    res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /quests/:id", e);
    sendErr(res, "failed_delete_quest");
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
