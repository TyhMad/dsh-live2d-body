// 导出模型里每个参数的真实取值范围（min / max / default），产出 param-ranges.json。
//
// 为什么要它：Cubism 会把越界值「夹」进合法范围，而夹完往往等于没写
// （比如某个参数范围是 [0,1]，你写 -1，最后落成 0，画面上什么都不变）。
// 只有拿到真实范围，才能判断「参数写了没反应」到底是没美术、被夹、还是被别的层覆盖。
//
// 用法：
//   1) 先起 body-server（默认 127.0.0.1:17901）
//   2) node tools/dump-param-ranges.mjs
//   3) 产出 param-ranges.json（放在当前目录）
//
// 可选环境变量：
//   BODY_URL   页面地址，默认 http://127.0.0.1:17901
//   CHROME     浏览器可执行文件路径（默认自动找 Edge / Chrome）
//   CDP_PORT   调试端口，默认 9347

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.CDP_PORT || 9347);
const BASE = (process.env.BODY_URL || 'http://127.0.0.1:17901') + '/?nolife&nofocus';

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('找不到浏览器，请用 CHROME=... 指定');
  process.exit(1);
}

const PROFILE = mkdtempSync(path.join(tmpdir(), 'rng-'));
process.on('exit', () => { try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); } catch { /* ignore */ } });

const child = spawn(BROWSER, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--headless=new',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=900,1200',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let ws = null;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
  });
}

async function main() {
  // 等浏览器起来
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('连不上浏览器调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };

  await send('Page.enable');
  await send('Page.navigate', { url: BASE });

  // 等模型加载完
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', {
        expression: '!!(window.__model && window.__model.internalModel && window.__model.internalModel.coreModel && window.__model.internalModel.coreModel._model)',
        returnByValue: true,
      });
      ready = !!(r.result && r.result.value);
    } catch { /* 页面还没准备好 */ }
  }
  if (!ready) throw new Error('模型没加载出来（检查 body-server 与 LIVE2D_MODEL_DIR）');

  const expr = `(() => {
    const core = window.__model.internalModel.coreModel;
    const p = core._model.parameters;           // 注意：coreModel.parameters 是 undefined
    const ids = Array.from(p.ids || []);
    const out = [];
    for (let i = 0; i < p.count; i++) {
      out.push({ id: ids[i], min: p.minimumValues[i], max: p.maximumValues[i], def: p.defaultValues[i] });
    }
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const rows = JSON.parse(r.result.value);

  writeFileSync('param-ranges.json', JSON.stringify(rows, null, 1), 'utf8');
  console.log(`导出 ${rows.length} 个参数 → param-ranges.json`);

  const byRange = new Map();
  for (const x of rows) {
    const k = `${x.min}~${x.max}`;
    byRange.set(k, (byRange.get(k) || 0) + 1);
  }
  console.log('范围分布（前 5）：');
  [...byRange.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([k, n]) => console.log(`  ${k}  ×${n}`));
}

main()
  .catch((e) => { console.error('失败：', e.message); process.exitCode = 1; })
  .finally(() => { try { ws && ws.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } });
