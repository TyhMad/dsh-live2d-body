# 第三方组件与许可

本仓库自身的代码以 MIT 发布（见 `LICENSE`）。下面这些是**没有随仓库分发**的第三方组件，
使用者需要自行安装或下载，并遵守它们各自的许可：

| 组件 | 版本 | 许可 | 获取方式 |
|---|---|---|---|
| [PIXI.js](https://pixijs.com/) | 6.5.10 | MIT | `scripts/get-vendor.ps1` 从 npmmirror 拉取 |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | 0.4.0 | MIT | 同上 |
| [Live2D Cubism Core](https://www.live2d.com/sdk/cubism/) | 5.x | Live2D 专有 | 必须从 live2d.com 自行下载，**本仓库不提供** |
| [Electron](https://www.electronjs.org/) | ^33 | MIT | `npm i -D electron` |
| [ws](https://github.com/websockets/ws) | ^8 | MIT | `npm i ws` |

## 模型

仓库里**没有**任何 `.moc3`、贴图、`.physics3.json`、`.motion3.json` 或角色形象文件。
你自己准备的模型，其版权与使用条款归原作者；本项目的 MIT 许可**不覆盖**它。
