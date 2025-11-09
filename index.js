// index.js — Zalo OA Task Bot (v3)
// - Ghi việc tự động (im lặng), done im lặng
// - Báo cáo theo lệnh & tự động 17:00
// - Báo cáo theo khoảng thời gian & xuất Excel (*.xlsx) qua link
// - Bắt group chắc chắn, tự refresh token khi hết hạn (nếu có)
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const app = express();
const PORT = process.env.PORT || 3000;

let ACCESS_TOKEN   = process.env.ZALO_OA_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,''); // bỏ dấu / cuối

let GROUP_ID = process.env.GROUP_ID || '';
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

const ONLY_ADMINS = String(process.env.ONLY_ADMINS || 'false').toLowerCase() === 'true';
const ADMIN_UIDS  = (process.env.ADMIN_UIDS || '').split(',').map(s=>s.trim()).filter(Boolean);

const AUTO_TODO   = String(process.env.AUTO_TODO || 'true').toLowerCase() === 'true';
const AUTO_TODO_CONFIRM = String(process.env.AUTO_TODO_CONFIRM || 'false').toLowerCase() === 'true';

const DONE_SILENT = String(process.env.DONE_SILENT || 'true').toLowerCase() === 'true';

const DAILY_H = Number(process.env.DAILY_REPORT_HOUR || 17);
const DAILY_M = Number(process.env.DAILY_REPORT_MINUTE || 0);

const DONE_REGEX  = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

const API_V3 = 'https://openapi.zalo.me/v3.0';

const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';
const MSG_FILE   = './msgs.json';
const TOKEN_FILE = './token.json';

// đảm bảo thư mục public/exports tồn tại
fs.mkdirSync('public/exports', { recursive: true });

app.use(bodyParser.json());
app.use('/files', express.static('public')); // phục vụ file xuất excel & last webhook

// ---------------- Storage helpers ----------------
function safeRead(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function safeWrite(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function fmt(d) { return new Date(d).toLocaleString('vi-VN', { timeZone: TZ }); }
function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function norm(s){
  const noAt = clean(String(s||'').replace(/(^|\s)@\S+/g,' '));
  return noAt.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}

// Alias báo cáo
function isReportCmd(s) {
  const t = norm(s);
  return (
    /^\/report$/i.test(s) ||
    /^\/bc$/i.test(s) ||
    t === 'bc' || t === 'bao cao' || t === 'baocao' || t === 'bao-cao'
  );
}

// ---------------- Token load/save/refresh ----------------
function loadPersistedToken() {
  const tok = safeRead(TOKEN_FILE, null);
  if (tok?.access_token) ACCESS_TOKEN = tok.access_token;
}
function persistToken(access_token, expires_in_sec) {
  const expires_at = Date.now() + (Number(expires_in_sec || 3600) - 60) * 1000;
  safeWrite(TOKEN_FILE, { access_token, expires_at });
  ACCESS_TOKEN = access_token;
  console.log('🔄 Token refreshed. Expires at:', new Date(expires_at).toISOString());
}
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) { console.log('⚠️ REFRESH_TOKEN chưa cấu hình.'); return false; }
  try {
    const r = await axios.post(`${API_V3}/oa/access_token`,
      { refresh_token: REFRESH_TOKEN },
      { headers: { 'Content-Type':'application/json' }, validateStatus:()=>true, timeout:10000 }
    );
    if (r.status === 200 && r.data?.access_token) {
      persistToken(r.data.access_token, r.data.expires_in || 3600);
      return true;
    }
    console.log('❌ refresh token fail:', r.status, r.data); return false;
  } catch (e) { console.log('❌ refresh token error:', e.response?.data || e.message); return false; }
}
loadPersistedToken();

// ---------------- Task helpers ----------------
function loadTasks(){ return safeRead(TASK_FILE, []); }
function saveTasks(t){ safeWrite(TASK_FILE, t); }
function nextTaskId(tasks){ return tasks.reduce((m,t)=>Math.max(m,t.id||0),0)+1; }

