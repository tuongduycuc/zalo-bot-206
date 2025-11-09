// index.js — Zalo OA Group Task Bot (full, ready-to-run)
// Node >= 18, ESM enabled in package.json ("type": "module")

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "";
let GROUP_ID = process.env.GROUP_ID || "";

// ====== FILES ======
const TASK_FILE = "./tasks.json";
const GROUP_FILE = "./group.json";
const MSG_CACHE_FILE = "./msg_cache.json";
const LAST_DEBUG_FILE = "./last_payload.json";

// ====== UTIL FILE IO ======
function safeReadJSON(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function safeWriteJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {}
}

// load existing
if (!GROUP_ID) {
  const g = safeReadJSON(GROUP_FILE, { group_id: "" });
  GROUP_ID = g.group_id || "";
}

// ====== TASKS ======
function loadTasks() { return safeReadJSON(TASK_FILE, []); }
function saveTasks(tasks) { safeWriteJSON(TASK_FILE, tasks); }
function nextTaskId(tasks) { return (tasks.length ? Math.max(...tasks.map(t => +t.id || 0)) : 0) + 1; }

// ====== MESSAGE CACHE (id -> cleaned text) ======
let msgCache = safeReadJSON(MSG_CACHE_FILE, {});
function cachePut(id, text) {
  if (!id || !text) return;
  const clean = String(text).replace(/@\S+/g, "").trim(); // bỏ @mention
  if (!clean) return;
  msgCache[id] = { text: clean, ts: Date.now() };
  // dọn > 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(msgCache)) if ((msgCache[k]?.ts || 0) < cutoff) delete msgCache[k];
  safeWriteJSON(MSG_CACHE_FILE, msgCache);
}
function cacheGet(id) { return id && msgCache[id]?.text ? msgCache[id].text : ""; }

// ====== HELPERS ======
const DONE_REGEX = /(đã xong|da xong|ok\b|okay\b|hoàn thành|hoan thanh|đã xử lý|da xu ly|đã sửa|da sua)/i;

const norm = (s) => String(s || "").toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
const stripMentions = (s) => String(s || "").replace(/@\S+/g, "").trim();
const stripDoneWords = (s) => String(s || "").replace(DONE_REGEX, "").trim();
const core = (s) => norm(stripDoneWords(stripMentions(s)));

function renderTask(t) {
  const who = t.owner ? ` (${t.owner})` : "";
  return `${t.message}${who}`;
}

async function sendTextToGroup(text) {
  if (!ACCESS_TOKEN) { console.log("⚠️ Thiếu ZALO_OA_ACCESS_TOKEN"); return; }
  if (!GROUP_ID) { console.log("⚠️ Chưa có GROUP_ID."); return; }
  try {
    // V3 group message
    const url = "https://openapi.zalo.me/v3.0/oa/group/message";
    const payload = { group_id: GROUP_ID, message: { text } };
    const res = await axios.post(url, payload, {
      headers: { access_token: ACCESS_TOKEN, "Content-Type": "application/json" },
      timeout: 15000
    });
    console.log("==> V3 group/message:", res.status, JSON.stringify(res.data));
  } catch (err) {
    console.log("❌ Send group error:", err.response?.status, err.response?.data || err.message);
  }
}

function saveGroupId(id) {
  if (!id) return;
  GROUP_ID = id;
  safeWriteJSON(GROUP_FILE, { group_id: id });
  console.log("🔐 GROUP_ID saved:", id);
}

function keepLastPayload(body) { safeWriteJSON(LAST_DEBUG_FILE, body); }

