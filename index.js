// index.js
import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// servir archivos estáticos (admin.html) desde /public
app.use(express.static("public"));

const db = new Firestore();
const PORT = process.env.PORT || 8080;

// nombres de colecciones/doc
const ROOT_COLLECTION = "world_progress";
const GLOBAL_DOC_ID = "global";
const PLAYERS_SUBCOLL = "world_progress"; // subcolección dentro del doc global

// Home: muestra endpoints
app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    endpoints: ["/global (GET|PATCH)", "/players (GET)", "/players/:name (PUT)"],
    time: new Date().toISOString(),
  });
});

/* --------- GLOBAL PROGRESS ---------- */

// GET /global -> lee current/goal/stage
app.get("/global", async (_req, res) => {
  try {
    const snap = await db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .get();
    const data = snap.exists ? snap.data() : { current: 0, goal: 0, stage: 0 };
    res.json({
      current: Number(data.current || 0),
      goal: Number(data.goal || 0),
      stage: Number(data.stage || 0),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_get_global" });
  }
});

// PATCH /global  {current?, goal?, stage?}
app.patch("/global", async (req, res) => {
  try {
    const { current, goal, stage } = req.body || {};
    const payload = {};
    if (Number.isFinite(current)) payload.current = Number(current);
    if (Number.isFinite(goal)) payload.goal = Number(goal);
    if (Number.isFinite(stage)) payload.stage = Number(stage);

    await db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .set(payload, { merge: true });

    const snap = await db.collection(ROOT_COLLECTION).doc(GLOBAL_DOC_ID).get();
    res.json(snap.data() || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_patch_global" });
  }
});

/* --------- PLAYERS ---------- */

// GET /players -> lista jugadores (name, level)
app.get("/players", async (_req, res) => {
  try {
    const col = db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL);
    const qs = await col.get();
    const items = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_list_players" });
  }
});

// PUT /players/:name  { level }
app.put("/players/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    const level = Number(req.body?.level ?? 0);
    if (!name) return res.status(400).json({ error: "name_required" });

    const ref = db
      .collection(ROOT_COLLECTION)
      .doc(GLOBAL_DOC_ID)
      .collection(PLAYERS_SUBCOLL)
      .doc(name);

    await ref.set({ name, level: Number.isFinite(level) ? level : 0 }, { merge: true });
    const snap = await ref.get();
    res.json(snap.data() || { name, level: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_upsert_player" });
  }
});

app.listen(PORT, () => {
  console.log(`mmorpgapi listening on ${PORT}`);
});