function render(t){
  const due = t.dueAt ? ` | hạn: ${fmt(t.dueAt)}` : '';
  const who = t.owner ? ` | phụ trách: ${t.owner}` : '';
  const st  = t.done ? `✅ (xong ${fmt(t.doneAt)})` : '⏳';
  return `#${t.id} ${st} ${t.message}${who}${due}`;
}
function report(tasks){
  const done = tasks.filter(x=>x.done);
  const pend = tasks.filter(x=>!x.done);
  let msg = `📅 Báo cáo ${fmt(new Date())}\n\n`;
  msg += '✅ ĐÃ HOÀN THÀNH:\n' + (done.length?done.map(render).join('\n'):'• Không có') + '\n\n';
  msg += '⚠️ CHƯA HOÀN THÀNH:\n' + (pend.length?pend.map(render).join('\n'):'• Không có');
  return msg;
}

function loadMsgs(){ return safeRead(MSG_FILE, []); }
function saveMsgs(msgs){
  msgs.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  safeWrite(MSG_FILE, msgs.slice(0,500));
}

function loadGroupId(){
  try{ if(!fs.existsSync(GROUP_FILE)) return ''; return JSON.parse(fs.readFileSync(GROUP_FILE,'utf8')).group_id||''; }
  catch{ return ''; }
}
function saveGroupId(id){
  GROUP_ID=id; safeWrite(GROUP_FILE, {group_id:id});
  console.log('🔐 GROUP_ID saved:', id);
}
if(!GROUP_ID) GROUP_ID = loadGroupId();

// Dedupe
const seen = new Map();
function remember(id){ const now=Date.now(); if(id) {seen.set(id,now); for(const[k,v] of seen){ if(now-v>10*60*1000) seen.delete(k);} } }
function isDup(id){ return id && seen.has(id); }

const isAdmin = uid => ADMIN_UIDS.includes(String(uid));
const allow   = uid => !ONLY_ADMINS || isAdmin(uid);

// Quote extractor
function getQuoteInfo(data){
  const m = data?.message || {};
  const qid =
    m.quote_msg_id ||
    m?.quoted_message?.msg_id ||
    m?.quote?.msg_id ||
    m?.reply_to?.msg_id ||
    m?.quoted?.msg_id ||
    '';
  const qtxt =
    clean(m?.quoted_message?.text || m?.quote?.text || m?.reply_to?.text || m?.quoted?.text || '');
  const qsender =
    m?.quoted_message?.sender?.id || m?.quote?.sender?.id || m?.reply_to?.sender?.id || '';
  return { quoteId: qid, quoteText: qtxt, quoteSender: qsender };
}

// ---------------- Send to group (auto refresh on -216/401) ----------------
async function zaloGroupMessage(text) {
  return axios.post(
    `${API_V3}/oa/group/message`,
    { recipient:{ group_id: GROUP_ID }, message:{ text:String(text) } },
    {
      headers:{
        'Content-Type':'application/json',
        access_token: ACCESS_TOKEN,
        Authorization:`Bearer ${ACCESS_TOKEN}`,
      },
      validateStatus:()=>true,
      timeout:10000
    }
  );
}
async function sendGroup(text){
  if(!GROUP_ID){ console.log('⚠️ No GROUP_ID'); return; }
  if(!ACCESS_TOKEN){ console.log('⚠️ No ACCESS_TOKEN'); return; }
  let r = await zaloGroupMessage(text);
  console.log('📨 v3 group/message:', r.status, r.data);
  const expired = (r.status===401) || (r.data?.error === -216);
  if (expired) {
    const ok = await refreshAccessToken();
    if (ok) {
      r = await zaloGroupMessage(text);
      console.log('📨 retry v3 group/message:', r.status, r.data);
    }
  }
}

// ---------------- Time helpers & range parsing ----------------
function toDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) { const dd=m[1].padStart(2,'0'); const mm=m[2].padStart(2,'0'); const yy=m[3]; return new Date(`${yy}-${mm}-${dd}T00:00:00`); }
  return new Date(s);
}
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d){ const x=new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }

