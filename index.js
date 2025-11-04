// index.js
const express = require('express');
const path = require('path');
const app = express();

// Cho phép Express phục vụ thư mục 'public' để Zalo có thể truy cập file xác minh
app.use(express.static(path.join(__dirname, 'public')));

// Trang chính (test)
app.get('/', (req, res) => {
  res.send('💧 Zalo Bot 206 đang hoạt động!');
});

// Khởi chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
  console.log(`🌐 Kiểm tra file xác minh tại: https://zalo-bot-206.onrender.com/zalo_verifierCyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html`);
});
