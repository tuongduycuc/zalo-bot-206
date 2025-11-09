// index.js — Zalo OA Task Bot (v3) — full file
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '';
let GROUP_ID = process.env.GROUP_ID || '';
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

const ONLY_ADMINS = String(process.env.ONLY_ADMINS || 'false').toLowerCase() === 'true';
const ADMIN_UIDS  = (process.env.ADMIN_UIDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const AUTO_TODO   = String(process.env.AUTO_TODO || 'true').toLowerCase() === 'true';

const DONE_REGEX  = /(đã xong|da xong|\bok\b|okay|xong\b|hoàn thành|hoan thanh|đã xử lý|da xu ly)/i;

const API_V3 = 'https://openapi.zalo.me/v3.0';

const TASK_FILE  = './tasks.json';
const GROUP_FILE = './group.json';
const LAST_FILE  = './public/last_webhook.json';
const MSG_FILE   = './msgs.json';

app.use(bodyParser.json());

// ---------- utils ----------
function safeRead(path, fallback) {
  try { return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : fallback; }
  catch { return fallback; }
}
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

// === Alias lệnh báo cáo (mới) ===
function isReportCmd(s) {
  const t = norm(s);
  return (
    /^\/report$/i.test(s) ||
    /^\/bc$/i.test(s) ||
    t === 'bc' ||
    t === 'bao cao' ||
    t === 'baocao' ||
    t === 'bao-cao'
  );
}

function loadTasks(){ return safeRead(TASK_FILE, []); }
function saveTasks(t){ fs.writeFileSync(TASK_FILE, JSON.stringify(t,null,2)); }
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
  fs.writeFileSync(MSG_FILE, JSON.stringify(msgs.slice(0,500),null,2));
}

function loadGroupId(){
  try{ if(!fs.existsSync(GROUP_FILE)) return ''; return JSON.parse(fs.readFileSync(GROUP_FILE,'utf8')).group_id||''; }
  catch{ return ''; }
}
function saveGroupId(id){
  GROUP_ID=id; fs.writeFileSync(GROUP_FILE, JSON.stringify({group_id:id},null,2));
  console.log('🔐 GROUP_ID saved:', id);
}
if(!GROUP_ID) GROUP_ID = loadGroupId();

const seen = new Map();
function remember(id){ const now=Date.now(); if(id) {seen.set(id,now); for(const[k,v] of seen){ if(now-v>10*60*1000) seen.delete(k);} } }
function isDup(id){ return id && seen.has(id); }

const isAdmin = uid => ADMIN_UIDS.includes(String(uid));
const allow   = uid => !ONLY_ADMINS || isAdmin(uid);

// ---------- extract quote ----------
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

// ---------- send ----------
async function sendGroup(text){
  if(!GROUP_ID){ console.log('⚠️ No GROUP_ID'); return; }
  if(!ACCESS_TOKEN){ console.log('⚠️ No ACCESS_TOKEN'); return; }
  try{
    const r = await axios.post(`${API_V3}/oa/group/message`,
      {recipient:{group_id:GROUP_ID}, message:{text:String(text)}},
      { headers:{
          'Content-Type':'application/json',
          access_token: ACCESS_TOKEN,
          Authorization:`Bearer ${ACCESS_TOKEN}` },
        validateStatus:()=>true, timeout:10000 }
    );
    console.log('📨 v3 group/message:', r.status, r.data);
  }catch(e){ console.error('❌ group/message:', e.response?.data||e.message); }
}

// ---------- routes ----------
app.get('/', (req,res)=>{
  res.send(`<h3>💧 Zalo Task Bot (v3)</h3>
   <div>GROUP_ID: ${GROUP_ID||'(none)'} —
    <a href="/health">health</a> — <a href="/debug/last">last</a> — <a href="/report-now">report-now</a></div>`);
});
app.get('/health', (req,res)=>res.json({ok:true, group_id:!!GROUP_ID}));
app.get('/debug/last', (req,res)=>{ try{res.type('json').send(fs.readFileSync(LAST_FILE,'utf8'))}catch{res.status(404).send('no payload')}});
app.get('/set-group', (req,res)=>{ const id=String(req.query.id||'').trim(); if(!id) return res.status(400).send('missing ?id'); saveGroupId(id); res.send('OK '+id); });
app.get('/report-now', async (req,res)=>{ await sendGroup(report(loadTasks())); res.send('OK'); });

