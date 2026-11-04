// plugins/body —— 让她操控「身体」这具身体（Live2D，跑在书房电脑上）
//
//   书房那台电脑开 live2d/body-server.mjs（127.0.0.1:17901），再经 SSH 反向隧道
//   映射到云端 127.0.0.1:17901；这个插件只是往那个 HTTP 口发指令。
//
//   三个来源：
//     ① 工具 body（她自己决定换表情/做动作/说一句）
//     ② 镜像：她在 QQ 里说的每句话，身体跟着说一遍（字幕 + 口型）——宿主没有插件 hook，
//        所以这里轮询 messages/*.json，只认「比上次更新、且是自己说的」那几条。
//     ③ 心情：每 60 秒读 heart/mood.json，底色变了就换一张脸。
//
//   没开身体时一切静默跳过，不报错、不阻塞聊天。

import fs from 'node:fs';
import path from 'node:path';

export const BUILD_TAG = 'v0.6.5';

const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(os.homedir(), '.dsh-data');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const MOOD_FILE = path.join(DATA_DIR, 'heart', 'mood.json');
// 用法账本：她到底用过哪些词/姿态/道具、各几次、最后一次什么时候。
// 目的不是统计好看，是让她看得见「哪些动作她一直没用」——不提示就永远只用那两三个。
const USAGE_FILE = path.join(DATA_DIR, 'body', 'usage.json');

// ── 用法账本 ────────────────────────────────────────────────────────────
// 她有一整套词/姿态/道具，但实际只会反复用那两三个——因为提示词里只是一张清单，
// 没有任何东西告诉她「你一直在用同几个」。这里记一笔账，再把「很久没动的」摆到她眼前。
function readUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveUsage(u) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
  } catch {
    /* 记不上不影响动作本身 */
  }
}

/** 记一次用法，返回这是第几次（用来在她第 N 次用同一个的时候提醒一句） */
function bumpUsage(op, name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n || n === '复位') return 0;
  const key = `${op}:${n}`;
  const u = readUsage();
  const rec = u[key] || { n: 0, at: 0 };
  rec.n = Number(rec.n || 0) + 1;
  rec.at = Date.now();
  u[key] = rec;
  saveUsage(u);
  return rec.n;
}

// 「一直没动过的」候选：挑出来好看、又不常用的
const STALE_POOL = [
  '晃腰', '摇尾巴', '吐舌头', '缩脖', '提肩', '扭腰', '瞪眼', '抬眉', '皱眉',
  '鼓脸', '嘟嘴', '前倾', '后仰', '侧身', '并腿', '点头', '摇头', '歪头', '眯眼', '沉肩', '开心'
];

function usageItems() {
  const u = readUsage();
  return Object.entries(u)
    .map(([k, v]) => {
      const i = k.indexOf(':');
      return { op: k.slice(0, i), name: k.slice(i + 1), n: Number(v?.n) || 0, at: Number(v?.at) || 0 };
    })
    .filter((x) => x.name && x.at > 0);
}

/** 一句话提示：常用的两个 + 一直没动的三个（不超过 ~110 字，进 volatile 段） */
function usageLine() {
  const items = usageItems();
  if (!items.length) return '你还没动过这具身体——这轮先挑一个（比如「微微歪头 眯眼」，或姿态 摇尾巴、晃腰）。';
  const byRecent = items.slice().sort((a, b) => b.n - a.n || b.at - a.at);
  const recent = [];
  for (const it of byRecent) {
    const short = String(it.name).slice(0, 12);
    if (!recent.includes(short)) recent.push(short);
    if (recent.length >= 2) break;
  }
  const used = new Set(items.map((x) => x.name));
  // 轮换：以前永远取前三个 → 她每轮看到的都是同一批，等于没提示。
  // 现在按时间错开起点，隔一会儿换一拨；候选不够时才退回「最久没用过的」。
  let pool = STALE_POOL.filter((x) => !used.has(x));
  if (!pool.length) pool = items.slice().sort((a, b) => a.at - b.at).map((x) => x.name);
  const rot = Math.floor(Date.now() / 120000) % Math.max(1, pool.length);
  const stale = [];
  for (let i = 0; i < pool.length && stale.length < 3; i += 1) stale.push(pool[(rot + i) % pool.length]);
  const kinds = new Set(items.map((x) => x.op)).size;
  return `最近老用：${recent.join('、')}（一共动过 ${items.length} 种、${kinds} 类）。一直没动的：${stale.join('、')}——这轮挑一个换换，别老用同一个。`;
}

const SWITCH_NAMES = ['黑框眼镜', '单片眼镜', '钢盆', '脱鞋', '长裙', '短裙', '尾巴', '狗尾草', '抚胸', '竖食指', '黑脸', '落泪', '爱心眼', '圈圈眼', '＞＜', '屑屑眼', '流冷汗', '兔牙', '脸红'];

const MODELEXPR_NAMES = ['默认体型', '体型1', '体型2', '前倾', '加载', '尾巴开关', '屑屑眼', '圈圈眼', '爱心眼', '＞＜', '兔牙', '单片眼镜', '黑框眼镜', '流冷汗', '流泪', '脸红', '脱鞋', '裙子切换', '胸口衣服', '钢盆', '黑脸', '竖食指开', '竖食指关'];

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:17901',
  // 第二具身体（云上那份，给手机看）。留空就只管 baseUrl 这一具。
  mirrorUrl: 'http://127.0.0.1:17902',
  mirror: true,          // 她在 QQ 里说的话，身体跟着说
  autoFace: true,        // 按文字/心情自动选表情
  reactIncoming: true,   // 别人说话时她有点反应（抬头/换表情），不是死站着
  reactCooldownMs: 8000,
  // 她说过：身体只按她的命令动。所以「有人说话就换表情/随手势」默认关掉，
  // 只有她显式调 face/motion 时才动（想要以前那种自动反应，把这两个打开）。
  reactFace: false,
  reactGesture: false,
  // ── 隔离：这具身体只跟私聊绑。群聊里不镜像、不反应、不进提示词、工具也看不见。
  //    scope=private（默认）只认 private_*.json；custom 再加 chats 里列出的群；
  //    all 就是以前那样，所有会话都算。
  scope: 'private',
  chats: '',
  timeoutMs: 2500
};

