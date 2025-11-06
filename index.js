// index.js — Zalo Task Bot cho nhóm
// Yêu cầu: npm i express body-parser axios
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CẤU HÌNH CẦN ĐIỀN ======
const ACCESS_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN || "XzfP9dlmHLU2rLegSVvCMOBLLYfdhYaYbTvjDntuS020dXLf3U9F7PAx5HGKxNbYffC1SXZuM6MOcqvxFhu3POBVJdC7fmHpjk1002wz81kFm45h5QO5MUtH4qyHZamudUHMAM2VEYRulbCHU-Wz7DMLV1Glu0mNXQfo6IQDBGUNm4iP2x0X3PBaTWGUl0y1eyPG0bwuBXRlmMivTeCT8jluK0LPZ4ODegmz4opiNXAYZXyRESHZ9hZc22mcn74cjO4JAZRcL1ISW3rZRzXQTlQiFbrKwKPpte4lHNtODYpFXauwRl0c4vRKSHDhYpSdoQejKs7YRK_VW7ffODutUDkFTaHsnJGrzU5p5tEcFGoLpYOVQSiIBqHuvaLL"; // <- thay token OA thật
// GROUP_ID sẽ được tự động bắt và lưu khi bot nhận tin nhắn trong nhóm lần đầu
let GROUP_ID = process.env.GROUP_ID || "";

// ====== FILE LƯU TẠM ======
const TASK_FILE  = "./tasks.json";   // lưu nhiệm vụ trong ngày
const GROUP_FILE = "./group.json";   // lưu group_id nhận được

// ====== HỖ TRỢ ======
app.use(bodyParser.json());

// đọc / ghi tasks an toàn
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

// lưu / nạp GROUP_ID
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

// nạp nếu có sẵn
if (!GROUP_ID) GROUP_ID = loadGroupId();

// Thời gian VN
function getVNDate() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
function getVNParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    Y: parts.year,
    M: parts.month,
    D: parts.day,
    h: parseInt(parts.hour, 10),
    m: parseInt(parts.minute, 10),
    dateStr: `${parts.day}/${parts.month}/${parts.year}`
  };
}

// Gửi text qua OA API (mặc định: gửi vào nhóm qua group_id)
async function sendTextToGroup(text) {
  if (!GROUP_ID) {
    console.log("⚠️ Chưa có GROUP_ID để gửi báo cáo.");
    return;
  }
  try {
    await axios.post(
      "https://openapi.zalo.me/v3.0/oa/message/callback",
      {
        recipient: { group_id: GROUP_ID }, // gửi vào nhóm
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

// Regex nhận diện hoàn thành
const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ====== WEBHOOK: Zalo gọi vào đây ======
app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("📩 Webhook payload:", JSON.stringify(data, null, 2));
  res.status(200).send("OK"); // luôn 200 cho Zalo

  // 1) Tự động bắt GROUP_ID từ payload lần đầu
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    "";

  if (detectedGroupId && !GROUP_ID) {
    saveGroupId(detectedGroupId);
  }

  // 2) Xử lý tin nhắn văn bản của người dùng
  if (data.event_name === "user_send_text") {
    const sender = data.sender?.id || "unknown";
    const text   = (data.message?.text || "").trim();
    const nowStr = getVNDate();

    // Lệnh test nhanh: /groupid
    if (/^\/groupid$/i.test(text)) {
      if (GROUP_ID) {
        await sendTextToGroup(`GROUP_ID hiện tại: ${GROUP_ID}`);
      } else {
        await sendTextToGroup(`Chưa ghi nhận GROUP_ID. Hãy gửi 1 tin bất kỳ trong nhóm để bot tự lưu.`);
      }
      return;
    }

    let tasks = loadTasks();

    // Nếu là tin nhắn xác nhận đã hoàn thành
    if (DONE_REGEX.test(text)) {
      // đánh dấu công việc CHƯA hoàn thành gần nhất của người này
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].sender === sender && !tasks[i].done) {
          tasks[i].done = true;
          tasks[i].doneAt = nowStr;
          break;
        }
      }
      saveTasks(tasks);
      console.log(`✅ Đánh dấu hoàn thành cho ${sender}`);
      return;
    }

    // Ngược lại: thêm nhiệm vụ mới
    tasks.push({
      sender,
      message: text,
      time: nowStr,
      done: false
    });
    saveTasks(tasks);
    console.log(`📋 Thêm nhiệm vụ: (${sender}) → ${text}`);
  }
});

// (GET) Kiểm tra nhanh webhook
app.get("/webhook", (req, res) => {
  res.send("Webhook Zalo đang hoạt động ✅");
});

// Debug: xem tasks hiện tại
app.get("/tasks", (req, res) => {
  res.json(loadTasks());
});

// Debug: xoá tasks (reset ngày)
app.post("/tasks/reset", (req, res) => {
  saveTasks([]);
  res.send("Đã reset danh sách nhiệm vụ.");
});

// Trang chủ
app.get("/", (req, res) => {
  res.send(`<h2>💧 Zalo Task Bot đang chạy!</h2>
  <ul>
    <li>Webhook: <code>POST /webhook</code></li>
    <li>Xem nhiệm vụ: <a href="/tasks">/tasks</a></li>
  </ul>`);
});

// ====== LỊCH GỬI BÁO CÁO 17:00 HÀNG NGÀY ======
let lastReportDate = ""; // để tránh gửi trùng trong cùng ngày
setInterval(async () => {
  const { Y, M, D, h, m, dateStr } = getVNParts();
  if (h === 17 && m === 0 && lastReportDate !== `${Y}-${M}-${D}`) {
    const tasks = loadTasks();
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);

    let msg = `📅 Báo cáo ngày ${dateStr}\n\n`;
    msg += "✅ ĐÃ HOÀN THÀNH:\n";
    msg += done.length ? done.map(t => `• ${t.message}`).join("\n") : "• Không có\n";
    msg += "\n⚠️ CHƯA HOÀN THÀNH:\n";
    msg += pending.length ? pending.map(t => `• ${t.message}`).join("\n") : "• Không có";

    await sendTextToGroup(msg);

    // Reset danh sách sau khi báo cáo
    saveTasks([]);
    lastReportDate = `${Y}-${M}-${D}`;
    console.log("🕔 Đã gửi báo cáo 17:00 & reset danh sách.");
  }
}, 15 * 1000); // kiểm tra mỗi 15 giây (nhẹ nhàng hơn mỗi phút)

// ====== KHỞI ĐỘNG ======
app.listen(PORT, () => {
  console.log(`🚀 Server chạy cổng ${PORT}`);
  console.log(`ℹ️ Nhớ đặt ZALO_OA_ACCESS_TOKEN trong Render (Environment)`);
});
