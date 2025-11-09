// index.js — Zalo OA GMF bot (API v3, ES Module)
// Chạy: npm i express body-parser axios dotenv
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// ==== ENV ====
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';

let GROUP_ID = process.env.GROUP_ID || '';
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

// (tùy chọn) chỉ cho phép admin dùng lệnh
const ONLY_ADMINS = String(process.env.ONLY_ADMINS || 'false').toLowerCase() === 'true';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Bật tạo việc tự động khi có tin nhắn thường
const AUTO_TODO = String(process.env.AUTO_TODO || 'true').toLowerCase() === 'true';

// Regex nhận diện hoàn thành
const DONE_REGEX = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ==== Files ====
const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';

// API v3
const API_V3 = 'https://openapi.zalo.me/v3.0';

app.use(bodyParser.json());

// ==== load/save ====
function loadTasks() {
  try { return fs.existsSync(TASK_FILE) ? JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')) : []; }
  catch { return []; }
}
function saveTasks(tasks) { fs.writeFileSync(TASK_FILE, JSON.stringify(tasks, null, 2)); }

function loadGroupId() {
  try {
    if (!fs.existsSync(GROUP_FILE)) return '';
    const o = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf8'));
    return o.group_id || '';
  } catch { return ''; }
}
function saveGroupId(id) {
  GROUP_ID = id;
  fs.writeFileSync(GROUP_FILE, JSON.stringify({ group_id: id }, null, 2));
  console.log('🔐 GROUP_ID saved:', id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

// ==== fmt / helpers ====
const fmt = d => new Date(d).toLocaleString('vi-VN', { timeZone: TZ });

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// >>> BẢN VÁ NHẬN DIỆN: bỏ mention, bỏ dấu, hạ thường để so khớp “mềm”
function normalizeForMatch(s) {
  const noMention = cleanText(String(s || '').replace(/(^|\s)@\S+/g, ' '));
  return noMention
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// >>> BẢN VÁ NHẬN DIỆN: đọc đủ biến thể quoted/quote/reply_to
function getQuoteInfo(data) {
  const m = data?.message || {};
  const q = m.quoted_message || m.quote || m.reply_to || {};
  const quoteId =
    m.quote_msg_id ||
    q.msg_id || q.message_id || q.msgId || '';
  const quoteText = cleanText(q.text || q.message || '');
  const quoteSender = q.sender?.id || q.from_id || '';
  return { quoteId, quoteText, quoteSender };
}

// De-dup theo msg_id (10 phút)
const seen = new Map();
function remember(id) {
  const now = Date.now();
  seen.set(id, now);
  for (const [k, v] of seen) if (now - v > 10 * 60 * 1000) seen.delete(k);
  return true;
}
function isDup(id) { return id && seen.has(id); }

// ==== send helpers ====
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
    console.log('📨 v3 group/message:', r.status, r.data);
  } catch (e) { console.error('❌ group/message:', e.response?.data || e.message); }
}

async function sendTextToUser(uid, text) {
  if (!ACCESS_TOKEN) return;
  try {
    const r = await axios.post(
      `${API_V3}/oa/message`,
      { recipient: { user_id: uid }, message: { text: String(text) } },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true, timeout: 10000
      }
    );
    console.log('📨 v3 oa/message:', r.status, r.data);
  } catch (e) { console.error('❌ oa/message:', e.response?.data || e.message); }
}

// ==== tasks ====
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

// ==== quyền ====
const isAdmin = uid => ADMIN_UIDS.includes(String(uid));
const assertPerm = uid => !ONLY_ADMINS || isAdmin(uid);

// ==== webhook ====
app.post('/webhook', async (req, res) => {
  const data = req.body || {};
  res.status(200).send('OK');

  try {
    fs.mkdirSync('./public', { recursive: true });
    fs.writeFileSync(LAST_FILE, JSON.stringify(data, null, 2));
  } catch {}

  const ev     = data.event_name || '';
  const text0  = data?.message?.text;
  const msgId  = data?.message?.msg_id || data?.msg_id;
  const inGrp  = !!(data?.recipient?.group_id || data?.conversation?.id || data?.message?.conversation_id);
  const sender = data?.sender?.id || 'unknown';

  // tự lưu GROUP_ID nếu thấy từ payload
  const detectedGid = data?.recipient?.group_id || data?.message?.conversation_id || data?.conversation?.id || '';
  if (detectedGid && !GROUP_ID) saveGroupId(detectedGid);

  console.log('📩', JSON.stringify({ ev, sender, gid: detectedGid, msgId, text0 }));
  if (isDup(msgId)) return; remember(msgId);

  if (typeof text0 !== 'string') return;
  const text = cleanText(text0);
  if (!text) return;

  if (!assertPerm(sender)) {
    await sendTextToGroup('⛔ Bạn không có quyền dùng lệnh này.');
    return;
  }

  // ----- lệnh cơ bản -----
  if (/^\/groupid$/i.test(text)) { await sendTextToGroup(GROUP_ID ? `GROUP_ID: ${GROUP_ID}` : 'Chưa có GROUP_ID.'); return; }
  if (/^\/report$/i.test(text))  { await sendTextToGroup(reportText(loadTasks())); return; }
  if (/^\/list$/i.test(text))    {
    const tasks = loadTasks();
    if (!tasks.length) { await sendTextToGroup('📭 Không có việc.'); return; }
    await sendTextToGroup('📋 Danh sách:\n' + tasks.slice(-20).map(renderTask).join('\n')); return;
  }

  // ======= BẢN VÁ NHẬN DIỆN HOÀN THÀNH (chỉ thay khối này) =======
  if (DONE_REGEX.test(text)) {
    const tasks = loadTasks();

    // Lấy thông tin reply/quote nếu có
    const { quoteId, quoteText, quoteSender } = getQuoteInfo(data);

    if (quoteId || quoteText) {
      // 1) Tìm theo id nguồn
      let t = tasks.find(x => !x.done && x.src_msg_id && x.src_msg_id === quoteId);

      // 2) Nếu chưa thấy, so khớp "mềm" theo nội dung tin gốc (bỏ @, bỏ dấu)
      if (!t && quoteText) {
        const qn = normalizeForMatch(quoteText);
        t = tasks.find(x => {
          if (x.done) return false;
          const tn = normalizeForMatch(x.message);
          return tn === qn || tn.includes(qn) || qn.includes(tn);
        });
      }

      // 3) Nếu vẫn chưa thấy mà có text tin gốc -> tạo “just-in-time” rồi chốt
      if (!t && quoteText) {
        t = {
          id: nextTaskId(tasks),
          sender: quoteSender || sender,
          owner: '',
          message: cleanText(quoteText),
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: false,
          doneAt: null,
          src_msg_id: quoteId || '',
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

    // 4) Fallback: không reply -> chốt việc mở gần nhất của người nhắn
    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      if (!t.done && (t.sender === sender || (t.owner && t.owner.includes('@')))) {
        t.done = true; t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTask(t)}`);
        return;
      }
    }

    await sendTextToGroup('⚠️ Không có việc nào để đánh dấu xong.');
    return;
  }
  // ======= HẾT KHỐI VÁ =======

  // Auto tạo việc từ tin nhắn thường (giữ nguyên)
  if (AUTO_TODO && inGrp && !text.startsWith('/')) {
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
        src_msg_id: msgId,      // <— quan trọng để lần sau reply khớp theo id
        src_sender: sender
      };
      tasks.push(t);
      saveTasks(tasks);
      await sendTextToGroup(`📝 Đã ghi nhận việc: ${renderTask(t)}`);
      return;
    }
  }

  // Không phải lệnh → bỏ qua
});

// ==== routes nhỏ để debug ====
app.get('/', (req, res) => {
  res.send(`<h3>💧 Zalo Task Bot (v3)</h3>
  <div>GROUP_ID: ${GROUP_ID || '(none)'}
  — <a href="/health">health</a>
  — <a href="/debug/last">last</a>
  — <a href="/report-now">report-now</a></div>`);
});
app.get('/health', (req, res) => res.json({ ok: true, group_id: !!GROUP_ID }));
app.get('/debug/last', (req, res) => { try { res.type('application/json').send(fs.readFileSync(LAST_FILE, 'utf8')); } catch { res.status(404).send('no payload'); }});
app.get('/set-group', (req, res) => { const id = String(req.query.id || '').trim(); if (!id) return res.status(400).send('missing ?id'); saveGroupId(id); res.send('OK ' + id); });
app.get('/send', async (req, res) => { const text = String(req.query.text || '').trim(); if (!text) return res.status(400).send('missing ?text'); await sendTextToGroup(text); res.send('sent'); });
app.get('/report-now', async (req, res) => { const tasks = loadTasks(); await sendTextToGroup(reportText(tasks)); res.send('OK, báo cáo đã gửi vào nhóm.'); });

// ==== start ====
app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Missing ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN');
});
