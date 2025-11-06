// index.js - Dạng ES Module (Render hỗ trợ tốt nhất)
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN || "XzfP9dlmHLU2rLegSVvCMOBLLYfdhYaYbTvjDntuS020dXLf3U9F7PAx5HGKxNbYffC1SXZuM6MOcqvxFhu3POBVJdC7fmHpjk1002wz81kFm45h5QO5MUtH4qyHZamudUHMAM2VEYRulbCHU-Wz7DMLV1Glu0mNXQfo6IQDBGUNm4iP2x0X3PBaTWGUl0y1eyPG0bwuBXRlmMivTeCT8jluK0LPZ4ODegmz4opiNXAYZXyRESHZ9hZc22mcn74cjO4JAZRcL1ISW3rZRzXQTlQiFbrKwKPpte4lHNtODYpFXauwRl0c4vRKSHDhYpSdoQejKs7YRK_VW7ffODutUDkFTaHsnJGrzU5p5tEcFGoLpYOVQSiIBqHuvaLL";
let GROUP_ID = process.env.GROUP_ID || "";

const TASK_FILE = "./tasks.json";
const GROUP_FILE = "./group.json";

app.use(bodyParser.json());

// ====== HÀM HỖ TRỢ ======
function loadTasks() {
  try {
    if (!fs.existsSync(TASK_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASK_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveTasks(tasks) {
  fs.writeFileSync(TASK_FILE, JSON.stringify(tasks, null, 2));
}

function loadGroupId() {
  try {
    if (!fs.existsSync(GROUP_FILE)) return "";
    const o = JSON.parse(fs.readFileSync(GROUP_FILE, "utf8"));
    return o.group_id || "";
  } catch {
    return "";
  }
}
function saveGroupId(id) {
  GROUP_ID = id;
  fs.writeFileSync(GROUP_FILE, JSON.stringify({ group_id: id }, null, 2));
  console.log("🔐 Đã lưu GROUP_ID:", id);
}

if (!GROUP_ID) GROUP_ID = loadGroupId();

async function sendTextToGroup(text) {
  if (!GROUP_ID) {
    console.log("⚠️ Chưa có GROUP_ID để gửi tin nhắn.");
    return;
  }
  try {
    await axios.post(
      "https://openapi.zalo.me/v3.0/oa/message/callback",
      {
        recipient: { group_id: GROUP_ID },
        message: { text }
      },
      {
        headers: {
          access_token: ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Đã gửi tin nhắn vào nhóm.");
  } catch (err) {
    console.error("❌ Lỗi gửi tin nhắn:", err.response?.data || err.message);
  }
}

const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  const data = req.body;
  res.status(200).send("OK");

  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    "";

  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  if (data.event_name === "user_send_text") {
    const sender = data.sender?.id || "unknown";
    const text = (data.message?.text || "").trim();

    if (/^\/groupid$/i.test(text)) {
      await sendTextToGroup(GROUP_ID ? `GROUP_ID hiện tại: ${GROUP_ID}` : "Chưa có GROUP_ID.");
      return;
    }

    let tasks = loadTasks();

    if (DONE_REGEX.test(text)) {
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].sender === sender && !tasks[i].done) {
          tasks[i].done = true;
          break;
        }
      }
      saveTasks(tasks);
      return;
    }

    tasks.push({ sender, message: text, done: false });
    saveTasks(tasks);
  }
});

app.get("/", (req, res) => {
  res.send("<h2>💧 Zalo Task Bot đang chạy!</h2>");
});

// ====== BÁO CÁO 17:00 ======
setInterval(async () => {
  const now = new Date();
  const h = now.getHours() + 7 > 23 ? now.getHours() - 17 : now.getHours() + 7; // giờ VN
  const m = now.getMinutes();
  if (h === 17 && m === 0) {
    const tasks = loadTasks();
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);
    let msg = `📅 Báo cáo ngày ${now.toLocaleDateString("vi-VN")}\n\n`;
    msg += "✅ ĐÃ HOÀN THÀNH:\n" + (done.length ? done.map(t => `• ${t.message}`).join("\n") : "• Không có") + "\n\n";
    msg += "⚠️ CHƯA HOÀN THÀNH:\n" + (pending.length ? pending.map(t => `• ${t.message}`).join("\n") : "• Không có");
    await sendTextToGroup(msg);
    saveTasks([]);
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
});
