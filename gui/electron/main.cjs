const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  clipboard,
  Notification,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const { spawn, execFile, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pty = null;
try {
  pty = require('node-pty');
} catch (error) {
  console.error('node-pty unavailable:', error);
}

const ROOT = path.resolve(__dirname, '..');
const APP_ENTRY_URL = pathToFileURL(path.join(ROOT, 'dist', 'index.html')).href;
const ALLOWED_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/fork',
  'thread/list',
  'thread/search',
  'thread/searchOccurrences',
  'thread/turns/list',
  'thread/items/list',
  'thread/prepareApprovedPlan',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/backgroundTerminals/clean',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/name/set',
  'thread/readState/update',
  'thread/archive',
  'thread/unarchive',
  'thread/delete',
  'thread/compact/start',
  'thread/goal/get',
  'thread/goal/set',
  'thread/goal/clear',
  'thread/revert',
  'threadSection/list',
  'threadSection/create',
  'threadSection/update',
  'threadSection/delete',
  'thread/section/move',
  'project/list',
  'project/read',
  'project/create',
  'project/import',
  'project/update',
  'project/delete',
  'project/move',
  'review/start',
  'model/list',
  'modelProvider/list',
  'collaborationMode/list',
  'experimentalFeature/list',
  'experimentalFeature/enablement/set',
  'fuzzyFileSearch',
  'mcpServerStatus/list',
  'mcpServer/oauth/login',
  'mcpServer/tool/call',
  'mcpServer/resource/read',
  'windowsSandbox/readiness',
  'windowsSandbox/setupStart',
  'skills/list',
  'plugin/list',
  'plugin/install',
  'plugin/uninstall',
  'plugin/search',
  'plugin/read',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'config/mcpServer/reload',
  'hooks/list',
  'skills/config/write',
  'config/read',
  'config/batchWrite',
]);

const THREAD_CONFIG_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

let win = null;
let tray = null;
let child = null;
let rpc = null;
let online = false;
let lastError = null;
let initPromise = null;
let restartTimer = null;
let restartAttempts = 0;
let engineStopping = false;
let engineEpoch = 0;
let engineStartPromise = null;
let engineStableTimer = null;
let appQuitting = false;
let apiKey = null;
const serverLog = [];
const MAX_SERVER_LOG_CHARS = 256 * 1024;
let serverLogChars = 0;
const terminals = new Map();
let terminalSeq = 0;
let browserGuest = null;
let browserWaiters = [];
let browserBridge = null;
let browserBridgeToken = '';

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function configureUserData() {
  const appData = app.getPath('appData');
  const profile = process.env.PORTABLE_EXECUTABLE_DIR
    ? 'DeepSeek Codex Portable'
    : app.isPackaged
      ? 'DeepSeek Codex'
      : 'DeepSeek Codex Dev';
  const target = process.env.DEEPSEEK_CODEX_USER_DATA
    ? path.resolve(process.env.DEEPSEEK_CODEX_USER_DATA)
    : path.join(appData, profile);
  app.setPath('userData', target);
  fs.mkdirSync(target, { recursive: true });
  const legacyDirs = [path.join(appData, 'DeepSeek Codex'), path.join(appData, 'deepseek-codex-gui')];
  for (const legacy of legacyDirs) {
    if (path.resolve(legacy) === path.resolve(target)) continue;
    for (const name of ['deepseek.key', 'window-state.json', 'Local State']) {
      const source = path.join(legacy, name);
      const destination = path.join(target, name);
      try {
        if (fs.existsSync(source) && !fs.existsSync(destination)) {
          fs.copyFileSync(source, destination);
        }
      } catch {
        /* migration is best-effort */
      }
    }
  }
}

function appendMainLog(message) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        const previous = path.join(dir, 'main.log.1');
        try {
          fs.unlinkSync(previous);
        } catch {
          /* ignore */
        }
        fs.renameSync(file, previous);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never break the app */
  }
}

configureUserData();
process.on('uncaughtException', (error) => {
  appendMainLog(`uncaughtException: ${error?.stack || error}`);
});
process.on('unhandledRejection', (reason) => {
  appendMainLog(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

function apiKeyFile() {
  return path.join(app.getPath('userData'), 'deepseek.key');
}

function localToolsPrefsFile() {
  return path.join(app.getPath('userData'), 'ai-tools.json');
}

function localMcpScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'shanui-local-mcp.cjs')
    : path.join(ROOT, 'mcp', 'shanui-local-mcp.cjs');
}

function readLocalToolsPrefs() {
  const fallback = { browser: false, computer: false, search: false };
  try {
    const saved = JSON.parse(fs.readFileSync(localToolsPrefsFile(), 'utf8'));
    return {
      browser: Boolean(saved?.browser),
      computer: Boolean(saved?.computer),
      search: Boolean(saved?.search),
    };
  } catch {
    return fallback;
  }
}

function localMcpServerConfig(prefs) {
  if (!prefs.browser && !prefs.computer && !prefs.search) return null;
  return {
    command: process.execPath,
    args: [localMcpScriptPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      SHANUI_BRIDGE_FILE: browserBridgeFile(),
      SHANUI_ENABLE_BROWSER: prefs.browser ? '1' : '0',
      SHANUI_ENABLE_COMPUTER: prefs.computer ? '1' : '0',
      SHANUI_ENABLE_WEB_SEARCH: prefs.search ? '1' : '0',
    },
    default_tools_approval_mode: 'prompt',
    tool_timeout_sec: 60,
  };
}

function withLocalMcpConfig(method, params) {
  if (!THREAD_CONFIG_METHODS.has(method)) return params;
  const server = localMcpServerConfig(readLocalToolsPrefs());
  if (!server) return params;
  const config = { ...(params?.config || {}) };
  config['mcp_servers.shanui_local'] = server;
  return { ...(params || {}), config };
}

async function loadApiKey() {
  try {
    const file = apiKeyFile();
    if (!fs.existsSync(file)) return;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      appendMainLog('api key present but safeStorage is unavailable');
      return;
    }
    const encrypted = await fs.promises.readFile(file);
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    apiKey = decrypted.result;
    if (decrypted.shouldReEncrypt) {
      try {
        const refreshed = await safeStorage.encryptStringAsync(decrypted.result);
        await fs.promises.writeFile(file, refreshed);
      } catch {
        /* keep the readable key even if re-encryption fails */
      }
    }
    appendMainLog('api key loaded');
  } catch (error) {
    apiKey = null;
    appendMainLog(`api key load failed: ${error?.message || error}`);
  }
}

function hasApiKey() {
  return Boolean(apiKey || process.env.DEEPSEEK_API_KEY);
}

function resolveCodexBin() {
  const candidates = [
    process.env.CODEX_BIN,
    process.env.PORTABLE_EXECUTABLE_DIR
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'codex.exe')
      : null,
    path.join(path.dirname(app.getPath('exe')), 'codex.exe'),
    path.join(process.resourcesPath || '', 'codex', 'codex.exe'),
    'D:/MyWorkspace/codex-deepseek/dist/codex.exe',
    path.join(ROOT, '..', 'dist', 'codex.exe'),
    path.join(ROOT, '..', 'codex-src', 'codex-rs', 'target', 'release', 'codex.exe'),
    path.join(ROOT, '..', 'codex-src', 'codex-rs', 'target', 'debug', 'codex.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function loadModels() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(codexHome, 'models.json'), 'utf8'));
    return (data.models || [])
      .filter((model) => !model.visibility || model.visibility === 'list')
      .map((model) => ({
        slug: model.slug,
        display_name: model.display_name || model.slug,
        description: model.description || '',
        context_window: model.context_window ?? null,
        input_modalities: model.input_modalities || ['text'],
        reasoning_levels: (model.supported_reasoning_levels || []).map((level) => level.effort),
      }));
  } catch {
    return [];
  }
}

