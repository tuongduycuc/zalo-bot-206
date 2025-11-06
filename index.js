import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// Cho phép Zalo gửi JSON body
app.use(bodyParser.json());

// Route mặc định (trang chủ)
app.get("/", (req, res) => {
  res.send(`
    <h1>💧 Zalo Bot đang chạy!</h1>
    <p>Webhook: <a href="/webhook">/webhook</a></p>
  `);
});

// 🟢 Route webhook — Zalo sẽ gửi POST request đến đây
app.post("/webhook", (req, res) => {
  console.log("📩 Nhận dữ liệu từ Zalo:", req.body);

  // Bắt buộc phải trả về HTTP 200 OK
  res.status(200).send("OK");
});

// (Tuỳ chọn) kiểm tra bằng GET
app.get("/webhook", (req, res) => {
  res.send("Webhook Zalo đang hoạt động ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
