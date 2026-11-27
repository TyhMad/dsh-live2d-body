// 大肥鱼的身体：渲染 + 听命令
// 页面代码版本：必须在脚本最顶层抓 document.currentScript —— 进了回调它就是 null 了。
// 服务端按文件 mtime 生成 ?v=，所以这一串能直接和云端文件对上，判断「她的页面是不是旧代码」。
const PAGE_V = (() => { try { const s = (document.currentScript && document.currentScript.src) || ''; return new URL(s, location.href).searchParams.get('v') || ''; } catch (e) { return ''; } })();
const HUD = document.getElementById('hud2');
const BUBBLE = document.getElementById('bubble');
const MOUTH_ID = 'ParamMouthOpenY';

let app = null;
let model = null;
let physSwing = 1;   // 「手感」面板里的动作幅度倍率（晃腰/摇尾巴等波形共用）
let mouth = 0;          // 当前嘴张合 0..1
let talkingUntil = 0;   // 说话到什么时候（时间戳）
let heardUntil = 0;     // 他刚说话之后的一小段（epoch ms）：这段时间待机组不许开工
let lastTalkAt = Date.now();  // 最后一次「有人在说话」：她的气泡或他发来的消息（epoch ms）。
                              // 初始值 = 页面加载的那一刻：刚打开页面不该马上演待机。
let talkSeed = Math.random() * 10;
let bubbleTimer = null;
let lastCommandAt = 0;
let lastSayAt = 0;      // 上一次说话的时刻（诊断用）
let lastSayText = '';   // 上一次说的内容（同一句被送两遍时去重）
// 字幕排队：她经常 1 秒内连发两三句，直接换文本会让前一句根本没露面。
// 规则：正在显示的那句放完再接下一条；最多排 2 句，再多就丢掉最旧的（别越积越久）。
const SAY_Q = [];
let sayShowing = null;  // { t, dur, proactive, until }
const SAY_Q_MAX = 4;   // 她一轮常发三条（send_message 数组），排 2 句会把第三条直接丢掉
// 最近说过的句子 → 时刻。云端推送说完一轮后，镜像轮询还会把这些话按同样顺序再送一遍；
// 只比 lastSayText 不够（三条里第一条早就播完了），会看到同一句被重播。
const SAY_RECENT = new Map();
const SAY_DEDUPE_MS = 8000;
let wsRef = null;       // 当前 WS 连接（诊断用）
let retryMs = 800;      // 重连退避：从 0.8 秒起步（以前固定 10 秒，断一次就瞎十秒）
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
  // 11-25：MouthSmile_L/R 在这副皮上是「有参数、不画东西」（实测写 1 ∈ 与不写完全一样），
  // 真正让嘴角提起来的是 ParamMouthForm。开心/笑 以前一半的力气花在那两个死参数上。
  '开心': { EyeSmile: 1, ParamMouthForm: 1, ParamMouthOpenY: 0.2, ParamBrowLY: 0.5, ParamBrowRY: 0.5, CheeksWiggleY: 0.8, ParamAngleZ: 4, ParamAngleY: 2 },
  '笑': { EyeSmile: 1, ParamMouthForm: 1, ParamMouthOpenY: 0.16, ParamBrowLY: 0.4, ParamBrowRY: 0.4, ParamAngleZ: 3 },
  // 11-25：MouthSmile_L/R 的范围是 [0,1]，写 -1 会被 setParamMap 夹成 0 —— 也就是说
  // 「嘴角向下」从来没发生过，委屈/难过 全靠 ParamMouthForm 一个人撑。
  // 换成抿嘴（MouthPressLipOpen，范围 [-1,1]），实测截图里嘴角才真的压下去。
  // 11-25 晚：用户说「委屈和难过怎么是一样的，还是缺点那种感觉」——确实，这两条
  // 之前只差 ParamAngleY 1 度和 AngleZ 3 度，而 MouthSmile_L/R 是死参数（写 -1 不画东西），
  // 所以两张脸几乎是同一张。重新分工：
  //   委屈 = 撅着嘴、眼角往下压、内眉挑起来（憋着不哭，还带点不服气）
  //   难过 = 微垂耳 + 低眉 + 腮帮子鼓起来（后面 11-25 夜又按用户口味改成「鼓嘴」那一版）
  '委屈': { EyeSmile: -0.25, Mouthpucker: 0.5, MouthPressLipOpen: -0.35, ParamMouthForm: -0.7, ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8, ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamBrowLAngle: 1, ParamBrowRAngle: 1, BrowInnerUp: 1, ParamEyeBallY: -0.2, ParamAngleY: -4, ParamAngleZ: 3 },
  // 11-25 夜：用户说「生气和难过换一下，感觉这个表情更适合做生气；真正的难过可以稍微垂耳低眉、
  // 再鼓一点嘴」。于是把上一版那条「耳朵塌 + 眼半闭 + 低头」原样搬给生气（生闷气的那种脸），
  // 难过重做成：微垂耳、低眉、腮帮子鼓起来（CheeckPuff）—— 这才是「憋着难受」的样子。
  '难过': { ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamBrowLAngle: -0.5, ParamBrowRAngle: -0.5, BrowInnerUp: 0.5, CheeckPuff: 0.6, MouthPuckerWiden: -0.4, ParamMouthForm: -0.8, ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8, ParamAngleY: -6, ParamAngleZ: -1 },
  '疑惑': { ParamBrowLY: 1, ParamBrowRY: -1, ParamBrowLAngle: -1, ParamBrowRAngle: 0.5, ParamMouthForm: -0.4, ParamMouthOpenY: 0.4, ParamAngleZ: 7, ParamBodyAngleZ: 3 },
  '生气': { Angry: 1, Angry3: 1, ParamBrowLY: -0.7, ParamBrowRY: -0.7, ParamBrowLAngle: -0.8, ParamBrowRAngle: -0.8, ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamMouthForm: -1, MouthPressLipOpen: -0.4, ParamAngleY: -6, ParamAngleZ: -2, ParamBodyAngleX: 3 },
  '害羞': { CheeksWiggleX: 1, CheeksWiggleY: 1, ParamMouthForm: 0.7, EyeSmile: 0.7, ParamBrowLY: 0.5, ParamBrowRY: 0.5, ParamAngleY: -3, ParamAngleZ: 5 },
  '惊讶': { ParamBrowLY: 1, ParamBrowRY: 1, ParamMouthOpenY: 1, BrowInnerUp: 1, ParamEyeLOpen: 1.4, ParamEyeROpen: 1.4, ParamAngleY: 3 },
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
  // 头转角不是越大越像「转头」：ParamAngleX 只有 3.5%，真正让人读出「转过去」的是
  // 上半身跟着拧一点（ParamBodyAngleZ 15.2%）+ 眼球到位。所以这里的 X 给足，同时带一点身体。
  '看左': { ch: 'head', set: { ParamEyeBallX: -0.9, ParamAngleX: -24, ParamAngleZ: 7, ParamBodyAngleZ: -9 } },
  '看右': { ch: 'head', set: { ParamEyeBallX: 0.9, ParamAngleX: 24, ParamAngleZ: -7, ParamBodyAngleZ: 9 } },
  // 看下/看上：这套皮的头几乎不低头（ParamAngleY 推满只动 2.6% 像素），
  // 所以除了眼神和脖子，还得让整个人沉一点/提一点——`sink` 就是那个整体位移。
  // 改成活通道：AngleY 实测 0.00%（死的），抬头要靠脖子 ParamAngleY + 上身 ParamBodyAngleY（13.93%）+ 整体上浮
  // 这副皮「抬头」天生弱：ParamBodyAngleY 往下（负）能压 30px，往上（正）到 30 才抬 8px。
  // 所以「看上/抬头」只能顶满 + 靠 sink 把整个人提一点，才勉强读得出来。
  '看上': { ch: 'head', sink: -12, set: { ParamEyeBallY: 0.9, ParamAngleY: 18, ParamBodyAngleY: 30 } },
  '看下': { ch: 'head', sink: 12, set: { ParamEyeBallY: -0.9, ParamAngleY: -22, ParamBodyAngleY: -22 } },
  // 歪头幅度：原来 ParamAngleZ=15，实际脸只斜了 4 度左右（这套皮对 Z 的形变很小），
  // 现在写满 22 再叠一点侧倾和脖子平移，肉眼才看得出「歪了」。
  // AngleXbs 是死的；改用 ParamBodyAngleZ（18.51%，最活的通道之一）带整体侧倾。
  // 注意 ParamAngleZ 的上限就是 30，写 34 也会被夹回 30 —— 直接写满 30，别留虚假的余量。
  '歪头': { ch: 'head', set: { ParamAngleZ: 30, ParamAngleX: 8, ParamBodyAngleZ: 14 } },
  '点头': { ch: 'head', wave: { ids: ['ParamAngleY', 'ParamBodyAngleY'], amp: { ParamAngleY: 18, ParamBodyAngleY: 7 }, hz: 1.6, ms: 1400, sign: 1 } },
  '摇头': { ch: 'head', wave: { ids: ['ParamAngleX', 'ParamBodyAngleZ'], amp: { ParamAngleX: 18, ParamBodyAngleZ: 6 }, hz: 1.5, ms: 1700, sign: 1 } },
  // 一激灵：被吓到/被戳到那一瞬的抖——高频、短促、只走上身，跟「发抖」那种长时间的抖不一样
  '一激灵': { ch: 'body', wave: { ids: ['ParamBodyAngleZ', 'ParamAngleZ', 'ParamAngleX'], amp: { ParamBodyAngleZ: 9, ParamAngleZ: 4, ParamAngleX: 3.2 }, phase: { ParamBodyAngleZ: 0, ParamAngleZ: 1.2, ParamAngleX: 2.4 }, hz: 9, ms: 340 } },
  // 晃脑袋：慢慢左右摇（不同意/无奈/哼歌），比「摇头」慢、幅度也比它大，读起来是情绪不是否定
  '晃脑袋': { ch: 'head', wave: { ids: ['ParamAngleX', 'ParamAngleZ'], amp: { ParamAngleX: 16, ParamAngleZ: 5 }, phase: { ParamAngleX: 0, ParamAngleZ: -0.7 }, hz: 1.2, ms: 1900 } },
  // 以前这里 noPhysics:true（甩的时候摘掉 physics），结果是尾巴在动、头发裙摆停住，
  // 甩完 2.8 秒物理一接回来整只「啪」地回位——看着像全身都在动。其实我们的 ticker
  // 跑在 model.update 之后（LOW 优先级），尾巴参数每帧写得进去，根本不用摘物理。
  '摇尾巴': { ch: 'tail', wave: { ids: TAIL_IDS, amp: 11, hz: 1.2, ms: 2800, sign: 1 } },
  // 来回晃腰：胯先动、上身晚半拍（相位差），裙摆的物理是拿 HipAngleZ/HipAngleX/ParamBodyAngleZ 当输入的，
  // 所以裙子会被这一串带着甩起来——不是给它单独写一个「裙子在飘」的假动画。
  '晃腰': {
    ch: 'body',
    wave: {
      ids: ['ParamHipAngleZ', 'LEGAngleZ2', 'HipAngleX', 'ParamBodyAngleZ'],
      amp: { ParamHipAngleZ: 22, LEGAngleZ2: -14, HipAngleX: 5, ParamBodyAngleZ: 15 },
      phase: { ParamHipAngleZ: 0, LEGAngleZ2: Math.PI, HipAngleX: 0.35, ParamBodyAngleZ: -0.55 },
      hz: 0.8,
      ms: 4600
    }
  },
  // TongueOut 实测 0.00%（这套皮没绑舌头骨骼）→ 改成张嘴+咧嘴+一点鼓腮，远看才是「吐舌」的形状
  '吐舌头': { ch: 'face', set: { ParamMouthOpenY: 0.5, ParamMouthForm: 0.55, CheeckPuff: 0.35 } },
  '张嘴': { ch: 'face', set: { ParamMouthOpenY: 0.8 } },
  '闭嘴': { ch: 'face', set: { ParamMouthOpenY: 0 }, holdMs: 800 },
  '开心': { ch: 'face', set: { ParamMouthForm: 1, ParamEyeBallY: 0.1 }, holdMs: 1800 },
  // 下面这批是「按几何影响量」挑出来的：把参数推到极值，数有多少个 drawable 的顶点动了
  // （Clothes2 711 / ParamBodyAngleX 249 / ShoulderY 195 / HipAngleZ 127 / CheeckPuff 76 / EyeSmile 62 …）。
  // 所以她们动起来是真的有形状变化，不是白写。
  // 前倾/后仰：实测 ParamBodyAngleX 只转胯和裙摆（头 1.5%），「前倾」的大头其实是
  // ParamBodyAngleY（−16 头就下移 30px）+ 镜头推近（zoom，姿态层算进 model.scale）。
  // 只写 X 的话看着像「她在原地扭胯」，不会像「她凑过来」。
  '前倾': { ch: 'body', sink: 5, zoom: 0.14, lean: -22, set: { ParamBodyAngleY: -10, ParamBodyAngleX: 8, ParamHipAngleZ: 5, ParamAngleY: -4 } },
  '后仰': { ch: 'body', sink: -3, zoom: -0.07, lean: 18, set: { ParamBodyAngleY: 8, ParamBodyAngleX: -6, ParamHipAngleZ: -5, ParamAngleY: 5 } },
  '侧身': { ch: 'body', zoom: 0.05, lean: -6, set: { ParamBodyAngleZ: 24, ParamHipAngleZ: 18, ParamBodyAngleX: 5 } },
  // 扭腰：以前是「扳一下就不动」的静态姿势，看不出在扭 → 改成慢速摆动（晃腰的温柔版）
  '扭腰': {
    ch: 'body',
    wave: {
      ids: ['ParamHipAngleZ', 'LEGAngleZ2', 'HipAngleX', 'ParamBodyAngleZ'],
      amp: { ParamHipAngleZ: 16, LEGAngleZ2: -10, HipAngleX: 4, ParamBodyAngleZ: 10 },
      phase: { ParamHipAngleZ: 0, LEGAngleZ2: Math.PI, HipAngleX: 0.35, ParamBodyAngleZ: -0.55 },
      hz: 0.6,
      ms: 5200,
    },
  },
  // ShoulderY/ShoulderZ 实测 1.0% 左右（死的）→ 改成挺胸（ParamBodyAngleRX 17.88%）+ 上身微提
  '提肩': { ch: 'body', sink: -5, zoom: 0.03, set: { ParamBodyAngleRX: 22, ParamBodyAngleY: 12, ParamAngleY: 4 } },
  '沉肩': { ch: 'body', sink: 8, zoom: -0.03, set: { ParamBodyAngleRX: -22, ParamBodyAngleY: -14, ParamAngleY: -4 } },

  // ── 距离感：凑过来 / 往后退（靠 zoom 才读得出「远近」，光靠参数只是原地缩）──
  '凑近': { ch: 'body', sink: 4, zoom: 0.2, lean: -14, set: { ParamBodyAngleY: -8, ParamBodyAngleX: 6, ParamHipAngleZ: 4, ParamAngleZ: 5, ParamAngleY: -2 } },
  '凑过来': { ch: 'body', sink: 4, zoom: 0.2, lean: -14, set: { ParamBodyAngleY: -8, ParamBodyAngleX: 6, ParamHipAngleZ: 4, ParamAngleZ: 5, ParamAngleY: -2 } },
  '退开': { ch: 'body', sink: -2, zoom: -0.12, lean: 12, set: { ParamBodyAngleY: 6, ParamBodyAngleX: -5, ParamHipAngleZ: -4, ParamAngleY: 6 } },
  '往后退': { ch: 'body', sink: -2, zoom: -0.12, lean: 12, set: { ParamBodyAngleY: 6, ParamBodyAngleX: -5, ParamHipAngleZ: -4, ParamAngleY: 6 } },
  // ── 整个人矮下去的三档：缩起来（抱紧自己）→ 塌下去（撑不住）──
  '缩起来': { ch: 'body', sink: 10, zoom: -0.06, lean: -10, set: { ParamBodyAngleY: -18, ParamBodyAngleRX: -12, ParamAngleY: -8, ParamAngleZ: 6 } },
  '塌下去': { ch: 'body', sink: 14, zoom: 0.02, lean: -16, set: { ParamBodyAngleY: -22, ParamBodyAngleRX: -16, ParamAngleY: -10, ParamAngleZ: 8, ParamHipAngleZ: -6 } },
  '挺胸': { ch: 'body', sink: -6, zoom: 0.05, lean: 8, set: { ParamBodyAngleRX: 24, ParamBodyAngleY: 8, ParamAngleY: 10 } },
  '探头': { ch: 'body', zoom: 0.1, lean: -8, set: { ParamBodyAngleZ: 12, ParamBodyAngleY: -4, ParamAngleX: 16, ParamAngleZ: 8 } },
  // 背对你：整个人转过去（BodyAngleZ 反向 + 胯反向 + 头也扭走 + 眼神挪开）
  '背对你': { ch: 'body', zoom: -0.02, lean: -4, set: { ParamBodyAngleZ: -28, ParamHipAngleZ: 18, ParamAngleX: -24, ParamAngleZ: -6, ParamEyeBallX: -0.4 } },

  // ── 阶段 3：按 param-map 挑「真能看出形状变化」的参数凑出来的新姿态 ──
  // 回头看你：躯干先扭（ParamBodyAngleZ 34% 像素）、胯反向、头再转过来，眼珠跟到位
  '回头看你': { ch: 'body', zoom: -0.04, lean: -8, set: { ParamBodyAngleZ: 24, ParamHipAngleZ: -16, ParamBodyAngleX: 5, ParamAngleX: 24, ParamAngleZ: -10, ParamEyeBallX: 0.65 } },
  // 鞠躬：试过 ParamBodyAngleX 30 + AngleY -28 + sink 14，画面上只是整个人往下滑一点、
  // 头并不会低下去（这套皮的 ParamBodyAngleX 是把上半身平移，不是弯腰）。
  // 与其留一个「点了没反应」的假动作，不如不做——已删掉，别名一起撤。
  // 伸懒腰：肩往上提、上身后仰，呼吸幅度加大，慢（0.35Hz）才像伸展
  // 这副皮没有手臂动作，原来的「伸懒腰」是 RX/AngleY 的对称波 —— 波的均值是 0，
  // 单帧看和站着没区别。改成「挺起来 + 头往后仰 + 整个人提一点」的持续姿势，
  // 没有手也能读出是在伸。
  '伸懒腰': {
    ch: 'body',
    sink: -10,
    zoom: 0.03,
    lean: 6,
    holdMs: 2600,
    set: { ParamBodyAngleRX: 22, ParamBodyAngleY: 18, ParamAngleY: 16, ParamAngleZ: -5 },
  },
  // 发抖：高频小幅（6.5Hz）只抖肩和上身，裙子被物理带着一起颤
  '发抖': {
    ch: 'body',
    wave: {
      // 原来 4.5°，连拍 12 帧几乎看不出差别（2026-11-22 胶片验收）。
      // 幅度翻上去、频率略快、时长压短，才像「抖一下」而不是「慢慢晃」。
      ids: ['ParamBodyAngleZ', 'ParamAngleX', 'ParamAngleZ'],
      amp: { ParamBodyAngleZ: 7.5, ParamAngleX: 5, ParamAngleZ: 3 },
      phase: { ParamBodyAngleZ: 0, ParamAngleX: 1.1, ParamAngleZ: 2.2 },
      hz: 7.5,
      ms: 1800,
    },
  },
  // 甩头发：头快速甩动，头发/裙摆由物理跟着甩——这条就是「物理真的在算」的现场演示
  '甩头发': {
    ch: 'head',
    wave: {
      ids: ['ParamAngleX', 'ParamAngleZ'],
      amp: { ParamAngleX: 26, ParamAngleZ: 10 },
      phase: { ParamAngleX: 0, ParamAngleZ: -0.8 },
      hz: 1.1,
      ms: 1600,
    },
  },

  '缩脖': { ch: 'body', sink: 9, zoom: -0.04, set: { ParamBodyAngleY: -16, ParamAngleY: -14 } },
  '并腿': { ch: 'body', set: { Param33: 1 } },
  // 鼓腮必须左右一起推（CheeckPuffL/R），只推 CheeckPuff 在网页尺寸下看不出来
  '鼓脸': { ch: 'face', set: { CheeckPuff: 1, CheeckPuffL: 0.9, CheeckPuffR: 0.9, Mouthpucker: 0.6, MouthPuckerWiden: 0.6, ParamMouthOpenY: 0.3, ParamMouthForm: 0.5 } },
  // 眯眼只推眼睛开合在网页尺寸下只有 2.7% 像素变化 → 叠笑眼、压眉、嘴角上扬
  // 但别拉满：眼睛留一半开、笑眼半成、眉和嘴角只带一点，否则像挤眉弄眼
  '眯眼': { ch: 'face', set: { EyeSmile: 0.55, ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamBrowLY: 0.2, ParamBrowRY: 0.2, ParamMouthForm: 0.28 } },
  '瞪眼': { ch: 'face', set: { ParamEyeLOpen: 1, ParamEyeROpen: 1, BrowInnerUp: 0.8, ParamBrowLY: 0.6, ParamBrowRY: 0.6 } },
  '抬眉': { ch: 'face', set: { ParamBrowLY: 1, ParamBrowRY: 1, BrowInnerUp: 0.5 } },
  // 11-25（用户提醒）：她的眉毛跟耳朵是连在一起的 —— 眉毛参数 +1 是「眉抬起来 + 耳朵立起来」，
  // -1 是「眉垂下来 + 耳朵塌下去」。所以「竖耳朵 / 耷拉耳朵」根本不用新参数，就是眉毛那两根。
  '竖耳朵': { ch: 'face', set: { ParamBrowLY: 1, ParamBrowRY: 1 } },
  '耷拉耳朵': { ch: 'face', set: { ParamBrowLY: -1, ParamBrowRY: -1, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 } },
  '抖耳朵': { ch: 'face', wave: { ids: ['ParamBrowLY', 'ParamBrowRY'], amp: 0.55, hz: 2.4, ms: 900, sign: 1 } },
  // 11-25：原来只写 ParamBrowLAngle/RAngle + BrowInnerUp -0.6 —— 而 BrowInnerUp 范围是 [0,1]，
  // 写负数是空写，所以「皱眉」以前只是把眉毛角度拧了一点，眉本身根本没压下来。
  '皱眉': { ch: 'face', set: { ParamBrowLAngle: 1, ParamBrowRAngle: 1, ParamBrowLY: -0.7, ParamBrowRY: -0.7 } },
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
  // 脸红 = key7。查过模型自带的 Exp3/脸红.exp3.json，它写的就是 key7（Blend=Add, 值 1），
  // 模型里 key7 是真实存在的参数（509 个里有），所以直接按开关写 1 就行，不必绕表达式。
  '脸红': { id: 'key7' },
  '加载': { id: 'key8' }, '兔牙': { id: 'key9' }, '大牙': { id: 'key9' },
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
const LAYER_ORDER = ['physio', 'emotion', 'expression', 'pose', 'touch', 'gesture', 'lipsync', 'manual', 'misc'];
// touch：触摸反应单独一层（2026-11-08）。以前触摸直接走 applyPose，会把她正在演的姿态按同参数覆盖掉，
// 脸部反应还会 clearFaceSlot() 把她的表情清空；独立成层后到期就自动回落到她原来的姿态。
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
// 排障口子：直接把视线目标钉到某处（测跟随链用，鼠标事件在无头页里推不动）
window.__gazeTo = (x, y) => {
  gazeTarget.x = Math.max(-1, Math.min(1, Number(x) || 0));
  gazeTarget.y = Math.max(-1, Math.min(1, Number(y) || 0));
  return { ...gazeTarget };
};
// 被摸的时候整只往前凑一点（≈4.5%），松手再退回去。镜头推近要靠 fit() 算出来的基准缩放，
// 所以这里只存「额外的推近系数」，别直接改 userScale（那是用户自己调的大小）。
let baseScale = 1;
let leanZoom = 0;
// 姿态自带的推近/推远（前倾=凑近一点、退开=退后一点）。和 leanZoom 分开记：
// 一个是手按着时的镜头，一个是姿态的镜头，谁在算都不会把对方清掉。
let poseZoom = 0;
let poseZoomTarget = 0;
let poseZoomUntil = 0;
let poseSeq = 0;                 // 姿态序号：起手/过冲的延时写入要确认期间没换过姿态
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
// 每帧缓动系数按真实 dt 归一（60fps 下 perFrame(k)≈k）。
// 不归一的话，帧间隔在 8.2/16.7/29.2ms 之间来回跳时，同一段缓动会快慢差 3 倍，
// 头发/裙摆看起来就是「走两下停一下」甚至「两帧来回切」。
let frameDtMs = 16.7;
// 写入时的默认缓入时长。待机/生命层用 340ms（柔和），
// 但**她下的命令**必须快——用户反馈「没有老版本跟手」就是被这个 340 拖的。
// 命令路径（pose/word/expression/emotion）临时降到 CMD_RAMP_MS，写完立刻恢复。
const CMD_RAMP_MS = 120;
let PHYSH_HEAD = false;   // 实验开关：?physhead=1 时让物理接管头/身角度（QT 还没定义，见下方赋值）
let writeRampMs = 340;
const perFrame = (k) => {
  const r = Math.max(0.4, Math.min(3.5, frameDtMs / 16.7));
  return 1 - Math.pow(1 - k, r);
};
const focusAim = { x: 0, y: 0, z: 0, bx: 0 };  // 缓存跟随目标换算出来的角度
// 我们自己算的「跟随目标」（x/y ∈ [-1,1]）。只由鼠标移动写入；触屏一律写 EYE_BIAS（正视）。
// 为什么不直接用渲染器的 focusController：库自带的 InteractionManager 会往里塞指针坐标，
// `autoInteract:false` 也没拦住 —— 手指点她脸，fc.y 立刻 +0.31，放大后就变成「抬头看天」。
const manualFocus = { x: 0, y: 0 };
// 「按住才贴」：手指/鼠标按在她身上时，头往按的地方歪、上身跟着倾、整个人朝那边挪一点，
// 松手弹回。用户明确要「按住才贴」（鼠标路过不能让她歪头），所以只在 pointerdown→pointerup 之间生效。
// s = 当前强度（0..1，带弹簧）；x/y = 按点相对她头中心的归一化方向（-1..1）。
const leanPress = { down: false, x: 0, y: 0, s: 0, at: 0, cap: 0.5, raised: false, baseX: 0, baseY: 0, zone: '', fy0: null };
// 默认就给一个只读快照：没按过的时候也能查状态（以前只 leanStart 里才赋值，
// 于是无头测试在「还没按下去」时调 __leanInfo() 会报 not a function）。
window.__leanInfo = () => ({ down: false, x: 0, y: 0, s: 0, cap: 0, zone: '', gest: '', gestTracks: 0, st: 'idle', u: 0, v: 0, zoom: 0, scale: 0, baseScale: 0 });
// 摸身体其他部位（胸/腰/腿/尾巴）时的「推近一点点」：不贴手、只把镜头往她身上凑。
// 和 leanPress 分开，是因为贴手会让头往手上倒 —— 摸腰的时候头往腰上倒就是错的。
const bodyPress = { down: false, zoom: 0.18, at: 0 };

// ── 摸脸编排（M2）：状态机 + 四层叠加 ────────────────────────────────────────
// 以前是「每帧把按点映射成角度」，手一抖角度就抖，而且没有「贴上去→蹭→回位」的过程。
// 现在分四层，各写各的参数子集：
//   表演层：按住 0.15s 起前倾（BodyAngleY 到 9°），松手反序回落；
//   方向层：按点方向 (u,v) 经过死区 + 低通 + 限速，驱动头/身/位移；
//   韵律层：按住 >0.35s 开始蹭（头 ±2.6°@1.7Hz）与轻摇（身 ±1.6°@0.6Hz）；
//   表情层：GEST 轨道（眼/嘴/脸红，带延迟与反序）。
// ── 手感配置（M1/M4）：面板滑条直接改这里，存在 localStorage ────────────────
// zoom     近景倍率（0.8 全身 / 1.0 默认 / 1.6 胸像 / 2.2 怼脸）
// leanGain 摸脸整体幅度倍率
// follow   跟手灵敏度（越大越跟手、越小越稳）
// nuzzle   主动蹭的强度（她往你手上顶的那股劲）
// pitch    上下贴的幅度（手在她脸下方时低头把下巴递过去 / 上方时抬头贴上去）
// shadow   脚下一层软阴影的浓度（0 = 关）
const TUNE_DEF = { zoom: 1, leanGain: 1, follow: 1, nuzzle: 1, pitch: 1, shadow: 1 };
const TUNE = Object.assign({}, TUNE_DEF);
try { Object.assign(TUNE, JSON.parse(localStorage.getItem('body.tune') || '{}')); } catch (e) { /* ignore */ }
window.__tune = (patch) => {
  if (patch && typeof patch === 'object') {
    Object.assign(TUNE, patch);
    try { localStorage.setItem('body.tune', JSON.stringify(TUNE)); } catch (e) { /* ignore */ }
    if (Object.prototype.hasOwnProperty.call(patch, 'zoom')) { try { setScale(TUNE.zoom); } catch (e) { /* ignore */ } }
    if (Object.prototype.hasOwnProperty.call(patch, 'shadow')) { try { updateShadow(); } catch (e) { /* ignore */ } }
  }
  return Object.assign({}, TUNE);
};
window.__tuneInfo = () => Object.assign({}, TUNE, { userScale });
const LEAN = {
  state: 'idle',   // idle | nuzzle | recover
  tu: 0, tv: 0,    // 目标方向（带死区）
  u: 0, v: 0,      // 平滑后的方向
  prevU: 0, prevV: 0,
  s: 0,            // 整段强度包络（200ms 起 / 350ms 落）
  at: 0,           // 按下时刻（算按住时长与蹭相位）
  over: 0,         // 松手回位时的过冲（-1..0）
  retreatAt: 0,    // 松手时刻（收场动画用）
  conflicts: 0,
};
let baseY = null;                // 模型容器的基准 Y（呼吸上下浮动就在它附近晃）
let bodySink = 0;                // 当前整体沉降（像素，逻辑坐标）——低头/抬头用它补
let bodySinkTarget = 0;          // 目标沉降
// 按脸时「上下贴」带来的整体沉降：和 bodySink 分开存，免得和姿态系统的定时归还打架
let leanSink = 0;
let leanSinkTarget = 0;
let poseSinkUntil = 0;           // 姿态带来的沉降什么时候到期（0 = 不自动回）
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
// 最近一次「她被人摸到」：{ at, zone, name, x, y }。心跳和 /touch 都靠它，
// 云端那层会把「他 3 秒前摸了摸你的头」拼成一句话塞进提示词。
let lastTouch = null;
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
const lastMix = new Map();    // id → 上一帧实际写给模型的数（含 drift），排障用：__mixNow()
const lastAdd = new Map();    // id → 上一帧加法层加了多少（呼吸/跟随/微表情），排障用：__mixNow()
// 活体层（站立时的重量感/二级动作）用的弹簧状态：id → {x, v}
const lifeSpring = new Map();
const lifeIds = new Set();
// 表情与心情的共存规则（2026-11-03 定，用户选的方案 C）：
//   表情是「短时覆盖」，心情是「底色」。表情默认活 25 秒，之后用 RELEASE_MS 淡回心情脸；
//   期间如果心情剧变（v/a 跨过阈值），提前退场——「人难过着，脸还挂着笑」比掉表情更假。
//   她要常驻就显式说「一直保持」（holdMs = -1）。
const EXPR_IMPLICIT_MS = 25000;
// 姿态（pose）默认活多久。以前默认 0 = 常驻，结果她每发一个姿态就永远挂在那儿，
// 换过几次之后 pose 层里堆了几十个参数（心跳里 pose:"38p"），人就僵在一个怪姿势上，
// 待机呼吸/自发动作全被压住 ——「没有老版本丰富、卡住不回来」的真因。
// 现在：没显式给 holdMs → 12 秒自己回；真想常驻要显式 holdMs = -1。
const POSE_DEFAULT_MS = 12000;
// 词表说出来的动作（word/phrase）默认活多久：10 秒。
// 以前这里是 0（常驻），于是一句「眯眼+皱眉」会永远留在脸上，后面的动作全叠在它上面。
const PHRASE_DEFAULT_MS = 10000;
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
// ── 排障开关（URL 参数）──────────────────────────────────────────────
// 出问题时不用改代码，加参数二分定位到底哪一层在作妖：
//   ?nophys=1  关掉「物理推迟」（回到库自己算物理）
//   ?nolife=1  关掉活体层（重心/呼吸/惯性）
//   ?nofocus=1 关掉鼠标跟随（头不再被指针拉）
//   ?nomask=1  关掉点击遮罩（点击只按包围盒判部位）
const QT = new URLSearchParams(location.search);
PHYSH_HEAD = QT.get('physhead') === '1';
const NO_PHYS = QT.has('nophys');
const NO_LIFE = QT.has('nolife');
// 动作质感五个开关（2026-11-25 加，都是「不想要就关掉」的独立开关）：
//   additive 加法层：摆姿态时呼吸/重心不停（以前是整段让位 → hold 期像雕像）
//   follow   跟随链：眼睛→头→身体级联（自带延迟与过冲，不需要给每个动作写曲线）
//   vary     变化引擎：同一条指令每次幅度/时长/方向都不一样，刚动过还有概率不动
//   queue    动作排队：旧动作还在演时新的晚一点接上（交叉 260ms），不硬切
//   idleAnim 待机动作组：拿 anims/ 里编好的循环片段当待机（库还空着，默认关）
// 用法：localStorage['body.additive'] = '0' 之类，或地址栏 ?noadd=1
const MOTION_ON = {
  additive: QT.get('noadd') !== '1' && localStorage.getItem('body.additive') !== '0',
  follow: QT.get('nofollow') !== '1' && localStorage.getItem('body.follow') !== '0',
  vary: QT.get('novary') !== '1' && localStorage.getItem('body.vary') !== '0',
  queue: QT.get('noqueue') !== '1' && localStorage.getItem('body.queue') !== '0',
  idleAnim: QT.get('idleanim') === '1' || localStorage.getItem('body.idleAnim') === '1',
};
window.__motionOn = MOTION_ON;
const NO_FOCUS = QT.has('nofocus');
const NO_MASK = QT.has('nomask');
// ?still=1：对拍专用。只把呼吸/浮沉/自发小动作这些环境层归零，物理照跑。
// 和 cmd{frozen} 的区别：frozen 会连 flushWrites 一起停掉、物理也摘了，
// 那样量不到「参数 → 画面」的真实响应；still 只清噪声，量参数照样准。
const STILL = QT.has('still');
// ?eyeforce=-1：把眼睛钉死（排障用），确认 ParamEyeLOpen 是不是这只眼睛的有效通道
const EYE_FORCE = QT.has('eyeforce') ? Math.max(-1, Math.min(1, Number(QT.get('eyeforce')) || 0)) : null;
window.__diag = () => ({ build: window.__bodyBuild, NO_PHYS, NO_LIFE, NO_FOCUS, NO_MASK, fpsCap: window.__fpsCap, renderer: window.__rendererKind, fps: window.__fpsNow, physStep: window.__physStep });

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

// ── 物理推迟求值 ───────────────────────────────────────────────
// 引擎每帧的顺序是：动作 → 存快照 → 表情 → 眨眼 → 视线 → 自然动 → **物理** → beforeModelUpdate → 绘制 → 回滚快照
// 也就是说物理永远在我们写参数之前算完，我们写的输入（AngleX/HipAngleZ…）这一帧它看不到；
// 帧末 loadParameters() 又把参数回滚到快照，下一帧同样看不到 —— 于是物理等于被架空。
// 实测（2026-11-08，真页面）：把自动求值拦掉、改到 beforeModelUpdate 里自己算一次，
//   AngleX=25 时 ParamAngleX 稳定跟到 23.34，头发/裙子真的跟着甩。
// 注意必须"一帧只算一次"：物理内部有粒子速度/位置状态，同帧算两次 = 时间步长翻倍，头发两倍速。
function deferPhysics() {
  if (NO_PHYS) return;                                   // ?nophys=1：排障用，交回库自己算
  const im = model?.internalModel;
  const ph = im?.physics;
  if (!ph || ph.__deferred) return;
  const orig = ph.evaluate.bind(ph);
  let pend = null;
  ph.evaluate = (core, dt) => { pend = { core, dt }; };   // 框架那次只记账，不算
  ph.__run = (dt) => {
    if (!pend) return;
    const c = pend.core;
    pend = null;
    try {
      orig(c, Number.isFinite(dt) ? dt : 1 / 60);
      window.__physRuns = (window.__physRuns || 0) + 1;
    } catch (e) {
      window.__physErr = String((e && e.message) || e);
    }
  };
  ph.__deferred = true;
  window.__physDeferred = true;
}

// 姿态层写的是物理的「输出」（ParamAngleX/Y/Z），每帧会被物理重算后盖掉。
// 要让头发/裙子跟着甩，就得写它的「输入」（AngleX/Y/Z），让物理自己算出输出。
// 比例是按 physics3 的归一化反推的：输入 25 → 输出 23.34，补 1.07 才等价。
const PHYS_IN_OF = { ParamAngleX: 'AngleX', ParamAngleY: 'AngleY', ParamAngleZ: 'AngleZ' };
const NO_REDIRECT = QT.has('noredirect');   // 排障：不把 ParamAngle* 改道进物理
const PHYS_IN_GAIN = 1.07;

