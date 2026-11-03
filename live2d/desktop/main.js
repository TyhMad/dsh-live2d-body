// Live2D 桌面身体：一个透明的、置顶的、无边框窗口，里面就是 17901 那个页面。
//
// 用法：electron.exe F:\GAME\qqagent\live2d\desktop
// 或者双击 live2d\开桌面鱼.bat

const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.LIVE2D_PORT || 17901);
const LOCAL_PAGE = `http://127.0.0.1:${PORT}/?desktop=1`;
// 云上那台身体服务：电脑窗口也可以连它，这样电脑和手机看的是同一个她
// （launch-desktop.ps1 会用 FISH_URL 传进来；连不上就自动退回本机）
let PAGE = process.env.FISH_URL || LOCAL_PAGE;
const USING_CLOUD = PAGE !== LOCAL_PAGE;
const ROOT = path.join(__dirname, '..');

// 透明置顶窗口 + Live2D 曾经每隔一会儿崩一次（life.log: `render-process-gone reason=crashed
// exit=-36861`），当时归到「GPU 不稳」头上，关掉硬件加速绕开——代价是拖动窗口整块重绘、
// 一挪就闪。后来查明崩的主因是「高 DPI 尺寸纠偏死循环」（已修），再加上 Chromium 把这块
// 显卡判进了黑名单（`gl=disabled_software`），所以现在是：
//   默认开加速 + 忽略黑名单 + 指定 D3D11；真出问题再设 FISH_SOFT=1 退回软件渲染。
if (softMode()) {
  app.disableHardwareAcceleration();
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  // 透明 + alwaysOnTop 的窗口走 DirectComposition 会周期性把渲染进程整块弄崩
  // （life.log 里 exit=-36861，10~25 分钟一次）。关掉它、走老的合成路径。
  app.commandLine.appendSwitch('disable-direct-composition');
  // 下一次崩溃能查：Chromium 自己的日志会落到 userData\chromium.log
  // （render-process-gone 只给一个 exit 码，看不出是哪一层挂的 —— 前天到今天已经崩了 26 次）
  try {
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', path.join(app.getPath('userData'), 'chromium.log'));
  } catch { /* ignore */ }
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let win = null;
let serverProc = null;
// 窗口尺寸只认这一个答案。拖动时每次都用它重设一遍：Windows 对透明无边框窗口
// 每挪一次会偷偷把内容区加大一圈（实测每次 +8~10px），不压住的话拖几次鱼就变大一次，
// 而且中途尺寸一变，PIXI 会重新 fit，画面看着就是「抖一下 / 闪一下」。
const WIN_W = 460;
const WIN_H = 700;

// 把窗口位置写盘。做成模块级函数是因为「启动恢复位置」和「拖动结束」两处都要用，
// 之前放在 createWindow 里面，外面调用会静默 ReferenceError（被 try 吃掉，pos.json 一直不出现）。
function savePos() {
  if (!win || win.isDestroyed()) return;
  try {
    const [x, y] = win.getPosition();
    require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'pos.json'), JSON.stringify({ x, y }));
  } catch { /* ignore */ }
}

