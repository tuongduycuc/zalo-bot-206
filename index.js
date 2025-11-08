// index.js — ES Module (Node >=18)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';   // OA access token
let GROUP_ID = process.env.GROUP_ID || '';

const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';

// Message V3 base
const MSGV3_BASE = 'https://business.openapi.zalo.me';

app.use(bodyParser.json());

// ===== Helpers =====
function loadTasks() {
  try {
    if (!fs.existsSync(TASK_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  } catch { return []; }
}
function saveTasks(t) { fs.writeFileSync(TASK_FILE, JSON.stringify(t, null, 2)); }

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
  console.log('🔐 Lưu GROUP_ID:', id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ===== Message V3 senders =====
async function sendTextToGroup(text) {
  if (!GROUP_ID) return console.log('⚠️ Chưa có GROUP_ID.');
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');

  try {
    const r = await axios.post(
      `${MSGV3_BASE}/message/api/v3/oa/group/message`,
      { group_id: GROUP_ID, message: { text: String(text) } },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        validateStatus: () => true
      }
    );
    console.log('📨 V3 group/message:', r.status, r.data);
    if (r.data?.error === 0 || r.data?.message === 'Success') {
      console.log('✅ Đã gửi vào nhóm (V3).');
    } else {
      console.log('⚠️ Gửi không thành công (V3):', r.data);
    }
  } catch (e) {
    console.error('❌ Lỗi (V3 group):', e.response?.data || e.message);
  }
}

async function sendTextToUser(user_id, text) {
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');
  try {
    const r = await axios.post(
      `${MSGV3_BASE}/message/api/v3/oa/message`,
      { recipient: { user_id }, message: { text: String(text) } },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        validateStatus: () => true
      }
    );
    console.log('📨 V3 oa/message:', r.status, r.data);
  } catch (e) {
    console.error('❌ Lỗi (V3 user):', e.response?.data || e.message);
  }
}

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const data = req.body || {};
  console.log('📩 Webhook:', JSON.stringify(data));
  res.status(200).send('OK');

  // Lưu payload gần nhất
  try { fs.writeFileSync(LAST_FILE, JSON.stringify(data, null, 2)); } catch {}

  // Tự phát hiện group id
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.group_id || '';
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  // Ghi task / đánh dấu done
  const ev = data.event_name || '';
  if (ev === 'user_send_text' || ev === 'group.message') {
    const sender = data.sender?.id || 'unknown';
    const text = (data.message?.text || '').trim();
    if (!text) return;

    if (/^\/groupid$/i.test(text)) {
      await sendTextToGroup(GROUP_ID ? `GROUP_ID hiện tại: ${GROUP_ID}` : 'Chưa có GROUP_ID.');
      return;
    }

    let tasks = loadTasks();
    if (DONE_REGEX.test(text)) {
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].sender === sender && !tasks[i].done) { tasks[i].done = true; break; }
      }
      saveTasks(tasks);
      return;
    }

    tasks.push({ sender, message: text, done: false });
    saveTasks(tasks);
  }
});

// ===== Pages / Tools =====
app.get('/', (req, res) => {
  res.send(`
    <h2>💧 Zalo Task Bot (Message V3) đang chạy!</h2>
    <p>GROUP_ID: ${GROUP_ID ? GROUP_ID : '(chưa có)'} — <a href="/health">health</a> — <a href="/debug/last">last</a></p>
  `);
});
app.get('/health', (req, res) => res.json({ ok: true, group_id: !!GROUP_ID }));

app.get('/debug/last', (req, res) => {
  try { res.type('application/json').send(fs.readFileSync(LAST_FILE, 'utf8')); }
  catch { res.status(404).send('Chưa có payload nào.'); }
});

// Đặt GROUP_ID thủ công (lấy từ gid=... trên URL chat nhóm)
app.get('/set-group', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).send('Thiếu ?id');
  saveGroupId(id);
  res.send('OK, GROUP_ID=' + id);
});

// Gửi nhanh vào nhóm: /send?text=Ping
app.get('/send', async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).send('Thiếu ?text');
  await sendTextToGroup(text);
  res.send('Đã gọi gửi: ' + text);
});

// Gửi 1–1 test: /send2-user?uid=...&text=...
app.get('/send2-user', async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  const text = String(req.query.text || 'test').trim();
  if (!uid) return res.status(400).send('Thiếu ?uid');
  await sendTextToUser(uid, text);
  res.send('Đã gọi gửi 1–1.');
});

// Kiểm tra token: trả info OA nếu token hợp lệ
app.get('/token-check', async (req, res) => {
  try {
    const r = await axios.get(
      'https://openapi.zalo.me/v3.0/oa/getoa',
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, validateStatus: () => true }
    );
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// ===== Báo cáo 17:00 (giờ VN) =====
setInterval(async () => {
  const now = new Date();
  const hVN = (now.getUTCHours() + 7) % 24;
  const m = now.getUTCMinutes();
  if (hVN === 17 && m === 0) {
    const tasks = loadTasks();
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);
    let msg = `📅 Báo cáo ngày ${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n\n`;
    msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length ? done.map(t => `• ${t.message}`).join('\n') : '• Không có') + '\n\n';
    msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pending.length ? pending.map(t => `• ${t.message}`).join('\n') : '• Không có');
    await sendTextToGroup(msg);
    saveTasks([]);
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Thiếu ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN trong ENV!');
});
