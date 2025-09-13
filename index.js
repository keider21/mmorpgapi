// index.js — backend completo
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static("public")); // sirve /admin.html, /player.html, /index.html, etc.

const db = new Firestore();
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "cambia-esto";

// -------- helpers ----------
const ROOT = "world_progress";
const GLOBAL_ID = "global";
const PLAYERS = "world_progress";  // subcolección de jugadores
const QUESTS = "quests";
const ENEMIES = "enemies";

const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const forbid = (res) => res.status(403).json({ error: "forbidden" });
const need = (res, msg) => res.status(400).json({ error: msg });

const requireAdmin = (req, res, next) => {
  const s = req.header("x-admin-secret") || "";
  if (!ADMIN_SECRET || s !== ADMIN_SECRET) return forbid(res);
  next();
};

// ---------- Home ----------
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET    /global",
      "PATCH  /global",
      "GET    /players?limit&startAfter",
      "GET    /players/:name",
      "PUT    /players/:name",
      "DELETE /players/:name",
      "GET    /leaderboard?limit",
      "GET    /quests",
      "POST   /quests   (admin)",
      "PATCH  /quests/:id  (admin)",
      "DELETE /quests/:id  (admin)",
      "GET    /enemies",
      "POST   /admin/enemies        (admin, upsert 1)",
      "POST   /admin/enemies/seed   (admin, siembra pack 5)"
    ]
  });
});

// ---------- Global ----------
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT).doc(GLOBAL_ID).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(d.current, 0),
      goal: toInt(d.goal, 10000),
      stage: toInt(d.stage, 1)
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_get_global" });
  }
});

app.patch("/global", requireAdmin, async (req, res) => {
  try {
    const { current, goal, stage } = req.body || {};
    const payload = {};
    if (current !== undefined) payload.current = toInt(current);
    if (goal !== undefined) payload.goal = toInt(goal);
    if (stage !== undefined) payload.stage = toInt(stage);
    await db.collection(ROOT).doc(GLOBAL_ID).set(payload, { merge: true });
    const snap = await db.collection(ROOT).doc(GLOBAL_ID).get();
    res.json(snap.data() || {});
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_patch_global" });
  }
});

// ---------- Players ----------
app.get("/players", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 25), 1), 100);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS).orderBy("name").limit(limit);
    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken = items.length ? (items[items.length - 1].name || items[items.length - 1].id) : null;
    res.json({ items, nextPageToken });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_list_players" });
  }
});

app.get("/players/:name", async (req, res) => {
  try {
    const name = (req.params.name || "").trim();
    if (!name) return need(res, "name_required");
    const ref = db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS).doc(name);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    res.json(snap.data());
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_get_player" });
  }
});

app.put("/players/:name", async (req, res) => {
  try {
    const name = (req.params.name || "").trim();
    if (!name) return need(res, "name_required");
    const level = toInt(req.body?.level, 1);
    const xp = toInt(req.body?.xp, 0);
    const ref = db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS).doc(name);
    await ref.set({ name, level, xp }, { merge: true });
    const snap = await ref.get();
    res.json(snap.data() || { name, level, xp });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_upsert_player" });
  }
});

app.delete("/players/:name", requireAdmin, async (req, res) => {
  try {
    const name = (req.params.name || "").trim();
    if (!name) return need(res, "name_required");
    await db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS).doc(name).delete();
    res.json({ ok: true, name });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_delete_player" });
  }
});

// sumar XP rápido
app.post("/players/addxp", async (req, res) => {
  try {
    const { name, xp = 0 } = req.body || {};
    if (!name) return need(res, "name_required");
    const ref = db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS).doc(name);
    await ref.set({ name }, { merge: true });
    await ref.update({ xp: FieldValue.increment(toInt(xp,0)) });
    const d = (await ref.get()).data();
    res.json({ ok: true, name, xp: d?.xp || 0 });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_add_xp" });
  }
});

// ---------- Leaderboard ----------
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
    const qs = await db.collection(ROOT).doc(GLOBAL_ID).collection(PLAYERS)
      .orderBy("xp", "desc").limit(limit).get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_leaderboard" });
  }
});

