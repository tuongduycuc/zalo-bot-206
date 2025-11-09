// index.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

const app = express();
app.use(bodyParser.json());

// ===== ENV =====
const PORT = process.env.PORT || 3000;
const OA_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN || '';
let   GROUP_ID = (process.env.GROUP_ID || '').trim();
const VERIFY_SIGNATURE = (process.env.VERIFY_SIGNATURE || 'false') === 'true';

// ===== FILES =====
const TASK_FILE = './tasks.json';
const INBOX_FILE = './inbox.json';
const GROUP_FILE = './group.json';

// ===== IO helpers =====
function loadJSON(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}
function loadTasks()   { return loadJSON(TASK_FILE, []); }
function saveTasks(t)  { saveJSON(TASK_FILE, t); }
function loadInbox()   { return loadJSON(INBOX_FILE, []); }
function saveInbox(b)  { saveJSON(INBOX_FILE, b); }
function loadGroupId() { return loadJSON(GROUP_FILE, { group_id: '' }).group_id || ''; }
function saveGroupId(id) { GROUP_ID = id; saveJSON(GROUP_FILE, { group_id: id }); console.log('🔐 Lưu GROUP_ID:', id); }

if (!GROUP_ID) GROUP_ID = loadGroupId();

// ===== Zalo send (Message V3) =====
async function sendToGroup(text) {
  const gid = GROUP_ID?.trim();
  if (!OA_TOKEN) {
    console.log('⚠️ Thiếu ZALO_OA_ACCESS_TOKEN');
    return;
  }
  if (!gid) {
    console.log('⚠️ Chưa có GROUP_ID để gửi');
    return;
  }
  try {
    const url = 'https://openapi.zalo.me/v3.0/oa/message/callback';
    const payload = { recipient: { group_id: gid }, message: { text } };
    const res = await axios.post(url, payload, {
      headers: { access_token: OA_TOKEN, 'Content-Type': 'application/json' }
    });
    const data = res.data || {};
    console.log('📨 V3 group/message:', res.status, data);
    if (data.error === 0) console.log('✅ Đã gửi vào nhóm.');
    else console.log('⚠️ Gửi không thành công:', data);
  } catch (err) {
    console.log('❌ Lỗi gửi nhóm:', err.response?.data || err.message);
  }
}

// ===== Normalizers / matchers =====
const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly|đã sửa|da sua|ok đã xử lý|ok da xu ly)/i;

function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function fuzzyMatch(a, b) {
  const A = normalizeForMatch(a);
  const B = normalizeForMatch(b);
  if (!A || !B) return false;
  if (A === B) return true;
  return A.includes(B) || B.includes(A);
}
function cleanText(s) { return (s || '').trim(); }
function nextTaskId(tasks) {
  const x = tasks.map(t => t.id || 0);
  return (x.length ? Math.max(...x) : 0) + 1;
}

// ===== Inbox helpers =====
// Lưu inbox: mỗi item {msg_id, group_id, sender, text, ts}
function pushInbox(msg) {
  const inbox = loadInbox();
  inbox.push(msg);
  // giữ tối đa ~2000 bản ghi
  if (inbox.length > 2000) inbox.splice(0, inbox.length - 2000);
  saveInbox(inbox);
}

// Tìm tin gần nhất của CHÍNH user trong 15'
function findRecentUserMessage(user_id, group_id) {
  const inbox = loadInbox();
  const now = Date.now();
  for (let i = inbox.length - 1; i >= 0; i--) {
    const it = inbox[i];
    if (it.group_id !== String(group_id) || it.sender !== String(user_id)) continue;
    if (now - it.ts > 15 * 60 * 1000) break;
    const t = cleanText(it.text || '');
    if (!t) continue;
    if (t.startsWith('/') || DONE_REGEX.test(t)) continue;
    return it;
  }
  return null;
}

