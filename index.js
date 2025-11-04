// === OA 206 Zalo Bot Server ===
// Cấu hình hoàn chỉnh để xác thực domain + nhận Webhook từ Zalo OA

const express = require('express');
const path = require('path');
const app = express();

// ✅ Cho phép phục vụ file tĩnh (để Zalo có thể xác minh file HTML)
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// ✅ Endpoint phục vụ file xác thực domain
app.get('/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html'));
});

// ✅ Trang test hoạt động chính
app.get('/', (req, res) => {
  res.send('💧 OA 206 bot đang hoạt động (đã bật phục vụ file xác minh Zalo)');
});

// ✅ Webhook endpoint - Zalo OA sẽ gửi sự kiện về đây
app.post('/webhook', express.json(), (req, res) => {
  console.log('Webhook received:', req.body);
  res.sendStatus(200);
});

// ✅ Chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`🌐 Kiểm tra xác minh tại: https://zalo-bot-206.onrender.com/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});
