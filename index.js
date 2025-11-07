// index.js — ES Module (Node >=18)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- ENV (hỗ trợ cả tên cũ lẫn mới) ----
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';

let GROUP_ID = process.env.GROUP_ID || '';

const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';

app.use(bodyParser.json());

// ========== Helpers ==========
function loadTasks() {
  try {
    if (!fs.existsSync(TASK_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  } catch { return []; }
}
function saveTasks(t) {
  fs.writeFileSync(TASK_FILE, JSON.stringify(t, null, 2));
}
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

async function sendTextToGroup(text) {
  if (!GROUP_ID) return console.log('⚠️ Chưa có GROUP_ID.');
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');
  try {
    const res = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/callback',
      { recipient: { group_id: GROUP_ID }, message: { text } },
      { headers: { access_token: ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('📨 Zalo response (callback):', res.data);
    if (res.data && (res.data.error === 0 || res.data.message === 'Success')) {
      console.log('✅ Đã gửi vào nhóm.');
    } else {
      console.log('⚠️ Gửi không thành công:', res.data);
    }
  } catch (err) {
    console.error('❌ Lỗi gửi (callback):', err.response?.data || err.message);
  }
}

const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ========== Webhook ==========
app.post('/webhook', async (req, res) => {
  const data = req.body || {};
  console.log('📩 Webhook:', JSON.stringify(data));
  res.status(200).send('OK');

  // Lưu payload gần nhất để debug
  try { fs.writeFileSync(LAST_FILE, JSON.stringify(data, null, 2)); } catch {}

  // Tự phát hiện group id ở nhiều vị trí
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.group_id || '';

  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  // Ghi task / đánh dấu done cho cả user & group
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
        if (tasks[i].sender === sender && !tasks[i].done) {
          tasks[i].done = true;
          break;
        }
      }
      saveTasks(tasks);
      return;
    }

    tasks.push({ sender, message: text, done: false });
    saveTasks(tasks);
  }
});

// ========== Pages / Tools ==========
app.get('/', (req, res) => {
  res.send(`
    <h2>💧 Zalo Task Bot đang chạy!</h2>
    <p>GROUP_ID: ${GROUP_ID ? GROUP_ID : '(chưa có)'} — <a href="/health">health</a> — <a href="/debug/last">last</a></p>
  `);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, group_id: !!GROUP_ID });
});

app.get('/debug/last', (req, res) => {
  try {
    const raw = fs.readFileSync(LAST_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).send('Chưa có payload nào.');
  }
});

// Đặt GROUP_ID thủ công: /set-group?id=xxxxx
app.get('/set-group', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).send('Thiếu ?id');
  saveGroupId(id);
  res.send('OK, GROUP_ID=' + id);
});

// Gửi nhanh qua callback API: /send?text=...
app.get('/send', async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).send('Thiếu ?text');
  await sendTextToGroup(text);
  res.send('Đã gọi gửi: ' + text);
});

// Thử endpoint group riêng (một số OA yêu cầu): /send2?text=...
app.get('/send2', async (req, res) => {
  if (!GROUP_ID) return res.status(400).send('Chưa có GROUP_ID');
  if (!ACCESS_TOKEN) return res.status(400).send('Thiếu ACCESS_TOKEN');
  try {
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/group/message',
      { group_id: GROUP_ID, message: { text: String(req.query.text || 'test') } },
      { headers: { access_token: ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('📨 Zalo response (group/message):', r.data);
    res.json(r.data);
  } catch (e) {
    console.error('❌ send2 error:', e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

// ========== Báo cáo 17:00 (giờ VN) ==========
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
