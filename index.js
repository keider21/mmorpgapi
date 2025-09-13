const express = require("express");
const app = express();

// Cloud Run te da el puerto en PORT
const PORT = process.env.PORT || 8080;

// Para que acepte JSON si más adelante haces POST
app.use(express.json());

// Ruta principal
app.get("/", (req, res) => {
  res.send("Hello World desde mmorpgapi!");
});

// Estado simple en JSON
app.get("/status", (req, res) => {
  res.json({ ok: true, service: "mmorpgapi", time: new Date().toISOString() });
});

// Suma dos números: /sum?a=2&b=3  -> { result: 5 }
app.get("/sum", (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return res.status(400).json({ error: "Usa /sum?a=NUM&b=NUM" });
  }
  res.json({ result: a + b });
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
