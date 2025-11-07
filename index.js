// index.js — ESM, chạy trên Node 18+ (Render hỗ trợ tốt)
// CÁC TÍNH NĂNG CHÍNH
// - Nhận Webhook (tùy chọn verify chữ ký)
// - Tự phát hiện & lưu GROUP_ID khi có sự kiện từ nhóm
// - Lệnh /groupid để xem group hiện tại
// - Ghi nhận "task" theo từng người, đánh dấu xong khi thấy từ khóa "đã xong/ok/..."
// - Cron 17:00 (giờ VN) gửi BÁO CÁO NGÀY vào nhóm GMF
// - API test: GET /send?text=... để gửi thử vào nhóm

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

/* ====== CẤU HÌNH TỪ .env ====== */
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  ""; // BẮT BUỘC: token OA có quyền GMF

// (Tuỳ chọn) nếu muốn bật verify chữ ký Webhook, đặt VERIFY_SIGNATURE=true
const VERIFY_SIGNATURE = String(process.env.VERIFY_SIGNATURE || "false").toLowerCase() === "true";

// Tuỳ tài liệu tích hợp của OA/GMF/ZNS, có 2 kiểu verify phổ biến.
// Đặt SIGN_MODE=1: sha256(data + ZALO_API_KEY)
// Đặt SIGN_MODE=2: sha256(appId + data + timeStamp + OA_SECRET)
const SIGN_MODE = Number(process.env.SIGN_MODE || 1);
const ZALO_API_KEY = process.env.ZALO_API_KEY || ""; // cho SIGN_MODE=1
const OA_APP_ID = process.env.OA_APP_ID || "";       // cho SIGN_MODE=2
const OA_SECRET = process.env.OA_SECRET || "";       // cho SIGN_MODE=2

let GROUP_ID = process.env.GROUP_ID || ""; // có thể điền sẵn để khỏi auto detect

/* ====== FILE LƯU TẠM (lưu ý: host ephemeral sẽ mất khi restart) ====== */
const TASK_FILE = "./tasks.json";
const GROUP_FILE = "./group.json";

app.use(bodyParser.json({ limit: "2mb" }));

/* ====== HÀM HỖ TRỢ LƯU/ĐỌC ====== */
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
  if (!id) return;
  GROUP_ID = id;
  fs.writeFileSync(GROUP_FILE, JSON.stringify({ group_id: id }, null, 2));
  console.log("🔐 Đã lưu GROUP_ID:", id);
}

if (!GROUP_ID) GROUP_ID = loadGroupId();

