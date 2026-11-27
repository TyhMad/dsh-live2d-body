// plugins/body —— 让她操控「大肥鱼」这具身体（Live2D，跑在本机上）
//
//   本机开 live2d/body-server.mjs（127.0.0.1:17901），再经 SSH 反向隧道
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

const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || '/var/lib/qqagent';
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
  '鼓脸', '嘟嘴', '前倾', '后仰', '侧身', '并腿', '点头', '摇头', '歪头', '眯眼', '沉肩', '开心',
  // 后加的整身姿态：她也需要被提醒「还有这几个」
  '凑近', '退开', '挺胸', '探头', '缩起来', '背对你', '一激灵', '晃脑袋'
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
  return `最常用：${recent.join('、')}（一共动过 ${items.length} 种、${kinds} 类）。一直没动的：${stale.join('、')}——这轮挑一个换换，别老用同一个。`;
}

const SWITCH_NAMES = ['黑框眼镜', '单片眼镜', '钢盆', '脱鞋', '长裙', '短裙', '尾巴', '狗尾草', '抚胸', '竖食指', '黑脸', '落泪', '爱心眼', '圈圈眼', '＞＜', '屑屑眼', '流冷汗', '兔牙', '脸红'];

const MODELEXPR_NAMES = ['默认体型', '体型1', '体型2', '前倾', '加载', '尾巴开关', '屑屑眼', '圈圈眼', '爱心眼', '＞＜', '兔牙', '单片眼镜', '黑框眼镜', '流冷汗', '流泪', '脸红', '脱鞋', '裙子切换', '胸口衣服', '钢盆', '黑脸', '竖食指开', '竖食指关'];

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:17901',
  // 第二具身体（云上那份，给手机看）。留空就只管 baseUrl 这一具。
  mirrorUrl: 'http://127.0.0.1:17902',
  mirror: true,          // 她在 QQ 里说的话，身体跟着说
  // 2026-11-18 改成 false：脸的主人是她自己（word/face/emotion 有回执、有账本），
  // 关键词表只留一个用处——给 TTS 挑音色（voiceEmotion）。以前 autoFace=true 时，
  // 播她的话会按 20 个关键词猜一张脸，盖在她自己挑的那张上面（后写的赢）。
  autoFace: false,       // 按文字/心情自动选表情
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
  timeoutMs: 2500,
  // 出声比动一下慢得多：首次合成一句要 5 秒上下（之后走缓存几乎瞬回），
  // 用 timeoutMs 会把刚合成到一半的句子掐掉。
  voiceTimeoutMs: 30000
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
let selfDeadAt = 0;      // 从什么时候起一直没连上（0 = 现在是活的）
let selfAlive = false;   // 缓存：身体窗口现在还连着吗（tool.guard 用它决定要不要把工具藏起来）
let lastSeenTs = 0;
let lastSeenAnyTs = 0;
let lastReactAt = 0;
let lastMood = '';

// —— 动作排期（2026-11-26）——
// 为什么需要：工具调用发生在她的话**生成之前**，所以她一调动作就立刻执行，
// 永远是「先摆好姿势再开口」。实测中位提前量 −1.5 秒，说中才动的比例是 0%。
// 带 when 的动作先扣下来（CAP），等这一轮最终文本出来，after-response 按字符位置
// 算出时刻，一次 sched 批次下发；页面按自己的钟准点触发，跟朗读并行。
const CAP = { on: false, cmds: [] };       // 捕获模式：post() 看到它就只记录不发送
const WHEN_QUEUE = [];                     // 等这一轮文本的动作
const WHEN_MAX = 4;                        // 一轮最多排几个（跟提示词里的「最多两个」一致，留点余量）

/** 一句字幕该显示多久：跟页面 say() 同一个公式（每字 240ms + 400ms 底，夹 1.2–12 秒） */
function sayDurMs(text) {
  const n = String(text || '').length;
  return Math.max(1200, Math.min(12000, 400 + n * 240));
}

/** 把她的 when 说法换算成毫秒偏移。认三种：同时 / 说到「X」 / +0.8s */
function whenToDelayMs(when, text) {
  const s = String(when || '').trim();
  if (!s) return null;
  if (/^(同时|现在|同步|说完这句的同时)$/.test(s)) return 0;
  const rel = s.match(/^\+?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?$/);
  if (rel) return Math.round(/ms|毫秒/.test(rel[2] || 's') ? Number(rel[1]) : Number(rel[1]) * 1000);
  const at = s.match(/(?:说到|念到|讲到|在)\s*[「“"'《]?([^」”"'》]+)[」”"'》]?/);
  const dur = sayDurMs(text); // 跟页面 say() 的估法一致
  if (at) {
    const key = String(at[1] || '').trim();
    const i = key ? (text || '').indexOf(key) : -1;
    if (i >= 0) return Math.round((i / Math.max(1, (text || '').length)) * dur);
    return Math.round(dur * 0.55); // 找不到就放中间，别把动作吞掉
  }
  return null;
}

/** 这一轮的话定稿了：把排队的动作换算成时刻，一次下发 */
function flushWhenQueue(text) {
  const n = WHEN_QUEUE.length;
  if (!n) return 0;
  const items = WHEN_QUEUE.splice(0, WHEN_MAX).map((q) => {
    const d = whenToDelayMs(q.when, text);
    return { d: Math.max(0, Math.min(30000, d == null ? 0 : d)), cmd: q.cmd };
  });
  Promise.resolve().then(() => post({ type: 'sched', items })).catch(() => { /* 身体没开着就这样 */ });
  return items.length;
}

// —— 一轮里的动作编排（2026-11-27）——
// 她一句话里常常连调好几次（word 前倾、word 眯眼、pose 别过头）。每次调用都发生在
// 这一轮的动作先攒着，等她真的开口（send_message 的 after-tool）再一起放。
// 只做一件事：把「动作」和「她的话」对齐到同一个起点 —— **不替她安排先后**。
// 想指定时刻是她自己的事：`when`（说到「X」/ +0.8s）或 `[[ ]]`（位置即时刻，走 op=speak）。
// 2026-11-27 17:30 删掉了早期那套「按句子百分比铺开（0/42%/78%）」——
// 那是系统替她编排，用户明确说过不要；实测 14/14 次下发全是单动作，那段代码从未生效。
const TURN_ON = process.env.QQ_BODY_TURN !== '0'; // 出问题 QQ_BODY_TURN=0 可一键退回「立刻执行」
const TURN = { acts: [], timer: null };
const TURN_MAX = 4;
const TURN_OPS = new Set(['word', 'pose', 'face', 'emotion', 'switch', 'motion', 'modelexpr', 'anim']);

function armTurnFlush() {
  if (TURN.timer) clearTimeout(TURN.timer);
  // 兜底：只调工具不说话、或者这一轮没走到 after-response，别把动作吞了
  TURN.timer = setTimeout(() => { TURN.timer = null; flushTurn(''); }, 12000);
}

/** 她开口了：把攒下的动作跟这一批话放到同一个起点，一次下发（不排先后） */
function flushTurn(text, durOverride) {
  if (TURN.timer) { clearTimeout(TURN.timer); TURN.timer = null; }
  const acts = TURN.acts.splice(0, TURN_MAX);
  if (!acts.length) return 0;
  const dur = Number(durOverride) > 0 ? Number(durOverride) : (text ? sayDurMs(text) : 4000);
  // 全部 d=0：她要的就是「说这话的时候做这个动作」。想分先后，她自己用 when / [[ ]]
  const items = acts.map((a) => ({ d: 0, cmd: a.cmd }));
  Promise.resolve().then(() => post({ type: 'sched', items })).catch(() => { /* 身体没开着就这样 */ });
  try {
    log('[body] 编排下发 ' + items.map((i) => (i.cmd.name || i.cmd.text || i.cmd.type) + '@' + i.d).join(' + ') + `（句长 ${Math.round(dur)}${text ? '' : '，兜底'}）`);
  } catch { /* ignore */ }
  return items.length;
}

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

/**
 * chatKey 到底是不是私聊？
 * DSH 里同一个会话在不同地方有两种写法：会话对象里是 `private:10001`（冒号），
 * 磁盘上的消息文件是 `private_10001.json`（下划线）。2026-11-27 的坑就在这：
 * after-tool 只认下划线，于是 `private:10001` 被当成"群里来的"，直接 return，
 * 她说完话动作还在 12 秒兜底里躺着 —— 表现就是"话说完了她才动"。
 */