const EXPRESSIONS = ['默认体型', '体型1', '体型2', '兔牙', '前倾', '加载', '单片眼镜', '圈圈眼',
  '尾巴开关', '屑屑眼', '流冷汗', '流泪', '爱心眼', '竖食指开', '竖食指关', '胸口衣服',
  '脱鞋', '脸红', '裙子切换', '钢盆', '黑框眼镜', '黑脸', '＞＜'];

function hud(text) { HUD.textContent = text; }

async function boot() {
  loadLexicon();   // 词表是异步拉的，拉不到就用内置兜底，不挡启动
  loadVocab();     // 词表 v2（通道式，可叠加）
  // 贴图带 alpha 时，PIXI 6 默认预乘会让某些小网格发黑（模型鼻尖那块黑点就是这么来的）
  // 但「不预乘」在透明画布上会让边缘 alpha 抖动（发丝/裙边逐帧闪）——所以留一个 A/B 开关：
  //   ?premul=1 强制预乘，?aa=0 关抗锯齿。用户机器上若只有描边/发丝在闪，多半是这条。
  const FORCE_PREMUL = QT.get('premul') === '1';
  const NO_AA = QT.get('aa') === '0';
  if (PIXI.settings) {
    PIXI.settings.PREFER_PREMULTIPLIED_ALPHA = FORCE_PREMUL ? true : false;
    PIXI.settings.STRICT_TEXTURE_CACHE = false;
  }
  app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: !NO_AA,
    resizeTo: window,
    autoDensity: true,
    premultipliedAlpha: FORCE_PREMUL ? true : false,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  });
  document.getElementById('stage').appendChild(app.view);
  window.__app = app;   // 排障用：能直接 app.renderer.extract.pixels() 取像素做「动没动」的量化对比
  // 帧率：默认跟着显示器刷新（maxFPS=0 交给 rAF），别再钉 60。
  // 钉 60 在 120/144/165Hz 屏上和 vsync 打架，会变成「2:2:3」这种不均匀节拍：
  // 肉眼看就是画面每两帧重复一次、发丝和裙边在抖 —— 用户报的「像两帧画面来回切」。
  // 需要省电/省 GPU 时用 ?fps=60 之类自己钉住。
  const fpsArg = Number(QT.get('fps'));
  const fpsCap = QT.has('fps') && Number.isFinite(fpsArg) && fpsArg >= 0 ? fpsArg : 0;
  app.ticker.maxFPS = fpsCap;
  window.__fpsCap = fpsCap;
  // 记录这一页到底跑在 WebGL 还是 canvas2d 上（canvas2d 一挪窗口就闪，先知道自己在哪条路上）
  rendererKind = app.renderer?.type === PIXI.RENDERER_TYPE.CANVAS ? 'canvas2d' : 'webgl';
  window.__rendererKind = rendererKind;
  setInterval(() => {
    try { tickerFps = app.ticker.FPS || 0; } catch { /* ignore */ }
  }, 1000);
  // PIXI 的 ticker.FPS 在 maxFPS 限帧下会忽高忽低（同一秒里 90 和 45 交替），
  // 因为它算的是「相邻两帧的间距」；这里自己数真实帧数，读数才可信。
  app.ticker.add(() => { framesInWindow += 1; });
  setInterval(() => { tickerFps = framesInWindow; framesInWindow = 0; window.__fpsNow = tickerFps; calibratePhysStep(); }, 1000);
  // 手机切到别的 App / 浏览器标签进后台时 requestAnimationFrame 会被冻结，
  // 命令照收、参数照写，但一帧都不画 —— 表现就是「她说下一句了，上一句的动作才出来」。
  // 后台时用 setInterval 兜底：手动推进 ticker 并按低频重绘，回来时就是最新状态。
  let hiddenTimer = 0;
  const hiddenPump = () => {
    if (!app || !app.ticker || !app.renderer) return;
    try {
      app.ticker.update(performance.now());
      app.renderer.render(app.stage);
      window.__hiddenPumps = (window.__hiddenPumps || 0) + 1;
    } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!hiddenTimer) hiddenTimer = setInterval(hiddenPump, 250);
    } else if (hiddenTimer) {
      clearInterval(hiddenTimer);
      hiddenTimer = 0;
    }
  });
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
  if (!modelFile) modelFile = '大肥鱼.model3.json';
  const url = '/model/' + encodeURIComponent(modelFile);
  model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
  app.stage.addChild(model);
  window.__model = model; // 调试用：控制台里查 drawable
  // 页面到底加载了哪一版 body.js：以前写死 'v1.4-mask'，心跳里看不出版本差。
  // 现在用 <script src="/body.js?v=1699..."> 里的 stamp（服务端按文件 mtime 生成），
  // 一发心跳就能和云端的 mtime 对上，判断「她的页面是不是还在跑旧代码」不用再猜。
  window.__bodyBuild = 'v1.5/' + (PAGE_V || 'dev'); // 用来确认页面到底加载了哪一版 body.js（PAGE_V 抓的是 ?v=mtime）

  // ── 闪烁自检（?bench=1）────────────────────────────────────────────
  // 「像两帧来回切」有一个可测的指纹：A B A B 交替时，
  //   相邻两帧差 d1 很大，隔一帧差 d2 很小（frame[i] 与 frame[i-2] 几乎一样）。
  // 所以 d2/d1 明显 < 1 就是交替闪烁；正常动画两者相近。
  // 结果会 POST 到 /diag（本机服务端），/state 里能读回来，不用用户截图。
  async function runBench() {
    if (!QT.has('bench')) return;
    const frame = new PIXI.Rectangle(320, 220, 560, 420);   // 只取模型主体
    const grabs = [];
    const dts = [];
    const grab = () => {
      try {
        const r = app.renderer.extract.pixels(app.stage, frame);
        const px = (r && r.pixels) ? r.pixels : r;
        return px && px.length ? Uint8Array.from(px) : null;
      } catch { return null; }
    };
    const diff = (a, b) => {
      if (!a || !b) return 0;
      let s = 0, n = 0;
      for (let i = 0; i < a.length; i += 16) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
      return n ? s / n : 0;
    };
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      dts.push(Number(app.ticker.deltaMS) || 0);
      const g = grab();
      if (g) grabs.push(g);
      if (grabs.length >= 120) break;
    }
    const d1 = [], d2 = [];
    for (let i = 2; i < grabs.length; i++) { d1.push(diff(grabs[i], grabs[i - 1])); d2.push(diff(grabs[i], grabs[i - 2])); }
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    // 逐像素的「两帧来回切」指纹：A B A B 时 frame[i] 像 frame[i-2] 而不像 frame[i-1]。
    // 区域平均值会被呼吸/整体位移稀释（一次呼吸能让半个身子动），所以必须像素级判定：
    //   |b-a| 够大（这一帧确实变了）且 |c-a| 够小（隔一帧又回到原样）→ 记一个「交替像素」。
    // altShare = 交替像素 / 有变化的像素：接近 0 是平滑运动，接近 1 是真的在两帧之间跳。
    let altCnt = 0, movedCnt = 0, cmpCnt = 0;
    const lum = (p, i) => p[i] + p[i + 1] + p[i + 2];
    for (let i = 2; i < grabs.length; i++) {
      const a = grabs[i - 2], b = grabs[i - 1], c = grabs[i];
      if (!a || !b || !c) continue;
      for (let j = 0; j < c.length; j += 8) {
        const la = lum(a, j), lb = lum(b, j), lc = lum(c, j);
        cmpCnt++;
        if (Math.abs(lb - la) >= 18) {
          movedCnt++;
          if (Math.abs(lc - la) <= 6) altCnt++;
        }
      }
    }
    const dtMeanV = mean(dts);
    const beat = dts.filter((d) => dtMeanV > 0 && Math.abs(d - dtMeanV) > dtMeanV * 0.2).length;
    const payload = {
      build: window.__bodyBuild, fpsCap: window.__fpsCap, fps: window.__fpsNow, renderer: window.__rendererKind,
      dpr: window.devicePixelRatio, screenHz: window.screen?.refreshRate ?? null,
      frames: grabs.length, d1: +mean(d1).toFixed(3), d2: +mean(d2).toFixed(3),
      altRatio: +(mean(d2) / (mean(d1) || 1)).toFixed(3),
      altPct: +((100 * altCnt) / (cmpCnt || 1)).toFixed(3),
      movedPct: +((100 * movedCnt) / (cmpCnt || 1)).toFixed(3),
      altShare: +(altCnt / (movedCnt || 1)).toFixed(3),
      beatPct: +((100 * beat) / (dts.length || 1)).toFixed(1),
      dtMean: +dtMeanV.toFixed(2), dtMin: +Math.min(...dts).toFixed(2), dtMax: +Math.max(...dts).toFixed(2),
      ua: navigator.userAgent.slice(0, 120), at: Date.now(),
    };
    window.__bench = payload;
    try { await fetch('/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); } catch {}
    console.log('[bench]', payload);
    return payload;
  }
  window.__bench = () => runBench();
  // 模型加载完再跑，避免把加载期算进去
  setTimeout(() => { runBench(); }, 2500);

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
  // 物理：拦掉框架的自动求值，改到 beforeModelUpdate 里我们写完参数之后算（否则物理永远吃不到我们的输入）
  deferPhysics();

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
  const aimAt = (clientX, clientY, src, scale) => {
    if (!model || pinnedHead) return;
    const k = Number.isFinite(scale) ? Math.max(0.1, Math.min(1, scale)) : 1;
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
    // 【手指不算「视线目标」】手机上是「人在你面前」，不是「屏幕某个角落」：
    //   以前点屏幕会把点到的位置当成她要看的地方，点上半屏（她的头/脸）→ fy 为正 → 她就抬头，
    //   表现就是「一碰就仰头看天」。现在触屏只动眼珠，头保持正视。
    const isTouch = src === 'touch';
    const fx = isTouch ? EYE_BIAS.x : Math.max(-1, Math.min(1, (x * 0.9 + EYE_BIAS.x) * k));
    const fy = isTouch ? EYE_BIAS.y : Math.max(-1, Math.min(1, (-y * 0.6 + EYE_BIAS.y) * k));
    manualFocus.x = fx;
    manualFocus.y = fy;
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
  // 按住不放时移动指针：她的头/身体要跟着走，跨到另一半脸就换手势
  // 按住不放时移动指针：她的头/身体要跟着走，跨到另一半脸就换手势。
  // 必须用「是否按着」来判断，而不是 pointerType —— 手机是 touch，
  // 之前写 mouse 才跟，结果手机上按住之后手指怎么划她都不动。
  window.addEventListener('pointermove', (e) => {
    if (leanPress.down) leanMove(e.clientX, e.clientY);
  }, { passive: true });
  // 手指被系统打断（来电/手势返回）时也要收场，否则她会一直歪着
  window.addEventListener('pointercancel', (e) => { bodyPress.down = false; if (leanPress.down) leanEnd(); }, { passive: true });
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
    const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    // 幅度收小：以前 g/28 就满量程，手机稍微歪一下她就整颗头甩过去（用户反馈「吓人」）。
    // 现在要歪到 50 度才到边，且整体再乘 0.5（aimAt 的 scale），最大也就 ±15 度上下。
    const nx = dead(Math.max(-0.8, Math.min(0.8, g / 50)));
    const ny = dead(Math.max(-0.8, Math.min(0.8, (b - 55) / 60)));
    const cx = window.innerWidth * (0.5 + nx * 0.45);
    const cy = window.innerHeight * (0.5 + ny * 0.45);
    aimAt(cx, cy, 'tilt', 0.5);
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

  // ── 摸她（M4 阶段 5）：点/摸到身上才算，点空白不算 ──────────────────────────
  // 判定用像素 alpha 掩码：只有落在画出来的身体上才算命中，比包围盒准——
  // 这套皮两层头发之间是大片透明，用矩形判定会出现「点到空气她却躲」。
  // 分区用画面纵向比例（模型是站姿全身，头/脸/胸/腰裙/腿尾 分段稳定）。
  // 分段比例 = 相对「模型包围盒高度」的。
  // 这套比例是 2026-11-08 对着实际画面（5 % 网格截图）一格一格量出来的，不是拍的：
  //   0.10 发顶 / 0.175 眉毛 / 0.195 眼睛 / 0.225 下巴 / 0.26 肩 / 0.375 围裙腰线
  //   0.50 围裙腹 / 0.555 裙摆下缘 / 0.565 白丝起点 / 0.70 膝盖 / 0.87 脚踝
  // 第一版拍脑袋写的 0.30/0.40/0.58 全偏下一大截 —— 表现就是「摸胸回的是捏脸」。
  const TOUCH_ZONES_DEFAULT = [
    { max: 0.175, zone: 'head', name: '头' },
    { max: 0.232, zone: 'face', name: '脸' },
    { max: 0.375, zone: 'chest', name: '胸口' },
    { max: 0.70, zone: 'waist', name: '腰' },
  ];
  let TOUCH_ZONES = TOUCH_ZONES_DEFAULT;
  const TOUCH_REACT = {
    head: { pose: '眯眼', text: '……别揉乱了' },
    face: { pose: '嘟嘴', text: '捏脸要付钱的' },
    chest: { pose: '缩脖', text: '痒' },
    waist: { pose: '扭腰', text: '手往哪儿放呢' },
    tail: { pose: '摇尾巴', text: '尾巴不许揪' },
  };

  // 触摸反应**不抢她的动作**。
  // 以前直接走 applyPose()，有两个副作用：
  //   ① 同参数（她正在「扭腰」时又去摸腰）会被 2.6 秒的触摸版覆盖，到期后她那个动作就没了；
  //   ② 脸部姿态会触发 clearFaceSlot()，把她的表情整个清掉。
  // 现在：常驻型姿态写进独立的 touch 层（同优先级、更晚开始 → 只临时接管这批参数），
  //       波形型（扭腰/摇尾巴/发抖）另开一条 tch_ 前缀通道叠加，两条波形靠 Δ 累加共存。
  function applyTouchReact(name, ms) {
    const key = POSES[name] ? name : (POSE_ALIAS[name] || name);
    const pose = POSES[key];
    if (!pose || pose.clear) return false;
    const hold = clampNum(ms, 2600);
    if (pose.wave) {
      const ch = 'tch_' + (pose.ch || 'body');
      const now = performance.now();
      channelWaves.set(ch, {
        ch,
        ids: pose.wave.ids.slice(),
        amp: (pose.wave.amp && typeof pose.wave.amp === 'object') ? { ...pose.wave.amp } : clampNum(pose.wave.amp, 6),
        phase: pose.wave.phase ? { ...pose.wave.phase } : null,
        hz: clampNum(pose.wave.hz, 1.5),
        noPhysics: false,
        t0: now,
        until: now + Math.max(300, hold)
      });
      return true;
    }
    // 摸的时候头/身角度优先让给「手势层」（贴手那套连续动作）：
    // 触摸层原来 prio 5 压在手势层(4) 上面，一摸脸，头就被钉在一个一次性姿态上，
    // 每 0.7 秒换一个目标 → 看着像在抽。手势在跑时降到 3.5，让连续的贴手赢。
    // 胸/腰/腿/尾巴没有手势层，仍然是 5（反应要压过待机小动作）。
    const gestOn = !!(GEST.tracks && !GEST.released);
    const prio = gestOn ? 3.5 : 5;
    // 按下那一刻手势还没起来（GEST.tracks 为空），先按 prio 5 写了一条；
    // 等手势起来后想降到 3.5，setParamMap 会因为它自己更低的优先级被"同层更高优先级"挡住
    // （`prev.prio > prio` → continue），于是整段摸下来头都被钉在那条 prio 5 上。
    // 这里先把同层里比 3.5 高的条目删掉，让降级真的落地。
    if (gestOn) {
      const store = layerOf('touch');
      for (const id of Object.keys(pose.set || {})) {
        const prev = store.get(id);
        if (prev && (prev.prio || 0) > prio) store.delete(id);
      }
    }
    // 起手慢一点 + 续接：同一次摸里反复下发同一个姿态时不要从中间值重新爬（那就是"抖一下"）
    const n = setParamMap(pose.set || {}, hold, prio, pose.ch || 'head', { layer: 'touch', rampMs: 320, continueFrom: true });
    return n > 0;
  }

  // 「摸摸」开关：默认开（桌面透明窗没有顶栏，关掉就再也点不回来），
  // 关掉之后连 /touch 都不上报 —— 她那边不会收到「被摸了」。
  let touchEnabled = true;
  try { touchEnabled = localStorage.getItem('body.touch') !== '0'; } catch (e) { /* 隐私模式 */ }
  // 手套光标的开关由下面注册（摸手那块定义得比这里晚，不能直接引用）
  let onTouchToggle = null;
  function setTouchEnabled(v, quiet) {
    touchEnabled = !!v;
    try { localStorage.setItem('body.touch', touchEnabled ? '1' : '0'); } catch (e) { /* ignore */ }
    try { if (onTouchToggle) onTouchToggle(touchEnabled); } catch (e) { /* ignore */ }
    const btn = document.getElementById('btnTouch');
    if (btn) {
      btn.textContent = touchEnabled ? '摸摸 开' : '摸摸 关';
      btn.classList.toggle('off', !touchEnabled);
    }
    if (!quiet) hud(touchEnabled ? '摸摸开着，可以点她' : '摸摸关着，点她不会理');
  }
  window.__touchFlag = () => touchEnabled;
  window.__setTouch = (v) => setTouchEnabled(v);
  setTimeout(() => { try { setTouchEnabled(touchEnabled, true); } catch (e) { /* ignore */ } }, 0);
  let touchDownX = 0, touchDownY = 0, touchDownAt = 0;

  // 命中判定用的「粗糙 alpha 遮罩」：把模型缩小到 1/4 渲一次、整张读回内存，
  // 之后点击就只是查表（纯 CPU，0 次 GPU 回读）。
  // 为什么必须这样：每次点击都 render+extract 的话，GPU→CPU 同步会把当帧动画卡住一帧，
  //   表现就是「点她一下就闪一下」——点空白能优化掉，点她也一样会闪，只能靠缓存。
  // 她只在呼吸时轻微形变，1 秒刷一次遮罩完全够用。
  const MASK_SCALE = 0.25;
  let mask = null;              // { buf, w, h, bx, by, at }
  let maskRT = null;
  const refreshAlphaMask = () => {
    if (NO_MASK) return false;                       // ?nomask=1：排障用，点击退化为「按包围盒+高度分区」
    try {
      if (!model || !app) return false;
      const b = model.getBounds();
      const w = Math.max(1, Math.round(b.width * MASK_SCALE));
      const h = Math.max(1, Math.round(b.height * MASK_SCALE));
      if (!maskRT || maskRT.width !== w || maskRT.height !== h) {
        if (maskRT) { try { maskRT.destroy(true); } catch (e) { /* ignore */ } }
        maskRT = PIXI.RenderTexture.create({ width: w, height: h });
      }
      const mtx = new PIXI.Matrix(MASK_SCALE, 0, 0, MASK_SCALE, -b.x * MASK_SCALE, -b.y * MASK_SCALE);
      app.renderer.render(model, { renderTexture: maskRT, transform: mtx, clear: true });
      const p = app.renderer.extract.pixels(maskRT);
      const buf = (p && p.pixels) ? p.pixels : p;
      if (!buf || !buf.length) return false;
      mask = { buf, w, h, bx: b.x, by: b.y, at: Date.now() };
      window.__maskInfo = { w, h, bytes: buf.length, at: mask.at };
      return true;
    } catch (e) { window.__maskErr = String((e && e.message) || e); return false; }
  };
  window.__refreshMask = refreshAlphaMask;
  // 【不要在空闲时定时刷】之前是用 setInterval 每秒渲一次遮罩，
  // 等于空闲状态下每秒多一次离屏渲染 —— 在某些机器/被遮挡的窗口上会看到「周期性一闪」。
  // 改成懒刷新：只有真要判定点击时才刷（最多 1.5 秒一次），空闲时零额外渲染。

  // 查表：返回 0..1 的 alpha；越界返回 -1
  function alphaAtModelPoint(sx, sy) {
    const b = model.getBounds();
    const stale = !mask || Date.now() - mask.at > 1500;
    if (stale || Math.abs(mask.bx - b.x) > 2 || Math.abs(mask.by - b.y) > 2) refreshAlphaMask();
    if (!mask) return -1;
    const lx = Math.floor((sx - mask.bx) * MASK_SCALE);
    const ly = Math.floor((sy - mask.by) * MASK_SCALE);
    if (lx < 0 || ly < 0 || lx >= mask.w || ly >= mask.h) return -1;
    return mask.buf[(ly * mask.w + lx) * 4 + 3] / 255;
  }

  // ── 触摸分区自动标定 ────────────────────────────────────────────────
  // 为什么需要：分区比例按这套皮的解剖位置定，写死必然错位。第一版写死 0.30/0.40/0.58
  //   结果「摸胸口」落在 face 区间，回的是捏脸的对白 —— 而且换皮就全错。
  // 怎么量：用已经渲好的 1/4 遮罩（91×186）逐行统计
  //   ① 不透明像素数（occ）：找头顶 / 脚底；
  //   ② 肤色像素数（skin）：脸是第一段连续肤色带，腿是脸之后最大的一段肤色带，
  //      两者之间的分界就是「下巴到胯」这段躯干，再按比例切胸口/腰。
  // 肤色判据偏保守（暖色 + 红明显大于蓝），白围裙（r≈b）、蓝头发（b>r）都会被排除。
  const isSkinPixel = (r, g, b) => (r >= 150 && g >= 110 && b >= 95 && r - b >= 22 && Math.abs(r - g) <= 70);
  // 自动标定（calibrateZones）默认开：它按当前这一帧的遮罩逐行找肤色带，
  // 所以**镜头推近、换皮、改画布尺寸它都跟得上**；手写比例是死数，推近 1.216 倍以后
  // 「下巴」那条线就跑到她鼻子上了（用户实测：摸下巴 → 说「摸到了胸口」）。
  // 想要回到手写比例：加 ?rawzones=1。
  const ZONE_AUTO = !QT.has('rawzones');
  let zoneMap = null;
  function calibrateZones() {
    if (!mask || !mask.buf) return null;
    const { buf, w, h } = mask;
    const occ = new Array(h).fill(0);
    const skin = new Array(h).fill(0);
    // 肤色只在「中间竖带」里数：手臂/手在两侧，会把肤色带算到腰上去（第一版就踩了这坑，
    // 结果 hip 落在围裙腰线上、整条裙子被划成「腿」）。脸和腿都在中线上，两侧不算没影响。
    const x0 = Math.floor(w * 0.32), x1 = Math.ceil(w * 0.68);
    for (let y = 0; y < h; y++) {
      let o = 0, s = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (buf[i + 3] > 100) {
          o++;
          if (x >= x0 && x <= x1 && isSkinPixel(buf[i], buf[i + 1], buf[i + 2])) s++;
        }
      }
      occ[y] = o; skin[y] = s;
    }
    let top = -1, bottom = -1;
    for (let y = 0; y < h; y++) if (occ[y] > 0) { top = y; break; }
    for (let y = h - 1; y >= 0; y--) if (occ[y] > 1) { bottom = y; break; }
    if (top < 0 || bottom <= top) return null;
    const H = bottom - top + 1;
    // 脸：从头顶往下第一段「连续肤色」带（允许 2 行空隙，防止刘海/眼睛把脸切断）
    let faceTop = -1, faceBot = -1, gap = 0;
    for (let y = top; y <= bottom; y++) {
      if (skin[y] >= 5) { if (faceTop < 0) faceTop = y; faceBot = y; gap = 0; }
      else if (faceTop >= 0 && ++gap > 8) break;   // 连续 9 行没肤色 = 脸结束（被领结挡住）
    }
    // 腿：脸结束之后、最长的一段肤色带（>=3 行）的起点就是裙摆/胯线
    let hip = -1, runStart = -1, bestLen = 0, bestStart = -1;
    for (let y = (faceBot < 0 ? top : faceBot) + 4; y <= bottom; y++) {
      if (skin[y] >= 4) { if (runStart < 0) runStart = y; }
      else {
        if (runStart >= 0) { const len = y - runStart; if (len > bestLen) { bestLen = len; bestStart = runStart; } }
        runStart = -1;
      }
    }
    if (runStart >= 0) { const len = bottom - runStart + 1; if (len > bestLen) { bestLen = len; bestStart = runStart; } }
    hip = bestStart >= 0 ? bestStart : Math.round(top + H * 0.72);
    if (faceTop < 0) faceTop = top + Math.round(H * 0.10);
    if (faceBot < 0 || faceBot < faceTop + 2) faceBot = faceTop + Math.round(H * 0.06);
    if (hip <= faceBot + 4) hip = faceBot + Math.round(H * 0.30);
    // 胸口 / 腰 的分界：下巴到胯按 45% 切（这套皮胸在 V 领里，腰在围裙腰线）
    const chestEnd = Math.round(faceBot + (hip - faceBot) * 0.45);
    // 脸的下沿往下放 4.5% 身高（用户 11-25：「把脸部范围调大些」）：
    // 肤色带的下沿正好压在「下巴」那一行，不留余量就会在边界上反复跳；
    // 放这么宽以后下巴、下颌线、脖子都算脸，摸她的脸不会跳到胸口。
    // 头 / 脸 的分界往上收 1%：肤色带的上沿大概在眉眼那一行，
    // 结果按「眼睛」判成了摸头。往上收一点，眼眶以下都算脸，头顶和刘海才是头。
    const headEnd = Math.round(faceTop - (bottom - top) * 0.01);
    const faceEnd = Math.round(faceBot + (bottom - top) * 0.045);
    // 胸口从「放大后的脸」下面开始切，否则脸一大胸口就没了
    const chestEnd2 = Math.round(faceEnd + (hip - faceEnd) * 0.62);   // 11-25：0.45 → 0.62，胸口别那么容易被判成腰
    const f = (row) => +(row / h).toFixed(4);
    const table = [
      { max: f(headEnd), zone: 'head', name: '头' },
      { max: f(faceEnd), zone: 'face', name: '脸' },
      { max: f(chestEnd2), zone: 'chest', name: '胸口' },
      // 腰一直管到胯以下一段（大腿根），11-25 用户：「我只要从腰到大腿那边」
      { max: f(Math.round(hip + (bottom - hip) * 0.35)), zone: 'waist', name: '腰' },
      // 再往下不再单独分区（腿部分区已按用户要求去掉）
    ];
    return { table, top, bottom, faceTop, faceBot, chestEnd, hip, h, at: mask.at };
  }
  function ensureZones() {
    if (!mask || !mask.buf) { TOUCH_ZONES = TOUCH_ZONES_DEFAULT; return; }
    if (zoneMap && zoneMap.at === mask.at) return;
    const r = calibrateZones();
    if (!r) { TOUCH_ZONES = TOUCH_ZONES_DEFAULT; return; }
    zoneMap = r;
    TOUCH_ZONES = r.table;
    window.__zones = r;
  }
  window.__calibrateZones = () => { const r = calibrateZones(); if (r) { zoneMap = r; TOUCH_ZONES = r.table; window.__zones = r; } return r; };

  async function touchHit(clientX, clientY) {
    if (!model || !app || !app.view) return null;
    const r = app.view.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    // 视口坐标 → 舞台坐标。
    // 关键：stage 的坐标系是 CSS 像素（`model.getBounds()` 也在这个空间），
    // 而 `app.view.width` 是 canvas 的**后备缓冲**宽度 = CSS 宽 × renderer.resolution。
    // 手机上 resolution = min(dpr, 2) ≈ 2~3，之前直接拿 view.width 除，坐标被放大 2~3 倍，
    // 点头（fy≈0.15）会一路偏到尾巴区（fx>0.60, fy>0.55）—— 表现就是「手机摸头她说尾巴」。
    const scr = (app.renderer && app.renderer.screen) || { width: app.view.width, height: app.view.height };
    const sx = (clientX - r.left) * (scr.width / r.width);
    const sy = (clientY - r.top) * (scr.height / r.height);
    if (sx < 0 || sy < 0 || sx > scr.width || sy > scr.height) return null;
    const b = model.getBounds();
    if (sx < b.x || sy < b.y || sx > b.x + b.width || sy > b.y + b.height) return null;   // 空白区域：直接当没点
    let a;
    if (NO_MASK) a = 1;                              // 排障模式：不做 alpha 判定，直接按高度分区
    else { try { a = alphaAtModelPoint(sx, sy); } catch (e) { return null; } }
    if (!(a >= 0.4)) return null;                    // 点到透明的地方：当没点
    if (ZONE_AUTO) ensureZones();                    // ?auto=1：换皮时用自动标定（默认关，用实测比例）
    const lx = Math.round(sx - b.x);
    const ly = Math.round(sy - b.y);
    const hit = { w: Math.max(1, Math.round(b.width)), h: Math.max(1, Math.round(b.height)), b };
    const fx = lx / hit.w;                           // 0=模型左缘 1=右缘
    const fy = ly / hit.h;                           // 0=头顶 1=脚底
    // 尾巴绕身体一圈：下半身、且贴左右两侧 —— 先判尾巴，再按高度分段。
    // 中间 fx 0.34~0.66 是腿，两侧那两条白的/蓝的就是尾巴本体。
    let zone = 'legs';
    if (fy > 0.55 && fy < 0.92 && (fx > 0.60 || fx < 0.34)) zone = 'tail';
    else { for (const z of TOUCH_ZONES) { if (fy < z.max) { zone = z.zone; break; } } }
    const name = (TOUCH_ZONES.find((z) => z.zone === zone) || {}).name || '尾巴';
    lastTouch = { at: Date.now(), zone, name, x: +fx.toFixed(3), y: +fy.toFixed(3) };
    const react = TOUCH_REACT[zone] || TOUCH_REACT.head;
    if (react) {
      // 11-25 用户：「把单点的那层去掉」——单击不再下发一次性姿态（那层会和贴手/手势打架，看着像抽搐）。
      // 现在只出声、只记账；身体反应交给「按住就一直在」的连续层（applyHoldZone）。
      say(react.text, 2600);
      // 大腿 / 尾巴：摸一下就脸红（她自己开着的话不动，只关自己点的那次）
      if (zone === 'thigh' || zone === 'tail') blushOnce(6000);
    }
    hud(`摸到了${name}`);
    // 告诉她：这条会进 /state 的 lastTouch，云端那层再拼成一句话塞进提示词
    try {
      logMove(zone || '碰了一下', '你摸的');
      await fetch('/touch', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ zone, name, at: lastTouch.at }),
      });
    } catch (e) { /* 离线也要能摸 */ }
    return lastTouch;
  }
  window.__touch = (x, y) => touchHit(Number(x), Number(y));

  // ── 按住不放 = 持续摸 ───────────────────────────────────────────────
  // 单击走 touchHit（一下反应）；按住走这里：每 700ms 触发一次，越按越急。
  // 以前按住只做 leanStart（她往你手上贴），身体没有任何「一下一下被摸」的反应，
  // 所以摸头和摸胸在手上是同一种感觉，只有松手那一下有区别。
  //
  // 判定和 touchHit 里那段是同一套（坐标→舞台→alpha→分区），那边是 async（末尾要 POST），
  // 这边只要结果，所以单独留一份同步版；改分区比例时两处都要改。
  function zoneAtSync(clientX, clientY) {
    if (!model || !app || !app.view) return null;
    const r = app.view.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const scr = (app.renderer && app.renderer.screen) || { width: app.view.width, height: app.view.height };
    const sx = (clientX - r.left) * (scr.width / r.width);
    const sy = (clientY - r.top) * (scr.height / r.height);
    if (sx < 0 || sy < 0 || sx > scr.width || sy > scr.height) return null;
    const b = model.getBounds();
    if (sx < b.x || sy < b.y || sx > b.x + b.width || sy > b.y + b.height) return null;
    let a = 1;
    if (!NO_MASK) { try { a = alphaAtModelPoint(sx, sy); } catch (e) { return null; } }
    if (!(a >= 0.4)) return null;
    if (ZONE_AUTO) ensureZones();
    const w = Math.max(1, Math.round(b.width));
    const h = Math.max(1, Math.round(b.height));
    const fx = (sx - b.x) / w;
    const fy = (sy - b.y) / h;
    let zone = 'legs';
    if (fy > 0.55 && (fx > 0.60 || fx < 0.34)) zone = 'tail';
    else { for (const z of TOUCH_ZONES) { if (fy < z.max) { zone = z.zone; break; } } }
    const name = (TOUCH_ZONES.find((z) => z.zone === zone) || {}).name || '尾巴';
    return { zone, name, fx: +fx.toFixed(3), fy: +fy.toFixed(3) };
  }

  // 连摸时的「升级台词」：第一下用 TOUCH_REACT 那句，第二下催一下，第三下开始躲。
  const PET_UP = {
    head: ['唔…别停', '好了好了，头发都要乱了'],
    face: ['再捏就红了', '够啦，脸都给捏热了'],
    chest: ['你、你别一直摸…', '站远一点！'],
    waist: ['痒…别一直挠那儿', '我躲了啊'],
    legs: ['…别一直碰腿', '痒得站不住了'],
    thigh: ['别、别一直碰那儿…', '你再摸我就走了'],
    tail: ['尾巴…别一直揪', '再揪我要咬了'],
  };
  const PET_TICK_MS = 700;
  const PET = { on: false, zone: '', name: '', t0: 0, lastAt: 0, ticks: 0, x: 0, y: 0, fy: null, timer: 0, candZone: '', candAt: 0, keepAction: false, lastPlay: null, lastPoseAt: 0, alive: null, lastHold: null };

  // 只有「她自己没开着」时才点脸红，且只关自己点的那次（和害羞表情同一套规矩）
  function blushOnce(ms) {
    if (!SWITCHES['脸红'] || switchState.has('脸红')) return;
    applySwitch('脸红', true, '摸');
    if (blushTimer) clearTimeout(blushTimer);
    blushTimer = setTimeout(() => { try { applySwitch('脸红', false, '摸'); } catch (e) { /* ignore */ } }, clampNum(ms, 5000));
  }

  function petReact() {
    const react = TOUCH_REACT[PET.zone] || TOUCH_REACT.head;
    const up = PET_UP[PET.zone] || PET_UP.head;
    // 11-25：「把单点的那层去掉」——按住期间**不再**每 0.7 秒下发一次性姿态。
    // 那套和贴手（手势层）是两套时间线，凑在一起就是用户看到的「抽搐」。
    // 现在按住的身体反应由 applyHoldZone() 每帧连续写，这里只负责说台词与记账。
    // 11-25 用户：「我让鱼自己试了一下，她可以扶胸啊」——她自己用的是 **motion 举手**
    // （模型 TapBody 组里的动作，手真的抬到胸口），不是那个只到蝴蝶结的 `抚胸` 道具。
    // 所以胸口走 applyMotion('举手')，并且按住期间循环接，断口才不明显。
    // 按哪个区就播哪个区的动作；**离开这个区的时候动作不会停**（见下面 keepAlive），
    // 回来的话只是把它的「存活时间」往后刷，不重播。
    const playZone = (zone) => {
      const r = TOUCH_REACT[zone] || TOUCH_REACT.head;
      if (zone === 'chest') {
        try { applyMotion('举手', 2600); } catch (e) { /* 动作没有就退回姿态 */ }
      }
      applyTouchReact(r.pose, r.hold || 2600);
      PET.lastHold = PET.lastHold || {};
      PET.lastHold[zone] = Date.now();
      PET.lastPlay = PET.lastPlay || {};
      PET.lastPlay[zone] = Date.now();
    };
    const playOnce = () => { playZone(PET.zone); PET.lastPoseAt = Date.now(); };
    // 11-25 用户：「换区之后原位置动作应该保持，如果期间回来，应该刷新保持时间」
    // 每个区记一个存活截止时间：当前区每 tick 往后推 3 秒；不在手上的区按到期自然结束。
    // 只要还有一口气，就每 1.6 秒悄悄把它的动作续一次（不换脸色、不说台词）。
    PET.alive = PET.alive || {};
    PET.alive[PET.zone] = Date.now() + 3000;
    const now2 = Date.now();
    for (const zn of Object.keys(PET.alive)) {
      if (zn === PET.zone) continue;
      if (PET.alive[zn] <= now2) { delete PET.alive[zn]; delete PET.lastHold?.[zn]; continue; }
      if (now2 - ((PET.lastHold && PET.lastHold[zn]) || 0) > 1600) playZone(zn);
    }
    // 11-25 用户：「摸到不同部位的表情怎么没」——分区决定脸色，各部位一张脸，
    // 不再全用同一个表情；表情只动脸，身体交给姿态/动作层。
    const FACE_BY_ZONE = { chest: '惊讶', waist: '害羞', tail: '惊讶' };
    if (PET.ticks === 0 && FACE_BY_ZONE[PET.zone]) {
      try { applyExpression(FACE_BY_ZONE[PET.zone], 3200); } catch (e) { /* ignore */ }
    }
    if (PET.ticks === 0) {
      say(react.text, 2200);
      if (PET.zone === 'waist' || PET.zone === 'tail') blushOnce(6000);
      // 换区回来时如果这一区的动作还没过期，就不重播——不然一进一出就「重载」一次
      if (!PET.keepAction) playOnce();
      else { PET.lastPoseAt = Date.now(); PET.alive[PET.zone] = Date.now() + 3000; }
      PET.keepAction = false;
    } else if (PET.ticks < 999) {
      // 按住就一直循环：每约 2.2 秒接一段，动作首尾能对上，看着是连贯地在扭/在扶。
      if (Date.now() - (PET.lastPoseAt || 0) > 2200) playOnce();
      if (PET.ticks === 1 || PET.ticks === 4) say(up[0], 2000);
    }
    hud(`摸到了${PET.name}`);
  }

  function petTick() {
    if (!PET.on) return;
    PET.timer = setTimeout(petTick, 160);
    const now = Date.now();
    if (now - PET.lastAt < PET_TICK_MS) return;
    PET.lastAt = now;
    petReact();
    PET.ticks += 1;
  }

  function petBegin(clientX, clientY) {
    if (!touchEnabled) return false;
    const z = zoneAtSync(clientX, clientY);
    if (!z) return false;
    PET.on = true;
    PET.zone = z.zone;
    PET.name = z.name;
    PET.t0 = Date.now();
    PET.lastAt = 0;
    PET.ticks = 0;
    PET.x = clientX;
    PET.y = clientY;
    PET.fy = z.fy;
    lastTouch = { at: PET.t0, zone: z.zone, name: z.name, x: z.fx, y: z.fy };
    // 11-25 用户：「按到其他部位手就没了」——元凶是这里原来会调 petChestSwitch，
    // 非胸口的部位会把「抚胸」关掉，手部零件整块被隐藏。现在胸口走 motion 举手，这个开关不用了。
    petTick();          // 第一下立刻反应，不然要按住 0.7 秒才有动静
    return true;
  }

  // 按住拖动：换区就是「摸到别处」，但**不能每次越界都从头重来**——
  // 用户 11-25：「鼠标乱晃换区域，换出去又换回来会导致动作突然重载」。
  // 三条规矩：
  //   ① 新区要「停住」220ms 才真的切（晃过去又晃回来不算）
  //   ② 切回去的那个区，如果它自己的动作还在有效期（1.8s 内播过），不重播，接着用
  //   ③ 同区内的抖动只更新 fy，什么都不重来
  const PET_ZONE_HYST = 0.035;
  const PET_DWELL_MS = 220;      // 新分区要停这么久才切
  const PET_REPLAY_MS = 1800;    // 这个区的动作还在有效期内就不重播
  function petMove(clientX, clientY) {
    if (!PET.on) return;
    PET.x = clientX;
    PET.y = clientY;
    const z = zoneAtSync(clientX, clientY);
    if (!z) return;
    if (z.zone === PET.zone) { PET.fy = z.fy; PET.candZone = ''; return; }
    const from = (PET.fy === null || PET.fy === undefined) ? z.fy : PET.fy;
    if (Math.abs(z.fy - from) < PET_ZONE_HYST) return;   // 只是推近带来的漂移，不算摸到别处
    if (PET.candZone !== z.zone) { PET.candZone = z.zone; PET.candAt = Date.now(); return; }
    if (Date.now() - (PET.candAt || 0) < PET_DWELL_MS) return;   // 还没停够，先不动
    const now = Date.now();
    const recent = (PET.lastPlay && PET.lastPlay[z.zone] && now - PET.lastPlay[z.zone] < PET_REPLAY_MS);
    PET.zone = z.zone;
    PET.name = z.name;
    PET.fy = z.fy;
    PET.candZone = '';
    PET.ticks = 0;
    PET.lastAt = 0;
    PET.keepAction = !!recent;    // 切回去：保留原来那口气，不再重播动作
  }

  function petEnd() {
    if (!PET.on) return { zone: PET.zone, name: PET.name, ms: 0, ticks: 0 };
    PET.on = false;
    holdzStop();
    if (PET.timer) { clearTimeout(PET.timer); PET.timer = 0; }
    const ms = Date.now() - PET.t0;
    const out = { zone: PET.zone, name: PET.name, ms, ticks: PET.ticks };
    if (ms > 800 && PET.ticks > 1) {
      try { logMove(PET.zone, '你摸的'); } catch (e) { /* ignore */ }
      try {
        fetch('/touch', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ zone: PET.zone, name: PET.name, at: Date.now(), ms, ticks: PET.ticks }),
        });
      } catch (e) { /* 离线也要能摸 */ }
    }
    return out;
  }

  // 排障：__pet(x, y) 按住（不给 ms 就一直按着），__petEnd() 松手
  window.__pet = (x, y) => petBegin(Number(x), Number(y));
  window.__petEnd = () => petEnd();
  window.__petNow = () => ({ ...PET, name: PET.name });
  // 排障：这一点判成哪个区（不触发任何反应），用来核对分区表
  window.__zoneAt = (x, y) => zoneAtSync(Number(x), Number(y));

  // 纯判定：这一点是不是落在她身上（不改任何状态、不发请求、不说话）。
  // 桌面版拿它区分「按到她 = 摸」和「按到空白 = 拖窗口」。
  window.__onBody = (clientX, clientY) => {
    try {
      if (!model || !app || !app.view) return false;
      const r = app.view.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const scr = (app.renderer && app.renderer.screen) || { width: app.view.width, height: app.view.height };
      const sx = (clientX - r.left) * (scr.width / r.width);
      const sy = (clientY - r.top) * (scr.height / r.height);
      const b = model.getBounds();
      if (sx < b.x || sy < b.y || sx > b.x + b.width || sy > b.y + b.height) return false;
      if (NO_MASK) return true;
      return alphaAtModelPoint(sx, sy) >= 0.4;
    } catch (e) { return false; }
  };

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    touchDownX = e.clientX;
    touchDownY = e.clientY;
    touchDownAt = Date.now();
    leanStart(e.clientX, e.clientY);
    const petOk = petBegin(e.clientX, e.clientY);
    // 摸任何部位都拉近一点镜头（用户 11-25：「触碰其他部位也会拉近镜头」）。
    // 头和脸本来就有 leanZoom（0.26），这里只给胸腰腿尾巴一个更轻的（0.18）。
    const z = petOk ? PET.zone : '';
    if (z) {
      bodyPress.down = true;
      bodyPress.zoom = (z === 'head' || z === 'face') ? 0.26 : 0.18;
      bodyPress.at = Date.now();
    }
  }, { passive: true });
  // 按着拖动：手指/鼠标滑到别的部位就换区重新开始（摸头滑到脸 = 改摸脸）
  window.addEventListener('pointermove', (e) => {
    if (!PET.on) {
      // 没按着、只是把光标挪到她身上：给她一个「轻扶」的连续反应（幅度 0.55）。
      // 用户 11-25：「我想要她自己来回扭」——不用按住，光标停在腰/大腿上她就会慢慢摆。
      if (touchEnabled && e.pointerType === 'mouse') hoverHold(e.clientX, e.clientY);
      return;
    }
    if (e.pointerType === 'mouse' && !e.buttons) { petEnd(); return; }
    petMove(e.clientX, e.clientY);
  }, { passive: true });
  // 双击防抖：两次轻点间隔太近时，第二次直接吞掉。
  // 不吞的话，两次 applyPose 会让同一层重新从 0 权重淡入（0.34s），
  // 画面上就是头先回中立再升起来一次 —— 看着就是「双击在抖」。
  let lastTapAt = 0;
  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    leanEnd();
    bodyPress.down = false;
    // 按住摸过（超过 0.8 秒）就不再补那一下单击反应，否则一次长摸会多出一条台词
    const petRes = petEnd();
    if (petRes.ms > 800) return;
    const moved = Math.abs(e.clientX - touchDownX) + Math.abs(e.clientY - touchDownY);
    if (moved > 6 || Date.now() - touchDownAt > 900) return;
    const t = Date.now();
    if (t - lastTapAt < 450) { e.preventDefault?.(); return; }
    lastTapAt = t;
    if (!touchEnabled) { hud('摸摸关着（右上角「摸摸」开一下）'); return; }
    touchHit(e.clientX, e.clientY).catch(() => {});
  }, { passive: true });
  // 手机上双击会触发浏览器缩放（页面上会「整体一缩」，很像抽搐），直接掐掉
  window.addEventListener('dblclick', (e) => { e.preventDefault(); }, { passive: false });

  // 手套图以 data URI 内联：body-server 的静态路由是白名单（/body.js、/lexicon.json…），
  // 加一条 /glove.png 路由要同时改本地和云端两份服务、还得多传一个文件；内联只需部署 body.js。
  // 84x95、48 色调色板，1.9KB。
  const GLOVE_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFQAAABfCAMAAABBchAwAAAAwFBMVEUKEygRFichK0egpbI6Q15IUWna3eQNFzgeKEQbJUQWHzeSl6B7gpO9wcxdYm1bYXLJztQ6QViDh5EfK0N9hJE8QU20uMBfaIBzeIh4eoC9wssAAAD9/f4DBgwNGDnn6/QaJUQiLEoFCBMtNlOUmahQWHDEx89aYnjQ09kiLEqlqbYRFylxeIu3usRlbIKFipsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJcTUvAAAAMHRSTlMZXK7+/v7z/mbfk4r+/m2Xu65vNI5pp/2SeaQD/i3+/v75TP7+/v7+/tT+T/7+/v6TlaiqAAAGSElEQVR42u2ZaZeiOBSGQTYtq7q6e/ZpSG4MYZPl//+7eRMEogJSPc6XOZVzykMpPN7c/Ubnx3+wnE/oJ3TTrU7/90So84EnnM1MZ7/D2m95xNnK3As6MEai3D9LUufHTjBZp2lOJPbPgWo5WctjrCwg4Qxm+5eSghn3i/u0e/Sws01QkvwCjRsmznjvl/0vi487D11Tr92hjsfl097dCdI2c+afdx56vL7jwNIJmjMhiAmJv/LDkhrXLEW52yc75k1QxQRTXsizmqiclXVNUgebZMQOoixJjUwuibr+MpOT0bZKWhLlVVO1UJ+gbICmjPLh2mPCnUE4y5svSTaDQIL8i/nf8AXFpAqIuh1q4nKQrsCOmayA5R3MHkz6TVn5oe2XrLYM3vqMSaUkXtmk37j6GNQR1EzQyOM1gECmKbMk7ViZ3HMWoWchCktS+Cn3Uq/h2lCj0eIAOk0c17kmrUCtZ3PL+QFV07U4wJVvg2sFaoHyyIYKVveuUAntbEiyN8G1JumURPwrSRGgfppllU6uSLNpVmSv4pIRH+qU1IXa0hU0r2CziFAHFAK2v6fwqXQ2QZlfhbBPwMQVVMFdlZR+m72yISbiwioJy1CSnfZKX7/IG6hOAZomWTW+X8NlnXVoAp0WYQ31kWyLILqDmvglGY7vN5NW16BwKZ41Gb91qQnKJlviGzZBiwU/XZCUieQ5UCt5Q6dPknTyZez+8CRJRXTx08x/IrSPqLdaMA1NngFFdEjdYCEnqo7KJ0GlCS4hVYp69TSo1igPeV8EngkdK8sn9BP6f4Ei8xdVWhVDh9KkHsqAZ6BZlTa8h+Ier9guaaZQh1GIGzQTQy/laUlTX38gFdKpF+hLobJmC5Rkjarnq0DXvqgNxq6P1HiNe/ASKHyHzDdlKd2J6nYqyyPd2Iz9qaCIXnVtqpCYiVqt+kZtyKeJbiaErMJLw4hO+lLiGrxP3liVh/Y/DqLHSfqshwhsLc/6jnFqAbsoep1qlLLmi0fbd3XPk+dan55xqXF2gPWtYmc1xt0jQ0FM32wRutKdzcZmwl2EonvdSQr4NN8VmMc2Qc/L1XQv7NYUvWkd11FtdSIyHjs9K+pWnR+jjmCdPYBIdB/WFE1UTRNlZ49US1BsnfnSavfjUIgUzV89zfvTPlomsvG7odJ5qFuioS/swUT7CjoGEfV9fqF0t2qCIuY1/FT2PpuSgKCzUGydUshG11AW8BSRWXtpi04kywQTQeohGZAOKZV6nY8x5ZTMtT16ava1DIHVIMdviEQIWZl8EhkhM9Vfy8ozs79uUnan5B4KT8JA5BsRX+2hbnB87rVK1UOA1kq1KTe6weRe7tzTHNR4EmygECOFmObSlNgUNferxr5dEG3m2Ppj60hkAfSnXRJTXW8X3pE1984sGF0MzFuoPsxSb9hOlhtKbexS1Zid8zWmnnQM1Gb2UHOYNbhxZ3pu72IX0a0yjVJfbpgXSR1LiZfw4VUr4JBFvAGaXDN/OHeHWbjPjAccimjjeCv0ft7f2UcYcatt1UhG3kNmr9Mb5gC1Mwhye60162ePmcb65xvmALWP3ZDDVYtCwjcwdUo5JAtQ6zBLJzGK5Lp73qh09mDGtc829CAjrk6fllfHxJTxrqFJUlqWClDBX5Du8sdM5LOZ3Q9QFwHVF/ZQMYH0sMPYVT2EKjZj+xGavOA7X5useTUR4roujT0Dn1tDNrFS8z0UVGQUItz2ovPDCf8jX/PVpfDNpyUoqKfT+aWEecoXk3NO7umFtKQrSGiKyE1WoIkh9Zmxp4aoIEj5y8w3ibJ3TJxk6azvQh3XOTkiUyGqmiWdcg/l8C3m9w5lQwesuXSS7zHXdanvFO+t5KFH1f4SOsvQnmotJ/lbp4scTXLbcMsJjNulaLGF6YS+J6tn0nfUo2lsIRHz6yq7ZAIevqW57qFb/enXLzNmui7RVq411PPxK1BNK1EBUL9Um/+hfFMR/E7v/PcvpzkzrbTnoGofeD+GYZa2SqLUHkiXW1/VVRh+PX7RH89pdOVYTkvtno3pfvvr+Of7t2/656hvu/f3X49fes87n2Y3v3Ym3fvD+Xx2T/fLNW8nH4ZabuZeRcVwnSwxV3+RGBxhRtLho5/56ShZXz/9I9eHiVj/AFhoZ+YLKAA6AAAAAElFTkSuQmCC';
  // ── 光标换成一只白手套 ─────────────────────────────────────────────────────
  // gif 里「下巴/脸蛋往手上贴」之所以读得出来，一半功劳在那只手：
  // 画面里没有手当参照物，头动几个像素根本看不出「她在凑过去」。
  // 所以指针进画面就换成白手套，按住时轻轻压扁一点（像真的按在她脸上）。
  const gloveEl = (() => {
    if (typeof document === 'undefined' || !document.body) return null;
    // 桌面版不画这只手套：那边要鼠标本身去按窗口（拖/点都靠它），
    // 而且贴图在 460px 的小窗里显得很大。桌面只用系统自带的抓取光标。
    if (window.fishDesktop) return null;
    const el = document.createElement('img');
    el.src = GLOVE_SRC;
    el.alt = '';
    el.draggable = false;
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:52px', 'height:auto',
      'pointer-events:none', 'opacity:0', 'z-index:30',
      'transform:translate(-30%,-30%) rotate(-14deg)', 'transform-origin:30% 30%',
      'transition:opacity .14s ease', 'filter:drop-shadow(0 8px 12px rgba(6,10,26,0.5))',
    ].join(';');
    document.body.appendChild(el);
    return el;
  })();
  let gloveOn = false;
  let glovePress = false;
  function putGlove(x, y) {
    if (!gloveEl) return;
    gloveEl.style.left = x + 'px';
    gloveEl.style.top = y + 'px';
    const k = glovePress ? 0.93 : 1;
    gloveEl.style.transform = 'translate(-30%,-30%) rotate(' + (glovePress ? -9 : -14) + 'deg) scale(' + k + ')';
  }
  function showGlove(on) {
    // 摸摸关着的时候不出现手套：那只手是「我要摸她」的提示，没开就没这回事
    if (on && !touchEnabled) on = false;
    if (!gloveEl || gloveOn === on) return;
    gloveOn = on;
    gloveEl.style.opacity = on ? '0.97' : '0';
    document.body.style.cursor = on ? 'none' : '';
  }
  onTouchToggle = (v) => { if (!v) showGlove(false); };
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !gloveEl) { showGlove(false); return; }
    const v = app && app.view;
    if (!v) return;
    const r = v.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) { showGlove(false); return; }
    putGlove(e.clientX, e.clientY);
    showGlove(true);
  }, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !gloveEl) return;
    glovePress = true; putGlove(e.clientX, e.clientY); showGlove(true);
  }, { passive: true });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' || !gloveEl) return;
    glovePress = false; putGlove(e.clientX, e.clientY);
  }, { passive: true });
  window.addEventListener('blur', () => { glovePress = false; showGlove(false); });

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
    // 这个回调在模型 update 之后跑：把按住层「想写的值」和「这一帧实际留下的值」对一遍，
    // 有没有被物理/别的层覆盖，一次就看出来（11-25 排查「腰没在动」）。
    if (HOLDZ.on && HOLDZ.want) {
      const c = model.internalModel?.coreModel;
      if (c) {
        const seen = {};
        for (const id in HOLDZ.want) { try { seen[id] = +Number(c.getParameterValueById(id)).toFixed(2); } catch (e) { /* ignore */ } }
        HOLDZ.actual = seen;
      }
    }
    hideBlack();
    const core = model.internalModel?.coreModel;
    if (!core) return;
    const now = Date.now();
    const t = (performance.now() - t0) / 1000;

    // 情绪驱动的自发小动作（没人调她也会自己动一下）
    if (!frozen && !STILL) maybeSpontaneous(now);

    // 呼吸：胸口起伏 + 头肩极缓的摇摆 + 整个身子轻轻上下浮（像真在呼吸，不是定格）
    // frozen / ?still=1 = 截图对拍模式：所有环境动画归零，只剩「我正在写的那一层」，A/B 才比得干净
    const stillNow = frozen || STILL;
    const breath = stillNow ? 0 : Math.sin(t * 1.15);
    const sway = stillNow ? 0 : Math.sin(t * 0.42);
    const set = (id, v) => { try { frameWrites.set(id, v); } catch (e) { /* 没这个参数就算了 */ } };

    set('ParamBreath', stillNow ? 0.5 : 0.5 + breath * 0.5);

    // 呼吸带来的整体上下浮动：模型容器跟着轻轻起落（幅度随缩放走，小体型不会浮得太夸张）
    // bodySink 是「低头/抬头」这类姿态带来的整体沉降——这套皮的头几乎不低头（实测 ParamAngleY 全幅只动 2.6% 像素），
    // 只能连人一起往下沉一点，才看得出她真的低了头。
    // 姿态带来的沉降到期了自己收回去，不然她会一直「低着头」站着
    if (poseSinkUntil && Date.now() > poseSinkUntil) { bodySinkTarget = 0; poseSinkUntil = 0; }
    bodySink += ((bodySinkTarget || 0) - bodySink) * 0.12;
    leanSink += ((leanSinkTarget || 0) - leanSink) * 0.14;
    if (typeof baseY === 'number') {
      model.y = baseY + (stillNow ? 0 : Math.sin(t * 1.15 - 0.6) * 4.6 * userScale) + (bodySink + leanSink) * userScale;
    }
    // 被摸 → 镜头推近 26%，0.9s 到位，松手慢慢退回去。
    // 为什么要这么狠：实测 gif 里头的宽度占画面 46%，我们只占 23%（900 宽的底图）。
    // 取景近一倍，同样几像素的位移才在她脸上「读得出来」—— 26% 后头占约 29%。
    const leanTarget = Math.max(leanPress.down ? 0.26 : 0, bodyPress.down ? (bodyPress.zoom || 0.18) : 0);
    leanZoom += (leanTarget - leanZoom) * ((leanPress.down || bodyPress.down) ? 0.085 : 0.05);
    // 姿态的推近：前倾这类「凑过去」的姿态把镜头推近一点，退开反过来。
    // 0.06/帧 ≈ 0.35s 到位，比手的推近慢一档——姿态是「慢慢靠过来」，不是弹过来。
    if (poseZoomUntil && Date.now() > poseZoomUntil) { poseZoomTarget = 0; poseZoomUntil = 0; }
    poseZoom += ((poseZoomTarget || 0) - poseZoom) * 0.06;
    if (Math.abs(poseZoom) < 0.001 && !poseZoomTarget) poseZoom = 0;
    if (baseScale) {
      const zoomAll = leanZoom + poseZoom;
      model.scale.set(baseScale * (1 + zoomAll));
      // 推近的锚点是模型中心，头在中心上方 0.34 个模型高的位置：
      // 放大后头会往画面顶上飞，按这个偏移把整只往下压，脸大致停在原来的高度。
      const headOffsetPx = 0.34 * ((model.internalModel && model.internalModel.originalHeight) || 0) * baseScale;
      model.y += headOffsetPx * zoomAll;
    }

    // 鼠标在动的时候，头/身体/眼睛交给渲染器自带的 FocusController（就是 model.focus 那套），
    // 它按模型作者绑好的参数名自己插值转向——这才是这套皮「本来该有的跟随」。
    // 我们以前每帧覆盖 ParamAngle*/ParamEyeBall*，等于把它的自然动作顶掉了，看着就像整只被拖着走。
    // 两个驱动：鼠标跟随时由 FocusController 算头/身角度；没人理会时用很慢的自发环视。
    // 以前是硬切换——鼠标一停满 4 秒，头就从「被鼠标掰过去的角度」瞬间弹回中立位，
    // 看着就是「突然向右上看，又突然复位」。现在两条都在算，按 focusBlend 平滑过渡。
    const focusActive = (now - lastMouseAt < 4000) && !pinnedHead && !NO_FOCUS;
    focusBlend += ((focusActive ? 1 : 0) - focusBlend) * perFrame(0.10);
    const fb = Math.max(0, Math.min(1, focusBlend));
    // 【别再读 core 里的 ParamAngle* 来放大】——那是正反馈回路：
    //   ParamAngleX 现在是物理输出（= 1.07 × AngleX），我们读到 6 倍后的值再乘 6，
    //   下一帧 36 倍、再乘 216……两帧就撞到 ±30 的夹紧值，然后左右互相顶 → 头在抽搐。
    //   桌面端因为我平时用姿态命令（直接写 AngleX）盖住了回路，没暴露；手机端一碰就往死里抖。
    // 正解：直接问 FocusController 要它自己的状态（x/y ∈ [-1,1]），这是指针目标算出来的，
    //   和我们写出去的值无关，永远不会有回路。
    // 【别信 FocusController 的当前值】——渲染器自带的 InteractionManager 也会往它里面塞指针坐标，
    //   而且 `autoInteract:false` 没有拦住：手指点在她脸上，fc.y 立刻变成 +0.31，
    //   我们照它放大就成了「一点屏幕她就抬头看天」。
    //   所以跟随目标只用我们自己算的那份（鼠标移动才算，触屏一律正视）。
    const fx = Math.max(-1, Math.min(1, Number(manualFocus.x) || 0));
    const fy = Math.max(-1, Math.min(1, Number(manualFocus.y) || 0));
    // 这套皮的 ParamAngle* 在画面上很钝（实测推 30 度只有 2% 像素变化），
    // 但放大太多用户反馈「鼠标一挪脑袋就甩」。1.15 → 0.55：光标贴屏幕最边也只有 ~10 度，
    // 日常在中间晃 2–3 度——看得出在跟，但不会甩。
    const deg = 30;
    focusAim.x = Math.max(-14, Math.min(14, fx * deg * 0.55));
    focusAim.y = Math.max(-14, Math.min(14, fy * deg * 0.48));
    focusAim.z = Math.max(-14, Math.min(14, fx * deg * 0.12));
    focusAim.bx = Math.max(-14, Math.min(14, fx * deg * 0.10));
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
    // 有真音频在放的时候，嘴按真实音量开合；纯字幕才退回正弦假口型。
    // 以前她永远是「无声动画」——现在这两种情况要能无缝切换。
    const vlvl = voiceLevel();
    const target = vlvl > 0.015 ? Math.min(0.95, vlvl) : (talking ? Math.abs(Math.sin(now / 95 + talkSeed)) * 0.85 : 0);
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
          // 缓入缓出（easeInOutCubic）：以前是线性 340ms，起步那一帧就到位一半，看着像被人推了一把。
          // 三次曲线起步慢、中间快、收尾再慢，像自己把动作做出去。
          const ramp = Math.min(1, (now - o.start) / (Number(o.rampMs) > 0 ? Number(o.rampMs) : 340));
          const eased = ramp < 0.5 ? 4 * ramp * ramp * ramp : 1 - Math.pow(-2 * ramp + 2, 3) / 2;
          const w = Math.min(eased, Math.pow(Math.max(0, remain + RELEASE_MS) / RELEASE_MS, Number(o.relPow) > 0 ? Number(o.relPow) : 1.8));
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
          // 续接的条目自带「从哪儿开始」，用它替换中性底值 —— 否则半路改目标会从
          // 原位置瞬移回中段再爬，看起来像抖了一下。
          if (Number.isFinite(o.from)) acc.from = o.from;
          // 保持期微漂移：让她在「保持某个姿态」的时候还在呼吸，而不是冻成雕像。
          // 只取最大的那份幅度，多个层叠在一起也不会越漂越凶。
          if (o.drift > (acc.drift || 0)) acc.drift = o.drift;
          if (acc.seed === undefined) {
            acc.seed = (id.length * 1.7 + (id.charCodeAt(id.length - 1) || 0) * 0.13) % 6.28;
          }
          mix.set(id, acc);
        }
      }
      for (const [id, acc] of mix) {
        if (acc.den <= 0) continue;
        const target = acc.num / acc.den;
        const w = Math.min(1, acc.den);
        // 保持期的呼吸：目标值上叠一条 0.64Hz 的慢摆（幅度由写入时的 drift 决定，权重跟着 w 走）。
        // 只在完全生效（w≈1）时才有，避免刚起手就抖。
        let drift = 0;
        if (acc.drift) {
          const damt = acc.drift * Math.max(0, Math.min(1, (w - 0.75) * 4));
          if (damt > 0) drift = Math.sin(now / 640 + (acc.seed || 0)) * damt;
        }
        const origin = (acc.from === undefined || acc.from === null) ? acc.base : acc.from;
        const want = origin * (1 - w) + (target + drift) * w;
        // 缓动到目标（嘴不缓，否则说话像含着东西）
        const prev = smoothOut.has(id) ? smoothOut.get(id) : want;
        const k = id === MOUTH_ID ? 1 : perFrame(0.28);
        const sv = prev + (want - prev) * k;
        smoothOut.set(id, Math.abs(want - sv) < 0.0015 ? want : sv);
        set(id, Math.abs(want - sv) < 0.0015 ? want : sv);
        lastMix.set(id, Math.abs(want - sv) < 0.0015 ? want : sv);
      }
      // 层里已经没有的 id：缓着回原值（不是啪一下），回得差不多才放手
      for (const id of writtenIds) {
        if (mix.has(id)) continue;
        const base = animBase.has(id) ? animBase.get(id) : 0;
        const prev = smoothOut.has(id) ? smoothOut.get(id) : base;
        const sv = prev + (base - prev) * perFrame(0.20);
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
    const lifeGain = Number(window.__lifeGain ?? (NO_LIFE ? 0 : 1));   // 调参用：0 = 关掉活体层，1 = 正常
    // ① 加法层化：她摆姿态/做动作的时候，呼吸和重心**不许停**。
    // 以前这里是 `if (busyIds.has(id)) continue;` —— 只要有谁占了这批参数，活体层就整段让位，
    // 于是 hold 期她就是一座雕像（比没有动作还假）。现在改成「压低权重继续加」：
    // 动作照她的，底下的呼吸一直在。BUSY_LIFE_W = 0.4 是量出来的：再高会和姿态抢到发抖。
    const BUSY_LIFE_W = 0.4;
    for (const [id, target0] of LIFE) {
      const target = target0 * lifeGain;
      let st = lifeSpring.get(id);
      if (!st) { st = { x: target, v: 0 }; lifeSpring.set(id, st); }
      st.v += ((target - st.x) * LIFE_K - st.v * LIFE_C) * LIFE_DT;
      st.x += st.v * LIFE_DT;
      const w = busyIds.has(id) ? BUSY_LIFE_W : 1;
      if (!w) continue;
      frameAdds.set(id, (frameAdds.get(id) || 0) + st.x * w);
      lifeIds.add(id);
    }

    // ② 跟随链：眼睛先到 → 头跟 → 身体再跟（越靠下越慢，各用一根弹簧）。
    // 这条链是「看起来活」和「看起来被摆」的分界：真人转头时身体晚 150–250ms 才跟，
    // 而且回正时会过一点点再停（欠阻尼）。任何一次视线变化都会带着整根链动，
    // 所以不需要给每个动作写「预备/过冲」，它自己就长出来了。
    if ((window.__motionOn || {}).follow !== false) {
      const headZ = gazeNow.x * 4.5;      // 头被视线牵动的量（和上面那行同一个数）
      const headX = gazeNow.y * 2.6;
      const chain = (key, target, K, C) => {
        let st = lifeSpring.get(key);
        if (!st) { st = { x: target, v: 0 }; lifeSpring.set(key, st); }
        st.v += ((target - st.x) * K - st.v * C) * LIFE_DT;
        st.x += st.v * LIFE_DT;
        return st.x;
      };
      const bodyZ = chain('chain:bodyZ', headZ * 0.55, 55, 11);
      const bodyX = chain('chain:bodyX', headX * 0.50, 50, 10.5);
      const wBZ = busyIds.has('ParamBodyAngleZ') ? BUSY_LIFE_W : 1;
      const wBX = busyIds.has('ParamBodyAngleX') ? BUSY_LIFE_W : 1;
      frameAdds.set('ParamBodyAngleZ', (frameAdds.get('ParamBodyAngleZ') || 0) + bodyZ * wBZ);
      frameAdds.set('ParamBodyAngleX', (frameAdds.get('ParamBodyAngleX') || 0) + bodyX * wBX);
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

// ── M4：参数所有权 + 帧管线 ────────────────────────────────────────────────
// 以前的问题是「谁最后写谁赢」：物理盖姿态、波形盖姿态、口型盖表情，改一处坏三处。
// 现在每个参数每帧只有一个所有者，低优先级的后写会被拒绝并计数（__pipe().conflicts）。
// 优先级数字越大越强势；同一帧内先写者占位，后写者牌小的直接丢弃。
// 11-25：touch 从 5 降到 3.8 —— 压在 gesture(4) 上面时，一摸脸头就被一次性姿态钉住，
// 每 0.7 秒换一个目标，看着像在抽。现在手势（贴手的连续动作）赢，摸的姿态只赢过 pose(3)/anim(3.2)。
const OWNER_PRIO = { physio: 0, idle: 1, idlebeat: 2.5, emotion: 2, pose: 3, gesture: 4, touch: 3.8, lipsync: 6, manual: 7, debug: 9 };
// 说话时那张脸（G2）——加在 idlebeat(2.5) 上面一点点：要让自己的起伏比待机小动作明显，
// 但摸脸(touch 5)/手势(gesture 4)在场时一律让位，她自己摆的姿态(3)也压得住它。
OWNER_PRIO.speechexpr = 2.6;
// 脊髓（中钟）：夹在「说话时的脸」和「她自己摆的姿态」之间。
// 比 speechexpr 高一点点，是因为「他刚发来 → 抬眼看过去」这件事必须压过说话残留；
// 比 pose(3) 低，是她显式叫的动作永远赢。
OWNER_PRIO.spinal = 2.7;
// 时间轴动画（试播台编的动作）：在姿态(3)之上一点点 —— 它是「整段编排」，
// 应该盖住单独一个姿态；但仍低于手势(4)/摸(5)，她正在被摸时别打断摸的反应。
OWNER_PRIO.anim = 3.2;
const PARAM_OWNER = new Map();     // id -> { f: 帧号, owner: 'touch', prio }
let frameNo = 0;
let ownerConflicts = 0;
const ownerConflictSample = [];

function claimParam(id, owner) {
  const prio = OWNER_PRIO[owner] || 0;
  const cur = PARAM_OWNER.get(id);
  if (cur && cur.f === frameNo && cur.prio > prio) {
    ownerConflicts++;
    const tag = id + '<' + cur.owner;
    if (ownerConflictSample.length < 24 && ownerConflictSample.indexOf(tag) < 0) ownerConflictSample.push(tag);
    return false;
  }
  PARAM_OWNER.set(id, { f: frameNo, owner, prio });
  return true;
}

// 帧管线固定顺序（以前是隐式约定，现在写死并计时）：
//   1 feed    喂物理输入（AngleX/Y/Z）
//   2 eyes    眨眼/口型
//   3 physics 物理求值（一帧一次）
//   4 apply   把姿态/表情层写到物理输出之上
//   5 waves   波形叠加（按 Δ 累加）
//   6 ear     耳朵小抖
//   7 touch   摸脸方向层（增量）
//   8 gesture 摸脸表情编排（增量）
//   9 probe   采样
const pipeTimes = {};
function stage(name, fn) {
  const t0 = performance.now();
  fn();
  const d = performance.now() - t0;
  pipeTimes[name] = +(d).toFixed(2);
}
window.__pipe = () => ({ frame: frameNo, ...pipeTimes, conflicts: ownerConflicts, sample: ownerConflictSample.slice() });

function beforeModelHook() {
  // 每帧缓动的系数要按真实 dt 归一，否则帧间隔在 8.2 / 16.7 / 29.2ms 之间跳时，
  // 同一段缓动的速度会差 3 倍 —— 肉眼看就是「走两下停一下」，发丝和裙摆最明显。
  const dtms = Number(app?.ticker?.deltaMS) || 16.7;
  frameDtMs = Math.max(1, Math.min(80, dtms));
  frameNo++;
  stage('feed', () => flushWrites(true, false));    // 第一遍：只把物理输入（AngleX/Y/Z）喂进去
  stage('eyes', () => applyEyes());
  stage('physics', () => runPhysics());             // 物理按我们的输入算，算出头发/裙子/身体的惯性
  stage('apply', () => flushWrites(false));         // 第二遍：把真正想写的参数盖在物理输出之上
  stage('waves', () => applyWaves());
  stage('ear', () => applyEarTwitch());
  stage('touch', () => applyLean());                // 按住时朝按点倾（增量写）
  stage('gesture', () => applyGesture());           // 摸头/摸脸的编排手势（增量、错峰、反序回落）
  stage('acting', () => applyActing());              // 眼睛/嘴的节拍（同一批参数的唯一主人）
  stage('speech', () => applySpeechFace());          // 说话时脸跟着音量起伏（G2，只加不减）
  // 按住不放的连续反应放在最后：脸上那批参数（眼/眉/嘴角）不能被待机节拍、说话层盖回去。
  // 用户 11-25：「分区可以拿来做面部表情，头部什么表情、胸什么表情、腰什么表情，防止表情冲突」
  stage('holdz', () => applyHoldZone(Date.now()));
  // 脊髓这一层是纯装饰性的：它出任何错都不许把整具身体冻住。
  // （pixi 的 ticker 一旦在回调里抛异常就不再排下一帧 —— 刚才就因为这个冻成一张画）
  stage('spinal', () => {
    try { spinalTick(Date.now()); } catch (e) { SPINE.err = (SPINE.err || 0) + 1; }
  });
  // 时间轴动画（试播台里编的那种）：排在脊髓之后，让它压住脊髓的小动作
  stage('anim', () => {
    try {
      animTick(Date.now());
      if (typeof window.__idleTick === 'function') window.__idleTick(Date.now());
    } catch (e) { ANIM.err = (ANIM.err || 0) + 1; }
  });
  stage('aftercare', () => applyAftercare());        // 松手后三段式收尾
  stage('probe', () => sampleProbe());
}

// 物理：把框架那一次求值挪到我们写完参数之后，一帧只算一次（见 deferPhysics 的注释）
// 物理步长固定。
// 为什么不用真实 dt：deltatime 一抖，弹簧每帧吃到的步长就不一样，
// 头发裙摆会跟着「一顿一顿」地抖 —— 表现为「像两帧画面来回切」。
// 真实 dt 在 60fps 上限下实测 8.2 / 16.2 / 29.2ms 三个值来回跳（PIXI 的 maxFPS 节流不保证等间隔），
// 喂给物理就是明显的抖动源。这里改成按刷新率定一个固定步长，每帧一步：
// 掉帧时表现为轻微慢动作，但永远不会有「忽快忽慢」的抖动。
let physStep = 1 / 60;
if (QT.get('physstep') === 'real') physStep = 0;   // ?physstep=real：回退用真实 dt（排障用）
function calibratePhysStep() {
  // 1 秒定时器可能在模块还没走到 `let physStep` 之前就烧一次（页面首加载/热重载时见过），
  // 那时访问会抛 TDZ 的 ReferenceError。物理步长是纯优化项，测不到就等下一轮，不许抛。
  try {
    if (physStep === 0) return;
    const f = Number(window.__fpsNow) || 60;
    physStep = 1 / Math.min(144, Math.max(30, Math.round(f)));
    window.__physStep = physStep;
  } catch { /* 还没初始化完，下一轮再说 */ }
}
function runPhysics() {
  if (frozen) return;
  const ph = model?.internalModel?.physics;
  if (!ph || !ph.__run) return;
  const dt = physStep > 0
    ? physStep
    : Math.min(0.05, Math.max(1 / 240, (app?.ticker?.deltaMS || 16.7) / 1000));
  ph.__run(dt);
}

// 为什么所有参数写入都要挤到这里：引擎每帧的顺序是
//   动作 → 表情 → 眨眼 → 视线(updateFocus) → 自然动作 → 物理 → beforeModelUpdate → core.update()
// 我们的 ticker 跑在 core.update() **之后**，那一刻写进去的值只影响下一帧，
// 而下一帧的物理/视线又会把它盖掉 —— 结果就是「歪头只有 15 度、看着像没动」。
// 所以 ticker 只负责算，真正写入放到 beforeModelUpdate。
function flushWrites(redirect = true, consume = true) {
  if (frozen) { frameWrites.clear(); frameAdds.clear(); return; }
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  // ?noredirect=1：量参数的时候用（普查台会关掉物理，这时把 ParamAngle* 改道成 Angle*
  // 等于写进空气里）。只影响排障，正常页面不走这条。
  const redir = redirect && !NO_REDIRECT;
  for (const [id, v] of frameWrites) {
    // 头/身的三个角度是物理的输出，直接写会被物理下一帧重算盖掉；
    // 改写到它的输入（AngleX/Y/Z），物理自己算出带动惯性/过冲的头发和身体。
    const tid = (redir && PHYS_IN_OF[id]) || id;
    const tv = (redir && PHYS_IN_OF[id]) ? v * PHYS_IN_GAIN : v;
    // 【物理接管头部实验 ?physhead=1】第二遍不再把 ParamAngleX/Y/Z 写回去，
    // 让物理算出来的（带惯性、过冲、回弹的）头/身角度直接留在画面上。
    if (!redirect && PHYSH_HEAD && (id === 'ParamAngleX' || id === 'ParamAngleY' || id === 'ParamAngleZ')) continue;
    try { core.setParameterValueById(tid, tv); } catch (e) { /* 忽略 */ }
  }
  for (const [id, d] of frameAdds) {
    const useIn = redir && PHYS_IN_OF[id];
    const tid = useIn ? PHYS_IN_OF[id] : id;
    const td = useIn ? d * PHYS_IN_GAIN : d;
    try {
      const cur = Number(core.getParameterValueById(tid)) || 0;
      core.setParameterValueById(tid, cur + td);
      // 排障用：加法层（呼吸/跟随/微表情）不进 lastMix，单独记一份，
      // 否则「跟随链到底加了多少」在 __mixNow 里永远是 0（读参数也会被 loadParameters 回滚）。
      lastAdd.set(tid, +(td).toFixed(3));
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
  if (consume) {
    frameWrites.clear();
    frameAdds.clear();
  }
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

// 耳朵自己抖 —— 这是「老版本有个抖耳朵但不闭眼的动画」的唯一还原办法。
// 来龙去脉：那条动画原本来自模型自带的 Idle 动作（`mm.groups.idle`），
// 但它同时会改眼睛（她当时看到「眼睛一大一小」就是它），所以 2026-10 把它整组关掉了，
// 耳朵的小动作就一起没了。现在自己算：每 7~16 秒随机挑一只耳朵，300ms 里抖两下，
// **完全不碰眼睛**，所以「闭眼」和「抖耳朵」重新变成互相独立的两件事。
const EAR_L = ['LEar1', 'LEar2', 'LEar3'];
const EAR_R = ['REar1', 'REar2', 'REar3'];
let earNextAt = performance.now() + 4000 + Math.random() * 5000;
let earWave = null;      // { ids, t0, until, amp }
window.__earTwitch = (side) => {
  const ids = (side === 'R' ? EAR_R : side === 'L' ? EAR_L : (Math.random() < 0.5 ? EAR_L : EAR_R)).slice();
  const t0 = performance.now();
  earWave = { ids, t0, until: t0 + 320, amp: 0.42 };
  return ids[0];
};
function applyEarTwitch() {
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  const tms = performance.now();
  if (!earWave && !frozen && tms >= earNextAt) {
    window.__earTwitch();
    earNextAt = tms + 7000 + Math.random() * 9000;
  }
  if (!earWave) return;
  if (tms > earWave.until) { earWave = null; return; }
  const p = (tms - earWave.t0) / 1000;          // 秒
  const total = (earWave.until - earWave.t0) / 1000;
  const env = Math.max(0, Math.min(1, p / 0.05, (total - p) / 0.08));
  // 两下（3.2Hz）快速摆动；越靠耳尖幅度越大，看着像真的抽了一下
  const d = env * earWave.amp * Math.sin(2 * Math.PI * 3.2 * p);
  for (let i = 0; i < earWave.ids.length; i++) {
    const id = earWave.ids[i];
    try {
      const cur = Number(core.getParameterValueById(id)) || 0;
      core.setParameterValueById(id, cur + d * (0.55 + i * 0.3));
    } catch (e) { /* 没这个参数就算了 */ }
  }
}

// ── 按住才贴：把按点换算成「朝那边倾」的方向和强度 ────────────────────────────────
// 参考小黑盒那只桌宠的摸头：按住时她的头往手那边歪、上身跟着倾、人整体挪一点过去，
// 松手慢慢回正。区别是我们只在「按住」期间算，鼠标路过不触发（用户明确要求）。
function leanStart(clientX, clientY) {
  if (!model || !touchEnabled) return;
  let b;
  try { b = model.getBounds(); } catch (e) { return; }
  if (!b || !b.width) return;
  const view = app?.view || (app?.renderer && app.renderer.view);
  if (!view) return;
  const rect = view.getBoundingClientRect();
  const scr = (app?.renderer && app.renderer.screen) || { width: view.width, height: view.height };
  const sx = (clientX - rect.left) * (scr.width / rect.width);
  const sy = (clientY - rect.top) * (scr.height / rect.height);
  // 按的位置换算到她身体里的归一化坐标（0..1）
  const fx = (sx - b.x) / b.width;
  const fy = (sy - b.y) / b.height;
  if (fx < -0.15 || fx > 1.15 || fy < -0.05 || fy > 1.05) return;  // 按在窗口空白处，不算摸
  // 只有按在头/脸那一圈才做「往手上贴」。以前不分部位，按胸口/腰也是同一个朝向，
  // 结果鼠标拖到腰上时她的头还在往下贴 —— 用户反馈「有点乱」就是这个。
  // 11-25 用户要求：贴手别再看分区 —— 分区老判错，越改越乱。按在她身上就贴过来。
  // 方向：以「头的中心」为参照（她头大约在身高 0.16 处），往哪边按就往哪边倾
  // 注意：不能用 b.x + b.width/2 当中线 —— bounds 含尾巴和头发，左右不对称，
  // 会把左脸判成右脸（实测过）。用模型自身的水平位置 / 画布中线。
  const headX = Number.isFinite(Number(model.x)) && Number(model.x) > 0 ? Number(model.x) : (b.x + b.width / 2);
  const headY = b.y + b.height * 0.16;
  // 定点：按住期间一直用这一次的参照点算方向。
  // 不能每帧重读 model.x —— 我们会写 PositionX，整个人会跟着按点挪，
  // 再拿挪过之后的 model.x 当参照会形成反馈（往左按着按着方向就翻成往右）。
  leanPress.baseX = headX;
  leanPress.baseY = headY;
  leanPress.fy0 = fy;              // 记住按下的高度：往下拖多少才算离开脸区
  const hxRaw0 = (sx - headX) / Math.max(1, b.width * 0.10);   // 死区更窄：偏离头心 ~36px 就接近满偏
  const hxRaw = Math.sign(hxRaw0) * Math.pow(Math.abs(hxRaw0), 0.8);   // 曲线：小偏移也有明显倾斜
  const hyRaw = (sy - headY) / Math.max(1, b.height * 0.055);   // 上下更敏感：脸区只有 ~74px 高，0.055 → ~41px 就满偏
  leanPress.x = Math.max(-1, Math.min(1, hxRaw));
  leanPress.y = Math.max(-1, Math.min(1, hyRaw));
  // 越靠近她、越靠中间，强度越高；边缘轻轻按只有 0.3
  const dist = Math.hypot(hxRaw * 0.9, hyRaw * 0.9);
  leanPress.cap = Math.max(0.68, Math.min(1, 1.05 - dist * 0.25));   // 11-25：不再按分区边缘衰减
  leanPress.down = true;
  leanPress.at = Date.now();
  LEAN.at = leanPress.at;       // 按住时长从这里算（前倾/蹭的相位都依赖它）
  LEAN.state = 'nuzzle';
  // 分区：头顶 / 脸（身体上的胸腰腿尾巴仍走原来那套反应）
  const zone = pickZone(fy);
  if (zone && (zone !== leanPress.zone || !GEST.tracks || GEST.released)) startGestureSmart(zone, fx * 2);
  leanPress.zone = zone;
  window.__leanInfo = () => ({ down: leanPress.down, x: +leanPress.x.toFixed(2), y: +leanPress.y.toFixed(2), s: +leanPress.s.toFixed(2), cap: +leanPress.cap.toFixed(2), zone: leanPress.zone, gest: GEST.zone, gestTracks: GEST.tracks ? GEST.tracks.length : 0, st: LEAN.state, u: +LEAN.u.toFixed(3), v: +LEAN.v.toFixed(3), zoom: +leanZoom.toFixed(3), scale: +(Number(model && model.scale && model.scale.x) || 0).toFixed(4), baseScale: +Number(baseScale).toFixed(4) });
}

// 按在她身上的哪一段算「摸头/摸脸」（会触发往手上贴）
// 0.232 是下巴（TOUCH_ZONES 里脸的下界），再往下留一点余量到 0.27；
// 超过这条线就只做分区反应，不再把头往下拽。
const LEAN_ZONE_MAX = 0.30;
// 按下去以后允许「往下拖多远才松」：从按下的位置量，不是从固定线量。
// 为什么：捏脸会把镜头推近 1.2 倍，同一个屏幕点算出来的 fy 会自己变大（0.20 → 0.275），
// 用固定线（0.30）判会把「按住不动」也判成拖出了脸区 —— 用户看到的就是「突然不贴手了」。
// 现在改成「比按下时低了 0.14 才算拖出去」，推近那点漂移不会误杀。
const LEAN_DROP_DY = 0.14;
function leanDropLimit(fy0) {
  const base = Number.isFinite(fy0) ? fy0 : LEAN_ZONE_MAX - LEAN_DROP_DY;
  return Math.min(0.46, base + LEAN_DROP_DY);
}
// 靠近下巴那几厘米线性收力：0.19 以下满力、0.27 归零，避免「一到下巴就突然松掉」
function leanEdgeFade(fy) {
  const t = (LEAN_ZONE_MAX - fy) / 0.08;
  return Math.max(0, Math.min(1, t));
}

// 分区判定：只分「头顶 / 脸 / 其它」三块。
// 左右不再分两套手势 —— 脸的左右是**连续量**（按点相对她头的横向偏移），
// 由 applyLean() 每帧按 ax 连续驱动；中间就是正的，没有「突然从左边跳到右边」。
function pickZone(fy) {
  if (fy < 0.13) return 'headtop';
  // 0.30 和 LEAN_ZONE_MAX / 放大后的脸区一致：脸区放到 0.30 以后，
  // 这块还写 0.232 的话，摸下巴有贴手动作但没有表情手势（zone 空），读起来像「半套反应」。
  if (fy < LEAN_ZONE_MAX) return 'face';
  return '';
}

// 按住时移动鼠标：更新朝向与强度；跨区就换手势（旧的快速淡出、新的淡入）
function leanMove(clientX, clientY) {
  if (!leanPress.down || !touchEnabled) return;
  let b;
  try { b = model.getBounds(); } catch (e) { return; }
  if (!b || !b.width) return;
  const view = app?.view || (app?.renderer && app.renderer.view);
  if (!view) return;
  const rect = view.getBoundingClientRect();
  const scr = (app?.renderer && app.renderer.screen) || { width: view.width, height: view.height };
  const sx = (clientX - rect.left) * (scr.width / rect.width);
  const sy = (clientY - rect.top) * (scr.height / rect.height);
  const fx = (sx - b.x) / b.width;
  const fy = (sy - b.y) / b.height;
  // 拖出头部区（下巴以下）就不再贴手：强度包络自己 350ms 落回去，不硬切。
  // 拖回头上再重新贴回来，省得每次都要抬手重按。
  // 判据用「比按下时低了多少」，不用固定线 —— 推近会让 fy 自己变大（见 leanDropLimit 注释）。
  if (false) {   // 11-25：贴手不再因为分区/推近而松手（逻辑保留，想恢复时改回条件）
    if (leanPress.down) { leanPress.down = false; leanPress.zone = ''; }
    return;
  }
  if (!leanPress.down) {
    leanPress.down = true;
    leanPress.at = Date.now();
    LEAN.at = leanPress.at;
    LEAN.state = 'nuzzle';
  }
  const headX = Number.isFinite(leanPress.baseX) ? leanPress.baseX : (b.x + b.width / 2);
  const headY = Number.isFinite(leanPress.baseY) ? leanPress.baseY : (b.y + b.height * 0.16);
  const hxRaw0 = (sx - headX) / Math.max(1, b.width * 0.10);
  const hxRaw = Math.sign(hxRaw0) * Math.pow(Math.abs(hxRaw0), 0.8);
  const hyRaw = (sy - headY) / Math.max(1, b.height * 0.055);   // 上下更敏感：脸区只有 ~74px 高，0.055 → ~41px 就满偏
  leanPress.x = Math.max(-1, Math.min(1, hxRaw));
  leanPress.y = Math.max(-1, Math.min(1, hyRaw));
  const dist = Math.hypot(hxRaw * 0.9, hyRaw * 0.9);
  leanPress.cap = Math.max(0.68, Math.min(1, 1.05 - dist * 0.25));   // 11-25：不再按分区边缘衰减
  const zone = pickZone(fy);
  if (zone && (zone !== leanPress.zone || !GEST.tracks || GEST.released)) startGestureSmart(zone, fx * 2);
  leanPress.zone = zone;
}

function leanEnd() {
  LEAN.retreatAt = Date.now();   // 记下松手时刻，收场动画从这里算
  if (!leanPress.down && !AFTER.at) return;   // 没在按（比如空白处 pointerup），别启动收场
  leanPress.down = false;
  // 结束动画：依依不舍从松手这一刻开始计时（还赖在手上 → 慢慢睁眼目送 → 晃两下回正）
  AFTER.at = LEAN.retreatAt;
  AFTER.zone = leanPress.zone || '';
  // 记下手最后停在哪：收场第一段她要往那边再贴一下，视线也要留在那儿
  AFTER.x = Number(leanPress.x) || 0;
  AFTER.y = Number(leanPress.y) || 0;
  ACT.relAt = LEAN.retreatAt;    // 表演层从这里开始淡出，把脸交给收场
  gestRelease();   // 手势编排进入「反序回落」，不是一刀切
  // 事件播放器：手离开 → 放「余韵」（和上面给摸脸写的收场并存，谁在播谁占参数）
  try { window.__eventAnimPlay && window.__eventAnimPlay('touchend', LEAN.retreatAt); } catch (e) { }
  // 抬手动作收回去（和「默认手切举手」配对的另一半）
  if (leanPress.raised) {
    leanPress.raised = false;
    try { model?.motion?.('TapBody', 0); } catch (e) { /* ignore */ }
  }
}

// ── 摸头/摸脸：分区手势编排（三区：头顶 / 左脸 / 右脸）─────────────────────────
// 不是「一个动作」，是一组轨道：头、眼、脸红、嘴、手、身体各自有 delay/ramp/release，
// 错峰启动、反序回落；再加双频微抖（蹭），所以每次看起来都不完全一样。
const GEST_DEFS = {
  // 头顶：被摸头 —— 抬头、身体往上顶、轻轻摇头
  // 眼睛和嘴**不在这里**：它们交给 applyActing() 的节拍调度器一个人管，
  // 两套都写同一批参数会互相叠加（以前眼睛基础眯 −0.45 再叠 −0.55 的 wob，闭得过头还抖）。
  // key7 以前当腮红写过 —— 实测这副皮 key7 是空的（key10=铁锅、key11=眼镜），已删。
  headtop: {
    tracks: [
      { delay: 0, ramp: 200, release: 520, params: { ParamAngleY: 12, ParamAngleX: 3 } },
      { delay: 60, ramp: 240, release: 540, params: { ParamBodyAngleY: 5 } },
      { delay: 120, ramp: 200, release: 500, wob: { id: 'ParamAngleZ', amp: 2.4, f1: 0.7, f2: 1.3 } },
      { delay: 0, ramp: 300, release: 600, wob: { id: 'ParamBodyAngleZ', amp: 1.4, f1: 0.45, f2: 0.8 } },
    ],
  },
  // 脸（左右不再各一套！）：这里只管「表情」，方向和幅度由 applyLean() 按按点连续驱动。
  // 这样鼠标在中间时她就只是半眯着笑、不怎么歪；往左推才慢慢歪向左，往右推才歪向右，
  // 没有「越过中线突然换成另一套动作」的跳变。
  face: {
    tracks: [
      { delay: 260, ramp: 420, release: 900, wob: { id: 'ParamBrowLY', amp: 0.1, f1: 0.23, f2: 0.37 } },
      { delay: 260, ramp: 420, release: 900, wob: { id: 'ParamBrowRY', amp: 0.1, f1: 0.23, f2: 0.37 } },
    ],
    // 变体：每次按下随机挑一套额外动作，避免「每次摸脸都一模一样」
    variants: [
      [],   // 0：只走基础
      [     // 1：头在手上轻轻左右找位置
        { delay: 200, ramp: 400, release: 600, wob: { id: 'ParamAngleX', amp: 2.2, f1: 0.45, f2: 0.72 } },
        { delay: 260, ramp: 500, release: 700, wob: { id: 'ParamBodyAngleX', amp: 1.6, f1: 0.3, f2: 0.5 } },
      ],
      [     // 2：缩一下脖子、往下低一点（被摸得很受用的那种）
        { delay: 420, ramp: 320, release: 620, params: { ParamAngleY: -3.5, ShoulderY: -0.3 } },
        { delay: 900, ramp: 520, release: 700, wob: { id: 'ParamAngleY', amp: 2.2, f1: 0.5, f2: 0.8 } },
      ],
      [     // 3：眉毛跟着动（以前这里挂的是 key7 脸红，实测没有这个通道，改成眉）
        { delay: 300, ramp: 700, release: 800, wob: { id: 'ParamBrowLY', amp: 0.14, f1: 0.5, f2: 0.8 } },
        { delay: 300, ramp: 700, release: 800, wob: { id: 'ParamBrowRY', amp: 0.14, f1: 0.5, f2: 0.8 } },
      ],
    ],
  },
};

const GEST = { at: 0, zone: '', tracks: null, released: 0, fired: null, fading: null };

// 换区（按住移动时）：旧的立刻进入淡出，新的从头进；两套同时算，过渡不跳
function startGestureSmart(zone, seed) {
  if (!GEST_DEFS[zone]) return;
  if (GEST.zone === zone && GEST.tracks && !GEST.released) return;
  if (GEST.tracks && !GEST.released) {
    GEST.fading = { at: GEST.at, tracks: GEST.tracks, released: Date.now() - 260, fired: GEST.fired || {} };
  }
  startGesture(zone, seed);
}

function gestEase(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);   // smoothstep：起得柔、收得也柔
}

function addParamRaw(id, d) {
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  try {
    const cur = Number(core.getParameterValueById(id)) || 0;
    core.setParameterValueById(id, cur + d);
  } catch (e) { /* 没这个参数就算了 */ }
}

function startGesture(zone, seed) {
  const def = GEST_DEFS[zone];
  if (!def) return;
  const ph = (Math.random() - 0.5) * 0.16;   // 相位抖动 ±80ms
  // 变体：同一套基础动作 + 随机一套「额外戏」，所以每次摸脸不完全一样，
  // 也不至于变成完全随机（基础的表情节奏始终一致，看得出是她）。
  const variants = def.variants || [];
  const vi = variants.length ? Math.floor(Math.random() * variants.length) : -1;
  const all = vi >= 0 && variants[vi] ? def.tracks.concat(variants[vi]) : def.tracks;
  GEST.zone = zone;
  GEST.variant = vi;
  GEST.at = Date.now();
  GEST.released = 0;
  GEST.fired = {};
  GEST.tracks = all.map((tr) => ({
    ...tr,
    delay: Math.max(0, (tr.delay || 0) / 1000 + ph),
    ramp: (tr.ramp || 200) / 1000,
    release: (tr.release || 600) / 1000,
    amp: 0.85 + Math.random() * 0.3,          // 幅度 ±15%
    phase: (seed || 0) + Math.random() * Math.PI * 2,
  }));
}

function gestRelease() {
  if (!GEST.tracks) return;
  GEST.released = Date.now();
}

function applyGesture() {
  const now = Date.now();
  applyGestureOne(GEST, now);
  if (GEST.fading) {
    applyGestureOne(GEST.fading, now);
    if (!GEST.fading.tracks) GEST.fading = null;
  }
}

function applyGestureOne(g, now) {
  if (!g.tracks || !g.at) return;
  const t = (now - g.at) / 1000;
  if (!g.fired) g.fired = {};
  const rt = g.released ? (now - g.released) / 1000 : -1;
  let alive = false;
  for (const tr of g.tracks) {
    if (!g.fired[tr.delay] && tr.motion && t >= tr.delay) {
      g.fired[tr.delay] = true;
      try { model?.motion?.(tr.motion[0], tr.motion[1]); } catch (e) { /* ignore */ }
    }
    if (t < tr.delay) { alive = true; continue; }
    let env = gestEase((t - tr.delay) / tr.ramp);
    if (rt >= 0) env *= Math.max(0, 1 - rt / tr.release);
    if (env <= 0.001) continue;
    alive = true;
    const amp = env * (tr.amp || 1);
    if (tr.params) {
      for (const id in tr.params) addParamRaw(id, tr.params[id] * amp);
    }
    if (tr.wob) {
      const w = tr.wob;
      const osc = Math.sin(t * Math.PI * 2 * w.f1 + tr.phase) * 0.65
        + Math.sin(t * Math.PI * 2 * w.f2 + tr.phase * 1.7) * 0.35;
      addParamRaw(w.id, w.amp * amp * osc);
    }
  }
  if (!alive && g.released) {
    // 全部收完了：把抬手动作放回去，清状态
    const last = g.tracks.find((tr) => tr.motionRelease);
    if (last) { try { model?.motion?.(last.motionRelease[0], last.motionRelease[1]); } catch (e) { /* ignore */ } }
    g.tracks = null;
    g.zone = '';
    g.at = 0;
  }
}

// 每帧把它写成增量（排在所有层之后，直接加在当前值上，不会把姿态/表情盖掉）
// ── 按住不放的「连续」反应层（11-25 用户要求）─────────────────────────────
// 以前的摸法是「每 0.7 秒下发一个一次性姿态」：轻→重→躲，三个目标来回跳，
// 和贴手（gesture）、呼吸、物理各走各的时间线，叠起来就是用户说的「抽搐」。
// 现在改成：按住那一刻起，每帧现算一个缓慢的增量（正弦叠加，周期 3~5 秒），
// 松手后强度用同一个包络慢慢落回 0 —— 全程只有一条时间线，不会再跳。
const HOLDZ = { on: false, zone: '', u: 0, t0: 0, retreat: 0, chestSwitch: false, light: false };
// 排障：按住不放的连续层现在是什么状态、这一帧写了什么
window.__holdzInfo = () => ({ on: HOLDZ.on, zone: HOLDZ.zone, u: +HOLDZ.u.toFixed(3), retreat: HOLDZ.retreat, t: +(((Date.now() - HOLDZ.t0) / 1000) || 0).toFixed(2) });
// 排障：这一帧「想写的增量」和「实际留下的值」，两边差很多就是被覆盖了
window.__holdzProbe = () => ({ on: HOLDZ.on, zone: HOLDZ.zone, u: +HOLDZ.u.toFixed(3), want: HOLDZ.want || null, actual: HOLDZ.actual || null });
// 排障：不用鼠标也能把这一层打开（截图对拍用，不触发推近/手势，只测这一层本身有没有画出来）
window.__holdzTest = (zone, on = true) => { if (on) holdzStart(zone); else holdzStop(); return window.__holdzInfo(); };

// 每个部位「一直按着」时她该有的样子：
//   - 都不是静止的，带 0.3~0.5Hz 的缓慢起伏（像人在躲、在憋、在憋气）
//   - 幅度小（胸口缩 6~8 度、大腿并腿 + 微抖），按越久不会越夸张，只是慢慢晃
//   - 第三下（petReact 的 retreat）之后收 45%：她开始让开了
const HOLD_ACT = {
  chest: (t, r) => ({
    // 摸胸：手放到胸口（道具「抚胸」由 holdzStart 打开）+ 微微扭身 + 耳朵翘起来 + 又害羞又惊讶
    ParamBodyAngleZ: (3.4 * Math.sin(t * 0.9 + 0.4)) * r,           // 上身轻轻扭
    ParamBodyAngleRX: (-2.6 + 1.0 * Math.sin(t * 1.35)) * r,         // 往后缩一点
    ParamAngleX: 5.0 * Math.sin(t * 0.8 + 0.6) * r,                  // 头左右躲（看向鼠标由 gesture 负责）
    ParamAngleZ: (3.2 + 1.1 * Math.sin(t * 1.2)) * r,
    ParamBrowLY: 1.0 * r,                                            // 眉毛抬起来 = 耳朵翘起来
    ParamBrowRY: 1.0 * r,
    ParamEyeLOpen: (0.30 * r) + 1,                                    // 眼睛睁大（惊讶）
    ParamEyeROpen: (0.30 * r) + 1,
    ParamEyeSmile: (-0.15 + 0.06 * Math.sin(t * 1.8)) * r,           // 眼角压一点（害羞）
  }),
  waist: (t, r) => ({
    // 摸腰：并腿、扭腰、脸红（由 touchHit/petReact 的 blushOnce 负责），脸上偏妩媚又害羞
    // 11-25 加大到实测「看得见」的量级：HipAngleZ 16 / BodyAngleZ 10 / BodyAngleX 7 是
    // 单独推参数时像素差 41% 的那一档（原 8/5 太轻，他直接说「看不出来」）。
    ParamHipAngleZ: (16.0 * Math.sin(t * 0.9)) * r,
    ParamBodyAngleZ: (10.0 * Math.sin(t * 0.9 - 0.4)) * r,
    ParamBodyAngleX: (7.0 * Math.sin(t * 0.62 + 0.5)) * r,     // 胯左右摆，整身跟着晃
    ParamBodyAngleY: (-4.0 + 2.0 * Math.sin(t * 1.6)) * r,
    ParamAngleZ: (3.4 + 1.2 * Math.sin(t * 0.8 + 1.2)) * r,
    ParamAngleX: (2.2 * Math.sin(t * 0.7 + 0.9)) * r,
    ParamEyeLOpen: -0.30 * r,                                        // 眼睛半眯（妩媚）
    ParamEyeROpen: -0.30 * r,
    ParamEyeSmile: 0.30 * r,
    ParamMouthForm: 0.25 * r,                                        // 嘴角轻轻抬
    ParamCheek: 0.20 * r,                                            // 腮红（参数级的淡红）
  }),
  thigh: (t, r) => ({
    // 摸大腿根：并腿 + 扭腰 + 脸红 + 脸上妩媚又害羞
    Param33: Math.min(1, r * 1.6),                                   // 并腿（连续拉起，不是开关）
    ParamBodyAngleY: (-4.6 + 2.2 * Math.sin(t * 2.2)) * r,
    ParamAngleZ: (8.5 + 2.6 * Math.sin(t * 1.5 + 0.3)) * r,
    ParamHipAngleZ: (12.0 * Math.sin(t * 0.8)) * r,
    ParamBodyAngleX: (5.0 * Math.sin(t * 0.55 + 1.2)) * r,
    ParamBodyAngleZ: (8.0 * Math.sin(t * 1.1 + 1.1)) * r,
    ParamAngleX: (2.6 * Math.sin(t * 0.7 + 2.0)) * r,
    ParamEyeLOpen: -0.26 * r,
    ParamEyeROpen: -0.26 * r,
    ParamEyeSmile: 0.28 * r,
    ParamMouthForm: 0.22 * r,
    ParamCheek: 0.22 * r,
  }),
  legs: (t, r) => ({
    ParamAngleY: (-3.0 + 1.2 * Math.sin(t * 1.3)) * r,
    ParamBodyAngleY: (-2.4 + 1.0 * Math.sin(t * 1.8 + 0.6)) * r,
  }),
  tail: (t, r) => ({
    ParamBodyAngleZ: (3.2 * Math.sin(t * 1.4)) * r,
    ParamAngleZ: (2.2 * Math.sin(t * 1.4 - 0.4)) * r,
  }),
  // 头和脸主要是 gesture 在做连续动作，这里只补一点点身体（不然两套抢同一批参数）
  head: (t, r) => ({ ParamBodyAngleY: (-2.0 + 0.8 * Math.sin(t * 1.5)) * r }),
  face: (t, r) => ({ ParamBodyAngleY: (-2.2 + 0.9 * Math.sin(t * 1.5 + 0.5)) * r }),
};

// 光标停在她身上（没按键）时给一个轻量的连续反应：用户要「她自己来回扭」，
// 不是每一下都要按住。只对胸/腰/大腿/尾巴生效，头和脸保持「点了才动」。
const HOVER_ZONES = {};   // 11-25 用户要「按以前的」，悬停不再触发
let hoverZoneAt = 0;
function hoverHold(cx, cy) {
  if (Date.now() - hoverZoneAt < 90) return;
  hoverZoneAt = Date.now();
  const z = zoneAtSync(cx, cy);
  const want = z && HOVER_ZONES[z.zone] ? z.zone : '';
  if (want) {
    if (!HOLDZ.on || HOLDZ.light !== true || HOLDZ.zone !== want) {
      HOLDZ.light = true;
      holdzStart(want);
    }
  } else if (HOLDZ.on && HOLDZ.light === true) {
    HOLDZ.light = false;
    holdzStop();
  }
}

// 摸胸口时打开模型自带的「抚胸」道具（手抬到蝴蝶结下沿），换区/松手关掉我们点的那一次。
function petChestSwitch(zone) {
  const want = zone === 'chest';
  if (want && !HOLDZ.chestSwitch) {
    try {
      if (SWITCHES['抚胸'] && !switchState.has('抚胸')) { applySwitch('抚胸', true, '按住'); HOLDZ.chestSwitch = true; }
    } catch (e) { /* 道具没有就算了 */ }
  } else if (!want && HOLDZ.chestSwitch) {
    HOLDZ.chestSwitch = false;
    try { applySwitch('抚胸', false, '按住'); } catch (e) { /* ignore */ }
  }
}

function holdzStart(zone) {
  if (!HOLDZ.on) { HOLDZ.t0 = Date.now(); HOLDZ.retreat = 0; }
  HOLDZ.on = true;
  HOLDZ.zone = zone || 'chest';
  // 11-25 晚：这里以前会点开模型道具「抚胸」，但松手那一下如果 petEnd 没跑到
  // （鼠标移出窗口、pointerup 丢在别处），道具就永远开着 —— 表现成「她一直把手放在胸口」。
  // 现在胸口改走 motion「举手」（手真的抬到胸口，见 petReact），这里不再碰任何道具。
}

function holdzStop() {
  HOLDZ.on = false;
  if (HOLDZ.chestSwitch) {
    HOLDZ.chestSwitch = false;
    try { applySwitch('抚胸', false, '按住'); } catch (e) { /* ignore */ }
  }
}

// 每帧调用：强度包络 + 各参数增量。起 260ms / 落 520ms（松手要慢一点，像肌肉在放松）
function applyHoldZone(now) {
  // 自愈：如果我们点开过「抚胸」而现在早已松手，就把它关掉（防止一次漏掉的 pointerup 让手永远抬着）
  if (HOLDZ.chestSwitch && !HOLDZ.on) {
    HOLDZ.chestSwitch = false;
    try { applySwitch('抚胸', false, '按住'); } catch (e) { /* ignore */ }
  }
  const want = HOLDZ.on ? (HOLDZ.light ? 0.55 : 1) : 0;
  HOLDZ.u += (want - HOLDZ.u) * perFrame(want > HOLDZ.u ? 0.30 : 0.13);
  if (HOLDZ.u < 0.008) { HOLDZ.u = 0; return; }
  const f = HOLD_ACT[HOLDZ.zone];
  if (!f) return;
  // 页面上直接能看到「按住层到底有没有在跑」——11-25 他说「根本没效果」，
  // 光看动作分不清是没触发还是没画出来，所以把状态写到左下角。
  if (HOLDZ.hudZone !== HOLDZ.zone || (now - (HOLDZ.hudAt || 0) > 700)) {
    HOLDZ.hudZone = HOLDZ.zone; HOLDZ.hudAt = now;
    const NM = { head: '头', face: '脸', chest: '胸口', waist: '腰', thigh: '大腿', legs: '腿', tail: '尾巴' };
    hud('按住：' + (NM[HOLDZ.zone] || HOLDZ.zone) + ' ' + HOLDZ.u.toFixed(2));
  }
  const t = (now - HOLDZ.t0) / 1000;
  const r = HOLDZ.u * (HOLDZ.retreat ? 0.55 : 1);
  const map = f(t, r);
  // 记下「这一帧想写什么」，配合 __holdzProbe 查有没有被别的层覆盖
  HOLDZ.want = map;
  for (const id in map) {
    const v = map[id];
    if (Math.abs(v) > 0.001) addParamRaw(id, v);
  }
}

function applyLean() {
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  const now = Date.now();
  // ── 方向层：目标值 → 死区 → 低通 → 限速 ────────────────────────────────
  // 死区：手指按着不动时会有 2~3px 的抖，不滤掉就会被放大成「抽搐」
  const gain = Number(TUNE.leanGain) || 1;
  const followK = Math.max(0.05, Math.min(0.6, 0.18 * (Number(TUNE.follow) || 1)));
  const dead = (x, dz) => (Math.abs(x) < dz ? 0 : x);
  const dz = 0.06 / Math.max(0.4, Number(TUNE.follow) || 1);
  LEAN.tu = leanPress.down ? dead(leanPress.x, dz) : 0;
  LEAN.tv = leanPress.down ? dead(leanPress.y, dz * 0.8) : 0;
  const kU = perFrame(followK);
  // 上下用更快的跟随：眼睛先到、头后到，看着才像「先看见再转过去」
  const kV = perFrame(Math.min(0.5, followK * 1.45));
  LEAN.u += (LEAN.tu - LEAN.u) * kU;
  LEAN.v += (LEAN.tv - LEAN.v) * kV;
  // 限速 40°/s（u=1 → 22°），超了就按最大步长走：既跟手又不会「啪」地跳
  const maxStep = Math.min(0.25, (40 * frameDtMs / 1000) / 22);
  const du = Math.max(-maxStep, Math.min(maxStep, LEAN.u - LEAN.prevU));
  const dv = Math.max(-maxStep, Math.min(maxStep, LEAN.v - LEAN.prevV));
  LEAN.u = LEAN.prevU + du;
  LEAN.v = LEAN.prevV + dv;
  LEAN.prevU = LEAN.u;
  LEAN.prevV = LEAN.v;
  // ── 强度包络：起 200ms、落 350ms（松手不瞬间归零，看着才像肌肉在放松）──
  const want = leanPress.down ? leanPress.cap : 0;
  const rising = want > LEAN.s;
  LEAN.s += (want - LEAN.s) * perFrame(rising ? 0.26 : 0.12);
  if (LEAN.s < 0.004) {
    LEAN.s = 0;
    leanPress.s = 0;
    LEAN.state = 'idle';
    leanSinkTarget = 0;     // 强度归零时沉降也要回家，否则她会一直比别人矮一截
    return;
  }
  leanPress.s = LEAN.s;
  LEAN.state = leanPress.down ? 'nuzzle' : 'recover';
  const s = LEAN.s;
  const ax = LEAN.u;
  const ay = LEAN.v;
  const sg = s * (Number(TUNE.leanGain) || 1);
  const hold = leanPress.down ? (now - LEAN.at) / 1000 : 0;
  // ── 韵律层：按住 0.35s 起开始蹭（头）与轻摇（身）──────────────────────
  // 蹭是「她自己在磨」，所以给它自己的相位与频率，和方向层解耦：
  // 手不动，她也一直在小幅度蹭；手一动，蹭的中心跟着平移。
  const rubAmt = Math.max(0, Math.min(1, (hold - 0.35) / 0.5)) * s;
  const rub = rubAmt * Math.sin(hold * Math.PI * 2 * 1.7) * 2.6;
  const sway = rubAmt * Math.sin(hold * Math.PI * 2 * 0.6 + 1.1) * 1.6;
  const add = (id, d) => {
    if (!d || !claimParam(id, 'touch')) return;
    try {
      const cur = Number(core.getParameterValueById(id)) || 0;
      core.setParameterValueById(id, cur + d);
    } catch (e) { /* 没这个参数就算了 */ }
  };
  // 头往按的那边歪 + 蹭；转头看过去；上身跟着倾；整体朝那边挪一点。
  // 符号实测（用 ?axisTest=px 只写 PositionX、量剪影重心定位的）。
  const AT = QT.get('axisTest') || 'all';
  const use = (k) => AT === 'all' || AT === k;
  // ?mirror=1 把整套左右同时翻过来 —— 不用改代码就能确认方向对着没
  const M = QT.get('mirror') === '1' ? -1 : 1;
  const mx = ax * M;
  if (use('z')) add('ParamAngleZ', mx * 22 * sg + (rub + sway) * M);
  if (use('x')) add('ParamAngleX', mx * 10 * sg);
  // ── 上下跟：剂量全部来自 ?still=1 无头对拍（900x1200，数字=头区像素位移）─────────
  // 活通道实测：ParamBodyAngleY −16 → 头下移 30px（屏高 2.5%，一眼能看出来）；
  //             ParamAngleY −25 → 4px（只给一点透视，不能指望它）；
  //             CheeksWiggleY 0.55 → 脸区 16% 形变（下巴被托住的挤出感）。
  // 死通道实测（写入后画面差在噪声底内，别再用）：AngleY、PositionX、PositionY、
  //             ShoulderY、key7、ParamEyeBallY、ParamMouthForm、CheeksWiggleXL/XR。
  //             以前「上下没变化」就是全押在 AngleY + PositionY 这两条死路上。
  // 抬头天生弱：ParamBodyAngleY 要 +30 才抬 8px（这副皮往后仰几乎不动），
  // 所以抬头额外用 leanSink 把整只往上托 10px 凑，低头只要 4px（大头在 BodyAngleY）。
  const pu = Math.max(0, -ay);          // 手在她脸的上方（额头/发顶那侧）
  const pd = Math.max(0, ay);           // 手在下巴/脖子那侧
  const pv = sg * (Number(TUNE.pitch) || 1);
  add('ParamAngleY', (pu * 20 - pd * 20) * pv);
  add('ParamBodyAngleY', (pu * 26 - pd * 24) * pv);   // 低头的大头在这条（-16 就能让头下移 30px）
  add('CheeksWiggleY', pd * 0.55 * pv);               // 下巴被手托住时，脸颊挤出一点
  leanSinkTarget = (pd * 4 - pu * 10) * (s * (Number(TUNE.pitch) || 1));
  if (use('bz')) add('ParamBodyAngleZ', mx * 12 * sg + sway * 0.6);
  // 【身体的三个轴】ParamBodyAngleX 实测只转胯和裙摆（neck 12.9%、head 1.5%）——
  // 光转身体头不跟着，看着像脖子拧了，所以只给一点点，再让 ParamAngleX 把脸一起转过去。
  const lean = Math.min(1, Math.max(0, (hold - 0.15) / 0.9));   // 表演层：按住 0.15s 起前倾，1s 到位
  add('ParamBodyAngleX', mx * 16 * sg);                          // 转身体
  add('ParamBodyAngleY', lean * 6 * sg + rub * 0.12);            // 前倾贴过去（上下那部分在上面按姿态给）
  // 胯慢半拍跟着转（物理裙摆会带出层次）；再加一点按不住的轻晃，
  // 不然按住不动的那两秒她整个人是「钉住」的。
  add('ParamHipAngleZ', mx * 11 * sg + Math.sin(hold * 1.7) * 2.2 * sg);
  // PositionX / PositionY 实测是死通道（写了 0 变化），左右「往手那边挪」改由
  // ParamAngleZ（头歪过去）+ ParamAngleX（脸转过去）承受，见上面两条。
  add('ParamEyeBallX', mx * 0.6 * sg);
  add('ParamEyeBallY', -ay * 0.7 * sg);

  // ── 主动蹭：她要「自己往你手上顶」，不是被动跟着手走 ─────────────────────
  // 每 1.1s 一个来回：0~45% 时间顶出去（快），剩下的慢慢收回来，
  // 顶的方向跟着手（mx），所以手在哪边她就往哪边蹭。幅度由手感面板的「蹭劲」控制。
  if (leanPress.down && hold > 0.45) {
    const cyc = (hold * 0.9) % 1;
    const pushEnv = cyc < 0.45
      ? Math.sin(Math.PI * (cyc / 0.45))
      : Math.sin(Math.PI * (1 - (cyc - 0.45) / 0.55)) * 0.35;
    const push = pushEnv * 5.2 * (Number(TUNE.nuzzle) || 1) * sg;
    add('ParamAngleZ', mx * push);
    // 顶的方向要跟着手在哪：手在她脸下方 → 她把下巴往下往你手上顶；手在上方 → 抬头往上贴。
    // 以前这里写死 -Math.abs(push)（= 低头），所以隔着按都变成同方向，垂直那维就废了。
    const vdir = pu - pd;
    add('ParamAngleY', vdir * Math.abs(push) * 0.45);
    add('AngleY', vdir * Math.abs(push) * 0.75);
    add('ParamBodyAngleX', mx * push * 0.45);
    add('PositionX', mx * push * 1.4);
    add('PositionY', vdir * Math.abs(push) * 0.35);
  }

  // ── 收场：松手后先「抽回来一点」，再慢慢散掉（不是一下子弹回中立）──────
  const rt = LEAN.retreatAt ? (now - LEAN.retreatAt) / 1000 : 99;
  if (!leanPress.down && rt < 1.1) {
    const e = Math.exp(-rt * 3.2) * Math.sin(Math.min(1, rt / 0.5) * Math.PI * 0.5);
    // 收场是「抬一下头看你」：ParamAngleY / ParamBodyAngleY 正值 = 抬头（见姿态表「看上」）
    // 「AngleY」这条是死通道，实测写 ±30 画面差 0.5%（噪声底 1.5%），别再写它了。
    add('ParamAngleY', 2.6 * e * sg);
    add('ParamBodyAngleY', 2.2 * e * sg);
    add('ParamAngleZ', Math.sin(rt * 9) * 1.2 * e * sg);   // 一点点余韵
  }
}

// ── 表演层（加戏）：对手的反应，不是对秒表的反应 ──────────────────────────────
// 【为什么重写】上一版是个节拍器：眼睛 1.4~2.2s 换一拍、嘴 ~1s 换一拍，跟手完全无关。
// 人眼判断「机械」的第一条线索就是「动作和输入没有因果」——所以她看起来像在播放动画。
// 现在这一版读的是手速和停顿：手在摸 → 闭眼笑 ^^；手一停 → 睁开眼看你的手；
// 停久了 → 就这么半睁着看你；按住超过 4.2s → 开始不好意思（视线收回、嘴角压平）。
// 按住期间还随机插一次性小动作（歪头 / 抿嘴 / 抖一下 / 突然睁眼），那是「她自己的想法」。
// 眼睛、嘴仍然只有这一层写（同一参数一个主人），但值都过二阶弹簧：略欠阻尼、有 10~15% 过冲 ——
// 「灵动」和「参数在动」的差别就在这个过冲，以及动作到底跟不跟得上手。
const REACT = {
  on: false, at: 0, state: 'idle',
  px: 0, py: 0, hv: 0, stillAt: 0,
  eyeT: 1, smileT: 0, formT: 0, openT: 0,
  eye: 1, smile: 0, form: 0, open: 0,
  vEye: 0, vSmile: 0, vForm: 0, vOpen: 0,
  blush: 0, vBlush: 0,          // key7 = 腮红层（实测有效，只是慢热慢退，所以单独一根慢弹簧）
  wrote: 0, spontAt: 0, spontKind: '', spontDir: 1, spontT0: 0,
  peekUntil: 0,
  // 没人碰她的时候，她自己也在动一点点：下一拍的时间 / 这一步做什么 / 从哪开始 / 往哪边
  idleAt: 0, idleKind: '', idleDir: 1, idleT0: 0,
};
const AFTER = { at: 0, zone: '', dur: 2.4, x: 0, y: 0, wrote: null };
// 空闲小动作的写入计数（排障用）：写进去了几个参数 / 被更高优先级的层挡掉了几个
let beatWrites = 0;
let beatRefused = 0;
// 自发小动作：时长（秒）
// brow = 眉毛抬一下（想事情），blink = 多眨一下眼 —— 这两个只在没人碰她的时候用
const SPONT = { tilt: 0.95, pout: 0.7, shiver: 0.5, peek: 0.62, brow: 0.85, blink: 0.42 };

function applyActing() {
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  // ?eyeforce=-1 → 每帧把眼睛钉死在某个值上（排障用：确认 ParamEyeLOpen 到底管不管这只眼睛）
  if (EYE_FORCE !== null) {
    try {
      core.setParameterValueById('ParamEyeLOpen', EYE_FORCE);
      core.setParameterValueById('ParamEyeROpen', EYE_FORCE);
    } catch (e) { /* ignore */ }
    return;
  }
  const now = Date.now();
  // 用真实帧间隔，不要写死 1/60：无头/软渲染下只有 10fps，写死的话弹簧在墙上时间里会慢 5 倍
  const rawDt = REACT.lastAt ? (now - REACT.lastAt) / 1000 : 1 / 60;
  REACT.lastAt = now;
  const dt = Math.max(0.008, Math.min(0.06, rawDt));
  const held = !!leanPress.down;

  // 手速：每帧位移的指数平滑（leanPress.x/y 是「按点相对她头心」的归一化偏移，±1 满量程）
  const pv = Math.abs(leanPress.x - REACT.px) + Math.abs(leanPress.y - REACT.py);
  REACT.px = leanPress.x; REACT.py = leanPress.y;
  REACT.hv += (pv - REACT.hv) * 0.35;
  if (pv > 0.004) REACT.stillAt = now;

  let eyeT = 1, smileT = 0, formT = 0, openT = 0;
  let blushT = 0;
  let state = 'idle';
  const extra = [];   // 弹簧之外的临时增量（歪头 / 抖一下）

  if (held) {
    if (!REACT.on) {
      REACT.on = true;
      REACT.at = now; REACT.stillAt = now; REACT.hv = 0;
      REACT.spontAt = now + 6500 + Math.random() * 4500;    // 6.5~11s 之后她自己动一下
      REACT.peekUntil = now + 2300 + Math.random() * 900;   // 2.3~3.2s 之后忍不住偷看你一眼
      REACT.peekFrom = 0;
      // 手一放上来就暂停「她自己的小动作」，不然摸到一半她自己歪头，手感会乱
      REACT.idleKind = ''; REACT.idleAt = 0;
    }
    const stillMs = now - (REACT.stillAt || now);
    const holdMs = now - REACT.at;
    if (stillMs < 450 && REACT.hv > 0.006) {
      state = 'stroke';                    // 手在摸：闭眼笑 ^^
      eyeT = 0.02; smileT = 0.95; formT = 0.42; openT = 0.05; blushT = 0.55;
    } else if (stillMs < 1250) {
      state = 'open';                      // 手刚停：睁开眼看你的手
      eyeT = 0.70; smileT = 0.52; formT = 0.30; openT = 0.02; blushT = 0.40;
    } else {
      state = 'look';                      // 停久了：就这么半睁着看你
      eyeT = 0.90; smileT = 0.60; formT = 0.20; openT = 0; blushT = 0.30;
    }
    if (REACT.peekUntil && now >= REACT.peekUntil) {
      // 一次性惊喜：忽然睁大眼睛看你 —— 要持续 0.45s，只亮一帧的话眼睛还没弹开就没了
      REACT.peekUntil = 0; REACT.peekFrom = now;
    }
    if (REACT.peekFrom && now - REACT.peekFrom < 450) {
      eyeT = 1.0; smileT = 0.35; formT = 0.10; blushT = 0.50;
      state = 'peek';
    }
    if (holdMs > 4200) {                   // 摸太久了，不好意思
      eyeT = Math.min(eyeT, 0.55); smileT = 0.28; formT = -0.12; blushT = 1.0;
      state = 'shy';
    }
    // 自发小动作：不靠外部事件，也算「她自己的想法」
    if (now >= REACT.spontAt) {
      const kinds = Object.keys(SPONT);
      REACT.spontKind = kinds[Math.floor(Math.random() * kinds.length)];
      REACT.spontDir = Math.random() < 0.5 ? -1 : 1;
      REACT.spontT0 = now;
      REACT.spontAt = now + 7000 + Math.random() * 6000;
    }
  } else if (AFTER.at) {
    // 松手后的脸：依依不舍（头 / 身的小动作在 applyAftercare 里）
    const t = (now - AFTER.at) / 1000;
    if (t < 0.55) {
      state = 'linger';                    // ① 手走了，她还停在原地：眼不睁、嘴角还挂着笑
      eyeT = 0.05 + 0.10 * (t / 0.55); smileT = 0.85; formT = 0.38; blushT = 1.0;
    } else if (t < 1.35) {
      state = 'relook';                    // ② 这才慢慢把眼睛睁开，看手离开的方向
      const p = (t - 0.55) / 0.8;
      eyeT = 0.15 + 0.78 * p; smileT = 0.62 - 0.30 * p; formT = 0.34 - 0.36 * p;
      blushT = 0.90 - 0.45 * p;
    } else if (t < AFTER.dur) {
      state = 'settle';                    // ③ 晃两下，回常态
      eyeT = 0.95; smileT = 0.20; formT = 0.04; blushT = 0.30;
    } else {
      AFTER.at = 0; AFTER.zone = ''; state = 'idle';
    }
    // 依依不舍的视线：手离开后 1.3s 内她还在看那只手最后停的位置
    if (t < 1.3) {
      gazeTarget.x = Math.max(-0.9, Math.min(0.9, AFTER.x * 0.85));
      gazeTarget.y = Math.max(-0.9, Math.min(0.9, -AFTER.y * 0.7));
    }
  } else {
    if (REACT.on) { REACT.on = false; REACT.spontKind = ''; REACT.peekUntil = 0; }
    // 没人碰、也没在收场：她自己也有小动静。
    // 以前这些节拍只在她被摸的时候跑，松手就全停 —— 那正是「像贴图」的来源：
    // 一张脸从下一秒开始完全不变，只有引擎的眨眼还在。
    // 节奏取 4.2~9.4 秒一拍（真人静坐时的微动差不多就是这个量级），动作幅度按 0.5 缩小。
    if (!REACT.idleAt) {
      REACT.idleAt = now + 2200 + Math.random() * 3200;
    } else if (now >= REACT.idleAt) {
      const kinds = ['tilt', 'tilt', 'brow', 'brow', 'pout', 'peek', 'blink', 'shiver'];
      REACT.idleKind = kinds[Math.floor(Math.random() * kinds.length)];
      REACT.idleDir = Math.random() < 0.5 ? -1 : 1;
      REACT.idleT0 = now;
      REACT.idleAt = now + 4200 + Math.random() * 5200;
    }
    if (REACT.idleKind && now - REACT.idleT0 > (SPONT[REACT.idleKind] || 0.6) * 1000) {
      REACT.idleKind = '';
    }
  }

  // 自发小动作的具体表现：被摸时用 spont*，没人碰时用 idle*（幅度 0.5，起落都是正弦，不会硬切）
  const beatKind = held ? REACT.spontKind : (AFTER.at ? '' : REACT.idleKind);
  // 她正在演的那个部位，空闲小动作不许碰。
  // 注意：claimParam 只管手势那一族（touch/gesture），姿态层和词表层是直接写参数的，
  // 所以这里要自己查层里还有没有活着的占用 —— 否则「歪头 30」时再加 1.4，虽然看不出来，
  // 但会悄悄改掉她演的数值，时间一长就对不上了。
  const layerBusy = (id) => {
    for (const name of ['pose', 'manual', 'expression']) {
      const m = layerParams.get(name);
      const e = m && m.get(id);
      if (e && (e.until === Infinity || e.until > now)) return true;
    }
    return false;
  };
  const BEAT_IDS = {
    tilt: ['ParamAngleZ', 'ParamAngleX'],
    shiver: ['ParamBodyAngleZ'],
    pout: ['ParamMouthForm'],
    brow: ['ParamBrowLY', 'ParamBrowRY'],
  };
  const beatIds = BEAT_IDS[beatKind] || null;
  if (beatKind && beatIds && beatIds.some(layerBusy)) {
    beatRefused++;
    if (held) REACT.spontKind = ''; else REACT.idleKind = '';
  }
  if (beatKind) {
    const dur = SPONT[beatKind] || 0.6;
    const t0 = held ? REACT.spontT0 : REACT.idleT0;
    const dir = held ? REACT.spontDir : REACT.idleDir;
    const bk = held ? 1 : 0.5;
    const st = (now - t0) / 1000;
    if (st > dur) {
      if (held) REACT.spontKind = ''; else REACT.idleKind = '';
    } else {
      const e = Math.sin(Math.PI * (st / dur)) * bk;   // 起落都有，不会硬切
      if (beatKind === 'tilt') {
        extra.push(['ParamAngleZ', dir * 2.8 * e]);
        extra.push(['ParamAngleX', -dir * 1.2 * e]);
      } else if (beatKind === 'pout') {
        formT += 0.30 * e;
      } else if (beatKind === 'shiver') {
        extra.push(['ParamBodyAngleZ', Math.sin(st * 38) * 1.1 * e]);
      } else if (beatKind === 'peek') {
        eyeT = Math.max(eyeT, 0.95 * e);
      } else if (beatKind === 'brow') {
        // 眉毛抬一下：想事情、被问到、有点意外，都是这个动作
        extra.push(['ParamBrowLY', 0.34 * e]);
        extra.push(['ParamBrowRY', 0.34 * e]);
        extra.push(['BrowInnerUp', 0.18 * e]);
      } else if (beatKind === 'blink') {
        // 多眨一下：比引擎那次更实，用快起快落的三角包络（0.42s 内闭→开）
        const p = st / dur;
        const dip = p < 0.32 ? p / 0.32 : Math.max(0, 1 - (p - 0.32) / 0.4);
        eyeT = Math.min(eyeT, 1 - 0.92 * dip * bk);
      }
    }
  }

  // 二阶弹簧（和活体层同一组参数：略欠阻尼 → 到位时轻微过冲再稳住）
  const K = 150, C = 15.5;
  const step = (x, v, tgt) => {
    const nv = v + ((tgt - x) * K - v * C) * dt;
    return [x + nv * dt, nv];
  };
  let st1;
  st1 = step(REACT.eye, REACT.vEye, eyeT); REACT.eye = st1[0]; REACT.vEye = st1[1];
  st1 = step(REACT.smile, REACT.vSmile, smileT); REACT.smile = st1[0]; REACT.vSmile = st1[1];
  st1 = step(REACT.form, REACT.vForm, formT); REACT.form = st1[0]; REACT.vForm = st1[1];
  st1 = step(REACT.open, REACT.vOpen, openT); REACT.open = st1[0]; REACT.vOpen = st1[1];
  // 腮红单独一根慢弹簧：真人脸红是慢慢泛上来、慢慢退的，用眼睛那根（0.15s）会像开关
  {
    const KB = 26, CB = 7.2;
    const nv = REACT.vBlush + ((blushT - REACT.blush) * KB - REACT.vBlush * CB) * dt;
    REACT.blush = Math.max(0, Math.min(1, REACT.blush + nv * dt));
    REACT.vBlush = nv;
  }
  REACT.state = state;

  // 谁在写这一批参数：
  //   被摸 / 收场 → gesture(4)，要盖过姿态层（不然她演的眯眼会把摸脸表情顶掉）
  //   没人碰 → idlebeat(2.5)，只排在情绪(2)之上、姿态(3)之下：
  //            小动作看得见，但永远不会盖掉她正在演的那张脸
  const ADD_OWNER = (held || AFTER.at) ? 'gesture' : 'idlebeat';
  const add = (id, d) => {
    if (!d) return;
    const ok = claimParam(id, ADD_OWNER);
    if (ADD_OWNER === 'idlebeat') { if (ok) beatWrites++; else beatRefused++; }
    if (!ok) return;
    try { core.setParameterValueById(id, (Number(core.getParameterValueById(id)) || 0) + d); } catch (e) { /* ignore */ }
  };
  // 眼睛写「增量」：1 = 常态，0 = 全闭。用增量而不是绝对值，眨眼和表情想要的眯眼才不会被顶掉。
  const eyeDelta = Math.max(-1.25, Math.min(0.35, REACT.eye - 1));
  add('ParamEyeLOpen', eyeDelta);
  add('ParamEyeROpen', eyeDelta * 0.96);       // 右眼略小一点，不然像镜像贴图
  add('EyeSmile', Math.max(0, REACT.smile));
  add('ParamMouthForm', REACT.form);
  add('ParamMouthOpenY', Math.max(0, REACT.open));
  // 腮红：key7 是这层皮的腮红参数（全 509 参数扫出来唯一一个能把脸颊 R-G 拉高 +2.85 的），
  // 之前我按「整块包围盒平均」量它、被稀释成噪声底，误判成死通道，还把它从手势里删了。
  add('key7', REACT.blush);
  for (let i = 0; i < extra.length; i++) add(extra[i][0], extra[i][1]);
  // 记下这一帧真正写进去的值（帧末会被 loadParameters 回滚，所以只能写的时候顺手记）
  try { REACT.wrote = +(Number(core.getParameterValueById('ParamEyeLOpen')) || 0).toFixed(2); } catch (e) { REACT.wrote = null; }
}

// 排障用：看她此刻的「小动作」状态（摸脸时是 spont*，没人碰时是 idle*）。
// 用法：无头页里 setInterval 轮询，确认拍子真的在跑、也能看出下一拍还有多久。
window.__acting = () => ({
  state: REACT.state,
  held: !!leanPress.down,
  spont: REACT.spontKind,
  idle: REACT.idleKind,
  idleIn: Math.max(0, Math.round(REACT.idleAt - Date.now())),
  blush: +REACT.blush.toFixed(3),
  eye: +REACT.eye.toFixed(3),
  form: +REACT.form.toFixed(3),
  writes: REACT.wrote,
  beatWrites,
  beatRefused,
});
// 排障用：立刻触发一次指定的小动作（不受随机节拍影响），用来验证冲突让位
window.__beat = (kind) => {
  REACT.idleKind = String(kind || 'tilt');
  REACT.idleT0 = Date.now();
  REACT.idleDir = 1;
  return REACT.idleKind;
};
// 混合表情的排障口：不真的摆，只把「这个名字会被算成什么参数」算出来给她/我看。
window.__exprMix = (name) => {
  const mix = resolveExpressionMix(name);
  if (!mix) return { mixed: false, resolved: resolveEmotion(name) };
  return { mixed: true, label: mix.label, names: mix.names, pulse: mix.pulse, params: mix.params };
};

// ── G2：说话时那张脸也跟着说话 ────────────────────────────────────────────────
// 以前她开口只有嘴在动：眼睛、眉毛、头一动不动，看起来像「一张立绘在配音」。
// 这里只做**加法**——音量包络推着眼神、眉毛、头部小幅起伏，姿态层和表情层写下的值原样保留：
// 她要是正演着「委屈」的脸，脸上只会多一点「说话时的起伏」，不会换脸。
// 优先级 2.6：比待机小动作(2.5)明显一点，但摸脸(5)、手势(4)在场时整帧让位。
let spEnv = 0;        // 包络 0..1（快起慢落）
let spPeak = 0;       // 上一帧的包络（用来抓「重音起拍」）
let spDir = 1;        // 这一句往哪边歪头（开口时才换，不能每帧换）
let spNod = 0;        // 当前点头余量
let spNodAt = 0;      // 上一次点头的时刻
let spBrowAsym = 0;   // 这一句里两只眉毛的高低差（-0.4..0.4，开口时随机）
let spWas = false;    // 上一帧是不是在说话
let spWrites = 0;     // 排障：这一项写过多少帧
function applySpeechFace() {
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  const now = performance.now();
  // talkingUntil 存的是 Date.now() 的 epoch 毫秒，跟这里的 performance.now() 不是一个钟。
  // 用错钟的后果不是「早停」而是「永不停止」：performance.now() 永远小于 epoch 毫秒，
  // 所以第一句之后 talk 一直是 true，说话层永久以 2.6 抢写，待机小动作被压死。
  const wall = Date.now();
  const talk = wall < talkingUntil;
  if (!talk && !spWas && spEnv === 0 && spNod < 0.01) return;

  // 有真音频就跟着音量走；纯字幕（没声音）也得动，否则她打字说话时脸是死的
  const v = Math.max(0, Math.min(1, voiceLevel()));
  let target = 0;
  if (talk) {
    target = v > 0.015
      ? Math.min(1, 0.16 + v * 1.7)
      : 0.34 + 0.26 * Math.sin(now / 270 + spDir * 1.1);   // 假节拍：慢一点的呼吸式起伏
  }
  if (talk && !spWas) {
    spDir = Math.random() < 0.5 ? -1 : 1;                    // 新的一句，换一边
    spBrowAsym = (Math.random() * 0.8 - 0.4);                 // 两只眉毛不完全一样高
  }
  spEnv += (target - spEnv) * (target > spEnv ? 0.24 : 0.07);

  // 重音起拍：包络从低处顶上去，给一下很轻的点头（700ms 内最多一次）
  if (spEnv - spPeak > 0.02 && spEnv > 0.5 && now - spNodAt > 700) { spNod = 1; spNodAt = now; }
  spPeak = spEnv;
  spNod *= 0.9;

  const laugh = Math.max(0, Math.min(1, (spEnv - 0.72) / 0.28));   // 音量很满=像在笑，眼睛收一点
  // 她正演着的地方（姿态/词表/表情层还占着）不硬加：眼睛只保留「笑到眯」那点收，眉毛减半。
  const busy = (id) => {
    for (const name of ['pose', 'manual', 'expression']) {
      const m = layerParams.get(name);
      const e = m && m.get(id);
      if (e && (e.until === Infinity || e.until > performance.now())) return true;
    }
    return false;
  };
  const addS = (id, d) => {
    if (!d) return;
    if (!claimParam(id, 'speechexpr')) return;
    try {
      core.setParameterValueById(id, (Number(core.getParameterValueById(id)) || 0) + d);
      spWrites++;
    } catch (e) { /* ignore */ }
  };
  const eyeUp = busy('ParamEyeLOpen') ? 0 : 0.18 * spEnv;
  const eyeUpR = busy('ParamEyeROpen') ? 0 : 0.17 * spEnv;
  addS('ParamEyeLOpen', eyeUp - (busy('ParamEyeLOpen') ? 0.16 : 0.3) * laugh);
  addS('ParamEyeROpen', eyeUpR - (busy('ParamEyeROpen') ? 0.16 : 0.3) * laugh);
  const browK = busy('ParamBrowLY') ? 0.5 : 1;
  // 两只眉毛不完全一样高：一句里有一边抬得多一点，像在掂量话怎么说
  addS('ParamBrowLY', 0.20 * spEnv * browK * (1 + spBrowAsym));
  addS('ParamBrowRY', 0.20 * spEnv * browK * (1 - spBrowAsym));
  addS('ParamAngleZ', 1.7 * spEnv * spDir);
  addS('ParamBodyAngleZ', 1.2 * spEnv * spDir);
  addS('ParamAngleY', -2.6 * spNod);          // 点头：往下压一点，回弹靠 0.9 的衰减

  if (!talk && spEnv < 0.004) spEnv = 0;
  spWas = talk;
}
window.__speech = () => ({
  // talkingUntil 是 Date.now() 的 epoch 毫秒，这里必须用同一个钟。
  // 以前用 performance.now() 比，结果第一句之后 talk 永远是 true（见 probe-talk-clock.mjs）。
  talking: Date.now() < talkingUntil,
  env: +spEnv.toFixed(3),
  dir: spDir,
  nod: +spNod.toFixed(3),
  writes: spWrites,
});

// ─────────────────────────────────────────────────────────────────────────────
// 脊髓（中钟）S0+S1+S2
//
// 三层时钟：
//   慢钟 1–3 秒  云端：她说什么、什么情绪、叫哪个动作
//   中钟 5–20Hz  这里：把「外面发生了什么」变成 200–600ms 的小动作
//   快钟 60Hz    渲染：参数插值、物理、弹簧
//
// 以前缺的就是中间这层：云端下完命令，1–3 秒真空里她的脸只能靠「随机抽一个待机动作」，
// 于是看久了像一只会呼吸的立绘。脊髓只做一件事——让动作对着他发生。
//
// 边界：只写白名单里的二十来个参数、TTL 200–600ms 不续、遇到姿态/词表/表情/摸脸层占着就让位。
// 不碰台词、不碰情绪语义、不碰记忆。
// ─────────────────────────────────────────────────────────────────────────────

// 【2026-11-23 默认关】这一层上线一天的真实数据：`fired: {msg-look: 5}`、refused 39，
// 而她同一时间自己调工具 202 次。问题不在幅度（调过三轮），在**层**：它写的是 2–9 度的
// 微动作，和呼吸/重心/眨眼同量级，看不见；调到能看见就要压过她的 pose/word，就变成抽搐。
// 所以默认 0。想试就 localStorage.setItem('body.spine','1') 或 ?spine=1（代码都留着）。
const SPINE_ON_DEFAULT = false;
const SPINE = (() => {
  let on = SPINE_ON_DEFAULT;
  try { on = localStorage.getItem('body.spine') === '1'; } catch (e) { /* 隐私模式 */ }
  const q = QT.get('spine');
  if (q === '0') on = false;
  else if (q === '1') on = true;
  return { on, tickAt: 0, last: '', writes: 0, refused: 0, fired: Object.create(null), ticks: 0 };
})();

// 白名单：只允许碰这些。头和身的角度只给很小的量（±6 度内），大动作归 pose。
const SPINE_IDS = {
  ParamEyeBallX: 1, ParamEyeBallY: 1,
  ParamBrowLY: 1, ParamBrowRY: 1, ParamBrowLAngle: 1, ParamBrowRAngle: 1, ParamBrowLForm: 1, ParamBrowRForm: 1,
  ParamMouthForm: 1, ParamMouthOpenY: 1,
  ParamAngleX: 1, ParamAngleY: 1, ParamAngleZ: 1,
  ParamBodyAngleX: 1, ParamBodyAngleY: 1, ParamBodyAngleZ: 1, ParamBodyAngleRX: 1,
  CheeksWiggleY: 1,
};
// 待发的增量：id → { v, until, id(规则名) }
const SPINE_INTENT = new Map();
// 每条规则的冷却时间戳
const SPINE_COOL = new Map();

function spineCool(rule, ms, wall) {
  const at = SPINE_COOL.get(rule) || 0;
  if (wall - at < ms) return false;
  SPINE_COOL.set(rule, wall);
  return true;
}

// 让位：她自己摆的姿态 / 词表写入 / 整张表情 占着的参数，脊髓不去碰
function spineBusy(id, wall) {
  for (const name of ['pose', 'manual', 'expression']) {
    const m = layerParams.get(name);
    const e = m && m.get(id);
    if (e && (e.until === Infinity || e.until > wall)) return true;
  }
  return false;
}

function spinePulse(map, ms, rule) {
  if (!SPINE.on) return 0;
  const until = Date.now() + Math.max(120, Math.min(1600, Number(ms) || 400));
  let n = 0;
  for (const id in map) {
    if (!SPINE_IDS[id]) continue;
    // 【同一参数不许叠】两拍同时压同一个参数会各写各的底值 → 画面来回跳，看着就是抽搐。
    if (SPINE_INTENT.has(id)) continue;
    const v = Number(map[id]);
    if (!v) continue;
    SPINE_INTENT.set(id, { v, until, rule: rule || '' });
    n++;
  }
  return n;
}

// 每帧把还没到期的增量写上去（加法：不覆盖 saccade/物理已经算好的底）
function spineApply(wall) {
  if (!SPINE_INTENT.size) return;
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  for (const [id, it] of SPINE_INTENT) {
    if (wall > it.until) { SPINE_INTENT.delete(id); continue; }
    if (spineBusy(id, wall)) { SPINE.refused++; SPINE_INTENT.delete(id); continue; }
    if (!claimParam(id, 'spinal')) { SPINE.refused++; SPINE_INTENT.delete(id); continue; }
    try {
      // 【别用 cur + v 叠】——上一帧写进去的值可能还在（saveParameters/loadParameters 的时机决定了
      // 有时会留到下帧），那样就成了自己叠自己：2v、3v… 一路撞到 ±30 的夹紧值，再和物理互顶 →
      // 头疯狂抽搐（2026-11-22 用户报「现在会抽搐」就是这个）。
      // 正解：这一拍开始时记下「底值」it.base，之后每帧都写 base + v，无论上帧有没有留底都稳定。
      if (it.base === undefined) it.base = Number(core.getParameterValueById(id)) || 0;
      core.setParameterValueById(id, it.base + it.v);
      SPINE.writes++;
    } catch (e) { /* ignore */ }
  }
}

// ── S1 感觉总线 ───────────────────────────────────────────────────────────────
// 20Hz、最近 5 秒。只留摘要，不存原始事件，避免长跑吃内存。
const SENSE_MAX = 100;
const SENSE = {
  frames: [],
  last: 0,
  dropped: 0,
  hero: { msgAt: 0, msgCount: 0, typingAt: 0, typing: false, silenceAt: 0 },
};

// 云端的「他做了什么」从插件推过来：POST /cmd {type:'feel', kind:'msg'|'typing'|'silence'}
function feelEvent(kind, at) {
  const t = Number(at) || Date.now();
  const k = String(kind || '');
  if (k === 'msg') {
    SENSE.hero.msgAt = t;
    SENSE.hero.msgCount++;
    SENSE.hero.typing = false;
    // 事件播放器：他发来一条 → 放「抬眼看他」（SPINE 关着也照放）
    try { window.__eventAnimPlay && window.__eventAnimPlay('msg', t); } catch (e) { }
  } else if (k === 'typing') {
    SENSE.hero.typingAt = t;
    SENSE.hero.typing = true;
  } else if (k === 'silence' || k === 'stop') {
    SENSE.hero.silenceAt = t;
    SENSE.hero.typing = false;
  } else {
    return false;
  }
  return true;
}

function senseFrame(wall) {
  const talk = wall < talkingUntil;
  const touchAge = lastTouch ? wall - lastTouch.at : -1;
  const msgAge = SENSE.hero.msgAt ? wall - SENSE.hero.msgAt : -1;
  const typingAge = SENSE.hero.typingAt ? wall - SENSE.hero.typingAt : -1;
  const pointerIdle = lastMouseAt ? wall - lastMouseAt : -1;
  return {
    t: wall,
    talk,
    spEnv: +spEnv.toFixed(2),
    touchAge: (touchAge < 0 || touchAge > 12000) ? -1 : Math.round(touchAge),
    zone: (lastTouch && touchAge < 4000) ? String(lastTouch.zone || '') : '',
    pointerIdle: pointerIdle < 0 ? -1 : Math.round(pointerIdle),
    msgAge,
    typing: !!SENSE.hero.typing && typingAge >= 0 && typingAge < 5000,
    typingAge,
    v: +(Number(lastEmotion.v) || 0).toFixed(2),
    a: +(Number(lastEmotion.a) || 0).toFixed(2),
    busy: {
      pose: !!(layerParams.get('pose') && layerParams.get('pose').size),
      manual: !!(layerParams.get('manual') && layerParams.get('manual').size),
      expression: !!(layerParams.get('expression') && layerParams.get('expression').size),
    },
  };
}

function senseLast(n) {
  const k = Math.max(1, Math.min(SENSE_MAX, Number(n) || 1));
  return SENSE.frames.slice(-k);
}

window.__sense = () => ({
  on: SPINE.on,
  dropped: SENSE.dropped,
  frames: SENSE.frames.length,
  hero: { ...SENSE.hero, msgAge: SENSE.hero.msgAt ? Date.now() - SENSE.hero.msgAt : -1 },
  last: SENSE.frames.length ? SENSE.frames[SENSE.frames.length - 1] : null,
  recent: senseLast(6),
});

// ── S2 规则 ───────────────────────────────────────────────────────────────────
// 八条里能拿到数据的六条（typing 需要云端给，QQ 客户端基本拿不到，先留接口）：
function spineRules(f, wall) {
  const hour = new Date(wall).getHours();
  const night = hour >= 0 && hour < 5;
  const amp = night ? 0.7 : 1;           // ⑦ 深夜整体小一号
  let fired = '';

  // ① 他刚发来（400ms 内）：先抬眼看他一眼，再交给后面的动作
  //    【为什么要这么大】这套皮的 ParamAngleY 推 25 度才 5% 像素变化，眼睛又被焦点控制器按着；
  //    真正看得见的是 ParamBodyAngleY（实测 15.4%）和眉毛。最初 0.22/2.2 度版本肉眼零变化，
  //    第二版 9 度用户仍说「不明显」→ 现在给 14 度 + 两拍（先抬头→再歪一下），并加长到 ~1 秒。
  if (f.msgAge >= 0 && f.msgAge < 400 && spineCool('msgLook', 1200, wall)) {
    if (spinePulse({
      ParamBodyAngleY: 14 * amp, ParamAngleY: 5.5 * amp, ParamBrowLY: 0.5, ParamBrowRY: 0.5,
      ParamEyeBallY: 0.3 * amp
    }, 1100, 'msgLook')) fired = 'msg-look';
  }

  // ② 他在打字（>800ms）：视线垂到输入框那边、嘴闭一点（拿不到 typing 就永远不触发）
  if (f.typing && f.typingAge > 800 && spineCool('typingWatch', 1200, wall)) {
    if (spinePulse({ ParamEyeBallX: -0.32 * amp, ParamBodyAngleY: -2.5 * amp, ParamMouthForm: 0.12 }, 700, 'typing')) fired = 'typing-watch';
  }

  // ⑥ 鼠标停在那里：**交给渲染器自带的焦点控制器**，脊髓不再插手。
  //    原来这里每 1.5 秒补一次头偏，和焦点控制器抢同一批角度 → 头抖（2026-11-22 用户报「抽搐」）。
  //    鼠标跟随本来就已经有了，脊髓的重心是「事件反应」，不是持续跟随。

  // ③ 他 2 分钟没说话：头慢慢偏、视线漂（走神，但不是死机）
  if (f.msgAge > 120000 && !f.talk && spineCool('drift', 4200, wall)) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    if (spinePulse({ ParamEyeBallX: dir * 0.26 * amp, ParamAngleZ: dir * 2.2 * amp, ParamBodyAngleY: (Math.random() - 0.5) * 2.4 * amp }, 900, 'drift')) fired = 'drift';
  }

  // ⑤ 被摸过 300–900ms：余震一下（收肩 + 眼睛收一点），像「还被那只手按着」
  //    ParamBodyAngleX 只有 7%，收肩要写 ParamBodyAngleRX（18.4%）
  if (f.touchAge >= 300 && f.touchAge <= 900 && spineCool('touchAftershock', 1400, wall)) {
    if (spinePulse({ ParamBodyAngleRX: -3.4, ParamBodyAngleY: -1.6, ParamMouthForm: 0.1 }, 520, 'touch')) fired = 'touch-aftershock';
  }

  // ⑧ 他 5 分钟没理她、心情也低：沉肩 + 头低下去（跟心情挂钩，不是固定剧本）
  if (f.msgAge > 300000 && f.v < -0.2 && !f.talk && spineCool('slump', 12000, wall)) {
    if (spinePulse({ ParamBodyAngleRX: -4 * amp, ParamBodyAngleY: -6 * amp, ParamBrowLY: -0.28, ParamBrowRY: -0.28, ParamEyeBallY: -0.2 * amp }, 1100, 'slump')) fired = 'slump';
  }

  return fired;
}

// ④ 她刚说完（talk 由 true → false）：三段收尾——吸气、视线回收、眉松
let spineTalkWas = false;
let spineEndAt = 0;
function spineAfterTalk(wall) {
  if (spineTalkWas && !(wall < talkingUntil)) {
    spineEndAt = wall;
    // 「说完」要看得出来：先松一口气（头往下坠一点、肩落），再把视线收回来，最后眉放开。
    // 三拍都按可见阈值给（ParamBodyAngleY 是全皮最活的通道之一，15.4%）。
    spinePulse({ ParamBodyAngleY: -9, ParamAngleY: -4, ParamBodyAngleZ: -2.5 }, 400, 'end1');   // 0.4s：松一口气
    setTimeout(() => spinePulse({ ParamBodyAngleY: -5, ParamAngleY: -5, ParamMouthForm: -0.1 }, 700, 'end2'), 420); // 1.1s：视线收回
    setTimeout(() => spinePulse({ ParamBrowLY: -0.32, ParamBrowRY: -0.32, ParamAngleZ: -2 }, 1300, 'end3'), 900);  // 2.2s：眉松开
    SPINE.last = 'talk-end';
    // 事件播放器：这里放的是你编好的「收尾」动作（和上面那三拍参数无关，SPINE 关着也照放）
    try { window.__eventAnimPlay && window.__eventAnimPlay('talkend', wall); } catch (e) { }
  }
  spineTalkWas = wall < talkingUntil;
}

function spinalTick(nowWall) {
  const wall = Number(nowWall) || Date.now();
  spineApply(wall);                       // 先把上一拍还没到期的增量写上去（每帧都写）
  // 「说完了」这件事要先算：事件播放器不看 SPINE.on，它有自己的开关（EVENT_ANIM.on）
  spineAfterTalk(wall);
  // 感觉总线：**永远采集**，和脊髓开关无关。
  // 脊髓只决定「要不要根据它动」；采集停了的话 __sense() 就是空的，事件播放器也拿不到
  // msgAge 这类上下文，排查时还得先开脊髓——2026-11-23 解耦。
  if (wall - SENSE.last < 50) return;     // 中钟：20Hz
  SENSE.last = wall;
  const f = senseFrame(wall);
  SENSE.frames.push(f);
  if (SENSE.frames.length > SENSE_MAX) { SENSE.frames.shift(); SENSE.dropped++; }
  if (!SPINE.on) return;

  SPINE.ticks++;
  const fired = spineRules(f, wall);
  if (fired) { SPINE.last = fired; SPINE.fired[fired] = (SPINE.fired[fired] || 0) + 1; }
}

function setSpine(on, quiet) {
  SPINE.on = !!on;
  if (!SPINE.on) { SPINE_INTENT.clear(); SPINE.last = ''; }
  try { localStorage.setItem('body.spine', SPINE.on ? '1' : '0'); } catch (e) { /* ignore */ }
  if (!quiet) hud('脊髓：' + (SPINE.on ? '开（她会对着你动）' : '关（退回随机待机）'));
  return SPINE.on;
}

window.__spine = () => ({
  on: SPINE.on,
  ticks: SPINE.ticks,
  writes: SPINE.writes,
  refused: SPINE.refused,
  last: SPINE.last,
  fired: { ...SPINE.fired },
  intents: SPINE_INTENT.size,
  sense: SENSE.frames.length,
});
window.__setSpine = (v) => setSpine(v);
window.__feel = (kind, at) => feelEvent(kind, at);
// 排障：读一帧里参数的实际值（判断「写了但被覆盖」还是「根本没写到」）
// 用法：__params(['ParamBodyAngleY','ParamBrowLY']) → { ParamBodyAngleY: 3.2, ... }
window.__params = (ids) => {
  try {
    const c = model.internalModel.coreModel;
    const out = {};
    for (const id of (Array.isArray(ids) ? ids : [ids])) out[id] = +Number(c.getParameterValueById(id)).toFixed(3);
    return out;
  } catch (e) { return { err: String(e && e.message || e) }; }
};
// 排障：看「混合之后实际写出去的值」（含保持期微漂移）。
// 参数回读永远读到 0（帧末 loadParameters 会回滚），要看真实输出只能看这里。
window.__mixNow = (ids) => {
  const list = Array.isArray(ids) ? ids : [...lastMix.keys()];
  const out = {};
  for (const id of list) out[id] = lastMix.has(id) ? +Number(lastMix.get(id)).toFixed(3) : null;
  return out;
};
// 排障：加法层（呼吸/跟随/微表情/说话起伏）这一帧各加了多少。和 __mixNow 相加才是最终值。
window.__addNow = (ids) => {
  const list = Array.isArray(ids) ? ids : [...lastAdd.keys()];
  const out = {};
  for (const id of list) out[id] = lastAdd.has(id) ? +Number(lastAdd.get(id)).toFixed(3) : 0;
  return out;
};
// 排障：当前镜头推近了多少（0.14 = 推近 14%）。word 的 zoom 和 pose 的 zoom 共用这个数。
window.__zoomNow = () => ({
  zoom: +Number(poseZoom || 0).toFixed(3),
  target: +Number(poseZoomTarget || 0).toFixed(3),
  until: poseZoomUntil || 0,
});

// ── 时间轴动画（试播台里编的）──────────────────────────────────────────────
// 数据形状：{ name, duration(ms), loop, tracks: [{ id, e:'smooth|linear|in|out',
//            keys: [{ t(ms), v, e? }] }] }
// 和姿态的区别：姿态是「到目标 → 停 → 回」，这里是逐帧说「此刻这个参数应该是多少」，
// 所以它自己就是权威，写入用绝对值，走 anim 层（prio 3.2）。
const ANIM = { active: false, name: '', data: null, t0: 0, err: 0, plays: 0, writes: 0, event: false, idle: false, lastWrite: {} };
const ANIM_EASE = {
  linear: (x) => x,
  in: (x) => x * x,
  out: (x) => 1 - (1 - x) * (1 - x),
  smooth: (x) => x * x * (3 - 2 * x),
};
function animClip(track, t) {
  const keys = track.keys || [];
  if (!keys.length) return null;
  if (t <= keys[0].t) return Number(keys[0].v) || 0;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.t) {
      const span = Math.max(1, Number(b.t) - Number(a.t));
      const x = Math.min(1, Math.max(0, (t - Number(a.t)) / span));
      const ez = ANIM_EASE[b.e || a.e || track.e || 'smooth'] || ANIM_EASE.smooth;
      const av = Number(a.v) || 0, bv = Number(b.v) || 0;
      return av + (bv - av) * ez(x);
    }
  }
  return Number(keys[keys.length - 1].v) || 0;
}
function animStop(reason) {
  if (!ANIM.active) return;
  ANIM.active = false;
  ANIM.override = false;
  ANIM.event = false;
  ANIM.idle = false;
  hud('动作结束' + (reason ? '：' + reason : ''));
}
function animTick(wall) {
  if (!ANIM.active || !ANIM.data) return;
  // 保险丝：**待机组**的动作只在没人管的时候放。
  // 一旦她开始说话（talkingUntil）或他刚发来消息（heardUntil），这一帧就收手。
  // 注意只针对 `idle:true` 的：事件播放器的「抬眼看他」正是他发消息那一刻触发的，不能被这条误杀。
  if (ANIM.idle && Date.now() < Math.max(talkingUntil, heardUntil)) {
    animStop('她/他要说话了');
    return;
  }
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  const dur = Math.max(100, Number(ANIM.data.duration) || 2000);
  let t = wall - ANIM.t0;
  if (t >= dur) {
    if (ANIM.data.loop) { ANIM.t0 = wall; t = 0; } else { animStop(ANIM.name); return; }
  }
  if (typeof touchHeld === 'function' && touchHeld()) return;   // 手按着的时候别抢
  const w = {};
  for (const tr of (ANIM.data.tracks || [])) {
    const id = String(tr.id || '');
    if (!id) continue;
    const v = animClip(tr, t);
    if (v === null) continue;
    if (!claimParam(id, 'anim')) continue;
    try {
      let val = v;
      const info = PARAM_INFO.get(id);
      if (info && Number.isFinite(info.min) && Number.isFinite(info.max)) {
        val = Math.min(info.max, Math.max(info.min, val));
      }
      core.setParameterValueById(id, val);
      ANIM.writes++;
      w[id] = +Number(val).toFixed(3);
    } catch (e) { /* 参数不存在就算了 */ }
  }
  ANIM.lastWrite = w;
}
window.__playAnim = async (name, opt = {}) => {
  try {
    const r = await fetch('/anims/' + encodeURIComponent(String(name)) + '.json', { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: '没有这个动作：' + name };
    const data = await r.json();
    if (opt.loop !== undefined) data.loop = !!opt.loop;
    ANIM.data = data;
    ANIM.name = String(name);
    ANIM.t0 = Date.now();
    ANIM.active = true;
    ANIM.override = !!opt.override;    // true = 它是「顶替内置姿态」放出来的
    ANIM.event = !!opt.event;          // true = 事件播放器放的（她一动手就该让位）
    ANIM.idle = !!opt.idle;            // true = 待机组自己抽的（他说话/她说话时立刻收手）
    ANIM.plays++;
    hud(opt.idle ? ('待机：' + name) : ('动作：' + name + '（' + (Number(data.duration || 0) / 1000).toFixed(1) + ' 秒）'));
    // 待机组自己抽的不进「她动过什么」——不然她会把待机动作当成自己刚做的，
    // 提示词里会冒出一堆「你刚才自己做过：动作 待机·半转身」。
    if (!opt.idle && typeof window.__logMove === 'function') window.__logMove('动作 ' + name, '她调的');
    return { ok: true, name, duration: data.duration, tracks: (data.tracks || []).length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};
window.__stopAnim = () => { animStop('手动'); return { ok: true }; };
// 编辑器预览用：直接把内存里的轨道丢进来播，不用先存盘（草稿也能看）
window.__playAnimData = (data) => {
  try {
    if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return { ok: false, error: '没有轨道' };
    ANIM.data = {
      name: data.name || '（草稿）',
      duration: Math.max(100, Number(data.duration) || 2000),
      loop: !!data.loop,
      tracks: data.tracks,
    };
    ANIM.name = ANIM.data.name;
    ANIM.t0 = Date.now();
    ANIM.active = true;
    ANIM.plays++;
    hud('预览：' + ANIM.name + '（' + (ANIM.data.duration / 1000).toFixed(1) + ' 秒）');
    return { ok: true, tracks: ANIM.data.tracks.length, duration: ANIM.data.duration };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
};
window.__animInfo = () => ({
  active: ANIM.active, name: ANIM.name, plays: ANIM.plays, writes: ANIM.writes, err: ANIM.err,
  duration: ANIM.data ? ANIM.data.duration : 0,
  loop: !!(ANIM.data && ANIM.data.loop),
  elapsed: ANIM.active ? Date.now() - ANIM.t0 : 0,
  tracks: ANIM.data ? (ANIM.data.tracks || []).length : 0,
  override: !!ANIM.override, event: !!ANIM.event, idle: !!ANIM.idle,
});
// 排障：动作层这一帧把每个参数写成了多少（__mixNow 看不到动作层，它只记层混合的写入）
window.__animNow = () => ({
  active: ANIM.active, name: ANIM.name,
  t: ANIM.active ? Date.now() - ANIM.t0 : 0,
  v: { ...ANIM.lastWrite },
});

// ---- 同名覆盖：自己编的动作顶掉内置姿态 -------------------------------
// 规则：anims/<名字>.json 存在，且名字与某个姿态（或它的别名）完全一样 →
// `pose 歪头` 放的是你那盘带子，不是 POSES 里那组参数。
// 判定只用一份名字清单（每 30 秒刷一次），真正播放时才去取 JSON。
const ANIM_OVERRIDE = { on: true, names: new Set() };
async function refreshAnimLib() {
  try {
    const r = await fetch('/anims', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const next = new Set(((j && j.list) || []).map((a) => String(a.name)));
    ANIM_OVERRIDE.names = next;
    // 库里以「待机」开头的动作自动进待机组（她/你自己编的事件动作不会混进来）
    if (typeof window.__syncIdleNames === 'function') window.__syncIdleNames([...next]);
  } catch (e) { /* 服务端没这接口就当没有覆盖 */ }
}
window.__animLib = () => ({ on: ANIM_OVERRIDE.on, names: [...ANIM_OVERRIDE.names] });
window.__animRefresh = () => refreshAnimLib();
window.__animOverride = (on) => {
  ANIM_OVERRIDE.on = on !== false;
  return { on: ANIM_OVERRIDE.on, names: [...ANIM_OVERRIDE.names] };
};
// applyPose 在另一个块作用域里，够不着上面这些名字，只能走这两个口子。
window.__overrideName = (key) => (ANIM_OVERRIDE.on && ANIM_OVERRIDE.names.has(String(key)) ? String(key) : '');
window.__stopOverride = () => { if (ANIM.override) animStop('被别的姿态打断'); };
refreshAnimLib();
setInterval(refreshAnimLib, 5000);   // 5 秒足够：存完最多 5 秒她就能用上

// ── ⑤ 待机动作组：拿 anims/ 里编好的循环片段当「待机组」 ─────────────────────
// 专业做法（VTube Studio 那套）：待机不是一个姿态，是几段 loop 片段按权重随机轮换。
// 比「每 4–9 秒抽一个姿态」自然，因为片段本身带过程（in→loop→out），而且能轮换。
// 库还空着的时候这段完全不生效（names 为空 → on=false）。
// 11-25 夜（用户：待机动画播得太频繁）：原来 9–22 秒就来一段、段长 6–16 秒，
// 加上「段完了立刻换下一段」，长时间看下来几乎一直在动。改成：
//   一次 4–10 秒，两次之间隔 45–120 秒，而且到点还有 35% 概率「这次就不动了」——
//   人待着的时候大部分时间是静的，偶尔才动一下，这样才像在发呆而不是在表演。
// 待机组：他不在的时候，她自己抽一段小动作演。
// 2026-11-27：明明在聊天，待机动画还在放 —— 因为 heardUntil 只有 18 秒，
// 他想想再回一句，中间的空档就被当成了「没人」。
// 现在：必须安静 IDLE_QUIET_MS 才开机，开机后也降频（2–5 分钟一段）。
const IDLE_QUIET_MS = 180000;   // 3 分钟没人说话，才允许第一段
const IDLE_GROUP = {
  on: false, names: [], cur: '', nextAt: 0, plays: 0, skips: 0,
  quietMs: IDLE_QUIET_MS,
  minGap: 120000, maxGap: 300000, lenMin: 4000, lenMax: 9000, skipP: 0.3,
};
// 排障用：临时改节奏（不写死，方便测「频率」这种时间尺度很长的东西）
window.__idleTune = (o = {}) => {
  for (const k of ['minGap', 'maxGap', 'lenMin', 'lenMax']) {
    const v = Number(o[k]);
    if (Number.isFinite(v) && v >= 0) IDLE_GROUP[k] = v;
  }
  if (Number.isFinite(Number(o.skipP))) IDLE_GROUP.skipP = Math.max(0, Math.min(1, Number(o.skipP)));
  if (Number.isFinite(Number(o.quietMs)) && Number(o.quietMs) >= 0) IDLE_GROUP.quietMs = Number(o.quietMs);
  IDLE_GROUP.nextAt = 0;
  return { ...IDLE_GROUP, names: IDLE_GROUP.names.slice() };
};
window.__idleAnims = (list) => {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,，\s]+/);
  IDLE_GROUP.names = arr.map((s) => String(s || '').trim()).filter(Boolean);
  IDLE_GROUP.on = IDLE_GROUP.names.length > 0;
  IDLE_GROUP.manual = true;      // 手动设过就不再被库自动覆盖
  IDLE_GROUP.nextAt = 0;
  return { on: IDLE_GROUP.on, names: IDLE_GROUP.names.slice() };
};
// 库一变就把「待机」开头的动作同步进待机组（否则待机组永远是空的）
// 注意：这个函数每 5 秒会被刷新器叫一次，名单没变时**不能**重置 nextAt，
// 否则待机永远等不到（倒计时每 5 秒被推回去一次 —— 实测过一次，一直不播）。
window.__syncIdleNames = (names) => {
  if (IDLE_GROUP.manual) return { on: IDLE_GROUP.on, names: IDLE_GROUP.names.slice(), manual: true };
  const idle = (Array.isArray(names) ? names : []).filter((n) => /^待机/.test(String(n)));
  const key = idle.join('|');
  if (key !== IDLE_GROUP.key) {
    IDLE_GROUP.key = key;
    IDLE_GROUP.names = idle;
    IDLE_GROUP.on = idle.length > 0;
    IDLE_GROUP.nextAt = 0;
  }
  return { on: IDLE_GROUP.on, names: IDLE_GROUP.names.slice() };
};
window.__idleGroup = () => ({
  on: IDLE_GROUP.on, names: IDLE_GROUP.names.slice(), cur: IDLE_GROUP.cur,
  plays: IDLE_GROUP.plays, skips: IDLE_GROUP.skips,
  gap: [IDLE_GROUP.minGap, IDLE_GROUP.maxGap], len: [IDLE_GROUP.lenMin, IDLE_GROUP.lenMax],
  skipP: IDLE_GROUP.skipP,
  nextIn: IDLE_GROUP.nextAt ? Math.max(0, IDLE_GROUP.nextAt - Date.now()) : 0,
  talkIn: Math.max(0, talkingUntil - Date.now()), heardIn: Math.max(0, heardUntil - Date.now()),
  quietMs: IDLE_GROUP.quietMs,
  quietIn: Math.max(0, (IDLE_GROUP.quietMs || IDLE_QUIET_MS) - (Date.now() - (lastTalkAt || 0))),
});
function idleGroupTick(wall) {
  if (!IDLE_GROUP.on || !IDLE_GROUP.names.length) return;
  // 有人在说话 / 他刚发来消息 / 正在放动作 / 刚被她叫过 —— 都不打扰
  if (wall < talkingUntil) return;
  if (Date.now() < heardUntil) return;
  // 只在「这么久没人跟她说过话、她也没说过话」时才开工。
  // 聊天中途他多想一会儿，不该被当成走人。
  const quiet = Date.now() - (lastTalkAt || 0);
  if (quiet < (IDLE_GROUP.quietMs || IDLE_QUIET_MS)) {
    IDLE_GROUP.nextAt = 0;
    return;
  }
  if (ANIM.active) return;
  const lastAct = Number((window.__vary || {}).lastAt) || 0;
  if (lastAct && wall - lastAct < 4500) return;
  if (!IDLE_GROUP.nextAt) {
    // 刚满安静门槛：几秒后就来一段，别让他干等两分钟。
    IDLE_GROUP.nextAt = wall + 3000 + Math.random() * 12000;
    return;
  }
  if (wall < IDLE_GROUP.nextAt) return;
  // 到点了也可能「这次不动」：35% 概率直接重新排队，不播。
  // 少了这个，节奏再长也会显得「规律得像定时器」。
  if (Math.random() < IDLE_GROUP.skipP) {
    IDLE_GROUP.skips += 1;
    IDLE_GROUP.nextAt = wall + IDLE_GROUP.minGap + Math.random() * (IDLE_GROUP.maxGap - IDLE_GROUP.minGap);
    return;
  }
  const name = IDLE_GROUP.names[(Math.random() * IDLE_GROUP.names.length) | 0];
  IDLE_GROUP.cur = name;
  IDLE_GROUP.plays += 1;
  IDLE_GROUP.nextAt = wall + IDLE_GROUP.minGap + Math.random() * (IDLE_GROUP.maxGap - IDLE_GROUP.minGap);
  const len = IDLE_GROUP.lenMin + Math.random() * (IDLE_GROUP.lenMax - IDLE_GROUP.lenMin);
  if (typeof window.__playAnim === 'function') {
    window.__playAnim(name, { loop: true, event: true, idle: true }).then((r) => {
      if (!r || !r.ok) return;
      // 一段待机动作必须有明确的结束点。以前这里到点是「接着播下一段」，
      // 而下一段没有再排定时器 —— 结果 loop 一直转，ANIM.active 永远为真，
      // 待机组再也排不进新的一段，表现成「要么不动、要么一动就停不下来」。
      setTimeout(() => {
        if (ANIM.active && ANIM.name === name && ANIM.idle) animStop('待机到点了');
      }, len);
    }).catch(() => { });
  }
}
window.__idleTick = idleGroupTick;


// ---- 事件播放器（脊髓 B 方案）--------------------------------------------
// 上一版「脊髓」是自己往参数里偷偷加 2–9 度，看不见，还和她的动作抢同一批参数。
// 这一版换个做法：**事件到了就放一段你编好的动作**（anims/<名字>.json），不再碰参数。
//
//   msg      他发来一条        → 抬眼看他
//   talkend  她刚说完一段       → 收尾（垂眼/抿嘴/吐气）
//   touchend 手离开            → 余韵
//
// 默认关。开：window.__eventAnim({ on:true })，或者 localStorage 'body.event'='1'。
// 映射可改：window.__eventAnim({ map:{ msg:'抬眼看他', talkend:'说完收尾' } })。
// 她会为这个动作让位：她自己调 pose/word/face 时，正在播的事件动作立刻停（见 __eventYield）。
const EVENT_ANIM = {
  on: false,
  map: { msg: '', talkend: '', touchend: '' },   // 留空 = 这个事件不做（先由你在时间轴里编好再填名字）
  last: '', at: 0, plays: 0, misses: 0, skipped: 0, yielded: 0,
};
try {
  if (localStorage.getItem('body.event') === '1') EVENT_ANIM.on = true;
  const rawMap = localStorage.getItem('body.event.map');
  if (rawMap) {
    const m = JSON.parse(rawMap);
    if (m && typeof m === 'object') for (const k of Object.keys(EVENT_ANIM.map)) if (m[k]) EVENT_ANIM.map[k] = String(m[k]);
  }
} catch (e) { /* 隐私模式 / 坏 JSON 都用默认值 */ }

function eventAnimPlay(kind, at) {
  const k = String(kind || '');
  if (!EVENT_ANIM.on) return { ok: false, skipped: 'off' };
  if (!(k in EVENT_ANIM.map)) return { ok: false, skipped: 'unknown-event' };
  const name = String(EVENT_ANIM.map[k] || '');
  if (!name) { EVENT_ANIM.skipped++; return { ok: false, skipped: 'no-mapping' }; }
  const t = Number(at) || Date.now();
  if (t - EVENT_ANIM.at < 500) { EVENT_ANIM.skipped++; return { ok: false, skipped: 'debounce' }; }
  // 上一个事件动作还没起来（400ms 内）就别叠，叠起来就是抢参数
  if (ANIM.active && ANIM.event && Date.now() - ANIM.t0 < 400) {
    EVENT_ANIM.skipped++;
    return { ok: false, skipped: 'busy' };
  }
  EVENT_ANIM.at = t;
  EVENT_ANIM.last = k + '→' + name;
  EVENT_ANIM.plays++;
  window.__playAnim(name, { event: true }).then((r) => {
    if (!r || !r.ok) {
      EVENT_ANIM.misses++;
      hud('事件动作没起来：' + name + '（先在时间轴里存一个同名动作）');
    } else {
      hud('事件：' + k + ' → ' + name);
    }
  }).catch(() => { EVENT_ANIM.misses++; });
  return { ok: true, event: k, name };
}

// 她一动，事件动作让位（不然她这轮的姿态会被压在下面 1 秒）
function eventAnimYield() {
  if (!ANIM.active || !ANIM.event) return false;
  EVENT_ANIM.yielded++;
  animStop('她自己动了');
  return true;
}

window.__eventAnim = (opt) => {
  if (opt && typeof opt === 'object') {
    if ('on' in opt) EVENT_ANIM.on = !!opt.on;
    if (opt.map && typeof opt.map === 'object') {
      for (const k of Object.keys(EVENT_ANIM.map)) if (k in opt.map) EVENT_ANIM.map[k] = String(opt.map[k] || '');
    }
    try { localStorage.setItem('body.event', EVENT_ANIM.on ? '1' : '0'); } catch (e) { }
    try { localStorage.setItem('body.event.map', JSON.stringify(EVENT_ANIM.map)); } catch (e) { }
  }
  return window.__eventState();
};
window.__eventState = () => ({
  on: EVENT_ANIM.on,
  map: { ...EVENT_ANIM.map },
  last: EVENT_ANIM.last,
  plays: EVENT_ANIM.plays,
  misses: EVENT_ANIM.misses,
  skipped: EVENT_ANIM.skipped,
  yielded: EVENT_ANIM.yielded,
  active: ANIM.active && ANIM.event ? ANIM.name : '',
});
// 事件来自别的块作用域（feelEvent / leanEnd），走 window 口子
window.__eventAnimPlay = (kind, at) => { try { return eventAnimPlay(kind, at); } catch (e) { return { ok: false, error: String(e) }; } };
window.__eventYield = () => { try { return eventAnimYield(); } catch (e) { return false; } };


// 以前是「抽回 → 回正 → 小动作」，干净是干净，但松手就走，没有情绪。
// 现在三段全是舍不得：① 手走了她还赖在原地，脸往手的方向再送一点（0~0.55s）；
// ② 这才慢慢睁开眼，头跟着抬起来看她离开的方向（0.55~1.45s）；③ 轻轻晃两下才回正（1.45~2.4s）。
// 脸（眼睛/嘴）由 applyActing 统一管，这里只管头、身子和余韵——同一参数只能有一个主人。
function applyAftercare() {
  if (!AFTER.at) return;
  const core = model?.internalModel?.coreModel;
  if (!core) return;
  const now = Date.now();
  const rt = (now - AFTER.at) / 1000;
  if (rt > AFTER.dur) { AFTER.at = 0; AFTER.zone = ''; return; }
  const add = (id, d) => {
    if (!d || !claimParam(id, 'gesture')) return;
    try { core.setParameterValueById(id, (Number(core.getParameterValueById(id)) || 0) + d); } catch (e) { /* ignore */ }
  };
  if (rt < 0.55) {
    // ① 还赖在手上：脸往手那边再贴一点，身子跟着前倾一点点，然后才慢慢松
    const e = 1 - rt / 0.55;
    add('ParamAngleX', AFTER.x * 3.0 * e);
    add('ParamAngleY', AFTER.y * 2.6 * e);
    add('ParamAngleZ', AFTER.x * 1.8 * e);
    add('ParamBodyAngleY', AFTER.y * 1.2 * e);
    add('ParamBodyAngleX', AFTER.x * 1.6 * e);
  }
  if (rt >= 0.55 && rt < 1.45) {
    // ② 睁眼那一下：头轻轻抬起来，像目送那只手
    const p = (rt - 0.55) / 0.9;
    const e = Math.sin(p * Math.PI);
    add('ParamAngleY', 2.4 * e);
    add('ParamBodyAngleY', 0.9 * e);
    add('ParamAngleX', AFTER.x * 1.2 * e);
  }
  if (rt >= 1.45) {
    // ③ 晃两下回正（阻尼正弦，越晃越小，不是一刀切回中立）
    const p = Math.min(1, (rt - 1.45) / Math.max(0.1, AFTER.dur - 1.45));
    const env = (1 - p) * Math.sin(p * Math.PI) + 0;
    const ph = (rt - 1.45) * Math.PI * 2 * 1.7;
    add('ParamAngleZ', Math.sin(ph) * 2.6 * env);
    add('ParamBodyAngleZ', Math.sin(ph - 0.5) * 1.2 * env);
    add('ParamAngleX', Math.sin(ph * 0.62) * 1.4 * env);
  }
  try { AFTER.wrote = +(Number(core.getParameterValueById('ParamEyeLOpen')) || 0).toFixed(2); } catch (e) { AFTER.wrote = null; }
}

// 调试：现在是什么状态、手速多少、眼睛/嘴写进去多少
window.__act = () => ({
  on: REACT.on,
  state: REACT.state,
  beats: REACT.state,
  hv: +REACT.hv.toFixed(4),
  stillMs: REACT.stillAt ? Date.now() - REACT.stillAt : -1,
  spont: REACT.spontKind,
  eye: +REACT.eye.toFixed(3), smile: +REACT.smile.toFixed(3),
  form: +REACT.form.toFixed(3), open: +REACT.open.toFixed(3),
  wrote: REACT.wrote,
  after: AFTER.at ? +((Date.now() - AFTER.at) / 1000).toFixed(2) : -1,
  afZone: AFTER.zone,
  afWrote: AFTER.wrote,
});

function applyWaves() {
  const core = model?.internalModel?.coreModel;
  if (!core || !channelWaves.size) return;
  const tms = performance.now();
  // 【动作争用】以前每条波形直接写绝对值（base + sin），谁后写谁赢：
  //   ① 两条波形碰同一个参数就互相盖（歪头在用 ParamAngleZ，晃腰也在用）；
  //   ② 波形排在 flushWrites() 之后写，姿态层辛苦算出来的同 id 值被整条抹掉，
  //      表现出来就是「摆好姿势又突然被甩回中立位」。
  // 现在先按 id 累加增量（Δ），最后只写一次 cur + Δ：波形之间可叠加，姿态层也不会被抹掉。
  const deltas = new Map();
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
      // 尾巴六节越靠后越甩，看着像真的摆过去；
      // 但腰腹这种链条要**各自指定幅度和相位**（胯先动、上身晚半拍），所以 amp/phase 可以是对象
      const amp = (w.amp && typeof w.amp === 'object')
        ? (Number(w.amp[id]) || 0)
        : w.amp * (ids.length > 1 ? 0.5 + i * 0.14 : 1);
      const phase = (w.phase && typeof w.phase === 'object')
        ? (Number(w.phase[id]) || 0)
        : -i * 0.45;
      const d = env * amp * physSwing * Math.sin(2 * Math.PI * w.hz * p + phase);
      deltas.set(id, (deltas.get(id) || 0) + d);
    }
  }
  for (const [id, d] of deltas) {
    if (!d) continue;
    try {
      const cur = Number(core.getParameterValueById(id)) || 0;
      core.setParameterValueById(id, cur + d);
    } catch (e) { /* ignore */ }
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
        // 物理推迟求值：d=已接管，r=累计自己算过的帧数（每帧应 +1，约等于 fps）
        phys: `${window.__physDeferred ? 'd' : '-'}${window.__physRuns || 0}`,
        // 她刚被人摸过没有：zone:秒数（心跳里带着，云端拼成一句话进提示词）
        touch: lastTouch ? `${lastTouch.zone}:${Math.round((Date.now() - lastTouch.at) / 1000)}` : '',
        // 现在还挂着的模型自带动画（exp3，比如圈圈眼）；空 = 没挂
        mexpr: modelExprActive,
        word: lastWord,                       // 最近一次词表命中（排障：她说了什么、我拆成了哪几个词）
        // 上面那个词是什么时候给的。word 本身只有复位才清，可词表动作大多 1.5–4 秒就收，
        // 云端不按时间降级就会一直谎报「她现在摆着 XXX」。
        wordAt: lastWordAt,
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
        wordAt: lastWordAt,
        // 脊髓这一层在干什么（云端 /state 里能看：开没开、tick 过几次、真写进去几次、被更高层让位几次）
        // 这一层只在页面里活，不落她的账本，所以只能靠心跳上报
        spine: {
          on: SPINE.on ? 1 : 0,
          ticks: SPINE.ticks,
          writes: SPINE.writes,
          refused: SPINE.refused,
          err: SPINE.err || 0,
          last: SPINE.last || '',
          fired: { ...SPINE.fired }
        },
        // 现在放着哪段自己编的动作（时间轴编辑器存下来的），没放就是空
        anim: ANIM.active ? ANIM.name : '',
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
        moves: MOVE_LOG.slice(-5).map((m) => [Math.max(0, Math.round((Date.now() - m.t) / 1000)), m.what, m.src]),
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
  baseScale = s;
  model.scale.set(s * (1 + leanZoom));
  model.anchor.set(0.5, 0.5);
  // 放大时往上抬一点，免得脚被窗口底边切掉
  baseY = h / 2 + h * 0.02 + (userScale - 1) * h * 0.18;   // 放大时把镜头往下压：头/胸留在画面中间
  baseX = w / 2;
  model.position.set(baseX, baseY);
  updateShadow();
}

// 脚下一层软阴影：别小看它，2D 模型有没有「落地感」一大半靠这个。
// 位置跟着模型包围盒的底边，宽度按身宽，浓度由手感面板的「阴影」控制。
let shadowGfx = null;
function updateShadow() {
  if (!app || !model) return;
  const want = Number(TUNE.shadow) || 0;
  if (!shadowGfx) {
    shadowGfx = new PIXI.Graphics();
    app.stage.addChildAt(shadowGfx, 0);
  }
  shadowGfx.clear();
  if (want <= 0.01) { shadowGfx.visible = false; return; }
  shadowGfx.visible = true;
  let b;
  try { b = model.getBounds(); } catch (e) { return; }
  if (!b || !b.width) return;
  const cx = b.x + b.width * 0.5;
  const cy = b.y + b.height * 0.985;
  const rx = b.width * 0.30;
  const ry = Math.max(6, b.height * 0.016);
  for (let i = 6; i >= 1; i--) {
    const k = i / 6;
    shadowGfx.beginFill(0x0a1020, 0.055 * want * (1 - k * 0.5));
    shadowGfx.drawEllipse(cx, cy, rx * (1 + k * 0.5), ry * (1 + k * 0.35));
    shadowGfx.endFill();
  }
}

// 大小：0.5 小一号 … 1 刚好 … 1.5 怼脸。记得住，下次开窗还是这么大
function setScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) { hud(`现在是 ${userScale.toFixed(2)} 倍`); return false; }
  userScale = Math.max(0.4, Math.min(2.6, n));
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
  // 事件动作让位：她的词表动作优先级低于 anim 层，不收掉就会被压住
  if (typeof window.__eventYield === 'function') window.__eventYield();
  const entry = LEXICON.words[key] || {};
  // 同 applyPhrase：不传时长就活 10 秒，别永久糊在脸上（显式 -1 才常驻）
  const hraw = Number(holdMs);
  const keep = Number.isFinite(hraw) ? (hraw < 0 ? 0 : hraw) : PHRASE_DEFAULT_MS;
  let scale = 1;
  for (const [mod, k] of Object.entries(LEXICON.modifiers || {})) {
    if (String(text || '').includes(mod)) { scale = Number(k) || 1; break; }
  }
  let did = false;
  if (entry.emotion) {
    did = applyEmotion({ v: (Number(entry.emotion.v) || 0) * scale, a: (Number(entry.emotion.a) || 0) * scale, d: (Number(entry.emotion.d) || 0) * scale }, keep, key) || did;
  }
  if (entry.pose && POSES[entry.pose]) did = applyPose(entry.pose, keep) || did;
  if (entry.gesture) did = applyMotion(entry.gesture, keep) || did;
  if (entry.switch) {
    for (const s of [].concat(entry.switch)) did = applySwitch(s, true) || did;
  }
  if (entry.param) {
    // 同 applyPhrase：写之前先把她碰到的参数从别的层撤掉，免得两条缓动打架
    for (const pid of Object.keys(entry.param)) takeOverParam(pid, 3, 'manual', 2.5);
    did = setParamMap(entry.param, keep, 3, 'manual', { layer: 'manual' }) > 0 || did;
  }
  if (did) {
    lastWord = String(text || key);
    lastWordAt = Date.now();
    if (typeof window.__logMove === 'function') window.__logMove(lastWord, '她调的');
  }
  return did;
}

let lastWord = '';
// lastWord 的时间戳。心跳里的 word 永不过期（只有复位才清），而词表动作 1.5–4 秒就收完了；
// 云端靠这个判断「她现在真摆着」还是「刚才摆过」，否则那句状态会一直谎报。
let lastWordAt = 0;
let phraseExprTimer = 0;   // exp3 类词（脸红）到点自己收
let blushTimer = 0;        // 害羞表情顺便点的「脸红」道具，到点自己收
let phraseSeq = 0;         // 句子序号：起手/过冲的延时写入要确认期间没换过句子

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

// 保持期的「呼吸」：这些参数在 hold 期间允许小幅自己漂，别冻成雕像。
// 只给大关节，脸（眉/眼/嘴）一抖就成抽搐，故意不给。
const DRIFT_OF_PARAM = {
  ParamAngleX: 0.5, ParamAngleY: 0.5, ParamAngleZ: 0.7,
  ParamBodyAngleX: 0.45, ParamBodyAngleY: 0.6, ParamBodyAngleZ: 0.5,
  ParamBodyAngleRX: 0.45, ParamHipAngleZ: 0.35,
};

// 给一批「目标值」算每条该漂多少。warm = 心情的 v（越冷漂得越小）。
// 偏离中性越远，允许的漂移越大（小动作别乱晃，大姿态才看得出呼吸）。
function driftFor(map, warm) {
  const out = {};
  const k = warm < -0.3 ? 0.8 : 1;
  for (const pid of Object.keys(map || {})) {
    const dmax = DRIFT_OF_PARAM[pid];
    if (!dmax) continue;
    const v = Number(map[pid]) || 0;
    const info = PARAM_INFO.get(pid);
    const base = Number(info && info.def) || 0;
    const room = Math.min(1, Math.abs(v - base) / 14);
    out[pid] = dmax * (0.35 + 0.65 * room) * k;
  }
  return out;
}
// 姿态那条路在别的块作用域里，够不着上面的名字，只能留个窗口口子
window.__driftFor = driftFor;

// ── ③ 变化引擎（word / pose 共用） ───────────────────────────────────────────
// 同一句话连说三次，动作必须长得不一样，否则一眼就是「录好的」。
// 幅度 ±10%、时长 ±15%、左右交替（记住上一次偏哪边）；刚动过 900ms 内还有概率干脆不动。
const VARY = { amp: 0.1, dur: 0.15, skipP: 0.22, skipWinMs: 900, lastAt: 0, dir: 0, skips: 0, hits: 0 };
window.__vary = VARY;
window.__varyApply = (map, _hold, kind) => {
  if (!map) return null;
  const now = Date.now();
  // 只有「顺手做的小动作」(word) 允许跳过；她显式点的 pose 一定执行。
  if (kind !== 'pose' && now - VARY.lastAt < VARY.skipWinMs && Math.random() < VARY.skipP) {
    VARY.skips += 1;
    VARY.lastAt = now;
    return null;
  }
  VARY.hits += 1;
  VARY.lastAt = now;
  const s = 1 + (Math.random() * 2 - 1) * VARY.amp;
  // 左右交替：这次偏右，下次倾向偏左（对称轴上的动作最容易被看出「每次都一样」）
  VARY.dir = VARY.dir ? -VARY.dir : (Math.random() < 0.5 ? 1 : -1);
  const bias = 1 + VARY.dir * 0.06;
  const SYM = { ParamAngleZ: 1, ParamBodyAngleZ: 1, ParamHipAngleZ: 1, ParamAngleX: 1, ParamBodyAngleX: 1 };
  const out = {};
  for (const [id, v] of Object.entries(map)) {
    const info = PARAM_INFO.get(id);
    const base = Number(info && info.def) || 0;
    const k = SYM[id] ? s * bias : s;
    out[id] = base + (v - base) * k;
  }
  return { map: out };
};
window.__varyDur = (hold) => {
  const ms = Number(hold) || 0;
  if (ms <= 0) return ms;                    // 常驻（-1 早被换成 0）不抖
  return Math.round(Math.max(300, ms * (1 + (Math.random() * 2 - 1) * VARY.dur)));
};

// 返回 { ok, words, channels, hold, sink }
function applyPhrase(text, holdMs) {
  if (!VOCAB || !model) return null;
  const s = normPhrase(text);
  if (!s) return null;
  const ch = {};
  const used = [];
  const waves = [];
  const exprs = [];        // 有些词真身是 exp3（脸红就是），光写参数看不出来
  const chOwner = {};      // 通道 → 最后一个说起它的词序号（同一个参数被两个词写时，听后面的）
  let wordNo = 0;
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
        chOwner[c] = wordNo;
      }
      wordNo += 1;
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
  let zoomPush = 0;          // 词条里写了 zoom 的通道（前倾/凑近那种「凑过来」）
  let leanPush = 0;          // 词条里写了 lean 的通道（物理前倾：头发/裙摆被带一下）
  const applied = {};
  for (const [c, raw] of Object.entries(ch)) {
    const cdef = VOCAB.channels[c];
    if (!cdef) continue;
    const v = Math.max(-1.3, Math.min(1.3, Number(raw) || 0));
    if (!v) continue;
    applied[c] = +v.toFixed(2);
    if (cdef.zoom) zoomPush += Number(cdef.zoom) * v;
    if (cdef.lean) leanPush += Number(cdef.lean) * v;
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
  // 物理前倾（LeanInput）：pose 一直有，word 以前没有 —— 所以「前倾」在 word 里
  // 只有骨骼在动、头发和裙摆一点没被带走，看着就是「原地弯一下」。
  // 这个是物理输入（physics3.json 里有 19 个设置吃它），写进去就会被物理带起来。
  if (leanPush) {
    const leanV = clampNum(leanPush, -30, 30);
    if (leanV) map.LeanInput = leanV;
  }
  // ── 可见下限：动作小到看不见，等于没做 ──────────────────────────────────
  // 她的表达只能靠程度词（83% 的调用以「微微/轻轻/有点」开头），而程度词是个乘数。
  // 以前 0.25 一乘，低头只剩 2.5 度，跟呼吸一个量级，人眼根本看不出来。
  // 这里给「看得见才算动过」的那批通道兜一个下限，符号保持她说的方向。
  const VIS_FLOOR = {
    ParamAngleX: 4, ParamAngleY: 4, ParamAngleZ: 8,
    ParamBodyAngleX: 5, ParamBodyAngleY: 6, ParamBodyAngleZ: 5,
    ParamBodyAngleRX: 5, ParamHipAngleZ: 4,
    ParamBrowLY: 0.22, ParamBrowRY: 0.22,
    EyeSmile: 0.3, ParamEyeSmile: 0.3, CheeksWiggleY: 0.55
  };
  for (const [pid, v] of Object.entries(map)) {
    const floor = VIS_FLOOR[pid];
    if (!floor) continue;
    const info = PARAM_INFO.get(pid);
    const base = Number(info && info.def) || 0;
    const d = v - base;
    if (d && Math.abs(d) < floor) map[pid] = base + Math.sign(d) * floor;
  }
  // 时长：不传就 10 秒自己回（以前是 0 = 常驻，一句话的动作永远糊在脸上，
  //      下一次「眯眼」叠在旧的红脸+皱眉上，看着就像「说了没做」）；显式 -1 才常驻。
  // ── ③ 变化引擎：同一条指令，每次都不一样 ────────────────────────────────
  // 「按键动画」最刺眼的特征不是动作本身，是每次一模一样。这里给三个自由度：
  // 幅度 ±10%、时长 ±15%、左右交替记忆；另外「刚动过又来一条」时有概率干脆不动
  // （人不会对每句话都应一声）。全部可关（body.vary = 0）。
  let varySkipped = false;
  if ((window.__motionOn || {}).vary !== false && window.__varyApply) {
    const vr = window.__varyApply(map, 0, 'word');
    if (vr === null) varySkipped = true;
    else if (vr && vr.map) {
      for (const k of Object.keys(map)) delete map[k];
      Object.assign(map, vr.map);
    }
  }
  if (varySkipped) return null;

  const holdRaw = Number(holdMs);
  let hold = Number.isFinite(holdRaw)
    ? (holdRaw < 0 ? 0 : holdRaw)
    : (durMs !== null ? durMs : PHRASE_DEFAULT_MS);
  if ((window.__motionOn || {}).vary !== false && window.__varyDur) hold = window.__varyDur(hold);
  // ── ④ 动作排队：上一套还在演，新的不要一把盖上去 ──────────────────────────
  // 以前这里是无条件 `man.clear()`：新动作一到，旧动作瞬间消失 → 画面像被剪了一刀。
  // 现在的规则：旧条目快到期了就直接清；还在演就让它演完，新的最多晚 400ms 接上，
  // 交叉段 260ms（两条条目同时存在，靠层内权重做交叉淡化），这就是「排队交接」。
  const man = layerOf('manual');
  let overlap = 0;
  if (man && man.size) {
    const nowMs = Date.now();
    let until = 0;
    let alive = 0;
    for (const [id, e] of man) {
      const u = Number(e && e.until);
      if (!Number.isFinite(u) || u <= nowMs) { man.delete(id); continue; }
      alive += 1;
      if (u > until) until = u;
    }
    if (alive && (window.__motionOn || {}).queue !== false) {
      overlap = Math.min(400, Math.max(0, until - nowMs - 260));
    } else if (alive) {
      man.clear();
    }
  }
  // ── 节拍：一句话里有几个动作，就让它们前后错开一点，而不是四个词同时推到位 ──
  // 摸摸之所以显得活，很大一部分来自这种先后（她抬手 → 再歪头 → 才笑）。
  // 词表动作以前是一起推的，看着像被人一把掰过去。
  // 同一个参数被两个词写时，按最后一个说起它的词排时间；值仍然是加起来的那一份。
  const owner = new Map();
  for (const [c, idx] of Object.entries(chOwner)) {
    const cdef = VOCAB.channels[c];
    if (!cdef) continue;
    for (const pid of Object.keys(cdef.params || {})) {
      const prev = owner.get(pid);
      if (prev === undefined || idx > prev) owner.set(pid, idx);
    }
  }
  const groups = new Map();
  for (const [pid, v] of Object.entries(map)) {
    const idx = owner.get(pid) || 0;
    if (!groups.has(idx)) groups.set(idx, {});
    groups.get(idx)[pid] = v;
  }
  // ── 演出扩写：她给的是「意图」，怎么演是这边的事 ──────────────────────────
  // 一个 340ms 斜坡冲到目标然后冻住 4 秒，那是把台词念成拼音。
  // 真人做动作分四段：预备（反向一点点）→ 主体（带过冲）→ 保持（还在呼吸）→ 收尾（按情绪松）。
  // 强度/时长/收尾曲线都由她这一刻的心情决定（emotion 是她自己调的）。
  const moodNow = lastEmotion || { v: 0, a: 0, d: 0 };
  const energy = clampNum(moodNow.a, -1, 1);      // 激动程度
  const warmth = clampNum(moodNow.v, -1, 1);      // 心情好坏
  const antScale = 0.06 + Math.max(0, energy) * 0.08;
  const overScale = energy > 0.15 ? 1.055 : (energy < -0.15 ? 1.015 : 1.035);
  const rampMain = energy > 0.15 ? 260 : (energy < -0.15 ? 480 : 360);
  const relPow = energy > 0.15 ? 2.3 : (energy < -0.15 ? 1.35 : 1.8);
  // 保持期的呼吸幅度（参数单位）：头/身给 0.4~0.7，脸不给（脸一抖就像抽搐）
  const driftMap = driftFor(map, warmth);
  // 节拍：不是固定的 110ms —— 每次在 80–150ms 之间抖，累积到 400ms 封顶。
  // 固定间隔听起来像机械臂，人不会每次都挪同样多。
  phraseSeq += 1;
  const pSeq = phraseSeq;
  // 同参数接管：她又说了一个词，就把它碰到的这些参数从别的层里撤掉（姿态的保持、
  // 上一个词的收尾、待机节拍都算）。不撤的话两条缓动会在同一个参数上各拉各的，
  // 人眼看到的就是「抽一下」。手势/触摸/口型比 manual 高，不动它们。
  for (const pid of Object.keys(map)) takeOverParam(pid, 3, 'manual', 2.5);
  let n = 0;
  let gi = 0;
  let lag = 0;
  for (const [, sub] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (gi > 0) lag = Math.min(400, lag + 80 + Math.random() * 70);
    gi += 1;
    // 太短的动作不拆段（拆了反而碎成一堆抖动）
    if (hold < 600) {
      n += setParamMap(sub, hold, 3, 'manual', { layer: 'manual', startDelay: lag + overlap, releasePow: relPow });
      continue;
    }
    // 一次写完，不再拆「预备 / 过冲 / 归位」三段。
    // 三段式的问题：它是三次独立写入，每段都把目标重新指一遍 —— 只要中途改目标，
    // 曲线就必然出现「先朝反方向动一下再冲过去」的那一小段，人眼看到的就是「动之前抖了一下」。
    // 现在只写一次：从原值直接走到目标，缓动时长按情绪（260/360/480ms），
    // 保持期靠 drift 呼吸、收尾靠 releasePow，都在同一条条目里完成，没有中途换目标。
    n += setParamMap(sub, hold, 3, 'manual', {
      layer: 'manual', startDelay: lag + overlap, rampMs: rampMain, drift: driftMap, releasePow: relPow
    });
  }
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
  // 道具类（脸红/害羞…）：先看参数开关表。key7 这类是真参数，直写就看得见；
  // 模型自带的 exp3 只有表里没有的名字才走——实测这副皮的 exp3 通道写不进 key 参数
  // （model.expression('脸红') 返回 true、表达式也加载了，但 key7 全程是 0），
  // 走它等于什么都没画。vocab 里带 switch 的只有「脸红/害羞」，两个都在 SWITCHES 里。
  let exprOn = '';
  if (exprs.length) {
    const want = exprs[0];
    const keep = hold > 0 ? hold : (durMs || EXPR_IMPLICIT_MS);
    const keepMs = Math.max(1500, keep);
    if (SWITCHES[want]) {
      if (applySwitch(want, true)) {
        exprOn = want;
        hud(`道具：${want}`);
        if (phraseExprTimer) clearTimeout(phraseExprTimer);
        phraseExprTimer = setTimeout(() => {
          applySwitch(want, false);
          phraseExprTimer = 0;
        }, keepMs);
      }
    } else if (applyModelExpression(want)) {
      exprOn = want;
      hud(`模型动画：${want}`);
      if (phraseExprTimer) clearTimeout(phraseExprTimer);
      phraseExprTimer = setTimeout(() => {
        if (modelExprActive === want) clearModelExpression();
        phraseExprTimer = 0;
      }, keepMs);
    }
  }
  if (!n && !waves.length && !exprOn) return null;
  // ── word 也能「凑过来」：词条写了 zoom 才推镜头 ────────────────────────────
  // 以前推近只在 pose 那条路，而她 76% 的动作走 word，所以「前倾」在她嘴里只是
  // 原地低头，看着像没改过。这里跟程度词一起缩放（微微 0.55、轻轻 0.6、有点 0.75），
  // 再兜一个 0.06 的下限——0.044 这种推了等于没推。缓动和到期回收复用 poseZoom。
  if (zoomPush) {
    const zAbs = Math.max(Math.abs(zoomPush), 0.06);
    poseZoomTarget = clampNum(Math.sign(zoomPush) * Math.min(0.3, zAbs), -0.3, 0.3);
    poseZoomUntil = hold > 0 ? Date.now() + hold : 0;
  }
  lastWord = used.join('+');
  lastWordAt = Date.now();
  if (typeof window.__logMove === 'function') window.__logMove(lastWord, '她调的');
  return { ok: true, words: used, channels: applied, hold, sink: +sink.toFixed(1), n, expr: exprOn };
}

function applyExpression(name, holdMs) {
  if (!model || !name) return false;
  // 先看是不是「两种情绪混一张脸」（委屈+生气 / 委屈:0.6+生气:0.4 / 委屈60%+生气40%）
  const mix = resolveExpressionMix(name);
  // 她换脸色时，正在播的事件动作让位（事件动作里常带眼睛/眉，会盖掉新脸色）
  if (typeof window.__eventYield === 'function') window.__eventYield();
  const emo = mix ? mix.params : EMOTIONS[resolveEmotion(name)];
  const label = mix ? mix.label : String(name);
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
      lastExpr = label;
      lastExprUntil = keep > 0 ? Date.now() + keep : 0;   // 0 = 常驻
      // 记下摆表情那一刻的心情，用来判断「情绪是不是剧变了」
      exprBaseMood = { v: Number(lastEmotion.v) || 0, a: Number(lastEmotion.a) || 0, at: Date.now() };
      // 换表情的那一下轻轻点一下头/晃一下身：静态差别在 460px 窗口里太小，
      // 有「动」才抓得住眼睛（她说过「表情一帧换完看着僵」，反过来也一样——不动就看不出来）
      emotionPulseAt = performance.now();
      emotionPulseAmp = mix ? mix.pulse : (EMOTION_PULSE[resolveEmotion(name)] || 0);
      // 用户 11-25：「害羞应该加上脸红」。光靠 CheeksWiggle 那几个参数在网页尺寸下几乎看不出来，
      // 真看得见的是「脸红」这个道具（switch key7）。只在它本来没开着的时候点，
      // 并且只关我们自己点的这一次——她手动开的道具不能被这里顺手关掉。
      let blushed = false;
      const emoName = resolveEmotion(name);
      if (!mix && emoName === '害羞' && SWITCHES['脸红'] && !switchState.has('脸红')) {
        if (applySwitch('脸红', true, '表情')) {
          blushed = true;
          if (blushTimer) clearTimeout(blushTimer);
          const blushMs = Math.max(2500, Math.min(12000, keep > 0 ? keep : 8000));
          blushTimer = setTimeout(() => {
            blushTimer = 0;
            if (switchState.has('脸红')) applySwitch('脸红', false);
          }, blushMs);
        }
      }
      hud(`表情：${label}${blushed ? '，脸红' : ''}${keep > 0 ? `（${(keep / 1000).toFixed(1)} 秒后回心情）` : '（常驻）'}`);
      // 排障用：上一条脸色到底走了哪条路、有没有顺手点脸红
      window.__lastFace = { name: String(name), label, emo: emoName, blushed, keep, mix: !!mix, at: Date.now() };
      if (typeof window.__logMove === 'function') window.__logMove('脸色 ' + label, '她调的');
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

// 「委屈+生气」「委屈:0.6+生气:0.4」「委屈60%+生气40%」——两套表情按权重混成一张脸。
// 为什么需要：单一表情只能整块写一张表，可人的脸经常是「又委屈又生气」；
// 混出来的每个参数都是加权平均，所以是同一张脸上两种情绪各占一半的样子，不是两张脸叠在一起。
const MIX_SPLIT = /[+＋/、,，]/;
function resolveExpressionMix(name) {
  const raw = String(name || '').trim();
  if (!raw || !MIX_SPLIT.test(raw)) return null;
  const parts = raw.split(MIX_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const acc = {};
  let total = 0;
  let pulse = 0;
  const labels = [];
  for (const p of parts) {
    // 权重三种写法：`委屈:0.6` / `委屈:60%` / `委屈60%`；没写就是 1
    let nm = p;
    let w = 1;
    const mp = p.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*%$/);                 // 委屈60%
    const ms = p.match(/^(.+?)\s*[:：x×*]\s*(\d+(?:\.\d+)?)\s*(%?)$/);    // 委屈:0.6 / 委屈:60%
    if (mp) {
      nm = mp[1];
      w = Number(mp[2]) / 100;
    } else if (ms) {
      nm = ms[1];
      w = Number(ms[2]);
      if (ms[3] === '%' || w > 1) w /= 100;      // 60 也当 0.6，写字的人不用记规则
    }
    const key = resolveEmotion(String(nm).trim());
    const emo = EMOTIONS[key];
    if (!emo) continue;
    if (!Number.isFinite(w) || w <= 0) w = 1;
    total += w;
    pulse += (EMOTION_PULSE[key] || 0) * w;
    labels.push({ key, w });
    for (const [id, v] of Object.entries(emo)) acc[id] = (acc[id] || 0) + Number(v) * w;
  }
  if (!labels.length || total <= 0) return null;
  const params = {};
  for (const [id, sum] of Object.entries(acc)) params[id] = sum / total;
  const label = labels.map((x) => `${x.key}${Math.round((x.w / total) * 100)}%`).join('+');
  return { params, label, pulse: pulse / total, names: labels.map((x) => x.key) };
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

// ---------------------------------------------------------------- 出声（本地 TTS）
// 以前她只会「演说话」：字幕 + 正弦开合的嘴，一点声音都没有。
// 现在她自己决定某句要不要念——云端只说「这句用 soft」，body-server 在本机合成，
// wav 从页面同一个源取回来（跨源会拿不到波形），WebAudio 播出来，
// 再用 AnalyserNode 的真实音量驱动嘴，比假口型对得上得多。
const VOICE = { ctx: null, gain: null, analyser: null, data: null, src: null, until: 0, level: 0, norm: 4, failed: '' };

function voiceCtxInit() {
  if (VOICE.ctx) return VOICE.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    VOICE.ctx = new AC();
    VOICE.gain = VOICE.ctx.createGain();
    VOICE.analyser = VOICE.ctx.createAnalyser();
    VOICE.analyser.fftSize = 512;
    VOICE.data = new Uint8Array(VOICE.analyser.fftSize);
    VOICE.gain.connect(VOICE.analyser);
    VOICE.analyser.connect(VOICE.ctx.destination);
  } catch (e) {
    VOICE.ctx = null;
    return null;
  }
  return VOICE.ctx;
}

// 浏览器不许「没交互就放音」：第一次点击/按键时把这路音频真正打通。
// 只放一个 0 采样也不出声，但从此这个页面就算被授权了。
function voiceUnlock() {
  const ctx = voiceCtxInit();
  if (!ctx) return;
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  try {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  } catch (e) { /* 解锁失败下次交互再试 */ }
}
['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
  window.addEventListener(ev, voiceUnlock, { once: true, passive: true });
});

// 当前音量 → 0..1 的嘴张度。没在放音就返回 0（外面会退回正弦假口型）。
function voiceLevel() {
  if (!VOICE.analyser || !VOICE.until || performance.now() > VOICE.until) { VOICE.level = 0; return 0; }
  VOICE.analyser.getByteTimeDomainData(VOICE.data);
  let sum = 0;
  for (let i = 0; i < VOICE.data.length; i += 1) {
    const v = (VOICE.data[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / VOICE.data.length);
  // 成品语音是「峰值归一 0.89」的，平均响度 −15dBFS 上下：不换算直接乘系数会一直张到最大，
  // 所以每句先量一遍它自己有多响（VOICE.norm），再把这一刻的音量折算成嘴张度。
  const want = Math.min(1, rms * VOICE.norm);
  VOICE.level += (want - VOICE.level) * 0.5;
  return VOICE.level;
}

// 一句音频有多响：按小块取能量峰值，用它当这一句的满刻度。
// 这样换参考音色/换音量都不用重新调参数，嘴也不会整天大张着。
function peakRms(audio) {
  try {
    const d = audio.getChannelData(0);
    const block = Math.max(64, Math.floor(d.length / 300));
    let max = 0;
    for (let i = 0; i + block <= d.length; i += block) {
      let acc = 0;
      for (let j = 0; j < block; j += 4) acc += d[i + j] * d[i + j];
      const r = Math.sqrt(acc / (block / 4));
      if (r > max) max = r;
    }
    return max;
  } catch (e) { return 0; }
}

async function playVoice(url, fallbackDur, text) {
  const ctx = voiceCtxInit();
  if (!ctx) { hud('这个浏览器不支持 WebAudio，放不出声音'); return false; }
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* 交给下面报 */ } }
  if (ctx.state !== 'running') {
    // 还没被用户手势解锁：不报错（很吵），只提示一次
    if (VOICE.failed !== 'locked') {
      VOICE.failed = 'locked';
      hud('点一下页面才能出声（浏览器要求先交互一次）');
    }
    return false;
  }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.arrayBuffer();
    const audio = await new Promise((ok, bad) => ctx.decodeAudioData(raw, ok, bad));
    const peak = peakRms(audio);
    VOICE.norm = peak > 0.01 ? 1 / (peak * 1.15) : 4;
    if (VOICE.src) { try { VOICE.src.stop(); } catch (e) { /* 上一句已经放完了 */ } }
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(VOICE.gain);
    const durMs = (audio.duration || Number(fallbackDur) || 0) * 1000;
    VOICE.until = performance.now() + durMs;
    src.onended = () => {
      if (VOICE.src === src) { VOICE.src = null; VOICE.until = 0; VOICE.level = 0; }
    };
    VOICE.src = src;
    VOICE.failed = '';
    src.start();
    hud(`出声 · ${String(text || '').slice(0, 18)}（${Math.round(durMs / 100) / 10}s）`);
    return true;
  } catch (e) {
    // 放不出来也不能让场面卡住：字幕已经在了，退回假口型
    VOICE.until = 0;
    hud(`放不出声音：${(e && e.message) || e}`);
    return false;
  }
}

