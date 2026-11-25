# 换一个模型要改什么

这个项目对着**一套具体的 Cubism 4 模型**调出来的（509 个参数、47 个姿态、9 套表情、12 段待机动作）。
换模型能跑，但要分清「哪些是通用的、哪些是绑死在这副皮上的」。

## 一、开箱就通用的部分

| 部分 | 为什么通用 |
|---|---|
| 模型加载 | 扫模型目录里第一个 `*.model3.json`；`?model=` 可指定。支持 **Cubism 4**（`.model3.json`），不支持 Cubism 2 的 `.model.json` |
| 渲染 / 物理 / 眨眼 / 视线跟随 | pixi-live2d-display + Cubism Core 标准流程 |
| 推近、贴手（往鼠标方向靠） | 走 `model.scale` / `position`，与参数名无关 |
| 分层混合与优先级 | 只知道「参数 id」，不知道它属于哪个部位 |
| 动作回执 / `status` / 自拍 / 持久化 / 多端 | 与模型无关 |
| 说话层口型 | 只写 `ParamMouthOpenY`（Cubism 模板参数，绝大多数模型都有） |
| 空闲微表情 | 只写 `ParamAngleX/Y/Z`、`ParamEyeLOpen/ROpen`、`ParamBrowLY/RY` |

**结论**：换成任何 Cubism 4 模型，打开页面就能看到它站着、呼吸、眨眼、跟着鼠标看、说话时动嘴。
**歪头/点头/身体前倾**这类主干动作大概率也能用，因为 `ParamAngleX`、`ParamBodyAngleX` 这些是 Cubism 模板的固定名字。

## 二、绑死在这副皮上、必须重配的部分

| 东西 | 在 `live2d/body.js` / `vocab.json` 里的位置 | 换模型时怎么办 |
|---|---|---|
| 道具 / 换装 / 手部零件 | `SWITCHES`（`key1..13`、`Clothes1..5`、`Movement1..3`） | 看你模型的 `*.model3.json` 里有哪些 `Part` / `Key`，没对应就整块删掉 |
| 模型自带表情（exp3） | `MODEL_EXPR` 名单 | 改成你 `expressions/` 下的文件名 |
| 尾巴 | `TAIL_IDS` | 模型没尾巴就置空数组（否则摇尾巴会把别的部位带歪） |
| 手指/手势 | `HAND_PARAMS` | 同上 |
| 47 个姿态、9 套表情 | `POSES` / `EMOTIONS` | 参数名对不上就按你的模型改；不改的话坏的那几条会静默失败（回执会写「没有这个姿态」） |
| 75 个词条 → 31 条通道 | `live2d/vocab.json` | 纯 JSON，改 `channels` 里的参数名与幅度即可，不用动代码 |
| 参数真实范围 | `PARAM_RANGES` | **必须重新生成**，见第三节 |
| 中文参数名 | `PARAM_CN` | 可选，只影响试播台显示 |
| 12 段待机动作 | `live2d/anims/*.json` | 里面写的是参数 id；换模型后要么改 id，要么用试播台的时间轴编辑器重录 |

## 三、三步接上新模型

```powershell
# 1) 指向你的模型目录
$env:LIVE2D_MODEL_DIR = 'D:\models\你的模型'

# 2) 导出这个模型每个参数的真实取值范围（min/max/default）
node tools/dump-param-ranges.mjs
#    产出 param-ranges.json；body.js 会用它来夹值 + 判断「这个值够不够看得见」

# 3) 起服务，打开试播台逐个点
node live2d/body-server.mjs
#    http://127.0.0.1:17901/playground
```

试播台（`playground.html`）会列出**这个模型实际有的**姿态/表情/道具/参数滑杆，点一下就知道哪条能用、哪条是空的。

## 四、最常见的三种失败

1. **参数写了没反应** —— 九成是「写超了范围被夹」或「这个参数根本没有美术」（这两种在画面上完全一样）。先查 `param-ranges.json` 里的 min/max，再单参数推满看画面变不变。
2. **模型自带表情挂上摘不掉** —— exp3 必须 `resetExpression()`，把参数写回 0 没用。
3. **点击没反应 / 摸错部位** —— 命中判定用 alpha 遮罩（点到透明区域不算），分区是按包围盒高度比例切的（`TOUCH_ZONES_DEFAULT`），不同身材比例要微调；也可以用 `?auto=1` 让它按遮罩自动标定脸/胯分界。
