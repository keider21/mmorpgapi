// index.js — API MMORPG (global + players + enemies + combat + inventory + equipment)
import express from "express";
import cors from "cors";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Sirve archivos estáticos de /public (player.html, css, etc.)
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// ------------------- Constantes / helpers -------------------
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress";
const ENEMIES_SUBCOLL = "enemies";     // spawns
const INVENTORY_SUBCOLL = "inventory"; // items del jugador
const EQUIPMENT_SUBCOLL = "equipment"; // piezas equipadas

const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Leveling simple
const XP_PER_LEVEL = 100;
function applyLevelUp(p) {
  let changed = false;
  let xp = toInt(p.xp, 0);
  let level = clamp(toInt(p.level, 1), 1, 9999);

  while (xp >= XP_PER_LEVEL) {
    xp -= XP_PER_LEVEL;
    level += 1;
    changed = true;
  }
  return { level, xp, changed };
}

// ------------------- Home -------------------
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: [
      "GET  /global",
      "PATCH /global {current?,goal?,stage?}",
      "GET  /players?limit&startAfter",
      "GET  /players/:name",
      "PUT  /players/:name {level?, xp?}",
      "DELETE /players/:name",
      "GET  /leaderboard?limit",

      "GET  /enemies           (spawn list)",
      "POST /combat/attack     {name, enemyId}",

      "GET  /players/:name/inventory",
      "POST /players/:name/inventory/use     {itemId}",
      "DELETE /players/:name/inventory/:id",

      "GET  /players/:name/equipment",
      "POST /players/:name/equipment/equip   {slot, itemId}",
      "POST /players/:name/equipment/unequip {slot}",

      "GET  /player.html"
    ]
  });
});

// ------------------- GLOBAL -------------------
app.get("/global", async (_req, res) => {
  try {
    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      current: toInt(data.current, 0),
      goal: toInt(data.goal, 10000),
      stage: toInt(data.stage, 0)
    });
  } catch (e) {
    console.error("GET /global", e);
    res.status(500).json({ error: "failed_get_global" });
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
    res.status(500).json({ error: "failed_patch_global" });
  }
});

// ------------------- PLAYERS básicos -------------------
app.get("/players", async (req, res) => {
  try {
    const limit = clamp(toInt(req.query.limit, 25), 1, 100);
    const startAfter = (req.query.startAfter || "").toString();

    let q = db.collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("name")
      .limit(limit);

    if (startAfter) q = q.startAfter(startAfter);

    const qs = await q.get();
    const items = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const nextPageToken = items.length ? (items.at(-1).name || items.at(-1).id) : null;

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

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

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

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    await ref.set({ name, level, xp }, { merge: true });

    // normaliza por si subió de nivel
    const fresh = (await ref.get()).data() || { name, level, xp };
    const upd = applyLevelUp(fresh);
    if (upd.changed) {
      await ref.set({ level: upd.level, xp: upd.xp }, { merge: true });
    }
    res.json((await ref.get()).data());
  } catch (e) {
    console.error("PUT /players/:name", e);
    res.status(500).json({ error: "failed_upsert_player" });
  }
});

app.delete("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    await ref.delete();
    res.json({ ok: true, name });
  } catch (e) {
    console.error("DELETE /players/:name", e);
    res.status(500).json({ error: "failed_delete_player" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const limit = clamp(toInt(req.query.limit, 10), 1, 100);
    const q = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .orderBy("xp", "desc")
      .limit(limit);
    const qs = await q.get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /leaderboard", e);
    res.status(500).json({ error: "failed_leaderboard" });
  }
});

// ------------------- ENEMIGOS (spawns) -------------------
// Estructura típica de un enemy:
// { id, name, power, hp, xpReward, loot: [{item, type, rarity, chance, atk?, def?}] }
app.get("/enemies", async (_req, res) => {
  try {
    const col = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).collection(ENEMIES_SUBCOLL);
    const qs = await col.orderBy("power").get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /enemies", e);
    res.status(500).json({ error: "failed_list_enemies" });
  }
});

