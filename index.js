import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = "XzfP9dlmHLU2rLegSVvCMOBLLYfdhYaYbTvjDntuS020dXLf3U9F7PAx5HGKxNbYffC1SXZuM6MOcqvxFhu3POBVJdC7fmHpjk1002wz81kFm45h5QO5MUtH4qyHZamudUHMAM2VEYRulbCHU-Wz7DMLV1Glu0mNXQfo6IQDBGUNm4iP2x0X3PBaTWGUl0y1eyPG0bwuBXRlmMivTeCT8jluK0LPZ4ODegmz4opiNXAYZXyRESHZ9hZc22mcn74cjO4JAZRcL1ISW3rZRzXQTlQiFbrKwKPpte4lHNtODYpFXauwRl0c4vRKSHDhYpSdoQejKs7YRK_VW7ffODutUDkFTaHsnJGrzU5p5tEcFGoLpYOVQSiIBqHuvaLL"; // 👈 Thay token OA thật vào đây
const GROUP_ID = "GROUP_ID_CUA_NHOM"; // 👈 Lấy trong webhook khi nhận tin nhắn nhóm

app.use(bodyParser.json());

// === Hàm tiện ích ===
const TASK_FILE = "./tasks.json";

function loadTasks() {
  if (!fs.existsSync(TASK_FILE)) return [];
  return JSON.parse(fs.readFileSync(TASK_FILE, "utf8"));
}

function saveTasks(tasks) {
  fs.writeFileSync(TASK_FILE, JSON.stringify(tasks, null, 2));
}

function nowVN() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// === Webhook nhận tin nhắn ===
app.post("/webhook", async (req, res) => {
  const data = req.body;
  res.status(200).send("OK");

  if (data.event_name === "user_send_text") {
    const sender = data.sender.id;
    const message = data.message.text.trim();
    const timestamp = nowVN();

    let tasks = loadTasks();

    // Kiểm tra nếu là phản hồi hoàn thành
    if (/(đã xong|ok|hoàn thành|đã xử lý)/i.test(message)) {
      const lastTask = tasks.reverse().find(t => t.sender === sender && !t.done);
      if (lastTask) lastTask.done = true;
      saveTasks(tasks.reverse());
      console.log(`✅ Đánh dấu hoàn thành: ${sender}`);
      return;
    }

    // Ngược lại: thêm công việc mới
    tasks.push({ sender, message, time: timestamp, done: false });
    saveTasks(tasks);
    console.log(`📋 Nhiệm vụ mới: ${sender} → ${message}`);
  }
});

// === Gửi báo cáo 17h hàng ngày ===
setInterval(async () => {
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  if (h === 17 && m === 0) {
    const tasks = loadTasks();
    if (!tasks.length) return;

    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);

    let msg = `📅 Báo cáo ngày ${new Date().toLocaleDateString("vi-VN")}\n\n`;
    msg += "✅ Đã hoàn thành:\n";
    msg += done.length ? done.map(t => `- ${t.message}`).join("\n") : "Không có\n";
    msg += "\n⚠️ Chưa hoàn thành:\n";
    msg += pending.length ? pending.map(t => `- ${t.message}`).join("\n") : "Không có";

    try {
      await axios.post(
        "https://openapi.zalo.me/v3.0/oa/message/callback",
        {
          recipient: { user_id: GROUP_ID },
          message: { text: msg },
        },
        {
          headers: {
            access_token: ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("🕔 Đã gửi báo cáo 17h thành công!");
      saveTasks([]); // reset danh sách cho ngày mới
    } catch (err) {
      console.error("❌ Lỗi gửi báo cáo:", err.response?.data || err.message);
    }
  }
}, 60000); // kiểm tra mỗi phút

app.get("/", (req, res) => res.send("💧 Zalo Task Bot 206 đang chạy!"));
app.listen(PORT, () => console.log(`🚀 Server tại cổng ${PORT}`));
