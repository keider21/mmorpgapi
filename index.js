const express = require('express');
const app = express();

const PORT = process.env.PORT || 8080;   // Cloud Run define PORT

app.get('/', (req, res) => {
  res.send('Hello desde mmorpgapi!');
});

// MUY IMPORTANTE: escuchar en 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