/**
 * 一句字幕该显示多久：按字数，每字 240ms，底 400ms，夹在 1.2–12 秒。
 * （以前是 每字 300ms、地板 6 秒、封顶 18 秒 —— 地板太高，20 字以下全被夹成 6 秒，
 *   她 71% 的消息不到 20 字，等于所有短句都显示 6 秒，下一句一来就被顶掉。）
 * 有真音频时不用这个数，直接用音频长度。
 */
function sayDurMs(n) {
  return Math.max(1200, Math.min(12000, 400 + Math.max(0, Number(n) || 0) * 240));
}

/** 把排队里的下一句放到气泡上（同一时刻只有一句在显示） */
function sayNext() {
  if (sayShowing) return;
  const it = SAY_Q.shift();
  if (!it) return;
  sayShowing = it;
  it.until = Date.now() + it.dur;
  lastSayText = it.t;
  lastSayAt = Date.now();
  SAY_RECENT.set(it.t, Date.now());
  if (SAY_RECENT.size > 60) { for (const [k, v] of SAY_RECENT) if (Date.now() - v > 60000) SAY_RECENT.delete(k); }
  try { window.dispatchEvent(new CustomEvent('fish-say', { detail: { text: it.t, proactive: it.proactive } })); } catch { /* ignore */ }
  BUBBLE.textContent = it.t;
  BUBBLE.classList.toggle('proactive', it.proactive);
  BUBBLE.classList.add('show');
  talkingUntil = it.until;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    BUBBLE.classList.remove('show');
    sayShowing = null;
    sayNext();
  }, it.dur);
  hud(`说话中 · ${it.t.length} 字（${(it.dur / 1000).toFixed(1)} 秒）`);
}