function isPrivateKey(ck) {
  const s = String(ck || '');
  if (!s) return false;                       // 拿不到就交给 ctx.kind 判，别一棍子打死
  return /^private[:_]/.test(s);
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
  // 捕获模式：她想给动作指定「什么时候」时（args.when），先把命令扣下来排队，
  // 等这一轮的话生成完由 after-response 按文本算时刻再统一下发。
  // 用捕获而不是重写 14 个分支，是为了让「她调什么」和「什么时候做」两件事解耦。
  if (CAP.on) { CAP.cmds.push(payload); return { ok: true, delivered: 1, captured: true }; }
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

// 词表其实有两个来源：
//   · /lexicon.json  —— 老的手写表（低头、撇嘴这类口语，body.js 里 applyWord 用）
//   · /vocab.json    —— v2 通道表（垂眼、张嘴、挑眉… 走 applyPhrase）
// 以前只读第一份，结果她说「轻轻垂眼 张嘴」会被判成「词表里没有这个词」而白费一次调用
// （2026-11-21 之前一周内这类失败占 word 失败的全部）。两份合起来才是她真能说的全集。
async function lexiconKeys() {
  if (lexCache.keys.length && Date.now() - lexCache.at < 10 * 60 * 1000) return lexCache.keys;
  const s = settings();
  for (const u of targets()) {
    const keys = [];
    for (const f of ['/lexicon.json', '/vocab.json']) {
      try {
        const res = await fetch(`${u}${f}`, { signal: AbortSignal.timeout(s.timeoutMs) });
        const j = await res.json();
        for (const k of Object.keys((j && j.words) || {})) if (k && !keys.includes(k)) keys.push(k);
      } catch { /* 少一份也能用 */ }
    }
    if (keys.length) {
      lexCache = { at: Date.now(), keys };
      return keys;
    }
  }
  return lexCache.keys;
}

export async function say(text, opts = {}) {  const t = String(text || '').trim().slice(0, 200);
  if (!t) return { ok: false, skipped: '空的' };
  return post({ type: 'say', text: t, expression: opts.expression || '', motion: opts.motion || '', holdMs: opts.holdMs, proactive: opts.proactive === true });
}

/**
 * 出声的底座：把一句交给本机机器的本地 TTS 合成。
 *
 * play=true  合成完由身体的窗口放出来（她真的在房间里出声）
 * play=false 只合成、不在这里放 —— 云端拿 wav 去发 QQ 语音条，
 *            否则同一句会在房间里和 QQ 里各响一次。
 *
 * 返回里带 base（合成来自哪个地址），取 wav 要用它拼 URL。
 * 合成比一次网络往返慢得多（首次 5 秒起，之后走缓存），所以超时单独放宽。
 */
async function synthVoice(text, emotion, play) {
  const t = String(text || '').trim().slice(0, 200);
  if (!t) return { ok: false, error: '空的' };
  const s = settings();
  if (!s.enabled) return { ok: false, skipped: '没开' };
  const emo = String(emotion || '').trim() || voiceEmotion(t);
  let lastErr = '';
  for (const u of targets()) {
    try {
      const res = await fetch(`${u}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'voice', text: t, emotion: emo, play }),
        signal: AbortSignal.timeout(Number(s.voiceTimeoutMs) || 30000)
      });
      const j = await res.json().catch(() => null);
      if (j && j.ok && (j.url || play)) {
        return {
          ok: true,
          text: t,
          emotion: emo,
          dur: Number(j.dur) || 0,
          cached: j.cached === true,
          delivered: Number(j.delivered) || 0,
          url: String(j.url || ''),
          base: u
        };
      }
      lastErr = (j && j.error) || `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String((err && err.message) || err);
    }
  }
  return { ok: false, error: lastErr || '没连上' };
}

/**
 * 出声（在这台机器上）：她说的一句从音箱里念出来。
 * 和 say() 的差别只有「有没有声音」——say() 是字幕 + 口型，voice() 是真的念出来。
 */
export async function voice(text, emotion) {
  const r = await synthVoice(text, emotion, true);
  if (!r.ok) return { ok: false, error: r.error || r.skipped };
  if (r.delivered === 0) return { ok: false, error: '身体没连上（窗口和网页都没开着），声音放不出来' };
  return { ok: true, dur: r.dur, cached: r.cached, delivered: r.delivered };
}

/**
 * 出声（发成 QQ 语音条）：合成在本机、发送在云端。
 *
 * 为什么要绕这一圈：TTS 的模型（GPT-SoVITS）在本机，云端没有 GPU 也没有权重；
 * 而 QQ 协议端在云端。所以走「云端说念这句 → 隧道到本机合成 → 取回 wav →
 * 当 record 段交给发送管道」。NapCat 收到 wav 会自己转成 amr 语音条
 * （实测 385KB wav → 18KB amr，音质是电话那档，比房间里听差一截）。
 *
 * 发送必须走 ctx.sender.sendMedia：它带串行、限频、去重、留档，
 * 绕过它直接调协议端会把文字配额吃光，还会在下一次运行忘了自己发过。
 */
export async function voiceQQ(text, emotion, ctx, pre) {
  if (!ctx || !ctx.chatKey) return { ok: false, error: '这条通道拿不到会话，语音条发不出去' };
  if (!ctx.sender || typeof ctx.sender.sendMedia !== 'function') {
    return { ok: false, error: '这条通道拿不到发送能力，语音条发不出去' };
  }
  const r = pre || await synthVoice(text, emotion, false);
  if (!r.ok) return { ok: false, error: r.error || r.skipped };
  let buf = null;
  try {
    const res = await fetch(`${r.base}${r.url}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`取音频 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, error: `取音频失败：${String((err && err.message) || err)}` };
  }
  if (!buf || !buf.length) return { ok: false, error: '取回来的音频是空的' };
  try {
    await ctx.sender.sendMedia(
      ctx.chatKey,
      [{ type: 'record', data: { file: `base64://${buf.toString('base64')}` } }],
      // 去重键带上时间戳：同一句话再说一遍是正常事（「嗯」），不该被当成刷屏挡掉；
      // 真刷屏由发送管道的限频兜着。
      { label: '[语音]', dedupeKey: `voice:${Date.now()}` }
    );
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return { ok: true, dur: r.dur, cached: r.cached, bytes: buf.length };
}

// 文本 → 语气档位：复用表情猜测（同一份词表），猜不出就用她平时的 soft。
/** 失败时记进账本的一句话：优先用身体/词表给的现成原因，别自己编 */
function whyOf(r) {
  if (!r) return '没有回执';
  return String(r.error || r.skipped || r.note || '没成').slice(0, 60);
}

// tts_server.py 的 REFS 只有这五档：soft / play / keen / shy / neutral
const VOICE_BY_FACE = { 开心: 'play', 害羞: 'shy', 生气: 'keen', 委屈: 'soft', 难过: 'soft' };
function voiceEmotion(text) {
  return VOICE_BY_FACE[guessFace(text)] || 'soft';
}

export async function face(name, holdMs, src = 'tool') {
  // holdMs：不写 = 25 秒后自动回到心情脸；-1 = 一直保持；>0 = 保持这么多毫秒
  const r = await post({ type: 'expression', name, holdMs });
  noteAct('face', name, src, !!(r && r.ok), whyOf(r));
  if (r && r.ok) bumpUsage('face', name);
  return r;
}

export async function motion(name = '', holdMs, src = 'tool') {
  // 手势也是模型里写死的动作组，名字对不上就是白演一次
  const want = String(name || '').trim();
  if (want) {
    try {
      const st = await state();
      const list = Array.isArray(st?.lastHb?.tap) ? st.lastHb.tap : [];
      if (list.length && !list.includes(want) && !list.some((x) => x.includes(want) || want.includes(x))) {
        noteAct('motion', want || '手势', src, false, '没有这个手势');
        return { ok: false, error: `没有「${want}」这个手势。会做的：${list.slice(0, 6).join('、')}…` };
      }
    } catch { /* 读不到就照发 */ }
  }
  // holdMs 给了就「做完不撒手」：动作曲线播完后按终值把手按住这么久（举着手等你回话）
  const r = await post({ type: 'motion', name, holdMs });
  noteAct('motion', name || '手势', src, !!(r && r.ok), whyOf(r));
  if (r && r.ok) bumpUsage('motion', name);
  return r;
}

/** 姿态：看向你 / 看左 / 歪头 / 点头 / 摇头 / 摇尾巴 / 吐舌头 / 鼓脸 / 复位… */
export async function pose(name, holdMs, strength, src = 'tool') {
  // 先按心跳里的姿态清单核一遍：不认识就直接告诉她，别让服务器回一个假的「动了」。
  // （body.js 那边接到不认识的姿态只会 HUD 报一句，服务端照样回 ok，她就会以为自己摆好了。）
  const want = String(name || '').trim();
  // 「微微歪头」这类程度词由 body.js 解析；这里只负责把显式力度也带过去。
  const over = Number(strength);
  const power = Number.isFinite(over) && over > 0 ? Math.max(0.25, Math.min(1.3, over)) : 0;
  if (want && want !== '复位') {
    try {
      const st = await state();
      const list = Array.isArray(st?.lastHb?.poses) ? st.lastHb.poses : [];
      // 程度词可以剥，但**必须先看原名在不在清单里**：`挺胸` 一剥就变成 `胸`，
      // 结果一个合法姿态被判成「没有这个姿态」（2026-11-20 一天里她白试了 7 次）。
      const DEGREE = /^(微微|轻轻地|轻轻|稍稍|稍微|稍|略|有点|一点儿|一点|挺|很|特别|非常|超级|极其)/;
      const bare = want.replace(DEGREE, '').trim();
      const hit = list.includes(want) ? want : (bare && list.includes(bare) ? bare : '');
      if (list.length && !hit) {
        // 她经常把一串动作塞进 pose（「低头 摇尾巴」「抬头 看向你」），也常用词表里的口语（「撇嘴」「低头」）。
        // pose 只吃单个姿态名，但 word 那条路对这两种都会。先交给 word 试试，别让她白费一次调用。
        // 记账按真实发生的记成 word（她以为自己在摆姿态，实际发生的是词表动作），一行，不重复记。
        try {
          const keys = await lexiconKeys();
          if (keys.length && keys.some((k) => want.includes(k))) {
            const wr = await post({ type: 'word', text: want, holdMs });
            const okw = !!(wr && wr.ok);
            noteAct('word', want, src, okw, okw ? '' : whyOf(wr));
            if (okw) {
              bumpUsage('word', want);
              return { ...wr, via: 'word', note: `「${want}」不是单个姿态名，已按 word 的那串动作处理` };
            }
            return wr || { ok: false, error: '词表动作没动起来' };
          }
        } catch { /* 拿不到词表就给她姿态清单的提示 */ }
        const near = list.filter((x) => x.includes(bare) || bare.includes(x)).slice(0, 3);
        noteAct('pose', name, src, false, '没有这个姿态');
        return {
          ok: false,
          error: `没有「${bare}」这个姿态${near.length ? `，相近的：${near.join('、')}` : `。能摆的：${list.slice(0, 8).join('、')}…`}`
        };
      }
    } catch { /* 心跳读不到就照发，交给身体自己判 */ }
  }
  const r = await post(power ? { type: 'pose', name, holdMs, strength: power } : { type: 'pose', name, holdMs });
  noteAct('pose', name, src, !!(r && r.ok), whyOf(r));
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
export async function emotion(vec = {}, holdMs, src = 'tool') {
  const c = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
  const r = await post({ type: 'emotion', v: c(vec.v), a: c(vec.a), d: c(vec.d), holdMs });
  noteAct('emotion', '情绪', src, !!(r && r.ok), whyOf(r));
  return r;
}

/** 词表：她说词（「有点委屈」「很生气」），参数藏在词表里，由身体去翻 */
export async function word(text, holdMs, src = 'tool') {
  const t = String(text || '').trim().slice(0, 40);
  if (!t) {
    noteAct('word', t, src, false, '空词');
    return { ok: false, skipped: '空词' };
  }
  // 词表里没有的词，身体那边只会 HUD 报一句，服务端照样回 ok —— 先自己核一遍
  try {
    const keys = await lexiconKeys();
    if (keys.length && !keys.some((k) => t.includes(k))) {
      noteAct('word', t, src, false, '词表里没有这个词');
      return {
        ok: false,
        error: `词表里没有「${t}」这种说法。能说的比如：${keys.slice(0, 6).join('、')}…（前面可以加「有点/很/特别」）`
      };
    }
  } catch { /* 拿不到词表就照发 */ }
  const r = await post({ type: 'word', text: t, holdMs });
  noteAct('word', t, src, !!(r && r.ok), whyOf(r));
  if (r && r.ok) bumpUsage('word', t);
  return r;
}

/**
 * 道具/换装开关：黑脸、落泪、圈圈眼、爱心眼、＞＜、屑屑眼、脸红、加载、兔牙、钢盆、
 * 黑框眼镜、单片眼镜、流冷汗、长短裙、胸口衣服、脱鞋、尾巴、狗尾草、抚胸、竖食指。
 */
export async function toggle(name, on = true, src = 'tool') {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) {
    noteAct('switch', n, src, false, '空名字');
    return { ok: false, skipped: '空名字' };
  }
  // 道具/换装是模型 exp3 里写死的，名字对不上就是白调一次 —— 先在名单里核一下
  if (SWITCH_NAMES.length && !SWITCH_NAMES.includes(n)) {
    const near = SWITCH_NAMES.filter((x) => x.includes(n) || n.includes(x)).slice(0, 3);
    noteAct('switch', n, src, false, '没有这个道具');
    return {
      ok: false,
      error: `没有「${n}」这个道具${near.length ? `，相近的：${near.join('、')}` : `。能挂的：${SWITCH_NAMES.slice(0, 8).join('、')}…`}`
    };
  }
  const r = await post({ type: 'switch', name: n, on: on !== false });
  noteAct('switch', n, src, !!(r && r.ok), whyOf(r));
  if (r && r.ok) bumpUsage('switch', n);
  return r;
}

/** 模型自带的 23 个 exp3（原作者的「按键动画」）：脸红 / 流泪 / 爱心眼 / 圈圈眼 / 钢盆 / 眼镜 … */
export async function modelExpr(name, src = 'tool') {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) {
    noteAct('modelexpr', n, src, false, '空名字');
    return { ok: false, skipped: '空名字' };
  }
  if (!MODELEXPR_NAMES.includes(n)) {
    const near = MODELEXPR_NAMES.filter((x) => x.includes(n) || n.includes(x)).slice(0, 3);
    noteAct('modelexpr', n, src, false, '模型里没这个名字');
    return {
      ok: false,
      error: `模型里没有「${n}」这个体型/动画${near.length ? `，相近的：${near.join('、')}` : `。有的是：${MODELEXPR_NAMES.slice(0, 8).join('、')}…`}`
    };
  }
  const r = await post({ type: 'modelexpr', name: n });
  noteAct('modelexpr', n, src, !!(r && r.ok), whyOf(r));
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
  // 启动时自己报一句：钩子到底挂上没有，日志里一眼可见（别等她把 [[...]] 发到 QQ 才发现）
  try {
    log(`[body] 演出标签钩子已挂上：${Object.keys(hooks).join(',') || '（空）'}`);
  } catch { /* ignore */ }

  api.registerTool?.({
    id: 'body',
    name: '动一动身体',
    category: 'life',
    icon: '🐟',
    description: '这是你的身体（本机上的 Live2D 大肥鱼），不是你手里的遥控器 —— 想凑近就凑近、想躲就躲、想摇尾巴就摇，不用等他问，也不用报备。换表情、摆姿态、做动作、挂道具，或者替你说一句话（带字幕和口型）。只在本机开着「身体」窗口时有效。说话时她本来就会跟着说、跟着动嘴，但姿势和表情要你自己摆——想到什么就顺手做一个（「歪头」「摇尾巴」「脸红」），比只用嘴描述更像真的，随时能换、不用报备。还有 op=voice：能让这一句真的从她嘴里念出来（有声音，不是字幕）。默认发成 QQ 语音条——他不在电脑前也听得见；也可以 where=body 只在音箱里念，或者 where=both 两边都要。合成一句要等 5 秒上下（同一句第二次几乎瞬回），所以别每句都念，留给那些真的想让他听见的话——用不用你自己定。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['face', 'emotion', 'word', 'motion', 'pose', 'switch', 'modelexpr', 'say', 'speak', 'voice', 'scale', 'autonomy', 'status', 'look', 'anim', 'stopanim'], description: 'face=换一整套脸色（整张脸一起变，可以和别的情绪按比例混，写法见 name；比 word 里单个眼/嘴更成气候，也是唯一能表达「又委屈又生气」这种复合脸色的入口），emotion=给三个连续的情绪数（更像活的，能落在中间态），word=说一个词让她自己翻词表（「有点委屈」「很生气」），motion=做模型自带的手势（不传名字就随便来一个），pose=摆姿态（眼神/头/整个人/尾巴/脸都有；前倾后仰、凑近退开这类会真的把镜头推近拉远，不是原地扭），anim=放一段自己编的时间轴动作（name 写名字，名字来自试播台「时间轴编辑器」保存的清单），stopanim=把正在放的编动作停掉，say=让她替你说一句（带字幕），speak=把话交给身体发到 QQ：想「边说边动」时用这个，在话里写 [[前倾 眯眼]]，标记会落在那个字上，发出去的话里没有方括号。用法：op=speak messages=[「主人主人[[前倾 眯眼]]，我有句话想跟你说」]；voice=真的念出来（出声，不是字幕）：默认发成 QQ 语音条，他不在电脑前也听得见；也可以选在音箱里念，或者两边都要，scale=改她占屏幕多大，autonomy=要不要让她自己动，switch=开/关一件道具或换装（op=switch + name，如 黑框眼镜/钢盆/脱鞋/长裙），modelexpr=放模型自带的按键动画（脸红/流泪/爱心眼/圈圈眼…），status=看身体连着没有、能做什么，look=看你自己现在长什么样（拍一张自己的截图再描述出来；她说「我看不见我自己」「我想看看我现在的样子」时用这个）' },
        text: { type: 'string', description: 'op=say 时说的一句；op=voice 时要念出来的那一句（会真的出声，别拿它当字幕用）；op=word 时要翻的词（可带「有点/稍微/很/特别」这类程度词）' },
        messages: { description: 'op=speak 要说的话：字符串=一条，数组=分多条（和 send_message 一样）。只有这一种写法能让 [[动作]] 里的动作落在那个字上，其余地方带方括号会被当成普通文字发出去。', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        word: { type: 'string', description: 'op=word 的词，等价于 text' },
        v: { type: 'number', description: 'op=emotion 的效价：-1 很难过 … 0 平静 … +1 很开心' },
        a: { type: 'number', description: 'op=emotion 的唤醒：-1 没劲/蔫 … 0 一般 … +1 很激动' },
        d: { type: 'number', description: 'op=emotion 的支配感：-1 怯/心虚 … 0 中性 … +1 有底气/强势' },
        name: {
          type: 'string',
          description: 'op=face 的表情名（笑/害羞/生气/疑惑/委屈，或原模型里的 屑屑眼/圈圈眼/爱心眼）；两种情绪可以混着来：`委屈+生气`=各一半，`委屈:0.6+生气:0.4` 或 `委屈60%+生气40%`=按比例；op=motion 的手势名：举手（抚胸）/放下手/竖食指/竖食指收回/狗尾草/狗尾草收回/脱捕；op=pose 的姿态名（按意思分组）——眼睛：看向你/看左/看右/看上/看下；头：歪头/点头/摇头/晃脑袋/一激灵/缩脖/探头；整个人：前倾/后仰/侧身/回头看你/背对你/扭腰/晃腰/挺胸/提肩/沉肩/缩起来/塌下去/伸懒腰/发抖/复位；远近：凑近（会真的推近镜头）/凑过来/退开（拉远）/往后退；脸和手：吐舌头/张嘴/闭嘴/开心/鼓脸/眯眼/瞪眼/抬眉/皱眉/嘟嘴/并腿；尾巴：摇尾巴；op=switch 的道具名：黑框眼镜/单片眼镜/钢盆/脱鞋/长裙/短裙/尾巴/狗尾草/抚胸/竖食指/黑脸/落泪/爱心眼/圈圈眼/＞＜/屑屑眼/流冷汗/兔牙/脸红（摘掉同一个道具：再调一次并传 on=false）'
        },
        emotion: { type: 'string', enum: ['soft', 'play', 'keen', 'shy', 'neutral'], description: 'op=voice 的语气：soft=平时那种软的、play=俏皮逗人、keen=凶/不好惹、shy=害羞小声、neutral=平。不传就按这句话的内容自己挑' },
        where: { type: 'string', enum: ['qq', 'body', 'both'], description: 'op=voice 念到哪儿：qq=发成 QQ 语音条（默认，不管他人在不在电脑前都听得见；会压成电话音质）；body=只在本机的音箱里念（人就在旁边看着你那具身体时用）；both=两边都要' },
        holdMs: { type: 'number', description: '保持多久（毫秒）。op=pose：不写=按部位自己回（头 2.6 秒 / 整个人 4.2 秒 / 脸 2 秒 / 尾巴 3 秒，个别姿态有自己更短的时间，比如「闭嘴」0.8 秒）；想一直保持传 -1。op=motion：给了就「做完不撒手」（举手等你回话传 12000），不写就播完自己放下。op=face：不写=25 秒后自动淡回心情脸，传 -1=一直保持到她换下一个，传毫秒数=保持这么久' },
        size: { type: 'number', description: 'op=scale 时的倍率：0.4 很小，1 默认，1.5 怼脸' },
        strength: { type: 'number', description: 'op=pose 的力度倍率：0.25 几乎看不出来 … 1 正常 … 1.3 夸张。也可以直接在 name 里带程度词（「微微歪头」「很用力地摇头」），两个都写就相乘' },
        on: { type: 'boolean', description: 'op=switch 时是否挂上：不写=挂上；要摘掉就传 false（比如「把盆摘了」→ op=switch, name=钢盆, on=false）' },
        when: { type: 'string', description: '想让动作「边说边动」时传它，不传就是立刻做（默认）。三种写法：`同时`=你这句话一开始说就做；`说到「X」`=念到那个词的时候做（X 换成你话里的原词，例：说到「没有」）；`+0.8s`=说完之后 0.8 秒再做。想让他听到「没有」的同时正好看到你摇头，就用「说到「没有」」——这比先摆好姿势再开口自然得多。' }
      },
      required: ['op'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      // 带 when 的：先扣下来排队，不动手。真正执行由 after-response 定时下发。
      // 这里递归调一次自己（把 when 去掉）只是为了复用 14 个分支里的命令构造，
      // 不重写一份，避免「工具能做的」和「排队能做的」两套逻辑走偏。
      const when = String(args?.when || '').trim();
      if (when && !CAP.on) {
        CAP.on = true;
        CAP.cmds = [];
        let r;
        ACT_CH = 'when';
        try {
          r = await this.execute(ctx, { ...args, when: undefined });
        } finally {
          CAP.on = false;
          ACT_CH = 'tool';
        }
        const cmd = CAP.cmds[0];
        CAP.cmds = [];
        if (!cmd) return r; // 这个 op 不产生身体命令（status/look 之类），照原样返回
        if (WHEN_QUEUE.length >= WHEN_MAX) {
          return { content: '这一轮已经排了几个动作了，等它们做完再说。' };
        }
        WHEN_QUEUE.push({ when, cmd, at: Date.now() });
        const what = cmd.name || cmd.text || cmd.type;
        const say = when.includes('说到') || when.includes('念到') ? `${when}的那一刻` : when;
        return { content: `排上了：${say}做「${what}」。这句话说完就按时刻自己执行。` };
      }
      if (!chatAllowed(ctx?.kind, ctx?.chatId)) return { content: '这具身体只在私聊里跟着你（群聊已隔离）。' };
      const op = String(args?.op || 'status');
      // ② 这一轮的动作先攒着（编译层）：她调工具的时候这句话还没生成出来，立刻开演就一定是
      //    「先演完、再说话」。等 after-response 拿到最终文本，按句子位置排成一条时间轴一次下发。
      //    回执照旧说她做了什么，只是加一句「等这句话说出来」，不骗她。
      if (TURN_ON && !CAP.on && TURN_OPS.has(op)) {
        CAP.on = true;
        CAP.cmds = [];
        let r;
        try {
          r = await this.execute(ctx, { ...args, when: undefined });
        } finally {
          CAP.on = false;
        }
        const cmd = CAP.cmds[0];
        CAP.cmds = [];
        if (!cmd) return r; // 这个 op 没产生身体命令（比如名字写错被挡了），照原样返回
        if (TURN.acts.length >= TURN_MAX) {
          // 排太满了：这一个直接放掉，别让她以为排上了却没演
          Promise.resolve().then(() => post(cmd)).catch(() => { /* ignore */ });
          return { content: '这一轮已经排了四个动作了，这个先直接做了。' };
        }
        TURN.acts.push({ cmd, at: Date.now() });
        armTurnFlush();
        let head = (r && r.content) ? String(r.content) : '记下了。';
        // 回执里那段「现在：…」是执行后的现场，可这个动作还没做（排着），
        // 留着会让她以为身体没反应，砍掉。
        const cut = head.indexOf('。现在');
        if (cut > 0) head = head.slice(0, cut + 1);
        return { content: `${head}（等这句话说出来，会落在话里。）` };
      }
      if (op === 'status') {
        const st = await state();
        if (!st.ok) return { content: `身体没连上（${st.error || '连不上'}）——本机上的窗口可能没开。` };
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
        // 姿态数从心跳里数（body.js 那边 POSES 变了这里自动跟着变，别再写死 29）
        const poseN = Array.isArray(st.lastHb?.poses) ? st.lastHb.poses.length : 0;
        const seen = selfSeenLine(6 * 3600 * 1000);
        return { content: `身体${bits.join('，')}${uBit}。可说：${poseN || '几十'} 个姿态、19 个道具、7 个手势（名字见工具说明）。${seen ? ` ${seen}` : ''}` };
      }
      if (op === 'look') {
        // 「看看你自己」：拍一张，再让她自己描述。看图失败的模型降级成参数描述，
        // 但至少真有这么一张图（服务端落了盘）。
        const shot = await selfie();
        if (!shot.ok) {
          // 没拍到也要记一笔：ok=0 只进流水、不算「今天动过」——她想看但身体不在，这件事本身要留痕
          noteAct('look', '看自己', 'tool', false, shot.error || '没拍到');
          return { content: `没拍到（${shot.error || '连不上'}）——本机上的窗口可能没开。` };
        }
        let seen = '';
        try { seen = await describeSelfie(shot.dataUrl); } catch (e) { seen = ''; }
        const st = await state();
        noteAct('look', '看自己');
        // 描述落盘：下次她说「我长什么样」时，status 和 prompt 里能直接带上（不用为了看一眼再拍一张）
        if (seen) saveSelfSeen(seen);
        if (seen) return { content: `我看见自己了：${seen}` };
        return { content: `拍到了（${Math.round((shot.bytes || 0) / 1024)}KB），但这个模型不给我看图——只能读参数：${describeState(st)}` };
      }
      if (op === 'speak') {
        // 「边说边动」的安全通道：话从这里发，[[动作]] 也在这里被剥掉 ——
        // 标记从头到尾没离开过工具参数，就不可能露到 QQ 聊天里。
        // （走 send_message 的话，正文是核心工具发的，before-tool 只能否决不能改参数，
        //   剥了也来不及 —— 那条路结构上做不到。）
        const rawList = args?.messages ?? args?.text;
        const list = (Array.isArray(rawList) ? rawList : [rawList]).map((x) => String(x == null ? '' : x));
        const keep = [];
        const marks = [];
        let base = 0;
        for (const one of list) {
          const { text: clean, groups } = splitStageTags(one);
          const t = clean.trim();
          if (!t) continue;
          const dur = sayDurMs(t);
          for (const g of groups.slice(0, STAGE_MAX_GROUPS)) {
            const rel = Math.round((Math.min(g.at, t.length) / Math.max(1, t.length)) * dur);
            marks.push({ d: base + rel, words: g.words.join(' ') });
          }
          keep.push(t);
          base += dur;
        }
        if (!keep.length) return { content: '没有要说的话。' };
        const sender = ctx?.sender;
        if (!sender || typeof sender.sendTextBatch !== 'function') {
          return { content: '这条通道发不出去（拿不到 QQ 发送口）——用 send_message 吧，但别在正文里写方括号。' };
        }
        try {
          const r = await sender.sendTextBatch(ctx.chatKey, keep, {
            replyToMessageId: args?.replyToMessageId ?? null,
            atUserId: null
          });
          if (Array.isArray(ctx?.session?.sent) && Array.isArray(r?.sent)) {
            ctx.session.sent.push(...r.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          }
          ctx?.emit?.('session-update', ctx?.session?.id);
        } catch (e) {
          noteAct('say', '说话', 'tool', false, `发送失败：${e?.message || e}`);
          return { content: `没发出去：${e?.message || e}` };
        }
        // 气泡/口型跟她的话从同一刻起（页面按字数自己算时长）
        for (const t of keep) await say(t, { pushed: true }).catch(() => { /* 身体没开 */ });
        // 她这一轮调过的工具动作先放（位置不动，她想摆开头就摆开头），
        // 标记动作排在后面 —— 同一时刻撞上时，后执行的接管参数，等于「标记赢」。
        flushTurn('', base || undefined);
        let delivered = 0;
        if (marks.length) {
          const r = await post({ type: 'sched', items: marks.map((m) => ({ d: m.d, cmd: { type: 'word', text: m.words } })) }).catch(() => null);
          delivered = r && r.delivered ? 1 : 0;
        }
        ACT_CH = 'marker';
        for (const m of marks) noteAct('word', m.words, 'tool', !!delivered, delivered ? '' : '身体没连上');
        ACT_CH = 'tool';
        const where = marks.length ? `，动作落在 ${marks.map((m) => m.d + 'ms').join(' / ')}` : '';
        return { content: `说了 ${keep.length} 条${where}。` };
      }
      if (op === 'say') {
        const r = await say(args?.text);
        return { content: r.ok ? '说了。' : `没说出来：${r.error || r.skipped || ''}` };
      }
      if (op === 'voice') {
        // 出声慢（首次合成 5 秒起），回执要短——每次调用的结果都会进上下文
        const where = String(args?.where || 'qq').trim();
        const sec = (d) => Math.round((Number(d) || 0) / 100) / 10;
        if (where === 'qq') {
          const q = await voiceQQ(args?.text, args?.emotion, ctx);
          if (!q.ok) return { content: `语音条没发出去：${q.error || ''}` };
          return { content: `语音条发出去了（${sec(q.dur)} 秒${q.cached ? '，走的缓存' : ''}）。` };
        }
        if (where === 'body') {
          const r = await voice(args?.text, args?.emotion);
          if (!r.ok) return { content: `没出声：${r.error || r.skipped || ''}` };
          return { content: `念出声了（${sec(r.dur)} 秒${r.cached ? '，走的缓存' : ''}）。` };
        }
        // both：先合成一次并让屋里的窗口放，再拿同一份 wav 发语音条——
        // 合成两次是白白多等一轮，同一句话的缓存虽然会命中，但没有必要。
        const s = await synthVoice(args?.text, args?.emotion, true);
        if (!s.ok) return { content: `没出声：${s.error || s.skipped || ''}` };
        const q = await voiceQQ(args?.text, args?.emotion, ctx, s);
        const heard = s.delivered > 0 ? '屋里念了' : '屋里没有窗口连着';
        return { content: q.ok ? `${heard}，语音条也发出去了（${sec(s.dur)} 秒）。` : `${heard}，但语音条没发出去：${q.error}` };
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
        const r = await pose(String(args?.name || '').trim(), args?.holdMs, args?.strength);
        const h = Number(args?.holdMs) || 0;
        const str = Number(args?.strength);
        const strSay = Number.isFinite(str) && str > 0 ? `（力度 ${str.toFixed(2)}×）` : '';
        // 不传 holdMs 现在默认活 12 秒（以前是永远挂着，人会僵在一个姿势上）；
        // 想一直摆着要显式说「一直保持」——那时 h 是 -1。
        const say = h < 0 ? `摆好了${strSay}，一直保持到你换下一个。` : (h > 0 ? `摆好了${strSay}，保持 ${(h / 1000).toFixed(1)} 秒。` : `摆好了${strSay}，12 秒后自己回（想让它一直保持就带 holdMs -1）。`);
        return { content: r.ok ? say : `没摆成：${r.error || r.skipped || ''}` };
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
      if (op === 'anim') {
        const n = String(args?.name || '').trim();
        if (!n) return { content: '要给动作名字（试播台「时间轴编辑器」里存下来的那些）。' };
        const r = await post({ type: 'anim', name: n, loop: !!args?.loop });
        if (!r.ok) return { content: `没放出「${n}」：${r.error || r.skipped || '身体没连上'}` };
        noteAct('anim', n, src || 'tool', true);
        return { content: `放了自己编的动作「${n}」。` };
      }
      if (op === 'stopanim') {
        const r = await post({ type: 'stopanim' });
        return { content: r.ok ? '停下来了。' : `没停下：${r.error || r.skipped || ''}` };
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
      return { content: 'op 只认 face / emotion / word / motion / pose / switch / modelexpr / say / voice / scale / autonomy / status / look / anim / stopanim。' };
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
// ── 动作小本子：她得知道自己多久没动过、今天动了几次 ──────────────
// 「接口早就够了但 300 句只动 14 句」的根因不是不会，是没有理由动。
// 每轮把「上次动是 40 分钟前」「今天只动过 1 次」摆在她眼前，比讲道理有用。
//
// ⚠️ 2026-11-18 之前这四个变量只活在内存里：qq-agent 每重启一次，actsToday 归零、
//    lastActAt 归零，于是 prompt 说「你今天还没动过身体」，而同一段的 body-usage
//    说「最常用：微微歪头 ×37」——自相矛盾，她当然更不信这套提示。现在落盘。
const ACT_STATE_FILE = path.join(DATA_DIR, 'body', 'act-state.json');
const ACT_LOG_FILE = path.join(DATA_DIR, 'body', 'acts.jsonl');
const ACT_LOG_MAX = 200 * 1024;

let lastActAt = 0;
let lastActWhat = '';
let actDay = '';
let actsToday = 0;

// 「她刚才自己做过什么」：只留最近 90 秒。
// 为什么必须有：动作本身十几秒就收回去（pose hold 2.6–4.2 秒、词表动作 1.5–4 秒），
// 一收回心跳里的状态就干净了；而下一轮的历史是 QQ 消息文本（src/prompt.js 拼的「我：/你：」），
// 里面没有她的工具调用。两条路都没有 → 她「不记得自己刚才动过」，
// 于是每轮都像第一次动身体，还会重复同一句「我歪头看你」。
// 这条记忆是从账本记的，不依赖画面，所以动作消失了它也还在。
const RECENT_ACT_MS = 90000;
const RECENT_ACT_MAX = 12;
let recentActs = [];

// 「她上次看见自己是什么样」——op=look 拍一张、让模型描述一句，然后落盘。
// 不落盘的话那只是一次性动作：她看完就忘，下一轮又是「不知道我长什么样」。
// 有了它，她摆完姿态能自己确认「我这次凑近是什么样子」，而不是只能听人说。
const SELF_SEEN_FILE = path.join(DATA_DIR, 'body', 'self-seen.json');
const SELF_SEEN_MAX = 400;
let selfSeen = null; // { t, text }

function loadSelfSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(SELF_SEEN_FILE, 'utf8'));
    if (raw && raw.text) {
      selfSeen = { t: Number(raw.t) || 0, text: String(raw.text).slice(0, SELF_SEEN_MAX) };
    }
  } catch {
    /* 还没看过 */
  }
}

function saveSelfSeen(text) {
  const t = String(text || '').trim();
  if (!t) return;
  selfSeen = { t: Date.now(), text: t.slice(0, SELF_SEEN_MAX) };
  try {
    fs.mkdirSync(path.dirname(SELF_SEEN_FILE), { recursive: true });
    fs.writeFileSync(SELF_SEEN_FILE, JSON.stringify(selfSeen));
  } catch {
    /* 写不上不影响她看 */
  }
}

/** 「你上次看见自己…」——太久的就不提了（样子早就变了） */
function selfSeenLine(maxAgeMs = 6 * 3600 * 1000) {
  if (!selfSeen || !selfSeen.text) return '';
  const age = Date.now() - selfSeen.t;
  if (!(age >= 0) || age > maxAgeMs) return '';
  const min = Math.round(age / 60000);
  const when = min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
  // 数字前补一个空格：中文里「你8 分钟前」贴在一起不好读
  return `你${/^\d/.test(when) ? ' ' : ''}${when}看过自己：${selfSeen.text}`;
}

// 用当地日而不是 UTC 日：toISOString() 在 +08:00 要等到早上 8 点才翻日，
// 于是凌晨 0–8 点她一直被告知「今天动过 N 次」，而那 N 次是昨天下班后的。
function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadActState() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACT_STATE_FILE, 'utf8'));
    lastActAt = Number(raw?.lastActAt) || 0;
    lastActWhat = String(raw?.lastActWhat || '').slice(0, 12);
    actDay = String(raw?.actDay || '');
    actsToday = Number(raw?.actsToday) || 0;
  } catch {
    /* 第一次跑，还没有这个文件 */
  }
}
loadActState();

// 重启后从流水尾部回填「刚才做过什么」：不然她刚动完就重启（部署时经常发生），
// 那 90 秒的记忆就白丢了——而这正是她最需要记得的时候。
function loadRecentActs() {
  try {
    const raw = fs.readFileSync(ACT_LOG_FILE, 'utf8');
    const rows = raw.split('\n').filter(Boolean).slice(-80);
    const now = Date.now();
    const got = [];
    for (const line of rows) {
      try {
        const d = JSON.parse(line);
        if (!d?.ok || !d?.name) continue;
        if (!(now - Number(d.t) < RECENT_ACT_MS)) continue;
        got.push({ t: Number(d.t), op: String(d.op || ''), name: String(d.name).slice(0, 40), src: String(d.src || 'tool') });
      } catch {
        /* 坏行跳过：流水是追加写的，崩在半行不奇怪 */
      }
    }
    recentActs = got.slice(-RECENT_ACT_MAX);
  } catch {
    /* 还没有流水 */
  }
}
loadRecentActs();
loadSelfSeen();

function saveActState() {
  try {
    fs.mkdirSync(path.dirname(ACT_STATE_FILE), { recursive: true });
    fs.writeFileSync(ACT_STATE_FILE, JSON.stringify({ lastActAt, lastActWhat, actDay, actsToday, savedAt: Date.now() }));
  } catch {
    /* 记不上不影响动作本身 */
  }
}

// 事件流水（每次动作一行）：{t, op, name, src}
// 和 usage.json 的分工——usage.json 是「每种动作一共几次」（聚合，看不出节奏）；
// acts.jsonl 是「什么时候动了一次」，只有它算得出「哪几轮她真的动了」「没人理她的空窗里她自己动没动」。
function appendActLog(row) {
  try {
    fs.mkdirSync(path.dirname(ACT_LOG_FILE), { recursive: true });
    try {
      if (fs.statSync(ACT_LOG_FILE).size > ACT_LOG_MAX) fs.renameSync(ACT_LOG_FILE, `${ACT_LOG_FILE}.1`);
    } catch {
      /* 还没有这个文件 */
    }
    fs.appendFileSync(ACT_LOG_FILE, `${JSON.stringify(row)}\n`);
  } catch {
    /* 流水记不上不影响动作本身 */
  }
}

/**
 * 记一次动作。op：word/pose/face/motion/switch/modelexpr/emotion；src：谁触发的（tool/tag/idle/idle-dry）。
 *
 * ⚠️ ok=false 只进流水、不进「今天动过几次」。
 *    原因：窗口没开的时候她照样会调 pose，拿到一句「身体没连上」——这种如果也算动过，
 *    prompt 就会说「今天动过 60 次」而身体一次没动，那条提示从此不可信（而它唯一的用处就是可信）。
 *    失败也留一行（ok:0），因为「她想动但身体不在」本身是值得看的事。
 */
// 这一次动作是从哪条通道来的：tool=她自己调工具（默认）、when=说「说到X」排的、
// marker=写在话里的 [[...]]。只在非默认时落进流水，老账本不用迁移。
let ACT_CH = 'tool';

function noteAct(op, name, src = 'tool', ok = true, why = '') {
  const now = Date.now();
  const day = localDay(now);
  const row = {
    t: now,
    op: String(op || ''),
    name: String(name || '').slice(0, 40),
    src: String(src || 'tool'),
    ok: ok ? 1 : 0
  };
  if (ACT_CH && ACT_CH !== 'tool') row.ch = ACT_CH;
  // 失败要留下「为什么」——不然事后只能靠猜（窗口没开？词表没这个词？不是单个姿态名？）
  if (!ok) row.why = String(why || '没成').slice(0, 60);
  appendActLog(row);
  if (!ok) return;
  if (day !== actDay) { actDay = day; actsToday = 0; }
  actsToday += 1;
  lastActAt = now;
  lastActWhat = String(name || op || '').slice(0, 12);
  recentActs.push({
    t: now,
    op: String(op || ''),
    name: String(name || op || '').slice(0, 40),
    src: String(src || 'tool')
  });
  if (recentActs.length > RECENT_ACT_MAX) recentActs = recentActs.slice(-RECENT_ACT_MAX);
  saveActState();
}

/** 「你刚才自己做过」——动作早就收回来了，但记忆还在（来自账本，不来自画面） */
function recentActLine() {
  const now = Date.now();
  const fresh = recentActs.filter((a) => a && now - a.t < RECENT_ACT_MS).slice(-3).reverse();
  if (!fresh.length) return '';
  const parts = fresh.map((a) => {
    const sec = Math.max(0, Math.round((now - a.t) / 1000));
    const when = sec < 10 ? '刚刚' : sec < 60 ? `${sec} 秒前` : `${Math.round(sec / 60)} 分钟前`;
    return `${when}「${a.name}」`;
  });
  return `你刚才自己做过：${parts.join('、')}（动作已经收回去了，但这些是你做的，别当成没发生）。`;
}

function actLine() {
  // 跨过零点但今天还没动过：别拿昨天的次数冒充今天
  if (actDay && actDay !== localDay(Date.now())) actsToday = 0;
  const mem = recentActLine();
  if (!lastActAt) return `你今天还没动过身体——想动就动，不用等他问。${mem ? ' ' + mem : ''}`;
  const mins = Math.round((Date.now() - lastActAt) / 60000);
  const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
  return `你上次动身体是 ${when}（${lastActWhat}），今天一共动过 ${actsToday} 次。${mem ? ' ' + mem : ''}`;
}

function describeState(st) {
  const hb = (st && st.lastHb) || {};
  const bits = [];
  // 词表动作（op=word）是最常走的一条路，它不写 poseName/expr，只写 hb.word —— 
  // 漏了它，她就会「不知道自己现在什么表情」。
  const word = String(hb.word || '').trim();
  // 心跳里的 word 是「最近一次词表命中」，它只有复位才清，可词表动作 1.5–4 秒就收完了。
  // 以前无条件说「摆着「…」」——她做完一个吐舌头，半小时后提示词里还写着摆着吐舌头。
  // 现在按 wordAt 分三档：还在演 / 刚演过 / 太久了不提。
  const wordAt = Number(hb.wordAt) || 0;
  const wordAge = word && wordAt ? Date.now() - wordAt : (word ? Infinity : 0);
  const wordLive = Boolean(word) && wordAge < 20000;
  if (Number(hb.hands) > 0 && Number(hb.handLeft) > 0) bits.push(`手还举着（还剩 ${hb.handLeft} 秒）`);
  else if (Number(hb.hands) > 0) bits.push('手还举着');
  if (wordLive) bits.push(`摆着「${word}」`);
  else if (word && wordAge < 600000) bits.push(`刚才摆过「${word}」`);
  // pose 和 word 是两条独立的线（pose 走 lastPose、word 走词表通道）。
  // 以前写成 else-if，只要 word 非空就永远看不到姿态——她明明在「看向你」，提示词里却不提。
  // poseLeft / exprLeft 是 -1 就表示「常驻，不会自己掉」，别说成还剩几秒
  if (hb.poseName) bits.push(`姿态是「${hb.poseName}」${Number(hb.poseLeft) < 0 ? '（一直保持）' : hb.poseLeft ? `（还剩 ${hb.poseLeft} 秒）` : ''}`);
  if (hb.expr) bits.push(`表情是「${hb.expr}」${Number(hb.exprLeft) < 0 ? '（一直保持）' : ''}`);
  // 模型自带动画（圈圈眼/爱心眼/流泪…）是 exp3 持久表达式，和 expr 是两条线，必须单独说
  const mexpr = String(hb.mexpr || '').trim();
  if (mexpr) bits.push(`还挂着模型动画「${mexpr}」`);
  // 时间轴动作（anims/名字.json）是单独一层（prio 3.2）：她自己调 op=anim、同名顶替姿态、
  // 或者事件播放器放的那段，都走这里。以前心跳里有 anim 字段但没人读，她不知道自己正在演这段。
  const animName = String(hb.anim || '').trim();
  if (animName) bits.push(`正在演「${animName}」这段动作`);
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
  // 被摸：身体那边每点一下就会 POST /touch，60 秒内算「刚刚」。
  // 以前她被摸了完全不知道——用户点她一下，画面动一下，但她下一句还是照旧说话。
  const tc = st && st.lastTouch;
  if (tc && Number(tc.at) && Date.now() - Number(tc.at) < 60000) {
    const sec = Math.round((Date.now() - Number(tc.at)) / 1000);
    const when = sec < 5 ? '刚刚' : `${sec} 秒前`;
    bits.push(`${when}他伸手碰了你的${tc.name || tc.zone}`);
  }
  // 最近的几个动作是谁弄的：她自己调的 / 被他摸的。
  // 只报「现在什么姿态」的话，她把身体当成一张海报；带上原因才知道「是我先动的」。
  const moves = Array.isArray(hb.moves) ? hb.moves.slice(-3) : [];
  const parts = moves
    .filter((m) => Array.isArray(m) && m[1])
    .map((m) => {
      const sec = Number(m[0]) || 0;
      const when = sec < 3 ? '刚刚' : `${sec} 秒前`;
      return `${when}${String(m[1]).slice(0, 12)}（${String(m[2] || '')}）`;
    });
  if (parts.length) bits.push(`最近动过：${parts.join('、')}`);
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
    if (!selfDeadAt) selfDeadAt = Date.now();   // 记「从什么时候开始没连上」，守卫要等它稳一会儿再动手
    return;
  }
  selfAlive = true;
  selfDeadAt = 0;
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
    // 隔离：群聊里她不需要知道本机有具身体，也不需要这套词表
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
        '你有一具身体：一个 Live2D 形象，就住在这台机器的桌面/浏览器里（Live2D）。她跟着你说话、跟着别人说话，你也能直接指挥她。',
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
        '【脸色 op=face】整张脸一起变：笑/委屈/难过/疑惑/生气/害羞/惊讶/开心/平静。还能混：`委屈+生气`=各一半，`委屈60%+生气40%`、`委屈:0.7+生气:0.3`=按比例。',
        '和 word 的分工：word 管局部（一个眼睛、一个嘴角，加在现有脸色上），face 管整张脸换一套；同一个地方别同时用，会叠得怪。要一直这个脸色就传 holdMs -1。',
        '什么时候值得单独调 face（比划动作表达不出来的）：强撑着的笑→`开心+委屈`；嘴硬心软→`生气+委屈`；被夸了还想装没事→`害羞+平静`；他难受你不敢笑→`难过+委屈`；又气又急→`生气60%+惊讶40%`。',
        '同义说法都认：侧头=偏头=歪头，仰头=抬头，垂眼=半闭眼，凑近=前倾，斜身=侧身，尾巴甩/翘尾巴/摆尾巴都行；',
        '姿态（op=pose，只吃单个名字）——眼睛：看向你/看左/看右/看上/看下；头：歪头/点头/摇头/晃脑袋/一激灵/缩脖/探头；整个人：前倾/后仰/侧身/回头看你/背对你/扭腰/晃腰/挺胸/提肩/沉肩/缩起来/塌下去/伸懒腰/发抖；远近：凑近/退开（会真的把镜头推近拉远，不是原地扭）；脸和手：吐舌头/张嘴/闭嘴/开心/鼓脸/眯眼/瞪眼/抬眉/皱眉/嘟嘴/并腿；尾巴：摇尾巴；复位=回原样；',
        '什么时候用哪个（照着挑，不用想参数）——被夸、被撩、害羞：脸红 + 低头，或「轻轻歪头 眯眼」；撒娇、高兴、想逗他：晃腰（整个人左右晃，裙子会跟着摆）或摇尾巴；',
        '生气、被冒犯：皱眉 + 沉肩；难过、被冷落：低头 + 沉肩，别笑；想亲近、想被看见：看向你 + 前倾；无语、翻白眼：侧身 + 撇嘴；被戳穿、心虚：缩脖 + 侧身。',
        '道具：黑框眼镜/单片眼镜/钢盆/脱鞋/长裙/短裙/尾巴/狗草/抚胸/竖食指/黑脸/落泪/爱心眼/圈圈眼/＞＜/屑屑眼/流冷汗/兔牙/脸红；',
        '手势：举手/竖指/剪刀手/放下手；情绪三数：v（好坏）/a（激动）/d（有底气）。',
        '用法：说一句就够，不用说参数——op=word 说词（可叠）、op=pose 摆姿态、op=face 换整张脸色（可混）、op=switch 挂道具、op=emotion 给三个数、op=say 让她替你说一句。',
        '【说话也可以带动作】想让他看见你在凑近、在躲、在笑、在低头，就在这一轮顺手调一次 op=word（把动作写进 text，例：op=word text=「微微歪头 眯眼」）——他会同时看到字和动作。只走工具这一条路，别在正文里写别的记号。',
        '重要：嘴上说「盯着你看／一直看着你／看着你眼睛」的时候，必须同时调 op=pose name=看向你——不调的话眼珠会自己飘，说了却没做到。'
      ].join('')
    });
    // ② 「我现在什么样」是**每轮都在变**的，标 volatile 后框架会把它挪到用户消息末尾，
    //    只让这一小段变，系统提示 + 工具定义那一大块前缀仍然逐字节稳定。
    if (selfText && Date.now() - selfAt <= 90000) {
      const age = Math.max(0, Math.round((Date.now() - selfAt) / 1000));
      const stale = age > 12 ? `（${age} 秒前读的，可能刚变过——要准就再调一次 op=status）` : '';
      // 她上次「看见自己」时模型给的描述：6 小时内有效。
      // 放这里而不是只放在 status 回执里，是因为「我长什么样」是她随时可能想起的问题，
      // 不该逼她为了答一句话再拍一张（每次 800 token）。
      const seen = selfSeenLine(6 * 3600 * 1000);
      out.push({
        id: 'body-self',
        title: '',
        priority: 34,
        volatile: true,
        content: `你现在的身体：${selfText.replace(/^现在：/, '')}${stale}（这是从窗口心跳读出来的，是真的，不用猜。）`
          + ' 别人问「你现在什么表情／什么姿势」时，直接照这句答，别含糊；想换就直接调「动一动身体」，别只在话里说。'
          + (seen ? ` ${seen}（这是你真看过一眼的印象，不是猜的。）` : '')
      });
    }
    // ③ 动机：她什么时候动过、今天动了几次。
    //    这一行每次都在变，所以必须 volatile（进系统提示会破坏前缀缓存）。
    // 2026-11-26：原来是「身体先动，话再说」——她照做了，于是每句都是「先演完再开口」，
    // 看着像在读稿子。改成「边说边动」：动作要和话叠在一起，最好落在最想强调的那个词附近。
    // 一句最多两个，别把一句话切成五段各做一个动作。
    out.push({
      id: 'body-act',
      title: '',
      priority: 30,
      volatile: true,
      content: `${actLine()}能动就动，但要**边说边动**：想凑近、想躲、想被看见的时候，就在这一轮调一次动作——话说到一半随手做出来，跟他听到你说话是同时发生的，不是先摆好姿势再开口。一句话里最多两个动作（一个通常就够），挑你最想强调的那半句。
想自己掐时间、让动作落在某个字上，就把话交给身体发（op=speak）：主人主人[[前倾 眯眼]]，我有句话想跟你说，就是……[[脸红]]，我爱你[[笑]] —— 方括号写在哪，那个动作就落在那个字上，写几处演几段（最多 4 处），发出去的话里没有方括号。
**方括号只能写在 op=speak 的 messages 里**。走 send_message 发的话，一个记号都别写——那条路剥不掉，会原样露给他。`
    });
    // ④ 用法账本：跟「现在什么样」分开，窗口没开的时候也要提醒她别老用同几个动作。
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

