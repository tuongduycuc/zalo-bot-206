// index.js — Zalo OA Group Bot (v3) — full production build
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import XLSX from "xlsx";

dotenv.config();

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

// ====== OPTIONS ======
const AUTO_TODO_CONFIRM = false;      // không phản hồi khi ghi việc
const AUTO_TODO = true;               // tự ghi việc từ tin nhắn group
const DAILY_REPORT_ENABLED = true;    // báo cáo tự động 17:00 (giờ VN)

// DONE keywords
const DONE_REGEX = /(đã xong|da xong|\bok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly|xong\b|ok đã xử lý)/i;

// ====== HELPERS ======
const app = express();
app.use(bodyParser.json());

function clean(s) { return String(s || "").trim(); }
function nextTaskId(tasks) {
  return tasks.length ? Math.max(...tasks.map(t => Number(t.id) || 0)) + 1 : 1;
}
function render(t) {
  const flag = t.done ? "✅" : (t.inProgress ? "⏳" : "⚠️");
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
    if (r?.data?.error !== 0) console.log("❌ Zalo v3 send error:", r.data);
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
    inProgress: t.inProgress ? 1 : 0,   // xuất cột đang xử lý
    sender: t.sender || '',
    src_msg_id: t.src_msg_id || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
  XLSX.writeFile(wb, filename);
  return filename;
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  res.send(`<h2>💧 Zalo Task Bot đang chạy!</h2>
<p>GROUP_ID: ${GROUP_ID || "(chưa có)"} — <a href="/health">health</a></p>`);
});
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  const data = req.body || {};

  // lưu group id nếu payload có
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id || "";
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  // chỉ quan tâm text trong nhóm
  if (data.event_name !== "user_send_group_text") return;

  const sender      = data?.sender?.id || "";
  const msgId       = data?.message?.msg_id || "";
  const textRaw     = data?.message?.text || "";
  const text        = clean(textRaw);
  const quote       = data?.message?.quote_msg || {};
  const quoteText   = clean(quote?.text || "");
  const quoteMsgId  = quote?.msg_id || "";
  const quoteSender = quote?.sender?.id || "";
  const isSlash     = text.startsWith("/");

  // ====== LỆNH ======
  if (isSlash) {
    const cmd = text.toLowerCase();

    if (cmd === "/list") {
      const tasks = loadTasks();
      const undone = tasks.filter(t => !t.done);
      if (!undone.length) await sendGroup("📣 Không có việc.");
      else await sendGroup(`📣 Việc đang mở:\n${undone.slice(-10).map(render).join("\n")}`);
      return;
    }

    if (cmd.startsWith("/report")) {
      const tasks  = loadTasks();
      const done   = tasks.filter(t => t.done);
      const inprog = tasks.filter(t => !t.done && t.inProgress);
      const pend   = tasks.filter(t => !t.done && !t.inProgress);

      const msg =
        `🗓️ Báo cáo ${new Date().toLocaleString("vi-VN")}\n\n` +
        `✅ ĐÃ HOÀN THÀNH:\n` +
        (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
        `⏳ ĐANG XỬ LÝ:\n` +
        (inprog.length ? inprog.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
        `⚠️ CHƯA HOÀN THÀNH:\n` +
        (pend.length ? pend.map(t => `• ${render(t)}`).join("\n") : "• Không có");

      await sendGroup(msg);
      return;
    }

    if (cmd.startsWith("/export")) {
      const tasks = loadTasks();
      const filename = `tasks_${Date.now()}.xlsx`;
      exportExcel(tasks, filename);
      await sendGroup("📄 Đã xuất Excel (file nằm trên server).");
      return;
    }

    if (cmd === "/groupid") {
      await sendGroup(GROUP_ID ? `GROUP_ID: ${GROUP_ID}` : "Chưa có GROUP_ID.");
      return;
    }

    if (cmd === "/help") {
      await sendGroup(`Các lệnh: 
/list — liệt kê việc đang mở
/report — báo cáo ngay
/export — xuất Excel
/groupid — xem group id
/help — trợ giúp`);
      return;
    }

    return; // lệnh khác: bỏ qua
  }

  // ====== AUTO GHI VIỆC ======
  if (AUTO_TODO) {
    const content = clean(text);
    if (content && content.length <= 500) {
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner_uid: sender,
        owner_name: extractFirstMentionName(content) || "",
        message: content,
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        inProgress: false,         // trạng thái ban đầu
        src_msg_id: msgId || '',
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      console.log("📝 AUTO_TODO:", { id: t.id, owner_uid: t.owner_uid, owner_name: t.owner_name, message: t.message });
      if (AUTO_TODO_CONFIRM) await sendGroup(`📝 Đã ghi nhận việc: #${t.id} ${t.message}`);
    }
  }

  // ====== ĐÁNH DẤU HOÀN THÀNH ======
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    // a) Có reply vào tin gốc -> tìm theo src_msg_id
    if (quoteMsgId) {
      let t = tasks.find(x => x.src_msg_id === quoteMsgId);
      if (!t) {
        // nếu chưa có, tạo mới từ quote rồi đánh dấu xong
        const msg = quoteText || "(No text)";
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
          inProgress: false,
          src_msg_id: quoteMsgId,
          src_sender: quoteSender || ''
        };
        tasks.push(t); saveTasks(tasks);
        console.log("✅ DONE-by-quote (created):", t.id);
        return;
      } else {
        if (!t.owner_uid)  t.owner_uid = quoteSender || sender || '';
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || '';
        t.done = true;
        t.doneAt = new Date().toISOString();
        t.inProgress = false;
        saveTasks(tasks);
        console.log("✅ DONE-by-quote (matched):", t.id);
        return;
      }
    }

    // b) Không reply -> lấy việc mở gần nhất của người này
    const tasks2 = loadTasks();
    for (let i = tasks2.length - 1; i >= 0; i--) {
      const t = tasks2[i];
      if (!t.done && (t.sender === sender || !t.owner_uid)) {
        t.done = true;
        t.doneAt = new Date().toISOString();
        t.inProgress = false;
        if (!t.owner_uid)  t.owner_uid = sender || '';
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || '';
        saveTasks(tasks2);
        console.log("✅ DONE-last-open:", t.id);
        return;
      }
    }
    return;
  }

  // ====== REPLY nhưng KHÔNG có từ khóa hoàn thành -> đánh dấu ĐANG XỬ LÝ ======
  if (!isSlash && quoteMsgId && !DONE_REGEX.test(text)) {
    const tasks = loadTasks();
    const t = tasks.find(x => x.src_msg_id === quoteMsgId);
    if (t && !t.done) {
      if (!t.owner_uid)  t.owner_uid = sender || '';
      if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || '';
      t.inProgress = true;
      saveTasks(tasks);
      await sendGroup(`⏳ Việc #${t.id} đang chờ xử lý.`);
    }
    return;
  }
});

// ====== TỰ ĐỘNG BÁO CÁO 17:00 (VN) ======
if (DAILY_REPORT_ENABLED) {
  setInterval(async () => {
    try {
      const now = new Date();
      const hoursVN = (now.getUTCHours() + 7) % 24;
      const m = now.getUTCMinutes();
      if (hoursVN === 17 && m === 0) {
        const tasks  = loadTasks();
        const done   = tasks.filter(t => t.done);
        const inprog = tasks.filter(t => !t.done && t.inProgress);
        const pend   = tasks.filter(t => !t.done && !t.inProgress);

        const msg =
          `🗓️ Báo cáo ngày ${now.toLocaleDateString("vi-VN")}\n\n` +
          `✅ ĐÃ HOÀN THÀNH:\n` +
          (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
          `⏳ ĐANG XỬ LÝ:\n` +
          (inprog.length ? inprog.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
          `⚠️ CHƯA HOÀN THÀNH:\n` +
          (pend.length ? pend.map(t => `• ${render(t)}`).join("\n") : "• Không có");

        await sendGroup(msg);
        // Sau khi báo cáo ngày -> reset danh sách
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
});
