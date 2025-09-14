// index.js — API pública y páginas
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

// Servir /public (admin.html, player.html, signup.html, _nav.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

const db = new Firestore();

// --- Constantes de datos ---
const ROOT = "world_progress";
const GLOBAL = "global";
const PLAYERS = "world_progress";  // subcolección dentro de /world_progress/global
const ENEMIES = "enemies";

// --- Utilidades ---
const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------
// Home
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET  /public/enemies",
      "POST /public/register        { name, level? }",
      "POST /public/attack          { name, enemyId }",
      "GET  /public/leaderboard?limit=10",
      "GET  /player   (player.html)",
      "GET  /admin    (admin.html)",
      "GET  /signup   (signup.html)"
    ]
  });
});

// ------------------------------------------------------------------
// Rutas PÚBLICAS usadas por player.html y signup.html

// Lista de enemigos
app.get("/public/enemies", async (_req, res) => {
  try {
    const col = db.collection(ROOT).doc(GLOBAL).collection(ENEMIES);
    const qs = await col.orderBy("power").get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    return res.json(items);
  } catch (e) {
    console.error("GET /public/enemies", e);
    return res.status(500).json({ error: "failed_list_enemies" });
  }
});

// Registro / asegurar jugador
app.post("/public/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const level = clamp(toInt(req.body?.level, 1), 1, 99);
    if (!name) return res.status(400).json({ error: "name_required" });

    const pref = db.collection(ROOT).doc(GLOBAL).collection(PLAYERS).doc(name);
    await pref.set(
      { name, level, xp: toInt(req.body?.xp, 0) },
      { merge: true }
    );

    const snap = await pref.get();
    return res.json(snap.data() || { name, level, xp: 0 });
  } catch (e) {
    console.error("POST /public/register", e);
    return res.status(500).json({ error: "failed_register" });
  }
});

// Atacar enemigo
app.post("/public/attack", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const enemyId = String(req.body?.enemyId || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });
    if (!enemyId) return res.status(400).json({ error: "enemy_required" });

    // Cargar enemigo
    const eref = db.collection(ROOT).doc(GLOBAL).collection(ENEMIES).doc(enemyId);
    const esnap = await eref.get();
    if (!esnap.exists) return res.status(404).json({ error: "enemy_not_found" });
    const enemy = esnap.data();

    // Cargar/crear jugador
    const pref = db.collection(ROOT).doc(GLOBAL).collection(PLAYERS).doc(name);
    let psnap = await pref.get();
    if (!psnap.exists) {
      await pref.set({ name, level: 1, xp: 0 });
      psnap = await pref.get();
    }
    const player = psnap.data();

    // Lógica simple de combate y XP
    const level = toInt(player.level, 1);
    const power = toInt(enemy.power, 1);
    const baseChance = 0.5 + (level - power) / 100; // nivel vs poder
    const chance = clamp(baseChance, 0.1, 0.9);
    const roll = Math.random();
    const win = roll < chance;

    let xpGain = 0;
    if (win) {
      xpGain = toInt(enemy.rewardXp, 0);
      await pref.update({ xp: FieldValue.increment(xpGain) });
      await db.collection(ROOT).doc(GLOBAL).set(
        { current: FieldValue.increment(xpGain) },
        { merge: true }
      );
    }

    return res.json({
      ok: true,
      win,
      chance,
      roll,
      xpGain,
      enemy: { id: enemy.id, name: enemy.name, power: enemy.power, rewardXp: enemy.rewardXp }
    });
  } catch (e) {
    console.error("POST /public/attack", e);
    return res.status(500).json({ error: "failed_attack" });
  }
});

// Leaderboard Top N por XP
app.get("/public/leaderboard", async (req, res) => {
  try {
    const limit = clamp(toInt(req.query?.limit, 10), 1, 50);
    const qs = await db
      .collection(ROOT).doc(GLOBAL).collection(PLAYERS)
      .orderBy("xp", "desc").limit(limit).get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    return res.json(items);
  } catch (e) {
    console.error("GET /public/leaderboard", e);
    return res.status(500).json({ error: "failed_leaderboard" });
  }
});

// ------------------------------------------------------------------
// Aliases para servir las páginas por ruta "bonita"
app.get("/player", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "player.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/signup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

// ------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
