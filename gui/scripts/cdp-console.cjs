// Usage: node cdp-console.cjs [port] [waitMs]
const http = require('node:http');

const port = Number(process.argv[2] || 9223);
const waitMs = Number(process.argv[3] || 2500);

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
  const problems = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push(`EXCEPTION ${message.params?.exceptionDetails?.text || ''} ${message.params?.exceptionDetails?.exception?.description || ''}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      problems.push(`CONSOLE ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      problems.push(`LOG ${message.params.entry.text}`);
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
  await send('Log.enable', {});
  await send('Page.enable', {});
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  console.log(JSON.stringify({ problems }, null, 2));
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});