// Live2D 身体：渲染 + 听命令
const HUD = document.getElementById('hud2');
const BUBBLE = document.getElementById('bubble');
const MOUTH_ID = 'ParamMouthOpenY';

let app = null;
let model = null;
let physSwing = 1;   // 「手感」面板里的动作幅度倍率（晃腰/摇尾巴等波形共用）
let mouth = 0;          // 当前嘴张合 0..1
let talkingUntil = 0;   // 说话到什么时候（时间戳）
let talkSeed = Math.random() * 10;
let bubbleTimer = null;
let lastCommandAt = 0;
let lastSayAt = 0;      // 上一次说话的时刻（诊断用）
let wsRef = null;       // 当前 WS 连接（诊断用）
let dragDowns = 0;      // 桌面版按下过多少次（诊断用：不涨说明鼠标事件没到页面）

// ===== 姿态通道（param）：白名单参数 + 保持时长 =====
// 模型有 509 个参数，但真让她随便写会炸形；这里只放行「看起来还是她、只是表情/视线/尾巴变了」的那些。
const POSE_PARAMS = new Set([
  'ParamEyeBallX', 'ParamEyeBallY',            // 眼珠看向哪
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', // 头：左右 / 上下 / 歪
  'ParamBodyAngleX', 'ParamBodyAngleZ',        // 身体
  'ParamBreath',                               // 呼吸幅度
  'ParamMouthOpenY', 'ParamMouthForm',         // 嘴
  'Mouthpucker', 'MouthFunnel',                // 鼓脸 / 漏斗嘴
  'TongueOut',                                 // 吐舌头
  // 这套皮的自定义轴（cdi3 的「身体轴」组）：头的真角度在这里，ParamAngle* 只是兼容位
  'AngleXbs', 'AngleYbs', 'AngleXbs3', 'AngleXbs2', 'AngleYbs2',
  'ParamBodyAngleY', 'HipAngleZ', 'HipAngleX', 'HipAngleY',
  'ShoulderX', 'ShoulderY', 'ShoulderZ', 'ShoulderYy',
  'Param50', 'Param53', 'Param54',             // Lean Y 1/2/3
  'Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86',
  'Param_Angle_Rotation87', 'Param_Angle_Rotation88', 'Param_Angle_Rotation89' // 尾巴 6 节
]);

const TAIL_IDS = [
  'Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86',
  'Param_Angle_Rotation87', 'Param_Angle_Rotation88', 'Param_Angle_Rotation89'
];

// 这套皮的「表情」其实是一堆开关（key1..key13、Clothes*、眼镜、兔牙…），
// 而真正的情绪是参数组合：Angry / EyeSmile / MouthSmile_L/R / ParamBrowL*。
// 所以她说的「开心」「委屈」这类词，得我们自己拼参数——否则 model.expression('委屈')
// 直接返回 false，画面一动不动，看着就像「表情一帧就换完/根本没换」。
const EMOTIONS = {
  // 幅度都往满里写：脸在 460 宽的窗口里只有一百多像素，写七分看不出来。
  // 除了脸，还带一点头/身体的姿态（ParamAngleZ、ParamBodyAngleZ），不然远看完全一样。
  '开心': { EyeSmile: 1, MouthSmile_L: 1, MouthSmile_R: 1, ParamMouthForm: 1, ParamBrowLY: 0.5, ParamBrowRY: 0.5, CheeksWiggleY: 0.7, ParamAngleZ: 4, ParamAngleY: 2 },
  '笑': { EyeSmile: 1, MouthSmile_L: 1, MouthSmile_R: 1, ParamMouthForm: 1, ParamBrowLY: 0.4, ParamBrowRY: 0.4, ParamAngleZ: 3 },
  '委屈': { EyeSmile: 0, MouthSmile_L: -1, MouthSmile_R: -1, ParamMouthForm: -1, ParamBrowLY: 1, ParamBrowRY: 1, ParamBrowLAngle: 1, ParamBrowRAngle: 1, BrowInnerUp: 1, ParamAngleY: -4 },
  '难过': { EyeSmile: 0, MouthSmile_L: -1, MouthSmile_R: -1, ParamMouthForm: -1, ParamBrowLY: 1, ParamBrowRY: 1, BrowInnerUp: 1, ParamAngleY: -5, ParamAngleZ: -3 },
  '疑惑': { ParamBrowLY: 1, ParamBrowRY: -1, ParamBrowLAngle: -1, ParamBrowRAngle: 0.5, ParamMouthForm: -0.4, ParamMouthOpenY: 0.15, ParamAngleZ: 7, ParamBodyAngleZ: 3 },
  '生气': { Angry: 1, Angry3: 1, ParamBrowLAngle: 1, ParamBrowRAngle: 1, ParamMouthForm: -1, Mouthpucker: 0.4, ParamEyeLOpen: 0.6, ParamEyeROpen: 0.6, ParamAngleY: -3, ParamBodyAngleX: 3 },
  '害羞': { CheeksWiggleX: 1, CheeksWiggleY: 1, ParamMouthForm: 0.6, EyeSmile: 0.7, ParamBrowLY: 0.5, ParamBrowRY: 0.5, ParamAngleY: -3, ParamAngleZ: 5 },
  '惊讶': { ParamBrowLY: 1, ParamBrowRY: 1, ParamMouthOpenY: 1, BrowInnerUp: 1, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamAngleY: 3 },
  '平静': { EyeSmile: 0, MouthSmile_L: 0, MouthSmile_R: 0, ParamMouthForm: 0, ParamBrowLY: 0, ParamBrowRY: 0, ParamMouthOpenY: 0, ParamBrowLAngle: 0, ParamBrowRAngle: 0, BrowInnerUp: 0, CheeksWiggleY: 0, ParamAngleZ: 0, ParamAngleY: 0, ParamBodyAngleZ: 0 }
};
for (const emo of Object.values(EMOTIONS)) for (const id of Object.keys(emo)) POSE_PARAMS.add(id);
POSE_PARAMS.add('Angry').add('EyeSmile').add('BrowInnerUp').add('CheeksWiggleX').add('CheeksWiggleY').add('MouthSmile_L').add('MouthSmile_R');

// 手势切换动作会动的那些参数（probe-motions.py 拆出来的）：举手 / 狗尾草 / 竖食指 / 脱捕
// 动作播完之后按这一组「按住」，手才会一直举着，而不是被下一轮待机动作放下去。
const HAND_PARAMS = [
  'Movement1', 'Movement2', 'Movement3',
  'Param36', 'Param39', 'Param41', 'Param42', 'Param43',
  'Param55', 'Param56', 'Param57', 'Param58',
  'Param59', 'Param60', 'Param61', 'Param62'
];
// 手势参数也要能被 setParamMap 写（否则「保持」会被白名单直接丢掉，表现为手照样掉下去）
for (const id of HAND_PARAMS) POSE_PARAMS.add(id);

// 一句人话 → 一组参数。她只要说「歪头」就行，不用知道参数名。
const POSES = {
  '看向你': { ch: 'head', pin: true, set: { ParamEyeBallX: 0, ParamEyeBallY: 0.02, ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamBodyAngleZ: 0 } },
  '看左': { ch: 'head', set: { ParamEyeBallX: -0.85, ParamAngleX: -14, ParamAngleZ: 5 } },
  '看右': { ch: 'head', set: { ParamEyeBallX: 0.85, ParamAngleX: 14, ParamAngleZ: -5 } },
  // 看下/看上：这套皮的头几乎不低头（ParamAngleY 推满只动 2.6% 像素），
  // 所以除了眼神和脖子，还得让整个人沉一点/提一点——`sink` 就是那个整体位移。
  '看上': { ch: 'head', sink: -4, set: { ParamEyeBallY: 0.85, ParamAngleY: 12, AngleY: 18, ParamBodyAngleY: 5 } },
  '看下': { ch: 'head', sink: 6, set: { ParamEyeBallY: -0.9, ParamAngleY: -18, AngleY: -30, ParamBodyAngleY: -11, ShoulderY: -5 } },
  // 歪头幅度：原来 ParamAngleZ=15，实际脸只斜了 4 度左右（这套皮对 Z 的形变很小），
  // 现在写满 22 再叠一点侧倾和脖子平移，肉眼才看得出「歪了」。
  '歪头': { ch: 'head', set: { ParamAngleZ: 30, ParamAngleX: 8, ParamBodyAngleZ: 8, AngleXbs: -8 } },
  '点头': { ch: 'head', wave: { ids: ['ParamAngleY'], amp: 9, hz: 1.7, ms: 1500, sign: 1 } },
  '摇头': { ch: 'head', wave: { ids: ['ParamAngleX'], amp: 9, hz: 1.6, ms: 1800, sign: 1 } },
  // 以前这里 noPhysics:true（甩的时候摘掉 physics），结果是尾巴在动、头发裙摆停住，
  // 甩完 2.8 秒物理一接回来整只「啪」地回位——看着像全身都在动。其实我们的 ticker
  // 跑在 model.update 之后（LOW 优先级），尾巴参数每帧写得进去，根本不用摘物理。
  '摇尾巴': { ch: 'tail', wave: { ids: TAIL_IDS, amp: 11, hz: 1.2, ms: 2800, sign: 1 } },
  // 来回晃腰：胯先动、上身晚半拍（相位差），裙摆的物理是拿 HipAngleZ/HipAngleX/ParamBodyAngleZ 当输入的，
  // 所以裙子会被这一串带着甩起来——不是给它单独写一个「裙子在飘」的假动画。
  '晃腰': {
    ch: 'body',
    wave: {
      ids: ['HipAngleZ', 'LEGAngleZ2', 'HipAngleX', 'ParamBodyAngleZ', 'ShoulderZ', 'ShoulderY'],
      amp: { HipAngleZ: 19, LEGAngleZ2: -13, HipAngleX: 5, ParamBodyAngleZ: 13, ShoulderZ: 5, ShoulderY: 2.2 },
      phase: { HipAngleZ: 0, LEGAngleZ2: Math.PI, HipAngleX: 0.35, ParamBodyAngleZ: -0.55, ShoulderZ: -0.9, ShoulderY: 0.6 },
      hz: 0.8,
      ms: 4600
    }
  },
  '吐舌头': { ch: 'face', set: { TongueOut: 1, ParamMouthOpenY: 0.25 } },
  '张嘴': { ch: 'face', set: { ParamMouthOpenY: 0.8 } },
  '闭嘴': { ch: 'face', set: { ParamMouthOpenY: 0 }, holdMs: 800 },
  '开心': { ch: 'face', set: { ParamMouthForm: 1, ParamEyeBallY: 0.1 }, holdMs: 1800 },
  // 下面这批是「按几何影响量」挑出来的：把参数推到极值，数有多少个 drawable 的顶点动了
  // （Clothes2 711 / ParamBodyAngleX 249 / ShoulderY 195 / HipAngleZ 127 / CheeckPuff 76 / EyeSmile 62 …）。
  // 所以她们动起来是真的有形状变化，不是白写。
  '前倾': { ch: 'body', sink: 6, set: { ParamBodyAngleX: 14, ParamBodyAngleY: -8, ShoulderY: 6 } },
  '后仰': { ch: 'body', sink: -4, set: { ParamBodyAngleX: -14, ParamAngleY: 8, ShoulderY: -6 } },
  '侧身': { ch: 'body', set: { ParamBodyAngleZ: 16, HipAngleZ: 12, ParamBodyAngleX: 4 } },
  // 扭腰：以前是「扳一下就不动」的静态姿势，看不出在扭 → 改成慢速摆动（晃腰的温柔版）
  '扭腰': {
    ch: 'body',
    wave: {
      ids: ['HipAngleZ', 'LEGAngleZ2', 'HipAngleX', 'ParamBodyAngleZ', 'ShoulderZ'],
      amp: { HipAngleZ: 12, LEGAngleZ2: -8, HipAngleX: 3, ParamBodyAngleZ: 8, ShoulderZ: 3 },
      phase: { HipAngleZ: 0, LEGAngleZ2: Math.PI, HipAngleX: 0.35, ParamBodyAngleZ: -0.55, ShoulderZ: -0.9 },
      hz: 0.55,
      ms: 5200,
    },
  },
  '提肩': { ch: 'body', set: { ShoulderY: 22, ShoulderZ: 10 } },
  '沉肩': { ch: 'body', set: { ShoulderY: -22, ShoulderZ: -6 } },

  '缩脖': { ch: 'body', sink: 4, set: { ShoulderY: 20, ParamAngleY: -12, AngleY: -14, ParamBodyAngleY: -5 } },
  '并腿': { ch: 'body', set: { Param33: 1 } },
  // 鼓腮必须左右一起推（CheeckPuffL/R），只推 CheeckPuff 在网页尺寸下看不出来
  '鼓脸': { ch: 'face', set: { CheeckPuff: 1, CheeckPuffL: 0.9, CheeckPuffR: 0.9, Mouthpucker: 0.6, MouthPuckerWiden: 0.6, ParamMouthOpenY: 0.3, ParamMouthForm: 0.5 } },
  // 眯眼只推眼睛开合在网页尺寸下只有 2.7% 像素变化 → 叠笑眼、压眉、嘴角上扬
  '眯眼': { ch: 'face', set: { EyeSmile: 1, ParamEyeLOpen: 0.32, ParamEyeROpen: 0.32, ParamBrowLY: 0.45, ParamBrowRY: 0.45, ParamMouthForm: 0.55 } },
  '瞪眼': { ch: 'face', set: { ParamEyeLOpen: 1, ParamEyeROpen: 1, BrowInnerUp: 0.8, ParamBrowLY: 0.6, ParamBrowRY: 0.6 } },
  '抬眉': { ch: 'face', set: { ParamBrowLY: 1, ParamBrowRY: 1, BrowInnerUp: 0.5 } },
  '皱眉': { ch: 'face', set: { ParamBrowLAngle: 1, ParamBrowRAngle: 1, BrowInnerUp: -0.6 } },
  // 只推 Mouthpucker 在这套皮上只有几个像素，网页尺寸下等于没动；
  // 现在嘴唇外扩+漏斗+张开一点，再叠鼓腮、压眉、头微低微侧，远看才有「在闹别扭」的形状。
  '嘟嘴': { ch: 'face', set: { Mouthpucker: 1, MouthPuckerWiden: 1, MouthFunnel: 0.35, ParamMouthOpenY: 0.45, ParamMouthForm: 0.6, CheeckPuff: 1, CheeckPuffL: 0.9, CheeckPuffR: 0.9, ParamBrowLY: -0.7, ParamBrowRY: -0.7, ParamBrowLAngle: 0.4, ParamBrowRAngle: 0.4, ParamEyeLOpen: 0.78, ParamEyeROpen: 0.78, ParamAngleY: -5, ParamAngleZ: 7 } },
  '复位': { ch: 'all', clear: true }
};

// 模型自带的 23 个 exp3 不是情绪，是道具/特效开关（原作者的「按键」）。
// 名字直接可以喂给 model.expression()。
const MODEL_EXPRESSIONS = [
  '默认体型', '体型1', '体型2', '前倾', '加载', '尾巴开关', '屑屑眼', '圈圈眼', '爱心眼',
  '＞＜', '兔牙', '单片眼镜', '黑框眼镜', '流冷汗', '流泪', '脸红', '脱鞋', '裙子切换',
  '胸口衣服', '钢盆', '黑脸', '竖食指开', '竖食指关'
];

