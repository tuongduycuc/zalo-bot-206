// === OA 206 Zalo Bot Server (Final Verified Version) ===

const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

// ✅ Bật phục vụ file tĩnh (đảm bảo Zalo có thể đọc file HTML xác minh)
app.use(express.static(__dirname));

// ✅ Endpoint phục vụ file xác minh Zalo với MIME chính xác
app.get('/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html', (req, res) => {
  const filePath = path.join(__dirname, 'zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(filePath, 'utf8'));
});

// ✅ Trang kiểm tra hoạt động
app.get('/', (req, res) => {
  res.send('💧 OA 206 bot đang hoạt động (đã tối ưu xác thực Zalo)');
});

// ✅ Webhook endpoint (Zalo OA gửi sự kiện về đây)
app.post('/webhook', express.json(), (req, res) => {
  console.log('Webhook event:', req.body);
  res.sendStatus(200);
});

// ✅ Chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`✅ Kiểm tra file xác minh tại: https://zalo-bot-206.onrender.com/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});
