// Usage: node cdp-shot.cjs [port] [outputPath]
const http = require('node:http');
const fs = require('node:fs');

const port = Number(process.argv[2] || 9223);
const output = process.argv[3] || 'D:/MyWorkspace/codex-deepseek/gui/shot.png';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

(async () => {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
  if (!page) throw new Error(`page not found on ${port}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await send('Runtime.enable', {});
  const response = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(output, Buffer.from(response.result.data, 'base64'));
  console.log(`saved ${output}`);
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});