function loadConfigDefaults() {
  let model = 'deepseek-flash';
  let provider = 'deepseek';
  try {
    const raw = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const modelMatch = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const providerMatch = raw.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    if (modelMatch) model = modelMatch[1];
    if (providerMatch) provider = providerMatch[1];
  } catch {
    /* defaults */
  }
  return { model, provider };
}

function defaultWorkspace() {
  const documents = path.join(os.homedir(), 'Documents');
  try {
    if (fs.statSync(documents).isDirectory()) return documents;
  } catch {
    /* ignore */
  }
  return os.homedir();
}

const allowedRoots = new Set();
function addAllowedRoot(value) {
  if (typeof value !== 'string' || !value) return;
  try {
    allowedRoots.add(fs.realpathSync.native(path.resolve(value)));
  } catch {
    /* only existing roots can be trusted */
  }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathAllowed(target, message = '路径不在允许范围') {
  if (![...allowedRoots].some((root) => isPathInside(root, target))) {
    throw new Error(message);
  }
}

function collectAllowedRoots(method, result) {
  if (!result || typeof result !== 'object') return;
  const add = (value) => addAllowedRoot(value);
  if (method === 'project/list' || method === 'project/read') {
    const projects = Array.isArray(result.data)
      ? result.data
      : [result.project ?? result];
    for (const project of projects) {
      for (const root of project?.roots ?? []) add(root?.path);
    }
  }
  if (method.startsWith('thread/')) {
    const visit = (thread) => add(thread?.cwd);
    visit(result.thread);
    visit(result);
    if (Array.isArray(result.data)) result.data.forEach(visit);
  }
}

const attachmentsDir = path.join(app.getPath('temp'), 'deepseek-codex-attachments');
const worktreesRoot = path.join(codexHome, 'worktrees');
try {
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(worktreesRoot, { recursive: true });
} catch {
  /* ignore */
}
addAllowedRoot(codexHome);
addAllowedRoot(app.getPath('userData'));
addAllowedRoot(defaultWorkspace());
addAllowedRoot(worktreesRoot);
addAllowedRoot(attachmentsDir);
for (const name of ['Desktop', 'Downloads', 'Pictures']) {
  addAllowedRoot(path.join(os.homedir(), name));
}

class RpcClient {
  constructor(processHandle) {
    this.child = processHandle;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = {};
    this.buffer = '';
    this.closed = false;

    processHandle.stdin.on('error', (error) => this.fail(error, -1));
    processHandle.stdout.setEncoding('utf8');
    processHandle.stdout.on('error', (error) => this.fail(error, -1));
    processHandle.stdout.on('data', (chunk) => this.onData(chunk));
    processHandle.stderr.setEncoding('utf8');
    processHandle.stderr.on('error', () => {});
    processHandle.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        const trimmed = line.length > 8192 ? line.slice(0, 8192) : line;
        serverLog.push(trimmed);
        serverLogChars += trimmed.length;
        while (
          serverLog.length > 300 ||
          (serverLogChars > MAX_SERVER_LOG_CHARS && serverLog.length > 1)
        ) {
          serverLogChars -= serverLog.shift().length;
        }
      }
    });
    processHandle.on('error', (error) => this.fail(error, -1));
    processHandle.on('exit', (code) => this.fail(new Error('app-server exited'), code));
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason || 'app-server closed');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  fail(error, code) {
    if (this.closed) return;
    this.close(error.message);
    this.handlers.exit?.(code, error);
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.fail(new Error('app-server output exceeded 8MB without a newline'), -1);
      return;
    }
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.startsWith('{')) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  handle(message) {
    if (
      message.id !== undefined &&
      ('result' in message || 'error' in message) &&
      this.pending.has(message.id)
    ) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handlers.serverRequest?.(message);
      return;
    }
    if (message.method) {
      this.handlers.notification?.(message);
    }
  }

  request(method, params, timeoutMs = 180000) {
    if (this.closed) return Promise.reject(new Error('app-server is not running'));
    const id = this.nextId++;
    const payload =
      JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const onWrite = (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error);
      };
      try {
        this.child.stdin.write(payload, onWrite);
      } catch (error) {
        onWrite(error);
      }
    });
  }

  respond(id, result, error) {
    if (this.closed) return;
    const message = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? {} };
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n', () => {});
    } catch {
      /* engine already gone */
    }
  }
}

function isTrustedSender(event) {
  if (!win || event.sender !== win.webContents) return false;
  const url = event.senderFrame?.url || '';
  return url.split('#')[0].split('?')[0] === APP_ENTRY_URL;
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error('unauthorized IPC sender');
}

function handleIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });
}

const pendingRendererMessages = [];
const MAX_PENDING_RENDERER_MESSAGES = 500;
let rendererReady = false;

function sendToRenderer(channel, payload) {
  if (appQuitting) return;
  if (!rendererReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) {
    if (channel === 'app:status' || channel === 'window:maximized') {
      const existing = pendingRendererMessages.findIndex((item) => item.channel === channel);
      if (existing >= 0) pendingRendererMessages.splice(existing, 1);
    }
    pendingRendererMessages.push({ channel, payload });
    while (pendingRendererMessages.length > MAX_PENDING_RENDERER_MESSAGES) {
      const removable = pendingRendererMessages.findIndex(
        (item) => item.channel !== 'rpc:serverRequest' && item.channel !== 'app:status',
      );
      if (removable < 0) break;
      pendingRendererMessages.splice(removable, 1);
    }
    return;
  }
  win.webContents.send(channel, payload);
}

function flushRendererMessages() {
  rendererReady = true;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const queued = pendingRendererMessages.splice(0, pendingRendererMessages.length);
  for (const item of queued) {
    win.webContents.send(item.channel, item.payload);
  }
}

function broadcastStatus() {
  sendToRenderer('app:status', { online, error: lastError });
}

function browserBridgeFile() {
  return path.join(codexHome, 'shanui-bridge.json');
}

function attachBrowserGuest(contents) {
  browserGuest = contents;
  contents.once('destroyed', () => {
    if (browserGuest === contents) browserGuest = null;
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      contents.loadURL(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  const waiters = browserWaiters;
  browserWaiters = [];
  for (const resolve of waiters) resolve();
}

async function ensureBrowserGuest() {
  if (browserGuest && !browserGuest.isDestroyed()) return browserGuest;
  sendToRenderer('browser:open');
  if (browserGuest && !browserGuest.isDestroyed()) return browserGuest;
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      browserWaiters = browserWaiters.filter((entry) => entry !== finish);
      resolve();
    };
    const timer = setTimeout(() => {
      browserWaiters = browserWaiters.filter((entry) => entry !== finish);
      reject(new Error('浏览器面板未能打开'));
    }, 10000);
    browserWaiters.push(finish);
  });
  if (!browserGuest || browserGuest.isDestroyed()) throw new Error('浏览器面板未就绪');
  return browserGuest;
}

