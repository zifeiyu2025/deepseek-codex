const http = require('node:http');
const fs = require('node:fs');

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
  const targets = await getJson('http://127.0.0.1:9222/json/list');
  const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
  if (!page) throw new Error('page not found');
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
  const response = await send('Runtime.evaluate', {
    expression:
      "window.codex.createWorktree('D:/MyWorkspace/codex-deepseek/codex-src')",
    awaitPromise: true,
    returnByValue: true,
  });
  const value = response.result?.result?.value ?? response.result?.exceptionDetails;
  console.log(JSON.stringify(value, null, 2));
  if (value && value.path) {
    fs.writeFileSync('D:/MyWorkspace/codex-deepseek/gui/worktree-result.json', JSON.stringify(value, null, 2));
  }
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});