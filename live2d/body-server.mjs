// Live2D 身体：本机渲染服务
//   静态文件：/vendor/*（渲染库）、/model/*（Live2D 模型资源，直接读原目录）
//   控制接口：POST /cmd（她那边调用它来动这具身体）、GET /state
//   WebSocket：/ws（页面连上来，服务端把命令转发过去）
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = process.env.LIVE2D_MODEL_DIR || path.join(HERE, 'model');
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
  '.moc3': 'application/octet-stream'
};

const clients = new Set();
// 自拍请求：页面收到 {type:'selfie'} 后把 PNG dataUrl 从 WS 回传，这里按 id 等它
const pendingSelfies = new Map();
const SELFIE_DIR = process.env.BODY_SELFIE_DIR || path.join(os.tmpdir(), 'qqagent-selfie');
let lastState = { expression: '', motion: '', text: '', at: 0 };
let lastHb = null;
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

function send(payload) {
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(raw);
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
const HISTORY_FILE = process.env.BODY_HISTORY || '';
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
  // 这样就算哪天钥匙漏了，外面的人最多只能「看」她，不能让她说话/摆姿势。
  if ((p === '/cmd' || p === '/bounds') && !isLocal(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '控制面只对本机开放' }));
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveIndex(res);
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
    return res.end(JSON.stringify({ ok: true, clients: clients.size, lastState, lastHb, lastBounds, last: history.slice(-8) }));
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
      cmd.at = Date.now();
      if (cmd.type === 'expression') lastState.expression = String(cmd.name || '');
      if (cmd.type === 'motion') lastState.motion = String(cmd.name || '');
      if (cmd.type === 'say') lastState.text = String(cmd.text || '');
      if (cmd.type === 'pose') lastState.pose = String(cmd.name || '');
      if (cmd.type === 'param') lastState.param = cmd.id ? String(cmd.id) : Object.keys(cmd.params || {}).join(',');
      lastState.at = cmd.at;
      try { applyToScene(cmd); } catch (e) { log('scene 更新失败：' + (e && e.message)); }
      // 重载/冻结/心跳这类「动作」不能进补发队列：
      // 否则页面一连上来就被 replay 的 reload 再刷一次，变成无限重载。
      if (cmd.type !== 'reload' && cmd.type !== 'ping' && cmd.type !== 'freeze') {
        history.push(cmd);
        if (history.length > 60) history.shift();
      }
      send(cmd);
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
  ws.send(JSON.stringify({ type: 'hello', at: Date.now(), lastState }));
  try { ws.send(JSON.stringify({ type: 'scene', scene })); } catch { /* ignore */ }
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

server.listen(PORT, HOST, () => {
  const keyed = TOKEN && HOST !== '127.0.0.1' ? '（要钥匙）' : '';
  console.log(`[body] Live2D 身体服务听在 http://${HOST}:${PORT}${keyed}（模型目录 ${MODEL_DIR}）`);
});