// 0/1 型道具开关。key1..13 是原作者留的「按键」，Clothes1..5 是换装，Movement1..3 是手部小动作。
// 用 drawable 透明度实测量过：key6 屑屑眼 102 个、key3 圈圈眼 88、key5 ＞＜ 88、
// Movement3 竖食指 33、key12 单片眼镜 19、key2 落泪 12、Clothes4 脱鞋 10 …
const SWITCHES = {
  '黑脸': { id: 'key1' }, '落泪': { id: 'key2' }, '流泪': { id: 'key2' },
  '圈圈眼': { id: 'key3' }, '蚊香眼': { id: 'key3' }, '爱心眼': { id: 'key4' },
  '＞＜': { id: 'key5' }, '＞＜眼': { id: 'key5' }, '屑屑眼': { id: 'key6' },
  '脸红': { id: 'key7' }, '加载': { id: 'key8' }, '兔牙': { id: 'key9' }, '大牙': { id: 'key9' },
  '钢盆': { id: 'key10' }, '大钢盆': { id: 'key10' }, '黑框眼镜': { id: 'key11' },
  '单片眼镜': { id: 'key12' }, '流冷汗': { id: 'key13' },
  '短裙': { id: 'Clothes1', on: 1 }, '长裙': { id: 'Clothes1', on: 0 },
  '大小变': { id: 'Clothes2' }, '胸口衣服': { id: 'Clothes3' },
  '脱鞋': { id: 'Clothes4' }, '尾巴': { id: 'Clothes5' }, '尾巴开关': { id: 'Clothes5' },
  '狗尾草': { id: 'Movement1' }, '抚胸': { id: 'Movement2' }, '竖食指': { id: 'Movement3' }
};
const switchState = new Set();   // 现在开着的道具（心跳回执用）

// 页面里出什么错都要能看见：以前脚本一抛异常，表现就是「窗口在、但既不连也不报心跳」，
// 外面完全查不到原因。这里把错误直接 POST 到 /hb，从 /state 就能读到。
window.addEventListener('error', (e) => {
  try {
    fetch('/hb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsError: String(e.message || e.error || 'error'), src: String(e.filename || ''), line: e.lineno || 0 })
    }).catch(() => { });
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    fetch('/hb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsError: 'promise: ' + String((e.reason && e.reason.message) || e.reason || '') })
    }).catch(() => { });
  } catch { /* ignore */ }
});

// 分层混合（P1）：每个来源（生理/情绪/姿态/手势/口型/手动）各占一层，
// 每层只存「我想把哪个参数写成什么」，每帧按权重合起来算，谁也不再盖住谁。
// 以前是全塞一个 poseOverrides、「后写赢、优先级高的赢」，所以歪头和生气只能二选一。
const layerParams = new Map();   // layer → Map(id → { value, start, until, prio, ch, weight })
const LAYER_ORDER = ['physio', 'emotion', 'expression', 'pose', 'gesture', 'lipsync', 'manual', 'misc'];
function layerOf(name) { return layerParams.get(name) || (layerParams.set(name, new Map()), layerParams.get(name)); }

const poseOverrides = new Map(); // 派生视图：id → { until, prio, ch }，给心跳/忙闲判断用
// 波形姿态按「通道」分开存：头一个槽、尾巴一个槽，所以「歪着头摇尾巴」能同时成立。
// 以前只有一个 poseWave 变量，第二个波形直接把第一个顶掉。
const channelWaves = new Map();  // ch → { ids, amp, hz, t0, until, base, noPhysics }
let savedPhysics = null;         // 甩尾巴时临时摘掉的物理演算
// 大小：1 = 窗口高度刚好装下她；0.6 = 小一号，1.3 = 怼脸
let userScale = (() => {
  const v = Number(localStorage.getItem('fishScale'));
  return Number.isFinite(v) && v >= 0.4 && v <= 1.6 ? v : 1;
})();
let gazeTarget = { x: 0, y: 0 };
const gazeNow = { x: 0, y: 0 };
let lastMouseAt = 0;             // 鼠标很久没动就自己东张西望，否则眼神永远钉在上次那个点
let mouseNX = 0;                 // 鼠标在窗口里的归一化位置（-1 左 … 1 右）
let mouseNY = 0;
let aimSource = 'none';          // 最近一次视线来源：mouse / touch / tilt
let tiltOn = false;              // 重力感应跟随是否打开（手机上要用户点一下才允许）
let lastTiltAt = 0;
let aimX = 0;                    // 平滑后的转向量，直接喂给头/身体的旋转参数
let aimY = 0;
let focusBlend = 0;              // 0=自发环视 1=鼠标跟随，中间是过渡（硬切换会让头「啪」地弹回去）
const focusAim = { x: 0, y: 0, z: 0, bx: 0 };  // 缓存 FocusController 算出来的角度，避免自己读自己写
let baseY = null;                // 模型容器的基准 Y（呼吸上下浮动就在它附近晃）
let bodySink = 0;                // 当前整体沉降（像素，逻辑坐标）——低头/抬头用它补
let bodySinkTarget = 0;          // 目标沉降
let baseX = null;                // 基准 X（跟着鼠标侧移用）
let tickerFps = 0;               // 最近一秒真实帧率（排查「拖动闪 / 卡」时唯一可信的指标）
let framesInWindow = 0;          // 这一秒里画了多少帧（tickerFps 的来源）
let rendererKind = '';           // 页面最后拿到的是 webgl 还是 canvas2d
let lastPose = { name: '', until: 0 };   // 最近一次姿态（回执用）
// 「看向你」这类把整颗头钉住的姿态：钉住之后不许鼠标跟随再掰头，也不许自发环视换落点。
// 以前只钉了 ParamAngleX/Z，结果头被 FocusController 慢慢转走、眼神在飘——她说「看着我」，
// 画面上却像在看别处。
let pinnedHead = false;
// 输出平滑：每个参数记住上一帧真正写出去的值，朝目标缓动过去。
// 以前是「这一帧算出来就直接写」，所以换姿态、表情到期都是硬切（看着像掉帧）。
const smoothOut = new Map();
let lastHandUntil = 0;                   // 手被「按住」到什么时候（回执用）
let holdDbg = '';                        // 「保持」这条链路走到哪一步了（排障用）
let lastExpr = '';               // 当前表情（回执用）
let lastExprUntil = 0;           // 表情参数什么时候到期（回执用）
let emotionPulseAt = 0;          // 换表情时的那一下「点头/晃身」起点，用来让她一眼看出换了
let emotionPulseAmp = 0;
// 每个表情配一下「点头/摇头」的幅度（正数=点头，负数=仰头），0 表示不动。
// 放在这里而不是 applyExpression 旁边：boot 里会先 applyExpression 一次，写在使用点之后就撞 TDZ。
const EMOTION_PULSE = { '开心': 3.5, '笑': 3.5, '疑惑': -4.5, '生气': 4.5, '惊讶': -5, '难过': 3, '委屈': 2.5, '害羞': 2, '平静': 0 };
const RELEASE_MS = 420;   // 姿态到期后再用这段时间把权重降到 0（手是慢慢放下的，不是弹回去）
// 「层撤走要把参数还回去」：以前某个参数只在层里被写过，层一没就没人再写它，
// 于是脸停在最后一个值上（表情到期了还笑着）。这里记下原值，撤层时写回去一次。
const animBase = new Map();   // id → 动它之前的值
let writtenIds = new Set();   // 上一帧我们写过的 id
let releasing = new Set();    // 这一帧正在缓着回原值的 id
// 活体层（站立时的重量感/二级动作）用的弹簧状态：id → {x, v}
const lifeSpring = new Map();
const lifeIds = new Set();
// 表情与心情的共存规则（2026-11-03 定，用户选的方案 C）：
//   表情是「短时覆盖」，心情是「底色」。表情默认活 25 秒，之后用 RELEASE_MS 淡回心情脸；
//   期间如果心情剧变（v/a 跨过阈值），提前退场——「人难过着，脸还挂着笑」比掉表情更假。
//   她要常驻就显式说「一直保持」（holdMs = -1）。
const EXPR_IMPLICIT_MS = 25000;
const EXPR_SURGE_V = 0.45;
const EXPR_SURGE_A = 0.5;
let exprBaseMood = null;         // 摆表情那一刻的心情，用来判断「剧变」
let frozen = false;              // 截图/对拍时冻结环境动画，A/B 才比得干净
// 自主性开关：关掉 = 只由她下命令驱动（默认）；打开才自己甩尾巴、瞟来瞟去。
// 她原话：「只让我的鱼来操控身体就行，呼吸可以像现在这样」。
let autonomy = false;
// 探针（排障用）：她/我们指定几个参数 id，页面在两次心跳之间记录它们的最大最小值，
// 直接从 /state 就能看出「这个参数到底动没动」，不用靠截图比像素（桌面背景会干扰）。
let probeIds = [];
let probeRange = new Map();
let dumpParams = false;      // 下一次心跳把非默认参数打出来
let paramDump = '';
// 眼珠的最终目标（在 ticker 里算好，beforeModelUpdate 里写进 core，见 applyEyes）
let eyeWant = { x: null, y: null };
// 这一帧要写进模型的参数：绝对值和加法分开存，等 beforeModelUpdate 一起落地
const frameWrites = new Map();   // id → 绝对值（头/身/嘴/眨眼/眼珠）
const frameAdds = new Map();     // id → 增量（情绪漏到姿态上的那一点）
// 这套皮的眼睛画得偏左上（黑眼珠本来就靠左上），写 0 看起来像在瞟天花板。
// 补一点右下，才像正视前方。数值是一次次截图对出来的。
const EYE_BIAS = { x: 0, y: 0 };

// 尾巴/头发是物理算出来的，我们每帧写进去的值下一帧就被覆盖 —— 甩的时候先关掉物理，甩完再装回去
function suspendPhysics() {
  const im = model?.internalModel;
  if (!im || savedPhysics) return;
  if (!im.physics) return;
  savedPhysics = im.physics;
  im.physics = null;
}

function restorePhysics() {
  const im = model?.internalModel;
  if (!savedPhysics || !im) return;
  im.physics = savedPhysics;
  savedPhysics = null;
}

const EXPRESSIONS = ['默认体型', '体型1', '体型2', '兔牙', '前倾', '加载', '单片眼镜', '圈圈眼',
  '尾巴开关', '屑屑眼', '流冷汗', '流泪', '爱心眼', '竖食指开', '竖食指关', '胸口衣服',
  '脱鞋', '脸红', '裙子切换', '钢盆', '黑框眼镜', '黑脸', '＞＜'];

function hud(text) { HUD.textContent = text; }

