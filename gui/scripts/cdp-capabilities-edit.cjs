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
  async function setValue(selector, value) {
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
  }

  await send('Runtime.enable', {});
  await send('Page.enable', {});

  await evaluate("document.querySelectorAll('.sidebar-actions button')[0]?.click(); 'opened'");
  await sleep(1600);

  const skillsBefore = await evaluate(
    "document.querySelectorAll('.cap-section')[1]?.querySelector('.cap-btn')?.textContent || ''",
  );
  console.log('skill button before:', skillsBefore);
  await evaluate(
    "document.querySelectorAll('.cap-section')[1]?.querySelector('.cap-btn')?.click(); 'toggled'",
  );
  await sleep(1400);
  const skillsAfter = await evaluate(
    "document.querySelectorAll('.cap-section')[1]?.querySelector('.cap-btn')?.textContent || ''",
  );
  console.log('skill button after:', skillsAfter);
  await evaluate(
    "document.querySelectorAll('.cap-section')[1]?.querySelector('.cap-btn')?.click(); 'restored'",
  );
  await sleep(1400);
  const skillsRestored = await evaluate(
    "document.querySelectorAll('.cap-section')[1]?.querySelector('.cap-btn')?.textContent || ''",
  );
  console.log('skill button restored:', skillsRestored);

  await setValue('.mcp-form input:nth-of-type(1)', 'mcptest');
  await setValue('.mcp-form input:nth-of-type(2)', 'node');
  await setValue('.mcp-form input:nth-of-type(3)', '');
  await setValue('.mcp-form textarea', '');
  await sleep(300);
  await evaluate("document.querySelector('.mcp-form button.primary')?.click(); 'saved'");
  await sleep(2200);
  const mcpText = await evaluate(
    "document.querySelector('.capabilities-card')?.textContent?.includes('mcptest') || false",
  );
  console.log('mcp test saved/visible:', mcpText);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(
    'D:/MyWorkspace/codex-deepseek/gui/caps2.png',
    Buffer.from(shot.result.data, 'base64'),
  );
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});