// ---------- Enemies ----------
app.get("/enemies", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT).doc(GLOBAL_ID).collection(ENEMIES).orderBy("power").get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_list_enemies" });
  }
});

// upsert 1 enemigo (admin)
app.post("/admin/enemies", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || body.name || "").toString().trim().toLowerCase().replace(/\s+/g,"_");
    if (!id) return need(res, "id_or_name_required");

    const data = {
      name: body.name || id,
      power: toInt(body.power, 1),
      hp: toInt(body.hp, 20),
      xpReward: toInt(body.xpReward, 5),
      loot: Array.isArray(body.loot) ? body.loot : []
    };

    const ref = db.collection(ROOT).doc(GLOBAL_ID).collection(ENEMIES).doc(id);
    await ref.set(data, { merge: true });
    const snap = await ref.get();
    res.json({ id, ...(snap.data() || data) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_upsert_enemy" });
  }
});

// siembra pack 5 (admin)
app.post("/admin/enemies/seed", requireAdmin, async (_req, res) => {
  try {
    const pack = {
      slime: { name:"Slime", power:1,  hp:20,  xpReward:5,
        loot:[{item:"Gelatina", type:"material", rarity:"common", chance:0.5}] },
      goblin:{ name:"Goblin",power:8,  hp:60,  xpReward:20,
        loot:[{item:"Daga mohosas", type:"weapon", rarity:"common", atk:3, chance:0.25}] },
      wolf:  { name:"Lobo",  power:15, hp:90,  xpReward:35,
        loot:[{item:"Piel de lobo", type:"armor", rarity:"uncommon", def:4, chance:0.2}] },
      orc:   { name:"Orco",  power:30, hp:160, xpReward:120,
        loot:[{item:"Hacha orca", type:"weapon", rarity:"rare", atk:9, chance:0.15}] },
      dragon:{ name:"Dragón",power:60, hp:300, xpReward:500,
        loot:[
          {item:"Colmillo de dragón", type:"weapon", rarity:"rare", atk:15, chance:0.2},
          {item:"Escama de dragón",   type:"armor",  rarity:"epic",  def:20, chance:0.1}
        ] }
    };
    const col = db.collection(ROOT).doc(GLOBAL_ID).collection(ENEMIES);
    const batch = db.batch();
    Object.entries(pack).forEach(([id, data]) => batch.set(col.doc(id), data, { merge:true }));
    await batch.commit();
    res.json({ ok:true, seeded: Object.keys(pack) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_seed_enemies" });
  }
});

// ---------- Quests (básico) ----------
app.get("/quests", async (_req, res) => {
  try {
    const qs = await db.collection(ROOT).doc(GLOBAL_ID).collection(QUESTS)
      .orderBy("createdAt","desc").get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_list_quests" });
  }
});

app.post("/quests", requireAdmin, async (req, res) => {
  try {
    const title = (req.body?.title || "").trim();
    const status = (req.body?.status || "open").trim();
    if (!title) return need(res, "title_required");
    const ref = await db.collection(ROOT).doc(GLOBAL_ID).collection(QUESTS)
      .add({ title, status, createdAt: new Date().toISOString() });
    const snap = await ref.get();
    res.json({ id: ref.id, ...(snap.data() || {}) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_create_quest" });
  }
});

app.patch("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return need(res, "id_required");
    const payload = { updatedAt: new Date().toISOString() };
    if (typeof req.body?.title === "string") payload.title = req.body.title;
    if (typeof req.body?.status === "string") payload.status = req.body.status;
    const ref = db.collection(ROOT).doc(GLOBAL_ID).collection(QUESTS).doc(id);
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    res.json({ id, ...(snap.data() || {}) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_patch_quest" });
  }
});

app.delete("/quests/:id", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return need(res, "id_required");
    await db.collection(ROOT).doc(GLOBAL_ID).collection(QUESTS).doc(id).delete();
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "failed_delete_quest" });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