async function boot() {
  loadLexicon();   // 词表是异步拉的，拉不到就用内置兜底，不挡启动
  loadVocab();     // 词表 v2（通道式，可叠加）
  // 贴图带 alpha 时，PIXI 6 默认预乘会让某些小网格发黑（模型鼻尖那块黑点就是这么来的）
  if (PIXI.settings) {
    PIXI.settings.PREFER_PREMULTIPLIED_ALPHA = false;
    PIXI.settings.STRICT_TEXTURE_CACHE = false;
  }
  app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    resizeTo: window,
    autoDensity: true,
    premultipliedAlpha: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  });
  document.getElementById('stage').appendChild(app.view);
  // 这台屏是 240Hz，默认跟着屏幕跑就是 240fps —— 桌面宠物用不着，纯烧 GPU（也更容易崩）。
  // 60 帧足够顺滑，GPU 负载直接砍掉四分之三。
  app.ticker.maxFPS = 60;
  // 记录这一页到底跑在 WebGL 还是 canvas2d 上（canvas2d 一挪窗口就闪，先知道自己在哪条路上）
  rendererKind = app.renderer?.type === PIXI.RENDERER_TYPE.CANVAS ? 'canvas2d' : 'webgl';
  setInterval(() => {
    try { tickerFps = app.ticker.FPS || 0; } catch { /* ignore */ }
  }, 1000);
  // PIXI 的 ticker.FPS 在 maxFPS 限帧下会忽高忽低（同一秒里 90 和 45 交替），
  // 因为它算的是「相邻两帧的间距」；这里自己数真实帧数，读数才可信。
  app.ticker.add(() => { framesInWindow += 1; });
  setInterval(() => { tickerFps = framesInWindow; framesInWindow = 0; }, 1000);
  app.view.style.width = '100%';
  app.view.style.height = '100%';

  // 模型文件名不再写死：优先 URL 上的 ?model=xxx，其次问服务端（它会扫模型目录里第一个 *.model3.json），
  // 最后才退回默认名。别人拿这份代码配自己的模型时，不用改源码。
  let modelFile = new URLSearchParams(location.search).get('model') || '';
  if (!modelFile) {
    try {
      const r = await fetch('/model-file', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.file) modelFile = String(j.file);
    } catch { /* 老服务端没有这个接口，走默认 */ }
  }
  if (!modelFile) modelFile = '';  // 交给服务端 /model-file 探测，或由 ?model= 指定
  const url = '/model/' + encodeURIComponent(modelFile);
  model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
  app.stage.addChild(model);
  window.__model = model; // 调试用：控制台里查 drawable
  window.__bodyBuild = 'v1.3-phys'; // 用来确认页面到底加载了哪一版 body.js

  // ── 手感（物理阻尼）──────────────────────────────────────────────
  // 模型自带 physics3.json 里，每个质点都有 mobility（跟手程度）和 delay（滞后），
  // 它们决定裙子/头发/胸部「被带着走」的手感：mobility 越大越跟手，delay 越大越拖。
  // 运行时结构不带名字，只能按每组的 output 目标参数名分类（SkirtLayerX1 / FrontHairX2 …）。
  // 原始值存在质点自己的 __origMobility/__origDelay 上，任何调参都能原样还原。
  const PHYS_CATS = [
    ['skirt', '裙摆', /^(Skirt|Lace)/i],
    ['hair', '头发', /^(Late.*Hair|FrontHair|SideHair|ShortPonytail)/i],
    ['chest', '胸部', /^Chest/i],
    ['ribbon', '丝带', /(Ribbon|Bow)/i],
    ['sleeve', '袖子', /Sleeve/i],
    ['tail', '尾巴', /Angle_Rotation/i],
  ];
  // 默认手感：比原厂稍微跟手一点点，但静止时基本不动
  const PHYS_DEFAULT = {
    skirt: { m: 1.12, d: 0.92 }, hair: { m: 1.12, d: 0.92 }, chest: { m: 1.12, d: 0.92 },
    ribbon: { m: 1.12, d: 0.92 }, sleeve: { m: 1.12, d: 0.92 }, tail: { m: 1.05, d: 0.95 },
    idle: 0.42,      // 静止时自动重心变化的幅度（1 = 之前那版明显晃）
    swing: 1,        // 主动动作（晃腰/摇尾巴）的幅度
  };
  const physCfg = JSON.parse(JSON.stringify(PHYS_DEFAULT));
  const physRig = model?.internalModel?.physics?._physicsRig;
  const physGroups = (() => {
    if (!physRig || !Array.isArray(physRig.settings)) return [];
    const list = [];
    for (const st of physRig.settings) {
      const names = [];
      for (let i = 0; i < (st.outputCount || 0); i += 1) {
        const dst = physRig.outputs?.[st.baseOutputIndex + i]?.destination?.id;
        if (dst) names.push(String(dst));
      }
      const key = names.join(' ');
      let cat = null;
      for (const [id, , test] of PHYS_CATS) { if (test.test(key)) { cat = id; break; } }
      list.push({ st, names, key, cat });
    }
    return list;
  })();
  function applyPhysCfg(patch) {
    if (patch && typeof patch === 'object') {
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'idle' || k === 'swing') { physCfg[k] = Number(v); continue; }
        if (!physCfg[k] || typeof v !== 'object') continue;
        if (v.m !== undefined) physCfg[k].m = Number(v.m);
        if (v.d !== undefined) physCfg[k].d = Number(v.d);
      }
    }
    const counts = {};
    for (const g of physGroups) {
      if (!g.cat || !physRig) continue;
      const { m, d } = physCfg[g.cat];
      const c = counts[g.cat] || (counts[g.cat] = { groups: 0, points: 0 });
      c.groups += 1;
      for (let i = 0; i < (g.st.particleCount || 0); i += 1) {
        const pt = physRig.particles[g.st.baseParticleIndex + i];
        if (!pt) continue;
        if (typeof pt.mobility === 'number') {
          if (pt.__origMobility === undefined) pt.__origMobility = pt.mobility;
          pt.mobility = Math.max(0, Math.min(1, pt.__origMobility * m));
          c.points += 1;
        }
        if (typeof pt.delay === 'number') {
          if (pt.__origDelay === undefined) pt.__origDelay = pt.delay;
          pt.delay = Math.max(0.02, Math.min(2, pt.__origDelay * d));
        }
      }
    }
    return { cfg: physCfg, counts };
  }
  applyPhysCfg();
  window.__phys = (patch) => applyPhysCfg(patch);
  window.__physCfg = () => JSON.parse(JSON.stringify(physCfg));
  window.__physInfo = () => ({
    cfg: physCfg,
    groups: physGroups.filter((g) => g.cat).length,
    cats: PHYS_CATS.map(([id, label]) => ({
      id, label, sample: physGroups.filter((g) => g.cat === id).map((g) => g.names[0]).slice(0, 3),
    })),
  });

  // 参数表从模型本身读（P0）：509 个 id + 各自的 min/max，写参数只认这里有的。
  // 以前是手写白名单，漏一个就表现为「写了没反应」，还容易误判成参数不存在。
  const paramCount = indexParams(model.internalModel?.coreModel);
  window.__paramCount = paramCount;

  // 模型里有两个「鼻子」图层：Part10 是正常的鼻影，Part46 带了反向裁切掩码，
  // 网页渲染器（pixi-live2d-display）不支持反向掩码 → Part46 会糊成鼻尖上一块黑方块。
  // 只关 Part46，保留 Part10 的鼻影；每帧重设一次，防止被动作覆盖。
  // 波形（摇尾巴/点头/摇头）必须挂在模型的 beforeModelUpdate 上。
  // Cubism 的 update 顺序是：动作 → 表情 → 眨眼 → 视线 → 自然动 → **物理** → beforeModelUpdate → core.update()
  // 我们的 ticker 在整只 update 之后才跑，写进去的尾巴参数下一帧就被物理盖掉 —— 所以以前只能靠「摘物理」硬来，
  // 结果头发裙摆停住、接回物理时整只弹一下。挂在 beforeModelUpdate 就正好在物理之后、绘制之前。
  const im0 = model.internalModel;
  if (im0 && typeof im0.on === 'function') {
    try {
      im0.on('beforeModelUpdate', beforeModelHook);
      window.__waveHook = true;
    } catch (e) { window.__waveHookErr = String((e && e.message) || e); }
  }

  const HIDE_PARTS = ['Part46'];
  const core0 = model.internalModel?.coreModel;
  const hideBlack = () => {
    for (const p of HIDE_PARTS) { try { core0?.setPartOpacityById?.(p, 0); } catch (e) { /* ignore */ } }
  };
  hideBlack();

  fit();
  window.addEventListener('resize', fit);

  // 待机动作：关掉。
  // 模型自带的 Idle 循环会自己改眼睛/耳朵/手臂参数（她看到「眼睛一大一小、耳朵一上一下」就是它），
  // 和我们的参数写入打架。现在身体只由我们这套参数驱动，呼吸/眨眼/视线都是自己算的。
  try {
    const mm = model.internalModel?.motionManager;
    if (mm) {
      mm.stopAllMotions?.();
      mm.groups.idle = '';          // 关掉「闲着就随机播 Idle」这条路
    }
  } catch (e) { /* 拿不到就算了，后面也还有 clearPose 兜底 */ }

  // 鼠标跟随：眼珠朝鼠标转，头连身体也一起转（幅度比之前大，看着像「盯着你」）
  // 手机上没有鼠标，所以这里做成「任意指向源」：鼠标移动 / 手指按住 / 重力感应倾斜，
  // 都换算成同一个归一化坐标，走路和手机用的是同一套跟随逻辑。
  const aimAt = (clientX, clientY, src) => {
    if (!model || pinnedHead) return;
    const x = Math.max(-1, Math.min(1, (clientX / window.innerWidth) * 2 - 1));
    const y = Math.max(-1, Math.min(1, (clientY / window.innerHeight) * 2 - 1));
    lastMouseAt = Date.now();
    aimSource = src;
    mouseNX = x;
    mouseNY = y;
    gazeTarget.x = Math.max(-0.95, Math.min(0.95, x * 0.95));
    gazeTarget.y = Math.max(-0.95, Math.min(0.95, -y * 0.8));
    // 交给渲染器自带的 FocusController：它按模型绑好的参数名自己转，头/身/眼一起动。
    // 偏移量是把「这套皮眼珠天生偏左上」补回正视方向（focus 的 y 轴向上为正，所以往下要减）。
    const fx = Math.max(-1, Math.min(1, x * 0.9 + EYE_BIAS.x));
    const fy = Math.max(-1, Math.min(1, -y * 0.6 + EYE_BIAS.y));
    try { model.focus(fx, fy); } catch (e) { /* ignore */ }
  };
  window.addEventListener('mousemove', (e) => aimAt(e.clientX, e.clientY, 'mouse'));
  // 触屏：手指按下的地方就是她在看的地方（pointerType 为 touch/pen 才走这条，鼠标不会重复触发）
  const onTouchAim = (e) => {
    if (!e.isPrimary && e.touches && e.touches.length) return;
    const p = e.touches?.[0] || e;
    if (p.clientX === undefined) return;
    aimAt(p.clientX, p.clientY, 'touch');
  };
  window.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') onTouchAim(e); }, { passive: true });
  window.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' && e.buttons) onTouchAim(e); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (e.touches?.length) onTouchAim(e); }, { passive: true });

  // 手机：倾斜机身就当她在转头看你（gamma = 左右倾，beta = 前后倾）。
  // iOS 需要用户手势里调 DeviceOrientationEvent.requestPermission()，所以不自动开，
  // 由下面那个「摇一摇她」按钮触发；桌面端不会出现这个按钮。
  const tiltHandler = (e) => {
    if (!tiltOn || !model) return;
    const now = Date.now();
    if (now - lastTiltAt < 40) return;
    lastTiltAt = now;
    const g = Number(e.gamma) || 0;
    const b = Number(e.beta) || 0;
    const dead = (v) => (Math.abs(v) < 0.06 ? 0 : v);
    const nx = dead(Math.max(-1, Math.min(1, g / 28)));
    const ny = dead(Math.max(-1, Math.min(1, (b - 55) / 30)));
    const cx = window.innerWidth * (0.5 + nx * 0.45);
    const cy = window.innerHeight * (0.5 + ny * 0.45);
    aimAt(cx, cy, 'tilt');
  };

  const startTilt = async () => {
    try {
      const DOE = window.DeviceOrientationEvent;
      if (!DOE) return false;
      if (typeof DOE.requestPermission === 'function') {
        const s = await DOE.requestPermission();
        if (s !== 'granted') return false;
      }
      if (!tiltOn) { window.addEventListener('deviceorientation', tiltHandler, true); tiltOn = true; }
      return true;
    } catch (e) { return false; }
  };
  window.__enableTilt = startTilt;

  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    const btn = document.createElement('button');
    btn.id = 'tiltBtn';
    btn.textContent = '摇一摇她';
    btn.style.cssText = 'position:fixed;right:14px;bottom:76px;z-index:40;padding:8px 14px;border-radius:999px;'
      + 'border:1px solid rgba(140,190,255,.45);background:rgba(20,32,56,.82);color:#dce8ff;'
      + 'font:13px/1 system-ui,-apple-system,"PingFang SC",sans-serif;backdrop-filter:blur(6px);';
    btn.addEventListener('click', async () => {
      const ok = await startTilt();
      btn.textContent = ok ? '倾斜手机试试' : '这台设备不支持';
      if (ok) setTimeout(() => { btn.style.opacity = '0.35'; btn.textContent = '跟随中…'; }, 1500);
    });
    document.body.appendChild(btn);
  }

  // 没人理她的时候自己东张西望（2~4 秒换一次落点），不然眼珠永远钉在上一次鼠标停的地方，
  // 看着就是「眼神空洞、像贴图」。小幅扫视任何时候都开着（这是活物的基本体征）；
  // 大幅度「看别处」只有打开 AUTONOMY 才有，免得抢她的姿态。
  // 她说「看向你/盯着我」时，眼珠由姿态层钉住；这时候再改落点没意义（看不见），
  // 反而会让「盯着你」的下一句又飘走。
  const eyePinned = () => {
    for (const [, m] of layerParams) if (m.has('ParamEyeBallX') || m.has('ParamEyeBallY')) return true;
    return false;
  };
  const saccade = () => {
    setTimeout(() => {
      if (!frozen && !pinnedHead && !eyePinned() && Date.now() - lastMouseAt > 2500) {
        const r = Math.random();
        const biasX = 0.12;
        if (autonomy && r < 0.16) {
          // 偶尔看向别处（想事情的样子），幅度大一点
          gazeTarget.x = Math.max(-0.85, Math.min(0.85, (Math.random() * 2 - 1) * 0.5 + biasX));
          gazeTarget.y = (Math.random() * 2 - 1) * 0.3 - 0.05;
        } else if (autonomy) {
          // 大多数时候在中间小幅扫视，像在看你
          gazeTarget.x = Math.max(-0.6, Math.min(0.6, (Math.random() * 2 - 1) * 0.2 + biasX));
          gazeTarget.y = (Math.random() * 2 - 1) * 0.12 - 0.05;
        } else {
          // 「有神」不等于「一直乱瞟」：真正让人觉得活着的是**看着你**。
          // 所以默认落点在正前方偏下一点点（像在看你脸），幅度只有 ±0.06 的抖动；
          // 偶尔（8%）才瞟一眼别处，1~2 秒后自己回到脸上。
          const glance = Math.random() < 0.04;
          if (glance) {
            gazeTarget.x = Math.max(-0.6, Math.min(0.6, (Math.random() * 2 - 1) * 0.30 + 0.1));
            gazeTarget.y = Math.max(-0.2, Math.min(0.1, (Math.random() * 2 - 1) * 0.14 - 0.03));
          } else {
            gazeTarget.x = Math.max(-0.16, Math.min(0.22, 0.09 + (Math.random() * 2 - 1) * 0.035));
            gazeTarget.y = Math.max(-0.09, Math.min(0.02, -0.04 + (Math.random() * 2 - 1) * 0.025));
          }
        }
      }
      saccade();
    }, 600 + Math.random() * 1500);
  };
  saccade();

  // 点一下换表情（手动玩）
  model.on('hit', (areas) => {
    if (!areas || !areas.length) return;
    const pick = EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)];
    applyExpression(pick);
  });

  // 眨眼：模型自带 eyeBlink 在待机动作里常被曲线压住，这里自己补一个
  let blinkAt = performance.now() + 2000 + Math.random() * 2000;
  let blinkPhase = 0; // 0 睁 → 1 闭 → 2 睁
  let blinkValue = 1;
  let eyeLockUntil = 0;
  const updateBlink = (tms) => {
    if (blinkPhase === 0 && tms >= blinkAt) { blinkPhase = 1; blinkAt = tms + 70; }
    else if (blinkPhase === 1 && tms >= blinkAt) { blinkPhase = 2; blinkAt = tms + 110; }
    else if (blinkPhase === 2 && tms >= blinkAt) { blinkPhase = 0; blinkAt = tms + 2600 + Math.random() * 3600; }
    if (blinkPhase === 0) blinkValue = Math.min(1, blinkValue + 0.2);
    else if (blinkPhase === 1) blinkValue = Math.max(0, blinkValue - 0.45);
    else blinkValue = Math.min(1, blinkValue + 0.28);
    return blinkValue;
  };

  // 每帧：嘴型 + 呼吸 + 轻微头动 + 眨眼
  const t0 = performance.now();
  // LOW 优先级 = 在模型的 update 之后跑，参数才不会被动作曲线盖回去
  app.ticker.add(() => {
    if (!model) return;
    hideBlack();
    const core = model.internalModel?.coreModel;
    if (!core) return;
    const now = Date.now();
    const t = (performance.now() - t0) / 1000;

    // 情绪驱动的自发小动作（没人调她也会自己动一下）
    if (!frozen) maybeSpontaneous(now);

    // 呼吸：胸口起伏 + 头肩极缓的摇摆 + 整个身子轻轻上下浮（像真在呼吸，不是定格）
    // frozen = 截图对拍模式：所有环境动画归零，只剩「我正在写的那一层」，A/B 才比得干净
    const breath = frozen ? 0 : Math.sin(t * 1.15);
    const sway = frozen ? 0 : Math.sin(t * 0.42);
    const set = (id, v) => { try { frameWrites.set(id, v); } catch (e) { /* 没这个参数就算了 */ } };

    set('ParamBreath', frozen ? 0.5 : 0.5 + breath * 0.5);

    // 呼吸带来的整体上下浮动：模型容器跟着轻轻起落（幅度随缩放走，小体型不会浮得太夸张）
    // bodySink 是「低头/抬头」这类姿态带来的整体沉降——这套皮的头几乎不低头（实测 ParamAngleY 全幅只动 2.6% 像素），
    // 只能连人一起往下沉一点，才看得出她真的低了头。
    bodySink += ((bodySinkTarget || 0) - bodySink) * 0.12;
    if (typeof baseY === 'number') {
      model.y = baseY + (frozen ? 0 : Math.sin(t * 1.15 - 0.6) * 4.6 * userScale) + bodySink * userScale;
    }

    // 鼠标在动的时候，头/身体/眼睛交给渲染器自带的 FocusController（就是 model.focus 那套），
    // 它按模型作者绑好的参数名自己插值转向——这才是这套皮「本来该有的跟随」。
    // 我们以前每帧覆盖 ParamAngle*/ParamEyeBall*，等于把它的自然动作顶掉了，看着就像整只被拖着走。
    // 两个驱动：鼠标跟随时由 FocusController 算头/身角度；没人理会时用很慢的自发环视。
    // 以前是硬切换——鼠标一停满 4 秒，头就从「被鼠标掰过去的角度」瞬间弹回中立位，
    // 看着就是「突然向右上看，又突然复位」。现在两条都在算，按 focusBlend 平滑过渡。
    const focusActive = (now - lastMouseAt < 4000) && !pinnedHead;
    focusBlend += ((focusActive ? 1 : 0) - focusBlend) * 0.10;
    const fb = Math.max(0, Math.min(1, focusBlend));
    // 只在 focus 活着的时候读它算出来的值（它每帧在 model.update 里写绝对值），
    // 否则会读到自己上一帧写进去的混合结果，越乘越大。
    if (focusActive) {
      const amp = (id, k) => {
        const v = Number(core.getParameterValueById(id)) || 0;
        return Math.max(-30, Math.min(30, v * k));
      };
      // 这套皮的 ParamAngle* 在画面上很钝（实测推 30 度只有 2% 像素变化），
      // FocusController 自己算出来的角度又只有一两度 → 乘 2 还是看不出来。
      // 所以这里放大到 6/5/3.5 倍，让「头转过去」这件事真的看得见。
      focusAim.x = amp('ParamAngleX', 6.0);
      focusAim.y = amp('ParamAngleY', 5.0);
      focusAim.z = amp('ParamAngleZ', 3.5);
      focusAim.bx = amp('ParamBodyAngleX', 4.0);
    }
    // 自发环视那条永远在算（幅度小、周期长）
    const aimTX = Math.sin(t * 0.23) * 0.3;
    const aimTY = Math.sin(t * 0.31 + 1.1) * 0.22;
    aimX += (aimTX - aimX) * 0.05;
    aimY += (aimTY - aimY) * 0.05;
    const mixf = (f, i) => (fb > 0.002 ? f * fb + i * (1 - fb) : i);
    set('ParamAngleX', mixf(focusAim.x, sway * 2.4 - aimX * 10));
    set('ParamAngleY', mixf(focusAim.y, breath * 2.0 + aimY * 7));
    set('ParamAngleZ', mixf(focusAim.z, sway * 2.6 + aimX * 3));
    set('ParamBodyAngleX', mixf(focusAim.bx, sway * 1.2 - aimX * 4));
    set('ParamBodyAngleZ', sway * 1.0 + aimX * 2);

    const talking = now < talkingUntil;
    const target = talking ? Math.abs(Math.sin(now / 95 + talkSeed)) * 0.85 : 0;
    mouth += (target - mouth) * 0.35;
    set(MOUTH_ID, mouth);

    // 眨眼（换表情后 5 秒内不抢眼睛，让表情自己演）。真正的写入挪到图层混合之后：
    // 眼睛开合还要乘上表情层想要的「眯」，否则嘟嘴/眯眼这类表情会被眨眼直接顶掉。
    const b = frozen ? 1 : updateBlink(performance.now());
    const blinkOn = performance.now() > eyeLockUntil;

    // 眼神：眼珠完全由我们算（鼠标在动时 gazeTarget 就是鼠标位置，静止时是自发环视）。
    // 引擎的 FocusController 也在写这两个参数，但它的写入发生在 core.update 之前，
    // 我们在 applyEyes() 里又按「这一帧算好的值」盖一次，所以最终画面听我们的。
    gazeNow.x += (gazeTarget.x - gazeNow.x) * 0.14;
    gazeNow.y += (gazeTarget.y - gazeNow.y) * 0.14;
    set('ParamEyeBallX', Math.max(-1, Math.min(1, gazeNow.x + EYE_BIAS.x)));
    set('ParamEyeBallY', Math.max(-1, Math.min(1, gazeNow.y + EYE_BIAS.y)));

    // 换表情那一下的点头/抬头（0.6 秒，sin 起落，不硬）
    if (emotionPulseAmp) {
      const p = (performance.now() - emotionPulseAt) / 600;
      if (p >= 1) { emotionPulseAmp = 0; } else {
        const k = Math.sin(Math.PI * p) * emotionPulseAmp;
        set('ParamAngleY', (Number(core.getParameterValueById('ParamAngleY')) || 0) + k);
      }
    }

    // 分层混合：把每一层想在参数上做的偏移合起来，而不是「谁后写谁赢」。
    // 单层时结果和原来完全一样（w=1 → 直接写成目标值）；多层时按权重加权平均，
    // 于是「歪头 + 生气 + 说话」能同时成立，各自只负责自己那几个参数。
    let layerMouthNum = 0, layerMouthDen = 0;   // 表情层想要的嘴张合，等混合完再决定要不要用
    let eyeSquintNum = 0, eyeSquintDen = 0;     // 表情层想要的眼睛开合（1=正常，<1 眯）
    if (layerParams.size) {
      const mix = new Map();     // id → { num: Σ(value×w), den: Σw, until }
      for (const [layer, m] of layerParams) {
        for (const [id, o] of m) {
          const remain = o.until - now;
          if (remain < -RELEASE_MS) { m.delete(id); continue; }
          const w = Math.min(1, (now - o.start) / 340, Math.max(0, remain + RELEASE_MS) / RELEASE_MS);
          if (w <= 0) continue;
          const lw = Number(o.weight) || 1;
          if (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen') {
            // 眼睛开合和眨眼是同一批参数，先攒起来，等混合完和眨眼一起写
            eyeSquintNum += o.value * w * lw;
            eyeSquintDen += w * lw;
            continue;
          }
          if (id === MOUTH_ID) {
            // 嘴张合归口型管：表情层只提供「不说话时嘴角该张多大」（惊讶那种），
            // 一旦说话就必须让给口型——否则她换了表情就再也张不开嘴。
            layerMouthNum += o.value * w * lw;
            layerMouthDen += w * lw;
            continue;
          }
          let acc = mix.get(id);
          if (!acc) {
            const baseVal = Number(core.getParameterValueById(id)) || 0;
            acc = { num: 0, den: 0, base: baseVal, maxPrio: -1, newest: -1 };
            if (!animBase.has(id)) animBase.set(id, baseVal);
          }
          // 高优先级（姿态/手势/手动）压过低优先级（情绪）：同一参数只要有更明确的意图，
          // 就不让它被情绪的 0 值平均掉——否则「嘟嘴」里的歪头只剩一半，看着像没做。
          const prio = Number(o.prio) || 0;
          if (prio > acc.maxPrio) {
            acc.maxPrio = prio;
            acc.newest = o.start;
            acc.num = 0;
            acc.den = 0;
          } else if (prio === acc.maxPrio && o.start > acc.newest + 1) {
            // 同优先级里**后下的命令**整个接管这个参数：她先说「眯眼微笑」，
            // 再说「换生气的表情」，嘴不该还停在上一句的笑上。
            // 同一条命令写进来的多个值 start 相同，照常叠加。
            acc.newest = o.start;
            acc.num = 0;
            acc.den = 0;
          }
          if (prio < acc.maxPrio) continue;
          acc.num += o.value * w * lw;
          acc.den += w * lw;
          if (!acc.layer) acc.layer = layer;
          mix.set(id, acc);
        }
      }
      for (const [id, acc] of mix) {
        if (acc.den <= 0) continue;
        const target = acc.num / acc.den;
        const w = Math.min(1, acc.den);
        const want = acc.base * (1 - w) + target * w;
        // 缓动到目标（嘴不缓，否则说话像含着东西）
        const prev = smoothOut.has(id) ? smoothOut.get(id) : want;
        const k = id === MOUTH_ID ? 1 : 0.28;
        const sv = prev + (want - prev) * k;
        smoothOut.set(id, Math.abs(want - sv) < 0.0015 ? want : sv);
        set(id, Math.abs(want - sv) < 0.0015 ? want : sv);
      }
      // 层里已经没有的 id：缓着回原值（不是啪一下），回得差不多才放手
      for (const id of writtenIds) {
        if (mix.has(id)) continue;
        const base = animBase.has(id) ? animBase.get(id) : 0;
        const prev = smoothOut.has(id) ? smoothOut.get(id) : base;
        const sv = prev + (base - prev) * 0.20;
        if (Math.abs(sv - base) < 0.004) {
          set(id, base);
          smoothOut.delete(id);
          animBase.delete(id);
        } else {
          set(id, sv);
          releasing.add(id);
        }
      }
      writtenIds = new Set([...mix.keys(), ...releasing]);
      releasing.clear();
      // 表情层空了（自然到期 / 被心情剧变顶掉）→ 回执也跟着回到「心情」，别让她查状态时
      // 还被告知「开心」，而脸上已经是心情的颜色。
      const exprAfter = layerParams.get('expression');
      if (lastExprUntil !== 0 && lastExpr && (!exprAfter || !exprAfter.size)) {
        lastExpr = '';
        lastExprUntil = 0;
        exprBaseMood = null;
      }
    }
    // 说话时听口型的，不说话时用 max(静止的 0, 表情想要的张开) —— 惊讶能张着嘴，说话也照张
    if (layerMouthDen > 0) {
      const layerMouth = layerMouthNum / layerMouthDen;
      set(MOUTH_ID, now < talkingUntil ? Math.max(mouth, layerMouth * 0.0) : Math.max(mouth, layerMouth));
    }
    // 眼睛开合：眨眼 × 表情想要的眯眼系数。放在这里写，眨眼和表情就不再互相顶掉。
    if (blinkOn) {
      const squint = eyeSquintDen > 0
        ? Math.max(0.12, Math.min(1.35, eyeSquintNum / eyeSquintDen))
        : 1;
      // 0.98 的「闭一点」：一直瞪到 1.0 会显得呆（上眼睑贴着眼球上沿，像没眨眼能力）
      set('ParamEyeLOpen', b * 0.98 * squint);
      set('ParamEyeROpen', b * 0.98 * squint);
    }
    syncOverrides();

    // 这一帧有哪些参数被「她明确要求」的层占用（姿态/手势/手动）。
    // 情绪姿态不许改这些参数——否则她说「看着我」，情绪一强就把头拽到一边去了。
    const busyIds = new Set();
    for (const m of layerParams.values()) {
      for (const id of m.keys()) busyIds.add(id);
    }

    // 波形姿态：点头 / 摇头 / 摇尾巴。一个通道一个槽，互不打断
    // 正常走 beforeModelUpdate 钩子（在物理之后、绘制之前）；钩子没挂上时才在这兜底。
    if (!window.__waveHook) applyWaves();
    // 眼睛动、头也跟一点点：纯靠眼珠转会显得「眼球在眼眶里滑」，带上 3~4 度的转头才像在看人。
    // 只有在没被她明确摆头（姿态/手动层占着 ParamAngleX）的时候才加。
    if (!busyIds.has('ParamAngleX')) {
      frameAdds.set('ParamAngleX', (frameAdds.get('ParamAngleX') || 0) + gazeNow.x * 3.5);
      frameAdds.set('ParamAngleZ', (frameAdds.get('ParamAngleZ') || 0) + gazeNow.x * 1.8);
    }
    emotionPosture(core, busyIds);

    // ── 活体层：站着也要像活的 ──────────────────────────────────────────────
    // 三个来源叠加，都走二阶弹簧（略欠阻尼 → 到位时轻微过冲再稳住，「灵动」就来自这一点）：
    //   ① 重心：髋部慢慢左右换、膝盖反向补偿，不然像根柱子杵着
    //   ② 呼吸：肩线跟着上下、胸腔起伏
    //   ③ 惯性：头转过去之后上半身晚一点跟过去（二级动作），比整只一起转自然
    // 全部用加法写，不覆盖引擎/物理自己算的那部分；她明确摆了哪个部位就让位。
    const lifeT = now / 1000;
    const lifeSway = Math.sin(lifeT * 0.72) * 0.62 + Math.sin(lifeT * 0.31 + 1.7) * 0.38;
    const lifeBr = Math.sin(lifeT * 1.15 - 0.6);
    const lifeYaw = Number(focusAim.x) || 0;
    // 幅度收着来：站着不动时只要「还在呼吸、重心没死」，不要一直明显晃。
    // idleK 由「手感」面板的「静止幅度」控制（默认 0.42）。
    const idleK = Number(physCfg.idle ?? 0.42);
    const LIFE = [
      ['HipAngleZ', lifeSway * 4.5 * idleK],
      ['LEGAngleZ2', -lifeSway * 3.8 * idleK],
      ['HipAngleX', lifeSway * 1.2 * idleK],
      ['ShoulderY', lifeBr * 1.6 + lifeSway * 2.2 * idleK],
      ['ShoulderZ', lifeSway * 3.0 * idleK],
      ['ParamBodyAngleRX', lifeYaw * 0.22],
      ['ParamBodyAngleZ', lifeSway * 1.6 * idleK],
    ];
    lifeIds.clear();
    const LIFE_K = 130, LIFE_C = 15, LIFE_DT = 1 / 60;
    const lifeGain = Number(window.__lifeGain ?? 1);   // 调参用：0 = 关掉活体层，1 = 正常
    for (const [id, target0] of LIFE) {
      if (busyIds.has(id)) continue;
      const target = target0 * lifeGain;
      let st = lifeSpring.get(id);
      if (!st) { st = { x: target, v: 0 }; lifeSpring.set(id, st); }
      st.v += ((target - st.x) * LIFE_K - st.v * LIFE_C) * LIFE_DT;
      st.x += st.v * LIFE_DT;
      frameAdds.set(id, (frameAdds.get(id) || 0) + st.x);
      lifeIds.add(id);
    }

    // 把这一帧「眼珠该在哪」记下来：姿态层写进去的、或者引擎自己算的，都算数。
    // 下一帧的 beforeModelUpdate 会把这两个值再写一次，盖过引擎的 updateFocus。
    const cEye = model?.internalModel?.coreModel;
    if (cEye) {
      const ex = Number(cEye.getParameterValueById('ParamEyeBallX'));
      const ey = Number(cEye.getParameterValueById('ParamEyeBallY'));
      if (Number.isFinite(ex) && Number.isFinite(ey)) eyeWant = { x: ex, y: ey };
    }

    // 钩子没挂上时兜底：至少把这些值直接写进去（会晚一帧，但比完全不动好）
    if (!window.__waveHook) flushWrites();

  }, null, PIXI.UPDATE_PRIORITY.LOW);

