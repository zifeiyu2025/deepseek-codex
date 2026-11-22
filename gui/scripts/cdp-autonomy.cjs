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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  console.log('open settings:', await evaluate("document.querySelector('.policy')?.click(); 'ok'"));
  await sleep(400);
  console.log(
    'select autonomy:',
    await evaluate(`(() => {
      const target = [...document.querySelectorAll('.setting-option')].find((el) => el.textContent.includes('自主执行'));
      if (!target) return 'missing';
      target.click();
      return 'selected';
    })()`),
  );
  await sleep(300);
  console.log(
    'save settings:',
    await evaluate("document.querySelector('.settings-card .key-actions .primary')?.click(); 'saved'"),
  );
  await sleep(400);
  console.log('stored settings:', await evaluate("localStorage.getItem('deepseek-codex.settings')"));
  console.log('policy chip:', await evaluate("document.querySelector('.policy')?.textContent"));

  console.log(
    'fill composer:',
    await evaluate(`(() => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'Use the apply_patch tool to create a file named AUTONOMY_DEMO.txt containing exactly one line: autonomous ok. Then run the shell command whoami. Finally reply with DONE.');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`),
  );
  await sleep(600);
  console.log(
    'send:',
    await evaluate("(() => { const b = document.querySelector('.composer .send'); if (!b || b.disabled) return 'disabled'; b.click(); return 'clicked'; })()"),
  );
  await sleep(800);
  console.log('thread active:', await evaluate("document.querySelector('.thread.active .thread-preview')?.textContent || ''"));
  socket.close();
})().catch((error) => {
  console.error('CDP_ERROR', error.message);
  process.exit(1);
});