function say(text, holdMs, opts) {
  const t = String(text || '').trim();
  if (!t) return;
  lastTalkAt = Date.now();   // 她开口 = 这轮对话还活着，待机组别插队
  // 页面外壳的「对话记录」靠这个事件追加她刚说的话
  const proactive = !!(opts && opts.proactive);
  const dur = holdMs > 0 ? holdMs : sayDurMs(t.length);
  // 同一句会来两次：云端推送 + 镜像轮询、字幕 + 出声。
  // 第二次不再重放气泡、也不在对话记录里多记一条。
  // 只有带真实时长的（出声，holdMs = 音频长度）才续；
  // 纯重复（镜像补一次）不能把嘴再拖长一整句。
  const dupShown = t === lastSayText && Date.now() - lastSayAt < SAY_DEDUPE_MS;
  const dupQueued = SAY_Q.some((it) => it.t === t && Date.now() - it.addedAt < SAY_DEDUPE_MS);
  const dupRecent = Date.now() - (SAY_RECENT.get(t) || 0) < SAY_DEDUPE_MS;
  if (!proactive && (dupShown || dupQueued || dupRecent)) {
    if (holdMs > 0) {
      if (sayShowing && sayShowing.t === t) {
        // 正在显示：把气泡和嘴一起续到音频结束
        const want = Date.now() + holdMs;
        if (want > talkingUntil) talkingUntil = want;
        if (want > sayShowing.until) {
          sayShowing.until = want;
          sayShowing.dur = want - Date.now();
          if (bubbleTimer) clearTimeout(bubbleTimer);
          bubbleTimer = setTimeout(() => {
            BUBBLE.classList.remove('show');
            sayShowing = null;
            sayNext();
          }, sayShowing.dur);
        }
      } else {
        const q = SAY_Q.find((it) => it.t === t);
        if (q) q.dur = Math.max(q.dur, holdMs);
        else talkingUntil = Math.max(talkingUntil, Date.now() + holdMs);
      }
    }
    return;
  }
  SAY_Q.push({ t, dur, proactive, addedAt: Date.now(), until: 0 });
  while (SAY_Q.length > SAY_Q_MAX) SAY_Q.shift();   // 排不下就丢最旧的，别让字幕越积越晚
  sayNext();
}

