const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// ✅ Phục vụ file xác minh HTML chính xác theo tên
app.get('/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html', (req, res) => {
  const filePath = path.join(__dirname, 'zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html');
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(filePath);
});

// ✅ Trang kiểm tra hoạt động
app.get('/', (req, res) => {
  res.send('💧 OA 206 bot đang hoạt động và sẵn sàng xác thực!');
});

// ✅ Webhook (để Zalo gọi sau khi xác thực)
app.post('/webhook', express.json(), (req, res) => {
  console.log(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot đang chạy tại cổng ${PORT}`));
