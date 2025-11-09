// index.js — Zalo OA GMF bot (API v3, ES Module)
// cài: npm i express body-parser axios dotenv
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

axios.defaults.timeout = 10000;

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';

let GROUP_ID = process.env.GROUP_ID || '';
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

const ONLY_ADMINS = String(process.env.ONLY_ADMINS || 'false').toLowerCase() === 'true';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const AUTO_TODO = String(process.env.AUTO_TODO || 'true').toLowerCase() === 'true';

// nhận diện “ok/hoàn thành/đã xong/đã xử lý…”
const DONE_REGEX = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ===== Files =====
const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';

// API v3
const API_V3 = 'https://openapi.zalo.me/v3.0';

// Express
app.use(bodyParser.json());

// ===== Utils: load/save =====
function loadTasks() {
  try { return fs.existsSync(TASK_FILE) ? JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')) : []; }
  catch { return []; }
}
function saveTasks(tasks) { fs.writeFileSync(TASK_FILE, JSON.stringify(tasks, null, 2)); }

function loadGroupId() {
  try { return fs.existsSync(GROUP_FILE) ? (JSON.parse(fs.readFileSync(GROUP_FILE, 'utf8')).group_id || '') : ''; }
  catch { return ''; }
}
function saveGroupId(id) {
  GROUP_ID = id;
  fs.writeFileSync(GROUP_FILE, JSON.stringify({ group_id: id }, null, 2));
  console.log('🔐 GROUP_ID saved:', id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

const fmt = (d) => new Date(d).toLocaleString('vi-VN', { timeZone: TZ });

// de-dup: giữ 10 phút
const seen = new Map();
function remember(id) {
  const now = Date.now();
  seen.set(id, now);
  for (const [k, v] of seen) if (now - v > 10 * 60 * 1000) seen.delete(k);
  return true;
}
function isDup(id) { return id && seen.has(id); }

// ===== Helpers =====
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function getQuoteInfo(data) {
  const qObj = data?.message?.quoted_message || data?.message?.quote || {};
  const quoteId =
    data?.message?.quote_msg_id ||
    qObj.msg_id || qObj.message_id || qObj.msgId || '';
  const quoteText = cleanText(qObj.text || qObj.message || '');
  const quoteSender = qObj.sender?.id || qObj.from_id || '';
  return { quoteId, quoteText, quoteSender };
}

// ===== Send helpers (v3) =====
async function sendTextToGroup(text) {
  if (!GROUP_ID) return console.log('⚠️ No GROUP_ID');
  if (!ACCESS_TOKEN) return console.log('⚠️ No ACCESS_TOKEN');
  try {
    const r = await axios.post(
      `${API_V3}/oa/group/message`,
      { recipient: { group_id: GROUP_ID }, message: { text: String(text) } },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true, timeout: 10000
      }
    );
    console.log('📨 group/message:', r.status, r.data);
  } catch (e) { console.error('❌ group/message:', e.response?.data || e.message); }
}

async function sendTextToUser(user_id, text) {
  if (!ACCESS_TOKEN) return;
  try {
    const r = await axios.post(
      `${API_V3}/oa/message`,
      { recipient: { user_id }, message: { text: String(text) } },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true, timeout: 10000
      }
    );
    console.log('📨 oa/message:', r.status, r.data);
  } catch (e) { console.error('❌ oa/message:', e.response?.data || e.message); }
}

// ===== Task helpers =====
function nextTaskId(tasks) { return tasks.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1; }
function renderTask(t) {
  const due = t.dueAt ? ` | hạn: ${fmt(t.dueAt)}` : '';
  const who = t.owner ? ` | phụ trách: ${t.owner}` : '';
  const st  = t.done ? `✅ (xong ${fmt(t.doneAt)})` : '⏳';
  return `#${t.id} ${st} ${t.message}${who}${due}`;
}
function reportText(tasks) {
  const done = tasks.filter(t => t.done);
  const pending = tasks.filter(t => !t.done);
  let msg = `📅 Báo cáo ${fmt(new Date())}\n\n`;
  msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length ? done.map(renderTask).join('\n') : '• Không có') + '\n\n';
  msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pending.length ? pending.map(renderTask).join('\n') : '• Không có');
  return msg;
}
function parseDue(s) {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) { const [_, dd, mm, yyyy, hh, mi] = m.map(Number); return new Date(Date.UTC(yyyy, mm - 1, dd, hh - 7, mi)).toISOString(); }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) { const now = new Date(); const yyyy = now.getUTCFullYear(); const [_, dd, mm, hh, mi] = m.map(Number); return new Date(Date.UTC(yyyy, mm - 1, dd, hh - 7, mi)).toISOString(); }
  m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) { const now = new Date(); const yyyy = now.getUTCFullYear(); const [_, dd, mm] = m.map(Number); return new Date(Date.UTC(yyyy, mm - 1, dd, 10, 0)).toISOString(); }
  return null;
}
function parseTodo(text) {
  const raw = text.replace(/^\/todo\s*/i, '');
  const parts = raw.split('|').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const item = { message: parts[0], owner: '', dueAt: null };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('@')) item.owner = p;
    else {
      const d = parseDue(p);
      if (d) item.dueAt = d; else item.message += ' | ' + p;
    }
  }
  return item;
}