function resolveShortcut(token) {
  const now = new Date();
  const todayS = startOfDay(now);
  const yesterdayS = addDays(todayS, -1);
  if (token === 'today')     return { from: todayS, to: endOfDay(todayS) };
  if (token === 'yesterday') return { from: yesterdayS, to: endOfDay(yesterdayS) };

  const dow = todayS.getDay() || 7; // Mon=1..Sun=7
  const weekStart = addDays(todayS, 1 - dow);
  const lastWeekStart = addDays(weekStart, -7);
  if (token === 'thisweek') return { from: weekStart, to: endOfDay(addDays(weekStart, 6)) };
  if (token === 'lastweek') return { from: lastWeekStart, to: endOfDay(addDays(lastWeekStart, 6)) };

  const m0 = new Date(todayS.getFullYear(), todayS.getMonth(), 1);
  const m1 = new Date(todayS.getFullYear(), todayS.getMonth()+1, 0);
  const lm0 = new Date(todayS.getFullYear(), todayS.getMonth()-1, 1);
  const lm1 = new Date(todayS.getFullYear(), todayS.getMonth(), 0);
  if (token === 'thismonth') return { from: m0, to: endOfDay(m1) };
  if (token === 'lastmonth') return { from: lm0, to: endOfDay(lm1) };

  return null;
}

function parseRange(args) {
  let target = 'createdAt'; // mặc định lọc theo ngày tạo
  let i = 0;
  if (String(args[0]||'').toLowerCase() === 'done') { target = 'doneAt'; i = 1; }

  let from=null, to=null;
  const token = String(args[i]||'').toLowerCase();

  const sc = resolveShortcut(token);
  if (sc) { from = sc.from; to = sc.to; return { target, from, to }; }

  if (args[i] && args[i+1]) {
    const f = toDate(args[i]);
    const t = toDate(args[i+1]);
    if (f && t && !isNaN(f) && !isNaN(t)) { return { target, from:startOfDay(f), to:endOfDay(t) }; }
  }
  if (args[i]) {
    const f = toDate(args[i]);
    if (f && !isNaN(f)) { return { target, from:startOfDay(f), to:endOfDay(f) }; }
  }
  return null;
}

function filterByRange(tasks, range) {
  if (!range) return tasks;
  const { target, from, to } = range;
  return tasks.filter(t => {
    const stamp = t[target];
    if(!stamp) return false;
    const dt = new Date(stamp);
    return dt >= from && dt <= to;
  });
}