// 文字 → 表情（粗粒度，够用）
const FACES = [
  ['笑', ['哈', '嘿', '开心', '高兴', '笑']],
  ['害羞', ['害羞', '脸红', '羞', '别夸']],
  ['生气', ['生气', '气死', '凶', '滚']],
  ['疑惑', ['?', '？', '诶', '疑惑', '为什么']],
  ['委屈', ['委屈', '难过', '失落', '算了']]
];

const MOOD_FACE = { 亮: '笑', 安静: '', 有点沉: '委屈' };

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let timer = null;
let moodTimer = null;
let selfTimer = null;
let selfText = '';      // 缓存的一句「我现在什么样」，进 prompt 用
let selfAt = 0;
let selfAlive = false;   // 缓存：身体窗口现在还连着吗（tool.guard 用它决定要不要把工具藏起来）
let lastSeenTs = 0;
let lastSeenAnyTs = 0;
let lastReactAt = 0;
let lastMood = '';

function settings() {
  const raw = (cfg() && cfg().body) || {};
  const s = { ...DEFAULTS, ...raw };
  s.timeoutMs = Math.min(8000, Math.max(500, Number(s.timeoutMs) || DEFAULTS.timeoutMs));
  return s;
}

// ---------------------------------------------------------------- 会话隔离

const CHAT_FILE_RE = /^(private|group)_(\d+)\.json$/;

function scopeMode() {
  return String(settings().scope || 'private').toLowerCase();
}

