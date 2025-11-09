// index.js — Zalo OA GMF bot (API v3, ES Module, ổn định + Inbox fallback)
// Cài: npm i express body-parser axios dotenv
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

// Nhận diện hoàn thành
const DONE_REGEX = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ===== Files =====
const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';
// Hộp thư đến (vòng đệm các tin đã nhận để fallback khi thiếu quote)
const INBOX_FILE = './inbox.json';

// API v3
const API_V3 = 'https://openapi.zalo.me/v3.0';

app.use(bodyParser.json());

// ===== Utils: load/save =====
function loadJSON(path, def) {
  try { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : def; }
  catch { return def; }
}
function saveJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

function loadTasks() { return loadJSON(TASK_FILE, []); }
function saveTasks(tasks) { saveJSON(TASK_FILE, tasks); }

function loadGroupId() { return loadJSON(GROUP_FILE, { group_id: '' }).group_id || ''; }
function saveGroupId(id) { GROUP_ID = id; saveJSON(GROUP_FILE, { group_id: id }); console.log('🔐 GROUP_ID saved:', id); }
if (!GROUP_ID) GROUP_ID = loadGroupId();

// Inbox vòng đệm
function loadInbox() { return loadJSON(INBOX_FILE, []); }
function saveInbox(inbox) {
  // giữ 500 dòng gần nhất
  if (inbox.length > 500) inbox.splice(0, inbox.length - 500);
  saveJSON(INBOX_FILE, inbox);
}

const fmt = (d) => new Date(d).toLocaleString('vi-VN', { timeZone: TZ });

