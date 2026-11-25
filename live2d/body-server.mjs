// 大肥鱼的身体：本机渲染服务
//   静态文件：/vendor/*（渲染库）、/model/*（Live2D 模型资源，直接读原目录）
//   控制接口：POST /cmd（她那边调用它来动这具身体）、GET /state
//   WebSocket：/ws（页面连上来，服务端把命令转发过去）
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 页面代码的版本（build）───────────────────────────────────────────────
// 这个服务换 body.js 是不重启的（静态文件），但**已经开着的页面还在跑老脚本**：
// 新姿态不认、新词表没有、心跳里的 poses 只有 33 个 —— 而她在那边看到的是「没这个姿态」。
// 以前每次改完都要等人手动刷新一次。现在服务端自己盯着 body.js：文件一变，
// 就按 WebSocket 让所有开着的页面自己重载（重载后 G4 会把姿态/词表/道具补回来）。
function buildOf(file) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  } catch { return ''; }
}
const BODY_FILE = path.join(HERE, 'body.js');
let BUILD = buildOf(BODY_FILE);
let buildStat = null;
function refreshBuild() {
  let st = null;
  try { st = fs.statSync(BODY_FILE); } catch { return BUILD; }
  if (buildStat && st.mtimeMs === buildStat.mtimeMs && st.size === buildStat.size) return BUILD;
  buildStat = st;
  const next = buildOf(BODY_FILE);
  if (next && next !== BUILD) {
    const old = BUILD;
    BUILD = next;
    if (clients.size) {
      console.log(`[body] 页面代码变了 ${String(old).slice(0, 8)} → ${next.slice(0, 8)}，让 ${clients.size} 个页面自己重载`);
      send({ type: 'reload' });
    } else {
      console.log(`[body] 页面代码变了 ${String(old).slice(0, 8)} → ${next.slice(0, 8)}（当前没页面开着）`);
    }
  }
  return BUILD;
}
// 模型目录：① 环境变量 ② 仓库里那套公皮 ③ live2d/model。
// 之前只认 ②/③ 里的一个，手工起服务时没带环境变量就会静默指向不存在的目录，
// 页面报「模型加载失败：Network error」，而服务本身一切正常——很难查。
function findModelDir() {
  const env = process.env.LIVE2D_MODEL_DIR;
  if (env) return env;
  const guesses = [
    path.join(HERE, '..', 'DeepSeek免费公皮', 'DeepSeek免费公皮', 'DeepSeek'),
    path.join(HERE, 'model'),
  ];
  for (const g of guesses) {
    try {
      if (fs.readdirSync(g).some((n) => n.toLowerCase().endsWith('.model3.json'))) return path.resolve(g);
    } catch { /* 目录不存在就试下一个 */ }
  }
  return path.join(HERE, 'model');
}
const MODEL_DIR = findModelDir();
const PORT = Number(process.env.BODY_PORT || process.env.LIVE2D_PORT || 17901);
// 手机上要能看，服务就得绑到 0.0.0.0 上；但绑出去就必须有钥匙。
// 本机（她自己的插件、桌面窗口）不需要钥匙，外面来的都要带 ?k=TOKEN。
const HOST = process.env.BODY_HOST || '127.0.0.1';
const TOKEN = process.env.BODY_TOKEN || '';
// 手机页面上打的字要进她的大脑：先落到同机 qq-agent 的 /api/inbox，
// 由它当成一条「用户发来的 QQ 消息」处理。这里只负责把令牌和目标会话带上。
const AGENT = process.env.BODY_AGENT || 'http://127.0.0.1:3210';
const AGENT_CONFIG = process.env.BODY_AGENT_CONFIG || '/var/lib/qqagent/config.json';
let agentToken = '';
let agentTokenAt = 0;

function readAgentToken() {
  if (Date.now() - agentTokenAt < 60000) return agentToken;
  try {
    const cfg = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8'));
    agentToken = String(cfg?.server?.token || '');
  } catch { agentToken = ''; }
  agentTokenAt = Date.now();
  return agentToken;
}

function chatTarget() {
  // 默认私聊她自己（她主人的 QQ）；可用 chat.json 覆盖
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, 'chat.json'), 'utf8'));
    if (j && j.id) return { kind: j.kind === 'group' ? 'group' : 'private', id: String(j.id) };
  } catch { /* ignore */ }
  return { kind: process.env.BODY_CHAT_KIND === 'group' ? 'group' : 'private', id: String(process.env.BODY_CHAT_ID || '') };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream'
};

