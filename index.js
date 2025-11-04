import express from "express";
const app = express();
const PORT = process.env.PORT || 3000;

// Cho phép truy cập các file trong thư mục public
app.use(express.static("public"));

// Trang chính
app.get("/", (req, res) => {
  res.send(`
    <h1>💧 Zalo Bot đang chạy!</h1>
    <p>Truy cập file xác minh Zalo tại:
      <a href="/zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html">
        /zalo-verifier-CyU78lIr33n_e8ePfgaWBqVNbN6hg4OgDZC.html
      </a>
    </p>
  `);
});

// Chạy server
app.listen(PORT, () => {
  console.log(`🚀 Bot đang chạy tại cổng ${PORT}`);
});