// 波形：点头 / 摇头 / 摇尾巴。挂在模型的 beforeModelUpdate 上执行（见 boot 里的注册），
// 这样写进去的尾巴参数不会被同一帧的物理演算盖回去，也不用再把物理整个摘掉。
function beforeModelHook() {
  flushWrites();      // 头/身体/嘴/眨眼这些「这一帧算好的绝对值」也要在这里写
  applyWaves();
  applyEyes();
  sampleProbe();
}

// 为什么所有参数写入都要挤到这里：引擎每帧的顺序是
//   动作 → 表情 → 眨眼 → 视线(updateFocus) → 自然动作 → 物理 → beforeModelUpdate → core.update()
// 我们的 ticker 跑在 core.update() **之后**，那一刻写进去的值只影响下一帧，
// 而下一帧的物理/视线又会把它盖掉 —— 结果就是「歪头只有 15 度、看着像没动」。
// 所以 ticker 只负责算，真正写入放到 beforeModelUpdate。
function flushWrites() {
  if (frozen) { frameWrites.clear(); frameAdds.clear(); return; }
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  for (const [id, v] of frameWrites) {
    try { core.setParameterValueById(id, v); } catch (e) { /* 忽略 */ }
  }
  for (const [id, d] of frameAdds) {
    try {
      const cur = Number(core.getParameterValueById(id)) || 0;
      core.setParameterValueById(id, cur + d);
    } catch (e) { /* 忽略 */ }
  }
  // 眼珠：applyEyes() 会在同一个钩子里再写一次 eyeWant，所以这里先把它对齐到这一帧算好的值，
  // 否则「视线」会被上一帧读到的旧值盖回去（表现出来就是眼神发直、盯着一个点不动）。
  if (frameWrites.has('ParamEyeBallX') && frameWrites.has('ParamEyeBallY')) {
    eyeWant = { x: Number(frameWrites.get('ParamEyeBallX')), y: Number(frameWrites.get('ParamEyeBallY')) };
  }
  // 排障用：flush 到底写进去了没有（写完立刻回读一次，控制台可查 window.__bodyFlush）
  try {
    window.__bodyFlush = {
      n: frameWrites.size,
      puff: core.getParameterValueById('CheeckPuff'),
      mf: core.getParameterValueById('ParamMouthForm'),
      z: core.getParameterValueById('ParamAngleZ')
    };
  } catch (e) { /* ignore */ }
  frameWrites.clear();
  frameAdds.clear();
}

// 眼珠：引擎每帧在 updateFocus() 里会把 ParamEyeBallX/Y 重算一遍（它总盯着某个点），
// 我们的写入在 core.update 之后，下一帧又会被它盖掉 —— 结果就是「看向你」永远看不出来。
// 所以在 beforeModelUpdate（视线之后、绘制之前）把上一帧算好的目标值再写一次。
function applyEyes() {
  if (frozen) return;
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  if (eyeWant.x === null) return;
  try {
    core.setParameterValueById('ParamEyeBallX', eyeWant.x);
    core.setParameterValueById('ParamEyeBallY', eyeWant.y);
  } catch (e) { /* 忽略 */ }
}

// 探针采样：这一帧真正要画出去的参数值（在物理之后、core.update 之前读）
function sampleProbe() {
  if (!probeIds.length) return;
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  for (const id of probeIds) {
    let v;
    try { v = Number(core.getParameterValueById(id)); } catch (e) { continue; }
    if (!Number.isFinite(v)) continue;
    const r = probeRange.get(id);
    if (!r) probeRange.set(id, { min: v, max: v });
    else { if (v < r.min) r.min = v; if (v > r.max) r.max = v; }
  }
}

function applyWaves() {
  const core = model?.internalModel?.coreModel;
  if (!core || !channelWaves.size) return;
  const tms = performance.now();
  for (const [ch, w] of channelWaves) {
    if (tms > w.until) {
      channelWaves.delete(ch);
      if (w.noPhysics) restorePhysics();
      continue;
    }
    if (w.noPhysics) suspendPhysics();
    const p = (tms - w.t0) / 1000;
    const total = (w.until - w.t0) / 1000;
    const env = Math.max(0, Math.min(1, p / 0.22, (total - p) / 0.3));
    const ids = w.ids;
    // 摆动中心只取一次，否则每帧把上一帧的写回当基准，会一路漂走
    if (!w.base) w.base = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!(id in w.base)) w.base[id] = Number(core.getParameterValueById(id)) || 0;
      const base = w.base[id];
      // 尾巴六节越靠后越甩，看着像真的摆过去；
      // 但腰腹这种链条要**各自指定幅度和相位**（胯先动、上身晚半拍），所以 amp/phase 可以是对象
      const amp = (w.amp && typeof w.amp === 'object')
        ? (Number(w.amp[id]) || 0)
        : w.amp * (ids.length > 1 ? 0.5 + i * 0.14 : 1);
      const phase = (w.phase && typeof w.phase === 'object')
        ? (Number(w.phase[id]) || 0)
        : -i * 0.45;
      const val = base + env * amp * physSwing * Math.sin(2 * Math.PI * w.hz * p + phase);
      try { core.setParameterValueById(id, val); } catch (e) { /* ignore */ }
    }
  }
}

