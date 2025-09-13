import express from "express";
import { Firestore } from "@google-cloud/firestore";

const app = express();
const port = process.env.PORT || 8080;

// Inicializar Firestore
const firestore = new Firestore();

// Ruta para probar lectura de jugadores
app.get("/players", async (req, res) => {
  const snapshot = await firestore.collection("players").get();
  const players = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json(players);
});

// Ruta para crear un jugador
app.post("/players", express.json(), async (req, res) => {
  const { name, level } = req.body;
  const docRef = await firestore.collection("players").add({ name, level });
  res.json({ id: docRef.id, name, level });
});

app.listen(port, () => {
  console.log(`API MMORPG corriendo en puerto ${port}`);
});
