const http = require('node:http');

const port = Number(process.argv[2] || 9222);
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
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
  if (!page) throw new Error(`page not found on port ${port}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable', {});

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ||
          response.result.exceptionDetails.text,
      );
    }
    return response.result?.result?.value;
  }

  const failures = [];
  const check = (name, condition, detail = '') => {
    if (condition) {
      console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`);
    } else {
      failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
      console.log(`FAIL ${name}${detail ? ` · ${detail}` : ''}`);
    }
  };

  const boot = JSON.parse(
    await evaluate(
      "JSON.stringify({titlebar:!!document.querySelector('.titlebar'),online:document.querySelector('.statusbar')?.classList.contains('ready'),nav:[...document.querySelectorAll('.nav-row')].map(e=>e.textContent.trim()),composer:!!document.querySelector('.composer textarea'),model:!!document.querySelector('.model-pill'),theme:document.documentElement.dataset.theme||''})",
    ),
  );
  check('无边框标题栏', boot.titlebar);
  check('引擎在线', boot.online);
  check('侧栏导航', ['新对话', '插件', '定时任务'].every((item) => boot.nav.some((text) => text.includes(item))), boot.nav.join(' / '));
  check('输入框与模型选择器', boot.composer && boot.model);
  check('主题标记', Boolean(boot.theme), boot.theme);

  const protocol = JSON.parse(
    await evaluate(`(async () => {
      const list = await window.codex.request('thread/list', { limit: 5 });
      const modes = await window.codex.request('collaborationMode/list', {});
      const projects = await window.codex.request('project/list', { limit: 5 });
      const sandbox = await window.codex.request('windowsSandbox/readiness', {}).catch((error) => ({ error: error.message }));
      return JSON.stringify({
        threads: Array.isArray(list.data),
        modes: Array.isArray(modes.data) && modes.data.length > 0,
        projects: Array.isArray(projects.data),
        sandbox: sandbox.status || sandbox.error || 'unknown',
      });
    })()`),
  );
  check('thread/list 协议', protocol.threads);
  check('collaborationMode/list 协议', protocol.modes);
  check('project/list 协议', protocol.projects);
  check('Windows 沙箱就绪查询', Boolean(protocol.sandbox), protocol.sandbox);

  const terminalOpen = await evaluate("!!document.querySelector('.terminal-dock')");
  if (!terminalOpen) {
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
    );
    await sleep(2500);
  }
  const terminal = JSON.parse(
    await evaluate(
      "JSON.stringify({dock:!!document.querySelector('.terminal-dock'),xterm:!!document.querySelector('.xterm'),bg:!!document.querySelector('.terminal-bg-toggle')})",
    ),
  );
  check('PTY 终端挂载', terminal.dock && terminal.xterm);
  check('后台终端入口', terminal.bg);
  if (!terminalOpen && terminal.dock) {
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
    );
    await sleep(500);
  }

  await evaluate("document.querySelector('.account-settings')?.click(); true");
  await sleep(200);
  await evaluate("[...document.querySelectorAll('.account-menu button')].find(b=>b.textContent.includes('设置'))?.click(); true");
  await sleep(700);
  const settingsTabs = await evaluate(
    "[...document.querySelectorAll('.settings-nav-item')].map(e=>e.textContent)",
  );
  check(
    '设置中心页签',
    ['通用', '外观', '通知', '实验功能', '快捷键', '诊断', '关于'].every((tab) =>
      settingsTabs.includes(tab),
    ),
    settingsTabs.join(' / '),
  );
  await evaluate("document.querySelector('.settings-back')?.click(); true");
  await sleep(500);

  await evaluate(
    "[...document.querySelectorAll('.nav-row')].find(e=>e.textContent.includes('插件'))?.click(); true",
  );
  await sleep(2500);
  const capabilitySections = await evaluate(
    "[...document.querySelectorAll('.cap-section .setting-label')].map(e=>e.textContent)",
  );
  check(
    '能力面板区块',
    ['MCP 服务器', '插件', 'Hooks', '模型'].every((label) =>
      capabilitySections.includes(label),
    ),
    capabilitySections.join(' / '),
  );
  check('插件市场表单', await evaluate("!!document.querySelector('.marketplace-form')"));
  await evaluate("document.querySelector('.plugins-page .page-ghost')?.click(); true");
  await sleep(400);

  socket.close();
  if (failures.length > 0) {
    console.error(`\nSMOKE_FAILED ${failures.length} 项`);
    process.exit(1);
  }
  console.log('\nSMOKE_PASS');
})().catch((error) => {
  console.error('SMOKE_ERROR', error.message);
  process.exit(1);
});
