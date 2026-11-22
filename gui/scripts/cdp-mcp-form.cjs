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
  async function setInput(index, value) {
    return evaluate(`(() => {
      const inputs = document.querySelectorAll('.mcp-form input');
      const el = inputs[${index}];
      if (!el) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
  }

  await send('Runtime.enable', {});
  await evaluate("document.querySelectorAll('.sidebar-actions button')[0]?.click(); 'opened'");
  await sleep(1500);
  console.log('fill name:', await setInput(0, 'mcptest2'));
  console.log('fill command:', await setInput(1, 'node'));
  console.log('fill args:', await setInput(2, '-e process.exit(0)'));
  await sleep(400);
  console.log(
    'save click:',
    await evaluate("(() => { const b = document.querySelector('.mcp-form button.primary'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()"),
  );
  await sleep(10000);
  console.log(
    'modal state:',
    await evaluate(`(() => {
      const card = document.querySelector('.capabilities-card');
      return {
        loading: !!card?.querySelector('.cap-loading'),
        hasTest: card?.textContent?.includes('mcptest2') || false,
        error: document.querySelector('.error-toast')?.textContent || null
      };
    })()`),
  );
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});