/** 排障：现在气泡在放什么、后面还排着几句 */
window.__sayNow = () => ({
  showing: sayShowing ? { text: sayShowing.t, until: sayShowing.until } : null,
  queue: SAY_Q.map((it) => ({ text: it.t, dur: it.dur })),
  talkingIn: Math.max(0, talkingUntil - Date.now())
});


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

// 分层延迟（M4 阶段 4）：一个姿态同时写头、腰、肩时，让它们错开 0/90/150ms 起步。
// 整只身体同一帧一起动，看着像「整体被推了一把」；真人转头是头先走、肩腰跟着，
// 差个一百毫秒就够观众看出层次了。这里只推迟起点，终值不变。
const WRITE_DELAY = [0, 90, 150];
function delayFor(id) {
  // 头/脸/眼：立刻
  if (/^(ParamAngle|Angle|ParamEyeBall|ParamEye|LEye|REye|ParamBrow|ParamMouth|Mouth|Jaw|Cheeck|EyeSmile|BrowInnerUp)/.test(id)) return WRITE_DELAY[0];
  // 肩、袖：最后跟上
  if (/^(Shoulder|LSleeve|RSleeve)/.test(id)) return WRITE_DELAY[2];
  // 躯干、胯、腿、裙、胸：中间那一档
  if (/^(ParamBodyAngle|hip|Hip|LEG|Skirt|Chest|ParamHip)/.test(id)) return WRITE_DELAY[1];
  return 60;
}

