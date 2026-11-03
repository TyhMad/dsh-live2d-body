# 致谢与素材来源

## 代码

- [PIXI.js](https://pixijs.com/) 6.5.x
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0
- [Live2D Cubism Core](https://www.live2d.com/sdk/cubism/) 5.2（按 Live2D 的授权条款使用，**不随本仓库分发**）
- DeepSeek Harness 插件 API

## 关于模型

- 本仓库**不包含**任何 Live2D 模型、贴图、物理或动作文件。
- 开发和测试时用过第三方公开皮（美术与绑定作者另有署名与使用条款），这类素材的版权归原作者，本项目不分发、也不对其授权作任何转授。
- 想跑起来：自备任何 Cubism 4 模型，按 README 把 `LIVE2D_MODEL_DIR` 指过去即可。

## 参考与启发

- [jingyu-live2d-agent](https://github.com/InariNGT-Ofiicial/jingyu-live2d-agent)：参数清单与动作编译器的思路
- [soullink-emotion-sdk](https://github.com/nanlingyin/soullink-emotion-sdk)：连续 VAD 情绪 + FACS/AU 的映射方式
- [dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood)：情绪衰减与「同一次变化只说一次」的做法
