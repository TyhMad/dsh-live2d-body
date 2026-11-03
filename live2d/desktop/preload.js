// 桌面鱼窗口的 preload：只暴露「按像素挪一下窗口」这一个能力。
// 为什么不用 -webkit-app-region: drag：那样整块区域会被当成标题栏，鼠标事件全被系统吞掉，
// 页面里 model.on('hit') 的「点一下换表情」就废了。所以自己算屏幕坐标差，发给主进程挪窗口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fishDesktop', {
  dragBy: (dx, dy) => ipcRenderer.send('fish:drag', dx, dy),
  // 松手时告诉主进程「拖完了」：Windows 上程序挪窗口不会触发 'moved'，位置只能在这里存
  dragEnd: () => ipcRenderer.send('fish:dragend'),
  hide: () => ipcRenderer.send('fish:hide'),
  version: 1
});