// de-dup 10 phút
const seen = new Map();
function remember(id) {
  const now = Date.now();
  seen.set(id, now);
  for (const [k, v] of seen) if (now - v > 10 * 60 * 1000) seen.delete(k);
}
function isDup(id) { return id && seen.has(id); }

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function stripMentions(s) { return String(s || '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim(); }
function normalizeForMatch(s) {
  return stripMentions(cleanText(s))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function fuzzyMatch(a, b) {
  const A = normalizeForMatch(a);
  const B = normalizeForMatch(b);
  if (!A || !B) return false;
  if (A.includes(B) || B.includes(A)) return true;
  const wa = new Set(A.split(' ').filter(w => w.length > 1));
  const wb = new Set(B.split(' ').filter(w => w.length > 1));
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit >= 2;
}

function getQuoteInfo(data) {
  const qObj = data?.message?.quoted_message || data?.message?.quote || {};
  const quoteId =
    data?.message?.quote_msg_id ||
    qObj.msg_id || qObj.message_id || qObj.msgId || '';
  const quoteText = cleanText(qObj.text || qObj.message || '');
  const quoteSender = qObj.sender?.id || qObj.from_id || '';
  return { quoteId, quoteText, quoteSender };
}

// ===== Send helpers =====
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
  msg += '⚠️ CHƢA HOÀN THÀNH:\n' + (pending.length ? pending.map(renderTask).join('\n') : '• Không có');
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

// ===== Inbox helpers =====
function pushInbox({ msg_id, text, sender, group_id }) {
  const inbox = loadInbox();
  inbox.push({ msg_id, text: cleanText(text), sender: String(sender || ''), group_id: String(group_id || ''), ts: Date.now() });
  saveInbox(inbox);
}
// Tìm tin gần nhất của user trong 15 phút qua (không phải lệnh, không phải "ok ...")
function findRecentUserMessage(sender, group_id) {
  const inbox = loadInbox();
  const now = Date.now();
  for (let i = inbox.length - 1; i >= 0; i--) {
    const it = inbox[i];
    if (it.group_id !== String(group_id)) continue;
    if (it.sender !== String(sender)) continue;
    if (now - it.ts > 15 * 60 * 1000) break;
    const t = cleanText(it.text || '');
    if (!t) continue;
    if (t.startsWith('/') || DONE_REGEX.test(t)) continue;
    return it; // tin hợp lệ gần nhất để sinh task
  }
  return null;
}

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const data = req.body || {};
  res.status(200).send('OK');

  try {
    fs.mkdirSync('./public', { recursive: true });
    saveJSON(LAST_FILE, data);
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

  console.log('📩 Webhook:', JSON.stringify({ event: ev, sender: data?.sender?.id, gid: detectedGroupId, msg_id: msgId, text: text0 }));

  if (isDup(msgId)) { console.log('↩️ duplicate ignored'); return; }
  remember(msgId);

  const sender = data.sender?.id || 'unknown';
  const text = cleanText(text0 || '');

  // Bất kỳ tin nhóm nào cũng đẩy vào inbox (để fallback)
  if (inGroup && isText && text) {
    pushInbox({ msg_id: msgId, text, sender, group_id: detectedGroupId || GROUP_ID });
  }

  // Lọc nếu không phải text/không ở nhóm/không user text
  if (!(isText && (inGroup ||
    ev === 'user_send_group_text' || ev === 'group.message' ||
    ev === 'group_send_text' || ev === 'group_user_send_text' ||
    ev === 'user_send_text'))) return;

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
Có thể reply “ok/hoàn thành/đã xong” vào tin gốc để chốt việc.`);
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
      norm: normalizeForMatch(info.message),
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

  // ===== Natural language DONE =====
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();
    const { quoteId, quoteText, quoteSender } = getQuoteInfo(data);

    // 1) Có quote: tìm theo msg_id → text → fuzzy
    if (quoteId || quoteText) {
      let t = tasks.find(x => !x.done && x.src_msg_id === quoteId);
      if (!t && quoteText) {
        t = tasks.find(x => !x.done &&
          (x.norm === normalizeForMatch(quoteText) ||
           cleanText(x.message) === cleanText(quoteText) ||
           fuzzyMatch(x.message, quoteText)));
      }
      if (!t && quoteText) {
        // nếu chưa từng ghi task → tạo from quote rồi chốt
        t = {
          id: nextTaskId(tasks),
          sender: quoteSender || sender,
          owner: '',
          message: quoteText,
          norm: normalizeForMatch(quoteText),
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: false, doneAt: null,
          src_msg_id: quoteId || '',
          src_sender: quoteSender || sender
        };
        tasks.push(t);
      }
      if (t) {
        if (t.done) {
          await sendTextToGroup(`ℹ️ Việc này đã xong trước đó: ${renderTask(t)}`);
          return;
        }
        t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }

    // 2) KHÔNG có quote: lấy tin gần nhất của chính user trong 15'
    const latest = findRecentUserMessage(sender, detectedGroupId || GROUP_ID);
    if (latest) {
      // thử tìm task đã có (nếu AUTO_TODO đã tạo)
      let t = tasks.find(x => !x.done &&
        (x.src_msg_id === latest.msg_id ||
         x.norm === normalizeForMatch(latest.text) ||
         fuzzyMatch(x.message, latest.text)));
      if (!t) {
        // tạo JIT rồi chốt
        t = {
          id: nextTaskId(tasks),
          sender,
          owner: '',
          message: latest.text,
          norm: normalizeForMatch(latest.text),
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: false, doneAt: null,
          src_msg_id: latest.msg_id,
          src_sender: sender
        };
        tasks.push(t);
      }
      t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
      await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
      return;
    }

    // 3) Fallback cuối: chốt việc gần nhất của user
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

  // ===== AUTO_TODO: tin thường → tạo việc =====
  if (AUTO_TODO && inGroup && !text.startsWith('/')) {
    const content = cleanText(text);
    if (content.length >= 2 && content.length <= 400) {
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner: '',
        message: content,
        norm: normalizeForMatch(content),
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        src_msg_id: msgId,
        src_sender: sender
      };
      tasks.push(t);
      saveTasks(tasks);
      await sendTextToGroup(`📝 Đã ghi nhận việc: ${renderTask(t)}`);
      return;
    }
  }
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

// Token check (đa biến thể)
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

// Report 17:00 (UTC+7)
setInterval(async () => {
  const now = new Date();
  const min = now.getUTCMinutes();
  const hourVN = (now.getUTCHours() + 7) % 24;
  if (hourVN === 17 && min === 0) {
    const tasks = loadTasks();
    await sendTextToGroup(reportText(tasks));
  }
}, 60 * 1000);

// Nhắc quá hạn mỗi 5'
setInterval(async () => {
  const tasks = loadTasks();
  const now = Date.now();
  const overdue = tasks.filter(t => !t.done && t.dueAt && new Date(t.dueAt).getTime() < now);
  if (overdue.length) await sendTextToGroup('⏰ NHẮC HẠN:\n' + overdue.slice(-10).map(renderTask).join('\n'));
}, 5 * 60 * 1000);

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Missing ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN');
});
