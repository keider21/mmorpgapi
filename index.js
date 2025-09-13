// index.js — API completa (incluye batallas)
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Servir archivos estáticos (admin.html, player.html, etc.)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ================== CONFIG BÁSICA ==================
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const QUESTS_SUBCOLL = "quests";

const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

const playersCol = () =>
  db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL);

// ================== HOME ==================
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET   /global",
      "PATCH /global                 {current?, goal?, stage?}",
      "GET   /players?limit&startAfter",
      "GET   /players/:name",
      "PUT   /players/:name          {level?, xp?}",
      "DELETE /players/:name",
      "GET   /leaderboard?limit=10",
      "GET   /quests",
      "POST  /quests                 {id?, title, status}",
      "PATCH /quests/:id             {title?, status?}",
      "DELETE /quests/:id",
      // Batallas:
      "GET   /enemies",
      "POST  /battle/attack          {name, enemyId}"
    ]
  });
});

// ================== GLOBAL ==================
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

// ================== PLAYERS ==================
app.get("/players", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 25);
    const startAfter = (req.query.startAfter || "").toString();

    let q = playersCol().orderBy("name").limit(Math.min(Math.max(limit, 1), 100));
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

    const ref = playersCol().doc(name);
    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);
    res.json({ name, ...(snap.data() || {}) });
  } catch (e) {
    console.error("GET /players/:name", e);
    sendErr(res, "failed_get_player");
  }
});

// crea/actualiza jugador
app.put("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);
    const power = toInt(req.body?.power, 10); // campo nuevo opcional

    const ref = playersCol().doc(name);
    await ref.set({ name, level, xp, power }, { merge: true });

    const snap = await ref.get();
    res.json({ name, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PUT /players/:name", e);
    sendErr(res, "failed_upsert_player");
  }
});

app.delete("/players/:name", async (req, res) => {
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

app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);
    const q = playersCol().orderBy("xp", "desc").limit(Math.min(Math.max(limit, 1), 100));
    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ================== QUESTS ==================
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

app.post("/quests", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res, "title_required", 400);

    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);
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

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id);
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
    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id).delete();
    res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /quests/:id", e);
    sendErr(res, "failed_delete_quest");
  }
});

// ================== BATALLAS ==================

// Lista de enemigos “demo” (podrías mover esto a Firestore si quieres)
const ENEMIES = [
  { id: "slime",    name: "Slime",       power: 8,  xp: 10, gold: 2 },
  { id: "goblin",   name: "Goblin",      power: 15, xp: 16, gold: 5 },
  { id: "wolf",     name: "Lobo Alfa",   power: 22, xp: 24, gold: 8 },
  { id: "knight",   name: "Caballero",   power: 35, xp: 40, gold: 15 },
  { id: "lich",     name: "Lich",        power: 55, xp: 65, gold: 25 },
  { id: "dragon",   name: "Dragón",      power: 85, xp: 120, gold: 60 },
];

app.get("/enemies", (_req, res) => res.json(ENEMIES));

// Ataque simple: calcula victoria/derrota y actualiza XP + historial
app.post("/battle/attack", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const enemyId = String(req.body?.enemyId || "").trim();
    if (!name || !enemyId) return sendErr(res, "name_and_enemyId_required", 400);

    const enemy = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return sendErr(res, "enemy_not_found", 404);

    // Asegurar que el jugador exista
    const pRef = playersCol().doc(name);
    const pSnap = await pRef.get();
    if (!pSnap.exists) await pRef.set({ name, level: 1, xp: 0, power: 10 }, { merge: true });
    const player = (await pRef.get()).data() || { level: 1, xp: 0, power: 10 };

    // Poder efectivo del jugador (muy simple: base + nivel*5 + (xp/20))
    const playerPower = toInt(player.power, 10) + toInt(player.level, 1) * 5 + Math.floor(toInt(player.xp, 0) / 20);

    // Pequeño factor aleatorio para ambos lados
    const rnd = () => Math.floor(Math.random() * 6) - 2; // -2 .. +3 aprox
    const playerRoll = playerPower + rnd();
    const enemyRoll  = enemy.power + rnd();

    const win = playerRoll >= enemyRoll;
    let xpGain = 0;

    // Nivelar: por cada 100 XP -> +1 nivel (demo)
    let newLevel = toInt(player.level, 1);
    let newXP = toInt(player.xp, 0);

    if (win) {
      xpGain = enemy.xp;
      newXP += xpGain;
      while (newXP >= 100) {
        newXP -= 100;
        newLevel += 1;
      }
      await pRef.set({ xp: newXP, level: newLevel }, { merge: true });
    }

    // Guardar historial
    const bRef = pRef.collection("battles").doc();
    await bRef.set({
      enemyId,
      enemyName: enemy.name,
      at: new Date().toISOString(),
      playerPower,
      enemyPower: enemy.power,
      playerRoll,
      enemyRoll,
      win,
      xpGain
    });

    res.json({
      ok: true,
      win,
      enemy: { id: enemy.id, name: enemy.name, power: enemy.power, xp: enemy.xp },
      player: { name, level: newLevel, xp: newXP, power: playerPower },
      xpGain
    });
  } catch (e) {
    console.error("POST /battle/attack", e);
    sendErr(res, "failed_battle", 500, { message: e.message });
  }
});

// ================== ARRANQUE ==================
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});// index.js — API completa (incluye batallas)
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Servir archivos estáticos (admin.html, player.html, etc.)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ================== CONFIG BÁSICA ==================
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const QUESTS_SUBCOLL = "quests";