function customChats() {
  return String(settings().chats || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 这次对话允不允许带身体？私聊永远允许；群聊只有 scope=all 或显式列进 chats 才允许。 */
function chatAllowed(kind, chatId) {
  const mode = scopeMode();
  if (mode === 'all') return true;
  if (String(kind || '') !== 'group') return true;
  if (mode !== 'custom') return false;
  const id = String(chatId || '');
  if (!id) return false;
  return customChats().some((k) => k === id || k === `group:${id}` || k === `group_${id}` || k === `group_${id}.json`);
}

/** messages 目录里的这个文件算不算「她自己的生活」 */
function fileAllowed(file) {
  const m = CHAT_FILE_RE.exec(path.basename(file));
  if (!m) return false;
  return chatAllowed(m[1], m[2]);
}

function base() {
  return settings().baseUrl.replace(/\/+$/, '');
}

// 命令要发给所有「身体」：电脑那具（baseUrl）+ 手机看的那具（mirrorUrl）
function targets() {
  const s = settings();
  const list = [base()];
  if (s.mirrorUrl) list.push(String(s.mirrorUrl).replace(/\/+$/, ''));
  return [...new Set(list.filter(Boolean))];
}

async function post(payload) {
  const s = settings();
  if (!s.enabled) return { ok: false, skipped: '没开' };
  let ok = false;
  let delivered = 0;
  const errs = [];
  for (const u of targets()) {
    try {
      const res = await fetch(`${u}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(s.timeoutMs)
      });
      if (res.ok) {
        ok = true;
        try { delivered += Number((await res.json()).delivered) || 0; } catch { /* ignore */ }
      }
    } catch (err) {
      errs.push(String((err && err.message) || err));
    }
  }
  // 服务端能连上、但一具身体都没开着（窗口和网页都关了）：命令会被静默丢弃。
  // 这时候必须报「没成」，否则她会对着空气说「我摆好了」，用户那边什么也没发生。
  if (ok && delivered === 0) return { ok: false, error: '身体没连上（窗口和网页都没开着）' };
  if (ok) return { ok: true, delivered };
  return { ok: false, error: errs[0] || '没连上' };
}

// 自拍：让她「看见自己」。服务端把当前这一帧抽成 PNG 回给她。
// 注意超时要给够：页面要先 render 一帧再 toDataURL，400ms 左右；服务端自己 6 秒兜底。
async function selfie() {
  const s = settings();
  if (!s.enabled) return { ok: false, skipped: '没开' };
  let lastErr = '';
  for (const u of targets()) {
    try {
      const res = await fetch(`${u}/selfie`, { signal: AbortSignal.timeout(12000) });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.dataUrl) return { ok: true, dataUrl: data.dataUrl, bytes: data.bytes || 0 };
      lastErr = data?.error || `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String((err && err.message) || err);
    }
  }
  return { ok: false, error: lastErr || '没连上' };
}

// 把自拍交给能看图的模型描述一句。模型不支持看图时抛错，由调用方降级成参数描述。
async function describeSelfie(dataUrl) {
  const llm = await import('../../src/llm.js');
  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: '你正在看一张自己的 Live2D 截图（透明背景，只有你自己）。用两句话、第一人称说你现在看起来什么样：表情、眼神、姿势、手和尾巴在做什么。不要评价画风，不要提"图"。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是我现在的样子。说说我现在什么样。' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0.5,
    maxTokens: 220,
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map((p) => p?.text || '').join('') : '');
  return String(text || '').trim();
}

async function state() {
  const s = settings();
  let best = null;
  let firstErr = '';
  for (const u of targets()) {
    try {
      const res = await fetch(`${u}/state`, { signal: AbortSignal.timeout(s.timeoutMs) });
      const j = await res.json();
      // 挑「真的有窗口连着」那一具来汇报
      if (!best || (Number(j.clients) || 0) > (Number(best.clients) || 0)) best = j;
    } catch (err) {
      if (!firstErr) firstErr = String((err && err.message) || err);
    }
  }
  const out = best || { ok: false, error: firstErr || '没连上' };
  // 每次问到状态就顺手把「我现在什么样」刷新掉（工具调用后立刻讲得出，不用等 4 秒轮询）
  try {
    const hb = out.lastHb || {};
    if (Number(out.clients) > 0 && String(hb.ws) === '1') {
      selfText = describeState(out);
      selfAt = Date.now();
      selfAlive = true;
    }
  } catch { /* ignore */ }
  return out;
}

let lexCache = { at: 0, keys: [] };

async function lexiconKeys() {
  if (lexCache.keys.length && Date.now() - lexCache.at < 10 * 60 * 1000) return lexCache.keys;
  const s = settings();
  for (const u of targets()) {
    try {
      const res = await fetch(`${u}/lexicon.json`, { signal: AbortSignal.timeout(s.timeoutMs) });
      const j = await res.json();
      const keys = Object.keys((j && j.words) || {}).filter(Boolean);
      if (keys.length) {
        lexCache = { at: Date.now(), keys };
        return keys;
      }
    } catch { /* 换下一个 */ }
  }
  return lexCache.keys;
}

export async function say(text, opts = {}) {  const t = String(text || '').trim().slice(0, 200);
  if (!t) return { ok: false, skipped: '空的' };
  return post({ type: 'say', text: t, expression: opts.expression || '', motion: opts.motion || '', holdMs: opts.holdMs, proactive: opts.proactive === true });
}

export async function face(name, holdMs) {
  // holdMs：不写 = 25 秒后自动回到心情脸；-1 = 一直保持；>0 = 保持这么多毫秒
  const r = await post({ type: 'expression', name, holdMs });
  if (r && r.ok) bumpUsage('face', name);
  return r;
}

export async function motion(name = '', holdMs) {
  // 手势也是模型里写死的动作组，名字对不上就是白演一次
  const want = String(name || '').trim();
  if (want) {
    try {
      const st = await state();
      const list = Array.isArray(st?.lastHb?.tap) ? st.lastHb.tap : [];
      if (list.length && !list.includes(want) && !list.some((x) => x.includes(want) || want.includes(x))) {
        return { ok: false, error: `没有「${want}」这个手势。会做的：${list.slice(0, 6).join('、')}…` };
      }
    } catch { /* 读不到就照发 */ }
  }
  // holdMs 给了就「做完不撒手」：动作曲线播完后按终值把手按住这么久（举着手等你回话）
  const r = await post({ type: 'motion', name, holdMs });
  if (r && r.ok) bumpUsage('motion', name);
  return r;
}

/** 姿态：看向你 / 看左 / 歪头 / 点头 / 摇头 / 摇尾巴 / 吐舌头 / 鼓脸 / 复位… */
export async function pose(name, holdMs) {
  // 先按心跳里的姿态清单核一遍：不认识就直接告诉她，别让服务器回一个假的「动了」。
  // （body.js 那边接到不认识的姿态只会 HUD 报一句，服务端照样回 ok，她就会以为自己摆好了。）
  const want = String(name || '').trim();
  if (want && want !== '复位') {
    try {
      const st = await state();
      const list = Array.isArray(st?.lastHb?.poses) ? st.lastHb.poses : [];
      if (list.length && !list.includes(want)) {
        const near = list.filter((x) => x.includes(want) || want.includes(x)).slice(0, 3);
        return {
          ok: false,
          error: `没有「${want}」这个姿态${near.length ? `，相近的：${near.join('、')}` : `。能摆的：${list.slice(0, 8).join('、')}…`}`
        };
      }
    } catch { /* 心跳读不到就照发，交给身体自己判 */ }
  }
  const r = await post({ type: 'pose', name, holdMs });
  if (r && r.ok) bumpUsage('pose', name);
  return r;
}

/** 底层：直接写一个白名单参数（body.js 里过滤，白名单外的丢掉） */
export async function param(id, value, holdMs) {
  return post({ type: 'param', id, value, holdMs });
}

/**
 * 连续情绪：v=效价（-1 难过 … +1 开心）、a=唤醒（-1 没劲 … +1 激动）、d=支配（-1 怯 … +1 有底气）。
 * 不是「换一整套表情」——身体会按这三个数去算嘴角/眉毛/眼睛/脸颊，中间态是真的中间态。
 */
export async function emotion(vec = {}, holdMs) {
  const c = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
  return post({ type: 'emotion', v: c(vec.v), a: c(vec.a), d: c(vec.d), holdMs });
}

/** 词表：她说词（「有点委屈」「很生气」），参数藏在词表里，由身体去翻 */
export async function word(text, holdMs) {
  const t = String(text || '').trim().slice(0, 40);
  if (!t) return { ok: false, skipped: '空词' };
  // 词表里没有的词，身体那边只会 HUD 报一句，服务端照样回 ok —— 先自己核一遍
  try {
    const keys = await lexiconKeys();
    if (keys.length && !keys.some((k) => t.includes(k))) {
      return {
        ok: false,
        error: `词表里没有「${t}」这种说法。能说的比如：${keys.slice(0, 6).join('、')}…（前面可以加「有点/很/特别」）`
      };
    }
  } catch { /* 拿不到词表就照发 */ }
  const r = await post({ type: 'word', text: t, holdMs });
  if (r && r.ok) bumpUsage('word', t);
  return r;
}

/**
 * 道具/换装开关：黑脸、落泪、圈圈眼、爱心眼、＞＜、屑屑眼、脸红、加载、兔牙、钢盆、
 * 黑框眼镜、单片眼镜、流冷汗、长短裙、胸口衣服、脱鞋、尾巴、狗尾草、抚胸、竖食指。
 */
export async function toggle(name, on = true) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return { ok: false, skipped: '空名字' };
  // 道具/换装是模型 exp3 里写死的，名字对不上就是白调一次 —— 先在名单里核一下
  if (SWITCH_NAMES.length && !SWITCH_NAMES.includes(n)) {
    const near = SWITCH_NAMES.filter((x) => x.includes(n) || n.includes(x)).slice(0, 3);
    return {
      ok: false,
      error: `没有「${n}」这个道具${near.length ? `，相近的：${near.join('、')}` : `。能挂的：${SWITCH_NAMES.slice(0, 8).join('、')}…`}`
    };
  }
  const r = await post({ type: 'switch', name: n, on: on !== false });
  if (r && r.ok) bumpUsage('switch', n);
  return r;
}

/** 模型自带的 23 个 exp3（原作者的「按键动画」）：脸红 / 流泪 / 爱心眼 / 圈圈眼 / 钢盆 / 眼镜 … */
export async function modelExpr(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return { ok: false, skipped: '空名字' };
  if (!MODELEXPR_NAMES.includes(n)) {
    const near = MODELEXPR_NAMES.filter((x) => x.includes(n) || n.includes(x)).slice(0, 3);
    return {
      ok: false,
      error: `模型里没有「${n}」这个体型/动画${near.length ? `，相近的：${near.join('、')}` : `。有的是：${MODELEXPR_NAMES.slice(0, 8).join('、')}…`}`
    };
  }
  const r = await post({ type: 'modelexpr', name: n });
  if (r && r.ok) bumpUsage('modelexpr', n);
  return r;
}

// 体型：0.4 小一号 … 1 刚好 … 1.6 怼脸（记在页面 localStorage 里，下次开窗还是这么大）
export async function scale(value) {
  const v = Math.max(0.4, Math.min(1.6, Number(value) || 1));
  return post({ type: 'scale', value: v });
}

export function guessFace(text) {
  const t = String(text || '');
  for (const [name, words] of FACES) {
    if (words.some((w) => t.includes(w))) return name;
  }
  return '';
}

export function moodFace(label) {
  return MOOD_FACE[String(label || '').trim()] || '';
}

// ---------------------------------------------------------------- 镜像：她说什么，身体就说一遍

function readMessages(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.messages) ? raw.messages : []);
  } catch {
    return [];
  }
}