// 情绪带动头/肩：这套皮的脸部参数很弱（实测嘴形满幅 30% 像素变化、眉毛只有 5–10%），
// 光靠脸上那点变化，隔着一米看根本分不出来。所以把情绪再「漏」一点到姿态上：
// 开心 → 头往一边偏、身体跟着轻晃；难过 → 头低下去；生气 → 下巴抬起来、肩绷住。
// 这里是**加法**（在视线跟随算完之后再加），所以既不会把她的注视顶掉，也不会被顶掉。
function emotionPosture(core, busyIds) {
  if (!core || frozen || !lastEmotionAt) return;
  const { v, a, d } = lastEmotion;
  const amt = Math.min(1, Math.abs(v) * 1.15 + Math.abs(a) * 0.35);
  if (amt < 0.06) return;
  const t = performance.now() / 1000;
  const breathe = Math.sin(t * 1.05) * (0.35 + Math.abs(a) * 0.5);
  const tilt = (v >= 0 ? 1 : -1) * amt * 7 + breathe;          // 开心向右歪，难过向左歪
  const nod = -Math.max(0, -v) * amt * 6 + Math.max(0, d) * amt * 3;  // 难过低头，有底气抬下巴
  const lean = (v >= 0 ? 1 : -1) * amt * 4;
  const push = (id, delta) => {
    // 她明确摆了姿态（比如「看向你」「抬头」）时，情绪不许再往头上叠：
    // 以前情绪强的时候会把头拽到一边，看着就是「让她看我她偏看右边」。
    if (busyIds && busyIds.has(id)) return;
    frameAdds.set(id, (frameAdds.get(id) || 0) + delta);
  };
  push('ParamAngleZ', tilt);
  push('ParamAngleY', nod);
  push('ParamBodyAngleZ', lean);
  push('ParamBodyAngleX', -lean * 0.5);
}

// 待机动作整段停用：她说过「只让我的鱼来操控身体」，所以不再自己找小动作。
  // 想恢复的话，把 AUTONOMY 打开就行（下面 schedulePose / saccade 都看这个开关）。

// 情绪驱动的「自发小动作」：跟 AUTONOMY 那套随机乱动不一样——
// 它看的是 she 当前的心情（v 好坏 / a 激动），只有心情明显偏一边时才动一下。
// 节奏很克制：35–70 秒一次，而且只有两种动作（心情好→晃腰短版；低落→沉一下肩）。
// 有人正在调她、正在说话、有波形/姿态占位、页面藏着时都跳过。
let nextSpontAt = 0;
let spontCount = 0;
let spontName = '';
function maybeSpontaneous(now) {
  if (!nextSpontAt) { nextSpontAt = now + 30000 + Math.random() * 20000; return; }
  if (now < nextSpontAt) return;
  nextSpontAt = now + 35000 + Math.random() * 35000;   // 35–70 秒
  if (pinnedHead || now < talkingUntil + 800) return;
  if (channelWaves.size || poseOverrides.size) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const v = Number(lastEmotion?.v) || 0;
  const a = Number(lastEmotion?.a) || 0;
  if (v > 0.25 || (a > 0.45 && v > -0.05)) {
    spontName = '晃腰';
    applyPose('晃腰', 2300 + Math.round(Math.random() * 600));
  } else if (v < -0.25) {
    spontName = '沉肩';
    applyPose('沉肩', 3000);
  } else {
    return;   // 心情平平就老实待着——待机动作不堆量
  }
  spontCount += 1;
}
window.__spont = () => ({ n: spontCount, last: spontName, nextIn: Math.max(0, Math.round((nextSpontAt - Date.now()) / 1000)), v: Number(lastEmotion?.v) || 0, a: Number(lastEmotion?.a) || 0 });
// 排障用：立刻按给定心情试一次（不用等 20 秒）
window.__spontForce = (v = 0.8, a = 0.3) => { lastEmotion = { v: Number(v) || 0, a: Number(a) || 0, d: 0 }; nextSpontAt = Date.now() - 1; return true; };

  // 自己找点事做：隔一阵甩下尾巴、歪下头、瞟一眼别处——只有打开 AUTONOMY 才会跑
  const IDLE_POSES = ['看左', '看右', '看上', '看下', '摇尾巴', '吐舌头', '鼓脸', '开心', '歪头', '点头'];
  const schedulePose = () => {
    if (!autonomy) return;
    const wait = 18000 + Math.random() * 17000;
    setTimeout(() => {
      try {
        // 正在说话、正在做别的姿态、页面被藏起来时都别抢戏
        if (frozen || !autonomy) { schedulePose(); return; }
        if (document.hidden) { schedulePose(); return; }
        if (channelWaves.size || poseOverrides.size || Date.now() < talkingUntil + 1200) { schedulePose(); return; }
        if (Math.random() < 0.3) { schedulePose(); return; }   // 也不是每次都动，留点安静
        applyPose(IDLE_POSES[Math.floor(Math.random() * IDLE_POSES.length)]);
      } catch (e) { /* ignore */ }
      schedulePose();
    }, wait);
  };
  schedulePose();

  // 排队泵：动作通道忙的时候排上的动作，等通道空了就按顺序演
  setInterval(pumpQueue, 250);

  // 心跳：每 2 秒把当前姿态报给服务端，用来确认这具身体真的在动（/state 的 lastHb）
  setInterval(() => {
    window.__hbTicks = (window.__hbTicks || 0) + 1;
    try {
      const c = window.__model?.internalModel?.coreModel;
      if (dumpParams && c) {
        dumpParams = false;
        const bad = [];
        for (const [id, info] of PARAM_INFO.entries()) {
          let v = 0;
          try { v = Number(c.getParameterValueById(id)); } catch { continue; }
          const d = Number(info.def) || 0;
          if (Math.abs(v - d) > 0.25 && Math.abs(v) > 0.05) bad.push(`${id}=${v.toFixed(2)}(默认${d})`);
        }
        paramDump = bad.slice(0, 40).join(' | ');
      }
      const body = {
        angleX: c ? +Number(c.getParameterValueById('ParamAngleX')).toFixed(3) : null,
        eye: c ? +Number(c.getParameterValueById('ParamEyeLOpen')).toFixed(3) : null,
        frames: Math.round(performance.now() / 1000),
        // 真实帧率：拖动窗口卡不卡、切到 GPU 之后有没有变快，看这个数
        fps: Math.round(tickerFps),
        gfx: rendererKind,
        seq: appliedSeq,
        bld: String(window.__bodyBuild || ''),
        // 波形钩子挂上了没（没挂上就只有兜底路径，尾巴会被物理盖掉）
        wh: window.__waveHook ? 1 : 0,
        // 现在还挂着的模型自带动画（exp3，比如圈圈眼）；空 = 没挂
        mexpr: modelExprActive,
        word: lastWord,                       // 最近一次词表命中（排障：她说了什么、我拆成了哪几个词）
        sink: Math.round(bodySink),           // 整体沉降（低头/抬头用的位移）
        pd: paramDump,
        waves: [...channelWaves.keys()].join(','),
        ws: wsRef ? wsRef.readyState : -1,
        bubble: BUBBLE.className || '',
        bubbleText: String(BUBBLE.textContent || '').slice(0, 12),
        sayAge: lastSayAt ? Math.round((Date.now() - lastSayAt) / 1000) : -1,
        fd: window.fishDesktop ? 1 : 0,
        dragN: dragDowns,
        pose: [
          channelWaves.size ? `w${channelWaves.size}` : '',
          poseOverrides.size ? `${poseOverrides.size}p` : ''
        ].filter(Boolean).join('+') || '',
        waves: [...channelWaves.keys()].join(','),
        q: actionQueue.length,
        qdbg: lastDispatch,
        // 分层混合：现在哪几层在写参数（回执里能看出「几件事同时在演」）
        mix: [...layerParams.entries()].filter(([, m]) => m.size).map(([k]) => k).join('+'),
        // 连续情绪：她给的那三个数现在是多少（回执里能读回来，不用猜）
        emo: [Number(lastEmotion.v.toFixed(2)), Number(lastEmotion.a.toFixed(2)), Number(lastEmotion.d.toFixed(2))],
        emoName: lastEmotionAt ? emotionName(lastEmotion) : '',
        word: lastWord,
        // 现在挂着哪些道具/换装（黑脸、眼镜、脱鞋、长短裙…）
        sw: [...switchState].join(','),
        // 回执用：现在在做什么、还剩多久（她看不到画面，只能靠这些字知道）
        // until=0 表示常驻（她说了就一直那样），回执里给 -1，免得被当成「马上到期」
        poseName: lastPose.name && (lastPose.until === 0 || Date.now() < lastPose.until) ? lastPose.name : '',
        poseLeft: lastPose.until === 0 ? -1 : Math.max(0, Math.round((lastPose.until - Date.now()) / 100) / 10),
        expr: (layerParams.get('expression')?.size ? lastExpr : (lastExpr || '')),
        exprPermanent: lastExprUntil === 0 ? 1 : 0,
        // 参数型回执用：表情到底写进去几个参数、还差多少毫秒到期
        exprN: (lastExpr && EMOTIONS[resolveEmotion(lastExpr)]) ? Object.keys(EMOTIONS[resolveEmotion(lastExpr)]).length : 0,
        exprLeft: lastExprUntil === 0 ? -1 : Math.max(0, Math.round((lastExprUntil - Date.now()) / 100) / 10),
        auto: autonomy ? 1 : 0,
        frozen: frozen ? 1 : 0,
        talk: Date.now() < talkingUntil,
        hands: HAND_PARAMS.filter((id) => poseOverrides.has(id)).length,
    handLeft: Math.max(0, Math.round((lastHandUntil - Date.now()) / 100) / 10),
    holdDbg,
        scale: userScale,
        gaze: [+gazeNow.x.toFixed(2), +gazeNow.y.toFixed(2)],
        vw: window.innerWidth,
        vh: window.innerHeight,
        dpr: window.devicePixelRatio,
        // 窗口在屏幕上的位置（CSS 像素），截图定位用，比从外面猜 GetWindowRect 靠谱
        sx: Math.round(window.screenX),
        sy: Math.round(window.screenY),
        tap: motionDefs('TapBody').map((d) => motionFile(d).replace(/^.*\//, '').replace(/\.motion3\.json$/, '')),
        poses: Object.keys(POSES),
        // 探针结果：两次心跳之间这几个参数的最小/最大值（能看到「动没动、幅度多大」）
        pv: probeIds.length ? probeIds.map((id) => {
          const r = probeRange.get(id) || { min: null, max: null };
          return [id.replace(/^Param_?/, ''), r.min, r.max];
        }) : null,
        probe: c ? {
          ebx: +Number(c.getParameterValueById('ParamEyeBallX')).toFixed(2),
          eby: +Number(c.getParameterValueById('ParamEyeBallY')).toFixed(2),
          px: +Number(c.getParameterValueById('PupilX')).toFixed(2),
          py: +Number(c.getParameterValueById('PupilY')).toFixed(2)
        } : null
      };
      fetch('/hb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch((e) => { window.__hbErr = 'fetch:' + String(e && e.message || e); });
      probeRange = new Map();  // 心跳发完就清，下一个窗口重新统计
    } catch (e) { window.__hbErr = String(e && e.message || e); }
  }, 2000);
  hud('已就位 · 等她的命令');
  connect();
}

function fit() {
  if (!model) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const base = Math.min(w / model.internalModel.originalWidth, h / model.internalModel.originalHeight) * 0.92;
  const s = base * userScale;
  model.scale.set(s);
  model.anchor.set(0.5, 0.5);
  // 放大时往上抬一点，免得脚被窗口底边切掉
  baseY = h / 2 + h * 0.02 + (userScale - 1) * h * 0.10;
  baseX = w / 2;
  model.position.set(baseX, baseY);
}

// 大小：0.5 小一号 … 1 刚好 … 1.5 怼脸。记得住，下次开窗还是这么大
function setScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) { hud(`现在是 ${userScale.toFixed(2)} 倍`); return false; }
  userScale = Math.max(0.4, Math.min(1.6, n));
  try { localStorage.setItem('fishScale', String(userScale)); } catch (e) { /* ignore */ }
  fit();
  hud(`大小 ${userScale.toFixed(2)} 倍`);
  return true;
}

// 换表情时点一下头的幅度（正=点头，负=抬头）。0 就是不点。

// ——— P2：连续情绪（VAD → AU 权重）＋ 词表 ———
// 她不再只能「换一整套表情」，而是给三个连续量：效价 v（开心/难过）、唤醒 a（激动/平静）、支配 d（有底气/怯）。
// 这里把它算成一组面部动作单元的权重，写进 emotion 那一层，所以能和姿态、手势同时成立。

let lastEmotion = { v: 0, a: 0, d: 0 };
let lastEmotionAt = 0;

const clamp1 = (x) => Math.max(-1, Math.min(1, Number(x) || 0));

function vadToAU(v, a, d) {
  const V = clamp1(v), A = clamp1(a), D = clamp1(d);
  // 轻度情绪在脸上会被「抹平」（这套皮的形变本来就小），用 0.72 次方把中间值抬起来：
  // v=0.45 不再是 0.45 的幅度，而是 0.56；v=1 仍然是 1，不会过冲。
  const gain = (x) => Math.sign(x) * Math.pow(Math.abs(x), 0.72);
  const pos = Math.max(0, gain(V)), neg = Math.max(0, -gain(V));
  const up = Math.max(0, gain(A)), down = Math.max(0, -gain(A));
  // 愤怒＝负效价 + 高唤醒 + 有底气；三者都到位才真的「凶」
  const anger = Math.min(1, neg * Math.max(0, A) * (0.5 + Math.max(0, D)) * 1.7);
  return {
    // 嘴角与笑肌
    MouthSmile_L: pos - neg * 0.35,
    MouthSmile_R: pos - neg * 0.35,
    EyeSmile: pos * 0.9,
    ParamMouthForm: pos - neg * 0.9,
    // 眉毛：负效价压内角，唤醒高抬眉，低唤醒压外侧
    ParamBrowLY: up * 0.5 + neg * 0.4 - down * 0.15,
    ParamBrowRY: up * 0.5 + neg * 0.4 - down * 0.15,
    ParamBrowLAngle: neg * 0.9 + up * 0.1,
    ParamBrowRAngle: neg * 0.9 + up * 0.1,
    BrowInnerUp: neg * 0.75,
    // 眼睛：中性时必须回到 1.0，否则一给情绪就像没睡醒
    ParamEyeLOpen: 1 + up * 0.12 - neg * 0.35,
    ParamEyeROpen: 1 + up * 0.12 - neg * 0.35,
    // 张嘴：只有高唤醒才张一点（说话另有一层在管）
    ParamMouthOpenY: up * 0.22 * (0.5 + 0.5 * Math.max(0, V)),
    // 愤怒专用（这套皮的 Angry 参数）
    Angry: anger,
    Angry3: anger * 0.8,
    Mouthpucker: Math.min(1, neg * up * 0.5),
    // 脸颊：正向情绪才有
    CheeksWiggleY: Math.max(0, V) * 0.7,
    CheeksWiggleX: Math.max(0, V) * 0.45
  };
}

function emotionName(e) {
  if (!e) return '平静';
  const { v, a, d } = e;
  if (Math.abs(v) < 0.22 && Math.abs(a) < 0.4) return '平静';
  if (v >= 0.25) return a >= 0.35 ? '兴奋' : '满足';
  if (a >= 0.35) return d >= 0 ? '生气' : '紧张';
  return d <= -0.2 ? '委屈' : '低落';
}