function setParamMap(map, holdMs, prio = 2, ch = 'misc', opts = {}) {
  const now = Date.now();
  // holdMs 传 0 / 负数 / 不传 = 常驻（她说过「说了就掐，没说就一直」）。
  // 常驻用 Infinity 表示，ticker 里 remain = Infinity 永远显正，不会被当成过期删掉。
  const raw = Number(holdMs);
  const ttl = Number.isFinite(raw) && raw > 0 ? Math.max(200, Math.min(60000, raw)) : Infinity;
  const layerName = (opts.layer || ch || 'misc');
  const weight = Number.isFinite(Number(opts.weight)) ? Math.max(0, Math.min(1, Number(opts.weight))) : 1;
  // 起手延迟：一句话里有好几个动作时，让它们前后错开一点（见 applyPhrase 的「节拍」）。
  // 只推迟开始和结束，不改值——所以同一层里后写的照样覆盖先写的，行为不变。
  const lag = Math.max(0, Math.min(1200, Number(opts.startDelay) || 0));
  const store = layerOf(layerName);
  let n = 0;
  for (const [id, raw2] of Object.entries(map || {})) {
    const info = PARAM_INFO.get(id);
    if (!info) continue;                       // 模型真没有这个参数才丢
    const prev = store.get(id);
    // 同一层内：更高优先级的还活着 → 这次不抢（表情不会把「歪头」顶掉，就是靠这条）
    if (prev && prev.until > now && (prev.prio || 0) > prio) continue;
    const v = Math.max(info.min, Math.min(info.max, clampNum(raw2, 0)));   // 夹到模型范围
    // 命令路径不再加分层延迟（躯干 90ms / 肩袖 150ms 那套是为待机柔和过渡准备的，
    // 加在命令上就是「她动了、我两百毫秒后才看见」）。
    const d = writeRampMs <= 150 ? 0 : delayFor(id);
    // 续接：同一层里这个参数正在演、这次只是「改一下目标」（预备→到位→过冲→归位），
    // 就接着它原来的起点算，不要从中间值重新爬 ——
    // 否则会看到「爬到 13° → 掉回 2° → 再爬回 17°」，像抖了一下（11-24 用户报的抽搐）。
    const cont = opts.continueFrom && prev && prev.until > now;
    // 续接时把「缓动进度」也接上：新条目的起点倒推，让它此刻的 w 等于旧条目的 w。
    // 只接当前值、不接进度的话，w 会从 1 突然掉到 0.4，看着就是「到了又缩回去」。
    let startAt = now + d + lag;
    if (cont) {
      const oldRamp = Math.max(1, Number(prev.rampMs) || writeRampMs);
      const oldW = Math.max(0, Math.min(1, (now - Number(prev.start || now)) / oldRamp));
      const myRamp = Math.max(1, Number.isFinite(Number(opts.rampMs)) ? Number(opts.rampMs) : writeRampMs);
      startAt = now - oldW * myRamp;
    }
    store.set(id, {
      value: v,
      start: startAt,
      until: ttl === Infinity ? Infinity : now + ttl + d + lag,
      prio, ch, weight,
      rampMs: Number.isFinite(Number(opts.rampMs)) ? Number(opts.rampMs) : writeRampMs,
      // 保持期的微漂移幅度（参数单位）：以前 hold 期她是冻住的，4 秒一动不动像雕像。
      // 可以传一个数，也可以传 { 参数id: 幅度 } 的表（一句话里每个部位幅度不同）。
      drift: (() => {
        const dm = opts.drift;
        if (dm && typeof dm === 'object') return Math.abs(Number(dm[id]) || 0);
        return Math.abs(Number(dm) || 0);
      })(),
      // 收尾曲线：>1 = 松得快，<1 = 放得慢。由情绪决定（见 applyPhrase 的「按情绪选曲线」）
      relPow: Number(opts.releasePow) > 0 ? Number(opts.releasePow) : 1.8,
      // 续接时从「上一帧实际显示的值」接着走，避免半路改目标时跳一下；
      // 新动作也一律从"她现在的样子"出发 —— 否则会先朝中性值回一下再往目标走，
      // 比如她正低着头、下一句又让她更低，会先抬起来一点再下去（看着就是抖）。
      from: lastMix.has(id) ? Number(lastMix.get(id)) : undefined
    });
    n += 1;
  }
  if (n) { appliedSeq += 1; syncOverrides(); }
  return n;
}