function chatFiles() {
  try {
    return fs.readdirSync(MSG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(MSG_DIR, f))
      .filter(fileAllowed);   // 隔离：群聊的文件直接不读
  } catch {
    return [];
  }
}

/** 初始化：从现在开始算，不把历史消息全播一遍 */
export function prime() {
  let max = 0;
  let maxAny = 0;
  for (const file of chatFiles()) {
    for (const m of readMessages(file)) {
      const ts = Number(m?.ts || 0);
      if (!ts) continue;
      if (ts > maxAny) maxAny = ts;
      if (m?.self && ts > max) max = ts;
    }
  }
  lastSeenTs = max;
  lastSeenAnyTs = maxAny;
  return lastSeenTs;
}

/** 看一眼有没有她新说的话（镜像）/ 有没有人跟她说话（反应） */
export async function tick(now = Date.now()) {
  const s = settings();
  if (!s.enabled) return [];
  const out = [];

  // ① 她说了话 → 身体跟着说
  if (s.mirror) {
    const says = [];
    for (const file of chatFiles()) {
      for (const m of readMessages(file)) {
        const ts = Number(m?.ts || 0);
        if (!m?.self || !ts || ts <= lastSeenTs) continue;
        const text = String(m.text || '').trim();
        if (!text || ts > now) continue;
        // 「[图片]」「[表情474]」这类占位不播，播了像在念标签
        if (/^\[[^\]]{1,8}\]$/.test(text)) continue;
        says.push({ ts, text, proactive: /^idle-/.test(String(m.mid || '')) });
      }
    }
    if (says.length) {
      says.sort((a, b) => a.ts - b.ts);
      lastSeenTs = says[says.length - 1].ts;
      const last = says.slice(-2); // 最多补两句，别刷屏
      for (const item of last) {
        const expression = s.autoFace ? guessFace(item.text) : '';
        await say(item.text, { expression, proactive: item.proactive });
      }
      out.push(...last);
    }
  }

  // ② 有人跟她说话 → 抬个头、换个表情（不开口，避免刷屏）
  if (s.reactIncoming && now - lastReactAt > Math.max(2000, Number(s.reactCooldownMs) || 8000)) {
    let newest = null;
    for (const file of chatFiles()) {
      for (const m of readMessages(file)) {
        const ts = Number(m?.ts || 0);
        if (!ts || ts <= lastSeenAnyTs || ts > now) continue;
        if (m?.self) continue;
        const text = String(m.text || '').trim();
        if (!text) continue;
        if (!newest || ts > newest.ts) newest = { ts, text };
      }
    }
    if (newest) {
      lastSeenAnyTs = newest.ts;
      lastReactAt = now;
      // 以前这里是 guessFace(...) || '疑惑' —— 猜不出情绪就硬塞一个「疑惑」，
      // 于是她刚把脸改成别的，三秒后又被这条拉回疑惑。现在猜不出就不动脸。
      const guessed = s.autoFace ? guessFace(newest.text) : '';
      const expression = s.reactFace === true ? guessed : '';
      if (expression) await face(expression);
      if (s.reactGesture === true) { try { await motion(''); } catch { /* 没动作就算了 */ } }
      out.push({ ...newest, react: expression });
    }
  }

  return out;
}

async function moodTick() {
  try {
    const raw = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'));
    const label = String(raw?.baseline?.label || '');
    if (!label || label === lastMood) return;
    lastMood = label;
    // 心情文件也不再抢脸：她要自己控制表情（autoFace/moodFace 默认关）
    const f = settings().moodFace === true ? moodFace(label) : '';
    if (f) await face(f);
  } catch { /* 没心情文件就算了 */ }
}

