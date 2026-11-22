const http = require('node:http');

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
  const expression = `(async () => {
    const thread = await window.codex.request('thread/start', {
      cwd: 'D:/MyWorkspace/codex-deepseek',
      model: 'deepseek-flash',
      modelProvider: 'deepseek',
      approvalPolicy: 'on-request'
    });
    const turn = await window.codex.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Use the shell to run: echo hello. Then reply with the exact stdout.', text_elements: [] }]
    });
    return { threadId: thread.thread.id, turnId: turn.turn.id };
  })()`;
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(response.result, null, 2));
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});