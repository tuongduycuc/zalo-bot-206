// index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// Lấy đường dẫn tuyệt đối cho file (Render cần khi deploy)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ B1: Cho phép truy cập file tĩnh (public folder)
app.use(express.static(path.join(__dirname, "public")));

// ✅ B2: Trang chính test bot
app.get("/", (req, res) => {
  res.send(`
    <h2>💧 Zalo Bot đang chạy!</h2>
    <p>Truy cập file xác minh Zalo tại: 
      <a href="/CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html" target="_blank">
        /CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html
      </a>
    </p>
  `);
});

// ✅ B3: (Tùy chọn) Kiểm tra thủ công đường dẫn file xác minh
app.get("/verify", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html"));
});

// ✅ B4: Lắng nghe cổng 3000 (Render sẽ tự set PORT)
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`🌐 Kiểm tra file xác minh tại: https://zalo-bot-206.onrender.com/CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});