const clients = new Set();
// 自拍请求：页面收到 {type:'selfie'} 后把 PNG dataUrl 从 WS 回传，这里按 id 等它
const pendingSelfies = new Map();
const SELFIE_DIR = process.env.BODY_SELFIE_DIR || path.join(os.tmpdir(), 'qqagent-selfie');
// 出声：说话模型就在这台机器上（local-hand/tts_server.py :17903）。
// 云端只决定「这句要不要念」，合成和播放都在本地，音频不出网、不走隧道。
const TTS_URL = process.env.BODY_TTS || 'http://127.0.0.1:17903';
const TTS_CACHE = process.env.BODY_TTS_CACHE || path.join(HERE, '..', 'local-hand', 'out', 'tts-cache');
const TTS_TIMEOUT = Math.max(5000, Number(process.env.BODY_TTS_TIMEOUT) || 30000);
// 她「现在长什么样」的完整记录。刷新/重连回来照着这个重放：
// 以前只存 pose/expression/motion/text，且页面按固定秒数猜，所以「她自己摆好的样子」刷新一次就没了。
// until：0 = 常驻，>0 = 到期自己退掉，undefined = 老命令没记过（不重放）。
let lastState = { expression: '', expressionUntil: 0, motion: '', motionAt: 0, text: '', word: '', wordUntil: 0, pose: '', poseUntil: 0, switches: {}, emotion: null, at: 0 };
let lastHb = null;
let lastTouch = null;   // 她最近一次被摸：{ zone, name, at }
let lastDiag = null;    // 页面 ?bench=1 的闪烁自检结果
let lastBounds = null;
const history = [];

// ---- 现场（scene）：姿态/表情/道具/大小/情绪 ----
// 以前这些只活在前端内存里，页面一刷新或服务一重启就全没了，
// 而鱼那边记得还挂着——于是「她说盆摘不掉、我这边什么都没有」。
// 现在服务端记一份，页面连上来时先把它放回去。
const SCENE_FILE = process.env.BODY_SCENE || path.join(HERE, 'scene.json');
function emptyScene() {
  return { pose: { name: '', holdMs: 0 }, expression: { name: '', holdMs: 0 }, switches: {}, scale: 1, emotion: { v: 0, a: 0, d: 0, holdMs: 0 }, modelExpr: '', word: '' };
}
function loadScene() {
  try {
    const j = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
    const base = emptyScene();
    return {
      pose: { name: String(j?.pose?.name || ''), holdMs: Number(j?.pose?.holdMs || 0) },
      expression: { name: String(j?.expression?.name || ''), holdMs: Number(j?.expression?.holdMs || 0) },
      switches: (j && typeof j.switches === 'object' && j.switches) || {},
      scale: Number(j?.scale || 1) || 1,
      emotion: { v: Number(j?.emotion?.v || 0), a: Number(j?.emotion?.a || 0), d: Number(j?.emotion?.d || 0), holdMs: Number(j?.emotion?.holdMs || 0) },
      modelExpr: String(j?.modelExpr || ''),
      word: String(j?.word || '')
    };
  } catch { return emptyScene(); }
}
let scene = loadScene();
let sceneTimer = null;

