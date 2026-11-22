const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await evaluate("document.querySelector('.new-session')?.click(); 'cleared'");

  const dataUrl = await evaluate(
    "window.codex.imageDataUrl('D:/MyWorkspace/codex-deepseek/image-test.png')",
  );
  console.log('image data url length:', typeof dataUrl === 'string' ? dataUrl.length : dataUrl);

  const started = await evaluate(`(async () => {
    const thread = await window.codex.request('thread/start', {
      cwd: 'D:/MyWorkspace/codex-deepseek',
      model: 'deepseek-flash',
      modelProvider: 'deepseek',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    });
    const turn = await window.codex.request('turn/start', {
      threadId: thread.thread.id,
      model: 'deepseek-flash',
      approvalPolicy: 'never',
      effort: 'high',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [
        { type: 'text', text: 'What number is shown in this image? Reply with just the number.', text_elements: [] },
        { type: 'localImage', path: 'D:/MyWorkspace/codex-deepseek/image-test.png' }
      ]
    });
    return { threadId: thread.thread.id, turnId: turn.turn.id };
  })()`);
  console.log('started:', JSON.stringify(started));

  await sleep(35000);
  console.log(
    'last reply:',
    await evaluate("[...document.querySelectorAll('.message.assistant .markdown')].pop()?.textContent || ''"),
  );
  console.log('usage:', await evaluate("document.querySelector('.usage-line')?.textContent || ''"));
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});