const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

const playersCol = () =>
  db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL);

// ================== HOME ==================
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET   /global",
      "PATCH /global                 {current?, goal?, stage?}",
      "GET   /players?limit&startAfter",
      "GET   /players/:name",
      "PUT   /players/:name          {level?, xp?}",
      "DELETE /players/:name",
      "GET   /leaderboard?limit=10",
      "GET   /quests",
      "POST  /quests                 {id?, title, status}",
      "PATCH /quests/:id             {title?, status?}",
      "DELETE /quests/:id",
      // Batallas:
      "GET   /enemies",
      "POST  /battle/attack          {name, enemyId}"
    ]
  });
});

// ================== GLOBAL ==================
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

// ================== PLAYERS ==================
app.get("/players", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 25);
    const startAfter = (req.query.startAfter || "").toString();

    let q = playersCol().orderBy("name").limit(Math.min(Math.max(limit, 1), 100));
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

    const ref = playersCol().doc(name);
    const snap = await ref.get();
    if (!snap.exists) return sendErr(res, "not_found", 404);
    res.json({ name, ...(snap.data() || {}) });
  } catch (e) {
    console.error("GET /players/:name", e);
    sendErr(res, "failed_get_player");
  }
});

// crea/actualiza jugador
app.put("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return sendErr(res, "name_required", 400);

    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);
    const power = toInt(req.body?.power, 10); // campo nuevo opcional

    const ref = playersCol().doc(name);
    await ref.set({ name, level, xp, power }, { merge: true });

    const snap = await ref.get();
    res.json({ name, ...(snap.data() || {}) });
  } catch (e) {
    console.error("PUT /players/:name", e);
    sendErr(res, "failed_upsert_player");
  }
});

app.delete("/players/:name", async (req, res) => {
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

app.get("/leaderboard", async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 10);
    const q = playersCol().orderBy("xp", "desc").limit(Math.min(Math.max(limit, 1), 100));
    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ================== QUESTS ==================
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

app.post("/quests", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const status = String(req.body?.status || "open").trim();
    if (!title) return sendErr(res, "title_required", 400);

    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL);
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

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id);
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
    await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(QUESTS_SUBCOLL).doc(id).delete();
    res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /quests/:id", e);
    sendErr(res, "failed_delete_quest");
  }
});

// ================== BATALLAS ==================

// Lista de enemigos “demo” (podrías mover esto a Firestore si quieres)
const ENEMIES = [
  { id: "slime",    name: "Slime",       power: 8,  xp: 10, gold: 2 },
  { id: "goblin",   name: "Goblin",      power: 15, xp: 16, gold: 5 },
  { id: "wolf",     name: "Lobo Alfa",   power: 22, xp: 24, gold: 8 },
  { id: "knight",   name: "Caballero",   power: 35, xp: 40, gold: 15 },
  { id: "lich",     name: "Lich",        power: 55, xp: 65, gold: 25 },
  { id: "dragon",   name: "Dragón",      power: 85, xp: 120, gold: 60 },
];

app.get("/enemies", (_req, res) => res.json(ENEMIES));

// Ataque simple: calcula victoria/derrota y actualiza XP + historial
app.post("/battle/attack", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const enemyId = String(req.body?.enemyId || "").trim();
    if (!name || !enemyId) return sendErr(res, "name_and_enemyId_required", 400);

    const enemy = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return sendErr(res, "enemy_not_found", 404);

    // Asegurar que el jugador exista
    const pRef = playersCol().doc(name);
    const pSnap = await pRef.get();
    if (!pSnap.exists) await pRef.set({ name, level: 1, xp: 0, power: 10 }, { merge: true });
    const player = (await pRef.get()).data() || { level: 1, xp: 0, power: 10 };

    // Poder efectivo del jugador (muy simple: base + nivel*5 + (xp/20))
    const playerPower = toInt(player.power, 10) + toInt(player.level, 1) * 5 + Math.floor(toInt(player.xp, 0) / 20);

    // Pequeño factor aleatorio para ambos lados
    const rnd = () => Math.floor(Math.random() * 6) - 2; // -2 .. +3 aprox
    const playerRoll = playerPower + rnd();
    const enemyRoll  = enemy.power + rnd();

    const win = playerRoll >= enemyRoll;
    let xpGain = 0;

    // Nivelar: por cada 100 XP -> +1 nivel (demo)
    let newLevel = toInt(player.level, 1);
    let newXP = toInt(player.xp, 0);

    if (win) {
      xpGain = enemy.xp;
      newXP += xpGain;
      while (newXP >= 100) {
        newXP -= 100;
        newLevel += 1;
      }
      await pRef.set({ xp: newXP, level: newLevel }, { merge: true });
    }

    // Guardar historial
    const bRef = pRef.collection("battles").doc();
    await bRef.set({
      enemyId,
      enemyName: enemy.name,
      at: new Date().toISOString(),
      playerPower,
      enemyPower: enemy.power,
      playerRoll,
      enemyRoll,
      win,
      xpGain
    });

    res.json({
      ok: true,
      win,
      enemy: { id: enemy.id, name: enemy.name, power: enemy.power, xp: enemy.xp },
      player: { name, level: newLevel, xp: newXP, power: playerPower },
      xpGain
    });
  } catch (e) {
    console.error("POST /battle/attack", e);
    sendErr(res, "failed_battle", 500, { message: e.message });
  }
});

// ================== ARRANQUE ==================
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
