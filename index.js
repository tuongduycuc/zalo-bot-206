const express = require('express');
const path = require('path');
const app = express();

// Cho phép Express phục vụ file tĩnh ở thư mục gốc
app.use(express.static(path.join(__dirname)));

// Trang mặc định
app.get('/', (req, res) => {
  res.send('💧 OA 206 bot đang hoạt động!');
});

// Webhook endpoint (để sau dùng Zalo)
app.post('/webhook', express.json(), (req, res) => {
  console.log(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot đang chạy tại cổng ${PORT}`));