async function guestInput(guest, method, params) {
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
  return guest.debugger.sendCommand(method, params);
}

async function prepareGuestInput(guest) {
  await guestInput(guest, 'Page.bringToFront');
  await guestInput(guest, 'Emulation.setFocusEmulationEnabled', { enabled: true });
}

const GUEST_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

async function guestPressKey(guest, key) {
  const spec = GUEST_KEYS[key];
  if (!spec) throw new Error('不支持的按键');
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
  };
  await guestInput(guest, 'Input.dispatchKeyEvent', {
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await guestInput(guest, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function navigateBrowserGuest(guest, raw) {
  const url = parseHttpUrl(raw);
  await guest.loadURL(url);
  return url;
}

function parseHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(typeof raw === 'string' ? raw.trim() : '');
  } catch {
    throw new Error('无效 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅允许 http/https 地址');
  }
  return parsed.toString();
}

let webWorker = null;
let webWorkerQueue = Promise.resolve();
let webWorkerIdleTimer = null;

function ensureWebWorker() {
  if (webWorker && !webWorker.isDestroyed()) return webWorker;
  const worker = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    webPreferences: {
      partition: 'persist:shanui-web-tools',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  worker.webContents.setAudioMuted(true);
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.on('will-attach-webview', (event) => event.preventDefault());
  worker.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  worker.webContents.session.setPermissionCheckHandler(() => false);
  worker.on('closed', () => {
    if (webWorker === worker) webWorker = null;
  });
  webWorker = worker;
  return worker;
}

function scheduleWebWorkerDispose() {
  if (webWorkerIdleTimer) clearTimeout(webWorkerIdleTimer);
  webWorkerIdleTimer = setTimeout(() => {
    webWorkerIdleTimer = null;
    if (webWorker && !webWorker.isDestroyed()) webWorker.destroy();
    webWorker = null;
  }, 60000);
  webWorkerIdleTimer.unref?.();
}

function runWebWorker(url, script, settleMs) {
  const job = async () => {
    const worker = ensureWebWorker();
    if (webWorkerIdleTimer) {
      clearTimeout(webWorkerIdleTimer);
      webWorkerIdleTimer = null;
    }
    let timer = null;
    try {
      await Promise.race([
        worker.loadURL(url),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('页面加载超时')), 30000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (!webWorker || webWorker.isDestroyed()) throw new Error('后台浏览器已关闭');
    return webWorker.webContents.executeJavaScript(script, true);
  };
  const next = webWorkerQueue.then(job, job);
  webWorkerQueue = next.catch(() => {});
  return next.finally(() => scheduleWebWorkerDispose());
}

async function handleBrowserTool(tool, args) {
  if (tool === 'web_search') {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('缺少搜索关键词');
    const limit = Math.max(1, Math.min(10, Number(args?.count) || 6));
    const searchUrl = `https://cn.bing.com/search?setlang=zh-Hans&q=${encodeURIComponent(query)}`;
    const data = await runWebWorker(
      searchUrl,
      `(() => {
        const limit = ${limit};
        const blocks = [...document.querySelectorAll('li.b_algo, div.result, div.c-container, div.vrwrap')];
        const results = [];
        const seen = new Set();
        for (const block of blocks) {
          if (results.length >= limit) break;
          const link = block.querySelector('h2 a, h3 a');
          if (!link) continue;
          const href = link.href || '';
          if (!/^https?:/i.test(href) || seen.has(href)) continue;
          const title = ((link.innerText || link.textContent || '') + '').replace(/\\s+/g, ' ').trim();
          if (!title) continue;
          const snippetEl = block.querySelector('.b_caption p, .b_lineclamp1, .b_lineclamp2, .b_lineclamp3, .c-abstract, .str_info, .str-text, [class*="summary"], [class*="desc"]');
          const snippet = (snippetEl ? snippetEl.innerText || '' : (block.innerText || '').replace(title, ''))
            .replace(/\\s+/g, ' ')
            .trim()
            .slice(0, 300);
          seen.add(href);
          results.push({ title: title.slice(0, 200), url: href, snippet });
        }
        return { title: document.title, url: location.href, results };
      })()`,
      400,
    );
    if (!data?.results?.length) throw new Error('未找到搜索结果');
    return {
      type: 'text',
      text: JSON.stringify({ query, engine: 'bing', results: data.results }, null, 2),
    };
  }
  if (tool === 'web_fetch') {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!raw) throw new Error('缺少目标 URL');
    const maxChars = Math.max(1000, Math.min(30000, Number(args?.maxChars) || 12000));
    const url = parseHttpUrl(raw);
    const data = await runWebWorker(
      url,
      `(() => {
        const maxChars = ${maxChars};
        const candidates = [...document.querySelectorAll('article, main, [role="main"]')];
        candidates.push(document.body);
        const root = candidates
          .filter(Boolean)
          .sort((a, b) => ((b.innerText || '').length - (a.innerText || '').length))[0];
        if (!root) return { title: document.title, url: location.href, description: '', content: '' };
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, canvas, iframe, header, nav, footer, aside, form, button').forEach((el) => el.remove());
        const content = (clone.innerText || clone.textContent || '')
          .replace(/\\r/g, '')
          .replace(/[ \\t]+/g, ' ')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim()
          .slice(0, maxChars);
        const description = document.querySelector('meta[name="description"]')?.content || '';
        return {
          title: document.title,
          url: location.href,
          description: (description + '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          content,
        };
      })()`,
      500,
    );
    if (!data?.content) throw new Error('页面没有可读取的正文');
    return {
      type: 'text',
      text: JSON.stringify({ ...data, requestedUrl: url }, null, 2),
    };
  }
  const guest = await ensureBrowserGuest();
  if (tool === 'open_browser') {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!raw) {
      let current = '';
      try {
        current = guest.getURL() || '';
      } catch {
        /* guest may not have navigated yet */
      }
      return { type: 'text', text: `内置浏览器已打开${current ? `：${current}` : ''}` };
    }
    const url = await navigateBrowserGuest(guest, raw);
    return { type: 'text', text: `已打开内置浏览器：${url}` };
  }
  if (tool === 'browser_navigate') {
    const url = await navigateBrowserGuest(guest, args?.url);
    return { type: 'text', text: `已导航到 ${url}` };
  }
  if (tool === 'browser_snapshot') {
    const data = await guest.executeJavaScript(
      `(() => {
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const candidates = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]')];
        const elements = [];
        let seq = window.__shanuiRefSeq || 0;
        for (const el of candidates) {
          if (elements.length >= 120) break;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
          if (rect.bottom < 0 || rect.top > innerHeight * 2) continue;
          let ref = el.getAttribute('data-shanui-ref');
          if (!ref || !/^e\\d+$/.test(ref)) {
            do {
              seq += 1;
              ref = 'e' + seq;
            } while (document.querySelector('[data-shanui-ref="' + ref + '"]'));
            el.setAttribute('data-shanui-ref', ref);
          }
          elements.push({
            ref,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            text: ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 120),
            bbox: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) },
          });
        }
        window.__shanuiRefSeq = seq;
        return { title: document.title, url: location.href, text: text.slice(0, 12000), elements };
      })()`,
      true,
    );
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (tool === 'browser_click') {
    const spec = JSON.stringify({
      ref: typeof args?.ref === 'string' ? args.ref : null,
      selector: typeof args?.selector === 'string' ? args.selector : null,
      text: typeof args?.text === 'string' ? args.text : null,
      x: Number.isFinite(Number(args?.x)) ? Number(args.x) : null,
      y: Number.isFinite(Number(args?.y)) ? Number(args.y) : null,
    });
    const target = await guest.executeJavaScript(
      `(() => {
        const spec = ${spec};
        if (spec.x !== null && spec.y !== null) return { x: spec.x, y: spec.y, text: '坐标点击' };
        const candidates = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]')];
        let el = null;
        if (spec.ref) el = document.querySelector('[data-shanui-ref="' + CSS.escape(spec.ref) + '"]');
        if (!el && spec.selector) el = document.querySelector(spec.selector);
        if (!el && spec.text) {
          const wanted = spec.text.trim();
          el = candidates.find((entry) => ((entry.innerText || entry.value || entry.getAttribute('aria-label') || '') + '').trim() === wanted)
            || candidates.find((entry) => ((entry.innerText || entry.value || entry.getAttribute('aria-label') || '') + '').includes(wanted));
        }
        if (!el) throw new Error('未找到目标元素');
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          text: ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        };
      })()`,
      true,
    );
    await prepareGuestInput(guest);
    await guestInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await guestInput(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
    await guestInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
    return { type: 'text', text: `已点击 ${JSON.stringify({ text: target.text, x: target.x, y: target.y })}` };
  }
  if (tool === 'browser_type') {
    const nextText = typeof args?.text === 'string' ? args.text : '';
    const spec = JSON.stringify({
      ref: typeof args?.ref === 'string' ? args.ref : null,
      selector: typeof args?.selector === 'string' ? args.selector : null,
      text: nextText,
      clear: args?.clear !== false,
      submit: Boolean(args?.submit),
    });
    await guest.executeJavaScript(
      `(() => {
        const spec = ${spec};
        let el = null;
        if (spec.ref) el = document.querySelector('[data-shanui-ref="' + CSS.escape(spec.ref) + '"]');
        if (!el && spec.selector) el = document.querySelector(spec.selector);
        if (!el && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) el = document.activeElement;
        if (!el) throw new Error('未找到输入元素');
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        if (spec.clear && !el.isContentEditable) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (spec.clear && el.isContentEditable) {
          el.textContent = '';
        }
        return true;
      })()`,
      true,
    );
    await prepareGuestInput(guest);
    guest.focus?.();
    await guest.insertText(nextText);
    if (args?.submit) await guestPressKey(guest, 'enter');
    return { type: 'text', text: `已输入 ${nextText.length} 个字符` };
  }
  if (tool === 'browser_press_key') {
    const key = typeof args?.key === 'string' ? args.key.toLowerCase() : '';
    await prepareGuestInput(guest);
    await guestPressKey(guest, key);
    return { type: 'text', text: `已按下 ${GUEST_KEYS[key].key}` };
  }
  if (tool === 'browser_scroll') {
    const direction = args?.direction === 'up' ? -1 : 1;
    const pages = Math.max(1, Math.min(10, Number(args?.pages) || 1));
    await guest.executeJavaScript(`window.scrollBy(0, ${direction * pages * window.innerHeight * 0.85}); true`, true);
    return { type: 'text', text: `已向${direction < 0 ? '上' : '下'}滚动 ${pages} 屏` };
  }
  if (tool === 'browser_back') {
    if (guest.navigationHistory?.canGoBack()) guest.navigationHistory.goBack();
    else guest.goBack();
    return { type: 'text', text: '已后退' };
  }
  if (tool === 'browser_forward') {
    if (guest.navigationHistory?.canGoForward()) guest.navigationHistory.goForward();
    else guest.goForward();
    return { type: 'text', text: '已前进' };
  }
  if (tool === 'browser_reload') {
    guest.reload();
    return { type: 'text', text: '已刷新页面' };
  }
  if (tool === 'browser_wait') {
    const ms = Math.max(100, Math.min(10000, Number(args?.ms) || 1000));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { type: 'text', text: `已等待 ${ms}ms` };
  }
  if (tool === 'browser_screenshot') {
    let image = await guest.capturePage();
    if (image.isEmpty()) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      image = await guest.capturePage();
    }
    if (image.isEmpty()) throw new Error('页面截图为空，请稍后重试');
    return {
      type: 'image',
      mimeType: 'image/png',
      data: image.toPNG().toString('base64'),
    };
  }
  throw new Error(`未知浏览器工具：${tool}`);
}

function startBrowserBridge() {
  if (browserBridge) return;
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/command') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers['x-shanui-token'] !== token) {
      response.writeHead(403);
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) request.destroy();
    });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await handleBrowserTool(payload.tool, payload.args || {});
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
    });
  });
  server.on('error', (error) => appendMainLog(`browser bridge error: ${error.message}`));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    try {
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(browserBridgeFile(), JSON.stringify({ port: address.port, token }), {
        mode: 0o600,
      });
      appendMainLog(`browser bridge listening on 127.0.0.1:${address.port}`);
    } catch (error) {
      appendMainLog(`browser bridge discovery failed: ${error?.message || error}`);
    }
  });
  browserBridge = server;
  browserBridgeToken = token;
}

