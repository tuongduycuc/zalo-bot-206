// index.js - OA group bot (v3) — full, ready-to-drop-in
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import XLSX from "xlsx";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ====== ENV ======
const OA_TOKEN  = process.env.ZALO_OA_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "";
let   GROUP_ID  = process.env.GROUP_ID || "";
const VERIFY_SIGNATURE = String(process.env.VERIFY_SIGNATURE || "false").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || "Asia/Bangkok";

// ====== FILES ======
const TASK_FILE  = "./tasks.json";
const GROUP_FILE = "./group.json";

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
  console.log("🔐 Saved GROUP_ID:", id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

// ====== CONFIG ======
// Không xác nhận khi auto-ghi việc để đỡ spam:
const AUTO_TODO_CONFIRM = false;
// Vẫn cho phép auto-ghi việc (nhưng im lặng):
const AUTO_TODO = true;
// Tự động báo cáo lúc 17:00 giờ VN:
const DAILY_REPORT_ENABLED = true;

// DONE keyword:
const DONE_REGEX = /(đã xong|da xong|\bok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly|xong\b|ok đã xử lý)/i;

// ====== HELPERS ======
function clean(s) { return String(s || "").trim(); }
function nextTaskId(tasks) {
  return tasks.length ? Math.max(...tasks.map(t => Number(t.id) || 0)) + 1 : 1;
}
function render(t) {
  const flag = t.done ? "✅" : "⚠️";
  const who  = t.owner_name || t.owner_uid || "—";
  return `${flag} #${t.id} • ${t.message}  👤 ${who}`;
}
function extractFirstMentionName(text) {
  const s = String(text || '');
  const at = s.indexOf('@');
  if (at === -1) return '';
  const tail = s.slice(at + 1).trim();
  const stops = [
    tail.indexOf('  '),
    tail.indexOf('\n'),
    tail.toLowerCase().indexOf(' buc '),
    tail.toLowerCase().indexOf(' bục '),
    tail.toLowerCase().indexOf(' mat '),
    tail.toLowerCase().indexOf(' mất ')
  ].filter(i => i >= 0);
  const stopIdx = stops.length ? Math.min(...stops) : -1;
  const name = stopIdx > -1 ? tail.slice(0, stopIdx).trim() : tail;
  return name.length > 50 ? name.slice(0, 50).trim() : name;
}

// ====== ZALO V3 SEND ======
async function sendGroup(text) {
  if (!GROUP_ID) {
    console.log("⚠️ No GROUP_ID yet; cannot send.");
    return;
  }
  try {
    const r = await axios.post(
      "https://openapi.zalo.me/v3.0/oa/message/callback",
      { recipient: { group_id: GROUP_ID }, message: { text: text } },
      { headers: { access_token: OA_TOKEN, "Content-Type": "application/json" } }
    );
    // v3 trả "200 { error: 0, message: 'Success' }"
    if (r?.data?.error !== 0) {
      console.log("❌ Zalo v3 send error:", r.data);
    }
  } catch (err) {
    console.log("❌ Zalo v3 send exception:", err.response?.data || err.message);
  }
}

// ====== EXCEL EXPORT ======
function exportExcel(tasks, filename) {
  const rows = tasks.map(t => ({
    id: t.id,
    message: t.message,
    owner: t.owner_name || t.owner_uid || '',
    createdAt: t.createdAt || '',
    dueAt: t.dueAt || '',
    done: t.done ? 1 : 0,
    doneAt: t.doneAt || '',
    sender: t.sender || '',
    src_msg_id: t.src_msg_id || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
  XLSX.writeFile(wb, filename);
  return filename;
}

// ====== WEB ======
app.get("/", (req, res) => {
  res.send(`<h2>💧 Zalo Task Bot đang chạy!</h2>
<p>GROUP_ID: ${GROUP_ID || "(chưa có)"} — <a href="/health">health</a></p>`);
});
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  // Yêu cầu Zalo: trả 200 nhanh
  res.status(200).send("OK");

  const data = req.body || {};
  // Nếu có group id trong payload => lưu
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id || "";

  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  // Chỉ quan tâm text trong group
  if (data.event_name !== "user_send_group_text") return;

  const sender  = data?.sender?.id || "";
  const msgId   = data?.message?.msg_id || "";
  const textRaw = data?.message?.text || "";
  const text    = clean(textRaw);
  const quote   = data?.message?.quote_msg || {};  // nếu reply
  const quoteText   = clean(quote?.text || "");
  const quoteMsgId  = quote?.msg_id || "";
  const quoteSender = quote?.sender?.id || "";

  // Lệnh slash
  const isSlash = text.startsWith("/");

  // ========== LỆNH ==========
  if (isSlash) {
    const cmd = text.toLowerCase();

    if (cmd === "/list") {
      const tasks = loadTasks();
      const undone = tasks.filter(t => !t.done);
      if (!undone.length) {
        await sendGroup("📣 Không có việc.");
      } else {
        const lines = undone.slice(-10).map(render).join("\n");
        await sendGroup(`📣 Việc đang mở:\n${lines}`);
      }
      return;
    }

    if (cmd.startsWith("/report")) {
      const tasks = loadTasks();
      const done = tasks.filter(t => t.done);
      const pending = tasks.filter(t => !t.done);
      const msg =
        `🗓️ Báo cáo ${new Date().toLocaleString("vi-VN")}\n\n` +
        `✅ ĐÃ HOÀN THÀNH:\n` +
        (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
        `⚠️ CHƯA HOÀN THÀNH:\n` +
        (pending.length ? pending.map(t => `• ${render(t)}`).join("\n") : "• Không có");
      await sendGroup(msg);
      return;
    }

    if (cmd.startsWith("/export")) {
      // /export hoặc /export 2025-11-01..2025-11-11 (chưa lọc – giữ đơn giản)
      const tasks = loadTasks();
      const filename = `tasks_${Date.now()}.xlsx`;
      exportExcel(tasks, filename);
      await sendGroup("📄 Đã xuất Excel (file nằm trên server Render).");
      return;
    }

    // /groupid để xem/lưu group id
    if (cmd === "/groupid") {
      await sendGroup(GROUP_ID ? `GROUP_ID: ${GROUP_ID}` : "Chưa có GROUP_ID.");
      return;
    }

    // /help
    if (cmd === "/help") {
      await sendGroup(`Các lệnh: 
/list — liệt kê việc đang mở
/report — xuất báo cáo ngay
/export — xuất Excel (toàn bộ)
/groupid — xem group id
/help — trợ giúp`);
      return;
    }

    // các lệnh khác… bỏ qua
    return;
  }

  // ========== AUTO GHI VIỆC ==========
  // Chỉ khi không phải lệnh và trong nhóm
  if (AUTO_TODO) {
    const content = clean(text);
    if (content && content.length <= 500) {
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner_uid: sender,                         // gán chủ trì = người tạo
        owner_name: extractFirstMentionName(content) || "", // nếu câu có @..., lưu chủ trì theo tên
        message: content,
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        src_msg_id: msgId || '',
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      console.log("📝 AUTO_TODO:", { id: t.id, owner_uid: t.owner_uid, owner_name: t.owner_name, message: t.message });
      if (AUTO_TODO_CONFIRM) {
        await sendGroup(`📝 Đã ghi nhận việc: #${t.id} ${t.message}`);
      }
    }
  }

  // ========== ĐÁNH DẤU HOÀN THÀNH ==========
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    // 1) Nếu có reply/quote -> cố gắng tìm theo src_msg_id
    if (quoteMsgId) {
      let t = tasks.find(x => x.src_msg_id === quoteMsgId);
      if (!t) {
        // tạo mới task từ quote rồi đánh dấu xong
        let msg = quoteText || "(No text)";
        t = {
          id: nextTaskId(tasks),
          sender: quoteSender || sender || '',
          owner_uid: quoteSender || sender || '',
          owner_name: extractFirstMentionName(msg) || '',
          message: msg,
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: true,
          doneAt: new Date().toISOString(),
          src_msg_id: quoteMsgId,
          src_sender: quoteSender || ''
        };
        tasks.push(t); saveTasks(tasks);
        console.log("✅ DONE-by-quote (created new):", t.id);
        // Không thông báo thêm theo yêu cầu: "khi hoàn thành không cần thông báo"
        return;
      } else {
        if (!t.owner_uid)  t.owner_uid = quoteSender || sender || '';
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || '';
        t.done = true;
        t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        console.log("✅ DONE-by-quote (matched):", t.id);
        return;
      }
    }

    // 2) Không reply: tìm việc gần nhất của người này chưa xong
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (!t.done && (t.sender === sender || !t.owner_uid)) {
        t.done = true;
        t.doneAt = new Date().toISOString();
        if (!t.owner_uid)  t.owner_uid = sender || '';
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || '';
        saveTasks(tasks);
        console.log("✅ DONE-last-open:", t.id);
        return;
      }
    }

    // nếu không tìm thấy thì thôi, không báo
    return;
  }
});

// ====== TỰ ĐỘNG BÁO CÁO 17:00 HÀNG NGÀY ======
if (DAILY_REPORT_ENABLED) {
  setInterval(async () => {
    try {
      const now = new Date();
      const hoursVN = (now.getUTCHours() + 7) % 24;
      const m = now.getUTCMinutes();

      if (hoursVN === 17 && m === 0) {
        const tasks = loadTasks();
        const done = tasks.filter(t => t.done);
        const pending = tasks.filter(t => !t.done);
        const msg =
          `🗓️ Báo cáo ngày ${now.toLocaleDateString("vi-VN")}\n\n` +
          `✅ ĐÃ HOÀN THÀNH:\n` +
          (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
          `⚠️ CHƯA HOÀN THÀNH:\n` +
          (pending.length ? pending.map(t => `• ${render(t)}`).join("\n") : "• Không có");
        await sendGroup(msg);
        // reset list sau khi gửi
        saveTasks([]);
      }
    } catch (e) {
      console.log("⏰ daily report err:", e.message);
    }
  }, 60 * 1000);
}

// ====== START ======
app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  console.log(`==> Your service is live 🎉`);
  console.log(`==> Available at (Render): https://<your-service>.onrender.com`);
});