/* ====== GỬI TIN NHẮN VÀO NHÓM GMF ====== */
async function sendTextToGroup(text) {
  if (!GROUP_ID) {
    console.log("⚠️ Chưa có GROUP_ID để gửi tin nhắn.");
    return;
  }
  try {
    const url = "https://openapi.zalo.me/v3.0/oa/group/message"; // ✅ endpoint nhóm GMF
    const body = {
      recipient: { group_id: GROUP_ID },
      message: { text }
    };
    const r = await axios.post(url, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`, // ✅ bearer token
      },
      timeout: 15000
    });
    console.log("✅ Đã gửi tin nhắn vào nhóm:", r.data);
  } catch (err) {
    console.error("❌ Lỗi gửi tin nhắn:", err.response?.data || err.message);
  }
}

/* ====== TỪ KHOÁ ĐÁNH DẤU HOÀN THÀNH ====== */
const DONE_REGEX = /(đã xong|da xong|\bok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

/* ====== VERIFY CHỮ KÝ (tuỳ chọn) ====== */
function verifySignature(req) {
  try {
    const sig = req.get("X-ZEvent-Signature");
    if (!sig) return false;

    const data = JSON.stringify(req.body);
    if (SIGN_MODE === 2) {
      const ts = req.get("X-ZEvent-Timestamp") || ""; // tuỳ nền tảng có header timestamp hay không
      const toHash = `${OA_APP_ID}${data}${ts}${OA_SECRET}`;
      const expect = crypto.createHash("sha256").update(toHash).digest("hex");
      return sig === expect;
    } else {
      // Mặc định SIGN_MODE=1
      const toHash = `${data}${ZALO_API_KEY}`;
      const expect = crypto.createHash("sha256").update(toHash).digest("hex");
      return sig === expect;
    }
  } catch {
    return false;
  }
}

/* ====== WEBHOOK ====== */
app.post("/webhook", async (req, res) => {
  try {
    if (VERIFY_SIGNATURE && !verifySignature(req)) {
      return res.status(401).send("BAD SIGNATURE");
    }

    // Tạm log nhẹ để debug (nên giảm log ở production)
    console.log("📩 Webhook:", JSON.stringify(req.body));

    // Trả lời ngay cho Zalo
    res.status(200).send("OK");

    const data = req.body;

    // Thử phát hiện GROUP_ID từ nhiều vị trí khác nhau
    const detectedGroupId =
      data?.recipient?.group_id ||
      data?.message?.conversation_id ||
      data?.conversation?.id ||
      data?.group_id ||
      "";

    if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

    // BẮT SỰ KIỆN TIN NHẮN (1–1 hoặc nhóm GMF tuỳ event_name của payload)
    const eventName = data?.event_name || data?.event || "";
    const text = (data?.message?.text || data?.text || "").trim();
    const sender = data?.sender?.id || data?.from_id || "unknown";

    // Lệnh trong nhóm/1-1: /groupid → trả GROUP_ID
    if (/^\/groupid$/i.test(text)) {
      await sendTextToGroup(GROUP_ID ? `GROUP_ID hiện tại: ${GROUP_ID}` : "Chưa có GROUP_ID.");
      return;
    }

    // Ghi task nếu là tin nhắn người dùng
    // Một số event_name phổ biến: "user_send_text" (1-1), "group.message" (nhóm)
    if (text && /send|message/i.test(eventName)) {
      let tasks = loadTasks();

      if (DONE_REGEX.test(text)) {
        // Đánh dấu task gần nhất của chính người gửi là done
        for (let i = tasks.length - 1; i >= 0; i--) {
          if (tasks[i].sender === sender && !tasks[i].done) {
            tasks[i].done = true;
            tasks[i].done_at = Date.now();
            break;
          }
        }
        saveTasks(tasks);
        return;
      }

      // Lưu task mới
      tasks.push({
        sender,
        message: text,
        done: false,
        ts: Date.now()
      });
      saveTasks(tasks);
    }
  } catch (e) {
    console.error("🔥 Webhook error:", e);
    // cố gắng vẫn trả 200 nếu chưa gửi
    if (!res.headersSent) res.status(200).send("OK");
  }
});

/* ====== TRANG CHỦ & HEALTHCHECK ====== */
app.get("/", (req, res) => {
  res.send(`<h2>💧 Zalo Task Bot đang chạy!</h2>
  <p>GROUP_ID: ${GROUP_ID || "(chưa có)"} — <a href="/health">health</a></p>`);
});
app.get("/health", (req, res) => res.json({ ok: true, group_id: GROUP_ID ? true : false }));

/* ====== API GỬI THỬ ====== */
// Ví dụ: GET /send?text=Hello
app.get("/send", async (req, res) => {
  const text = req.query.text || "Test gửi vào nhóm GMF";
  await sendTextToGroup(String(text));
  res.json({ sent: true, text });
});

/* ====== BÁO CÁO 17:00 (giờ VN - Asia/Ho_Chi_Minh) ====== */
setInterval(async () => {
  const now = new Date();
  const h = (now.getUTCHours() + 7) % 24; // VN = UTC+7
  const m = now.getUTCMinutes();

  if (h === 17 && m === 0) {
    const tasks = loadTasks();
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);

    // Tạo nội dung báo cáo ngắn gọn
    let msg = `📅 Báo cáo ngày ${now.toLocaleDateString("vi-VN")}\n\n`;
    msg += "✅ ĐÃ HOÀN THÀNH:\n" + (done.length ? done.map(t => `• ${t.message}`).join("\n") : "• Không có") + "\n\n";
    msg += "⚠️ CHƯA HOÀN THÀNH:\n" + (pending.length ? pending.map(t => `• ${t.message}`).join("\n") : "• Không có");

    await sendTextToGroup(msg);

    // Reset danh sách sau khi báo cáo
    saveTasks([]);
  }
}, 60 * 1000);

/* ====== KHỞI CHẠY ====== */
app.listen(PORT, () => {
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
  if (!ACCESS_TOKEN) {
    console.warn("⚠️ Thiếu ZALO_OA_ACCESS_TOKEN — hãy cấu hình trong biến môi trường!");
  }
});
