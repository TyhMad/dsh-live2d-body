# dsh-live2d-body · 给 AI 一具真的身体

> 一个 DeepSeek Harness（DSH）插件 + 一个本地渲染服务：让聊天机器人拥有一具**可持续、可查询、可自拍**的 Live2D 身体。
>
> 不是「播一段动画」，是**参数级的身子**：509 个 Cubism 参数、25 条语义通道、7 个分层混合优先级，她能摆出词表里没有的姿势，也能回头告诉你「我现在眯着眼、尾巴翘着」。

> 本仓库不含任何角色形象或模型文件；运行起来后画面里就是你自己准备的模型。

**这是一个参考实现，不是产品。** 我把自己那台机器上跑通的东西原样整理出来，方便你照着改、或者直接抄走某一段。

- 不承诺持续维护，不保证适配你手上那套 DSH 版本；issue 我可能看不到，看到了也不一定回。
- 最有参考价值的部分在 `docs/INTERNALS.md`：9 类「参数写了却没反应」的真因（写入时序、物理覆盖、混合优先级、缓存……），比功能列表更值得看。
- 想直接用：`live2d/` + `plugins/body/` 两个目录拷进你的工程即可，README 第 2 节有六步安装。

---

## 它和「Live2D 桌宠」有什么不一样

大部分桌宠是**镜像**：AI 在想事情 → 桌面上的模型播一个「思考」动作。
这一套是**反向的**：身体是一个可以下命令、可以读状态、还会被心情持续影响的**外设**。

| 能力 | 普通桌宠 | 本插件 |
|---|---|---|
| 动作来源 | 固定动作表 / 状态映射 | 词表（60 词）→ 25 条通道 → 509 参数，词组可叠加（「有点委屈地低头 + 摇尾巴」） |
| 表情 | 播一次就回去 | 分层混合：情绪会一直当底色，表情覆盖 25 秒后自己淡回去；心情剧变时表情提前退场 |
| 状态回执 | 无 | 每次动作回一句「做了什么 + 现在什么脸」，她能转述给你 |
| 自我感知 | 无 | `op=look` 自拍当前画布 → 交给能看图的模型描述「我现在长什么样」 |
| 持久化 | 重启就没了 | 服务端 `scene.json` 保存姿态/表情/道具/大小/情绪/词表，刷新、换设备、重启都还原 |
| 多端 | 单机 | 电脑透明置顶窗口 + 手机浏览器 + 网页，同一个她（令牌鉴权、跨端同一份现场） |
| 物理 | 直接改参数（常被物理覆盖） | 波形挂在 Cubism 的 `beforeModelUpdate` 上，尾巴/头发物理照常算 |

一句话：**别的插件让模型看起来像活的，这个插件让模型真的可以被「用」。**

---

## 架构

```
QQ / 网页 / 手机
      │  工具调用：动一动身体(op=…)
      ▼
plugins/body/index.js          ← DSH 插件：翻词表、发命令、收回执
      │  HTTP POST /cmd  +  GET /state
      ▼
live2d/body-server.mjs         ← 本地/云端服务：WS 广播、现场持久化、自拍代理、心情面板
      │  WebSocket /ws
      ▼
live2d/body.js  (PIXI + pixi-live2d-display)
      │  beforeModelUpdate 钩子（物理之后、绘制之前）
      ▼
Cubism Core → 509 参数 → 你的模型
```

### 为什么参数要写在 `beforeModelUpdate`

Cubism 每帧的顺序是：

```
动作 → 表情(exp3) → 眨眼 → 视线(FocusController) → 自然动 → 物理 → beforeModelUpdate → core.update()
```

在 `app.ticker` 里写参数是**在 core.update() 之后**，下一帧物理和视线就把你覆盖掉。
所以所有写入都走 `beforeModelUpdate`（见 `live2d/body.js` 的 `frameWrites` / `flushWrites`）。
这一条是这套东西能「说歪头就真歪头」的根本原因。

### 分层混合（这是「同时做几件事」的关键）

```
physio < emotion < expression ≈ pose ≈ gesture < manual < misc
```

- 同一参数上，**高优先级完全压过低优先级**（情绪不会把姿态平均成一半）；
- 同一优先级里，**后下的命令接管这个参数**（她说「微笑」再说「换生气的脸」，嘴不会停在上一句）；
- 不同参数各管各的，所以「歪头 + 生气 + 说话」可以同时成立。

---

## 安装

### 1. 需要什么

- DeepSeek Harness（插件跑在它的插件目录里）
- Node.js 18+
- 一个 Live2D Cubism 4 模型（`.model3.json` + `.moc3` + 贴图；**不附带模型**，版权自负）
- 可选：Electron（要桌面透明窗口才需要）

### 2. 放文件

```
<你的 DSH 目录>/
├── plugins/body/{index.js, plugin.json}      # 从本仓库 plugins/body 复制
└── live2d/{body.js, body-server.mjs, index.html, vocab.json, lexicon.json, desktop/…}
```

### 3. 指向你的模型

```powershell
$env:LIVE2D_MODEL_DIR = 'D:\models\你的模型目录'
```

模型目录里要有 `*.model3.json`。页面会先问服务端 `GET /model-file`（服务端扫目录里第一个 `*.model3.json`），
也可以用 `LIVE2D_MODEL_FILE=xxx.model3.json` 指定，或直接在地址后加 `?model=xxx.model3.json`。
**不用改源码，也没有写死的模型名。**