// 这具身体偶尔会自己消失（隔十来分钟换一个实例）。留个时间线日志，下次能一眼看出
// 是窗口被关、渲染崩、还是外部把它杀了：%APPDATA%\live2d-body-desktop\life.log
function life(msg) {
  try {
    const fs = require('node:fs');
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'life.log'),
      `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch { /* ignore */ }
}

// ── 崩溃记账 ────────────────────────────────────────────────────────────────
// GPU 模式下渲染进程会周期性崩（exit=-36861）。30 分钟内崩到 3 次就写一个
// softmode.flag：下次启动改用软件渲染。宁可慢一点，也不能隔十分钟黑一下。
const flagPath = (name) => path.join(app.getPath('userData'), name);

function softMode() {
  if (String(process.env.FISH_SOFT || '') === '1') return true;
  if (String(process.env.FISH_GPU || '') === '1') return false;
  try { return require('node:fs').existsSync(flagPath('softmode.flag')); } catch { return false; }
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch { return fallback; }
}

function noteCrash(reason, exitCode) {
  try {
    const now = Date.now();
    const list = (readJsonSafe(flagPath('crashes.json'), []) || []).filter((t) => now - t < 30 * 60 * 1000);
    list.push(now);
    require('node:fs').writeFileSync(flagPath('crashes.json'), JSON.stringify(list));
    life(`renderer crash #${list.length}/30min (${reason} exit=${exitCode})`);
    if (list.length >= 3 && !softMode()) {
      require('node:fs').writeFileSync(flagPath('softmode.flag'), new Date().toISOString());
      life('30 分钟内崩了 3 次 → 写 softmode.flag，重启窗口后改用软件渲染（强制 GPU: FISH_GPU=1）');
    }
  } catch { /* ignore */ }
}

process.on('exit', (code) => life(`exit code=${code}`));
process.on('SIGTERM', () => { life('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { life('SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => life('uncaught ' + (err && err.stack || err)));
process.on('unhandledRejection', (err) => life('unhandledRejection ' + (err && err.stack || err)));

function portOpen(timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), timeout);
  });
}