// ---------- webhook ----------
app.post('/webhook', async (req,res)=>{
  const data = req.body || {};
  res.status(200).send('OK');
  try{ fs.mkdirSync('./public',{recursive:true}); fs.writeFileSync(LAST_FILE, JSON.stringify(data,null,2)); }catch{}

  const ev     = data.event_name || '';
  const msgId  = data?.message?.msg_id || data?.msg_id || '';
  const sender = data?.sender?.id || 'unknown';
  const text0  = data?.message?.text;

  const detectedGid = data?.recipient?.group_id || data?.message?.conversation_id || data?.conversation?.id || '';
  if(detectedGid && !GROUP_ID) saveGroupId(detectedGid);

  const inGroup =
    !!(data?.recipient?.group_id ||
       data?.message?.conversation_id ||
       data?.conversation?.id ||
       (data?.recipient?.id && GROUP_ID && data.recipient.id===GROUP_ID)) ||
    /group/.test(ev);

  console.log('📩 webhook', { ev, sender, msgId, detectedGid, inGroup, text: text0 });

  if(isDup(msgId)) return; remember(msgId);
  if(typeof text0!=='string') return;
  const text = clean(text0);
  if(!text) return;

  // cache message to msgs.json
  if(inGroup && msgId){
    const msgs = loadMsgs();
    msgs.unshift({ msg_id: msgId, text, sender, timestamp: Date.now() });
    saveMsgs(msgs);
  }

  if(!allow(sender)){ await sendGroup('⛔ Bạn không có quyền dùng lệnh này.'); return; }

  // commands
  if(/^\/groupid$/i.test(text)){ await sendGroup(GROUP_ID?`GROUP_ID: ${GROUP_ID}`:'Chưa có GROUP_ID.'); return; }

  // === dùng alias báo cáo (bc, /bc, báo cáo, baocao, ...) ===
  if (isReportCmd(text)) { 
    await sendGroup(report(loadTasks())); 
    return; 
  }

  if(/^\/list$/i.test(text)){
    const tasks = loadTasks();
    if(!tasks.length){ await sendGroup('📭 Không có việc.'); return; }
    await sendGroup('📋 Danh sách:\n'+tasks.slice(-20).map(render).join('\n')); return;
  }
  if(/^\/done(\s+\d+)?$/i.test(text)){
    const tasks = loadTasks();
    const m = text.match(/\/done\s+(\d+)/i);
    if(m){
      const id = Number(m[1]);
      const t = tasks.find(x=>x.id===id);
      if(!t) { await sendGroup(`⚠️ Không thấy task #${id}`); return; }
      t.done=true; t.doneAt=new Date().toISOString(); saveTasks(tasks);
      await sendGroup(`✅ Đã hoàn thành: ${render(t)}`); return;
    }
    for(let i=tasks.length-1;i>=0;i--){
      if(!tasks[i].done){ tasks[i].done=true; tasks[i].doneAt=new Date().toISOString(); saveTasks(tasks); await sendGroup(`✅ Đã hoàn thành: ${render(tasks[i])}`); return; }
    }
    await sendGroup('⚠️ Không có việc nào để đánh dấu xong.'); return;
  }

  // handle OK
  if(DONE_REGEX.test(text)){
    const tasks = loadTasks();
    const {quoteId, quoteText, quoteSender} = getQuoteInfo(data);
    console.log('🔎 DONE check', {quoteId, quoteText, quoteSender});

    let t = null;

    // 1) match by src_msg_id
    if(quoteId){
      t = tasks.find(x=>!x.done && x.src_msg_id === quoteId);
      console.log('  ➜ match by msg_id:', !!t);
    }

    // 2) match by normalized text
    if(!t && quoteText){
      const qn = norm(quoteText);
      t = tasks.find(x => {
        if(x.done) return false;
        const tn = norm(x.message);
        return (tn===qn) || tn.includes(qn) || qn.includes(tn);
      });
      console.log('  ➜ match by text:', !!t);
    }

    // 3) JIT from cache if still not found
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
        console.log('  ➜ created JIT task from cache');
      }
    }

    // 4) JIT from provided quoteText
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
      console.log('  ➜ created JIT task from quoteText');
    }

    if(t){
      t.done = true; t.doneAt = new Date().toISOString(); saveTasks(tasks);
      await sendGroup(`✅ Đã hoàn thành: ${render(t)}`); return;
    }

    // 5) fallback: close newest not-done
    for(let i=tasks.length-1;i>=0;i--){
      if(!tasks[i].done){ tasks[i].done=true; tasks[i].doneAt=new Date().toISOString(); saveTasks(tasks); await sendGroup(`✅ Đã hoàn thành: ${render(tasks[i])}`); return; }
    }
    await sendGroup('⚠️ Không có việc nào để đánh dấu xong.');
    return;
  }

  // Auto create task from normal message
  if(AUTO_TODO && inGroup && !text.startsWith('/')){
    if(text.length>=2 && text.length<=400){
      const tasks = loadTasks();
      const t = {
        id: nextTaskId(tasks),
        sender,
        owner: '',
        message: text,
        dueAt: null,
        createdAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        src_msg_id: msgId,
        src_sender: sender
      };
      tasks.push(t); saveTasks(tasks);
      await sendGroup(`📝 Đã ghi nhận việc: ${render(t)}`);
    }
  }
});

// ---------- start ----------
app.listen(PORT, ()=>{
  console.log(`🚀 Server on :${PORT}`);
  if(!ACCESS_TOKEN) console.log('⚠️ Missing ZALO_OA_ACCESS_TOKEN/ACCESS_TOKEN');
});
