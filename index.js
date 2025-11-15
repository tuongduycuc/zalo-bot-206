// index.js — Zalo OA Group Bot (v3) — stable
// ✅ Chỉ ghi nhận việc khi tin nhắn có @Tên
// ✅ Nếu tin có cả @mention + "ok/đã xử lý..." => không tạo việc mới, mà đánh dấu DONE cho việc mở gần nhất
// ✅ Reply KHÔNG có từ khóa hoàn thành => set "ĐANG XỬ LÝ"
// ✅ Ẩn "ok/đã xử lý..." khi hiển thị nội dung
// ✅ Báo cáo tay: list / report / bc / rp
// ✅ Báo cáo tự động 17:00 giờ VN (giữ nguyên dữ liệu hoặc xóa sau báo cáo tùy chỉnh)
// ✅ Xuất Excel: export / ex

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
const API_V3 = "https://openapi.zalo.me/v3.0";

// ====== FILES ======
const TASK_FILE  = "./tasks.json";
const GROUP_FILE = "./group.json";

// ====== OPTIONS ======
const AUTO_TODO = true;               // ghi việc (chỉ khi có @mention)
const AUTO_TODO_CONFIRM = false;      // không gửi tin xác nhận “đã tạo việc”
const DAILY_REPORT_ENABLED = true;    // báo cáo tự động 17:00 giờ VN (UTC+7)

// Từ khóa hoàn thành
const DONE_REGEX = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ====== APP ======
const app = express();
app.use(bodyParser.json());

// ====== IO HELPERS ======
function safeRead(path, fallback) { try { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : fallback; } catch { return fallback; } }
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

// Bỏ “ok/đã xử lý…” ở cuối nội dung để hiển thị đẹp
function prettyMessage(msg) {
  if (!msg) return "";
  let s = String(msg);
  s = s.replace(/\s*(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)\s*$/i, "");
  return s.trim();
}

function render(t){
  const flag = t.done ? "✅" : (t.inProgress ? "⏳" : "⚠️");
  const who  = t.owner_name || t.owner_uid || "—";
  const msg  = prettyMessage(t.message);
  return `${flag} #${t.id} • ${msg}  👤 ${who}`;
}