// ====== BASIC ROUTES ======
app.get("/", (req, res) => {
  res.send(`<h2>💧 Zalo Task Bot đang chạy!</h2>
  <div>GROUP_ID: ${GROUP_ID || "(chưa có)"} — <a href="/health">health</a> — <a href="/debug/last">debug</a></div>`);
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Xem payload webhook gần nhất
app.get("/debug/last", (req, res) => {
  try { res.json(safeReadJSON(LAST_DEBUG_FILE, { note: "no payload yet" })); }
  catch { res.json({ note: "no payload yet" }); }
});

// Check OA info để biết token còn hiệu lực
app.get("/token-check", async (req, res) => {
  try {
    const url = "https://openapi.zalo.me/v3.0/oa/getoa";
    const r = await axios.get(url, { headers: { access_token: ACCESS_TOKEN } });
    res.json(r.data);
  } catch (e) {
    res.status(200).json({ error: e.response?.status || 500, message: e.response?.data || e.message });
  }
});

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");
  const data = req.body || {};
  keepLastPayload(data);

  // cố gắng bắt group_id
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    "";
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  const event = data.event_name || "";
  const sender = data.sender?.id || data?.sender?.user_id || "";
  const msgId =
    data?.message?.msg_id ||
    data?.message?.message_id ||
    data?.message?.id || "";

  // text người dùng
  const text0 = data?.message?.text || data?.message?.content || "";
  const text = String(text0 || "").trim();

  // Lưu vào cache mọi tin text để phục vụ reply “ok” nhưng thiếu quoted text
  if (msgId && text) cachePut(msgId, text0);

  // Chỉ xử lý sự kiện gửi text (user_send_text / user_send_group_text)
  if (!/user_send.*text/i.test(event)) return;

  // ===== COMMANDS =====
  if (/^\/?report\b/i.test(text)) {
    // báo cáo theo ngày hiện tại
    const today = new Date().toLocaleDateString("vi-VN");
    const tasks = loadTasks();
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);
    const msg =
      `🗓️ Báo cáo ${new Date().toLocaleTimeString("vi-VN")} ${today}\n\n` +
      `✅ ĐÃ HOÀN THÀNH:\n` +
      (done.length ? done.map(t => `• ${renderTask(t)}`).join("\n") : "• Không có") + "\n\n" +
      `⚠️ CHƯA HOÀN THÀNH:\n` +
      (pending.length ? pending.map(t => `• ${renderTask(t)}`).join("\n") : "• Không có");
    await sendTextToGroup(msg);
    return;
  }

  if (/^\/?list\b/i.test(text)) {
    const tasks = loadTasks();
    if (!tasks.length) { await sendTextToGroup("📋 Chưa có việc nào."); return; }
    const msg = "📋 Danh sách việc:\n" + tasks.map(t => `${t.done ? "✅" : "⏳"} ${renderTask(t)}`).join("\n");
    await sendTextToGroup(msg);
    return;
  }

  // ====== DONE HANDLER (siêu chịu lỗi + cache) ======
  if (DONE_REGEX.test(text)) {
    const getQuoteId = (payload) =>
      payload?.message?.quote_msg_id ||
      payload?.message?.quoted_message?.msg_id ||
      payload?.message?.quote?.msg_id ||
      payload?.message?.quote_message_id ||
      payload?.quoted_message?.msg_id ||
      payload?.message?.reply?.message_id ||
      payload?.reply?.message_id || "";

    const getQuoteText = (payload) =>
      payload?.message?.quoted_message?.text ||
      payload?.message?.quote?.text ||
      payload?.quoted_message?.text || "";

    const tasks = loadTasks();

    // 1) theo quote_msg_id map trực tiếp
    const quoteId = getQuoteId(data);
    if (quoteId) {
      const t = tasks.find(x => !x.done && x.src_msg_id === quoteId);
      if (t) {
        t.done = true; t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }

    // 2) theo quoted text (nếu có)
    let qTextRaw = getQuoteText(data);
    let qText = core(qTextRaw);
    if (qText) {
      const cand = tasks.filter(x => !x.done).reverse().find(x => {
        const nm = core(x.message);
        return nm && qText && (nm.includes(qText) || qText.includes(nm));
      });
      if (cand) {
        cand.done = true; cand.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(cand)}`);
        return;
      }
    }

    // 3) nếu thiếu quoted text → lấy text gốc từ cache theo quoteId
    if (!qTextRaw && quoteId) {
      const cached = cacheGet(quoteId);
      if (cached) {
        qTextRaw = cached;
        qText = core(qTextRaw);
      }
    }
    // 3b) có text → tự tạo task rồi chốt
    if (!tasks.some(t => !t.done && t.src_msg_id === quoteId) && qTextRaw && qTextRaw.trim().length >= 4) {
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner: "",
        message: stripMentions(qTextRaw).trim(),
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: true,
        doneAt: new Date().toISOString(),
        src_msg_id: quoteId || undefined
      };
      tasks.push(t); saveTasks(tasks);
      await sendTextToGroup(`✅ Đã hoàn thành (tạo từ reply): ${renderTask(t)}`);
      return;
    }

    // 4) fallback: chốt việc mở gần nhất của chính người nhắn
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (!t.done && (t.sender === sender || (t.owner && t.owner.includes("@")))) {
        t.done = true; t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }

    await sendTextToGroup("⚠️ Không có việc nào để đánh dấu xong.");
    return;
  }

  // ====== TẠO TASK TỪ TIN THƯỜNG ======
  // Bỏ lệnh & bỏ done-word; nếu còn nội dung hữu ích thì ghi nhận thành việc
  const messageCore = core(text);
  if (messageCore.length >= 4) {
    const tasks = loadTasks();
    const t = {
      id: nextTaskId(tasks),
      sender,
      owner: "",
      message: stripMentions(text), // giữ nguyên nội dung gốc (chỉ bỏ mention hiển thị)
      dueAt: null,
      createdAt: new Date().toISOString(),
      done: false,
      src_msg_id: msgId || undefined
    };
    tasks.push(t);
    saveTasks(tasks);
    await sendTextToGroup(`📝 Đã ghi nhận việc: ${renderTask(t)}`);
  }
});

// ====== START ======
app.listen(PORT, () => console.log(`🚀 Bot chạy tại cổng ${PORT}`));