function applyEmotion(vec, holdMs, label) {
  if (!model) return false;
  const v = clamp1(vec.v), a = clamp1(vec.a), d = clamp1(vec.d);
  const au = vadToAU(v, a, d);
  const keep = Number(holdMs) > 0 ? Number(holdMs) : 0;
  // 心情剧变 → 表情提前退场（她笑的时候被一句难过的话噎住，脸应该跟着变）
  const exprLayer0 = layerParams.get('expression');
  if (exprLayer0 && exprLayer0.size && exprBaseMood && lastExprUntil !== 0) {
    const dv = Math.abs(v - exprBaseMood.v);
    const da = Math.abs(a - exprBaseMood.a);
    if (dv >= EXPR_SURGE_V || da >= EXPR_SURGE_A) {
      releaseExpression(`心情变了（Δv ${dv.toFixed(2)} / Δa ${da.toFixed(2)}）`);
    }
  }
  // 同理：心情层每次整层重写，免得上一组 AU 的残留参数和新的一组混在一起。
  layerOf('emotion').clear();
  const n = setParamMap(au, keep, 2, 'face', { layer: 'emotion' });
  if (!n) return false;
  lastEmotion = { v, a, d };
  lastEmotionAt = Date.now();
  // 她自己摆过表情（expression 层还没空）时，心情只当底色，不许把回执里的表情名改掉——
  // 否则她明明笑着，查状态却被告知「平静」。
  const exprLayer = layerParams.get('expression');
  if (!exprLayer || !exprLayer.size) {
    lastExpr = label || emotionName(lastEmotion);
    lastExprUntil = keep > 0 ? Date.now() + keep : 0;
  }
  emotionPulseAt = performance.now();
  emotionPulseAmp = 0.12 + Math.abs(v) * 0.2;
  return true;
}

// 让表情层淡出（不等它自然到期）：把这一层的每个参数到期时间压到现在，
// 混合权重会在 RELEASE_MS 内降到 0，看起来是「表情慢慢松开」，不是啪一下换脸。
function releaseExpression(why = '') {
  const layer = layerParams.get('expression');
  if (!layer || !layer.size) return false;
  const now = Date.now();
  for (const [, o] of layer) o.until = Math.min(o.until, now);
  lastExprUntil = now;
  exprBaseMood = null;
  if (why) hud(`表情淡出：${why}`);
  return true;
}

// 词表：她说词，参数藏在词底下（她说「我歪头的时候也不用知道脖子几度」）。
// 词表放在 live2d/lexicon.json，改词不用改代码；文件读不到就用下面这份最小兜底。
const LEXICON_FALLBACK = {
  version: 1,
  modifiers: { 有点: 0.45, 稍微: 0.4, 一点: 0.45, 挺: 0.8, 很: 1, 特别: 1, 非常: 1.05, 超级: 1.15 },
  words: {
    开心: { emotion: { v: 0.7, a: 0.45, d: 0.2 } },
    难过: { emotion: { v: -0.65, a: -0.25, d: -0.3 } },
    委屈: { emotion: { v: -0.55, a: 0.15, d: -0.35 } },
    生气: { emotion: { v: -0.7, a: 0.65, d: 0.5 }, pose: '鼓脸' },
    害羞: { emotion: { v: 0.35, a: 0.2, d: -0.45 } },
    惊讶: { emotion: { v: 0.05, a: 0.85, d: -0.1 } },
    平静: { emotion: { v: 0, a: 0, d: 0 } },
    歪头: { pose: '歪头' },
    摇尾巴: { pose: '摇尾巴' },
    点头: { pose: '点头' },
    摇头: { pose: '摇头' },
    举手: { gesture: '举手' },
    竖指: { gesture: '竖指' }
  }
};
let LEXICON = LEXICON_FALLBACK;

async function loadLexicon() {
  try {
    const r = await fetch('/lexicon.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.words && typeof j.words === 'object' && Object.keys(j.words).length) {
      LEXICON = { modifiers: j.modifiers || LEXICON_FALLBACK.modifiers, words: j.words };
    }
  } catch (e) { /* 用兜底 */ }
}

function findWord(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (LEXICON.words[t]) return t;
  let best = '';
  for (const k of Object.keys(LEXICON.words)) if (t.includes(k) && k.length > best.length) best = k;
  return best || null;
}

function applyWord(text, holdMs) {
  const key = findWord(text);
  if (!key) return false;
  const entry = LEXICON.words[key] || {};
  let scale = 1;
  for (const [mod, k] of Object.entries(LEXICON.modifiers || {})) {
    if (String(text || '').includes(mod)) { scale = Number(k) || 1; break; }
  }
  let did = false;
  if (entry.emotion) {
    did = applyEmotion({ v: (Number(entry.emotion.v) || 0) * scale, a: (Number(entry.emotion.a) || 0) * scale, d: (Number(entry.emotion.d) || 0) * scale }, holdMs, key) || did;
  }
  if (entry.pose && POSES[entry.pose]) did = applyPose(entry.pose, holdMs) || did;
  if (entry.gesture) did = applyMotion(entry.gesture, holdMs) || did;
  if (entry.switch) {
    for (const s of [].concat(entry.switch)) did = applySwitch(s, true) || did;
  }
  if (entry.param) did = setParamMap(entry.param, holdMs, 3, 'manual', { layer: 'manual' }) > 0 || did;
  if (did) lastWord = String(text || key);
  return did;
}

let lastWord = '';
let phraseExprTimer = 0;   // exp3 类词（脸红）到点自己收

// ── 词表 v2：把「一句话」拆成通道，再落成参数 ───────────────────────────
// 为什么要有这层：老词表一个词只对一种东西（或表情、或姿态、或开关），
// 她没法说「微微歪头 + 眯眼 + 尾巴慢慢甩」。现在词 → 通道（head_roll / eye_open /
// tail_up…），通道再摊成参数，多个词直接相加，于是「菜单」变成了「积木」。
let VOCAB = null;