// Tìm tin gần nhất trong NHÓM (ai gửi cũng được) trong 10'
function findRecentGroupMessage(group_id) {
  const inbox = loadInbox();
  const now = Date.now();
  for (let i = inbox.length - 1; i >= 0; i--) {
    const it = inbox[i];
    if (it.group_id !== String(group_id)) continue;
    if (now - it.ts > 10 * 60 * 1000) break;
    const t = cleanText(it.text || '');
    if (!t) continue;
    if (t.startsWith('/') || DONE_REGEX.test(t)) continue;
    return it;
  }
  return null;
}

// ====== Routes ======
app.get('/', (req, res) => {
  res.send(
    `<h2>💧 Zalo Task Bot đang chạy!</h2>
     GROUP_ID: ${GROUP_ID ? GROUP_ID : '(chưa có)'} — <a href="/health">health</a> — <a href="/token-check">token-check</a>`
  );
});
app.get('/health', (req, res) => res.json({ ok: true, group_id: GROUP_ID || null }));
app.get('/token-check', async (req, res) => {
  try {
    const url = 'https://openapi.zalo.me/v3.0/oa/getoa';
    const r = await axios.get(url, { headers: { access_token: OA_TOKEN } });
    res.json(r.data);
  } catch (e) {
    res.status(500).json(e.response?.data || { error: e.message });
  }
});

// ====== Webhook ======
app.post('/webhook', async (req, res) => {
  // Nếu cần verify chữ ký: thêm phần check ở đây (VERIFY_SIGNATURE)
  res.status(200).send('OK');

  const b = req.body || {};
  console.log('🪝 Webhook:', JSON.stringify(b));

  // Trích xuất chung
  const event = b.event_name || '';
  const sender = String(b.sender?.id || '');
  const groupIdDetected =
    String(b.recipient?.group_id || b.message?.conversation_id || b.recipient?.id || '');

  if (groupIdDetected && !GROUP_ID) saveGroupId(groupIdDetected);

  // Chỉ xử lý text
  if (event !== 'user_send_group_text' && event !== 'user_send_text') return;
  const text = cleanText(b.message?.text || '');
  const msg_id = String(b.message?.msg_id || Date.now());
  const gid = groupIdDetected || GROUP_ID;

  // Ghi inbox
  pushInbox({ msg_id, group_id: gid, sender, text, ts: Date.now() });

  // Slash commands
  if (/^\/list\b/i.test(text))  return handleList(gid);
  if (/^\/report\b/i.test(text)) return handleReport(gid);

  // Nếu là câu DONE -> mark xong
  if (DONE_REGEX.test(text)) return handleDoneFlow(b, sender, gid, text);

  // Ngược lại -> tạo task mới
  return handleCreateTaskFromMessage(b, sender, gid, text);
});

// ====== Command handlers ======
async function handleList(gid) {
  const tasks = loadTasks().filter(t => !t.done);
  if (!tasks.length) return sendToGroup('📚 Không có việc phù hợp.');
  const lines = tasks.slice(-10).map(t => `• ${t.message}`);
  return sendToGroup('📚 Việc đang mở:\n' + lines.join('\n'));
}

async function handleReport(gid) {
  const tasks = loadTasks();
  const done = tasks.filter(t => t.done && isToday(t.doneAt));
  const pending = tasks.filter(t => !t.done);

  const stamp = new Date().toLocaleString('vi-VN');
  let msg = `📅 Báo cáo ${stamp}\n\n`;
  msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length ? '• ' + done.map(t => t.message).join('\n• ') : '• Không có') + '\n\n';
  msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pending.length ? '• ' + pending.map(t => t.message).join('\n• ') : '• Không có');
  return sendToGroup(msg);
}
function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// ====== Create Task ======
async function handleCreateTaskFromMessage(body, sender, gid, text) {
  if (!text) return;
  const tasks = loadTasks();
  const norm = normalizeForMatch(text);
  // chống trùng thẳng
  const dup = tasks.find(t => !t.done && (t.norm === norm || fuzzyMatch(t.message, text)));
  if (dup) return;

  const task = {
    id: nextTaskId(tasks),
    sender, owner: '',
    message: text, norm,
    src_msg_id: String(body.message?.msg_id || ''),
    src_sender: sender,
    group_id: gid,
    createdAt: new Date().toISOString(),
    dueAt: null,
    done: false, doneAt: null
  };
  tasks.push(task);
  saveTasks(tasks);
  await sendToGroup('📝 Đã ghi nhận: ' + text);
}