async function ensureServer() {
  if (await portOpen()) return;
  try {
    serverProc = spawn('node', ['body-server.mjs'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    serverProc.unref();
  } catch (err) {
    dialog.showErrorBox('起不来', '找不到 node，或者 body-server.mjs 不见了：\n' + String(err && err.message || err));
    return;
  }
  for (let i = 0; i < 30; i++) {
    if (await portOpen(300)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 260,
    minHeight: 380,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 透明无边框窗口能被拖着边缘改大小，一不小心就把整只鱼拉成满屏
    // （实测被拉到 1710x2174）。这里锁死尺寸，位置还是随便拖。
    resizable: false,
    movable: true,
    // thickFrame: Windows 给「可调整大小」的窗口外面套一圈看不见的边框（8px），
    // 透明窗口带着它被人拖的时候，系统会先画那圈边框/阴影再挪内容 —— 看起来就是边缘发白闪，
    // 而且每挪一次内容区会被重新算大一点（实测 460x700 拖完变成 470x712）。
    thickFrame: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: 'Live2D',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility(false);
  // 磁盘缓存会让页面继续跑旧的 body.js（改了代码 reload 还是旧行为，排查过一次很费劲），
  // 每次开窗前清一次缓存，保证加载的就是磁盘上这份。
  try {
    const { session } = require('electron');
    session.defaultSession.clearCache().catch(() => { });
  } catch (e) { /* ignore */ }
  win.loadURL(PAGE);
  life(`window created (render=${softMode() ? 'software' : 'gpu'})`);

  // 尺寸只有一个答案：460x700，而且 `resizable: false` 之后没人能改它。
  // 这里只在窗口创建后校准一次——**不要**监听 resize 再纠：高 DPI 下 getContentSize 报告的是
  // 经过舍入的 DIP 值（460x700 会读成 468x708 这种），纠一次就再触发一次 resize，
  // 实测会变成每 600ms 一次的窗口重排，把渲染进程（WebGL 上下文）逼崩，
  // 表现就是「隔一会儿重载一次、动作被打断」。
  try {
    const [cw, ch] = win.getContentSize();
    if (Math.abs(cw - 460) > 3 || Math.abs(ch - 700) > 3) {
      win.setContentSize(460, 700);
      life(`lock size ${cw}x${ch} -> 460x700`);
    }
  } catch (e) { /* ignore */ }

  // 把窗口在屏幕上的真实位置报给 body-server（/state 的 lastBounds），截图裁切用
  const reportBounds = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      fetch('http://127.0.0.1:17901/bounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, scale: screen.getPrimaryDisplay().scaleFactor })
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  };
  reportBounds();
  setInterval(reportBounds, 3000);
  // 挪窗口时 'moved' 一秒能来 60 次：每次都发 HTTP + 每次都同步写盘，主线程就是被这两件事
  // 拖住的（表现：拖动时画面一顿一顿）。改成「最后一次挪完 400ms 再写」，中间只记标记。
  let boundsDirty = false;
  let boundsTimer = null;
  const scheduleBounds = () => {
    boundsDirty = true;
    if (boundsTimer) return;
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!boundsDirty) return;
      boundsDirty = false;
      reportBounds();
      savePos();
    }, 400);
  };
  win.on('moved', scheduleBounds);

  // 服务刚起来时偶尔会抢跑（ERR_CONNECTION_REFUSED），重试几次，别停在 Error 页
  let retries = 0;
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (retries >= 8) return;
    retries += 1;
    // 连的是云上那台：三次都上不去（断网/服务没起）就退回本机，别让她消失
    if (USING_CLOUD && retries === 3 && PAGE !== LOCAL_PAGE) {
      life(`cloud page unreachable (${code} ${desc}) -> fallback to local`);
      PAGE = LOCAL_PAGE;
    }
    setTimeout(() => { if (win) win.loadURL(PAGE); }, 700);
  });
  win.webContents.on('did-finish-load', () => {
    retries = 0;
    // 页面里 PIXI 最终用的是 WebGL 还是 canvas2d —— 拖动闪不闪，一半看这个
    win.webContents.executeJavaScript(`(() => {
      try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl2') || c.getContext('webgl');
        if (!g) return 'no-webgl';
        const dbg = g.getExtension('WEBGL_debug_renderer_info');
        return 'webgl | ' + (dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER));
      } catch (e) { return 'err:' + e.message; }
    })()`).then((r) => life('page-renderer=' + r)).catch(() => {});
  });

  // 渲染进程崩了 / 卡死 → 自己重载，别留一张冻住的立绘在桌面上
  // 记下 reason / exitCode / 是否 GPU 相关，不然只知道「又崩了」查不出为什么
  win.webContents.on('render-process-gone', (_e, details) => {
    const d = details || {};
    life(`render-process-gone reason=${d.reason || '?'} exit=${d.exitCode ?? '?'}`);
    noteCrash(d.reason || '?', d.exitCode ?? '?');
    setTimeout(() => { try { win.reload(); } catch { /* ignore */ } }, 800);
  });
  win.webContents.on('unresponsive', () => {
    life('unresponsive -> reload');
    try { win.reload(); } catch { /* ignore */ }
  });
  // GPU 进程自己崩的时候渲染进程通常跟着走，单独记一笔
  app.on('child-process-gone', (_e, d) => {
    if (!d) return;
    life(`child-process-gone type=${d.type} reason=${d.reason} exit=${d.exitCode}`);
  });

  // 右上角右键菜单
  win.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      {
        label: win.isAlwaysOnTop() ? '取消置顶' : '保持置顶',
        click: () => win.setAlwaysOnTop(!win.isAlwaysOnTop(), 'floating')
      },
      { label: '重新载入', click: () => win.reload() },
      { type: 'separator' },
      {
        // 关掉「以后自己出来」：留一个标记文件，local-hand\start-all.ps1 看到它就不再把鱼拉起来
        label: '关掉，以后别自己出来',
        click: () => {
          try {
            const fs = require('node:fs');
            const dir = path.join(__dirname, '..', '..', 'local-hand');
            if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'FISH_OFF'), 'off');
            life('user turned off auto-launch (FISH_OFF written)');
          } catch (err) { life('FISH_OFF write failed: ' + err.message); }
          app.quit();
        }
      },
      { label: '退出（下次还会自己出来）', click: () => app.quit() }
    ]);
    menu.popup({ window: win });
  });

  // 记住位置（拖动期间不写，交给上面 400ms 的防抖；关窗口前补写一次）
  win.on('close', () => { try { savePos(); } catch {} });

  win.on('closed', () => { life('window closed'); win = null; });
}