async function loadVocab() {
  try {
    const r = await fetch('/vocab.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.words && j.channels) VOCAB = j;
  } catch (e) { /* 没有就用老词表 */ }
}

function findAt(dict, s, i) {
  let best = '';
  if (!dict) return null;
  for (const k of Object.keys(dict)) if (k && s.startsWith(k, i) && k.length > best.length) best = k;
  return best || null;
}

function normPhrase(s) {
  return String(s || '')
    .replace(/[\s，。、,.!！?？~～…—\-+＋/]/g, '')
    .replace(/然后|接着|再|并且|而且|同时/g, '');
}

// 返回 { ok, words, channels, hold, sink }
function applyPhrase(text, holdMs) {
  if (!VOCAB || !model) return null;
  const s = normPhrase(text);
  if (!s) return null;
  const ch = {};
  const used = [];
  const waves = [];
  const exprs = [];        // 有些词真身是 exp3（脸红就是），光写参数看不出来
  let degree = 1;
  let durMs = null;
  let i = 0;
  let matched = 0;
  while (i < s.length) {
    const deg = findAt(VOCAB.degrees, s, i);
    if (deg) { degree = Number(VOCAB.degrees[deg]) || 1; i += deg.length; continue; }
    const dur = findAt(VOCAB.durations, s, i);
    if (dur) { durMs = Number(VOCAB.durations[dur]) || 0; i += dur.length; continue; }
    const w = findAt(VOCAB.words, s, i);
    if (w) {
      const e = VOCAB.words[w] || {};
      used.push(w);
      matched += 1;
      for (const [c, v] of Object.entries(e)) {
        if (c === 'wave') { waves.push(v); continue; }
        if (c === 'switch') { exprs.push(String(v)); continue; }
        ch[c] = (ch[c] || 0) + Number(v) * degree;
      }
      degree = 1;                 // 程度词只管紧跟着的那个词
      i += w.length;
      continue;
    }
    i += 1;
  }
  if (!matched) return null;

  const deltas = {};
  const bases = {};          // 通道可以指定「从哪个基准值算」（眼睛默认 1，不是 0）
  let sink = 0;
  const applied = {};
  for (const [c, raw] of Object.entries(ch)) {
    const cdef = VOCAB.channels[c];
    if (!cdef) continue;
    const v = Math.max(-1.3, Math.min(1.3, Number(raw) || 0));
    if (!v) continue;
    applied[c] = +v.toFixed(2);
    const cb = Number.isFinite(Number(cdef.base)) ? Number(cdef.base) : null;
    for (const [pid, unit] of Object.entries(cdef.params || {})) {
      deltas[pid] = (deltas[pid] || 0) + Number(unit) * v;
      if (cb !== null) bases[pid] = cb;
    }
    if (v > 0 && cdef.sinkUp) sink += Number(cdef.sinkUp) * v;
    if (v < 0 && cdef.sinkDown) sink += Number(cdef.sinkDown) * (-v);
  }
  const map = {};
  for (const [pid, d] of Object.entries(deltas)) {
    const info = PARAM_INFO.get(pid);
    if (!info) continue;
    const b = bases[pid] !== undefined ? bases[pid] : (Number(info.def) || 0);
    map[pid] = b + d;   // 相对基准值算，眼睛这种「默认 1」的才对
  }
  const hold = Number.isFinite(Number(holdMs)) && Number(holdMs) > 0
    ? Number(holdMs)
    : (durMs !== null ? durMs : 0);
  const n = setParamMap(map, hold, 3, 'manual', { layer: 'manual' });
  if (sink) {
    bodySinkTarget = clampNum(bodySink + sink, -60, 60);
  }
  // 波形类（点头/摇头/摇尾巴）：走通道波形，和姿态共用一套
  for (const wid of waves) {
    const wv = VOCAB.waves[wid];
    if (!wv) continue;
    const now = performance.now();
    channelWaves.set('tail', {
      ch: 'tail', ids: wv.ids.slice(), amp: clampNum(wv.amp, 8), hz: clampNum(wv.hz, 1.5),
      t0: now, until: now + Math.max(300, Math.min(30000, Number(wv.ms) || 2000))
    });
  }
  // exp3 类（脸红…）：这类效果只在模型自带的表达式里，参数里没有
  let exprOn = '';
  if (exprs.length) {
    const want = exprs[0];
    if (applyModelExpression(want)) {
      exprOn = want;
      hud(`模型动画：${want}`);
      const keep = hold > 0 ? hold : (durMs || EXPR_IMPLICIT_MS);
      if (phraseExprTimer) clearTimeout(phraseExprTimer);
      phraseExprTimer = setTimeout(() => {
        if (modelExprActive === want) clearModelExpression();
        phraseExprTimer = 0;
      }, Math.max(1500, keep));
    }
  }
  if (!n && !waves.length && !exprOn) return null;
  lastWord = used.join('+');
  return { ok: true, words: used, channels: applied, hold, sink: +sink.toFixed(1), n, expr: exprOn };
}

function applyExpression(name, holdMs) {
  if (!model || !name) return false;
  const emo = EMOTIONS[resolveEmotion(name)];
  if (emo) {
    // 走参数通道：setParamMap 自带淡入（poseOverrides 的 w 斜坡），所以表情是「过渡」出来的，
    // 不是啪一下换完。她之前抱怨的「切换全是硬切」主要就是这里。
    //
    // 时长语义（2026-11-03 定）：
    //   holdMs 不填 / 0  → 表情活 EXPR_IMPLICIT_MS（25 秒）后自己淡回心情脸；
    //   holdMs = -1       → 常驻，直到她换下一个表情或复位（她原话「说了就掐，没说就一直」）；
    //   holdMs > 0        → 保持这么多毫秒。
    // 为什么不再默认常驻：心情桥每隔几秒推一次 v/a/d，脸一直笑、人却在难过，会明显脱节。
    const raw = Number(holdMs);
    const keep = Number.isFinite(raw) && raw < 0 ? 0 : (raw > 0 ? raw : EXPR_IMPLICIT_MS);
    // 换表情先把「脸」这个槽位清空：不然上一套表情独有的参数（比如笑眼的 EyeSmile）
    // 会一直挂着，和新表情拼成「一半笑一半难过」的脸；顺带把互斥的脸部姿态（眯眼/嘟嘴）也摘掉。
    clearFaceSlot();
    // 放独立的一层（优先级 3 > 情绪的 2）：心情桥推过来的 v/a/d 每几秒就会重写「情绪」层，
    // 如果表情也放那层，她刚摆好的脸会被心情洗掉——她抱怨过「表情保持不了」就是这个。
    const n = setParamMap(emo, keep, 3, 'face', { layer: 'expression' });
    if (n) {
      lastExpr = String(name);
      lastExprUntil = keep > 0 ? Date.now() + keep : 0;   // 0 = 常驻
      // 记下摆表情那一刻的心情，用来判断「情绪是不是剧变了」
      exprBaseMood = { v: Number(lastEmotion.v) || 0, a: Number(lastEmotion.a) || 0, at: Date.now() };
      // 换表情的那一下轻轻点一下头/晃一下身：静态差别在 460px 窗口里太小，
      // 有「动」才抓得住眼睛（她说过「表情一帧换完看着僵」，反过来也一样——不动就看不出来）
      emotionPulseAt = performance.now();
      emotionPulseAmp = EMOTION_PULSE[resolveEmotion(name)] || 0;
      hud(`表情：${name}${keep > 0 ? `（${(keep / 1000).toFixed(1)} 秒后回心情）` : '（常驻）'}`);
      return true;
    }
  }
  try {
    const ok = model.expression(name);
    eyeLockUntil = performance.now() + 5000;
    if (ok !== false) {
      lastExpr = String(name);
      hud(`表情：${name}`);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// 「委屈」「有点难过」这种口语，落到上面那几套参数组合上
const EMOTION_ALIAS = {
  '不开心': '难过', '难过': '难过', '委屈': '委屈', '想哭': '难过',
  '开心': '开心', '高兴': '开心', '笑': '开心', '嘿嘿': '开心',
  '疑惑': '疑惑', '困惑': '疑惑', '不解': '疑惑',
  '生气': '生气', '恼': '生气', '气': '生气',
  '害羞': '害羞', '脸红': '害羞', '羞': '害羞',
  '惊讶': '惊讶', '吃惊': '惊讶', '惊': '惊讶',
  '平静': '平静', '正常': '平静', '默认': '平静'
};

function resolveEmotion(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (EMOTIONS[n]) return n;
  if (EMOTION_ALIAS[n]) return EMOTION_ALIAS[n];
  const bare = n.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '');
  if (EMOTIONS[bare]) return bare;
  if (EMOTION_ALIAS[bare]) return EMOTION_ALIAS[bare];
  for (const key of Object.keys(EMOTION_ALIAS)) if (n.includes(key)) return EMOTION_ALIAS[key];
  return '';
}

// 动作定义放在 settings.motions 里；motionManager.motionGroups 是运行时缓存，
// 只有播过一次才会填上，刚加载时是空的 —— 之前用后者判断，结果 TapBody 永远被跳过，
// 云端发「举手」实际什么都不放。
function motionDefs(group) {
  try {
    const st = model?.internalModel?.settings;
    const src = st?.motions || st?.data?.motions || {};
    const list = src[group];
    if (Array.isArray(list) && list.length) return list;
  } catch (e) { /* ignore */ }
  try {
    const list = model?.internalModel?.motionManager?.motionGroups?.[group];
    if (list && list.length) return list;
  } catch (e) { /* ignore */ }
  return [];
}

function motionFile(d) {
  return String(d?.File || d?.file || '');
}

// 读动作文件，取每条曲线的**最后一个关键帧值**——那就是这个动作播完时手应该停的位置。
// 靠「播完再读当前参数」是抓不到的：待机动作早就把手插值回默认了（实测读到一串 0）。
async function motionEndValues(file) {
  const out = {};
  if (!file) return out;
  try {
    const url = '/model/' + String(file).split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url);
    if (!r.ok) return out;
    const j = await r.json();
    for (const c of j?.Curves || []) {
      if (c.Target !== 'Parameter' || !c.Id) continue;
      if (!HAND_PARAMS.includes(c.Id)) continue;
      const seg = c.Segments || [];
      if (!seg.length) continue;
      const v = Number(seg[seg.length - 1]);   // 各段类型（阶梯/线性/贝塞尔）最后一个数都是终值
      if (Number.isFinite(v)) out[c.Id] = v;
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 「举手」这种口语词要落到正确的那一条动作上。
// 坑：`includes('举手')` 会先命中「举手切默认手」——那是把手放下的动作，
// 结果她说「举手」画面里反而没变化。这里先把口语词映射成动作文件里的关键词。
const MOTION_ALIAS = {
  '举手': '默认手切举手',
  '举起': '默认手切举手',
  '抚胸': '默认手切举手',
  '放下手': '举手切默认手',
  '放下': '举手切默认手',
  '收手': '举手切默认手',
  '竖手指': '竖手指切出来动画',
  '竖食指': '竖手指切出来动画',
  '伸手指': '竖手指切出来动画',
  '手指收回': '竖手指切回默认',
  '狗尾草': '狗尾草切换出来',
  '狗尾巴草': '狗尾草切换出来',
  '狗尾草收回': '狗尾草切回默认手',
  '脱捕': '脱捕'
};

function resolveMotionName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (MOTION_ALIAS[n]) return MOTION_ALIAS[n];
  // 「举 手」「举手（抚胸）」这类带空格/括号的写法，去掉修饰再试一次
  const bare = n.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '');
  if (MOTION_ALIAS[bare]) return MOTION_ALIAS[bare];
  return bare;
}

function applyMotion(name, holdMs) {
  if (!model) return false;
  // TapBody 是模型自带的手势切换（举手/抚胸、狗尾草、竖食指、脱捕），优先它
  const groups = ['TapBody', 'Idle'];
  const holdFrom = (idx, label) => {
    // 「举着手等你回话」：动作曲线播完后，按动作文件的终值把手按住到 holdMs 到期。
    // 不按住的话，待机动作下一轮就把手放回去了——她说的「两秒就掉」就是这个。
    const h = Number(holdMs);
    if (!(h > 1500)) { holdDbg = `skip:h=${holdMs}`; return; }
    const f = motionFile(motionDefs('TapBody')[idx] || {});
    holdDbg = `enter:${label}:${f}`;
    motionEndValues(f).then((map) => {
      const total = Object.keys(map).length;
      holdDbg = `map:${label}:${total}`;
      if (!total) return;
      const dur = 1300;                        // 切换动作都在 1.0–1.3 秒内播完
      setTimeout(() => {
        const ttl = Math.max(1000, h - dur);
        const n = setParamMap(map, ttl, 3, 'hands', { layer: 'gesture' });
        holdDbg = `set:${label}:n=${n}:ttl=${Math.round(ttl / 1000)}s`;
        if (n) { lastHandUntil = Date.now() + ttl; hud(`手保持住 ${(ttl / 1000).toFixed(1)} 秒`); }
      }, dur);
    }).catch((e) => { holdDbg = `err:${label}:${(e && e.message) || e}`; });
  };
  for (const g of groups) {
    const defs = motionDefs(g);
    if (!defs.length) continue;
    try {
      if (name) {
        const want = resolveMotionName(name);
        // 先找完全一致的，再退回到包含匹配（避免「举手」命中「举手切默认手」）
        let idx = defs.findIndex((d) => {
          const f = motionFile(d).replace(/^.*\//, '').replace(/\.motion3\.json$/, '');
          return f === want;
        });
        if (idx < 0) idx = defs.findIndex((d) => motionFile(d).includes(want));
        if (idx >= 0) {
          model.motion(g, idx);
          holdFrom(idx, motionFile(defs[idx]).replace(/^.*\//, '').replace(/\.motion3\.json$/, ''));
          return true;
        }
      } else if (g === 'TapBody') {
        const idx = Math.floor(Math.random() * defs.length);
        model.motion(g, idx);
        holdFrom(idx, motionFile(defs[idx]).replace(/^.*\//, '').replace(/\.motion3\.json$/, ''));
        return true;
      }
    } catch (e) { /* ignore */ }
  }
  if (!name) { try { model.motion('Idle'); return true; } catch (e) { /* ignore */ } }
  return false;
}

function say(text, holdMs, opts) {
  const t = String(text || '').trim();
  if (!t) return;
  // 页面外壳的「对话记录」靠这个事件追加她刚说的话
  const proactive = !!(opts && opts.proactive);
  try { window.dispatchEvent(new CustomEvent('fish-say', { detail: { text: t, proactive } })); } catch { /* ignore */ }
  BUBBLE.textContent = t;
  BUBBLE.classList.toggle('proactive', proactive);
  BUBBLE.classList.add('show');
  lastSayAt = Date.now();
  const dur = holdMs || Math.max(6000, Math.min(18000, t.length * 300));
  talkingUntil = Date.now() + dur;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => BUBBLE.classList.remove('show'), dur);
  hud(`说话中 · ${t.length} 字`);
}

function clampNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 模型自己说了算：参数表在 boot 时从 coreModel 读出来（509 个，带 min/max/default）。
// 以前是我手写白名单，猜漏一个就「写了没反应」，现在只认模型真有的参数。
const PARAM_INFO = new Map();
let appliedSeq = 0;              // 每次真的写入参数就 +1，回执里带给云端对账

function indexParams(core) {
  if (!core || !core.getParameterCount) return 0;
  const n = core.getParameterCount();
  // Cubism 4 的 coreModel 没有 getParameterId(i)，id 表在 _parameterIds 上（实测）。
  const ids = core._parameterIds;
  for (let i = 0; i < n; i += 1) {
    const id = (ids && ids[i]) || (typeof core.getParameterId === 'function' ? core.getParameterId(i) : null);
    if (!id) continue;
    PARAM_INFO.set(id, {
      min: Number(core.getParameterMinimumValue(i)) || -1,
      max: Number(core.getParameterMaximumValue(i)) || 1,
      def: Number(core.getParameterDefaultValue ? core.getParameterDefaultValue(i) : 0) || 0
    });
  }
  return PARAM_INFO.size;
}

// 写一组参数：进的是「层」，不是全局表。
// layer：physio/emotion/pose/gesture/lipsync/manual/misc —— 同 id 的多层会按权重混合。
// prio：4=手动指定参数，3=姿态/手势保持，2=表情与自动动作（只在同一层内决定谁覆盖谁）。
// ch：通道名（head/tail/face/hands），排队时用来判断「这条路忙不忙」。
function setParamMap(map, holdMs, prio = 2, ch = 'misc', opts = {}) {
  const now = Date.now();
  // holdMs 传 0 / 负数 / 不传 = 常驻（她说过「说了就掐，没说就一直」）。
  // 常驻用 Infinity 表示，ticker 里 remain = Infinity 永远显正，不会被当成过期删掉。
  const raw = Number(holdMs);
  const ttl = Number.isFinite(raw) && raw > 0 ? Math.max(200, Math.min(60000, raw)) : Infinity;
  const layerName = (opts.layer || ch || 'misc');
  const weight = Number.isFinite(Number(opts.weight)) ? Math.max(0, Math.min(1, Number(opts.weight))) : 1;
  const store = layerOf(layerName);
  let n = 0;
  for (const [id, raw2] of Object.entries(map || {})) {
    const info = PARAM_INFO.get(id);
    if (!info) continue;                       // 模型真没有这个参数才丢
    const prev = store.get(id);
    // 同一层内：更高优先级的还活着 → 这次不抢（表情不会把「歪头」顶掉，就是靠这条）
    if (prev && prev.until > now && (prev.prio || 0) > prio) continue;
    const v = Math.max(info.min, Math.min(info.max, clampNum(raw2, 0)));   // 夹到模型范围
    store.set(id, { value: v, start: now, until: ttl === Infinity ? Infinity : now + ttl, prio, ch, weight });
    n += 1;
  }
  if (n) { appliedSeq += 1; syncOverrides(); }
  return n;
}

// 排障用：在控制台（或 ego_js）里看每一层还剩多少参数，
// 例如 __bodyLayers() → "pose:12,expression:8"。定位「命令发出去但画面不动」时先看这个。
window.__lifeOut = () => [...lifeIds].map((id) => id + '=' + ((lifeSpring.get(id) || {}).x || 0).toFixed(2)).join(' ');
  window.__bodyLayers = () => [...layerParams].map(([k, m]) => `${k}:${m.size}`).join(',');

// 把各层的当前目标汇总成一张「id → 什么时候到期」的表，供心跳/忙闲/复位使用。
function syncOverrides() {
  poseOverrides.clear();
  for (const m of layerParams.values()) {
    for (const [id, o] of m) {
      const prev = poseOverrides.get(id);
      if (!prev || (o.until || 0) > (prev.until || 0)) {
        poseOverrides.set(id, { until: o.until, prio: o.prio || 0, ch: o.ch, layer: o.value !== undefined ? o.ch : o.ch });
      }
    }
  }
}

// 一条通道现在有没有在占着（波形还在跑，或者还有没到期的**临时**覆盖）。
// 常驻（until = Infinity）不算忙 —— 常驻就是「她让它待在那儿」，新命令本来就该顶掉它，
// 否则复位写的中性脸会把这个通道永久占死，后面的表情全被排进队列等到天荒地老。
function channelBusy(ch) {
  if (channelWaves.has(ch)) return true;
  const now = Date.now();
  for (const o of poseOverrides.values()) {
    if (o.ch === ch && o.until !== Infinity && o.until > now) return true;
  }
  return false;
}

// 动作排队：她连着发几个动作时，不要「后到先砍」。
// 忙的通道先排队（最多 6 条、最多等 15 秒），空出来就按顺序演；闲着的通道立刻执行。
const actionQueue = [];
const QUEUE_MAX = 6;
const QUEUE_TTL = 15000;

let lastDispatch = '';               // 排障用：最近一次动作是立刻演的，还是排上了

function dispatch(ch, label, run) {
  // 表情是「独占替换」：applyExpression 上来先清空整层，所以永远不用排队——
  // 排队反而会让新表情卡在队里（表情层有 25 秒时限，face 通道就一直显示忙）。
  if (ch === 'face' || !channelBusy(ch)) { lastDispatch = `${ch}:now:${label}`; run(); return 'now'; }
  if (actionQueue.length >= QUEUE_MAX) actionQueue.shift();
  actionQueue.push({ ch, label, run, at: Date.now() });
  hud(`${label} 排上了（${ch} 这条路在忙）`);
  lastDispatch = `${ch}:queue:${label}`;
  return 'queued';
}

function pumpQueue() {
  const now = Date.now();
  for (let i = 0; i < actionQueue.length; i++) {
    const q = actionQueue[i];
    if (now - q.at > QUEUE_TTL) { actionQueue.splice(i--, 1); continue; }
    if (channelBusy(q.ch)) continue;
    actionQueue.splice(i--, 1);
    try { q.run(); } catch (e) { /* ignore */ }
    break;                                   // 一次只放一条，免得同一帧挤在一起
  }
}

function clearPose() {
  layerParams.clear();
  poseOverrides.clear();
  channelWaves.clear();
  actionQueue.length = 0;
  bodySinkTarget = 0;
  pinnedHead = false;
  restorePhysics();
}

// 脸只有一个槽位。
// 以前「眯眼」和「瞪眼」、「嘟嘴」和「生气」能同时挂在不同层里，
// 混合后互相抢 ParamEyeLOpen / ParamMouthForm，看起来就是脸部抽搐、一半笑一半哭。
// 现在任何新的脸部动作（表情 / 眯眼 / 嘟嘴 / 吐舌头 / 词表里的眉嘴眼）都会先把旧的脸摘掉；
// 身体类（歪头、摇尾巴、举手）是另一个槽位，互不影响——「歪头 + 生气」仍然能同时成立。
function clearFaceSlot() {
  let n = 0;
  for (const m of layerParams.values()) {
    for (const [id, o] of m) {
      if (o && o.ch === 'face') { m.delete(id); n += 1; }
    }
  }
  if (n) {
    poseOverrides.clear();
    for (const m of layerParams.values()) {
      for (const [id, o] of m) {
        const prev = poseOverrides.get(id);
        if (!prev || o.prio >= prev.prio) poseOverrides.set(id, { until: o.until, prio: o.prio || 0, ch: o.ch, layer: o.value !== undefined });
      }
    }
  }
  return n;
}

const POSE_ALIAS = {
  '左': '看左', '左边': '看左', '看左边': '看左',
  '右': '看右', '右边': '看右', '看右边': '看右',
  '上': '看上', '抬头': '看上', '看上面': '看上',
  '下': '看下', '低头': '看下', '看下面': '看下',
  '侧头': '歪头', '头歪': '歪头',
  '尾巴': '摇尾巴', '甩尾巴': '摇尾巴', '摇尾': '摇尾巴',
  '晃身子': '晃腰', '扭一扭': '晃腰', '摇一摇': '晃腰', '左右晃': '晃腰', '晃一晃': '晃腰', '扭扭腰': '晃腰',
  '舌头': '吐舌头', '吐舌': '吐舌头',
  '鼓腮': '鼓脸', '鼓腮帮子': '鼓脸', '生气': '鼓脸',
  '正常': '复位', '放下': '复位', '回来': '复位', '看镜头': '看向你',
  '看向我': '看向你', '看我': '看向你', '看着我': '看向你', '看这里': '看向你', '看过来': '看向你',
  '盯着我': '看向你', '盯着我看': '看向你', '盯着你': '看向你', '盯着': '看向你', '一直看着你': '看向你',
  '看着你的眼睛': '看向你', '看我的眼睛': '看向你',
  '看我一眼': '看向你', '对着我': '看向你'
};

function applyPose(name, holdMs) {
  const raw = String(name || '').trim();
  if (!raw) { hud('没给姿态名'); return false; }
  const key = POSES[raw] ? raw : (POSE_ALIAS[raw] || raw);
  const pose = POSES[key];
  const hold = clampNum(holdMs, 0);
  if (!pose) { hud(`不认识这个姿态：${raw}`); return false; }
  if (pose.clear) {
    clearPose();
    // 复位之后脸要回到「中性」，不是模型的默认脸（模型默认那张眉毛一高一低，看着像在疑惑）。
    setParamMap(EMOTIONS['平静'], 0, 2, 'face', { layer: 'emotion' });
    lastExpr = '平静';
    lastExprUntil = 0;
    lastPose = { name: '', until: 0 };   // 回执也要跟着清，不然她查状态会看到「还摆着歪头」
    // 手也要放回默认：Idle 关掉以后没有东西再把手插值回去，手势的终态会一直留在画面上
    const zeroHands = {};
    for (const id of HAND_PARAMS) zeroHands[id] = 0;
    setParamMap(zeroHands, 0, 3, 'hands', { layer: 'gesture' });
    lastHandUntil = 0;
    // exp3 类（脸红/钢盆/圈圈眼）是持久表达式，光清参数摘不掉，得主动 reset
    if (phraseExprTimer) { clearTimeout(phraseExprTimer); phraseExprTimer = 0; }
    clearModelExpression();
    hud('姿态复位');
    return true;
  }
  if (pose.wave) {
    const now = performance.now();
    const ch = pose.ch || 'head';
    const ms = hold > 0 ? hold : clampNum(pose.wave.ms, 1500);
    channelWaves.set(ch, {
      ch,
      ids: pose.wave.ids.slice(),
      amp: (pose.wave.amp && typeof pose.wave.amp === 'object') ? { ...pose.wave.amp } : clampNum(pose.wave.amp, 8),
      phase: pose.wave.phase ? { ...pose.wave.phase } : null,
      hz: clampNum(pose.wave.hz, 1.5),
      // 尾巴这类参数被物理演算每帧盖回去，甩的时候先短暂摘掉 physics
      noPhysics: !!pose.wave.noPhysics,
      t0: now,
      until: now + Math.max(300, Math.min(30000, ms))
    });
    lastPose = { name: key, until: Date.now() + Math.max(300, Math.min(30000, ms)) };
    hud(`姿态：${key}（${ch} 通道）`);
    return true;
  }
  // 默认常驻：她摆一个姿态就一直摆着，直到换下一个或喊复位（原话「说了就掐，没说就一直」）
  const ms = hold > 0 ? hold : 0;
  // 脸部姿态（眯眼/瞪眼/嘟嘴/鼓脸/开心/吐舌头…）独占脸的槽位，避免和上一个打架
  if (pose.ch === 'face') clearFaceSlot();
  // 「看向你」这类：钉住整颗头，鼠标跟随和自发环视都不许再动它
  pinnedHead = !!pose.pin;
  const n = setParamMap(pose.set || {}, ms, 3, pose.ch || 'head', { layer: 'pose' });
  if (n) lastPose = { name: key, until: ms > 0 ? Date.now() + Math.min(60000, ms) : 0 };
  // 低头/抬头要靠整体位移补（脸上看不出来），其它姿态不沉
  bodySinkTarget = clampNum(pose.sink, 0);
  hud(n ? `姿态：${key}${ms > 0 ? `（${(ms / 1000).toFixed(1)} 秒）` : '（常驻）'}` : `姿态 ${key} 没有可用参数`);
  return n > 0;
}

function applySwitch(name, on) {
  const key = String(name || '').trim();
  const sw = SWITCHES[key];
  if (!sw) return false;
  const onValue = sw.on === 0 ? 0 : 1;
  const value = on ? onValue : (sw.on === 0 ? 1 : 0);
  const n = setParamMap({ [sw.id]: value }, 0, 3, 'misc', { layer: 'misc' });
  if (on) switchState.add(key); else switchState.delete(key);
  // 有些道具其实是 exp3（圈圈眼/爱心眼/黑脸…）：光把参数写回 0 摘不掉，
  // 得把模型那条持久表达式 reset 掉，不然她嘴上说摘了、眼睛还是圈圈。
  if (!on) {
    const sameItem = modelExprActive
      && (modelExprActive === key || SWITCHES[modelExprActive]?.id === sw.id);
    if (sameItem) clearModelExpression();
  }
  return n > 0 || true;
}

// 模型自带的 23 个 exp3：走渲染器自己的表达式通道（带淡入淡出），和我们拼参数的表情互不干扰
// 注意：exp3 是「一直生效」的——不主动 resetExpression() 就永远摘不掉（圈圈眼摘不掉就是这个）
let modelExprActive = '';

function clearModelExpression() {
  const em = model?.internalModel?.motionManager?.expressionManager;
  try { em?.resetExpression?.(); } catch { /* 忽略 */ }
  if (modelExprActive) hud(`收起模型动画：${modelExprActive}`);
  modelExprActive = '';
  if (String(lastExpr || '').startsWith('模型:')) lastExpr = '';
}

const MODEL_EXPR_OFF = ['关掉', '关', '取消', '无', '默认', '复位', '摘掉', '收起', '去掉', '清掉'];

function applyModelExpression(name) {
  if (!model) return false;
  const key = String(name || '').trim();
  if (!key) return false;
  if (MODEL_EXPR_OFF.includes(key)) { clearModelExpression(); return true; }
  const known = MODEL_EXPRESSIONS.includes(key);
  try {
    const r = model.expression(key);
    if (r === false) return false;
    if (!known) return false;
    lastExpr = `模型:${key}`;
    modelExprActive = key;
    eyeLockUntil = performance.now() + 2000;
    return true;
  } catch { return false; }
}

function handle(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;  lastCommandAt = Date.now();
  if (cmd.type === 'say') {
    say(cmd.text, cmd.holdMs, { proactive: cmd.proactive === true });
    if (cmd.expression) applyExpression(cmd.expression);
    if (cmd.motion) applyMotion(cmd.motion, cmd.holdMs);
    return;
  }
  if (cmd.type === 'expression') {
    dispatch('face', cmd.name || '表情', () => applyExpression(cmd.name, cmd.holdMs));
    return;
  }
  if (cmd.type === 'motion') {
    dispatch('hands', cmd.name || '手势', () => applyMotion(cmd.name, cmd.holdMs));
    return;
  }
  if (cmd.type === 'pose') {
    const ch = (POSES[cmd.name] && POSES[cmd.name].ch) || 'head';
    dispatch(ch, cmd.name || '姿态', () => applyPose(cmd.name, cmd.holdMs));
    return;
  }
  if (cmd.type === 'emotion') {
    // 连续情绪：她给三个浮点（效价/唤醒/支配），不是「换一整套表情」
    const e = cmd.emotion || cmd;
    const ok = applyEmotion({ v: e.v, a: e.a, d: e.d }, cmd.holdMs);
    hud(ok ? `情绪：${emotionName(lastEmotion)}（${lastEmotion.v.toFixed(2)}/${lastEmotion.a.toFixed(2)}/${lastEmotion.d.toFixed(2)}）` : '情绪没动');
    return;
  }
  if (cmd.type === 'word' || cmd.type === 'phrase') {
    // 词表 v2：一句话里可以有多个词（「微微歪头，眯眼，尾巴慢慢甩」），
    // 先按通道拆开、相加，再落成参数；拆不出来才退回老词表。
    const text = cmd.text || cmd.word || cmd.name || '';
    const r = applyPhrase(text, cmd.holdMs);
    if (r && r.ok) {
      hud(`动：${r.words.join('+')}${r.hold ? `（${Math.round(r.hold / 1000)}s）` : ''}`);
      return;
    }
    const ok = applyWord(text, cmd.holdMs);
    hud(ok ? `照做：${text}` : `词表里没有「${text}」`);
    return;
  }
  if (cmd.type === 'switch') {
    // 道具/换装开关：黑脸、落泪、圈圈眼、爱心眼、眼镜、脱鞋、长短裙、狗尾草…
    const ok = applySwitch(cmd.name, cmd.on !== false);
    hud(ok ? `${cmd.on === false ? '收起' : '换上'}：${cmd.name}` : `没有这个道具：${cmd.name}`);
    return;
  }
  if (cmd.type === 'modelexpr') {
    // 直接走模型自带的 exp3（23 个「按键动画」），不经过我们的参数通道
    const name = String(cmd.name || '');
    const ok = applyModelExpression(name);
    hud(ok ? `模型动画：${name}` : `模型里没有「${name}」`);
    return;
  }
  if (cmd.type === 'probe') {
    // 排障：让她/我们指定要盯的参数，两次心跳之间记最大最小值
    probeIds = Array.isArray(cmd.ids) ? cmd.ids.slice(0, 8).map(String) : [];
    probeRange = new Map();
    hud(probeIds.length ? `盯住 ${probeIds.length} 个参数` : '不盯了');
    return;
  }
  if (cmd.type === 'dump') {
    // 排障：把「和默认值不一样」的参数全抓一遍，用来查是谁把脸弄花了
    dumpParams = true;
    hud('抓一遍当前参数');
    return;
  }
  if (cmd.type === 'param') {
    const map = (cmd.params && typeof cmd.params === 'object')
      ? cmd.params
      : (cmd.id ? { [cmd.id]: cmd.value } : null);
    if (!map) { hud('param 要带 id/value 或 params'); return; }
    const n = setParamMap(map, cmd.holdMs, 4, 'manual', { layer: 'manual' });
    hud(n ? `姿态：${n} 个参数` : '这些参数不在白名单里');
    return;
  }
  if (cmd.type === 'reset') {
    BUBBLE.classList.remove('show');
    talkingUntil = 0;
    clearPose();
    // 情绪也是「她给的状态」，复位要一起清掉，否则回执还挂着上一轮的三个数
    lastEmotion = { v: 0, a: 0, d: 0 };
    lastEmotionAt = 0;
    lastWord = '';
    lastPose = { name: '', until: 0 };
    lastHandUntil = 0;
    // 表情整层清掉，并把回执一并归零：复位就是「没有表情」，不该还挂着 25 秒倒计时
    layerOf('expression').clear();
    lastExpr = '';
    lastExprUntil = 0;
    exprBaseMood = null;
    // 复位不套「表情」：默认体型交给模型自己的 exp3，免得再占一层带 25 秒时限的脸
    try { model.expression('默认体型'); } catch (e) { /* ignore */ }
    applyMotion('IDLE');
    // 道具也收起来：复位 = 回到什么都没有的样子
    for (const key of [...switchState]) applySwitch(key, false);
    clearModelExpression();
    hud('回到待机');
    return;
  }
  if (cmd.type === 'scene') {
    // 服务端存着的「上次的样子」：页面刷新/手机重连/服务重启之后，先把它放回去。
    // 顺序有讲究：先大小和道具（底色），再表情，最后姿态（姿态会带 sink，放最后不会被打断）。
    const sc = cmd.scene || {};
    try {
      if (sc.scale) setScale(sc.scale);
      for (const [n, on] of Object.entries(sc.switches || {})) applySwitch(n, on !== false);
      if (sc.emotion && (sc.emotion.v || sc.emotion.a || sc.emotion.d)) {
        const ev = { v: sc.emotion.v, a: sc.emotion.a, d: sc.emotion.d };
        applyEmotion(ev, sc.emotion.holdMs || 0, emotionName(ev));
      }
      // 现场恢复也走默认时限（25 秒）：刷新只是把「她刚才摆过什么」放回来，
      // 不该因为一次刷新就把脸永久钉住
      if (sc.expression && sc.expression.name) applyExpression(sc.expression.name);
      if (sc.modelExpr) applyModelExpression(sc.modelExpr);
      else clearModelExpression();
      if (sc.pose && sc.pose.name && sc.pose.name !== '复位') applyPose(sc.pose.name, sc.pose.holdMs || 0);
      // 词表动作（「眯眼 微笑 摇尾巴」）以前只活在前端内存里，刷新就没了；
      // 但姿态/表情都会恢复，只有它消失，看起来就像她「忘了自己摆过什么」。
      if (sc.word) { try { applyPhrase(String(sc.word), 0); } catch { /* ignore */ } }
      hud('回到上次的样子');
    } catch (e) { hud('恢复现场出错：' + (e && e.message)); }
    return;
  }
  if (cmd.type === 'phys') {
    // 「手感」面板：裙摆/头发/胸部… 的阻尼，以及静止/动作幅度
    const r = window.__phys(cmd.cfg || {});
    hud('手感已更新');
    return r;
  }
  if (cmd.type === 'ping') { hud(`心跳 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`); return; }
  if (cmd.type === 'scale') { setScale(cmd.value); return; }
  // 冻结环境动画（呼吸/摇摆/自发扫视/待机动作/物理），只给截图对拍用：
  // POST /cmd {"type":"freeze","value":1}
  // 注意光归零我们自己的参数不够——模型的 Idle 动作和物理演算每帧都在动，所以这两样也要停。
  if (cmd.type === 'freeze') {
    frozen = !!cmd.value;
    try {
      if (frozen) {
        model?.internalModel?.motionManager?.stopAllMotions?.();
        suspendPhysics();
      } else {
        restorePhysics();
      }
    } catch (e) { /* ignore */ }
    hud(frozen ? '冻住了（对拍用）' : '解冻');
    return;
  }
  // 自主性开关：1 = 她自己会甩尾巴/瞟来瞟去；0（默认）= 只按她的命令动
  if (cmd.type === 'autonomy') {
    autonomy = !!cmd.value;
    if (!autonomy) { gazeTarget.x = 0; gazeTarget.y = 0; }
    hud(autonomy ? '放开手脚（会自己动）' : '只听从命令');
    return;
  }
  // 改了前端想让它立刻生效：POST /cmd {"type":"reload"}
  // reload 用带时间戳的跳转，而不是 location.reload()：后者在 Electron 里会被磁盘缓存喂旧脚本
  if (cmd.type === 'reload') {
    // 只对真正的 http(s) 页面下手：自动化浏览器里如果当前标签是 about:blank，
    // 拼上 ?r= 再 replace 会把它跳到 about:blank?r=…，整个页面就没了（实测过一次白屏）。
    const href = String(location.href || '');
    if (!/^https?:/i.test(href)) return;
    try {
      const u = new URL(href);
      u.searchParams.set('r', String(Date.now()));
      location.replace(u.toString());
    } catch { location.reload(); }
    return;
  }

  // 自拍：把当前这一帧（连背景透明）抽成 PNG 回给服务端。
  // 她要「看看自己现在什么样」就走这条——不是截整个屏幕，就是她自己。
  if (cmd.type === 'selfie') {
    try {
      // 用 canvas().toDataURL 而不是 extract.base64：后者在不同 PIXI 版本里返回
      // 带不同前缀的串（有时是 data:image/png;charset=utf-8;base64,…），
      // 服务端按 base64 解会得到乱码。这里统一给标准 dataURL。
      const cv = app.renderer.extract.canvas(app.stage);
      const data = cv.toDataURL('image/png');
      if (wsRef && wsRef.readyState === 1) {
        wsRef.send(JSON.stringify({ type: 'selfie', id: cmd.id || '', data }));
      }
    } catch (e) {
      if (wsRef && wsRef.readyState === 1) {
        wsRef.send(JSON.stringify({ type: 'selfie', id: cmd.id || '', error: String((e && e.message) || e) }));
      }
    }
    return;
  }
}

// 页面是从公网进来的，WebSocket 也得带钥匙，否则服务端会直接关掉（4001）
const WS_KEY = new URLSearchParams(location.search).get('k') || '';

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const q = WS_KEY ? `?k=${encodeURIComponent(WS_KEY)}` : '';
  hud('连接中…');
  const ws = new WebSocket(`${proto}${location.host}/ws${q}`);
  wsRef = ws;
  ws.addEventListener('open', () => {
    hud('已连上身体服务 · 等她动');
    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    }, 20000);
    ws.addEventListener('close', () => clearInterval(ping));
  });
  ws.addEventListener('message', (ev) => {
    let cmd = null;
    try { cmd = JSON.parse(ev.data); } catch { return; }
    if (cmd?.type === 'hello') {
      hud('已连上身体服务 · 等她动');
      if (cmd.lastState?.text && Date.now() - (cmd.lastState.at || 0) < 60000) say(cmd.lastState.text);
      return;
    }
    handle(cmd);
  });
  ws.addEventListener('close', (ev) => {
    if (ev && ev.code === 4001) {
      hud('钥匙不对：请用带 ?k=… 的完整链接打开');
      return;
    }
    hud('身体服务断了，10 秒后重连…');
    setTimeout(connect, 10000);
  });
  ws.addEventListener('error', () => { /* close 会跟着来 */ });
}

// 键盘：1-9 试表情，0 复位，空格换动作，+/- 改大小（下次开窗记得住）
window.addEventListener('keydown', (e) => {
  if (/^[1-9]$/.test(e.key)) applyExpression(EXPRESSIONS[Number(e.key) - 1] || '默认体型');
  if (e.key === '0') handle({ type: 'reset' });
  if (e.key === ' ') applyMotion('');
  if (e.key === '+' || e.key === '=') setScale(userScale + 0.1);
  if (e.key === '-' || e.key === '_') setScale(userScale - 0.1);
});

// 桌面版：按住左键就能把整只鱼拖到屏幕任意位置（右键还是菜单）。
// 只在她身上有效，浏览器版没有 window.fishDesktop 就自动跳过。
if (window.fishDesktop) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let movedPx = 0;
  let dragDX = 0;
  let dragDY = 0;
  let dragRaf = 0;
  const setCursor = (c) => { document.body.style.cursor = c; };
  setCursor('grab');

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragDowns += 1;
    movedPx = 0;
    lastX = e.screenX;
    lastY = e.screenY;
    setCursor('grabbing');
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 鼠标已经松开了（比如光标被别的程序瞬移），pointerup 没收到——这里补一刀，别让窗口自己乱跑
    if (e.buttons === 0) { endDrag(); return; }
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (!dx && !dy) return;
    lastX = e.screenX;
    lastY = e.screenY;
    // 单帧位移超过 150px 基本是事件异常（指针捕获被抢、光标瞬移），直接丢弃
    if (Math.abs(dx) > 150 || Math.abs(dy) > 150) return;
    movedPx += Math.abs(dx) + Math.abs(dy);
    // 攒到下一帧再发：游戏鼠标一秒能发 200+ 个 move，逐个发给主进程挪窗口，
    // 窗口重绘跟不上就会闪。一帧合并成一次，鼠标走得再快也只挪 60 次。
    dragDX += dx;
    dragDY += dy;
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      const sx = Math.round(dragDX);
      const sy = Math.round(dragDY);
      dragDX -= sx;
      dragDY -= sy;
      if (sx || sy) window.fishDesktop.dragBy(sx, sy);
    });
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    setCursor('grab');
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    const restX = Math.round(dragDX);
    const restY = Math.round(dragDY);
    dragDX -= restX;
    dragDY -= restY;
    if (restX || restY) window.fishDesktop.dragBy(restX, restY);
    if (movedPx > 3) {
      hud('放这儿了');
      // 程序挪窗口不会触发主进程的 'moved'，位置只能在这里存
      try { window.fishDesktop.dragEnd?.(); } catch { /* ignore */ }
    }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  // 第一次开窗口时提示一下，免得用户不知道能拖
  setTimeout(() => hud('按住我可以拖到任何地方'), 600);
}

boot().catch((err) => {
  hud('模型加载失败：' + (err?.message || err));
  console.error(err);
});