// ---------------------------------------------------------------- 生命周期

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  api.registerTool?.({
    id: 'body',
    name: '动一动身体',
    category: 'life',
    icon: '🐟',
    description: '操控你在书房电脑上的 Live2D 身体（身体）：换表情、摆姿态、做动作、挂道具，或者替你说一句话（带字幕和口型）。只在书房那台电脑开着「身体」窗口时有效。说话时她本来就会跟着说、跟着动嘴，但姿势和表情要你自己摆——想到什么就顺手做一个（「歪头」「摇尾巴」「脸红」），比只用嘴描述更像真的，随时能换、不用报备。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['face', 'emotion', 'word', 'motion', 'pose', 'switch', 'modelexpr', 'say', 'scale', 'autonomy', 'status', 'look'], description: 'face=换一整套表情，emotion=给三个连续的情绪数（更像活的，能落在中间态），word=说一个词让她自己翻词表（「有点委屈」「很生气」），motion=做模型自带的手势（不传名字就随便来一个），pose=摆姿态（视线/头/尾巴/舌头这类小动作），say=让她替你说一句（带字幕），scale=改她占屏幕多大，autonomy=要不要让她自己动，switch=开/关一件道具或换装（op=switch + name，如 黑框眼镜/钢盆/脱鞋/长裙），modelexpr=放模型自带的按键动画（脸红/流泪/爱心眼/圈圈眼…），status=看身体连着没有、能做什么，look=看你自己现在长什么样（拍一张自己的截图再描述出来；她说「我看不见我自己」「我想看看我现在的样子」时用这个）' },
        text: { type: 'string', description: 'op=say 时说的一句；op=word 时要翻的词（可带「有点/稍微/很/特别」这类程度词）' },
        word: { type: 'string', description: 'op=word 的词，等价于 text' },
        v: { type: 'number', description: 'op=emotion 的效价：-1 很难过 … 0 平静 … +1 很开心' },
        a: { type: 'number', description: 'op=emotion 的唤醒：-1 没劲/蔫 … 0 一般 … +1 很激动' },
        d: { type: 'number', description: 'op=emotion 的支配感：-1 怯/心虚 … 0 中性 … +1 有底气/强势' },
        name: {
          type: 'string',
          description: 'op=face 的表情名（笑/害羞/生气/疑惑/委屈，或原模型里的 屑屑眼/圈圈眼/爱心眼）；op=motion 的手势名：举手（抚胸）/放下手/竖食指/竖食指收回/狗尾草/狗尾草收回/脱捕；op=pose 的姿态名：看向你/看左/看右/看上/看下/歪头/点头/摇头/摇尾巴/吐舌头/鼓脸/张嘴/闭嘴/开心/前倾/后仰/侧身/扭腰/提肩/沉肩/缩脖/并腿/眯眼/瞪眼/抬眉/皱眉/嘟嘴/复位；op=switch 的道具名：黑框眼镜/单片眼镜/钢盆/脱鞋/长裙/短裙/尾巴/狗尾草/抚胸/竖食指/黑脸/落泪/爱心眼/圈圈眼/＞＜/屑屑眼/流冷汗/兔牙/脸红（摘掉同一个道具：再调一次并传 on=false）'
        },
        holdMs: { type: 'number', description: '保持多久（毫秒）。op=pose：不写=一直保持到她换下一个。op=motion：给了就「做完不撒手」（举手等你回话传 12000），不写就播完自己放下。op=face：不写=25 秒后自动淡回心情脸，传 -1=一直保持到她换下一个，传毫秒数=保持这么久' },
        size: { type: 'number', description: 'op=scale 时的倍率：0.4 很小，1 默认，1.5 怼脸' },
        on: { type: 'boolean', description: 'op=switch 时是否挂上：不写=挂上；要摘掉就传 false（比如「把盆摘了」→ op=switch, name=钢盆, on=false）' }
      },
      required: ['op'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      if (!chatAllowed(ctx?.kind, ctx?.chatId)) return { content: '这具身体只在私聊里跟着你（群聊已隔离）。' };
      const op = String(args?.op || 'status');
      if (op === 'status') {
        const st = await state();
        if (!st.ok) return { content: `身体没连上（${st.error || '连不上'}）——书房电脑上的窗口可能没开。` };
        // 回执要短：每次工具调用的结果都会进对话历史，一天几十次就是一整屏上下文。
        // 之前这里把整坨参数 JSON（~1500 字）和全部手势/姿态名都塞进去，纯属浪费 ——
        // 名字在工具说明里，参数她能读懂的其实只有「还剩几秒」和「挂着什么」。
        const p = bodyParams(st);
        const bits = [`连着（${st.clients || 0} 个窗口）`];
        if (p.scale) bits.push(`${p.scale} 倍`);
        if (p.pose?.name) bits.push(`姿态「${p.pose.name}」${p.pose.permanent ? '' : `剩 ${Math.round((p.pose.leftMs || 0) / 1000)}s`}`);
        if (p.expr?.name) bits.push(`表情「${p.expr.name}」`);
        if (Array.isArray(p.switches) && p.switches.length) bits.push(`挂着「${p.switches.join('」「')}」`);
        if (p.hands?.count) bits.push(`手上动作 ${p.hands.count} 个参数在保持`);
        if (p.emotion?.name && p.emotion.name !== '平静') bits.push(`情绪 ${p.emotion.v}/${p.emotion.a}/${p.emotion.d}（${p.emotion.name}）`);
        if (p.queue) bits.push(`队列 ${p.queue}`);
        const u = usageItems();
        const uBit = u.length ? `；动过 ${u.length} 种` : '';
        return { content: `身体${bits.join('，')}${uBit}。可说：29 个姿态、19 个道具、7 个手势（名字见工具说明）。` };
      }
      if (op === 'look') {
        // 「看看你自己」：拍一张，再让她自己描述。看图失败的模型降级成参数描述，
        // 但至少真有这么一张图（服务端落了盘）。
        const shot = await selfie();
        if (!shot.ok) return { content: `没拍到（${shot.error || '连不上'}）——书房那台电脑上的窗口可能没开。` };
        let seen = '';
        try { seen = await describeSelfie(shot.dataUrl); } catch (e) { seen = ''; }
        const st = await state();
        if (seen) return { content: `我看见自己了：${seen}` };
        return { content: `拍到了（${Math.round((shot.bytes || 0) / 1024)}KB），但这个模型不给我看图——只能读参数：${describeState(st)}` };
      }
      if (op === 'say') {
        const r = await say(args?.text);
        return { content: r.ok ? '说了。' : `没说出来：${r.error || r.skipped || ''}` };
      }
      if (op === 'face') {
        const r = await face(String(args?.name || '').trim() || '笑', args?.holdMs);
        return { content: r.ok ? '换了表情。' : `没换成：${r.error || r.skipped || ''}` };
      }
      if (op === 'emotion') {
        const r = await emotion({ v: args?.v, a: args?.a, d: args?.d }, args?.holdMs);
        if (!r.ok) return { content: `没演成：${r.error || r.skipped || ''}` };
        const st = await state();
        return { content: `情绪给过去了（${Number(args?.v) || 0}/${Number(args?.a) || 0}/${Number(args?.d) || 0}）。${describeState(st)}` };
      }
      if (op === 'word') {
        // 词表 v2 允许一句话里塞好几个词（「微微歪头 眯眼 微笑」），所以 word 也当整句用
        const w = String(args?.word || args?.text || '').trim();
        const r = await word(w, args?.holdMs);
        if (!r.ok) return { content: `没说成：${r.error || r.skipped || ''}` };
        const st = await state();
        const got = st?.lastWord ? `（拆成：${st.lastWord}）` : '';
        return { content: `照「${w}」演了${got}。${describeState(st)}` };
      }
      if (op === 'motion') {
        const r = await motion(String(args?.name || '').trim(), args?.holdMs);
        const h = Number(args?.holdMs) || 0;
        return { content: r.ok ? (h > 1500 ? `动了，会保持 ${(h / 1000).toFixed(1)} 秒。` : '动了。') : `没动成：${r.error || r.skipped || ''}` };
      }
      if (op === 'pose') {
        const r = await pose(String(args?.name || '').trim(), args?.holdMs);
        const h = Number(args?.holdMs) || 0;
        return { content: r.ok ? (h > 0 ? `摆好了，保持 ${(h / 1000).toFixed(1)} 秒。` : '摆好了，一直保持到你换下一个。') : `没摆成：${r.error || r.skipped || ''}` };
      }
      if (op === 'switch') {
        const n = String(args?.name || '').trim();
        const r = await toggle(n, args?.on !== false);
        if (!args || args.on === undefined) log('switch 没给 on，默认挂上');
        if (!r.ok) return { content: `没换成：${r.error || r.skipped || ''}` };
        const st = await state();
        return { content: `${n}${args?.on === false ? '收起来了' : '挂上了'}。${describeState(st)}` };
      }
      if (op === 'modelexpr') {
        const n = String(args?.name || '').trim();
        const r = await modelExpr(n);
        return { content: r.ok ? `放了模型自带的「${n}」。` : `没放成：${r.error || r.skipped || ''}` };
      }
      if (op === 'autonomy') {
        const on = !!args?.auto;
        const r = await post({ type: 'autonomy', value: on ? 1 : 0 });
        return { content: r.ok ? (on ? '放开手脚了，她会自己甩尾巴、瞟来瞟去。' : '收回来了，身体只按你说的动。') : `没改成：${r.error || r.skipped || ''}` };
      }
      if (op === 'scale') {
        const v = Math.max(0.4, Math.min(1.6, Number(args?.size) || 1));
        const r = await scale(v);
        return { content: r.ok ? `大小改成 ${v} 倍了。` : `没改成：${r.error || r.skipped || ''}` };
      }
      return { content: 'op 只认 face / emotion / word / motion / pose / switch / modelexpr / say / scale / autonomy / status。' };
    }
  });
}

