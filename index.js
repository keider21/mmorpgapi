import express from "express";
import { Firestore } from "@google-cloud/firestore";

const app = express();
const db = new Firestore(); // En Cloud Run usa credenciales del servicio automáticamente
const PORT = process.env.PORT || 8080;

/**
 * Estructura en Firestore (lo que ya creaste):
 * /world_progress            (colección)
 *   └─ global                (documento)
 *       ├─ fields: { goal, stage, current }
 *       └─ world_progress    (subcolección con jugadores)
 *           └─ {docId} -> { name, level, ... }
 */

app.get("/", (_req, res) => {
  res.json({
    service: "mmorpgapi",
    time: new Date().toISOString(),
    endpoints: ["/world"]
  });
});

app.get("/world", async (_req, res) => {
  try {
    // 1) Progreso global
    const globalRef = db.collection("world_progress").doc("global");
    const globalSnap = await globalRef.get();

    if (!globalSnap.exists) {
      return res.status(404).json({ error: "No existe world_progress/global" });
    }

    const globalData = globalSnap.data(); // { goal, stage, current }

    // 2) Jugadores (subcolección world_progress dentro del doc global)
    const playersSnap = await globalRef.collection("world_progress").get();
    const players = playersSnap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    // 3) Respuesta combinada
    return res.json({
      global: globalData,
      players
    });
  } catch (err) {
    console.error("Error en /world:", err);
    res.status(500).json({ error: "Error interno en /world" });
  }
});

app.listen(PORT, () => {
  console.log(`mmorpgapi escuchando en puerto ${PORT}`);
});
