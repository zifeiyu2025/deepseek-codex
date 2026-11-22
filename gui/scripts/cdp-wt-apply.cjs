const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return response.result?.result?.value ?? response.result?.exceptionDetails ?? null;
  }

  await send('Runtime.enable', {});
  const info = await evaluate("window.codex.createWorktree('D:/MyWorkspace/wt-sandbox')");
  console.log('created:', JSON.stringify(info));
  if (!info || !info.path) throw new Error('worktree creation failed');

  fs.writeFileSync(path.join(info.path, 'a.txt'), 'base\nchanged\n');
  fs.writeFileSync(path.join(info.path, 'b.txt'), 'new file\n');

  const applied = await evaluate(
    `window.codex.applyWorktree(${JSON.stringify({ repoRoot: info.repoRoot, worktreePath: info.path })})`,
  );
  console.log('apply result:', JSON.stringify(applied));
  console.log('main a.txt:', JSON.stringify(fs.readFileSync(path.join(info.repoRoot, 'a.txt'), 'utf8')));
  console.log('main b.txt exists:', fs.existsSync(path.join(info.repoRoot, 'b.txt')));

  const removed = await evaluate(
    `window.codex.removeWorktree(${JSON.stringify({
      repoRoot: info.repoRoot,
      worktreePath: info.path,
      branch: info.branch,
    })})`,
  );
  console.log('remove result:', JSON.stringify(removed));
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});