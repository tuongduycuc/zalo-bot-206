// index.js — ES Module (Node >=18)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

axios.defaults.timeout = 10000; // ⏱️ chống treo gây 502

const app = express();
const PORT = process.env.PORT || 3000;

// ==== ENV ====
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';
let GROUP_ID = process.env.GROUP_ID || '';

const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';

const API_V3 = 'https://openapi.zalo.me/v3.0';

app.use(bodyParser.json());

// ==== Helpers ====
function loadTasks() {
  try { return fs.existsSync(TASK_FILE) ? JSON.parse(fs.readFileSync(TASK_FILE,'utf8')) : []; }
  catch { return []; }
}
function saveTasks(t){ fs.writeFileSync(TASK_FILE, JSON.stringify(t,null,2)); }

function loadGroupId() {
  try { return fs.existsSync(GROUP_FILE) ? (JSON.parse(fs.readFileSync(GROUP_FILE,'utf8')).group_id || '') : ''; }
  catch { return ''; }
}
function saveGroupId(id){
  GROUP_ID = id;
  fs.writeFileSync(GROUP_FILE, JSON.stringify({group_id:id}, null, 2));
  console.log('🔐 Lưu GROUP_ID:', id);
}
if (!GROUP_ID) GROUP_ID = loadGroupId();

const DONE_REGEX = /(đã xong|da xong|ok\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

// ==== Senders (V3 đúng schema) ====
async function sendTextToGroup(text){
  if (!GROUP_ID) return console.log('⚠️ Chưa có GROUP_ID.');
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');
  try {
    const r = await axios.post(
      `${API_V3}/oa/group/message`,
      {
        recipient: { group_id: GROUP_ID },
        message:   { text: String(text) }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true,
        timeout: 10000 // ⏱️
      }
    );
    console.log('📨 V3 group/message:', r.status, r.data);
    if (r.data?.error === 0 || r.data?.message === 'Success') {
      console.log('✅ Đã gửi vào nhóm.');
    } else {
      console.log('⚠️ Gửi không thành công:', r.data);
    }
  } catch(e){
    console.error('❌ Lỗi group/message:', e.response?.data || e.message);
  }
}

async function sendTextToUser(user_id, text){
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');
  try {
    const r = await axios.post(
      `${API_V3}/oa/message`,
      {
        recipient: { user_id },
        message:   { text: String(text) }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true,
        timeout: 10000 // ⏱️
      }
    );
    console.log('📨 V3 oa/message:', r.status, r.data);
  } catch(e){
    console.error('❌ Lỗi oa/message:', e.response?.data || e.message);
  }
}

// ==== Webhook ====
app.post('/webhook', async (req,res)=>{
  const data = req.body || {};
  console.log('📩 Webhook:', JSON.stringify(data));
  res.status(200).send('OK');

  try { fs.writeFileSync(LAST_FILE, JSON.stringify(data,null,2)); } catch {}

  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.group_id || '';
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

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

// ==== Tools / Pages ====
app.get('/', (req,res)=>{
  res.send(`<h2>💧 Zalo Task Bot (OA API v3)</h2>
  <p>GROUP_ID: ${GROUP_ID || '(chưa có)'} — <a href="/health">health</a> — <a href="/debug/last">last</a></p>`);
});
app.get('/health', (req,res)=> res.json({ ok:true, group_id: !!GROUP_ID }));

// Route tự test nội bộ (phân biệt app down hay call Zalo treo)
app.get('/__selftest', (req,res)=> res.json({ up:true, t:Date.now() }));

app.get('/debug/last', (req,res)=>{
  try { res.type('application/json').send(fs.readFileSync(LAST_FILE,'utf8')); }
  catch { res.status(404).send('Chưa có payload nào.'); }
});

app.get('/set-group', (req,res)=>{
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).send('Thiếu ?id');
  saveGroupId(id);
  res.send('OK, GROUP_ID=' + id);
});

app.get('/send', async (req,res)=>{
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).send('Thiếu ?text');
  await sendTextToGroup(text);
  res.send('Đã gọi gửi: ' + text);
});

app.get('/send2-user', async (req,res)=>{
  const uid  = String(req.query.uid  || '').trim();
  const text = String(req.query.text || 'test').trim();
  if (!uid) return res.status(400).send('Thiếu ?uid');
  await sendTextToUser(uid, text);
  res.send('Đã gọi gửi 1–1.');
});

// ==== TOKEN CHECK: 6 tries (V3/V2/root) với header & query param ====
app.get('/token-check', async (req, res) => {
  const token = ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'no_token', message: 'Thiếu ACCESS_TOKEN trong ENV' });

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
        headers: t.hdr ? {
          access_token: token,
          Authorization: `Bearer ${token}`
        } : undefined,
        validateStatus: () => true,
        timeout: 10000 // ⏱️
      });
      console.log('🔎 token-check try:', t.url, r.status, r.data?.error);
      if (r.status !== 404 && !(r.data && r.data.error === 404)) {
        return res.status(r.status).json(r.data);
      }
    } catch (e) {
      console.log('token-check error on', t.url, e.message);
    }
  }
  return res.status(404).json({
    error: 404,
    message: 'All variants returned 404 (empty/invalid api). Hãy kiểm tra deploy (clear cache), domain và token.'
  });
});

// ==== Báo cáo 17:00 (giờ VN) ====
setInterval(async ()=>{
  const now = new Date();
  const hVN = (now.getUTCHours()+7)%24;
  const m = now.getUTCMinutes();
  if (hVN === 17 && m === 0) {
    const tasks = loadTasks();
    const done    = tasks.filter(t=>t.done);
    const pending = tasks.filter(t=>!t.done);
    let msg = `📅 Báo cáo ngày ${now.toLocaleDateString('vi-VN', { timeZone:'Asia/Ho_Chi_Minh' })}\n\n`;
    msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length ? done.map(t=>`• ${t.message}`).join('\n') : '• Không có') + '\n\n';
    msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pending.length ? pending.map(t=>`• ${t.message}`).join('\n') : '• Không có');
    await sendTextToGroup(msg);
    saveTasks([]);
  }
}, 60*1000);

app.listen(PORT, ()=>{
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Thiếu ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN trong ENV!');
});