// ===== Permissions =====
function isAdmin(uid) { return ADMIN_UIDS.includes(String(uid)); }
function assertPerm(uid) { return !ONLY_ADMINS || isAdmin(uid); }

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const data = req.body || {};
  res.status(200).send('OK');

  try {
    fs.mkdirSync('./public', { recursive: true });
    fs.writeFileSync(LAST_FILE, JSON.stringify(data, null, 2));
  } catch {}

  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.group_id || '';
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  const ev    = data.event_name || '';
  const text0 = data?.message?.text;
  const msgId = data?.message?.msg_id || data?.msg_id;
  const isText  = typeof text0 === 'string';
  const inGroup = !!(data?.recipient?.group_id || data?.conversation?.id || data?.message?.conversation_id);

  console.log('📩 Webhook:', JSON.stringify({
    event: ev, sender: data?.sender?.id, gid: detectedGroupId, msg_id: msgId, text: text0
  }));

  if (isDup(msgId)) { console.log('↩️ duplicate ignored'); return; }
  remember(msgId);

  if (!(isText && (inGroup ||
      ev === 'user_send_group_text' || ev === 'group.message' ||
      ev === 'group_send_text' || ev === 'group_user_send_text' ||
      ev === 'user_send_text'))) return;

  const sender = data.sender?.id || 'unknown';
  const text = cleanText(text0);
  if (!text) return;

  if (!assertPerm(sender)) {
    await sendTextToGroup('⛔ Bạn không có quyền dùng lệnh này.');
    return;
  }

  // ===== Commands =====
  if (/^\/help$/i.test(text)) {
    await sendTextToGroup(
`🤖 Lệnh:
• /whoami
• /todo <nội dung> [| @user] [| dd/mm/yyyy hh:mm]
• /list (all|done|me)
• /done [id]
• /report
Có thể chỉ reply “ok/hoàn thành/đã xong” vào tin gốc để chốt việc.`);
    return;
  }

  if (/^\/whoami$/i.test(text)) {
    await sendTextToGroup(`👤 user_id của bạn: ${sender}`);
    return;
  }

  if (/^\/todo/i.test(text)) {
    const info = parseTodo(text);
    if (!info) { await sendTextToGroup('⚠️ Cú pháp: /todo <nội dung> [| @user] [| dd/mm/yyyy hh:mm]'); return; }
    const tasks = loadTasks();
    const t = {
      id: nextTaskId(tasks),
      sender,
      owner: info.owner || '',
      message: info.message,
      dueAt: info.dueAt,
      createdAt: new Date().toISOString(),
      done: false,
      doneAt: null
    };
    tasks.push(t); saveTasks(tasks);
    await sendTextToGroup(`📝 Đã tạo việc: ${renderTask(t)}`);
    return;
  }

  if (/^\/list(\s+.+)?$/i.test(text)) {
    const arg = (text.split(/\s+/)[1] || '').toLowerCase();
    const tasks = loadTasks();
    let list = tasks;
    if (arg === 'done') list = tasks.filter(t => t.done);
    else if (arg === 'me') list = tasks.filter(t => (t.owner && t.owner.includes('@')) || t.sender === sender);
    else if (arg === 'all' || arg === '') list = tasks;
    else list = tasks.filter(t => !t.done);
    if (!list.length) { await sendTextToGroup('📭 Không có việc phù hợp.'); return; }
    await sendTextToGroup('📋 Danh sách:\n' + list.slice(-20).map(renderTask).join('\n'));
    return;
  }

  if (/^\/done(\s+\d+)?$/i.test(text)) {
    const tasks = loadTasks();
    const m = text.match(/^\/done\s+(\d+)$/i);
    if (m) {
      const id = Number(m[1]);
      const t = tasks.find(x => x.id === id);
      if (!t) { await sendTextToGroup(`⚠️ Không tìm thấy việc #${id}`); return; }
      t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
      await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
      return;
    } else {
      for (let i = tasks.length - 1; i >= 0; i--) {
        const t = tasks[i];
        if (!t.done && (t.sender === sender || (t.owner && t.owner.includes('@')))) {
          t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
          await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
          return;
        }
      }
      await sendTextToGroup('⚠️ Không có việc nào để đánh dấu xong.');
      return;
    }
  }

  if (/^\/report$/i.test(text)) {
    const tasks = loadTasks();
    await sendTextToGroup(reportText(tasks));
    return;
  }

  // === Natural language: "ok/hoàn thành/đã xong" — Ưu tiên reply vào tin gốc
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    const { quoteId, quoteText, quoteSender } = getQuoteInfo(data);

    if (quoteId) {
      // 1) tìm việc theo msg_id nguồn
      let t = tasks.find(x => !x.done && x.src_msg_id === quoteId);

      // 2) nếu chưa có, thử theo nội dung tin gốc
      if (!t && quoteText) {
        t = tasks.find(x => !x.done && cleanText(x.message) === quoteText);
      }

      // 3) nếu vẫn chưa có → tạo “just-in-time” từ tin được reply rồi chốt
      if (!t && quoteText) {
        t = {
          id: nextTaskId(tasks),
          sender: quoteSender || sender,
          owner: '',
          message: quoteText,
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: false,
          doneAt: null,
          src_msg_id: quoteId,
          src_sender: quoteSender || sender
        };
        tasks.push(t);
      }

      if (t) {
        t.done = true;
        t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }

    // 4) Fallback: không reply → chốt việc gần nhất của người nhắn
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (!t.done && (t.sender === sender || (t.owner && t.owner.includes('@')))) {
        t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }
    await sendTextToGroup('⚠️ Không có việc nào để đánh dấu xong.');
    return;
  }

  // --- Auto-TODO: tin nhắn thường (không có /) ---
  if (AUTO_TODO && inGroup && !text.startsWith('/')) {
    const content = cleanText(text);
    if (content.length >= 2 && content.length <= 400) {
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner: '',
        message: content,
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        src_msg_id: msgId,      // ràng buộc với reply (quote)
        src_sender: sender
      };
      tasks.push(t);
      saveTasks(tasks);
      await sendTextToGroup(`📝 Đã ghi nhận việc: ${renderTask(t)}`);
      return;
    }
  }

  // Not a command → bỏ qua
});

