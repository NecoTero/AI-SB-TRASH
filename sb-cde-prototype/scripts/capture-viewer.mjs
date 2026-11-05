import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9337;
const profile = path.resolve('.capture-profile');
const output = path.resolve('dist/assets/status-viewer.png');
const inspectCollapsed = process.argv.includes('--inspect-collapsed');
const browser = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1600,900',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  'http://localhost:5173/capture-viewer.html',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let page;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find(item => item.type === 'page' && item.url.includes('capture-viewer.html'));
      if (page) break;
    } catch {}
    await wait(250);
  }
  if (!page) throw new Error('Не удалось подключиться к странице viewer');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Runtime.enable');
  let state;
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const result = await call('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:window.__captureReady,error:window.__captureError})',
      returnByValue: true,
    });
    state = JSON.parse(result.result.value || '{}');
    if (state.error) throw new Error(state.error);
    if (state.ready) break;
    await wait(250);
  }
  if (!state?.ready) throw new Error('Viewer не подготовил снимок вовремя');
  if (inspectCollapsed) {
    await call('Runtime.evaluate', { expression: "document.querySelector('[data-current-works-toggle]').click()" });
    await wait(300);
    const measured = await call('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{const panel=document.querySelector('.viewer-current-works'),button=document.querySelector('[data-current-works-toggle]'),svg=button.querySelector('svg'),p=panel.getBoundingClientRect(),b=button.getBoundingClientRect(),s=svg.getBoundingClientRect(),style=getComputedStyle(panel);return {padding:style.padding,panel:{x:p.x,y:p.y,w:p.width,h:p.height,cx:p.x+p.width/2,cy:p.y+p.height/2},button:{x:b.x,y:b.y,w:b.width,h:b.height,cx:b.x+b.width/2,cy:b.y+b.height/2},svg:{x:s.x,y:s.y,w:s.width,h:s.height,cx:s.x+s.width/2,cy:s.y+s.height/2}}})())`,
      returnByValue: true,
    });
    const metrics = JSON.parse(measured.result.value);
    const offset = Math.hypot(metrics.panel.cx - metrics.svg.cx, metrics.panel.cy - metrics.svg.cy);
    console.log(JSON.stringify({ ...metrics, centerOffset: offset }, null, 2));
    if (offset > 0.6) throw new Error(`Стрелка смещена от центра на ${offset.toFixed(2)} px`);
  } else {
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(output, Buffer.from(shot.data, 'base64'));
    console.log(output);
  }
} finally {
  socket?.close();
  browser.kill();
}