// ====== Done Flow (3 lớp) ======
async function handleDoneFlow(body, sender, gid, text) {
  const tasks = loadTasks();
  let candidate = null;

  const quoted = body.message?.quote_msg; // một số payload dùng quote_msg
  const quoted_id = quoted?.msg_id || body.message?.quoted_msg_id || body.message?.quote_msg_id;

  // === Lớp 1: có quote -> gán thẳng
  if (quoted_id) {
    candidate = tasks.find(t => !t.done && (
      t.src_msg_id === String(quoted_id)
      || fuzzyMatch(t.message, quoted?.text || '')
    ));
    if (!candidate && quoted?.text) {
      candidate = {
        id: nextTaskId(tasks),
        sender: quoted?.sender || sender,
        owner: '',
        message: quoted.text,
        norm: normalizeForMatch(quoted.text),
        src_msg_id: String(quoted_id),
        src_sender: String(quoted?.sender || ''),
        group_id: gid,
        createdAt: new Date().toISOString(),
        dueAt: null,
        done: false, doneAt: null
      };
      tasks.push(candidate);
      saveTasks(tasks);
    }
  }

  // === Lớp 2: không có quote -> lấy tin gần nhất của CHÍNH user
  if (!candidate) {
    const hit = findRecentUserMessage(sender, gid);
    if (hit) {
      candidate = tasks.find(t => !t.done && (
        t.src_msg_id === hit.msg_id
        || t.norm === normalizeForMatch(hit.text)
        || fuzzyMatch(t.message, hit.text)
      ));
      if (!candidate) {
        candidate = {
          id: nextTaskId(tasks),
          sender,
          owner: '',
          message: hit.text,
          norm: normalizeForMatch(hit.text),
          src_msg_id: hit.msg_id,
          src_sender: sender,
          group_id: gid,
          createdAt: new Date().toISOString(),
          dueAt: null,
          done: false, doneAt: null
        };
        tasks.push(candidate);
        saveTasks(tasks);
      }
    }
  }

  // === Lớp 3: không có tin của user -> lấy tin gần nhất trong NHÓM
  if (!candidate) {
    const grpHit = findRecentGroupMessage(gid);
    if (grpHit) {
      candidate = tasks.find(t => !t.done && (
        t.src_msg_id === grpHit.msg_id
        || t.norm === normalizeForMatch(grpHit.text)
        || fuzzyMatch(t.message, grpHit.text)
      ));
      if (!candidate) {
        candidate = {
          id: nextTaskId(tasks),
          sender: grpHit.sender,
          owner: '',
          message: grpHit.text,
          norm: normalizeForMatch(grpHit.text),
          src_msg_id: grpHit.msg_id,
          src_sender: grpHit.sender,
          group_id: gid,
          createdAt: new Date().toISOString(),
          dueAt: null,
          done: false, doneAt: null
        };
        tasks.push(candidate);
        saveTasks(tasks);
      }
    }
  }

  if (!candidate) {
    return sendToGroup('⚠️ Không có việc nào để đánh dấu xong (không tìm thấy ứng viên). Thử /list hoặc tạo việc mới rồi nhắn "ok".');
  }

  candidate.done = true;
  candidate.doneAt = new Date().toISOString();
  saveTasks(tasks);

  return sendToGroup('✅ Đã hoàn thành: ' + candidate.message);
}

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
  if (!OA_TOKEN) console.log('⚠️ Thiếu ZALO_OA_ACCESS_TOKEN — hãy cấu hình trong biến môi trường!');
});