// ===== Routes =====
app.get('/', (req, res) => {
  res.send(`<h3>💧 Zalo Task Bot (v3)</h3>
  <div>GROUP_ID: ${GROUP_ID || '(none)'} —
  <a href="/health">health</a> — <a href="/debug/last">last</a> —
  <a href="/report-now">report-now</a></div>`);
});
app.get('/health', (req, res) => res.json({ ok: true, group_id: !!GROUP_ID }));
app.get('/debug/last', (req, res) => { try { res.type('application/json').send(fs.readFileSync(LAST_FILE, 'utf8')); } catch { res.status(404).send('no payload'); }});
app.get('/set-group', (req, res) => { const id = String(req.query.id || '').trim(); if (!id) return res.status(400).send('missing ?id'); saveGroupId(id); res.send('OK ' + id); });
app.get('/send', async (req, res) => { const text = String(req.query.text || '').trim(); if (!text) return res.status(400).send('missing ?text'); await sendTextToGroup(text); res.send('sent'); });
app.get('/send2-user', async (req, res) => { const uid = String(req.query.uid || '').trim(); const text = String(req.query.text || 'hi').trim(); if (!uid) return res.status(400).send('missing ?uid'); await sendTextToUser(uid, text); res.send('sent'); });
app.get('/report-now', async (req, res) => { const tasks = loadTasks(); await sendTextToGroup(reportText(tasks)); res.send('OK, báo cáo đã gửi vào nhóm.'); });

// Token check (thử nhiều biến thể)
app.get('/token-check', async (req, res) => {
  const token = ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'no_token' });
  const tries = [
    { url: 'https://openapi.zalo.me/v3.0/oa/getoa', hdr: true },
    { url: 'https://openapi.zalo.me/v2.0/oa/getoa', hdr: true },
    { url: 'https://openapi.zalo.me/oa/getoa',     hdr: true },
    { url: `https://openapi.zalo.me/v3.0/oa/getoa?access_token=${encodeURIComponent(token)}`, hdr: false },
    { url: `https://openapi.zalo.me/v2.0/oa/getoa?access_token=${encodeURIComponent(token)}`, hdr: false },
    { url: `https://openapi.zalo.me/oa/getoa?access_token=${encodeURIComponent(token)}`,     hdr: false },
  ];
  for (const t of tries) {
    try {
      const r = await axios.get(t.url, {
        headers: t.hdr ? { access_token: token, Authorization: `Bearer ${token}` } : undefined,
        validateStatus: () => true, timeout: 10000
      });
      console.log('🔎 token-check:', t.url, r.status, r.data?.error);
      if (r.status !== 404 && !(r.data && r.data.error === 404)) return res.status(r.status).json(r.data);
    } catch (e) { console.log('check err:', e.message); }
  }
  res.status(404).json({ error: 404, message: 'all variants 404' });
});

// Report 17:00 hàng ngày (UTC+7)
setInterval(async () => {
  const now = new Date();
  const min = now.getUTCMinutes();
  const hourVN = (now.getUTCHours() + 7) % 24;
  if (hourVN === 17 && min === 0) {
    const tasks = loadTasks();
    await sendTextToGroup(reportText(tasks));
  }
}, 60 * 1000);

// Nhắc quá hạn mỗi 5 phút
setInterval(async () => {
  const tasks = loadTasks();
  const now = Date.now();
  const overdue = tasks.filter(t => !t.done && t.dueAt && new Date(t.dueAt).getTime() < now);
  if (overdue.length) {
    await sendTextToGroup('⏰ NHẮC HẠN:\n' + overdue.slice(-10).map(renderTask).join('\n'));
  }
}, 5 * 60 * 1000);

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Missing ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN');
});