function stopBrowserBridge() {
  if (browserBridge) {
    try {
      browserBridge.close();
    } catch {
      /* ignore */
    }
    browserBridge = null;
  }
  browserBridgeToken = '';
  try {
    fs.unlinkSync(browserBridgeFile());
  } catch {
    /* ignore */
  }
}

function clearEngineTimers() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (engineStableTimer) {
    clearTimeout(engineStableTimer);
    engineStableTimer = null;
  }
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    process.kill(pid);
  } catch {
    /* ignore */
  }
}

function shutdownEngineNow() {
  engineStopping = true;
  engineEpoch += 1;
  clearEngineTimers();
  try {
    rpc?.close('app quitting');
  } catch {
    /* ignore */
  }
  rpc = null;
  online = false;
  initPromise = null;
  const processHandle = child;
  child = null;
  if (processHandle?.pid) killProcessTree(processHandle.pid);
}

async function stopEngine() {
  engineStopping = true;
  engineEpoch += 1;
  clearEngineTimers();
  const processHandle = child;
  const client = rpc;
  child = null;
  rpc = null;
  online = false;
  initPromise = null;
  if (!processHandle || processHandle.exitCode !== null) return;
  client?.close('app-server stopping');
  try {
    processHandle.kill();
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    processHandle.once('exit', finish);
    timer = setTimeout(() => {
      killProcessTree(processHandle.pid);
      finish();
    }, 2000);
  });
}

function scheduleEngineRestart() {
  if (engineStopping || appQuitting || restartTimer) return;
  if (restartAttempts >= 3) {
    lastError = 'app-server 连续退出，已停止自动重启；可在设置 → 诊断中手动重启';
    broadcastStatus();
    return;
  }
  restartAttempts += 1;
  const delay = 1500 * restartAttempts;
  lastError = `app-server 已退出，${Math.round(delay / 1000)} 秒后自动重启（${restartAttempts}/3）`;
  broadcastStatus();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!engineStopping && !appQuitting) void startEngine();
  }, delay);
}

