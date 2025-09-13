// index.js — API completa y estáticos
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Sirve /public (admin.html, player.html, signup.html, game.html, _nav.html, etc.)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ====== Constantes de BD ======
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección bajo /world_progress/global
const ENEMIES_SUBCOLL = "enemies";        // subcolección bajo /world_progress/global
const ITEMS_SUBCOLL   = "items";          // por si luego agregas items

// ====== Util ======
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const sendErr = (res, code, http = 500, extra = {}) =>
  res.status(http).json({ error: code, ...extra });

// ====== Home ======
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /public/enemies",
      "POST   /public/register        {name, level?}",
      "POST   /public/attack          {name, enemyId}",
      "GET    /leaderboard?limit=10",
      "GET    /global",
      "PATCH  /global                 {current?, goal?, stage?}"
    ]
  });
});

// ====== GLOBAL (admin o público de solo lectura) ======
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

// ====== PUBLIC: enemies ======
app.get("/public/enemies", async (_req, res) => {
  try {
    const qs = await db
      .collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(ENEMIES_SUBCOLL)
      .orderBy("power", "asc")
      .get();

    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /public/enemies", e);
    sendErr(res, "failed_list_enemies");
  }
});

// ====== PUBLIC: register/asegurar jugador ======
app.post("/public/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const level = Math.max(1, toInt(req.body?.level, 1));
    if (!name) return sendErr(res, "name_required", 400);

    const ref = db
      .collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    await ref.set({ name, level, xp: toInt(req.body?.xp, 0) }, { merge: true });
    const snap = await ref.get();
    res.json(snap.data() || { name, level, xp: 0 });
  } catch (e) {
    console.error("POST /public/register", e);
    sendErr(res, "failed_register");
  }
});

// ====== PUBLIC: attack ======
app.post("/public/attack", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const enemyId = String(req.body?.enemyId || "").trim();
    if (!name || !enemyId) return sendErr(res, "name_and_enemy_required", 400);

    // 1) Cargar enemigo
    const enemyRef = db
      .collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(ENEMIES_SUBCOLL).doc(enemyId);
    const enemySnap = await enemyRef.get();
    if (!enemySnap.exists) return sendErr(res, "enemy_not_found", 404);
    const enemy = enemySnap.data();

    // 2) Cargar/crear jugador
    const playerRef = db
      .collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);
    let playerSnap = await playerRef.get();
    if (!playerSnap.exists) {
      await playerRef.set({ name, level: 1, xp: 0 });
      playerSnap = await playerRef.get();
    }
    const player = playerSnap.data();

    // 3) Resolver batalla: súper simple (ajústalo a tu gusto)
    const powerPlayer = player.level * 10;
    const powerEnemy = toInt(enemy.power, 1);
    const baseWinChance = Math.min(0.9, Math.max(0.1, (powerPlayer / (powerPlayer + powerEnemy)))); // 10%–90%
    const rng = Math.random();
    const win = rng < baseWinChance;

    let gainedXp = 0;
    let levelUp = false;

    if (win) {
      gainedXp = toInt(enemy.rewardXp, 5);
      const newXp = toInt(player.xp, 0) + gainedXp;
      // regla simple: cada 100 xp = +1 nivel (puedes cambiarla)
      const addLevels = Math.floor(newXp / 100) - Math.floor(toInt(player.xp,0) / 100);
      const newLevel = toInt(player.level, 1) + Math.max(0, addLevels);
      levelUp = addLevels > 0;

      await playerRef.set({ xp: newXp, level: newLevel }, { merge: true });

      // opcional: avanza progreso global
      await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
        .set({ current: FieldValue.increment(1) }, { merge: true });

      res.json({
        ok: true,
        result: "win",
        gainedXp,
        player: { name, level: newLevel, xp: newXp },
        debug: { baseWinChance, rng }
      });
    } else {
      res.json({
        ok: true,
        result: "lose",
        gainedXp: 0,
        player: { name, level: player.level, xp: player.xp },
        debug: { baseWinChance, rng }
      });
    }
  } catch (e) {
    console.error("POST /public/attack", e);
    sendErr(res, "failed_attack");
  }
});

// ====== Leaderboard ======
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
    const qs = await db
      .collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc")
      .limit(limit)
      .get();

    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error("GET /leaderboard", e);
    sendErr(res, "failed_leaderboard");
  }
});

// ====== Arranque ======
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