### 3.5 准备 vendor 依赖（必做，否则页面是黑的）

页面需要 `live2d/vendor/` 下三个脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/get-vendor.ps1
```

脚本会从 npmmirror 拉 PIXI 与 pixi-live2d-display；**Cubism Core 需要你自己去
[Live2D 官网](https://www.live2d.com/sdk/cubism/) 下载**（专有运行时，本仓库不分发），
放到 `live2d/vendor/live2dcubismcore.min.js`。缺文件时页面左上角会红字提示缺哪个。

### 4. 起服务

```powershell
node live2d/body-server.mjs          # 默认 127.0.0.1:17901
```

打开 <http://127.0.0.1:17901/> 就能看到她自己站着。

### 5. 桌面窗口（可选）

```powershell
powershell -ExecutionPolicy Bypass -File live2d/launch-desktop.ps1
```

没有 DSH 自带 Electron 的话，先 `$env:ELECTRON_EXE = 'C:\path\to\electron.exe'`。

### 6. 让插件找到身体

`plugins/body/plugin.json` 里的 `settings.baseUrl` 默认 `http://127.0.0.1:17901`；改这里指向你的服务。

---

## 她会用的词（节选）

| 类别 | 词 |
|---|---|
| 头 | 歪头 / 侧头 / 抬头 / 低头 / 点头 / 摇头 / 左看 / 右看 / 缩脖 |
| 眼 | 眯眼 / 闭眼 / 睁大眼 / 瞪眼 / 笑眼 / 看你 |
| 眉 | 抬眉 / 挑眉 / 皱眉 |
| 嘴 | 微笑 / 笑 / 咧嘴 / 撇嘴 / 嘟嘴 / 张嘴 / 吐舌 / 鼓脸 |
| 身体 | 前倾 / 后仰 / 侧身 / 扭腰 / 提肩 / 沉肩 |
| 尾巴 | 摇尾巴 / 甩尾巴 / 尾巴翘 / 尾巴垂 / 尾巴偏 |
| 程度 | 微微 / 有点 / 挺 / 很 / 非常 / 超级 |
| 时长 | 一下 / 两秒 / 一直 / 保持 |

组合：`word=「很 委屈地 低头 缩脖」` → 拆出「很 · 低头 · 缩脖」，各自缩放后叠加。

改词表：`live2d/vocab.json`（纯 JSON，通道 → 参数 + 幅度），不用改代码。

---

## 插件工具

一个工具 `动一动身体`，`op` 取：

`face` `emotion` `word` `motion` `pose` `switch` `modelexpr` `say` `scale` `autonomy` `status` `look`

- `face=开心`：整套表情，默认 25 秒后淡回心情脸；`holdMs=-1` 常驻；
- `emotion={v,a,d}`：连续情绪（-1..1），会一直当底色；
- `word=「有点委屈」`：走词表，可叠加；
- `pose=歪头 / 嘟嘴 / 看向你`：预置姿态（视线、头、尾巴、吐舌…）；
- `switch=钢盆` / `switch=钢盆,on=false`：道具开关；
- `modelexpr=圈圈眼`：模型自带的 exp3 彩蛋动画（黑脸/流泪/爱心眼…）；
- `status`：连没连上、现在什么姿势、能做什么；
- `look`：**自拍** → 交给能看图的模型描述自己。

回执都带「做了什么 + 现在什么状态」，所以她能回答「你现在什么表情」。

---

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 渲染页（`?desktop=1` 隐藏 UI，`?k=<token>` 鉴权） |
| GET | `/state` | `{clients, lastHb, lastState, lastBounds}` —— 排障看这个 |
| POST | `/cmd` | 下命令（同插件 payload） |
| POST | `/hb` | 页面心跳（姿态/帧率/参数） |
| GET | `/selfie` | 抽当前画布成 PNG，返回 `{file, dataUrl}` |
| GET | `/vocab.json` | 词表 |
| GET | `/mood` | 心情面板数据（需要配置心情文件） |
| GET | `/history` | 对话记录（需要配置聊天档案） |
| WS | `/ws` | 页面连接（`?k=<token>`） |

环境变量：

```
LIVE2D_MODEL_DIR   模型目录（必填）
LIVE2D_PORT|BODY_PORT  端口，默认 17901
LIVE2D_HOST|BODY_HOST  监听地址，默认 127.0.0.1
LIVE2D_TOKEN|BODY_TOKEN  访问令牌（对外暴露时给）
BODY_SCENE         scene.json 路径
BODY_SELFIE_DIR    自拍落盘目录
BODY_HISTORY       聊天档案路径（可选）
BODY_MOOD          心情账本路径（可选）
```

---

## 已知限制

- **模型自带的表情（exp3）是「挂上去」的**：`resetExpression()` 才算摘掉，光把参数写回 0 没用；
- 这套皮的表情几乎全押在嘴上（嘴 29–31%、笑眼 21%、眉毛 5–10%，`ParamAngleZ` 只有 2%），所以「看起来没变」经常是美术限制，不是代码没生效；
- 首帧/冷启动会慢（模型 4~60MB，看素材）；
- Electron 透明窗口在 Windows 上挪动时会被系统改内容区尺寸（460→478px），必须锁尺寸，否则每拖一下闪一次。

---

## 许可

MIT（代码）。**模型、贴图、音色不在授权范围内**，请自己确认所用模型的分发许可。
本仓库不含任何模型文件。
