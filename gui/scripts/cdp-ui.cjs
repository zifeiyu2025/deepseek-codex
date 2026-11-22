const http = require('node:http');
const fs = require('node:fs');

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
  await send('Page.enable', {});
  async function screenshot(path) {
    const response = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(response.result.data, 'base64'));
  }

  console.log(
    'capabilities click:',
    await evaluate("document.querySelectorAll('.sidebar-actions button')[0]?.click(); 'clicked'"),
  );
  await sleep(1800);
  await screenshot('D:/MyWorkspace/codex-deepseek/gui/caps.png');
  console.log(
    'capabilities content:',
    await evaluate(`(() => {
      const card = document.querySelector('.capabilities-card');
      if (!card) return 'missing';
      return { rows: card.querySelectorAll('.cap-row').length, empty: card.querySelectorAll('.cap-empty').length, text: card.textContent.slice(0, 200) };
    })()`),
  );

  await sleep(200);
  console.log(
    'capabilities close:',
    await evaluate("document.querySelector('.capabilities-card .key-actions .primary')?.click(); 'closed'"),
  );
  await sleep(400);

  console.log(
    'resume first thread:',
    await evaluate("document.querySelector('.thread-wrap .thread')?.click(); 'clicked'"),
  );
  await sleep(1400);
  console.log(
    'toggle review:',
    await evaluate("document.querySelector('.icon-btn')?.click(); 'toggled'"),
  );
  await sleep(700);
  await screenshot('D:/MyWorkspace/codex-deepseek/gui/review.png');
  console.log(
    'review content:',
    await evaluate(`(() => {
      const panel = document.querySelector('.review-panel');
      if (!panel) return 'missing';
      return { blocks: panel.querySelectorAll('.change-block').length, text: panel.textContent.slice(0, 160) };
    })()`),
  );
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});