// ---------------- Export Excel ----------------
function exportExcel(tasks, filename) {
  const rows = tasks.map(t => ({
    id: t.id,
    message: t.message,
    owner: t.owner || '',
    createdAt: t.createdAt || '',
    dueAt: t.dueAt || '',
    done: t.done ? 1 : 0,
    doneAt: t.doneAt || '',
    sender: t.sender || '',
    src_msg_id: t.src_msg_id || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
  XLSX.writeFile(wb, filename);
}

// Hour/minute in TZ
function getHourMinuteTZ() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hh = Number(parts.find(p=>p.type==='hour').value);
  const mm = Number(parts.find(p=>p.type==='minute').value);
  return { hh, mm };
}

// ---------------- Routes ----------------
app.get('/', (req,res)=>{
  res.send(`<h3>💧 Zalo Task Bot (v3)</h3>
<div>GROUP_ID: ${GROUP_ID||'(none)'} —
<a href="/health">health</a> —
<a href="/files/last_webhook.json">last</a> —
<a href="/report-now">report-now</a></div>`);
});
app.get('/health', (req,res)=>res.json({ok:true, group_id:!!GROUP_ID}));
app.get('/report-now', async (req,res)=>{ await sendGroup(report(loadTasks())); res.send('OK'); });
app.get('/set-group', (req,res)=>{ const id=String(req.query.id||'').trim(); if(!id) return res.status(400).send('missing ?id'); saveGroupId(id); res.send('OK '+id); });

// ---------------- Webhook ----------------
app.post('/webhook', async (req,res)=>{
  const data = req.body || {};
  res.status(200).send('OK');
  try { fs.mkdirSync('./public',{recursive:true}); fs.writeFileSync(LAST_FILE, JSON.stringify(data,null,2)); } catch {}

  const ev     = data.event_name || '';
  const msgId  = data?.message?.msg_id || data?.msg_id || '';
  const sender = data?.sender?.id || 'unknown';
  const text0  = data?.message?.text;

  // Phát hiện group id từ nhiều trường
  const detectedGid =
    data?.recipient?.group_id ||
    data?.message?.conversation_id ||
    data?.conversation?.id ||
    data?.message?.group_id ||
    '';

  // Lưu GROUP_ID nếu chưa có
  if(detectedGid && !GROUP_ID) saveGroupId(detectedGid);

  // Bắt group chắc chắn
  const evLower = String(ev || '').toLowerCase();
  const looksGroup =
    !!detectedGid ||
    !!data?.recipient?.group_id ||
    !!data?.message?.conversation_id ||
    !!data?.message?.group_id ||
    !!data?.conversation?.id;
  const isGroupEvent =
    /group/.test(evLower) ||
    /user_send_group_text/.test(evLower) ||
    /oa_send_to_group/.test(evLower);
  const inGroup = looksGroup || isGroupEvent;

  console.log('📩 webhook', { ev, sender, msgId, detectedGid, inGroup, text: text0 });

  if(isDup(msgId)) return; remember(msgId);
  if(typeof text0!=='string') return;
  const text = clean(text0);
  if(!text) return;

  // Cache message để có thể JIT tạo task khi reply "ok"
  if(inGroup && msgId){
    const msgs = loadMsgs();
    msgs.unshift({ msg_id: msgId, text, sender, timestamp: Date.now() });
    saveMsgs(msgs);
  }

  if(!allow(sender)){ await sendGroup('⛔ Bạn không có quyền dùng lệnh này.'); return; }

  // ----- Commands -----
  if(/^\/groupid$/i.test(text)){ await sendGroup(GROUP_ID?`GROUP_ID: ${GROUP_ID}`:'Chưa có GROUP_ID.'); return; }

  // REPORT/EXPORT với khoảng thời gian
  if (/^\/(report|bc)\b/i.test(text) || /^\/export\b/i.test(text)) {
    const parts = text.split(/\s+/).slice(1);
    const cmd = text.toLowerCase().startsWith('/export') ? 'export' : 'report';
    const range = parseRange(parts);

    const tasks = loadTasks();
    const filtered = range ? filterByRange(tasks, range) : tasks;

    if (cmd === 'report') {
      const header = range
        ? `📅 Báo cáo (${range.target === 'doneAt' ? 'hoàn thành' : 'tạo'}) từ ${fmt(range.from)} đến ${fmt(range.to)}\n\n`
        : '';
      const done = filtered.filter(x=>x.done);
      const pend = filtered.filter(x=>!x.done);
      const msg =
        header +
        '✅ ĐÃ HOÀN THÀNH:\n' + (done.length?done.map(render).join('\n'):'• Không có') + '\n\n' +
        '⚠️ CHƯA HOÀN THÀNH:\n' + (pend.length?pend.map(render).join('\n'):'• Không có');
      await sendGroup(msg);
      return;
    }

    if (cmd === 'export') {
      const stamp = new Date();
      const name = range
        ? `report_${range.target === 'doneAt' ? 'done' : 'created'}_${stamp.getFullYear()}${String(stamp.getMonth()+1).padStart(2,'0')}${String(stamp.getDate()).padStart(2,'0')}_${String(stamp.getHours()).padStart(2,'0')}${String(stamp.getMinutes()).padStart(2,'0')}.xlsx`
        : `report_${stamp.getFullYear()}${String(stamp.getMonth()+1).padStart(2,'0')}${String(stamp.getDate()).padStart(2,'0')}_${String(stamp.getHours()).padStart(2,'0')}${String(stamp.getMinutes()).padStart(2,'0')}.xlsx`;
      const filePath = path.join('public/exports', name);
      exportExcel(filtered, filePath);

      // sinh link tải ổn định
      const base = PUBLIC_BASE_URL || `https://${process.env.RENDER_EXTERNAL_URL || req?.headers?.host || 'localhost:'+PORT}`.replace(/\/+$/,'');
      const url  = `${base}/files/exports/${encodeURIComponent(name)}`;
      await sendGroup(`📦 Đã tạo file: ${url}`);
      return;
    }
  }

  // alias báo cáo ngắn
  if (isReportCmd(text)) { await sendGroup(report(loadTasks())); return; }

  if(/^\/list$/i.test(text)){
    const tasks = loadTasks();
    if(!tasks.length){ await sendGroup('📭 Không có việc.'); return; }
    await sendGroup('📋 Danh sách:\n'+tasks.slice(-20).map(render).join('\n')); return;
  }

  // /done hoặc /done <id>
  if(/^\/done(\s+\d+)?$/i.test(text)){
    const tasks = loadTasks();
    const m = text.match(/\/done\s+(\d+)/i);
    if(m){
      const id = Number(m[1]);
      const t = tasks.find(x=>x.id===id);
      if(!t) { if(!DONE_SILENT) await sendGroup(`⚠️ Không thấy task #${id}`); return; }
      t.done=true; t.doneAt=new Date().toISOString(); saveTasks(tasks);
      if(!DONE_SILENT) await sendGroup(`✅ Đã hoàn thành: ${render(t)}`);
      return;
    }
    for(let i=tasks.length-1;i>=0;i--){
      if(!tasks[i].done){ tasks[i].done=true; tasks[i].doneAt=new Date().toISOString(); saveTasks(tasks);
        if(!DONE_SILENT) await sendGroup(`✅ Đã hoàn thành: ${render(tasks[i])}`); return; }
    }
    if(!DONE_SILENT) await sendGroup('⚠️ Không có việc nào để đánh dấu xong.');
    return;
  }

  // Nhắn "ok/đã xử lý/..." với quote để đánh dấu hoàn thành
  if(DONE_REGEX.test(text)){
    const tasks = loadTasks();
    const {quoteId, quoteText, quoteSender} = getQuoteInfo(data);
    let t = null;

    if(quoteId){
      t = tasks.find(x=>!x.done && x.src_msg_id === quoteId);
    }
    if(!t && quoteText){
      const qn = norm(quoteText);
      t = tasks.find(x => {
        if(x.done) return false;
        const tn = norm(x.message);
        return (tn===qn) || tn.includes(qn) || qn.includes(tn);
      });
    }
    if(!t && quoteId){
      const rec = loadMsgs().find(m=>m.msg_id===quoteId);
      if(rec && rec.text){
        t = {
          id: nextTaskId(tasks),
          sender: rec.sender || sender,
          owner: '',
          message: clean(rec.text),
          dueAt: null,
          createdAt: new Date().toISOString(),
          done: false,
          doneAt: null,
          src_msg_id: quoteId,
          src_sender: rec.sender || sender
        };
        tasks.push(t);
      }
    }
    if(!t && quoteText){
      t = {
        id: nextTaskId(tasks),
        sender: quoteSender || sender,
        owner: '',
        message: clean(quoteText),
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        src_msg_id: quoteId || '',
        src_sender: quoteSender || sender
      };
      tasks.push(t);
    }

    if(t){
      t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
      if(!DONE_SILENT) await sendGroup(`✅ Đã hoàn thành: ${render(t)}`);
      return;
    }

    for(let i=tasks.length-1;i>=0;i--){
      if(!tasks[i].done){ tasks[i].done=true; t=tasks[i]; t.doneAt=new Date().toISOString(); saveTasks(tasks);
        if(!DONE_SILENT) await sendGroup(`✅ Đã hoàn thành: ${render(t)}`); return; }
    }
    if(!DONE_SILENT) await sendGroup('⚠️ Không có việc nào để đánh dấu xong.');
    return;
  }

  // --------- AUTO_TODO: ghi nhận công việc (im lặng) ---------
  if (AUTO_TODO && inGroup && !text.startsWith('/')) {
    const content = clean(text);
    if (content.length >= 1 && content.length <= 500) {
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
        src_msg_id: msgId || '',
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      console.log('📝 AUTO_TODO captured:', { id: t.id, message: t.message });

      if (AUTO_TODO_CONFIRM) {
        await sendGroup(`📝 Đã ghi nhận việc: ${render(t)}`);
      }
    } else {
      console.log('ℹ️ AUTO_TODO skipped (length):', content.length);
    }
  }
});

// ---------------- Daily report (17:00 theo TZ) ----------------
let lastTick = '';
setInterval(async ()=>{
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hh = Number(parts.find(p=>p.type==='hour').value);
  const mm = Number(parts.find(p=>p.type==='minute').value);
  const key = `${hh}:${mm}`;
  if (hh === DAILY_H && mm === DAILY_M && key !== lastTick) {
    lastTick = key;
    await sendGroup(report(loadTasks()));
  }
}, 60 * 1000);

// ---------------- Start ----------------
app.listen(PORT, ()=>{
  console.log(`🚀 Server on :${PORT}`);
  if(!ACCESS_TOKEN) console.log('⚠️ Missing ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN');
});
