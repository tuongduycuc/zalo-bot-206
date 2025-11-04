const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
// Cho phép Express phục vụ file tĩnh trong thư mục gốc
const path = require('path');
app.use(express.static(path.join(__dirname, '.')));
app.use(bodyParser.json());

// ✅ Kiểm tra bot
app.get('/', (req, res) => res.send('💧 OA 206 bot đang hoạt động!'));

// ✅ Webhook nhận tin nhắn từ Zalo
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📩 Nhận dữ liệu:', JSON.stringify(body, null, 2));

  // Nếu là tin nhắn người dùng gửi đến OA
  if (body.event_name === 'user_send_text') {
    const text = body.message.text;
    const userId = body.sender.id;
    console.log(`Tin từ ${userId}: ${text}`);

    // Gửi lại phản hồi
    await axios.post('https://openapi.zalo.me/v3.0/oa/message/callback', {
      recipient: { user_id: userId },
      message: { text: `Cảm ơn bạn, OA 206 đã nhận: ${text}` }
    }, {
      headers: { access_token: process.env.ACCESS_TOKEN }
    });
  }

  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot đang chạy tại cổng ${PORT}`));