// ------------------- COMBATE + DROPS -------------------
app.post("/combat/attack", async (req, res) => {
  try {
    const { name, enemyId } = req.body || {};
    if (!name || !enemyId) return res.status(400).json({ error: "name_and_enemy_required" });

    const playerRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);
    const playerSnap = await playerRef.get();

    if (!playerSnap.exists) {
      await playerRef.set({ name, level: 1, xp: 0 }, { merge: true });
    }
    const player = (await playerRef.get()).data();

    const enemyRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(ENEMIES_SUBCOLL).doc(enemyId);
    const enemySnap = await enemyRef.get();
    if (!enemySnap.exists) return res.status(404).json({ error: "enemy_not_found" });
    const enemy = enemySnap.data();

    // poder básico jugador = nivel * 10 + bonus por equipo
    const eqRef = playerRef.collection(EQUIPMENT_SUBCOLL);
    const weapon = (await eqRef.doc("weapon").get()).data() || {};
    const armor  = (await eqRef.doc("armor").get()).data()  || {};
    const atkBonus = toInt(weapon.atk, 0);
    const defBonus = toInt(armor.def, 0);

    const playerPower = toInt(player.level, 1) * 10 + atkBonus + Math.floor(defBonus / 2);
    const enemyPower  = toInt(enemy.power, 5);

    // Probabilidad de victoria simple (suavizada)
    const winProb = clamp(0.5 + (playerPower - enemyPower) / (playerPower + enemyPower + 1), 0.1, 0.9);
    const win = Math.random() < winProb;

    let xpDelta = 0;
    const drops = [];

    if (win) {
      xpDelta = toInt(enemy.xpReward, 10);
      // tiradas de loot
      for (const l of enemy.loot || []) {
        const chance = Number(l.chance) || 0;
        if (Math.random() < chance) {
          // crear item en inventario
          const invRef = playerRef.collection(INVENTORY_SUBCOLL);
          const doc = await invRef.add({
            name: l.item,
            type: l.type,          // potion | weapon | armor | misc
            rarity: l.rarity || "common",
            atk: toInt(l.atk, 0),
            def: toInt(l.def, 0),
            qty: 1,
            createdAt: new Date().toISOString()
          });
          drops.push({ id: doc.id, item: l.item, type: l.type, rarity: l.rarity || "common", atk: toInt(l.atk,0), def: toInt(l.def,0) });
        }
      }
      // sumar XP y aplicar level up
      const newXP = toInt(player.xp, 0) + xpDelta;
      const { level, xp } = applyLevelUp({ level: player.level, xp: newXP });
      await playerRef.set({ xp, level }, { merge: true });
    }

    res.json({
      win,
      playerPower,
      enemyPower,
      xpGained: xpDelta,
      drops
    });
  } catch (e) {
    console.error("POST /combat/attack", e);
    res.status(500).json({ error: "failed_combat" });
  }
});

// ------------------- INVENTARIO -------------------
app.get("/players/:name/inventory", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const invCol = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name).collection(INVENTORY_SUBCOLL);

    const qs = await invCol.orderBy("createdAt", "desc").get();
    res.json(qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) })));
  } catch (e) {
    console.error("GET /players/:name/inventory", e);
    res.status(500).json({ error: "failed_inventory" });
  }
});

// Usar un ítem (soporte: potion => +20 xp; misc sin efecto; weapon/armor no se usan aquí)
app.post("/players/:name/inventory/use", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const { itemId } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "itemId_required" });

    const playerRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    const itemRef = playerRef.collection(INVENTORY_SUBCOLL).doc(itemId);
    const item = (await itemRef.get()).data();
    if (!item) return res.status(404).json({ error: "item_not_found" });

    let effect = null;

    if (item.type === "potion") {
      // +20 XP por poción
      const p = (await playerRef.get()).data();
      const newXP = toInt(p.xp, 0) + 20;
      const { level, xp } = applyLevelUp({ level: p.level, xp: newXP });
      await playerRef.set({ xp, level }, { merge: true });

      // consumir poción
      await itemRef.delete();
      effect = { xpAdded: 20, newLevel: level, newXP: xp };
    } else {
      effect = { note: "item_no_consumible" };
    }

    res.json({ ok: true, effect });
  } catch (e) {
    console.error("POST /inventory/use", e);
    res.status(500).json({ error: "failed_use_item" });
  }
});

