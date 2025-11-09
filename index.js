// index.js — ES Module (Node >=18)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

axios.defaults.timeout = 10000; // chống treo gây 502

const app = express();
const PORT = process.env.PORT || 3000;

// ==== ENV ====
const ACCESS_TOKEN =
  process.env.ZALO_OA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN || '';
let GROUP_ID = process.env.GROUP_ID || '';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s=>s.trim()).filter(Boolean);

// ==== Files ====
const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';
const API_V3 = 'https://openapi.zalo.me/v3.0';

app.use(bodyParser.json());

// ==== Helpers (IO) ====
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

// ==== Helpers (time & format) ====
const VN_TZ = 'Asia/Ho_Chi_Minh';
const fmtDate = (d) => new Date(d).toLocaleString('vi-VN', { timeZone: VN_TZ });

function parseDue(input){
  if (!input) return null;
  const s = input.trim();

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const [_, dd, mm, yyyy, hh, mi] = m.map(Number);
    return new Date(Date.UTC(yyyy, mm-1, dd, hh-7, mi)).toISOString(); // VN-7
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const [_, dd, mm, hh, mi] = m.map(Number);
    return new Date(Date.UTC(yyyy, mm-1, dd, hh-7, mi)).toISOString();
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const [_, dd, mm] = m.map(Number);
    return new Date(Date.UTC(yyyy, mm-1, dd, 10, 0)).toISOString(); // 17:00 VN
  }
  return null;
}

function nextTaskId(tasks){
  const max = tasks.reduce((a,t)=>Math.max(a, t.id||0), 0);
  return max + 1;
}

// ==== Senders (V3) ====
async function sendTextToGroup(text){
  if (!GROUP_ID) return console.log('⚠️ Chưa có GROUP_ID.');
  if (!ACCESS_TOKEN) return console.log('⚠️ Thiếu ACCESS_TOKEN.');
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
        validateStatus: () => true,
        timeout: 10000
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
      { recipient: { user_id }, message: { text: String(text) } },
      {
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`
        },
        validateStatus: () => true,
        timeout: 10000
      }
    );
    console.log('📨 V3 oa/message:', r.status, r.data);
  } catch(e){
    console.error('❌ Lỗi oa/message:', e.response?.data || e.message);
  }
}

// ==== Business (tasks & commands) ====
function renderTaskLine(t){
  const due = t.dueAt ? ` | hạn: ${fmtDate(t.dueAt)}` : '';
  const who = t.owner ? ` | phụ trách: ${t.owner}` : '';
  const st  = t.done ? `✅ (xong ${fmtDate(t.doneAt)})` : '⏳';
  return `#${t.id} ${st} ${t.message}${who}${due}`;
}
function reportText(tasks){
  const done    = tasks.filter(t=>t.done);
  const pending = tasks.filter(t=>!t.done);
  let msg = `📅 Báo cáo ${new Date().toLocaleString('vi-VN',{timeZone:VN_TZ})}\n\n`;
  msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length ? done.map(renderTaskLine).join('\n') : '• Không có') + '\n\n';
  msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pending.length ? pending.map(renderTaskLine).join('\n') : '• Không có');
  return msg;
}
// "/todo nội dung | @user | 10/11/2025 09:30"
function parseTodoCommand(text){
  const raw = text.replace(/^\/todo\s*/i,'');
  const parts = raw.split('|').map(s=>s.trim()).filter(Boolean);
  const item = { message:'', owner:'', dueAt:null };
  if (!parts.length) return null;
  item.message = parts[0];
  for (let i=1;i<parts.length;i++){
    const p = parts[i];
    if (p.startsWith('@')) item.owner = p;
    else {
      const d = parseDue(p);
      if (d) item.dueAt = d;
      else item.message += ' | ' + p;
    }
  }
  return item;
}

