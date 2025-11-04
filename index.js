import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;

// Cho phép phục vụ file trong thư mục "public"
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Zalo bot đang hoạt động 🚀');
});

app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
});
