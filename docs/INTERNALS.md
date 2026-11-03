# 踩过的坑（每条都真的卡过）

这份文件是本项目真正值钱的部分：Live2D 在浏览器里「看起来没反应」的 90% 原因，都在下面。

## 1. 写入时机：为什么在 ticker 里改参数没用

Cubism 每帧的顺序（`vendor/cubism4.min.js` 的 `update()`）：

```
motionManager → expression → eyeBlink → updateFocus() → naturalMovements
             → physics.evaluate → pose → emit("beforeModelUpdate")
             → core.update() → loadParameters()
```

PIXI 的 `app.ticker` 回调跑在 `core.update()` **之后**。你在那里写 `ParamAngleZ = 30`，
下一帧 `physics.evaluate()` 和 `updateFocus()` 会把它按物理/视线重算回去 —— 现象就是「写了没反应」。

**正确做法**：挂在 `model.internalModel.on('beforeModelUpdate', fn)`，在那里写 `core.setParameterValueById()`。
本项目里所有写入攒在 `frameWrites` / `frameAdds` 两个 Map，由 `flushWrites()` 在钩子里一次性写出。

## 2. 眼睛的三种「不听话」

- **眨眼**：`ParamEyeLOpen` 被 `eyeBlink` 每帧重算 → 自己写的眯眼会被顶掉。方案：表情层只提供「眯眼系数」，最后 `EyeLOpen = blinkValue * 0.98 * squint`。
- **视线**：`updateFocus()` 每帧重算 `ParamEyeBallX/Y` → 写姿态「看向你」无效。方案：同样在 `beforeModelUpdate` 里写，并且在 ticker 末尾把 core 的当前值读回 `eyeWant`，避免自己覆盖自己。
- **静止看着你**：空闲扫视如果一直开着，瞳孔会在 ±0.07 内来回飘，远看像「发直/翻白眼」。方案：默认落到 (0.09, -0.03)、抖动 ±0.035、4% 概率瞟一眼；有姿态钉住时完全不抖。

## 3. 物理：尾巴、头发

- 尾巴 6 节参数 `Param_Angle_Rotation84..89` 由 `physics3.json` 每帧重算；
- 想让它「自己甩」，别摘物理（摘掉之后整只回弹，看着像全身在动），而是**在 `beforeModelUpdate` 写叠加波形**：
  `value = base + sin(t*2πf) * amp * envelope`；
- 我们一开始把 `internalModel.physics = null` 了 2.8 秒，结果头发/裙摆全停、结束瞬间「啪」地回位。

## 4. 表情（exp3）是持久状态，不是一次性的

`model.expression('委屈')` 这类是**开关**：设了就一直挂着，把参数写回 0 也没用。
摘掉只能 `expressionManager.resetExpression()`。
所以要区分两件事：

- `switch on=false`（把道具摘了）；
- `modelexpr 关掉`（把动画摘了）。
  服务端 `scene.json` 也必须同步清，否则刷新/重连会把圈圈眼恢复回来。

## 5. 分层混合

```
physio < emotion < expression ≈ pose ≈ gesture < manual < misc
```

- 高优先级整个压过低优先级（否则「嘟嘴」里的 `ParamAngleZ=5` 被情绪层的 0 平均成 2.5，看着像没做）；
- **同优先级里后下的命令接管**（同一 `start` 的多个值才叠加）；
- 层撤走后必须把参数写回原值（`animBase`），否则脸停在最后一个表情上。

## 6. 计时

- 表情：默认 25 秒（`EXPR_IMPLICIT_MS`），到期 420ms 淡出；`holdMs=-1` 常驻；
- 心情剧变（|Δv|≥0.45 或 |Δa|≥0.5）时表情提前退场，交回心情底色；
- 常驻表情不参与剧变判定。

## 7. Electron 透明窗口

- Windows 每次移动透明无边框窗口都会把内容区撑大 8–10px（460→478），PIXI 就会重新 fit → 那一下闪；
  解决：拖动时 `win.setBounds({width: WIN_W, height: WIN_H})` 锁尺寸，攒 8ms 再挪；
- 恢复位置必须「整只夹进工作区」，只保证「80px 可见」会把负坐标写回 `pos.json`，下次开机半截在屏幕外；
- 磁盘缓存会让页面继续跑旧 `body.js`：服务端给 `body.js?v=<mtime>` 破缓存；
- DSH 全局设了 `ELECTRON_RUN_AS_NODE=1`，启动前必须清掉。

## 8. 服务端

- 页面崩了但 socket 还挂着 → `/cmd` 报 `delivered:1` 其实没人收。方案：45 秒没消息就 `terminate()`；
- 服务端能连但 `clients=0` 时命令被静默丢弃 → 插件必须把 `delivered:0` 当失败：
  「身体没连上（窗口和网页都没开着）」；
- 不要重连时补发历史命令：会把 20 分钟前的姿势/气泡复活。现场用 `scene` 恢复就够了；
- `/selfie` 超时必须清 `pendingSelfies`，否则每失败一次泄漏一条；
- `extract.base64()` 在不同 PIXI 版本返回**不同前缀**（`data:image/png;charset=utf-8;base64,…`），
  要 `replace(/^data:[^,]*,/, '')` 再解；解出来还得校验 PNG 头（`89 50`），否则会写出一堆 199KB 的垃圾。

## 9. 环境坑

- PowerShell 5.1 读写含中文的 UTF-8 文件会毁内容 → 一律 `[IO.File]::ReadAllText(path, UTF8)` + `WriteAllText(..., UTF8 no BOM)`；
- 把 python 代码塞进 `ssh "..."` 双引号里必炸 → 写文件再 `scp`；
- `curl -d '{"type":"reload"}'` 经 PowerShell→ssh 两层引号会被拆坏 → 用 python `urllib` 发；
- `pv`（探针）是心跳窗口的 min/max，刚变过时 `max` 还是旧值，要等窗口刷新再读。
