// index.js — Zalo OA Group Bot (v3) — accept user_send_text & user_send_group_text; assign-only capture; in-progress reply; bc without slash
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
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || "Asia/Bangkok";
const API_V3 = "https://openapi.zalo.me/v3.0";

// ====== FILES ======
const TASK_FILE  = "./tasks.json";
const GROUP_FILE = "./group.json";

// ====== OPTIONS ======
const AUTO_TODO = true;               // nhưng chỉ ghi khi có @mention
const AUTO_TODO_CONFIRM = false;      // không phản hồi khi ghi việc
const DAILY_REPORT_ENABLED = true;    // báo cáo tự động 17:00 (VN)

// DONE keywords
const DONE_REGEX = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly|ok đã xử lý)/i;

// ====== APP ======
const app = express();
app.use(bodyParser.json());

// ====== IO HELPERS ======
function safeRead(path, fallback) {
  try { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : fallback; }
  catch { return fallback; }
}
function safeWrite(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2)); }

function loadTasks(){ return safeRead(TASK_FILE, []); }
function saveTasks(t){ safeWrite(TASK_FILE, t); }
function nextTaskId(tasks){ return tasks.length ? Math.max(...tasks.map(x => Number(x.id)||0))+1 : 1; }

function loadGroupId(){
  try { if(!fs.existsSync(GROUP_FILE)) return ""; return JSON.parse(fs.readFileSync(GROUP_FILE,"utf8")).group_id || ""; }
  catch { return ""; }
}
function saveGroupId(id){
  GROUP_ID = id;
  safeWrite(GROUP_FILE, { group_id: id });
  console.log("🔐 Saved GROUP_ID:", id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

// ====== TEXT HELPERS ======
function clean(s){ return String(s||"").trim(); }
function render(t){
  const flag = t.done ? "✅" : (t.inProgress ? "⏳" : "⚠️");
  const who  = t.owner_name || t.owner_uid || "—";
  return `${flag} #${t.id} • ${t.message}  👤 ${who}`;
}
function extractFirstMentionName(text) {
  const s = String(text || "");
  const at = s.indexOf("@");
  if (at === -1) return "";
  const tail = s.slice(at + 1).trim();
  const stops = [
    tail.indexOf("  "),
    tail.indexOf("\n"),
    tail.toLowerCase().indexOf(" buc "),
    tail.toLowerCase().indexOf(" bục "),
    tail.toLowerCase().indexOf(" mat "),
    tail.toLowerCase().indexOf(" mất ")
  ].filter(i => i >= 0);
  const stopIdx = stops.length ? Math.min(...stops) : -1;
  const name = stopIdx > -1 ? tail.slice(0, stopIdx).trim() : tail;
  return name.length > 50 ? name.slice(0, 50).trim() : name;
}
function hasMention(text){ return extractFirstMentionName(text) !== ""; }

// ====== ZALO SEND (v3) — đúng endpoint: oa/group/message ======
async function zaloGroupMessage(text) {
  return axios.post(
    `${API_V3}/oa/group/message`,
    { recipient: { group_id: GROUP_ID }, message: { text: String(text) } },
    {
      headers: {
        "Content-Type": "application/json",
        access_token: OA_TOKEN,
        Authorization: `Bearer ${OA_TOKEN}`
      },
      validateStatus: () => true,
      timeout: 10000
    }
  );
}
async function sendGroup(text) {
  if (!GROUP_ID) { console.log("⚠️ No GROUP_ID; cannot send."); return; }
  if (!OA_TOKEN) { console.log("⚠️ Missing ZALO_OA_ACCESS_TOKEN"); return; }
  const r = await zaloGroupMessage(text);
  console.log("📨 group/message:", r.status, r.data);
  if (r.status === 401 || r?.data?.error === -216) {
    console.log("❌ Token/Permission issue. Kiểm tra lại token/quyền gửi vào nhóm.");
  }
  if (r?.data?.error !== 0) console.log("❌ Zalo send error detail:", r.data);
}

// ====== EXPORT EXCEL ======
function exportExcel(tasks, filename) {
  const rows = tasks.map(t => ({
    id: t.id,
    message: t.message,
    owner: t.owner_name || t.owner_uid || "",
    createdAt: t.createdAt || "",
    dueAt: t.dueAt || "",
    done: t.done ? 1 : 0,
    doneAt: t.doneAt || "",
    inProgress: t.inProgress ? 1 : 0,
    sender: t.sender || "",
    src_msg_id: t.src_msg_id || ""
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Tasks");
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

  // Nhận group id từ nhiều trường
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.message?.group_id ||
    "";
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  // Chấp nhận nhiều biến thể event_name
  const ev = String(data.event_name || "").toLowerCase();
  // Chỉ xử lý nếu payload thể hiện đây là tin trong group
  const looksGroup =
    !!detectedGroupId ||
    !!data?.recipient?.group_id ||
    !!data?.message?.conversation_id ||
    !!data?.message?.group_id ||
    !!data?.conversation?.id;

  if (!looksGroup) return; // bỏ qua tin nhắn 1:1 với OA

  // Lấy dữ liệu cần thiết
  const sender      = data?.sender?.id || "";
  const msgId       = data?.message?.msg_id || "";
  const textRaw     = data?.message?.text || "";
  const text        = clean(textRaw);
  const quote       = data?.message?.quote_msg || {}; // Zalo sẽ gửi nếu reply
  const quoteText   = clean(quote?.text || "");
  const quoteMsgId  = quote?.msg_id || "";
  const quoteSender = quote?.sender?.id || "";

  // ====== KHỐI LỆNH (có/không có "/") ======
  {
    const key = text.toLowerCase().trim().replace(/^[\/\\]+/, "");
    const keyHead = key.split(/\s+/)[0];

    // list / ds
    if (["list","ds"].includes(keyHead)) {
      const tasks = loadTasks();
      const undone = tasks.filter(t => !t.done);
      if (!undone.length) await sendGroup("📣 Không có việc.");
      else await sendGroup(`📣 Việc đang mở:\n${undone.slice(-15).map(render).join("\n")}`);
      return;
    }

    // report / bc / rp
    if (["report","bc","rp"].includes(keyHead)) {
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

    // export / ex
    if (["export","ex"].includes(keyHead)) {
      const tasks = loadTasks();
      const filename = `tasks_${Date.now()}.xlsx`;
      exportExcel(tasks, filename);
      await sendGroup("📄 Đã xuất Excel (file nằm trên server).");
      return;
    }

    // groupid
    if (["groupid"].includes(keyHead)) {
      await sendGroup(GROUP_ID ? `GROUP_ID: ${GROUP_ID}` : "Chưa có GROUP_ID.");
      return;
    }

    // help / ?
    if (["help","?"].includes(keyHead)) {
      await sendGroup(`Các lệnh:
- list / ds
- report / bc / rp
- export / ex
- groupid
- help / ?
(Chỉ ghi nhận công việc mới khi tin có @Tên)`);
      return;
    }
  }
  // ====== HẾT KHỐI LỆNH ======

  // ====== GHI VIỆC MỚI — CHỈ khi có @mention ======
  if (AUTO_TODO && hasMention(text)) {
    const content = clean(text);
    if (content && content.length <= 500) {
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner_uid: sender,                             // người giao
        owner_name: extractFirstMentionName(content) || "", // người được giao (@Tên)
        message: content,
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        inProgress: false,
        src_msg_id: msgId || "",
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      console.log("📝 ASSIGN captured (@mention):", { id: t.id, owner_uid: t.owner_uid, owner_name: t.owner_name, message: t.message });
      if (AUTO_TODO_CONFIRM) await sendGroup(`📝 Đã ghi nhận việc: #${t.id} ${t.message}`);
    }
  } else {
    // Không @ => không ghi nhận
  }

  // ====== ĐÁNH DẤU HOÀN THÀNH ======
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    // a) reply vào tin gốc -> tìm theo src_msg_id (không auto-create)
    if (quoteMsgId) {
      const t = tasks.find(x => x.src_msg_id === quoteMsgId);
      if (!t) { console.log("ℹ️ DONE reply ignored: no matched task."); return; }
      if (!t.owner_uid)  t.owner_uid = quoteSender || sender || "";
      if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || "";
      t.done = true;
      t.doneAt = new Date().toISOString();
      t.inProgress = false;
      saveTasks(tasks);
      console.log("✅ DONE-by-quote:", t.id);
      return;
    }

    // b) không reply -> close việc mở gần nhất của người này (nếu có)
    const tasks2 = loadTasks();
    for (let i = tasks2.length - 1; i >= 0; i--) {
      const t = tasks2[i];
      if (!t.done && (t.sender === sender || !t.owner_uid)) {
        t.done = true;
        t.doneAt = new Date().toISOString();
        t.inProgress = false;
        if (!t.owner_uid)  t.owner_uid = sender || "";
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || "";
        saveTasks(tasks2);
        console.log("✅ DONE-last-open:", t.id);
        return;
      }
    }
    return;
  }

  // ====== REPLY không có từ khóa hoàn thành -> set ĐANG XỬ LÝ (chỉ khi task đã tồn tại) ======
  if (quoteMsgId && !DONE_REGEX.test(text)) {
    const tasks = loadTasks();
    const t = tasks.find(x => x.src_msg_id === quoteMsgId);
    if (t && !t.done) {
      if (!t.owner_uid)  t.owner_uid = sender || "";
      if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || "";
      t.inProgress = true;
      saveTasks(tasks);
      await sendGroup(`⏳ Việc #${t.id} đang chờ xử lý.`);
    } else {
      console.log("ℹ️ InProgress reply ignored: no matched task.");
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
        // Nếu muốn giữ lịch sử, hãy comment dòng dưới:
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
  if (!OA_TOKEN) console.log("⚠️ Missing ZALO_OA_ACCESS_TOKEN");
});
