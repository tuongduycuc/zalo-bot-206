const express = require('express');
const path = require('path');
const app = express();

// Phục vụ tĩnh thư mục 'public' để Zalo có thể đọc file xác minh
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('💧 OA 206 bot đang hoạt động (đã mở quyền xác minh domain)');
});

app.post('/webhook', express.json(), (req, res) => {
  console.log('Webhook:', req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`🌐 Kiểm tra file xác minh tại: https://zalo-bot-206.onrender.com/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});