// ---- 手感（物理阻尼）：裙摆/头发/胸部… 的跟手与拖尾，以及静止/动作幅度 ----
// 这些是「看起来像不像贴图」的关键参数，做成页面上的滑条，改完存这里，
// 页面刷新 / 手机重连 / 服务重启都还认这套手感。
const PHYS_FILE = process.env.BODY_PHYS || path.join(HERE, 'phys.json');
const PHYS_DEFAULT = {
  skirt: { m: 1.12, d: 0.92 }, hair: { m: 1.12, d: 0.92 }, chest: { m: 1.12, d: 0.92 },
  ribbon: { m: 1.12, d: 0.92 }, sleeve: { m: 1.12, d: 0.92 }, tail: { m: 1.05, d: 0.95 },
  idle: 0.42, swing: 1
};
const PHYS_CATS = ['skirt', 'hair', 'chest', 'ribbon', 'sleeve', 'tail'];
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function normPhysCfg(raw) {
  const out = JSON.parse(JSON.stringify(PHYS_DEFAULT));
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PHYS_CATS) {
    const v = raw[k];
    if (v && typeof v === 'object') {
      out[k] = { m: clampNum(v.m, 0.2, 3, out[k].m), d: clampNum(v.d, 0.1, 3, out[k].d) };
    }
  }
  out.idle = clampNum(raw.idle, 0, 2.5, out.idle);
  out.swing = clampNum(raw.swing, 0, 2.5, out.swing);
  return out;
}
function loadPhys() {
  try { return normPhysCfg(JSON.parse(fs.readFileSync(PHYS_FILE, 'utf8'))); } catch { return normPhysCfg(null); }
}
let physCfg = loadPhys();
let physTimer = null;
function savePhys() {
  if (physTimer) return;
  physTimer = setTimeout(() => {
    physTimer = null;
    try { fs.writeFileSync(PHYS_FILE, JSON.stringify(physCfg, null, 2)); } catch (e) { log('phys 写不进去：' + (e && e.message)); }
  }, 250);
}
function saveScene() {
  if (sceneTimer) return;
  sceneTimer = setTimeout(() => {
    sceneTimer = null;
    try { fs.writeFileSync(SCENE_FILE, JSON.stringify(scene, null, 2)); } catch (e) { log('scene 写不进去：' + (e && e.message)); }
  }, 250);
}
function applyToScene(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;
  const hold = Number(cmd.holdMs || 0) || 0;
  if (cmd.type === 'pose') scene.pose = { name: String(cmd.name || ''), holdMs: hold };
  else if (cmd.type === 'expression') scene.expression = { name: String(cmd.name || ''), holdMs: hold };
  else if (cmd.type === 'switch') {
    const swName = String(cmd.name || '');
    scene.switches[swName] = cmd.on !== false;
    // 关掉一个「其实是 exp3」的道具（圈圈眼/爱心眼/黑脸…）时，现场里那条持久动画也得一起清，
    // 否则下次刷新/重连会被 scene 原样恢复回来 —— 她嘴上说摘了、眼睛还是圈圈。
    if (cmd.on === false && String(scene.modelExpr || '') === swName) scene.modelExpr = '';
  }
  else if (cmd.type === 'scale') scene.scale = Number(cmd.value || 1) || 1;
  else if (cmd.type === 'word' || cmd.type === 'phrase') scene.word = String(cmd.text || cmd.name || '');
  else if (cmd.type === 'emotion') scene.emotion = { v: Number(cmd.v || 0), a: Number(cmd.a || 0), d: Number(cmd.d || 0), holdMs: hold };
  else if (cmd.type === 'modelexpr') {
    const nm = String(cmd.name || '');
    const off = !nm || ['关掉', '关', '取消', '无', '默认', '复位', '摘掉', '收起', '去掉', '清掉'].includes(nm);
    scene.modelExpr = off ? '' : nm;
  }
  else if (cmd.type === 'reset') { scene = emptyScene(); try { fs.unlinkSync(SCENE_FILE); } catch { /* ignore */ } return; }
  else return;
  saveScene();
}

function send(payload, only) {
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    // only=<组>：只发给同一组的连接（试播台那种「只在这一块画布里试」，不去动别的鱼）
    if (only && ws.group !== only) continue;
    ws.send(raw);
  }
}

// ---- 鍘嗗彶浼氳瘽锛氳濂硅嚜宸辩殑绉佽亰瀛樻。锛堟枃浠舵病鍙樺氨涓嶉噸澶嶈В鏋愶級----
// ---- 心情：读 heart 插件的账本（页面顶栏与抽屉用）----
const MOOD_FILE = process.env.BODY_MOOD || '/var/lib/qqagent/heart/mood.json';
const EMO_KEYS = ['joy', 'steady', 'sweet', 'worry', 'anxious', 'sad', 'jealous', 'desire'];
function moodLabelOf(v) {
  if (v < 35) return '低沉';
  if (v < 50) return '有点闷';
  if (v < 65) return '一般';
  if (v < 80) return '还不错';
  return '挺好';
}
function readMood() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8')); } catch { return null; }
  const m = j?.moodV2 || {};
  const value = Number(m.value ?? j?.baseline?.value ?? 70);
  const emo = {};
  for (const k of EMO_KEYS) emo[k] = Number(m.emo?.[k] || 0);
  const changes = (Array.isArray(m.timeline) ? m.timeline : []).slice(-10).reverse().map((x) => ({
    at: Number(x.at) || 0,
    d: Number(x.d) || 0,
    // 这一次是哪几根情绪动了、各动了多少（面板上直接显示「心疼 +0.3」）
    emo: x.emo && typeof x.emo === 'object' ? x.emo : {},
    reason: String(x.reason || ''),
    src: String(x.src || '')
  }));
  return { value, label: moodLabelOf(value), emo, changes, at: Number(m.at) || 0 };
}

// 聊天记录文件：只给网页的「对话记录」抽屉用；设成空串就整块功能关掉。
const HISTORY_FILE = process.env.BODY_HISTORY
  || '';
let _histCache = { mtime: 0, rows: [] };