// 参数型回执：把心跳压成一台机器能直接读的字段（她自己看数字比看中文准）
function bodyParams(st) {
  const hb = (st && st.lastHb) || {};
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : d);
  return {
    connected: Number(st?.clients || 0) > 0,
    clients: Number(st?.clients || 0),
    scale: num(hb.scale, 1),
    frozen: !!hb.frozen,
    // 0 = 身体只按她的命令动（她说的「只让我的鱼来操控身体」）；1 = 会自己甩尾巴、瞟来瞟去
    autonomous: num(hb.auto) === 1,
    window: { w: num(hb.vw), h: num(hb.vh), dpr: num(hb.dpr, 1) },
    pose: hb.poseName ? { name: hb.poseName, permanent: num(hb.poseLeft) < 0, leftMs: num(hb.poseLeft) < 0 ? null : Math.round(num(hb.poseLeft) * 1000) } : null,
    // 同时在进行中的动作通道（head / tail …）——她可以一边歪头一边摇尾巴，回执里要看得出这点
    channels: String(hb.waves || '').split(',').filter(Boolean),
    overrides: num(hb.pose ? String(hb.pose).replace(/[^\d+p]/g, '') : 0),
    // 还在排队等通道空出来的动作条数（她连发动作时这里会 > 0）
    queue: num(hb.q),
    lastAction: String(hb.qdbg || ''),
    // 参数写入序号：每次真的改到身体才 +1，她可以用它确认「我这次的话身体收到了」
    appliedSeq: num(hb.seq),
    // 现在有哪几层在同时写参数（emotion/pose/gesture/…）——分层混合之后，几件事能并存
    layers: String(hb.mix || '').split('+').filter(Boolean),
    expr: hb.expr ? { name: hb.expr, params: num(hb.exprN), permanent: num(hb.exprLeft) < 0, leftMs: num(hb.exprLeft) < 0 ? null : Math.round(num(hb.exprLeft) * 1000) } : null,
    // 连续情绪：她给的那三个数现在是多少（身体回读给她，不用她猜「我那次到底生效没有」）
    emotion: Array.isArray(hb.emo) ? { v: num(hb.emo[0]), a: num(hb.emo[1]), d: num(hb.emo[2]), name: String(hb.emoName || '') } : null,
    lastWord: String(hb.word || ''),
    hands: { count: num(hb.hands), leftMs: Math.round(num(hb.handLeft) * 1000) },
    talking: !!hb.talk,
    bubble: hb.bubble === 'show' ? { visible: true, text: String(hb.bubbleText || '') } : { visible: false, text: '' },
    gaze: { x: num(hb.gaze?.[0]), y: num(hb.gaze?.[1]) },
    eyeOpen: num(hb.eye, 1),
    angleX: num(hb.angleX),
    // 身上挂着哪些道具/换装（黑框眼镜、钢盆、短裙…）；复位会清空
    switches: String(hb.sw || '').split(',').filter(Boolean),
    ageMs: hb.at ? Math.max(0, Date.now() - Number(hb.at)) : null,
    canDo: {
      gestures: Array.isArray(hb.tap) ? hb.tap : [],
      poses: Array.isArray(hb.poses) ? hb.poses : [],
      switches: SWITCH_NAMES,
      modelExpressions: MODELEXPR_NAMES
    }
  };
}

