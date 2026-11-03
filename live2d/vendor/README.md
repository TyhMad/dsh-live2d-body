# vendor/ 里要放什么（本仓库不附带）

页面 `index.html` 依赖三个脚本，都要放在 **`live2d/vendor/`** 下：

| 文件 | 来源 | 许可 |
|---|---|---|
| `pixi.min.js` | [pixi.js](https://www.npmjs.com/package/pixi.js) 6.5.x（`dist/pixi.min.js`） | MIT |
| `cubism4.min.js` | [pixi-live2d-display](https://www.npmjs.com/package/pixi-live2d-display)（`dist/cubism4.min.js`） | MIT |
| `live2dcubismcore.min.js` | [Live2D Cubism SDK for Web](https://www.live2d.com/sdk/cubism/)（Core 5.x） | **Live2D 专有，必须自己下载并同意其许可** |

## 为什么要自己下

- 前两个是 MIT，但为了仓库干净、体积小，不塞进来；
- `live2dcubismcore.min.js` 是 Live2D 的专有运行时，**不能**由本仓库二次分发。请去官网下载 Cubism SDK for Web，
  把 `Core/live2dcubismcore.min.js` 复制到本目录，并遵守 Live2D 的许可（个人/小规模通常免费，商用需按其条款）。

## 一条命令装前两个（国内可用）

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\get-vendor.ps1
```

脚本会从 npmmirror 拉 `pixi.js@6.5.10` 与 `pixi-live2d-display@0.4.0` 的 dist 文件；
Cubism Core 仍需你手动下载（脚本会打印下载页地址）。

## 缺文件会怎样

页面打开是**黑的**（`PIXI is not defined`）。新版 `index.html` 会直接显示一行红字提示缺哪个文件。