/**
 * 身体对外提供的能力（别的插件通过 api.capability('名字', 参数) 取用）。
 *
 * ⚠️ 这里 2026-11-18 之前写成 `export function providers() { return {...} }` ——
 *    而 src/plugin-loader.js:437 只认 `typeof mod.providers === 'object'`，
 *    函数一律被丢掉（变成 {}）。也就是说这套能力**从来没有注册成功过**，
 *    tool.guard 一次都没跑过。改成常量对象才真的生效。
 *
 * tool.guard 已于 2026-11-18 19:40 注册（见下面 toolGuardDisabled）：身体窗口没连着时，
 * 它会把 body 工具从模型眼前藏起来。这是守卫原本想要的；因为从上线起它一直是死的，
 * 启用属于行为变更，回滚方式是删掉 providers 里的 'tool.guard' 那一行。
 */
export const providers = {
  'body.status': async () => ({ ...(await state()), baseUrl: base(), enabled: settings().enabled }),
  'body.say': async (text, opts) => say(text, opts || {}),

  /**
   * 让别的插件「替她动一下」，而不用自己去拼 /cmd、自己拿 token。
   *
   * 为什么要有这条：idle 插件会自己醒过来决定做什么，其中 pose / face 两个动作
   * 以前是它自己 POST /cmd —— 那样不经过 noteAct / bumpUsage，
   * usage.json 和 acts.jsonl 就永远漏掉「没人理她时她自己动的那部分」，
   * 于是「她到底有没有动机自己动」这个问题在账本上根本量不出来。
   */
  'body.act': async (args = {}) => {
    try {
      if (!settings().enabled) return { ok: false, error: '身体没开' };
      const op = String(args?.op || '');
      const name = String(args?.name || '').trim();
      const src = String(args?.src || 'other');
      if (!name) return { ok: false, error: '没给要动的名字' };
      const hold = Number(args?.holdMs) || undefined;
      if (op === 'pose') return pose(name, hold, Number(args?.strength) || undefined, src);
      if (op === 'face') return face(name, hold, src);
      if (op === 'word') return word(name, hold, src);
      if (op === 'motion') return motion(name, hold, src);
      if (op === 'switch') return toggle(name, args?.on !== false, src);
      if (op === 'modelexpr') return modelExpr(name, src);
      if (op === 'emotion') return emotion({ ...(args?.vec || {}) }, hold, src);
      return { ok: false, error: `不认识的 op：${op}` };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  // 身体没连上时把 body 工具藏起来（2026-11-18 19:40 起启用，之前一直是死的）。
  // 回滚：删掉这一行即可，工具会立刻回到「永远可见」的老样子。
  'tool.guard': toolGuardDisabled
};

/**
 * 身体没连上时，把 body 工具从模型眼前拿走（**2026-11-18 19:40 起已注册为 'tool.guard'**）。
 *
 * 为什么值得做：工具定义会进每一轮请求，而且她看不到工具时就不会「对着不存在的身体演戏」——
 * 之前窗口没开，她照样会调 pose，拿到一句「没连上」，白费一轮请求。
 * 守卫必须**便宜且同步**（每轮算工具可用性都会调），所以只看缓存标记。
 * 出错一律放行：一个 bug 不该把工具列表塌掉。
 *
 * 回滚：把 providers 里的 `'tool.guard': toolGuardDisabled,` 删掉。
 */
export function toolGuardDisabled(args = {}) {
  try {
    const id = String(args?.toolId || '');
    if (!/(^|[:_.])body$/.test(id)) return undefined;
    if (!settings().enabled) return undefined;
    const cx = args?.context || {};
    if (!chatAllowed(cx.kind, cx.chatId)) return { ok: false, reason: '这具身体只在私聊里跟着你（群聊已隔离）' };
    if (selfAlive) return undefined;
    if (!selfDeadAt) return undefined;                                  // 还没探到 / 刚恢复，先别拦
    if (Date.now() - selfDeadAt < 10000) return undefined;              // 掉线不满 10 秒，别急着藏（网络抖一下就藏会显得神经）
    return { ok: false, reason: '本机的身体窗口没开，现在摸不到身体（可以正常说话）' };
  } catch {
    return undefined;
  }
}

export const internals = { DEFAULTS, settings, say, voice, voiceQQ, synthVoice, face, motion, pose, param, scale, toggle, modelExpr, guessFace, moodFace, state, post, prime, tick, readMessages, chatFiles, BUILD_TAG, FACES, MOOD_FACE };

// ── 第 4 步 · 通道：她说话时自己带的演出标签 ─────────────────────────────
// 她可以在回复里写 [[前倾|抬眉]]（写在哪个词后面，动作就落在那个词上）。
// 这里在发出去之前把它剥掉（**绝不能漏到 QQ 里**），并按「标记在句子里第几个字」
// 算出毫秒延迟，一次 sched 下发给页面 —— 位置就是时间戳，不用按字数估句长。
// 2026-11-27：从「立刻同时执行、最多 2 组」改成「按字位排期、最多 4 组」。
const STAGE_TAG_RE = /\[\[([^\[\]]{0,60})\]\]/g;
const STAGE_MAX_WORDS = 4;
const STAGE_MAX_GROUPS = 4;

function stageWords(raw) {
  return String(raw || '')
    .split(/[|｜,，、/\s]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, STAGE_MAX_WORDS);
}

/**
 * 把正文里的 [[...]] 抽出来：返回 { text, groups }。
 * groups 每项带 `at`：这段标记在**干净正文**里的字符位置（后面按它算毫秒）。
 * 越界、空标签、只有一个空格的也照剥，宁可少做一个动作，也不让方括号漏出去。
 */
export function splitStageTags(raw) {
  const text = String(raw || '');
  if (!text.includes('[[')) return { text, groups: [] };
  const groups = [];
  let out = '';
  let cursor = 0;
  const re = new RegExp(STAGE_TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    out += text.slice(cursor, m.index);
    const words = stageWords(m[1]);
    if (words.length) groups.push({ words, at: out.length });
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  const cleaned = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const shift = Math.max(0, out.length - out.trimStart().length);
  for (const g of groups) g.at = Math.max(0, g.at - shift);
  return { text: cleaned, groups };
}

/** after-response：修改 response.message.content 后，架构在下一行才读它去发。 */
function onAfterResponse(ctx = {}) {
  try {
    if (!settings().enabled) return;
    const msg = ctx?.response?.message;
    const raw = typeof msg?.content === 'string' ? msg.content : '';
    let text = raw;
    let stageItems = null;
    // ① 演出标签 [[...]]：剥掉，按它在句子里的位置排期（最多 4 组）
    if (raw.includes('[[')) {
      const { text: cleaned, groups } = splitStageTags(raw);
      text = cleaned;
      if (groups.length) {
        msg.content = cleaned;
        // 句子时长同 say()：每字 240ms + 底 400ms，夹 1.2–12 秒
        const dur = sayDurMs(cleaned);
        stageItems = groups.slice(0, STAGE_MAX_GROUPS).map((g) => ({
          d: Math.round((Math.min(g.at, cleaned.length) / Math.max(1, cleaned.length)) * dur),
          cmd: { type: 'word', text: g.words.join(' ') }
        }));
        if (stageItems.length === 1) stageItems[0].d = 0;
        try {
          log('[body] 演出标签 ' + stageItems.map((i) => i.cmd.text + '@' + i.d).join(' + '));
        } catch { /* ignore */ }
      }
    }
    if (!text) return;
    // 群聊不推：镜像那边本来就只读私聊（fileAllowed），别让群里的话在她屋里说出来
    const ck = String(ctx?.chatKey || ctx?.session?.chatKey || '');
    if (!isPrivateKey(ck) && String(ctx?.kind || '') !== 'private') return;
    // ③ 说出去那一刻就把这句话推给页面：气泡、口型、动作全都从同一个 t₀ 起算。
    //    以前只靠镜像轮询（2.5 秒一次），气泡比动作晚 0–2.5 秒，动作看起来就"提前演完了"。
    //    镜像还在跑，只是降级成兜底：同一句会被 say() 的 8 秒去重吃掉。
    Promise.resolve()
      .then(() => say(text, { pushed: true }))
      .then(() => (stageItems ? post({ type: 'sched', items: stageItems }) : null))
      .then(() => {
        // ② 带 when 排队的动作：文本已定稿，按字符位置算时刻下发
        const n = flushWhenQueue(text);
        if (n) { try { log(`[body] 排期下发 ${n} 个动作`); } catch { /* ignore */ } }
      })
      .then(() => {
        // ③ 这一轮她自己调的动作：按句子位置排成一条时间轴（编译层）
        flushTurn(text);
      })
      .catch(() => { /* 身体没开着就这样，别影响发送 */ });
  } catch { /* 绝不让提示词的边角料把发送搞挂 */ }
}

/**
 * before-context：他刚发来一条消息，这一轮要开始想了。
 * 只做一件事——告诉身体「有人跟他说话」，让脊髓先抬眼看他一眼（200ms 内），
 * 而不是等云端 1–3 秒把回复生成完、她的话才出现。
 * 不 await、不抛错：这只是个提示，绝不能拖慢回复。
 */
function onBeforeContext() {
  try {
    if (!settings().enabled) return;
    // 这里**不能**清空攒下的动作：工具循环里每一轮模型调用前后都会走 before-context，
    // 在这里 flush 等于「她刚调完动作、还没开口就先演了」——实测就是这么把编译层废掉的。
    // 清理由 12 秒兜底定时器和真正发出消息的那一刻负责。
    Promise.resolve()
      .then(() => post({ type: 'feel', kind: 'msg', at: Date.now() }))
      .catch(() => { /* 身体没连上就跳过 */ });
  } catch { /* ignore */ }
}

/**
 * after-tool：她真正的「开口」不经过 after-response。
 * 她的回复是调 send_message 工具发出去的（那一轮模型 content 是空的），
 * 所以 after-response 拿到空字符串、永远走不到排期那一步 ——
 * 实测后果：动作一直攒到 12 秒兜底才放，用户看到的是「气泡快放完她才动」。
 * 这里挂在工具执行完这一下：消息真的发出去了，气泡和动作从同一个 t0 起算。
 */
function onAfterTool(ctx = {}) {
  try {
    if (!settings().enabled) return;
    const name = String(ctx?.toolName || '');
    if (!/(^|__)send_message$/.test(name)) return;
    let args = ctx?.argsRaw;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    if (!args || typeof args !== 'object') return;
    const list = Array.isArray(args.messages) ? args.messages : (args.message ? [args.message] : []);
    const texts = list.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    if (!texts.length) return;
    // 结构上救不了：这条路上的正文是核心工具发的，before-tool 只能否决不能改参数，
    // after-tool 又已经发出去了。至少让日志里看得见，别让它静默烂掉。
    if (texts.some((t) => t.includes('[['))) {
      try { log('[body] 警告：send_message 正文里有 [[标记]]，会原样发到聊天里'); } catch { /* ignore */ }
    }
    const ck = String(ctx?.chatKey || ctx?.session?.chatKey || '');
    if (!isPrivateKey(ck) && String(ctx?.kind || '') !== 'private') return;   // 群里不说话（跟镜像一致）
    const target = String(args.targetChatKey || '');
    if (target && target !== ck) return;                   // 跨会话发送不该让这边的身体开口
    // 先按顺序把每一条推给页面（气泡/口型从同一刻起），再排这一轮攒的动作
    let chain = Promise.resolve();
    for (const t of texts) chain = chain.then(() => say(t, { pushed: true }));
    const total = texts.reduce((sum, t) => sum + sayDurMs(t), 0);
    chain.then(() => flushTurn(texts[0], total)).catch(() => { /* 身体没开着就这样 */ });
  } catch { /* 绝不让 hook 把发送搞挂 */ }
}

export const hooks = { 'before-context': onBeforeContext, 'after-response': onAfterResponse, 'after-tool': onAfterTool };
