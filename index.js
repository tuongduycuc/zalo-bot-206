const express = require("express");
const path = require("path");
const app = express();

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.type("text/html").send(`
    <h2>💧 OA 206 bot đang hoạt động!</h2>
    <p>File xác minh (hyphen): <a href="/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html">zalo-verifier-CyU78lIr33n...</a></p>
    <p>File xác minh (underscore): <a href="/zalo_verifierCyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html">zalo_verifierCyU78lIr33n...</a></p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`🌐 Kiểm tra file xác minh (hyphen): https://zalo-bot-206.onrender.com/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});