function readHistory(limit) {
  let st;
  try { st = fs.statSync(HISTORY_FILE); } catch { return []; }
  if (st.mtimeMs !== _histCache.mtime) {
    let arr = [];
    try {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      const j = JSON.parse(raw);
      arr = Array.isArray(j) ? j : (j.messages || []);
    } catch { arr = []; }
    _histCache = {
      mtime: st.mtimeMs,
      rows: arr.map((m) => ({
        who: m.self ? 'her' : 'me',
        text: String(m.text || m.raw_message || '').slice(0, 500),
        // 消息时间字段是 ts（毫秒），老代码读 time/at 才会一直是 0
        at: Number(m.ts || m.time || m.at || 0),
        name: String(m.name || m.senderName || m.sender?.nickname || ''),
        // idle / wants 这类主动引擎发出去的话，mid 是 idle-<ts>
        proactive: /^idle-/.test(String(m.mid || ''))
      })).filter((m) => m.text)
    };
  }
  return _histCache.rows.slice(-limit);
}

function isLocal(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function cookieToken(req) {
  const c = String(req.headers.cookie || '');
  const m = c.match(/(?:^|;\s*)bodyk=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function tokenOk(req, url) {
  if (!TOKEN) return true;
  if (isLocal(req)) return true;
  const k = url?.searchParams?.get('k') || req.headers['x-body-token'] || cookieToken(req) || '';
  return String(k) === TOKEN;
}

function deny(res) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('need token');
}

// 首页要带一个「脚本版本号」：Electron 的磁盘缓存有时候连 no-store 都不理，
// 页面刷新后照旧跑旧 body.js（表现为：改了代码、心跳里的 bld 不动）。
// 每次请求首页时把 body.js 的 mtime 拼进去，URL 一变缓存自然失效。
function serveIndex(res) {
  const file = path.join(HERE, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found: index.html');
      return;
    }
    let stamp = '0';
    try { stamp = String(fs.statSync(path.join(HERE, 'body.js')).mtimeMs | 0); } catch (e) { /* 没文件就算了 */ }
    const html = data.toString('utf8').replace('src="/body.js"', `src="/body.js?v=${stamp}"`);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html)
    });
    res.end(html);
  });
}

