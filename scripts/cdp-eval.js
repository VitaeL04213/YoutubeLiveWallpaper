'use strict';
// Tiny CDP helper: node scripts/cdp-eval.js "<title-substring>" "<expression>"
// Prints the evaluated value as JSON.
const http = require('http');
const titleMatch = process.argv[2] || 'Vellum';
const expression = process.argv[3] || '1';
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
(async () => {
  const list = await getJson('http://127.0.0.1:' + (process.env.CDP_PORT || 9222) + '/json/list');
  const pages = list.filter((t) => t.type === 'page');
  const target = pages.find((t) => String(t.title) === titleMatch) || pages.find((t) => String(t.title).includes(titleMatch));
  if (!target) { console.error('no page matching ' + titleMatch); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.result && out.result.exceptionDetails) { console.error('EVAL ERROR: ' + JSON.stringify(out.result.exceptionDetails)); }
  const r = out.result && out.result.result;
  console.log(JSON.stringify(r && 'value' in r ? r.value : r, null, 2));
  ws.close();
})();