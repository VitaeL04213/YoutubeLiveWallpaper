'use strict';
// node scripts/cdp-shot.js <title> <out.png> [width height]
const http = require('http');
const fs = require('fs');
const titleMatch = process.argv[2] || 'Vellum';
const out = process.argv[3] || '.cache/shot.png';
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
(async () => {
  const list = await getJson('http://127.0.0.1:' + (process.env.CDP_PORT || 9222) + '/json/list');
  const pages = list.filter((t) => t.type === 'page');
  const target = pages.find((t) => String(t.title) === titleMatch) || pages.find((t) => String(t.title).includes(titleMatch));
  if (!target) { console.error('no page matching ' + titleMatch); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const isJpg = /\.jpe?g$/i.test(out);
  const shot = await send('Page.captureScreenshot', {
    format: isJpg ? 'jpeg' : 'png',
    quality: isJpg ? 82 : undefined,
    captureBeyondViewport: false,
  });
  if (!shot.result || !shot.result.data) {
    console.error('screenshot failed: ' + JSON.stringify(shot.error || shot).slice(0, 300));
    process.exit(1);
  }
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('saved ' + out + ' ' + fs.statSync(out).size);
  ws.close();
})().catch((error) => {
  console.error('cdp-shot failed: ' + (error && error.message));
  process.exit(1);
});