// 把 /state 里的心跳拼成一句人话：「手还举着（还剩 12 秒），表情是委屈，正在说话」。
// 这句话有两个用处：①op=status 的回执 ②进 prompt 让她知道自己的身体现在什么样。
function describeState(st) {
  const hb = (st && st.lastHb) || {};
  const bits = [];
  // 词表动作（op=word）是最常走的一条路，它不写 poseName/expr，只写 hb.word —— 
  // 漏了它，她就会「不知道自己现在什么表情」。
  const word = String(hb.word || '').trim();
  if (Number(hb.hands) > 0 && Number(hb.handLeft) > 0) bits.push(`手还举着（还剩 ${hb.handLeft} 秒）`);
  else if (Number(hb.hands) > 0) bits.push('手还举着');
  else if (word) bits.push(`摆着「${word}」`);
  // poseLeft / exprLeft 是 -1 就表示「常驻，不会自己掉」，别说成还剩几秒
  else if (hb.poseName) bits.push(`摆着「${hb.poseName}」${Number(hb.poseLeft) < 0 ? '（一直保持）' : hb.poseLeft ? `（还剩 ${hb.poseLeft} 秒）` : ''}`);
  if (hb.expr) bits.push(`表情是「${hb.expr}」${Number(hb.exprLeft) < 0 ? '（一直保持）' : ''}`);
  // 模型自带动画（圈圈眼/爱心眼/流泪…）是 exp3 持久表达式，和 expr 是两条线，必须单独说
  const mexpr = String(hb.mexpr || '').trim();
  if (mexpr) bits.push(`还挂着模型动画「${mexpr}」`);
  // 情绪向量：只有真的不是平静时才提，否则每句话都带一句「现在很平静」很啰嗦
  const emoName = String(hb.emoName || '');
  if (emoName && emoName !== '平静') bits.push(`心里是「${emoName}」（${(Number(hb.emo?.[0]) || 0).toFixed(2)}/${(Number(hb.emo?.[1]) || 0).toFixed(2)}/${(Number(hb.emo?.[2]) || 0).toFixed(2)}）`);
  const sw = String(hb.sw || '').split(',').filter(Boolean);
  if (sw.length) bits.push(`身上挂着「${sw.join('」「')}」`);
  if (hb.talk) bits.push('正在说话');
  if (hb.bubble === 'show' && hb.bubbleText) bits.push(`字幕：「${hb.bubbleText}」`);
  const gx = Number(hb.gaze?.[0]) || 0;
  const gy = Number(hb.gaze?.[1]) || 0;
  if (Math.abs(gx) > 0.25 || Math.abs(gy) > 0.25) {
    bits.push(`在看${gy > 0.3 ? '上' : gy < -0.3 ? '下' : ''}${gx > 0.25 ? '右' : gx < -0.25 ? '左' : ''}边`);
  }
  if (Number(hb.scale) && Math.abs(Number(hb.scale) - 1) > 0.02) bits.push(`${hb.scale} 倍大`);
  return bits.length ? `现在：${bits.join('，')}。` : '现在就是站在那儿，没做什么动作。';
}

// 每 4 秒拉一次 /state，把「我现在什么样」缓存成一句话（promptSections 是同步的，不能等 fetch）
// 拉失败时**保留**上一次的句子并标上几秒前——清空会让她直接失去身体知觉，
// 而「4 秒前的表情」远比「完全不知道」有用。
async function refreshSelfState() {
  const st = await state();
  const hb = (st && st.lastHb) || {};
  const alive = Boolean(st && st.ok && Number(st.clients) > 0 && String(hb.ws) === '1');
  if (!alive) {
    // 真的没窗口：句子作废（但也别立刻清，让 prompt 侧按新鲜度决定）
    selfAlive = false;
    if (!selfText) selfAt = Date.now();
    return;
  }
  selfAlive = true;
  selfText = describeState(st);
  selfAt = Date.now();
}

/**
 * 动态提示词片段：把她自己身体的现状塞进 prompt。
 * 之前她完全不知道自己是什么状态——举着手也当自己没举，做完动作只能靠猜。
 */