// ==== Webhook ====
app.post('/webhook', async (req,res)=>{
  const data = req.body || {};
  console.log('📩 Webhook:', JSON.stringify(data));
  res.status(200).send('OK');

  try { fs.writeFileSync(LAST_FILE, JSON.stringify(data,null,2)); } catch {}

  // nhận group id
  const detectedGroupId =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.group_id || '';
  if (detectedGroupId && !GROUP_ID) saveGroupId(detectedGroupId);

  const ev = data.event_name || '';
  const isText  = !!(data?.message && typeof data.message.text === 'string');
  const isGroup = !!(data?.recipient?.group_id || data?.conversation?.id || data?.message?.conversation_id);

  // Bắt nhiều biến thể + fallback khi là tin nhắn text trong nhóm
  if (
    isText &&
    (ev === 'user_send_text' ||
     ev === 'group.message' ||
     ev === 'group_send_text' ||
     ev === 'group_user_send_text' ||
     isGroup)
  ) {
    const sender = data.sender?.id || 'unknown';
    const text = (data.message?.text || '').trim();
    if (!text) return;

    // ==== COMMANDS ====
    if (/^\/help$/i.test(text)) {
      await sendTextToGroup(
`🤖 Lệnh hỗ trợ:
• /todo <nội dung> [| @user] [| dd/mm/yyyy hh:mm]
• /list (all|done|me)
• /done [id]
• /report
Ví dụ: /todo Sửa rò rỉ D90 | @Toan | 12/11/2025 09:30`
      );
      return;
    }

    if (/^\/todo/i.test(text)) {
      const info = parseTodoCommand(text);
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
      tasks.push(t);
      saveTasks(tasks);
      await sendTextToGroup(`📝 Đã tạo việc: ${renderTaskLine(t)}`);
      return;
    }

    if (/^\/list(\s+.+)?$/i.test(text)) {
      const arg = (text.split(/\s+/)[1]||'').toLowerCase();
      const tasks = loadTasks();
      let list = tasks;
      if (arg === 'done') list = tasks.filter(t=>t.done);
      else if (arg === 'me') list = tasks.filter(t=>t.owner || t.sender === sender);
      else if (arg === 'all' || arg==='') list = tasks.filter(()=>true);
      else list = tasks.filter(t=>!t.done);
      if (!list.length){ await sendTextToGroup('📭 Không có việc phù hợp.'); return; }
      await sendTextToGroup('📋 Danh sách:\n' + list.slice(-15).map(renderTaskLine).join('\n'));
      return;
    }

    if (/^\/done(\s+\d+)?$/i.test(text)) {
      const tasks = loadTasks();
      const m = text.match(/^\/done\s+(\d+)$/i);
      if (m) {
        const id = Number(m[1]);
        const t = tasks.find(x=>x.id===id);
        if (!t) { await sendTextToGroup(`⚠️ Không tìm thấy việc #${id}`); return; }
        t.done = true; t.doneAt = new Date().toISOString();
        saveTasks(tasks);
        await sendTextToGroup(`✅ Đã hoàn thành: ${renderTaskLine(t)}`);
        return;
      } else {
        for (let i=tasks.length-1; i>=0; i--){
          const t = tasks[i];
          if (!t.done && (t.sender===sender || (t.owner && t.owner.includes('@')))) {
            t.done = true; t.doneAt = new Date().toISOString();
            saveTasks(tasks);
            await sendTextToGroup(`✅ Đã hoàn thành: ${renderTaskLine(t)}`);
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

    // Không phải command: bỏ qua (chỉ dùng /todo để tạo việc)
  }
});

// ==== ROUTES ====
app.get('/', (req,res)=>{
  res.send(`<h2>💧 Zalo Task Bot (OA API v3)</h2>
  <p>GROUP_ID: ${GROUP_ID || '(chưa có)'} — <a href="/health">health</a> — <a href="/debug/last">last</a></p>
  <p>Commands: /help, /todo, /list, /done, /report — <a href="/report-now">report-now</a></p>`);
});
app.get('/health', (req,res)=> res.json({ ok:true, group_id: !!GROUP_ID }));
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

// 👉 Gửi báo cáo ngay lập tức (không cần gõ trong nhóm)
app.get('/report-now', async (req, res) => {
  const tasks = loadTasks();
  await sendTextToGroup(reportText(tasks));
  res.send('OK, đã gửi báo cáo vào nhóm.');
});

// ==== TOKEN CHECK (thử nhiều biến thể endpoint) ====
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
        timeout: 10000
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
    message: 'All variants returned 404 (empty/invalid api). Kiểm tra deploy (clear cache), domain & token.'
  });
});

// ==== Báo cáo 17:00 (giờ VN) ====
setInterval(async ()=>{
  const now = new Date();
  const hVN = (now.getUTCHours()+7)%24;
  const m = now.getUTCMinutes();
  if (hVN === 17 && m === 0) {
    const tasks = loadTasks();
    await sendTextToGroup(reportText(tasks));
  }
}, 60*1000);

// ==== Nhắc hạn mỗi 5 phút ====
setInterval(async ()=>{
  const tasks = loadTasks();
  const now = Date.now();
  const overdue = tasks.filter(t=>!t.done && t.dueAt && new Date(t.dueAt).getTime() < now);
  if (overdue.length){
    const msg = '⏰ NHẮC HẠN (quá hạn):\n' + overdue.slice(-10).map(renderTaskLine).join('\n');
    await sendTextToGroup(msg);
  }
}, 5 * 60 * 1000);

app.listen(PORT, ()=>{
  console.log(`🚀 Bot chạy tại cổng ${PORT}`);
  if (!ACCESS_TOKEN) console.log('⚠️ Thiếu ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN trong ENV!');
});