app.whenReady().then(async () => {
  // 拖动：渲染进程把屏幕坐标的差值发过来，主进程挪窗口。
  // 不用 -webkit-app-region: drag，那样鼠标事件会被系统吞掉（点一下换表情就没了）。
  //
  // 为什么要「攒一下再挪」：透明无边框窗口每 setPosition 一次，Windows 就要把整块
  // 690x1050 的面重画一遍（软件渲染时是 CPU 干这活）。鼠标一秒能发 200+ 个 pointermove，
  // 逐个挪就是「跟不上 -> 画面一顿一顿 / 边缘发白闪」。这里把 8ms 内的位移合并成一次。
  let pendingX = 0;
  let pendingY = 0;
  let flushTimer = null;
  const flushDrag = () => {
    flushTimer = null;
    if (!win || win.isDestroyed()) { pendingX = 0; pendingY = 0; return; }
    const stepX = Math.round(pendingX);
    const stepY = Math.round(pendingY);
    pendingX -= stepX;
    pendingY -= stepY;
    if (!stepX && !stepY) return;
    const b = win.getBounds();
    const disp = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
    const wa = disp.workArea;
    const keep = 80;
    const nx = Math.min(Math.max(b.x + stepX, wa.x - WIN_W + keep), wa.x + wa.width - keep);
    const ny = Math.min(Math.max(b.y + stepY, wa.y - WIN_H + keep), wa.y + wa.height - keep);
    if (nx === b.x && ny === b.y && b.width === WIN_W && b.height === WIN_H) { pendingX = 0; pendingY = 0; return; }
    win.setBounds({ x: nx, y: ny, width: WIN_W, height: WIN_H });
  };
  // 松手：把攒着的位移挪完，再存一次位置
  ipcMain.on('fish:dragend', () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushDrag();
    savePos();
  });
  ipcMain.on('fish:drag', (_e, dx, dy) => {
    if (!win || win.isDestroyed()) return;
    pendingX += Number(dx) || 0;
    pendingY += Number(dy) || 0;
    if (flushTimer) return;
    flushTimer = setTimeout(flushDrag, 8);
  });

  await ensureServer();
  createWindow();
  // 记一笔 GPU 状态：以后排查「拖动闪 / 卡」能一眼看出当时是软件渲染还是走显卡
  try {
    const st = app.getGPUFeatureStatus();
    life(`gpu accel=${app.isHardwareAccelerationEnabled() ? 'on' : 'off'} ` +
      `gl=${st?.gpu_compositing || '?'} webgl=${st?.webgl || '?'} webgl2=${st?.webgl2 || '?'}`);
  } catch { /* ignore */ }

  // 恢复上次的位置（并夹回屏幕内：以前被拉大/拖出屏幕的窗口也能救回来）
  try {
    const fs = require('node:fs');
    const p = path.join(app.getPath('userData'), 'pos.json');
    let x = null;
    let y = null;
    try {
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      x = Number(saved.x);
      y = Number(saved.y);
    } catch { /* 没有记录：给个默认位置，别落在屏幕外 */ }
    const b = win.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = wa.x + wa.width - b.width - 40;
      y = wa.y + wa.height - b.height - 40;
    }
    const disp = screen.getDisplayNearestPoint({ x: Math.round(x + b.width / 2), y: Math.round(y + b.height / 2) });
    const area = disp.workArea;
    // 整只夹进屏幕：以前用的是「至少留 80px 可见」，于是 pos.json 里的负坐标会被原样接受，
    // 她就常有一半在屏幕外（看着像「鱼消失了」）。现在宁可挪回来，也不再接受半截在外的位置。
    const nx = Math.min(Math.max(Math.round(x), area.x), area.x + area.width - b.width);
    const ny = Math.min(Math.max(Math.round(y), area.y), area.y + area.height - b.height);
    win.setBounds({ x: nx, y: ny, width: 460, height: 700 });
    savePos();
  } catch {}

  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { life('window-all-closed -> quit'); app.quit(); });
app.on('before-quit', () => life('before-quit'));