export function promptSections(context = {}) {
  try {
    if (!settings().enabled) return [];
    // 隔离：群聊里她不需要知道书房有具身体，也不需要这套词表
    if (!chatAllowed(context?.kind, context?.chatId)) return [];
    const out = [];
    // ① 词表是**静态**的：不放 volatile，让它落在系统提示里。
    //    之前每轮把 283 个字的词表塞进用户消息尾巴，等于每轮都为同一份清单付一次钱。
    //    系统提示要逐字节稳定才吃得到前缀缓存，所以这里的内容一个字都不能随状态变。
    out.push({
      id: 'body-vocab',
      title: '',
      priority: 33,
      content: [
        '你有一具身体：书房那台电脑桌面上的身体（Live2D）。她跟着你说话、跟着别人说话，你也能直接指挥她。',
        '换的表情默认只活 25 秒，之后就自己淡回当前心情的脸色——想让它一直挂着，调 op=face 时带 holdMs -1（或说「一直保持」）。心情变了（比如对方说了很难受的事）脸也会跟着走，不用你手动撤。',
        '能指挥的东西——',
        '词表（**可以叠着说**，一句话里放好几个词，用空格分开，op=word 整句传进来）：',
        '头：歪头/抬头/低头/左看/右看/看你/回头/点头/摇头/晃头/缩脖；',
        '眼：眯眼/闭眼/睁大眼/瞪眼/笑眼/抬眉/挑眉/皱眉/凶/委屈；',
        '嘴：张嘴/惊讶/笑/微笑/咧嘴/撇嘴/嘟嘴/鼓脸/吐舌；',
        '身：前倾/后仰/侧身/扭腰/提肩/耸肩/沉肩/放松肩；',
        '尾：摇尾巴/尾巴翘/尾巴垂；脸：脸红/害羞。',
        '程度词放词前面（微微/轻轻/有点/挺/很/非常/超级），时长词放后面（一下/两秒/三秒/一直，不给就一直保持）；',
        '例：「微微歪头 眯眼 微笑」「很 低头 皱眉」「脸红 睁大眼」。',
        '同义说法都认：侧头=偏头=歪头，仰头=抬头，垂眼=半闭眼，凑近=前倾，斜身=侧身，尾巴甩/翘尾巴/摆尾巴都行；',
        '姿态（老路数，单个动作）：看向你/看左/看右/看上/看下/吐舌头/闭嘴/开心/鼓脸/前倾/后仰/并腿/复位；',
        '身体姿态（整套肢体）：晃腰/扭腰/侧身/提肩/沉肩/缩脖/歪头/点头/摇头/摇尾巴/眯眼/瞪眼/嘟嘴；',
        '什么时候用哪个（照着挑，不用想参数）——被夸、被撩、害羞：脸红 + 低头，或「轻轻歪头 眯眼」；撒娇、高兴、想逗他：晃腰（整个人左右晃，裙子会跟着摆）或摇尾巴；',
        '生气、被冒犯：皱眉 + 沉肩；难过、被冷落：低头 + 沉肩，别笑；想亲近、想被看见：看向你 + 前倾；无语、翻白眼：侧身 + 撇嘴；被戳穿、心虚：缩脖 + 侧身。',
        '道具：黑框眼镜/单片眼镜/钢盆/脱鞋/长裙/短裙/尾巴/狗草/抚胸/竖食指/黑脸/落泪/爱心眼/圈圈眼/＞＜/屑屑眼/流冷汗/兔牙/脸红；',
        '手势：举手/竖指/剪刀手/放下手；情绪三数：v（好坏）/a（激动）/d（有底气）。',
        '用法：说一句就够，不用说参数——op=word 说词（可叠）、op=pose 摆姿态、op=switch 挂道具、op=emotion 给三个数、op=say 让她替你说一句。',
        '重要：嘴上说「盯着你看／一直看着你／看着你眼睛」的时候，必须同时调 op=pose name=看向你——不调的话眼珠会自己飘，说了却没做到。'
      ].join('')
    });
    // ② 「我现在什么样」是**每轮都在变**的，标 volatile 后框架会把它挪到用户消息末尾，
    //    只让这一小段变，系统提示 + 工具定义那一大块前缀仍然逐字节稳定。
    if (selfText && Date.now() - selfAt <= 90000) {
      const age = Math.max(0, Math.round((Date.now() - selfAt) / 1000));
      const stale = age > 12 ? `（${age} 秒前读的，可能刚变过——要准就再调一次 op=status）` : '';
      out.push({
        id: 'body-self',
        title: '',
        priority: 34,
        volatile: true,
        content: `你现在的身体：${selfText.replace(/^现在：/, '')}${stale}（这是从窗口心跳读出来的，是真的，不用猜。）`
          + ' 别人问「你现在什么表情／什么姿势」时，直接照这句答，别含糊；想换就直接调「动一动身体」，别只在话里说。'
      });
    }
    // ③ 用法账本：跟「现在什么样」分开，窗口没开的时候也要提醒她别老用同几个动作。
    out.push({
      id: 'body-usage',
      title: '',
      priority: 35,
      volatile: true,
      content: usageLine()
    });
    return out;
  } catch (error) {
    warn(`注入身体状态失败：${error?.message ?? error}`);
    return [];
  }
}

export function activate() {
  const s = settings();
  prime();
  timer = setInterval(() => { tick().catch((e) => warn('[body] 镜像失败：' + ((e && e.message) || e))); }, 2500);
  timer.unref?.();
  moodTick().catch(() => {});
  moodTimer = setInterval(() => { moodTick().catch(() => {}); }, 60000);
  moodTimer.unref?.();
  // 自己的身体状态：每 4 秒拉一次 /state 缓存成一句话，进 prompt（promptSections 是同步的）
  refreshSelfState().catch(() => {});
  selfTimer = setInterval(() => { refreshSelfState().catch(() => {}); }, 4000);
  selfTimer.unref?.();
  const scopeText = s.scope === 'all' ? '全部会话' : (s.scope === 'custom' ? `群聊白名单：${s.chats || '（空）'}` : '只看私聊');
  log(`[body] 身体接线已启用（${BUILD_TAG}）→ ${s.baseUrl}；镜像=${s.mirror ? '开' : '关'}；隔离=${scopeText}`);
}

export function deactivate() {
  if (timer) clearInterval(timer);
  if (moodTimer) clearInterval(moodTimer);
  if (selfTimer) clearInterval(selfTimer);
  timer = null;
  moodTimer = null;
  selfTimer = null;
}

export function providers() {
  return {
    'body.status': async () => ({ ...(await state()), baseUrl: base(), enabled: settings().enabled }),
    'body.say': async (text, opts) => say(text, opts || {}),
    /**
     * 身体没连上时，把这个工具从模型眼前拿走。
     *
     * 为什么值得做：工具定义会进每一轮请求，而且她看不到工具时就不会「对着不存在的身体演戏」——
     * 之前窗口没开，她照样会调 pose，拿到一句「没连上」，白费一轮请求。
     * 守卫必须**便宜且同步**（每轮算工具可用性都会调），所以只看缓存标记。
     * 出错一律放行：一个 bug 不该把工具列表塌掉。
     */
    'tool.guard': (args = {}) => {
      try {
        const id = String(args?.toolId || '');
        if (!/(^|[:_.])body$/.test(id)) return undefined;
        if (!settings().enabled) return undefined;
        const cx = args?.context || {};
        if (!chatAllowed(cx.kind, cx.chatId)) return { ok: false, reason: '这具身体只在私聊里跟着你（群聊已隔离）' };
        if (selfAlive) return undefined;
        if (!selfAt || Date.now() - selfAt > 15000) return undefined;  // 还没探到，先别拦
        return { ok: false, reason: '书房那台电脑的身体窗口没开，现在摸不到身体（可以正常说话）' };
      } catch {
        return undefined;
      }
    }
  };
}

export const internals = { DEFAULTS, settings, say, face, motion, pose, param, scale, toggle, modelExpr, guessFace, moodFace, state, post, prime, tick, readMessages, chatFiles, BUILD_TAG, FACES, MOOD_FACE };