function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + path.basename(file));
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.moc3' || ext === '.png' ? 'public, max-age=604800' : 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);
  // 一行一条访问日志：谁、要了什么、给了多少（排查手机连不上时靠它）
  const _ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const _ua = String(req.headers['user-agent'] || '-').slice(0, 48);
  res.on('finish', () => {
    if (p === '/hb' || p === '/state') return; // 心跳太吵，不记
    console.log(`[req] ${_ip} ${req.method} ${p} ${res.statusCode} ${res.getHeader('content-length') || '-'} ua="${_ua}"`);
  });

  if (!tokenOk(req, url)) return deny(res);

  // 页面第一次拿 ?k= 进来时发一张 30 天通行证：之后 vendor/模型/WebSocket 都不必再带参数
  if (TOKEN && !isLocal(req) && url.searchParams.get('k') === TOKEN && !cookieToken(req)) {
    res.setHeader('set-cookie', `bodyk=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=2592000; SameSite=Lax`);
  }

  // 控制面只对本机开放：她自己的插件跑在同一台机器上，用不到外网。
  // 但试播台是从浏览器（别的机器）打开的，得让它能摆姿态、放动作、触发脊髓——
  // 所以带钥匙（cookie / ?k= / x-body-token）的远端请求放行「演出类」命令，
  // 出声、自拍、改配置这些非演出类的仍然只对本机开放（在 /cmd 里按类型再拦一次）。
  const PLAY_TYPES = new Set([
    'pose', 'word', 'phrase', 'face', 'expression', 'emotion', 'switch', 'modelexpr',
    'motion', 'say', 'reset', 'freeze', 'slow', 'param', 'scale', 'anim', 'stopanim',
    'feel', 'spinal', 'autonomy',
  ]);
  if ((p === '/cmd' || p === '/bounds') && !isLocal(req)) {
    const k = url?.searchParams?.get('k') || req.headers['x-body-token'] || cookieToken(req) || '';
    if (!(p === '/cmd' && TOKEN && String(k) === TOKEN)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '控制面只对本机开放' }));
    }
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveIndex(res);
  }
  // 试播台：左边是身体本身（iframe），右边是按钮和滑杆。只在本机能改东西（/cmd 只对本机开放）。
  if (req.method === 'GET' && (p === '/playground' || p === '/playground.html')) {
    return serveFile(res, path.join(HERE, 'playground.html'));
  }
  if (req.method === 'GET' && p === '/body.js') {
    return serveFile(res, path.join(HERE, 'body.js'));
  }
  if (req.method === 'GET' && p === '/lexicon.json') {
    return serveFile(res, path.join(HERE, 'lexicon.json'));
  }
  if (req.method === 'GET' && p === '/vocab.json') {
    return serveFile(res, path.join(HERE, 'vocab.json'));
  }
  if (req.method === 'GET' && p.startsWith('/tts/')) {
    // 只认缓存文件名本身（16 位十六进制 + .wav），挡掉 ../ 这类路径穿越。
    // 声音必须从「页面自己这个源」取：跨到 :17903 去拿，WebAudio 会因跨源而拿不到波形，
    // 嘴就只能继续假装在动。
    const name = p.slice('/tts/'.length);
    if (!/^[0-9a-f]{16}\.wav$/.test(name)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('bad name');
    }
    return serveFile(res, path.join(TTS_CACHE, name));
  }
  if (req.method === 'GET' && p.startsWith('/vendor/')) {
    const rel = p.slice('/vendor/'.length);
    const file = path.join(HERE, 'vendor', rel);
    if (!file.startsWith(path.join(HERE, 'vendor'))) { res.writeHead(400); return res.end('bad path'); }
    return serveFile(res, file);
  }
  if (req.method === 'GET' && p === '/model-file') {
    // 页面用它决定加载哪个 model3.json：环境变量优先，否则扫模型目录里的第一个
    let file = process.env.LIVE2D_MODEL_FILE || '';
    if (!file) {
      try {
        const hit = fs.readdirSync(MODEL_DIR).find((n) => n.toLowerCase().endsWith('.model3.json'));
        if (hit) file = hit;
      } catch { /* 目录不存在就当没有 */ }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: !!file, file, dir: MODEL_DIR }));
  }
  if (req.method === 'GET' && p.startsWith('/model/')) {
    const rel = p.slice('/model/'.length);
    const base = path.resolve(MODEL_DIR);
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('bad path');
    }
    return serveFile(res, file);
  }
  if (req.method === 'GET' && p === '/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, clients: clients.size, build: refreshBuild(), lastState, lastHb, lastTouch, lastBounds, lastDiag, last: history.slice(-8) }));
  }
  // 闪烁自检结果（页面 ?bench=1 跑完自己 POST 上来，方便我在服务端读，不用截图）
  if (req.method === 'POST' && p === '/diag') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        lastDiag = { ...j, receivedAt: Date.now() };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  // 手感面板：读取 / 保存物理阻尼设置
  if (req.method === 'GET' && p === '/phys') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, cfg: physCfg, cats: PHYS_CATS }));
    return;
  }
  if (req.method === 'POST' && p === '/phys') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        physCfg = normPhysCfg({ ...physCfg, ...(j.cfg || j) });
        savePhys();
        const msg = JSON.stringify({ type: 'phys', cfg: physCfg });
        for (const ws of clients) { try { ws.send(msg); } catch { /* ignore */ } }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, cfg: physCfg, clients: clients.size }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  // 主进程把窗口在屏幕上的真实位置发过来 —— 截图裁切要用，从外面猜 GetWindowRect 会被 DPI 骗
  if (req.method === 'POST' && p === '/bounds') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try { lastBounds = { ...JSON.parse(body || '{}'), at: Date.now() }; } catch { /* ignore */ }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  // 她被人摸了一下：页面 POST 过来，/state 里带出去，云端那层拼成一句话进提示词
  if (req.method === 'POST' && p === '/touch') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const zone = String(j.zone || '').slice(0, 16);
        if (zone) lastTouch = { zone, name: String(j.name || '').slice(0, 16), at: Number(j.at) || Date.now() };
        lastState.touch = lastTouch;
      } catch { /* ignore */ }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.method === 'POST' && p === '/hb') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      try { lastHb = { ...JSON.parse(body || '{}'), at: Date.now() }; } catch { /* ignore */ }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  // 手机页面上打的字：转给她的大脑，当成一条她收到的 QQ 消息
  // 鎵嬫満涓婄殑銆屽巻鍙蹭細璇濄€嶏細鐩存帴璇诲ス鑷繁鐨勭鑱婂瓨妗ｏ紝鍙粰鏈€鍚?N 鏉?  // 锛堝悓涓€涓枃浠躲€佸悓涓€浠借褰?鈥斺€?椤甸潰涓婄湅鍒扮殑鍜屽埆浜哄湪 QQ 閲岀湅鍒扮殑鏄悓涓€娈靛璇濓級
  if (req.method === 'GET' && p === '/mood') {
    const m = readMood();
    res.writeHead(m ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(m || { ok: false, error: '还没有心情账本' }));
    return;
  }
  if (req.method === 'GET' && p === '/history') {
    try {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 40)));
      const rows = readHistory(limit);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, messages: rows }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  if (req.method === 'POST' && p === '/chat') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      try { text = String(JSON.parse(body || '{}').text || '').trim().slice(0, 1000); } catch { /* ignore */ }
      if (!text) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '空的' }));
      }
      const target = chatTarget();
      // 没配置聊天目标就别往上游发：上游只会回「需要 kind / id（纯数字）/ text」，
      // 而我们这边会把它包成 502，页面上看起来像「网关坏了」，其实是配置缺一行。
      if (!target.id) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: false,
          error: '没配置聊天目标：在 live2d-web/chat.json 写 {"kind":"private","id":"你的QQ号"}，或设环境变量 BODY_CHAT_ID'
        }));
      }
      try {
        const r = await fetch(`${AGENT}/api/inbox`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': readAgentToken() },
          body: JSON.stringify({ ...target, text }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await r.json().catch(() => ({}));
        res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: r.ok, agent: j }));
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
      }
    });
    return;
  }
  // 自拍：让她「看见自己」。页面把 canvas 抽成 PNG 回传，这里落盘并返回 dataUrl。
  // 为什么不让它截桌面：她要的是「我现在长什么样」，桌面截图里她只占一小块。
  if (req.method === 'GET' && p === '/selfie') {
    (async () => {
      try {
        if (!clients.size) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '没有开着的身体（窗口/网页都没连）' }));
        }
        const id = `s${Date.now()}`;
        const dataUrl = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pendingSelfies.delete(id); reject(new Error('页面 6 秒没回自拍')); }, 6000);
          pendingSelfies.set(id, { resolve, reject, timer });
          send({ type: 'selfie', id });
        });
        const b64 = String(dataUrl).replace(/^data:[^,]*,/, '');
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '页面回的不是合法 PNG', head: String(dataUrl).slice(0, 64), len: String(dataUrl).length }));
        }
        const file = path.join(SELFIE_DIR, `${id}.png`);
        try { fs.mkdirSync(SELFIE_DIR, { recursive: true }); fs.writeFileSync(file, buf); } catch (e) { /* 落盘失败也照样能返回 */ }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, bytes: buf.length, file, dataUrl: `data:image/png;base64,${b64}` }));
      } catch (e) {
        try { pendingSelfies.delete(id); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })();
    return;
  }
  if (req.method === 'POST' && p === '/param-map') {
    // M4 阶段 2：页面把 509 个参数的扫描结果（谁管哪个部位）落盘，产出 live2d/param-map.json
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4000000) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (!Array.isArray(data.rows)) throw new Error('需要 {"rows":[...]}');
        const file = path.join(HERE, 'param-map.json');
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 1));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, rows: data.rows.length, bytes: fs.statSync(file).size, file }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  // ── 时间轴编辑器存的动画：live2d/anims/<名字>.json ────────────────────────
  // GET  /anims            → 列表
  // GET  /anims/<名字>.json → 一条
  // POST /anims/delete/<名字> → 删（用 POST 是为了不让简单的爬虫／误点就删东西）
  if (req.method === 'GET' && p === '/anims') {
    try {
      const dir = path.join(HERE, 'anims');
      const list = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f.replace(/\.json$/, ''), bytes: st.size, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime)
        : [];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, list }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
    return;
  }
  // 名字白名单：字母数字下划线、中文、连字符，外加「·」——
  // 她编的动作名字习惯带中点（`待机·歪头看`），只认 \w 和中文会把这种名字挡成 400。
  if (req.method === 'GET' && p.startsWith('/anims/') && p.endsWith('.json')) {
    const name = decodeURIComponent(p.slice('/anims/'.length, -'.json'.length));
    if (!/^[\w\u4e00-\u9fa5·-]{1,40}$/.test(name)) {
      res.writeHead(400); res.end('bad name'); return;
    }
    const file = path.join(HERE, 'anims', name + '.json');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('no such anim'); return; }
    return serveFile(res, file);
  }
  if (req.method === 'POST' && p.startsWith('/anims/save')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const name = String(data.name || '').trim();
        if (!/^[\w\u4e00-\u9fa5·-]{1,40}$/.test(name)) throw new Error('名字只能是中英文数字、横线和中点，40 字以内');
        if (!Array.isArray(data.tracks) || !data.tracks.length) throw new Error('至少要有一条轨道');
        const dir = path.join(HERE, 'anims');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name + '.json');
        const payload = {
          name,
          duration: Math.max(200, Math.min(20000, Number(data.duration) || 2000)),
          loop: !!data.loop,
          tracks: data.tracks.slice(0, 60),
          at: new Date().toISOString(),
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 1));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, name, bytes: fs.statSync(file).size, file }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && p.startsWith('/anims/delete/')) {
    const name = decodeURIComponent(p.slice('/anims/delete/'.length));
    if (!/^[\w\u4e00-\u9fa5·-]{1,40}$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
    const file = path.join(HERE, 'anims', name + '.json');
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, name }));
    return;
  }
  if (req.method === 'POST' && p === '/cmd') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20000) req.destroy();
    });
    req.on('end', () => {
      let cmd = null;
      try { cmd = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (!cmd || typeof cmd.type !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '需要 {"type": "...", ...}' }));
      }
      // 远端（试播台）只许演出类命令；出声/自拍/重载这些仍然只给本机
      if (!isLocal(req) && !PLAY_TYPES.has(cmd.type)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: `远端只能做演出类动作，${cmd.type} 不行` }));
      }
      if (cmd.type === 'voice') {
        // 出声：先在本机合成，再把 wav 地址推给页面。
        // 单独走一条路，不进 lastState/history —— 声音是「此刻发生的事」，
        // 页面重连时把十分钟前那句话再放一遍会很怪（和 say 的补发问题同一个坑）。
        (async () => {
          const reply = (obj) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(obj));
          };
          const text = String(cmd.text || '').trim().slice(0, 200);
          if (!text) return reply({ ok: false, error: '没有要说的话' });
          const emotion = String(cmd.emotion || 'soft').trim() || 'soft';
          try {
            const r = await fetch(`${TTS_URL}/say_json`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text, emotion }),
              signal: AbortSignal.timeout(TTS_TIMEOUT)
            });
            const j = await r.json().catch(() => null);
            if (!j || !j.ok || !j.file) throw new Error((j && j.error) || `声音服务回了 HTTP ${r.status}`);
            const name = path.basename(String(j.file));
            if (!/^[0-9a-f]{16}\.wav$/.test(name)) throw new Error(`声音文件名不对：${name}`);
            const dur = Number(j.dur) || 0;
            const payload = { type: 'voice', at: Date.now(), text, emotion, url: `/tts/${name}`, dur, cached: j.cached === true };
            // play:false = 只合成不在这台机器上放（云端要拿去发 QQ 语音条，
            // 放出来等于同一句话在房间里和 QQ 里各响一次）。
            if (cmd.play !== false) send(payload);
            return reply({ ok: true, delivered: cmd.play === false ? 0 : clients.size, clients: clients.size, url: payload.url, dur, emotion, cached: payload.cached });
          } catch (e) {
            const msg = String((e && e.message) || e);
            log(`出声失败：${msg}`);
            const hint = /fetch failed|ECONNREFUSED|timed out|aborted/i.test(msg)
              ? '（说话服务没开？本机的 local-hand/tts_server.py 要在跑）'
              : '';
            return reply({ ok: false, error: `${msg}${hint}` });
          }
        })();
        return;
      }
      cmd.at = Date.now();
      // 记下「她现在的样子」：页面刷新/重连回来要照着这个重放，而不是空着一张脸等她下一句。
      // until 语义：0 = 常驻（她自己说的「一直保持」），>0 = 到这个时间点自己退掉。
      const holdRaw = Number(cmd.holdMs);
      const untilOf = (defMs) => (Number.isFinite(holdRaw)
        ? (holdRaw > 0 ? cmd.at + holdRaw : (holdRaw < 0 ? 0 : cmd.at + defMs))
        : cmd.at + defMs);
      // 试播台那种「只想在这一块画布里试」的命令带 only=<组>：只发给同组的客户端，
      // 别去动桌面鱼/手机那几具。也正因为是试，不写进 lastState / history——
      // 否则重连回来的那具会照着调试痕迹重放一遍。
      const only = cmd.only ? String(cmd.only) : '';
      if (!only) {
        if (cmd.type === 'expression') { lastState.expression = String(cmd.name || ''); lastState.expressionUntil = untilOf(25000); }
        if (cmd.type === 'motion') { lastState.motion = String(cmd.name || ''); lastState.motionAt = cmd.at; }
        if (cmd.type === 'say') lastState.text = String(cmd.text || '');
        if (cmd.type === 'pose') { lastState.pose = String(cmd.name || ''); lastState.poseUntil = untilOf(12000); }
        if (cmd.type === 'word' || cmd.type === 'phrase') {
          lastState.word = String(cmd.text || cmd.word || cmd.name || '');
          lastState.wordUntil = untilOf(12000);
        }
        if (cmd.type === 'switch') lastState.switches[String(cmd.name || '')] = cmd.on !== false;
        if (cmd.type === 'emotion') {
          lastState.emotion = { v: Number(cmd.v) || 0, a: Number(cmd.a) || 0, d: Number(cmd.d) || 0, at: cmd.at };
        }
        if (cmd.type === 'param') lastState.param = cmd.id ? String(cmd.id) : Object.keys(cmd.params || {}).join(',');
        if (cmd.type === 'reset') {
          // 复位之后「她现在什么都不摆」，重放就不能再把旧姿势摆回去
          lastState = { ...lastState, expression: '', expressionUntil: 0, motion: '', pose: '', poseUntil: 0, word: '', wordUntil: 0, switches: {}, emotion: null, text: '' };
        }
        lastState.at = cmd.at;
        try { applyToScene(cmd); } catch (e) { log('scene 更新失败：' + (e && e.message)); }
        // 重载/冻结/心跳这类「动作」不能进补发队列：
        // 否则页面一连上来就被 replay 的 reload 再刷一次，变成无限重载。
        if (cmd.type !== 'reload' && cmd.type !== 'ping' && cmd.type !== 'freeze') {
          history.push(cmd);
          if (history.length > 60) history.shift();
        }
      }
      send(cmd, only);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, delivered: clients.size, clients: clients.size }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  // WebSocket 也要验钥匙：手机带 ?k= 连上来，本机窗口不用
  let ok = !TOKEN || (req.socket?.remoteAddress || '').startsWith('127.') ||
    (req.headers.host || '').includes('127.0.0.1');
  if (TOKEN && !ok) {
    try {
      const q = new URL(req.url, 'http://x').searchParams.get('k');
      if (q && q === TOKEN) ok = true;
      if (!ok && cookieToken(req) === TOKEN) ok = true;
    } catch { /* ignore */ }
  }
  if (!ok) { try { ws.close(4001, 'need token'); } catch { /* ignore */ } return; }
  // 页面带 ?g=<组> 连上来就记住它属于哪一组：带 only=<组> 的命令只发给这一组
  try { ws.group = new URL(req.url, 'http://x').searchParams.get('g') || ''; } catch { ws.group = ''; }
  clients.add(ws);
  ws.aliveAt = Date.now();
  ws.on('message', (raw) => {
    ws.aliveAt = Date.now();
    // 自拍回包：把 PNG 交回正在等它的 /selfie 请求
    try {
      const m = JSON.parse(String(raw));
      if (m && m.type === 'selfie' && m.id && pendingSelfies.has(m.id)) {
        const p = pendingSelfies.get(m.id);
        pendingSelfies.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.data);
      }
    } catch { /* 心跳之类的非 JSON 忽略 */ }
  });
  ws.send(JSON.stringify({ type: 'hello', at: Date.now(), build: refreshBuild(), lastState }));
  try { ws.send(JSON.stringify({ type: 'scene', scene })); } catch { /* ignore */ }
  try { ws.send(JSON.stringify({ type: 'phys', cfg: physCfg })); } catch { /* ignore */ }
  // 以前这里会把最近 3 条命令补发一遍（「她刚说完身体才醒」），但那是把 20 分钟前的动作
  // 也一起复活：断线重连一次，她会突然再摆一次很久以前的姿势、再弹一次旧气泡。
  // 现场（scene）已经覆盖姿态/表情/道具/大小/情绪/词表，够了，所以不再补发。
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// 渲染进程崩过之后会留下半开的 socket：它们还算在 clients 里，
// 于是 /cmd 报「delivered:1」但画面根本没反应，/state 的 lastHb 也一直是旧值。
// 页面自己每 20 秒发一次 pong，超过 45 秒没动静的直接踢掉。
setInterval(() => {
  const now = Date.now();
  for (const ws of [...clients]) {
    if (now - (ws.aliveAt || 0) > 45000) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
      clients.delete(ws);
      console.log('[body] 踢掉一个假客户端（45 秒没动静）');
    }
  }
}, 15000);

// 盯着 body.js：文件一变就让开着的页面自己重载（不然它们永远在跑老脚本）
setInterval(() => { try { refreshBuild(); } catch { /* ignore */ } }, 4000);

server.listen(PORT, HOST, () => {
  const keyed = TOKEN && HOST !== '127.0.0.1' ? '（要钥匙）' : '';
  console.log(`[body] 大肥鱼的身体听在 http://${HOST}:${PORT}${keyed}（模型目录 ${MODEL_DIR}，页面 ${String(BUILD).slice(0, 8)}）`);
});