async function restartEngine() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  await stopEngine();
  if (appQuitting) return;
  restartAttempts = 0;
  lastError = null;
  broadcastStatus();
  await startEngine();
}

function startEngine() {
  if (engineStartPromise) return engineStartPromise;
  const promise = startEngineInternal();
  engineStartPromise = promise;
  promise
    .finally(() => {
      if (engineStartPromise === promise) engineStartPromise = null;
    })
    .catch(() => {});
  return promise;
}

async function purgeLegacyLocalMcpConfig(client) {
  try {
    const read = await client.request('config/read', {}, 15000);
    const servers = read?.config?.mcp_servers;
    if (!servers || !Object.prototype.hasOwnProperty.call(servers, 'shanui_local')) return;
    await client.request(
      'config/batchWrite',
      {
        edits: [{ keyPath: 'mcp_servers.shanui_local', value: null, mergeStrategy: 'replace' }],
        reloadUserConfig: true,
      },
      15000,
    );
    appendMainLog('removed legacy shanui_local MCP entry from shared user config');
  } catch (error) {
    appendMainLog(`legacy local MCP cleanup failed: ${error?.message || error}`);
  }
}

async function startEngineInternal() {
  if (child) await stopEngine();
  if (appQuitting) return;
  engineStopping = false;
  const epoch = ++engineEpoch;
  clearEngineTimers();
  const bin = resolveCodexBin();
  if (!bin) {
    online = false;
    initPromise = null;
    lastError = '未找到本地 codex.exe，请先完成构建（dist/codex.exe）';
    appendMainLog('engine binary not found');
    broadcastStatus();
    return;
  }
  let processHandle;
  try {
    processHandle = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    online = false;
    lastError = `无法启动 app-server：${error.message}`;
    broadcastStatus();
    return;
  }
  if (epoch !== engineEpoch || appQuitting) {
    try {
      processHandle.kill();
    } catch {
      /* ignore */
    }
    return;
  }

  const client = new RpcClient(processHandle);
  child = processHandle;
  rpc = client;
  online = false;
  initPromise = null;
  client.on('notification', (message) => sendToRenderer('rpc:notification', message));
  client.on('serverRequest', (message) => sendToRenderer('rpc:serverRequest', message));
  client.on('exit', (code, error) => {
    if (epoch !== engineEpoch) return;
    if (rpc === client) rpc = null;
    if (child === processHandle) child = null;
    online = false;
    initPromise = null;
    if (engineStableTimer) {
      clearTimeout(engineStableTimer);
      engineStableTimer = null;
    }
    lastError = error ? `app-server 错误：${error.message}` : `app-server 已退出（code ${code}）`;
    appendMainLog(`engine exited: code=${code} error=${error?.message || ''}`);
    broadcastStatus();
    scheduleEngineRestart();
  });
  broadcastStatus();

  const init = client
    .request(
      'initialize',
      {
        clientInfo: {
          name: 'deepseek-codex-gui',
          title: 'DeepSeek Codex',
          version: app.getVersion(),
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      20000,
    )
    .then(() => {
      if (epoch !== engineEpoch) return;
      online = true;
      lastError = null;
      broadcastStatus();
      void purgeLegacyLocalMcpConfig(client);
      if (engineStableTimer) clearTimeout(engineStableTimer);
      engineStableTimer = setTimeout(() => {
        engineStableTimer = null;
        if (epoch === engineEpoch && online) restartAttempts = 0;
      }, 60000);
    })
    .catch((error) => {
      if (epoch !== engineEpoch) throw error;
      online = false;
      lastError = `app-server 初始化失败：${error.message}`;
      appendMainLog(`engine initialize failed: ${error?.stack || error}`);
      broadcastStatus();
      try {
        processHandle.kill();
      } catch {
        /* ignore */
      }
      throw error;
    });
  initPromise = init;
  init.catch(() => {});
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const fallback = { width: 1280, height: 840, maximized: false };
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const width = Number(saved.width);
    const height = Number(saved.height);
    return {
      width: Number.isFinite(width) ? Math.min(3840, Math.max(1020, width)) : fallback.width,
      height: Number.isFinite(height) ? Math.min(2400, Math.max(680, height)) : fallback.height,
      maximized: Boolean(saved.maximized),
    };
  } catch {
    return fallback;
  }
}

function saveWindowState() {
  if (!win) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      windowStateFile(),
      JSON.stringify({
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized(),
      }),
    );
  } catch {
    /* ignore */
  }
}

function openExternalUrl(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

function loadAppIcon() {
  try {
    return nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'icon.png')));
  } catch {
    return undefined;
  }
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const image = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'tray.png')));
    tray = new Tray(image);
    tray.setToolTip('DeepSeek Codex');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 DeepSeek Codex', click: () => showWindow() },
        {
          label: '新建对话',
          click: () => {
            showWindow();
            sendToRenderer('tray:action', 'new-session');
          },
        },
        {
          label: '设置',
          click: () => {
            showWindow();
            sendToRenderer('tray:action', 'settings');
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            appQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
    console.log('tray created');
  } catch (error) {
    console.error('tray unavailable:', error);
  }
}