// 排障用：在控制台（或 ego_js）里看每一层还剩多少参数，
// 例如 __bodyLayers() → "pose:12,expression:8"。定位「命令发出去但画面不动」时先看这个。
window.__lifeOut = () => [...lifeIds].map((id) => id + '=' + ((lifeSpring.get(id) || {}).x || 0).toFixed(2)).join(' ');
  window.__bodyLayers = () => [...layerParams].map(([k, m]) => `${k}:${m.size}`).join(',');

// ── 参数探针：给 509 个参数建「谁管哪个部位」的语义表（M4 阶段 2） ─────────────────
// 做法：冻结动画 → 记一张基准图 → 逐个参数推到极值（在 beforeModelUpdate 里写，才不会被回滚）→
//       截一张图 → 数差了多少像素、差在哪儿（横带占比 + 包围盒）→ 还原。
// 一次调用扫一段（count 个），避免单次太长被浏览器踢掉：__scanParams(0,40) → (40,40) → …
// 结果写回 window.__scanOut，最后用 __scanDump() 取 JSON。
const scan = { inited: false, ids: [], base: null, cur: null, W: 0, H: 0, out: [] };

function scanInit() {
  const im = model?.internalModel;
  const cm = im?.coreModel;
  if (!cm) return false;
  scan.cm = cm;
  scan.ids = [];
  const n = cm.getParameterCount();
  for (let i = 0; i < n; i++) {
    const id = (cm._parameterIds && cm._parameterIds[i]) || null;
    if (!id) continue;
    let min = 0, max = 0, def = 0;
    try { min = Number(cm.getParameterMinimumValue(i)); } catch (e) { /* ignore */ }
    try { max = Number(cm.getParameterMaximumValue(i)); } catch (e) { /* ignore */ }
    try { def = Number(cm.getParameterDefaultValue(i)); } catch (e) { /* ignore */ }
    // 推到离默认值更远的那一端
    const test = (max - def) >= (def - min) ? max : min;
    scan.ids.push({ id, i, min, max, def, test });
  }
  if (!scan.inited) {
    // 每帧把「当前正在测的参数」写到模型上：只有 beforeModelUpdate 里的写入才活得过 loadParameters()
    try {
      im.on('beforeModelUpdate', () => {
        if (!scan.cur) return;
        try { scan.cm.setParameterValueById(scan.cur.id, scan.cur.v); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    scan.inited = true;
  }
  return true;
}

function scanGrab() {
  const app0 = window.__app;
  const p = app0.renderer.extract.pixels(app0.stage);
  const px = (p && p.pixels) ? p.pixels : p;
  if (!scan.W) {
    const n = px.length / 4;
    scan.H = Math.round(Math.sqrt(n * 808 / 1256));
    scan.W = Math.round(n / scan.H);
  }
  return px;
}

// 基线漂移去噪：freeze 之后画面上仍有呼吸/眨眼的微小变化（实测 4~5% 像素），
// 所以每个像素只有在「基准两帧之间没变」时才算数——动的那些像素直接不算，
// 否则所有参数都会带上 ~13% 的假阳性。
function scanDiff(base, base2, cur, cur2) {
  const { W, H } = scan;
  let diff = 0, sx = 0, sy = 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const bands = [0, 0, 0, 0];   // 头 / 上身 / 裙摆 / 腿尾
  const n = Math.min(base.length, cur.length, base2 ? base2.length : base.length);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (i + 3 >= n) continue;
      const md = (p, q) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
      if (base2 && md(base, base2) > 16) continue;      // 基准自己在动的像素：不算
      if (md(base, cur) <= 16) continue;                // 这一帧没变
      if (cur2 && md(base2 || base, cur2) <= 16) continue; // 第二帧又回去了 → 瞬态（眨眼/抖动）
      if (cur2 && md(cur, cur2) > 16) continue;         // 两帧之间还在变 → 不稳
      diff++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const fy = y / H;
      if (fy < 0.42) bands[0]++; else if (fy < 0.60) bands[1]++; else if (fy < 0.78) bands[2]++; else bands[3]++;
    }
  }
  const total = Math.ceil(W / 2) * Math.ceil(H / 2);
  if (!diff) return { pct: 0, cx: 0, cy: 0, bbox: null, bands: [0, 0, 0, 0] };
  return {
    pct: +(100 * diff / total).toFixed(2),
    cx: Math.round(sx / diff), cy: Math.round(sy / diff),
    bbox: [x0, y0, x1, y1],
    bands: bands.map((b) => +(100 * b / diff).toFixed(0))
  };
}

const scanWait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

window.__scanParams = async (start, count, reset) => {
  if (!scanInit()) return { err: 'no model' };
  if (reset) { scan.base = null; scan.base2 = null; scan.out = []; }
  const slice = scan.ids.slice(start || 0, (start || 0) + (count || 40));
  if (!scan.base) {
    scan.cur = null;
    await scanWait();
    scan.base = Uint8Array.from(scanGrab());
    await scanWait();
    scan.base2 = Uint8Array.from(scanGrab());
  }
  const rows = [];
  for (const p of slice) {
    if (Math.abs(p.test - p.def) < 1e-6) { rows.push({ id: p.id, skip: 'flat' }); continue; }
    scan.cur = { id: p.id, v: p.test };
    await scanWait();
    const g = scanGrab();
    await scanWait();
    const g2 = scanGrab();
    const d = scanDiff(scan.base, scan.base2, g, g2);
    scan.cur = null;
    rows.push({ id: p.id, def: +(+p.def).toFixed(3), test: +(+p.test).toFixed(3), ...d });
  }
  await scanWait();
  for (const r of rows) {
    const old = scan.out.findIndex((x) => x.id === r.id);
    if (old >= 0) scan.out[old] = r; else scan.out.push(r);
  }
  return { start, count: slice.length, total: scan.ids.length, done: (start || 0) + slice.length, rows };
};

window.__scanDump = () => JSON.stringify({ W: scan.W, H: scan.H, total: scan.ids.length, rows: scan.out });

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

// ── 动作流水：她得知道自己这一下是谁弄的、多久以前 ──────────────────
// 以前心跳只报「现在什么姿态」，不报「怎么变成这样的」。她看不见屏幕，
// 只能靠这句把「我刚歪了下头」和「我刚被摸了一下」连起来。
const MOVE_LOG = [];
function logMove(what, src) {
  const w = String(what || '').trim().slice(0, 16);
  if (!w) return;
  const last = MOVE_LOG[MOVE_LOG.length - 1];
  if (last && last.what === w && Date.now() - last.t < 400) return; // 连发去重
  MOVE_LOG.push({ t: Date.now(), what: w, src: String(src || '').slice(0, 6) });
  if (MOVE_LOG.length > 8) MOVE_LOG.shift();
}
window.__moves = () => MOVE_LOG.slice();
// 词表/表情/道具/动画这几条路在别的块作用域里，够不着 logMove，走这个口子。
// 以前只有「被摸」和「pose」写流水，她走 word（占 88%）时心跳里的「最近动过」永远是空的。
window.__logMove = (what, src) => { try { logMove(what, src); } catch (e) { } };

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
  poseZoomTarget = 0;
  poseZoomUntil = 0;
  poseSeq += 1;          // 让还没执行的起手/过冲序列作废
  restorePhysics();
}

// 脸只有一个槽位。
// 以前「眯眼」和「瞪眼」、「嘟嘴」和「生气」能同时挂在不同层里，
// 混合后互相抢 ParamEyeLOpen / ParamMouthForm，看起来就是脸部抽搐、一半笑一半哭。
// 现在任何新的脸部动作（表情 / 眯眼 / 嘟嘴 / 吐舌头 / 词表里的眉嘴眼）都会先把旧的脸摘掉；
// 身体类（歪头、摇尾巴、举手）是另一个槽位，互不影响——「歪头 + 生气」仍然能同时成立。
// 按「通道」清槽位：头 / 身 / 脸 / 尾 各清各的。
// 以前换姿态是整层 clear()，歪头(头) 和 晃腰(身) 永远叠不起来，
// 「歪着头摇尾巴」这类组合全被吃掉。
function takeOverParam(id, prio, exceptLayer, minPrio = 0) {
  const p = Number(prio) || 0;
  const lo = Number(minPrio) || 0;
  for (const [ln, st] of layerParams) {
    if (ln === exceptLayer) continue;
    const e = st.get(id);
    if (!e) continue;
    const ep = Number(e.prio) || 0;
    // minPrio：只想接管「跟她同级或更高」的那几层，别把底层情绪一起抹掉
    if (e.until > Date.now() && ep <= p && ep >= lo) st.delete(id);
  }
}

function clearChannelSlot(ch) {  let n = 0;
  for (const m of layerParams.values()) {
    for (const [id, o] of m) {
      if (o && o.ch === ch) { m.delete(id); n += 1; }
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

function clearFaceSlot() { return clearChannelSlot('face'); }

const POSE_ALIAS = {
  '左': '看左', '左边': '看左', '看左边': '看左',
  '右': '看右', '右边': '看右', '看右边': '看右',
  '上': '看上', '抬头': '看上', '看上面': '看上',
  '下': '看下', '低头': '看下', '看下面': '看下',
  '侧头': '歪头', '头歪': '歪头',
  '尾巴': '摇尾巴', '甩尾巴': '摇尾巴', '摇尾': '摇尾巴',
  '晃身子': '晃腰', '扭一扭': '晃腰', '摇一摇': '晃腰', '左右晃': '晃腰', '晃一晃': '晃腰', '扭扭腰': '晃腰',
  '回头': '回头看你', '转头看我': '回头看你', '转身': '回头看你', '回眸': '回头看你',
  '伸懒腰': '伸懒腰', '伸展': '伸懒腰', '伸展一下': '伸懒腰', '抻一抻': '伸懒腰',
  '发抖': '发抖', '哆嗦': '发抖', '抖一下': '发抖', '打寒战': '发抖',
  '甩头发': '甩头发', '甩头': '甩头发', '甩一下头': '甩头发', '甩甩头': '甩头发',
  '舌头': '吐舌头', '吐舌': '吐舌头',
  '鼓腮': '鼓脸', '鼓腮帮子': '鼓脸', '生气': '鼓脸',
  '正常': '复位', '放下': '复位', '回来': '复位', '看镜头': '看向你',
  '看向我': '看向你', '看我': '看向你', '看着我': '看向你', '看这里': '看向你', '看过来': '看向你',
  '盯着我': '看向你', '盯着我看': '看向你', '盯着你': '看向你', '盯着': '看向你', '一直看着你': '看向你',
  '看着你的眼睛': '看向你', '看我的眼睛': '看向你',
  '看我一眼': '看向你', '对着我': '看向你',
  // 距离感与整身姿态（后来加的一组，配合 zoom 才读得出「远近」）
  '靠近': '凑近', '贴近': '凑近', '凑上去': '凑近', '靠近点': '凑近', '凑进来': '凑近',
  '躲开': '退开', '后退': '退开', '退后': '退开', '往后': '退开', '往后躲': '退开',
  '蜷起来': '缩起来', '抱紧自己': '缩起来', '缩成一团': '缩起来', '缩一下': '缩起来',
  '瘫下去': '塌下去', '软下来': '塌下去', '垮下去': '塌下去', '泄气': '塌下去',
  '转过身': '背对你', '转过去': '背对你', '别过脸': '背对你', '背过身': '背对你',
  '激灵': '一激灵', '打个激灵': '一激灵', '吓一跳': '一激灵',
  '晃头': '晃脑袋', '摇脑袋': '晃脑袋', '摇摇脑袋': '晃脑袋',
  '挺起来': '挺胸', '直起腰': '挺胸', '抬头挺胸': '挺胸',
  '伸头': '探头', '凑头': '探头', '探身': '探头'
};

// 小动作的默认时长按通道分：脸 2 秒、头 2.6 秒、身 4.2 秒、尾 3 秒。
// 以前一律 POSE_DEFAULT_MS=12 秒 —— 摆一个「歪头」要僵 12 秒，看着像被冻住。
const POSE_HOLD_DEFAULT = { head: 2600, body: 4200, face: 2000, tail: 3000 };

/**
 * 摆一个姿态。
 * @param {string} name 姿态名（人话，POSES 的键或别名）
 * @param {number} [holdMs] 保持多久；不传按通道默认；-1 = 常驻
 * @param {{scale?:number}} [opts] scale = 力度倍率 0.25~1.3（程度词走这里）
 */
function applyPose(name, holdMs, opts = {}) {
  const raw = String(name || '').trim();
  if (!raw) { hud('没给姿态名'); return false; }
  const key = POSES[raw] ? raw : (POSE_ALIAS[raw] || raw);
  // 同名覆盖：`anims/歪头.json` 存在的话，这次「歪头」放的是那盘带子，不是下面的参数配方。
  // （判定和播放都在动画那段里，这里够不着它的名字，只能走 window 上的两个口子）
  const overName = (typeof window.__overrideName === 'function') ? window.__overrideName(key) : '';
  if (overName) {
    if (typeof window.__stopOverride === 'function') window.__stopOverride();
    if (typeof window.__playAnim === 'function') {
      window.__playAnim(overName, { override: true }).then((r) => {
        if (r && r.ok) hud('姿态：' + overName + '（你自己编的版本，' + (Number(r.duration || 0) / 1000).toFixed(1) + ' 秒）');
      });
    }
    return true;
  }
  // 这次不是覆盖，那上一段覆盖就该收场了（否则循环的旧动作会一直贴着）
  if (typeof window.__stopOverride === 'function') window.__stopOverride();
  // 事件动作（他发来/说完/松手时放的短片）在她自己动手时立刻让位，别压住这一轮的姿态
  if (typeof window.__eventYield === 'function') window.__eventYield();
  const pose = POSES[key];
  // 力度：轻轻=0.55 / 有点=0.8 / 很=1.15 / 超级=1.3（调用方换算好传进来）
  const strength = Math.max(0.25, Math.min(1.3, Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : 1));
  const scaled = (v) => (typeof v === 'number' ? v * strength : v);
  const chName = (pose && (pose.ch || 'head')) || 'head';
  // 时长优先级：调用方显式给的 holdMs > 姿态条目自带的 holdMs（嘴角一抿 800ms 这种事）> 通道默认。
  // （2026-11-21 修：以前 pose 条目里的 holdMs 从来没被读过，闭嘴/开心一直按 face 默认 2000ms 挂着。）
  const poseHoldMs = (pose && Number.isFinite(Number(pose.holdMs)) && Number(pose.holdMs) > 0)
    ? Number(pose.holdMs) : 0;
  const defHold = POSE_HOLD_DEFAULT[chName] ?? POSE_DEFAULT_MS;
  const hold = Number.isFinite(Number(holdMs)) ? Number(holdMs)
    : (poseHoldMs > 0 ? poseHoldMs : defHold);
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
    // 波形的时长以 pose.wave.ms 为准，hold 只是兜底。
    // （以前写的是 `hold > 0 ? hold : wave.ms`，而 hold 按通道默认永远 >0，
    //  所以 wave.ms 从来没生效过：一激灵 340ms 的抖会按 body 默认抖满 4.2 秒 —— 狂抖；
    //  点头/摇头/摇尾巴也一直比设计的久 1.5 倍以上。调用方显式给了 holdMs 才取两者较小值。）
    const waveMs = clampNum(pose.wave.ms, 0);
    const explicitHold = Number.isFinite(Number(holdMs)) && Number(holdMs) > 0 ? Number(holdMs) : 0;
    const ms = explicitHold > 0
      ? (waveMs > 0 ? Math.min(explicitHold, waveMs) : explicitHold)
      : (waveMs > 0 ? waveMs : 1500);
    channelWaves.set(ch, {
      ch,
      ids: pose.wave.ids.slice(),
      amp: (pose.wave.amp && typeof pose.wave.amp === 'object')
        ? Object.fromEntries(Object.entries(pose.wave.amp).map(([k, v]) => [k, scaled(v)]))
        : clampNum(pose.wave.amp, 8) * strength,
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
  // 默认 12 秒：不传 holdMs 就自己回，不会一直挂着；显式 holdMs = -1 才常驻
  let ms = hold > 0 ? Math.min(60000, hold) : 0;
  // 换姿态先把上一套姿态的参数摘掉：不同姿态写的参数集不一样，
  // 不清就会层层累加（「看向你」的钉头 + 「歪头」的脖子角度 + 「缩脖」的肩膀…），
  // 人看起来就僵在一个说不清的怪姿势上，待机呼吸也压不回来。
  // 只清「同一个通道」的旧姿态：头、身、脸、尾各自独立，
  // 所以「歪着头 + 晃腰 + 眯眼」能同时挂着（以前整层 clear，全被吃掉）
  // ④ 排队：**不再让两条姿态重叠**（11-25 晚：用户报「1 秒内连发两条动作会抽搐」）。
  // 原先是「旧的继续演 + 新的延后 400ms 开始」，但两条姿态写的是同一批参数（前倾写 ParamAngleY -4，
  // 看向你又把它写回 0），只要有两份轨迹在跑，画面就是「头上去一下、又掉回来」。
  // 现在改成接管：新姿态把它碰到的参数从 pose 层里全部摘掉，从**当前屏幕上的实际值**出发，
  // 一条轨迹走到新目标 —— 只有唯一一个写者，就不会来回抽。
  let poseOverlap = 0;
  {
    const pl = layerOf('pose');
    if (pl && pl.size) {
      const nowMs = Date.now();
      for (const [id, e] of pl) {
        const u = Number(e && e.until);
        if (Number.isFinite(u) && u > nowMs + 200) { poseOverlap = 1; break; }
      }
      if (poseOverlap) {
        for (const id of Object.keys(scaledSet || {})) pl.delete(id);
        poseOverlap = 0;
      }
    }
  }
  if (!poseOverlap && lastPose.name && lastPose.name !== key) {
    clearChannelSlot(chName);
  }
  if (chName === 'face') clearFaceSlot();
  // 「看向你」这类：钉住整颗头，鼠标跟随和自发环视都不许再动它
  pinnedHead = !!pose.pin;
  const scaledSet = {};
  for (const [k, v] of Object.entries(pose.set || {})) scaledSet[k] = scaled(v);
  // ③ 变化引擎：同一个「歪头」连点三次，三次角度/时长都不一样（detail 交给 __varyApply）
  if ((window.__motionOn || {}).vary !== false && typeof window.__varyApply === 'function') {
    const vr = window.__varyApply(scaledSet, 0, 'pose');
    if (vr && vr.map) {
      for (const k of Object.keys(scaledSet)) delete scaledSet[k];
      Object.assign(scaledSet, vr.map);
    }
    if (typeof window.__varyDur === 'function') ms = window.__varyDur(ms);
  }
  // 姿态也吃「按情绪选曲线 + 保持期呼吸」那一套：
  // 以前的姿态是「斜坡到位 → 冻住 → 回弹」，中间那几秒像雕像，比不动还假。
  const poseMood = (typeof lastEmotion !== 'undefined' && lastEmotion) ? lastEmotion : { v: 0, a: 0 };
  const poseA = clampNum(poseMood.a, -1, 1);
  const poseRel = poseA > 0.15 ? 2.3 : (poseA < -0.15 ? 1.35 : 1.8);
  const poseDrift = (typeof window.__driftFor === 'function')
    ? window.__driftFor(scaledSet, clampNum(poseMood.v, -1, 1)) : undefined;
  const poseOpt = { layer: 'pose', drift: poseDrift, releasePow: poseRel };
  if (poseOverlap) poseOpt.startDelay = poseOverlap;
  poseSeq += 1;
  poseOpt.rampMs = poseA > 0.15 ? 260 : (poseA < -0.15 ? 480 : 360);
  // 接管：这些参数由这条姿态说了算，把别的层（word / 旧姿态所在通道）里同参数的旧条目摘掉，
  // 否则两份轨迹并行，画面上就是「先上去、再掉回来」的抽搐。
  for (const id of Object.keys(scaledSet)) takeOverParam(id, 3, 'pose');
  const n = setParamMap(scaledSet, ms, 3, chName, poseOpt);
  if (n) lastPose = { name: key, until: ms > 0 ? Date.now() + Math.min(60000, ms) : 0 };
  // 姿态也只写一次（理由同 applyPhrase）：三段式每段都会重新指目标，
  // 中途换目标必然在曲线上留下「先反向、再冲过去」的那一小段 —— 看起来就是抖一下。
  // 现在从原值一次走到目标，缓动时长跟着情绪走，保持期用 drift 呼吸。
  poseSeq += 1;
  const poseRamp = poseA > 0.15 ? 260 : (poseA < -0.15 ? 480 : 360);
  poseOpt.rampMs = poseRamp;
  // 姿态自带的推近/推远（前倾凑过来、退开往后退）
  poseZoomTarget = clampNum(pose.zoom, 0) * strength;
  poseZoomUntil = ms > 0 ? Date.now() + ms : 0;
  // 姿态自带的身体惯性（写物理输入 LeanInput，让头发/裙摆/尾巴自己甩出去）
  const leanV = clampNum(pose.lean, 0) * strength;
  if (leanV) setParamMap({ LeanInput: leanV }, ms, 2, chName, { layer: 'body' });
  // 低头/抬头要靠整体位移补（脸上看不出来），其它姿态不沉
  bodySinkTarget = clampNum(pose.sink, 0) * strength;
  poseSinkUntil = ms > 0 ? Date.now() + ms : 0;   // 沉下去的位移跟着姿态一起到期，别留在原地
  hud(n ? `姿态：${key}${ms > 0 ? `（${(ms / 1000).toFixed(1)} 秒）` : '（常驻）'}` : `姿态 ${key} 没有可用参数`);
  return n > 0;
}

// 验收后门：无头页面试镜时直接摆姿态，不必绕 /state 队列。
// 走的是同一个 applyPose，不改变线上行为。
try {
  window.__bodyTest = {
    pose: (name, holdMs, scale) => applyPose(name, holdMs, { scale }),
    reset: () => applyPose('复位'),
    poses: Object.keys(POSES),
    emotions: Object.keys(EMOTIONS),
    // 排障：把各层攒下的写入原样吐出来（start/until/rampMs/value），
    // 用来判断「参数到底进没进层」——截图看不出原因时看这个。
    dump: () => [...layerParams.entries()].map(([k, m]) => ({
      layer: k,
      items: [...m.entries()].map(([id, o]) => ({ id, value: o.value, prio: o.prio, rampMs: o.rampMs, start: o.start, until: o.until, drift: o.drift || 0, relPow: o.relPow || 1.8 }))
    }))
  };
  // 试播台（/playground）用：把「能做什么」一次性交出去，省得前端再手抄一份清单。
  // 清单变了这里自动跟着变，不会再出现「文档写 29 个、实际 44 个」那种事。
    // 参数的中文名：给试播台显示用（轨道标签、滑杆、画布左侧）。没收录的退回英文 id。
  // 名字尽量短（画布左边只有 56px），同一栏里放得下。
  const PARAM_CN = {
    ParamAngleX: '头左右',
    ParamAngleY: '头上下',
    ParamAngleZ: '头歪',
    ParamBodyAngleX: '身左右',
    ParamBodyAngleY: '身前倾',
    ParamBodyAngleZ: '身歪',
    ParamBodyAngleRX: '胸挺塌',
    ParamHipAngleZ: '胯歪',
    ParamHipAngleX: '胯前后',
    HipAngleZ: '胯歪旧',
    ParamEyeBallX: '眼球左右',
    ParamEyeBallY: '眼球上下',
    ParamEyeLOpen: '左眼睁',
    ParamEyeROpen: '右眼睁',
    ParamEyeSmile: '笑眼',
    ParamMouthOpenY: '张嘴',
    ParamMouthForm: '嘴角',
    ParamMouthPucker: '嘟嘴',
    ParamBrowLY: '左眉高',
    ParamBrowRY: '右眉高',
    ParamBrowLAngle: '左眉角',
    ParamBrowRAngle: '右眉角',
    ParamBrowLForm: '左眉形',
    ParamBrowRForm: '右眉形',
    ParamBrowInnerUp: '眉心',
    CheeksWiggleY: '脸颊',
    CheeksWiggleX: '腮横(死)',
    LeanInput: '前倾物理',
    key1: '黑脸',
    key2: '流泪',
    key3: '圈圈眼',
    key4: '爱心眼',
    key5: '＞＜',
    key6: '屑屑眼',
    key7: '脸红',
    key8: '加载',
    key9: '兔牙',
    key10: '钢盆',
    key11: '黑框镜',
    key12: '单片镜',
    key13: '冷汗',
    Clothes1: '裙子长短',
    Clothes2: '体型',
    Clothes3: '胸口衣',
    Clothes4: '脱鞋',
    Clothes5: '尾巴',
    Movement1: '狗尾草手',
    Movement2: '抚胸手',
    Movement3: '竖食指',
    Param_Angle_Rotation84: '尾巴1',
    Param_Angle_Rotation85: '尾巴2',
    Param_Angle_Rotation86: '尾巴3',
    Param_Angle_Rotation87: '尾巴4',
    Param_Angle_Rotation88: '尾巴5',
    Param_Angle_Rotation89: '尾巴6',
  };

window.__catalog = () => ({
    poses: Object.keys(POSES),
    aliases: POSE_ALIAS,
    emotions: Object.keys(EMOTIONS),
    exprs: (typeof MODEL_EXPRESSIONS !== 'undefined' ? MODEL_EXPRESSIONS : []).slice(),
    switches: Object.keys(SWITCHES),
    wordKeys: Object.keys((VOCAB && VOCAB.words) || {}),
    params: PARAM_INFO,
    // 试播台用：参数中文名 + 每个姿态的配方（把现成动作导入时间轴编辑器当草稿）
    labels: PARAM_CN,
    poseSet: Object.fromEntries(Object.entries(POSES).map(([k, v]) => [k, {
      ch: v.ch || '', set: v.set || null, wave: v.wave || null,
      sink: Number(v.sink) || 0, zoom: Number(v.zoom) || 0, lean: Number(v.lean) || 0,
      holdMs: Number(v.holdMs) || 0,
    }])),
    sliders: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
      'ParamBodyAngleRX', 'ParamHipAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeSmile',
      'ParamMouthOpenY', 'ParamMouthForm', 'ParamBrowLY', 'ParamBrowRY', 'CheeksWiggleY', 'LeanInput'],
  });
} catch { /* 忽略 */ }

function applySwitch(name, on, src) {
  const key = String(name || '').trim();
  // 先查参数开关表：key1..key13 这些是真的参数，写进去就生效（脸红=key7 就是这条路）。
  // 只有表里没有、但模型自带 exp3 表达式的（竖食指/裙子切换/胸口衣服…）才走表达式。
  const sw = SWITCHES[key];
  if (!sw) {
    if (MODEL_EXPRESSIONS.includes(key)) {
      if (on) {
        const ok2 = applyModelExpression(key);
        if (ok2) switchState.add(key);
        return ok2;
      }
      if (modelExprActive === key) clearModelExpression();
      switchState.delete(key);
      return true;
    }
    return false;
  }
  const onValue = sw.on === 0 ? 0 : 1;
  const value = on ? onValue : (sw.on === 0 ? 1 : 0);
  const n = setParamMap({ [sw.id]: value }, 0, 3, 'misc', { layer: 'misc' });
  if (on) switchState.add(key); else switchState.delete(key);
  if (on && typeof window.__logMove === 'function') window.__logMove('道具 ' + key, src || '她调的');
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

/**
 * 「微微歪头」→ { scale: 0.4, name: '歪头' }
 * 姿态命令里带的程度词以前直接丢掉了（只有词表那条路吃 degree），
 * 所以她说了「微微」和没说一样。这里把它剥出来当力度倍率。
 */
function splitDegree(raw) {
  const text = String(raw || '').trim();
  if (!text) return { name: '', scale: 1 };
  // 词表里程度词住在 vocab.json 的 degrees（lexicon.json 的 modifiers 是老表），两份合着用：
  // 只读 VOCAB.modifiers 的话一个都找不到（实测「微微歪头」被当成不认识的姿态名，原地不动）。
  const deg = { ...(LEXICON?.modifiers || {}), ...(VOCAB?.degrees || {}) };
  const mods = Object.keys(deg).sort((a, b) => b.length - a.length);
  for (const m of mods) {
    const v = Number(deg[m]);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (text.startsWith(m)) {
      const rest = text.slice(m.length).replace(/^[的地\s，,]+/, '').trim();
      if (rest) {
        // 「很用力地摇头」这种叠加词：剥掉一层再剥一层，倍率相乘
        const more = splitDegree(rest);
        return { name: more.name, scale: v * more.scale };
      }
    }
    const tail = text.slice(-m.length);
    if (tail === m) {
      const rest = text.slice(0, -m.length).replace(/[的地\s，,]+$/, '').trim();
      if (rest) {
        const more = splitDegree(rest);
        return { name: more.name, scale: v * more.scale };
      }
    }
  }
  return { name: text, scale: 1 };
}
window.__splitDegree = splitDegree;

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
    // expression() 返回的是 Promise（不是布尔）：以前只判 r === false，于是失败了也当成功，
    // 表情一点没画出来、心跳里却写着「模型:脸红」。这里接住结果，失败就把状态退回去并说出来。
    if (r && typeof r.then === 'function') {
      r.then((ok) => {
        if (ok === false && modelExprActive === key) {
          modelExprActive = '';
          lastExpr = '';
          hud(`模型动画没起来：${key}`);
        }
      }).catch(() => {
        if (modelExprActive === key) { modelExprActive = ''; lastExpr = ''; }
      });
    }
    return true;
  } catch { return false; }
}

// 排期批次的状态（她给动作指定时刻时用）：只留最后一批，排障用
const SCHED = { last: null };
window.__schedInfo = () => SCHED.last;

function handle(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;  lastCommandAt = Date.now();
  // 排期批次：她给动作指定了「什么时候」（当他说到某个词 / 同时 / 延后多久）。
  // 由云端 after-response 在文本定稿那一刻下发，这里只负责按 delay 准点触发。
  // 为什么不在云端 setTimeout：云端和页面之间的网络抖动会让时刻漂 50–200ms，
  // 而页面自己的钟是连续的，跟渲染同一帧，误差在一帧内。
  if (cmd.type === 'sched') {
    const items = Array.isArray(cmd.items) ? cmd.items.slice(0, 8) : [];
    let n = 0;
    for (const it of items) {
      const c = it && it.cmd;
      if (!c || typeof c.type !== 'string') continue;
      const d = Math.max(0, Math.min(30000, Number(it.d) || 0));
      n += 1;
      if (d < 40) { try { handle(c); } catch { /* 单个动作失败不影响别的 */ } }
      else setTimeout(() => { try { handle(c); } catch { /* ignore */ } }, d);
    }
    SCHED.last = { at: Date.now(), n, items: items.map((x) => ({ d: x.d, t: x.cmd && x.cmd.type, n: x.cmd && x.cmd.name })) };
    return { ok: true, scheduled: n };
  }
  // 她一动手 / 一开口，正在放的「待机动作」「事件动作」立刻让位。
  // 动作层是最后写的，不让位就会出现「她调了摇尾巴，屏幕上却是待机组那段尾巴」——
  // 13.36 写 eventAnimYield() 时忘了在入口调它，等于从没生效过（这次实测才发现）。
  if (cmd.type === 'say' || cmd.type === 'voice' || cmd.type === 'pose' || cmd.type === 'word'
    || cmd.type === 'phrase' || cmd.type === 'expression' || cmd.type === 'face'
    || cmd.type === 'switch' || cmd.type === 'emotion' || cmd.type === 'modelexpr'
    || cmd.type === 'motion' || cmd.type === 'anim') {
    try { eventAnimYield(); } catch { /* ignore */ }
  }
  if (cmd.type === 'say') {
    say(cmd.text, cmd.holdMs, { proactive: cmd.proactive === true });
    if (cmd.expression) applyExpression(cmd.expression);
    if (cmd.motion) applyMotion(cmd.motion, cmd.holdMs);
    return;
  }
  if (cmd.type === 'voice') {
    // 字幕和嘴的时值先按整段立起来，不等音频解码（解码要几十毫秒到几百毫秒）；
    // 声音到了就接着放，嘴自动切到真实音量。放不出来也只剩「有字幕没声音」。
    const durMs = Math.max(1500, Math.round((Number(cmd.dur) || 6) * 1000));
    if (cmd.text) say(cmd.text, durMs, { proactive: cmd.proactive === true });
    playVoice(cmd.url, cmd.dur, cmd.text);
    if (cmd.expression) applyExpression(cmd.expression);
    return;
  }
  // 11-25：外面（试播台 / shot-matrix）习惯写 type:'face'，而这里原来只认 'expression'，
  // 于是 `{"type":"face"}` 会被静默吞掉——我自己就被这个坑过一次。两个名字都收。
  if (cmd.type === 'expression' || cmd.type === 'face') {
    dispatch('face', cmd.name || '表情', () => applyExpression(cmd.name, cmd.holdMs));
    return;
  }
  if (cmd.type === 'motion') {
    dispatch('hands', cmd.name || '手势', () => applyMotion(cmd.name, cmd.holdMs));
    return;
  }
  if (cmd.type === 'pose') {
    logMove(cmd.name || '姿态', '她调的');
    // 程度词（微微/有点/很/非常…）可以作为力度倍率；命令里另给 strength 时相乘
    const split = splitDegree(cmd.name);
    const name = split.name || cmd.name;
    const extra = Number(cmd.strength);
    const scale = split.scale * (Number.isFinite(extra) && extra > 0 ? extra : 1);
    const ch = (POSES[name] && POSES[name].ch) || 'head';
    dispatch(ch, name || '姿态', () => applyPose(name, cmd.holdMs, { scale }));
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
    lastWordAt = 0;
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
    // 自己编的动画也要停：不然循环的动作会在「回到待机」之后继续放着
    // （anim 那段在更早的块里，这里够不着它的名字，只能走 window 上的口子）
    if (typeof window.__stopAnim === 'function') window.__stopAnim();
    hud('回到待机');
    return;
  }
  if (cmd.type === 'scene') {
    // 服务端存着的「上次的样子」：页面刷新/手机重连/服务重启之后，先把它放回去。
    // 但只恢复**能长期留着**的东西（大小、道具、体型表达式）。
    // 姿态/表情/词表动作是「此刻在演什么」，不是「她本来的样子」——
    // 以前这里连 word 一起恢复，等于每次刷新都把「眯眼+皱眉」永久钉在脸上，
    // 用户看到的就是「一刷新又是那张摸脸生气的脸」。
    const sc = cmd.scene || {};
    try {
      if (sc.scale) setScale(sc.scale);
      for (const [n, on] of Object.entries(sc.switches || {})) applySwitch(n, on !== false, '场景');
      if (sc.modelExpr) applyModelExpression(sc.modelExpr);
      else clearModelExpression();
      hud('回到待机');
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
  // 脊髓开关：1 = 她对着他动（默认）；0 = 退回随机待机
  //   注意：脊髓那段代码在一个更早的块作用域里，这里拿不到它的名字，
  //   一律走它挂到 window 上的入口（__setSpine / __feel）。以前这里直接写
  //   `setSpine(...)` / `feelEvent(...)`，运行时就是 ReferenceError。
  if (cmd.type === 'spinal') {
    if (typeof window.__setSpine === 'function') window.__setSpine(cmd.value !== false && cmd.on !== false);
    return;
  }
  // 云端的「他做了什么」：插件收到消息/知道他在打字时推过来
  //   POST /cmd {"type":"feel","kind":"msg"|"typing"|"silence","at":<epoch ms>}
  if (cmd.type === 'feel') {
    // 他刚说话 / 她马上要开口：正在放的待机动作立刻停，并且 18 秒内别再抽新的。
    // 不加这条的话，她的待机动画会跨过整轮对话一直晃（实测她回话时 anim 字段还挂着「待机·摇尾巴」）。
    if (cmd.kind === 'msg' || cmd.kind === 'typing') {
      heardUntil = Math.max(heardUntil, Date.now() + 18000);
      lastTalkAt = Date.now();   // 待机组的「安静计时」也归零
      try { eventAnimYield(); } catch { /* ignore */ }
    }
    const ok = typeof window.__feel === 'function' ? window.__feel(cmd.kind, cmd.at) : false;
    if (!ok) hud('feel：不认识 ' + String(cmd.kind || ''));
    return;
  }
  // 时间轴动画：POST /cmd {"type":"anim","name":"抬眼看你","loop":false}
  //   （试播台的编辑器存到 live2d/anims/*.json，这里按名字播）
  if (cmd.type === 'anim') {
    if (typeof window.__playAnim === 'function') {
      window.__playAnim(cmd.name, { loop: cmd.loop }).then((r) => {
        if (!r || !r.ok) hud('动作没起来：' + ((r && r.error) || '？'));
      });
    } else {
      hud('这个页面还没有动作播放器（刷新一下）');
    }
    return;
  }
  if (cmd.type === 'stopanim') {
    if (typeof window.__stopAnim === 'function') window.__stopAnim();
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
  const qs = [];
if (WS_KEY) qs.push('k=' + encodeURIComponent(WS_KEY));
// 试播台会带 ?g=<组> 打开：带 only=<组> 的命令只发给这一组的连接，不去动别的鱼
const WS_GROUP = (() => { try { return new URLSearchParams(location.search).get('g') || ''; } catch { return ''; } })();
if (WS_GROUP) qs.push('g=' + encodeURIComponent(WS_GROUP));
const q = qs.length ? '?' + qs.join('&') : '';
  hud('连接中…');
  const ws = new WebSocket(`${proto}${location.host}/ws${q}`);
  wsRef = ws;
  window.__wsClose = () => { try { ws.close(); } catch { /* ignore */ } };
  ws.addEventListener('open', () => {
    hud('已连上身体服务 · 等她动');
    retryMs = 800;
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
      // 断线期间落下的命令要补上：服务端留着她「现在的样子」，不重放的话
      // 表现为「他那边/面板显示动作了，她身体没做」，等下一句新命令才看见。
      const st = cmd.lastState || {};
      const nowMs = Date.now();
      // 还剩多久：-1 = 常驻（她自己说的「一直保持」），0 = 已经过期，不补。
      // 老版本服务端只给 at 不给 until，那种就按以前的固定窗口兜底。
      const leftOf = (until, fallbackMs) => {
        const u = Number(until);
        if (st.at === undefined) return 0;
        if (Number.isFinite(u) && u === 0) return -1;
        if (Number.isFinite(u) && u > 0) return u > nowMs ? u - nowMs : 0;
        if (Number.isFinite(u)) return 0;
        const age = nowMs - Number(st.at || 0);
        return fallbackMs && age < fallbackMs ? Math.max(200, fallbackMs - age) : 0;
      };
      // 断线/刷新回来先把旧姿势摘干净：以前一刷新就把服务端存着的旧姿态重新摆上，
      // 于是「每次刷新都是同一个表情」。现在有 until 了，过期的不补、没到期的按剩余时间补。
      clearPose();
      const poseLeft = leftOf(st.poseUntil, 12000);
      if (st.pose && poseLeft !== 0) handle({ type: 'pose', name: st.pose, holdMs: poseLeft });
      const wordLeft = leftOf(st.wordUntil, 12000);
      if (st.word && wordLeft !== 0) handle({ type: 'word', text: st.word, holdMs: wordLeft });
      const exprLeft = leftOf(st.expressionUntil, 25000);
      if (st.expression && exprLeft !== 0) handle({ type: 'expression', name: st.expression, holdMs: exprLeft });
      // 道具/换装是「一直开着」的东西，没有过期时间 —— 她戴着钢盆刷新回来，钢盆还得在
      if (st.switches && typeof st.switches === 'object') {
        for (const [nm, on] of Object.entries(st.switches)) if (on) handle({ type: 'switch', name: nm, on: true });
      }
      // 心情只补 60 秒内的：再久就不是「此刻」了，让它自己回到默认呼吸
      if (st.emotion && Number(st.emotion.at || st.at || 0) > nowMs - 60000) {
        handle({ type: 'emotion', v: st.emotion.v, a: st.emotion.a, d: st.emotion.d });
      }
      if (st.motion && st.at && nowMs - st.at < 30000) handle({ type: 'motion', name: st.motion });
      if (st.text && st.at && nowMs - st.at < 120000) say(st.text);
      return;
    }
    // 她下的命令：用短缓入（120ms）让动作「一叫就动」；待机/生命层仍用 340ms 柔和过渡。
    const fast = ['pose', 'word', 'phrase', 'expression', 'emotion', 'motion', 'switch'].includes(String(cmd?.type || ''));
    writeRampMs = fast ? CMD_RAMP_MS : 340;
    try { handle(cmd); } finally { writeRampMs = 340; }
  });  ws.addEventListener('close', (ev) => {
    if (ev && ev.code === 4001) {
      hud('钥匙不对：请用带 ?k=… 的完整链接打开');
      return;
    }
    const wait = retryMs;
    retryMs = Math.min(8000, Math.round(retryMs * 1.7));
    hud(`身体服务断了，${(wait / 1000).toFixed(1)} 秒后重连…`);
    setTimeout(connect, wait);
  });
  ws.addEventListener('error', () => { /* close 会跟着来 */ });
}

// 从后台切回来 / 网络恢复：立刻重连，不等退避计时
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!wsRef || wsRef.readyState !== 1) connect();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!wsRef || wsRef.readyState !== 1) connect();
  });
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
  // 她身上 = 摸她；空白处 = 拖窗口。两者不能同时来：
  // 以前 pointerdown 无条件 dragging=true，结果按下她的同时窗口也跟着鼠标跑，摸和拖打架。
  const overBody = (e) => {
    try { return !!(window.__onBody && window.__onBody(e.clientX, e.clientY)); } catch (err) { return false; }
  };
  const touchOn = () => {
    try { return !window.__touchFlag || !!window.__touchFlag(); } catch (err) { return true; }
  };
  let pressOnBody = false;

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pressOnBody = overBody(e);
    if (pressOnBody && touchOn()) {
      // 这一手是去摸她的，别抢窗口；光标也换成系统的小手，不画贴图
      setCursor('pointer');
      return;
    }
    dragging = true;
    dragDowns += 1;
    movedPx = 0;
    lastX = e.screenX;
    lastY = e.screenY;
    setCursor('grabbing');
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) {
      // 没在拖的时候：在她身上是小手（可以摸），空白处是抓手（可以拖窗口）
      if (e.pointerType === 'mouse') setCursor(pressOnBody ? 'pointer' : (overBody(e) ? 'pointer' : 'grab'));
      return;
    }
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