app.delete("/players/:name/inventory/:id", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const id = String(req.params.id || "");
    const itemRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name)
      .collection(INVENTORY_SUBCOLL).doc(id);
    await itemRef.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /inventory", e);
    res.status(500).json({ error: "failed_delete_item" });
  }
});

// ------------------- EQUIPAMIENTO -------------------
app.get("/players/:name/equipment", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const eqCol = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name).collection(EQUIPMENT_SUBCOLL);

    const weapon = (await eqCol.doc("weapon").get()).data() || null;
    const armor  = (await eqCol.doc("armor").get()).data() || null;
    res.json({ weapon, armor });
  } catch (e) {
    console.error("GET /equipment", e);
    res.status(500).json({ error: "failed_equipment" });
  }
});

// Equipa un ítem del inventario en un slot ("weapon" | "armor")
app.post("/players/:name/equipment/equip", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const { slot, itemId } = req.body || {};
    if (!slot || !itemId) return res.status(400).json({ error: "slot_and_itemId_required" });
    if (!["weapon", "armor"].includes(slot)) return res.status(400).json({ error: "invalid_slot" });

    const playerRef = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name);

    const invRef = playerRef.collection(INVENTORY_SUBCOLL).doc(itemId);
    const item = (await invRef.get()).data();
    if (!item) return res.status(404).json({ error: "item_not_found" });

    if (slot === "weapon" && item.type !== "weapon") return res.status(400).json({ error: "item_not_weapon" });
    if (slot === "armor" && item.type !== "armor")   return res.status(400).json({ error: "item_not_armor" });

    const eqRef = playerRef.collection(EQUIPMENT_SUBCOLL).doc(slot);
    await eqRef.set({
      id: itemId,
      name: item.name,
      atk: toInt(item.atk, 0),
      def: toInt(item.def, 0),
      rarity: item.rarity || "common",
      equippedAt: new Date().toISOString()
    });

    // al equipar, opcionalmente removemos del inventario
    await invRef.delete();

    const equip = {
      weapon: (await playerRef.collection(EQUIPMENT_SUBCOLL).doc("weapon").get()).data() || null,
      armor:  (await playerRef.collection(EQUIPMENT_SUBCOLL).doc("armor").get()).data()  || null,
    };
    res.json({ ok: true, equip });
  } catch (e) {
    console.error("POST /equipment/equip", e);
    res.status(500).json({ error: "failed_equip" });
  }
});

app.post("/players/:name/equipment/unequip", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    const { slot } = req.body || {};
    if (!["weapon", "armor"].includes(slot)) return res.status(400).json({ error: "invalid_slot" });

    const eqDoc = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL).doc(name).collection(EQUIPMENT_SUBCOLL).doc(slot);

    const data = (await eqDoc.get()).data();
    if (data) {
      // devolver al inventario
      const invCol = db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID)
        .collection(PLAYERS_SUBCOLL).doc(name).collection(INVENTORY_SUBCOLL);
      await invCol.add({
        name: data.name,
        type: slot === "weapon" ? "weapon" : "armor",
        atk: toInt(data.atk, 0),
        def: toInt(data.def, 0),
        rarity: data.rarity || "common",
        qty: 1,
        createdAt: new Date().toISOString()
      });
    }
    await eqDoc.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /equipment/unequip", e);
    res.status(500).json({ error: "failed_unequip" });
  }
});

// ------------------- Player UI (por si acceden directo a /player.html) -------------------
app.get("/player.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "player.html"));
});

// ------------------- Run -------------------
app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