function createWindow() {
  rendererReady = false;
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#0b0c0a',
    title: 'DeepSeek Codex',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  win.webContents.on('render-process-gone', (_event, details) => {
    appendMainLog(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    appendMainLog(`did-fail-load: code=${code} ${description} ${url}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win?.webContents.getURL()) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    if (!/^https?:\/\//i.test(params.src || '')) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    contents.session.setPermissionCheckHandler(() => false);
    attachBrowserGuest(contents);
  });
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  win.webContents.on('did-finish-load', () => {
    killAllTerminals();
    sendToRenderer('window:maximized', Boolean(win?.isMaximized()));
    broadcastStatus();
  });
  win.on('maximize', () => sendToRenderer('window:maximized', true));
  win.on('unmaximize', () => sendToRenderer('window:maximized', false));
  win.on('close', (event) => {
    saveWindowState();
    if (!appQuitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
    killAllTerminals();
  });
}

handleIpc('window:minimize', () => {
  win?.minimize();
});

handleIpc('window:toggle-maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

handleIpc('window:close', () => {
  win?.close();
});

handleIpc('window:is-maximized', () => Boolean(win?.isMaximized()));

handleIpc('app:get-config', () => {
  const defaults = loadConfigDefaults();
  return {
    appVersion: app.getVersion(),
    codexBin: resolveCodexBin(),
    codexHome,
    models: loadModels(),
    defaultModel: defaults.model,
    defaultProvider: defaults.provider,
    defaultCwd: defaultWorkspace(),
    online,
    error: lastError,
    apiKeyConfigured: hasApiKey(),
    log: serverLog.slice(-12),
  };
});

handleIpc('app:pick-folder', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  addAllowedRoot(result.filePaths[0]);
  return result.filePaths[0];
});

handleIpc('app:pick-files', async () => {
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  for (const file of result.filePaths) addAllowedRoot(path.dirname(file));
  return result.filePaths;
});

handleIpc('app:pick-images', async () => {
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (result.canceled) return [];
  for (const file of result.filePaths) addAllowedRoot(path.dirname(file));
  return result.filePaths;
});

handleIpc('app:save-pasted-image', async () => {
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((entry) => entry.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob)) continue;
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!buffer.length) continue;
    const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
    const dir = path.join(app.getPath('temp'), 'deepseek-codex-attachments');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `pasted-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`,
    );
    fs.writeFileSync(file, buffer);
    return file;
  }
  return null;
});

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'git failed').trim()));
          return;
        }
        resolve((stdout || '').trim());
      },
    );
  });
}

function assertCodexBranch(branch) {
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    !/^codex\/[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error('非法的 worktree 分支');
  }
}

handleIpc('app:create-worktree', async (_event, repoPath) => {
  const source = await realpathNearest(path.resolve(repoPath || defaultWorkspace()));
  assertPathAllowed(source, '仓库路径不在允许范围');
  const repoRoot = await runGit(['rev-parse', '--show-toplevel'], source);
  addAllowedRoot(repoRoot);
  const repoName = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '-');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(16).slice(2, 8);
  const branch = `codex/${stamp}-${suffix}`;
  const worktreeRoot = path.join(worktreesRoot, `${repoName}-${stamp}-${suffix}`);
  fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
  try {
    await runGit(['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD'], repoRoot);
  } catch (error) {
    try {
      await runGit(['branch', '-D', branch], repoRoot);
    } catch {
      /* ignore */
    }
    throw error;
  }
  return { repoRoot, path: worktreeRoot, branch };
});

handleIpc('app:worktree-apply', async (_event, payload) => {
  const repoRoot = payload?.repoRoot;
  const worktreePath = payload?.worktreePath;
  if (!repoRoot || !worktreePath) throw new Error('缺少 worktree 信息');
  const repoReal = await realpathNearest(path.resolve(repoRoot));
  assertPathAllowed(repoReal, '仓库路径不在允许范围');
  const worktreeReal = await resolveWithinReal(worktreesRoot, worktreePath);
  const status = await runGit(['status', '--porcelain'], repoReal);
  if (status.trim()) throw new Error('主仓库有未提交变更，请先提交或清理后再应用');
  await runGit(['add', '-A'], worktreeReal);
  const diff = await runGit(['diff', '--cached', 'HEAD', '--binary'], worktreeReal);
  if (!diff.trim()) return { applied: false, message: '没有可应用的变更' };
  const patchPath = path.join(os.tmpdir(), `codex-worktree-${Date.now()}.patch`);
  fs.writeFileSync(patchPath, diff.endsWith('\n') ? diff : `${diff}\n`);
  try {
    await runGit(['apply', '--check', '--whitespace=nowarn', patchPath], repoReal);
    await runGit(['apply', '--whitespace=nowarn', patchPath], repoReal);
    return { applied: true, message: '变更已应用到主仓库工作区（未提交）' };
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      /* ignore */
    }
  }
});

handleIpc('app:worktree-remove', async (_event, payload) => {
  const repoRoot = payload?.repoRoot;
  const worktreePath = payload?.worktreePath;
  const branch = payload?.branch;
  if (!repoRoot || !worktreePath) throw new Error('缺少 worktree 信息');
  const repoReal = await realpathNearest(path.resolve(repoRoot));
  assertPathAllowed(repoReal, '仓库路径不在允许范围');
  const worktreeReal = await resolveWithinReal(worktreesRoot, worktreePath);
  if (branch) assertCodexBranch(branch);
  await runGit(['worktree', 'remove', '--force', worktreeReal], repoReal);
  if (branch) {
    try {
      await runGit(['branch', '-D', branch], repoReal);
    } catch {
      /* ignore */
    }
  }
  return { removed: true };
});

handleIpc('app:image-data-url', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('缺少图片路径');
  const extension = path.extname(filePath).toLowerCase();
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  }[extension];
  if (!mime) throw new Error('不支持的图片格式');
  const target = await realpathNearest(path.resolve(filePath));
  assertPathAllowed(target, '图片路径不在允许范围');
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB');
  const data = await fs.promises.readFile(target);
  return `data:${mime};base64,${data.toString('base64')}`;
});

handleIpc('app:notify', (_event, payload) => {
  if (!win || win.isFocused()) return false;
  const title =
    typeof payload?.title === 'string' && payload.title
      ? payload.title.slice(0, 80)
      : 'DeepSeek Codex';
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 240) : '';
  if (!Notification.isSupported()) {
    tray?.displayBalloon?.({ title, content: body });
    return false;
  }
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
  return true;
});

handleIpc('app:copy-text', (_event, text) => {
  if (typeof text !== 'string' || !text) return false;
  clipboard.writeText(text);
  return true;
});

handleIpc('app:show-in-folder', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const target = await realpathNearest(path.resolve(targetPath));
  assertPathAllowed(target, '路径不在允许范围');
  shell.showItemInFolder(target);
  return true;
});

handleIpc('app:open-path', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return 'invalid path';
  const target = await realpathNearest(path.resolve(targetPath));
  assertPathAllowed(target, '路径不在允许范围');
  return shell.openPath(target);
});

handleIpc('app:restart-engine', async () => {
  await restartEngine();
  return true;
});

handleIpc('app:get-local-tools', () => readLocalToolsPrefs());

handleIpc('app:set-local-tools', async (_event, payload) => {
  const prefs = {
    browser: Boolean(payload?.browser),
    computer: Boolean(payload?.computer),
    search: Boolean(payload?.search),
  };
  fs.mkdirSync(path.dirname(localToolsPrefsFile()), { recursive: true });
  fs.writeFileSync(localToolsPrefsFile(), JSON.stringify(prefs));
  return prefs;
});

handleIpc('app:git-info', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return { repo: false };
  try {
    const source = await realpathNearest(path.resolve(targetPath));
    assertPathAllowed(source, '仓库路径不在允许范围');
    const root = await runGit(['rev-parse', '--show-toplevel'], source);
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], targetPath);
    let changed = 0;
    try {
      const status = await runGit(['status', '--porcelain'], targetPath);
      changed = status ? status.split('\n').filter(Boolean).length : 0;
    } catch {
      /* status is best-effort */
    }
    return { repo: true, root, branch: branch === 'HEAD' ? 'detached' : branch, changed };
  } catch {
    return { repo: false };
  }
});

function runGitRaw(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'git failed').trim()));
          return;
        }
        resolve(stdout || '');
      },
    );
  });
}

function countDiffLines(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function statusLetter(code) {
  if (code === 'A' || code === '?') return 'A';
  if (code === 'D') return 'D';
  if (code === 'R') return 'R';
  return 'M';
}

function parseStatus(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.length < 4 || line.startsWith('## ')) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    let oldPath = null;
    if ((x === 'R' || x === 'C') && rest.includes(' -> ')) {
      const index = rest.indexOf(' -> ');
      oldPath = rest.slice(0, index);
      rest = rest.slice(index + 4);
    }
    entries.push({ x, y, path: rest, oldPath });
  }
  return entries;
}

function parsePatchFiles(diff) {
  const parts = diff.split(/(?=^diff --git )/m).filter((part) => part.startsWith('diff --git '));
  return parts.map((part) => {
    const { additions, deletions } = countDiffLines(part);
    const match = part.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    const filePath = (match?.[2] || 'unknown').replace(/^"|"$/g, '');
    const status = /^new file mode/m.test(part)
      ? 'A'
      : /^deleted file mode/m.test(part)
        ? 'D'
        : /^rename from/m.test(part)
          ? 'R'
          : 'M';
    return { path: filePath, status, diff: part, additions, deletions, untracked: false };
  });
}

async function makeUntrackedDiff(root, relPath) {
  const target = await resolveWithinReal(root, relPath);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) return '';
  if (stat.size > 512 * 1024) {
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary file (too large)\n`;
  }
  const buffer = await fs.promises.readFile(target);
  if (buffer.includes(0)) {
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary files /dev/null and b/${relPath} differ\n`;
  }
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

function buildHunkPatch(diff, hunkIndex) {
  const lines = String(diff).split('\n');
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
    } else if (current) {
      current.push(line);
    } else {
      header.push(line);
    }
  }
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
    throw new Error('Diff 块不存在');
  }
  return `${header.join('\n')}\n${hunks[hunkIndex].join('\n')}\n`;
}

function assertGitPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('缺少文件路径');
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry || entry.startsWith('-')) {
      throw new Error('非法文件路径');
    }
  }
}

async function gitRootFor(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少工作目录');
  const source = await realpathNearest(path.resolve(cwd));
  assertPathAllowed(source, '仓库路径不在允许范围');
  return runGit(['rev-parse', '--show-toplevel'], source);
}

handleIpc('app:git-review', async (_event, payload) => {
  const cwd = payload?.cwd;
  const scope =
    payload?.scope === 'staged' || payload?.scope === 'branch' ? payload.scope : 'unstaged';
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少工作目录');
  const source = await realpathNearest(path.resolve(cwd));
  assertPathAllowed(source, '仓库路径不在允许范围');
  let repoRoot;
  let branch = '';
  try {
    repoRoot = await runGit(['rev-parse', '--show-toplevel'], source);
    try {
      branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    } catch {
      branch = '';
    }
  } catch {
    return { repo: false, scope, files: [], additions: 0, deletions: 0 };
  }
  try {
    if (scope === 'branch') {
      let base =
        typeof payload?.base === 'string' && payload.base.trim() ? payload.base.trim() : '';
      if (base && (base.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(base) || base.includes('..'))) {
        throw new Error('非法基线分支');
      }
      if (!base) {
        for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
          try {
            await runGit(['rev-parse', '--verify', '--quiet', candidate], repoRoot);
            base = candidate;
            break;
          } catch {
            /* try next */
          }
        }
      }
      if (!base) {
        return {
          repo: true,
          repoRoot,
          branch,
          scope,
          files: [],
          additions: 0,
          deletions: 0,
          error: '找不到基线分支（main / master）',
        };
      }
      let mergeBase = base;
      try {
        mergeBase = await runGit(['merge-base', base, 'HEAD'], repoRoot);
      } catch {
        mergeBase = base;
      }
      const diff = await runGitRaw(
        ['diff', '--no-color', '--unified=3', mergeBase],
        repoRoot,
      );
      const files = parsePatchFiles(diff);
      const status = await runGitRaw(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        repoRoot,
      );
      for (const entry of parseStatus(status)) {
        if (entry.x !== '?') continue;
        const untrackedDiff = await makeUntrackedDiff(repoRoot, entry.path);
        if (!untrackedDiff.trim()) continue;
        files.push({
          path: entry.path,
          status: 'A',
          diff: untrackedDiff,
          ...countDiffLines(untrackedDiff),
          untracked: true,
        });
      }
      return {
        repo: true,
        repoRoot,
        branch,
        base,
        scope,
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      };
    }
    const status = await runGitRaw(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      repoRoot,
    );
    const entries = parseStatus(status);
    const files = [];
    for (const entry of entries) {
      if (scope === 'staged') {
        if (entry.x === ' ' || entry.x === '?') continue;
        const diff = await runGitRaw(
          ['diff', '--cached', '--no-color', '--unified=3', '--', entry.path],
          repoRoot,
        );
        if (!diff.trim()) continue;
        files.push({
          path: entry.path,
          status: statusLetter(entry.x),
          diff,
          ...countDiffLines(diff),
          untracked: false,
        });
      } else {
        if (entry.x !== '?' && entry.y === ' ') continue;
        const untracked = entry.x === '?';
        const diff = untracked
          ? await makeUntrackedDiff(repoRoot, entry.path)
          : await runGitRaw(
              ['diff', '--no-color', '--unified=3', '--', entry.path],
              repoRoot,
            );
        if (!diff.trim()) continue;
        files.push({
          path: entry.path,
          status: statusLetter(untracked ? '?' : entry.y),
          diff,
          ...countDiffLines(diff),
          untracked,
        });
      }
    }
    return {
      repo: true,
      repoRoot,
      branch,
      scope,
      files,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  } catch (error) {
    return {
      repo: true,
      repoRoot,
      branch,
      scope,
      files: [],
      additions: 0,
      deletions: 0,
      error: error.message,
    };
  }
});

handleIpc('app:git-stage', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  await runGit(['add', '--', ...payload.paths], root);
  return { ok: true };
});

handleIpc('app:git-unstage', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  await runGit(['restore', '--staged', '--', ...payload.paths], root);
  return { ok: true };
});

handleIpc('app:git-discard', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  if (payload?.untracked) {
    for (const relPath of payload.paths) {
      await fs.promises.rm(await resolveWithinReal(root, relPath), {
        recursive: true,
        force: true,
      });
    }
  } else {
    await runGit(['restore', '--worktree', '--', ...payload.paths], root);
  }
  return { ok: true };
});

handleIpc('app:git-hunk', async (_event, payload) => {
  const mode = payload?.mode;
  if (!['stage', 'unstage', 'revert'].includes(mode)) throw new Error('未知的 Diff 操作');
  if (typeof payload?.diff !== 'string' || !payload.diff) throw new Error('缺少 Diff 内容');
  const root = await gitRootFor(payload?.cwd);
  const patch = buildHunkPatch(payload.diff, Number(payload?.hunkIndex));
  const patchPath = path.join(
    os.tmpdir(),
    `codex-hunk-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`,
  );
  fs.writeFileSync(patchPath, patch, 'utf8');
  try {
    const args = ['apply', '--whitespace=nowarn'];
    if (mode === 'stage') args.push('--cached');
    if (mode === 'unstage') args.push('--cached', '--reverse');
    if (mode === 'revert') args.push('--reverse');
    args.push(patchPath);
    await runGit(args, root);
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
});

handleIpc('app:git-commit', async (_event, payload) => {
  const message = String(payload?.message || '').trim();
  if (!message) throw new Error('提交信息不能为空');
  if (message.length > 4000) throw new Error('提交信息过长');
  const root = await gitRootFor(payload?.cwd);
  const output = await runGitRaw(['commit', '-m', message], root);
  return { output: output.trim() };
});

handleIpc('app:git-push', async (_event, payload) => {
  const root = await gitRootFor(payload?.cwd);
  const output = await runGitRaw(['push'], root);
  return { output: output.trim() };
});

async function realpathNearest(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (true) {
    try {
      const real = await fs.promises.realpath(current);
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveWithinReal(root, target) {
  const rootAbs = await realpathNearest(root);
  const targetAbs = await realpathNearest(path.resolve(rootAbs, target || '.'));
  const relative = path.relative(rootAbs, targetAbs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('路径超出项目目录');
  }
  return targetAbs;
}

handleIpc('app:list-dir', async (_event, payload) => {
  const root = payload?.root;
  if (typeof root !== 'string' || !root) throw new Error('缺少项目目录');
  const rootReal = await realpathNearest(path.resolve(root));
  assertPathAllowed(rootReal, '项目目录不在允许范围');
  const target = await resolveWithinReal(rootReal, payload?.path || '.');
  const directory = await fs.promises.readdir(target, { withFileTypes: true });
  const entries = directory
    .filter(
      (entry) =>
        entry.name !== '.git' &&
        entry.name !== '.DS_Store' &&
        entry.name !== 'Thumbs.db',
    )
    .map((entry) => ({
      name: entry.name,
      path: path
        .relative(path.resolve(root), path.join(target, entry.name))
        .split(path.sep)
        .join('/'),
      dir: entry.isDirectory(),
      symlink: entry.isSymbolicLink(),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return {
    path: path.relative(path.resolve(root), target).split(path.sep).join('/') || '.',
    entries: entries.slice(0, 2000),
  };
});

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

handleIpc('app:read-file', async (_event, payload) => {
  const root = payload?.root;
  const file = payload?.path;
  if (typeof root !== 'string' || !root) throw new Error('缺少项目目录');
  if (typeof file !== 'string' || !file) throw new Error('缺少文件路径');
  const rootReal = await realpathNearest(path.resolve(root));
  assertPathAllowed(rootReal, '项目目录不在允许范围');
  const target = await resolveWithinReal(rootReal, file);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('不是文件');
  const extension = path.extname(target).toLowerCase();
  const mime = IMAGE_MIME[extension];
  if (mime) {
    if (stat.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB');
    const data = await fs.promises.readFile(target);
    return {
      kind: 'image',
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      size: stat.size,
      path: file,
      absolutePath: target,
    };
  }
  const limit = 512 * 1024;
  const readSize = Math.min(stat.size, limit);
  const buffer = Buffer.alloc(readSize);
  const handle = await fs.promises.open(target, 'r');
  try {
    await handle.read(buffer, 0, readSize, 0);
  } finally {
    await handle.close();
  }
  if (buffer.includes(0)) {
    return { kind: 'binary', size: stat.size, path: file, absolutePath: target };
  }
  return {
    kind: 'text',
    text: buffer.toString('utf8'),
    truncated: stat.size > limit,
    size: stat.size,
    path: file,
    absolutePath: target,
  };
});

handleIpc('app:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('无效 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接');
  }
  await shell.openExternal(parsed.toString());
  return true;
});

function killTerminalTree(entry) {
  if (!entry?.pty) return;
  const pid = entry.pty.pid;
  try {
    entry.pty.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && pid) {
    killProcessTree(pid);
  }
}

function killAllTerminals() {
  for (const entry of terminals.values()) {
    killTerminalTree(entry);
  }
  terminals.clear();
}

handleIpc('terminal:start', async (_event, payload) => {
  if (!pty) throw new Error('终端组件不可用（node-pty 未加载）');
  if (terminals.size >= 8) throw new Error('终端数量已达上限（8 个）');
  const cwd = payload?.cwd;
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少工作目录');
  const cwdReal = await realpathNearest(path.resolve(cwd));
  assertPathAllowed(cwdReal, '工作目录不在允许范围');
  const stat = await fs.promises.stat(cwdReal);
  if (!stat.isDirectory()) throw new Error('工作目录无效');
  const id = `term-${++terminalSeq}`;
  const cols = Math.max(20, Math.min(400, Number(payload?.cols) || 120));
  const rows = Math.max(5, Math.min(200, Number(payload?.rows) || 30));
  const terminalEnv = { ...process.env, TERM: 'xterm-256color' };
  delete terminalEnv.DEEPSEEK_API_KEY;
  const session = pty.spawn(
    process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash',
    process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwdReal,
      env: terminalEnv,
      useConpty: true,
      useConptyDll: process.platform === 'win32',
    },
  );
  const send = (channel, data) => {
    sendToRenderer(channel, data);
  };
  session.onData((data) => send('terminal:data', { id, data }));
  session.onExit(({ exitCode }) => {
    terminals.delete(id);
    send('terminal:exit', { id, code: exitCode });
  });
  terminals.set(id, { pty: session });
  return { id, cwd };
});

handleIpc('terminal:input', (_event, payload) => {
  const entry = terminals.get(payload?.id);
  if (!entry) throw new Error('终端未运行');
  const data = typeof payload?.data === 'string' ? payload.data : '';
  if (!data) return false;
  if (data.length > 100000) throw new Error('输入过长');
  entry.pty.write(data);
  return true;
});

handleIpc('terminal:resize', (_event, payload) => {
  const entry = terminals.get(payload?.id);
  if (!entry) return false;
  const cols = Math.max(20, Math.min(400, Number(payload?.cols) || 120));
  const rows = Math.max(5, Math.min(200, Number(payload?.rows) || 30));
  try {
    entry.pty.resize(cols, rows);
  } catch {
    return false;
  }
  return true;
});

handleIpc('terminal:stop', (_event, id) => {
  const entry = terminals.get(id);
  if (!entry) return false;
  terminals.delete(id);
  killTerminalTree(entry);
  return true;
});

handleIpc('rpc:request', async (_event, method, params) => {
  if (!rpc || !online) {
    throw new Error(lastError || 'app-server 未连接');
  }
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`不允许的方法：${method}`);
  }
  await initPromise;
  const result = await rpc.request(method, withLocalMcpConfig(method, params));
  collectAllowedRoots(method, result);
  return result;
});

ipcMain.on('rpc:respond', (event, id, result, error) => {
  if (!isTrustedSender(event)) return;
  rpc?.respond(id, result, error);
});

ipcMain.on('app:renderer-ready', (event) => {
  if (!isTrustedSender(event)) return;
  flushRendererMessages();
  broadcastStatus();
});

handleIpc('app:api-key-status', () => ({
  configured: hasApiKey(),
  env: Boolean(process.env.DEEPSEEK_API_KEY),
}));

handleIpc('app:set-api-key', async (_event, key) => {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed.startsWith('sk-')) throw new Error('API Key 应以 sk- 开头');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('当前系统不支持安全存储');
  }
  fs.mkdirSync(path.dirname(apiKeyFile()), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(trimmed);
  await fs.promises.writeFile(apiKeyFile(), encrypted);
  apiKey = trimmed;
  await restartEngine();
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('local.deepseek.codex');
    await loadApiKey();
    startBrowserBridge();
    startEngine();
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    appQuitting = true;
    appendMainLog('app quitting');
    tray?.destroy();
    tray = null;
    stopBrowserBridge();
    if (webWorkerIdleTimer) {
      clearTimeout(webWorkerIdleTimer);
      webWorkerIdleTimer = null;
    }
    if (webWorker && !webWorker.isDestroyed()) webWorker.destroy();
    webWorker = null;
    shutdownEngineNow();
    killAllTerminals();
  });
}
