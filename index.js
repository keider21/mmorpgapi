// MMORPG API - Cloud Run
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const requireAdmin = (req, res, next) => {
  if (!ADMIN_SECRET) return next();
  const key = req.header("x-admin-secret") || "";
  if (key === ADMIN_SECRET) return next();
  return res.status(403).json({ error: "forbidden" });
};

const sendPublic = fname => (_req, res) =>
  res.sendFile(path.join(__dirname, "public", fname));
app.get("/admin", sendPublic("admin.html"));
app.get("/admin.html", sendPublic("admin.html"));
app.get("/player", sendPublic("player.html"));
app.get("/player.html", sendPublic("player.html"));

// --- Firestore names ---
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress";
const QUESTS_SUBCOLL = "quests";
const ENEMIES_SUBCOLL = "enemies"; // NUEVO

const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

// ======= HOME =======
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET /player (UI) | GET /admin (UI)",
      "GET /global | PATCH /global {current?,goal?,stage?}",
      "GET /players?limit&startAfter | GET /players/:name | PUT /players/:name {level?,xp?} | DELETE /players/:name",
      "POST /players/addxp {name,xp}",
      "GET /leaderboard?limit=10",
      "GET /quests | POST /quests | PATCH /quests/:id | DELETE /quests/:id",
      "GET /enemies",
      "POST /seed/enemies (admin)",
      "POST /battle {name, enemyId}"
    ]
  });
});

// ======= GLOBAL =======
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(d.current, 0),
      goal: toInt(d.goal, 10000),
      stage: toInt(d.stage, 1)
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

// ======= PLAYERS =======
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

app.post("/players/addxp", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const delta = toInt(req.body?.xp, 0);
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name);
    await ref.set({ name, level: 1, xp: 0 }, { merge: true });
    await ref.update({ xp: FieldValue.increment(delta) });

    const snap = await ref.get();
    res.json({ ok: true, ...(snap.data() || {}) });
  } catch (e) {
    console.error("POST /players/addxp", e);
    res.status(500).json({ error: "failed_add_xp" });
  }
});

// ======= LEADERBOARD =======
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

// ======= QUESTS =======
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

// ======= ENEMIGOS =======
// GET /enemies -> lista
app.get("/enemies", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(ENEMIES_SUBCOLL)
      .orderBy("power", "asc").get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /enemies", e);
    res.status(500).json({ error: "failed_list_enemies" });
  }
});

// POST /seed/enemies (admin) -> crea 6 enemigos base
app.post("/seed/enemies", requireAdmin, async (_req, res) => {
  try {
    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(ENEMIES_SUBCOLL);
    const defaults = [
      { id:"slime",  name:"Slime",        power: 1,  rewardXp: 10 },
      { id:"wolf",   name:"Lobo",         power: 5,  rewardXp: 25 },
      { id:"goblin", name:"Goblin",       power: 10, rewardXp: 50 },
      { id:"ogre",   name:"Ogro",         power: 20, rewardXp: 120 },
      { id:"mage",   name:"Mago oscuro",  power: 35, rewardXp: 220 },
      { id:"dragon", name:"Dragón",       power: 60, rewardXp: 500 },
    ];
    const batch = db.batch();
    defaults.forEach(e => batch.set(col.doc(e.id), e, { merge: true }));
    await batch.commit();
    res.json({ ok: true, created: defaults.length });
  } catch (e) {
    console.error("POST /seed/enemies", e);
    res.status(500).json({ error: "failed_seed_enemies" });
  }
});

// ======= BATALLA =======
// POST /battle { name, enemyId }
// Lógica: prob. de victoria depende de level vs. power (+ algo de azar).
// Recompensa: XP del enemigo, y subir nivel cada 100 xp acumulados (config simple).
app.post("/battle", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const enemyId = String(req.body?.enemyId || "").trim();
    if (!name || !enemyId) return res.status(400).json({ error: "name_and_enemy_required" });

    // lee jugador
    const pRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(PLAYERS_SUBCOLL).doc(name);
    await pRef.set({ name, level: 1, xp: 0 }, { merge: true });
    const pSnap = await pRef.get();
    const player = pSnap.data() || { name, level: 1, xp: 0 };

    // lee enemigo
    const eRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(ENEMIES_SUBCOLL).doc(enemyId);
    const eSnap = await eRef.get();
    if (!eSnap.exists) return res.status(404).json({ error: "enemy_not_found" });
    const enemy = eSnap.data();

    // prob. victoria
    const lvl = toInt(player.level, 1);
    const power = toInt(enemy.power, 1);
    const base = 0.35 + (lvl / (lvl + power + 1)); // 0.35..0.85 aprox
    const roll = Math.random(); // 0..1
    const win = roll < base;

    let xpGain = 0;
    let newLevel = lvl;
    let newXp = toInt(player.xp, 0);

    if (win) {
      xpGain = toInt(enemy.rewardXp, 10);
      newXp += xpGain;
      // subir nivel cada 100xp
      const lvlUps = Math.floor(newXp / 100);
      newLevel = Math.max(1, lvlUps + 1);
    } else {
      // derrota: poca xp de consuelo
      xpGain = 2;
      newXp += xpGain;
      const lvlUps = Math.floor(newXp / 100);
      newLevel = Math.max(1, lvlUps + 1);
    }

    await pRef.set({ xp: newXp, level: newLevel }, { merge: true });
    const result = {
      ok: true,
      win,
      roll: Number(roll.toFixed(3)),
      chance: Number(base.toFixed(2)),
      enemy: { id: enemyId, name: enemy.name, power: enemy.power, rewardXp: enemy.rewardXp },
      reward: { xp: xpGain },
      player: { name, level: newLevel, xp: newXp }
    };
    res.json(result);
  } catch (e) {
    console.error("POST /battle", e);
    res.status(500).json({ error: "failed_battle" });
  }
});

app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