function extractFirstMentionName(text) {
  const s = String(text || "");
  const at = s.indexOf("@");
  if (at === -1) return "";
  const tail = s.slice(at + 1).trim();
  const stops = [
    tail.indexOf("  "), tail.indexOf("\n"),
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

// ====== ZALO SEND (v3) — endpoint oa/group/message ======
async function zaloGroupMessage(text, groupIdOverride) {
  const gid = groupIdOverride || GROUP_ID;
  return axios.post(
    `${API_V3}/oa/group/message`,
    { recipient: { group_id: gid }, message: { text: String(text) } },
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
async function sendGroup(text, groupIdOverride) {
  const gid = groupIdOverride || GROUP_ID;
  if (!gid) { console.log("⚠️ No GROUP_ID; cannot send."); return; }
  if (!OA_TOKEN) { console.log("⚠️ Missing ZALO_OA_ACCESS_TOKEN"); return; }
  const r = await zaloGroupMessage(text, gid);
  console.log("📨 group/message:", r.status, r.data);
  if (r.status === 401 || r?.data?.error === -216) console.log("❌ Token/Permission issue.");
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

  // —— Bắt GROUP_ID từ nhiều chỗ
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.message?.group_id ||
    data?.recipient?.id ||
    "";
  if (detectedGroupId && !GROUP_ID) saveGroupId(String(detectedGroupId));

  // —— Lấy dữ liệu cơ bản
  const sender      = data?.sender?.id || "";
  const msgId       = data?.message?.msg_id || "";
  const textRaw     = data?.message?.text || "";
  const text        = clean(textRaw);
  const quote       = data?.message?.quote_msg || {};
  const quoteText   = clean(quote?.text || "");
  const quoteMsgId  = quote?.msg_id || "";
  const quoteSender = quote?.sender?.id || "";
  const evName      = String(data?.event_name || "");
  console.log("🧾 Incoming:", { evName, detectedGroupId, GROUP_ID, text });

  // ====== KHÔNG tạo task nếu có cả @mention & DONE trong cùng tin ======
  const bothMentionAndDone = hasMention(text) && DONE_REGEX.test(text);
  if (bothMentionAndDone) {
    const tasks = loadTasks();
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (!t.done && (t.sender === sender || !t.owner_uid)) {
        t.done = true;
        t.doneAt = new Date().toISOString();
        t.inProgress = false;
        if (!t.owner_uid)  t.owner_uid = sender || "";
        if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || "";
        saveTasks(tasks);
        console.log("✅ DONE-by-mixed(@+ok):", t.id);
        break;
      }
    }
    return;
  }

  // ====== LỆNH ======
  const key = text.toLowerCase().trim().replace(/^[\/\\]+/, "");
  const keyHead = key.split(/\s+/)[0];

  if (["list","ds"].includes(keyHead)) {
    const tasks = loadTasks();
    const undone = tasks.filter(t => !t.done);
    if (!undone.length) await sendGroup("📣 Không có việc.", detectedGroupId || undefined);
    else await sendGroup(`📣 Việc đang mở:\n${undone.slice(-15).map(render).join("\n")}`, detectedGroupId || undefined);
    return;
  }

  if (["report","bc","rp"].includes(keyHead)) {
    const tasks  = loadTasks();
    const done   = tasks.filter(t => t.done);
    const inprog = tasks.filter(t => !t.done && t.inProgress);
    const pend   = tasks.filter(t => !t.done && !t.inProgress);

    const msg =
      `🗓️ Báo cáo ${new Date().toLocaleString("vi-VN")}\n\n` +
      `✅ ĐÃ HOÀN THÀNH:\n` + (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
      `⏳ ĐANG XỬ LÝ:\n` + (inprog.length ? inprog.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
      `⚠️ CHƯA HOÀN THÀNH:\n` + (pend.length ? pend.map(t => `• ${render(t)}`).join("\n") : "• Không có");

    await sendGroup(msg, detectedGroupId || undefined);
    return;
  }

  if (["export","ex"].includes(keyHead)) {
    const tasks = loadTasks();
    const filename = `tasks_${Date.now()}.xlsx`;
    exportExcel(tasks, filename);
    await sendGroup("📄 Đã xuất Excel (file nằm trên server).", detectedGroupId || undefined);
    return;
  }

  if (["groupid"].includes(keyHead)) {
    const gid = detectedGroupId || GROUP_ID;
    await sendGroup(gid ? `GROUP_ID: ${gid}` : "Chưa có GROUP_ID.", gid || undefined);
    return;
  }

  if (["help","?"].includes(keyHead)) {
    const help = `Các lệnh:
- list / ds
- report / bc / rp
- export / ex
- groupid
- help / ?
(Chỉ ghi nhận việc mới khi tin có @Tên; reply không có “ok/đã xử lý…” => ⏳ đang xử lý)`;
    await sendGroup(help, detectedGroupId || undefined);
    return;
  }

  // ====== GHI VIỆC MỚI — CHỈ khi có @mention ======
  if (AUTO_TODO && hasMention(text)) {
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
        inProgress: false,
        src_msg_id: msgId || "",
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      console.log("📝 ASSIGN (@mention):", { id: t.id, owner: t.owner_name || t.owner_uid });
      if (AUTO_TODO_CONFIRM) await sendGroup(`📝 Đã ghi nhận việc: #${t.id} ${prettyMessage(t.message)}`, detectedGroupId || undefined);
    }
  }

  // ====== ĐÁNH DẤU HOÀN THÀNH ======
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    // a) reply vào tin gốc -> tìm theo src_msg_id
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

  // ====== REPLY KHÔNG có từ khóa hoàn thành -> set ĐANG XỬ LÝ (nếu đã có task) ======
  if (quoteMsgId && !DONE_REGEX.test(text)) {
    const tasks = loadTasks();
    const t = tasks.find(x => x.src_msg_id === quoteMsgId);
    if (t && !t.done) {
      if (!t.owner_uid)  t.owner_uid = sender || "";
      if (!t.owner_name) t.owner_name = extractFirstMentionName(t.message) || "";
      t.inProgress = true;
      saveTasks(tasks);
      await sendGroup(`⏳ Việc #${t.id} đang chờ xử lý.`, detectedGroupId || undefined);
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
          `✅ ĐÃ HOÀN THÀNH:\n` + (done.length ? done.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
          `⏳ ĐANG XỬ LÝ:\n` + (inprog.length ? inprog.map(t => `• ${render(t)}`).join("\n") : "• Không có") + "\n\n" +
          `⚠️ CHƯA HOÀN THÀNH:\n` + (pend.length ? pend.map(t => `• ${render(t)}`).join("\n") : "• Không có");

        await sendGroup(msg);
        // Muốn giữ lịch sử thì comment dòng dưới:
        // saveTasks([]);
      }
    } catch (e) { console.log("⏰ daily report err:", e.message); }
  }, 60 * 1000);
}

// ====== START ======
app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  if (!OA_TOKEN) console.log("⚠️ Missing ZALO_OA_ACCESS_TOKEN");
});
