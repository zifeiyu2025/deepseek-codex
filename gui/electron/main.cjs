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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pty = null;
try {
  pty = require('node-pty');
} catch (error) {
  console.error('node-pty unavailable:', error);
}

const ROOT = path.resolve(__dirname, '..');
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
  'config/batchWrite',
]);

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

function loadApiKey() {
  try {
    const file = apiKeyFile();
    if (!fs.existsSync(file)) return;
    if (!safeStorage.isEncryptionAvailable()) {
      appendMainLog('api key present but safeStorage is unavailable');
      return;
    }
    apiKey = safeStorage.decryptString(fs.readFileSync(file));
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

function broadcastStatus() {
  win?.webContents.send('app:status', { online, error: lastError });
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
  client.on('notification', (message) => win?.webContents.send('rpc:notification', message));
  client.on('serverRequest', (message) => win?.webContents.send('rpc:serverRequest', message));
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
            win?.webContents.send('tray:action', 'new-session');
          },
        },
        {
          label: '设置',
          click: () => {
            showWindow();
            win?.webContents.send('tray:action', 'settings');
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
      sandbox: false,
      webviewTag: true,
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
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!/^https?:\/\//i.test(params.src || '')) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: 'deny' };
    });
  });
  win.webContents.on('did-finish-load', () => {
    killAllTerminals();
    broadcastStatus();
    win?.webContents.send('window:maximized', Boolean(win?.isMaximized()));
  });
  win.on('maximize', () => win?.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win?.webContents.send('window:maximized', false));
  win.on('close', (event) => {
    saveWindowState();
    if (!appQuitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
    killAllTerminals();
  });
}

ipcMain.handle('window:minimize', () => {
  win?.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

ipcMain.handle('window:close', () => {
  win?.close();
});

ipcMain.handle('window:is-maximized', () => Boolean(win?.isMaximized()));

ipcMain.handle('app:get-config', () => {
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

ipcMain.handle('app:pick-folder', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('app:pick-files', async () => {
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('app:pick-images', async () => {
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('app:save-pasted-image', async () => {
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

ipcMain.handle('app:create-worktree', async (_event, repoPath) => {
  const source = repoPath || os.homedir();
  const repoRoot = await runGit(['rev-parse', '--show-toplevel'], source);
  const repoName = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '-');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(16).slice(2, 8);
  const branch = `codex/${stamp}-${suffix}`;
  const worktreeRoot = path.join(os.homedir(), '.codex', 'worktrees', `${repoName}-${stamp}-${suffix}`);
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

ipcMain.handle('app:worktree-apply', async (_event, payload) => {
  const repoRoot = payload?.repoRoot;
  const worktreePath = payload?.worktreePath;
  if (!repoRoot || !worktreePath) throw new Error('缺少 worktree 信息');
  const status = await runGit(['status', '--porcelain'], repoRoot);
  if (status.trim()) throw new Error('主仓库有未提交变更，请先提交或清理后再应用');
  await runGit(['add', '-A'], worktreePath);
  const diff = await runGit(['diff', '--cached', 'HEAD', '--binary'], worktreePath);
  if (!diff.trim()) return { applied: false, message: '没有可应用的变更' };
  const patchPath = path.join(os.tmpdir(), `codex-worktree-${Date.now()}.patch`);
  fs.writeFileSync(patchPath, diff.endsWith('\n') ? diff : `${diff}\n`);
  try {
    await runGit(['apply', '--check', '--whitespace=nowarn', patchPath], repoRoot);
    await runGit(['apply', '--whitespace=nowarn', patchPath], repoRoot);
    return { applied: true, message: '变更已应用到主仓库工作区（未提交）' };
  } finally {
    try {
      fs.unlinkSync(patchPath);
    } catch {
      /* ignore */
    }
  }
});

ipcMain.handle('app:worktree-remove', async (_event, payload) => {
  const repoRoot = payload?.repoRoot;
  const worktreePath = payload?.worktreePath;
  const branch = payload?.branch;
  if (!repoRoot || !worktreePath) throw new Error('缺少 worktree 信息');
  await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
  if (branch) {
    try {
      await runGit(['branch', '-D', branch], repoRoot);
    } catch {
      /* ignore */
    }
  }
  return { removed: true };
});

ipcMain.handle('app:image-data-url', async (_event, filePath) => {
  const extension = path.extname(filePath || '').toLowerCase();
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }[extension];
  if (!mime) throw new Error('不支持的图片格式');
  const data = await fs.promises.readFile(filePath);
  if (data.length > 12 * 1024 * 1024) throw new Error('图片超过 12MB');
  return `data:${mime};base64,${data.toString('base64')}`;
});

ipcMain.handle('app:notify', (_event, payload) => {
  if (!win || win.isFocused() || !Notification.isSupported()) return false;
  const title =
    typeof payload?.title === 'string' && payload.title
      ? payload.title.slice(0, 80)
      : 'DeepSeek Codex';
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 240) : '';
  if (payload?.sound) shell.beep();
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

ipcMain.handle('app:copy-text', (_event, text) => {
  if (typeof text !== 'string' || !text) return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('app:show-in-folder', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('app:open-path', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return 'invalid path';
  return shell.openPath(targetPath);
});

ipcMain.handle('app:restart-engine', async () => {
  await restartEngine();
  return true;
});

ipcMain.handle('app:git-info', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return { repo: false };
  try {
    const root = await runGit(['rev-parse', '--show-toplevel'], targetPath);
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
  const target = resolveWithin(root, relPath);
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
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

ipcMain.handle('app:git-review', async (_event, payload) => {
  const cwd = payload?.cwd;
  const scope =
    payload?.scope === 'staged' || payload?.scope === 'branch' ? payload.scope : 'unstaged';
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少工作目录');
  let repoRoot;
  let branch = '';
  try {
    repoRoot = await runGit(['rev-parse', '--show-toplevel'], cwd);
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

ipcMain.handle('app:git-stage', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  await runGit(['add', '--', ...payload.paths], root);
  return { ok: true };
});

ipcMain.handle('app:git-unstage', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  await runGit(['restore', '--staged', '--', ...payload.paths], root);
  return { ok: true };
});

ipcMain.handle('app:git-discard', async (_event, payload) => {
  assertGitPaths(payload?.paths);
  const root = await gitRootFor(payload?.cwd);
  if (payload?.untracked) {
    for (const relPath of payload.paths) {
      await fs.promises.rm(resolveWithin(root, relPath), { recursive: true, force: true });
    }
  } else {
    await runGit(['restore', '--worktree', '--', ...payload.paths], root);
  }
  return { ok: true };
});

ipcMain.handle('app:git-hunk', async (_event, payload) => {
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

ipcMain.handle('app:git-commit', async (_event, payload) => {
  const message = String(payload?.message || '').trim();
  if (!message) throw new Error('提交信息不能为空');
  if (message.length > 4000) throw new Error('提交信息过长');
  const root = await gitRootFor(payload?.cwd);
  const output = await runGitRaw(['commit', '-m', message], root);
  return { output: output.trim() };
});

ipcMain.handle('app:git-push', async (_event, payload) => {
  const root = await gitRootFor(payload?.cwd);
  const output = await runGitRaw(['push'], root);
  return { output: output.trim() };
});

function resolveWithin(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target || '.');
  const relative = path.relative(rootAbs, targetAbs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('路径超出项目目录');
  }
  return targetAbs;
}

ipcMain.handle('app:list-dir', async (_event, payload) => {
  const root = payload?.root;
  if (typeof root !== 'string' || !root) throw new Error('缺少项目目录');
  const target = resolveWithin(root, payload?.path || '.');
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
};

ipcMain.handle('app:read-file', async (_event, payload) => {
  const root = payload?.root;
  const file = payload?.path;
  if (typeof root !== 'string' || !root) throw new Error('缺少项目目录');
  if (typeof file !== 'string' || !file) throw new Error('缺少文件路径');
  const target = resolveWithin(root, file);
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

ipcMain.handle('app:open-external', async (_event, url) => {
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

ipcMain.handle('terminal:start', async (_event, payload) => {
  if (!pty) throw new Error('终端组件不可用（node-pty 未加载）');
  const cwd = payload?.cwd;
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少工作目录');
  const stat = await fs.promises.stat(cwd);
  if (!stat.isDirectory()) throw new Error('工作目录无效');
  const id = `term-${++terminalSeq}`;
  const cols = Math.max(20, Math.min(400, Number(payload?.cols) || 120));
  const rows = Math.max(5, Math.min(200, Number(payload?.rows) || 30));
  const session = pty.spawn(
    process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash',
    process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      useConpty: true,
      useConptyDll: process.platform === 'win32',
    },
  );
  const send = (channel, data) => {
    win?.webContents.send(channel, data);
  };
  session.onData((data) => send('terminal:data', { id, data }));
  session.onExit(({ exitCode }) => {
    terminals.delete(id);
    send('terminal:exit', { id, code: exitCode });
  });
  terminals.set(id, { pty: session });
  return { id, cwd };
});

ipcMain.handle('terminal:input', (_event, payload) => {
  const entry = terminals.get(payload?.id);
  if (!entry) throw new Error('终端未运行');
  const data = typeof payload?.data === 'string' ? payload.data : '';
  if (!data) return false;
  if (data.length > 100000) throw new Error('输入过长');
  entry.pty.write(data);
  return true;
});

ipcMain.handle('terminal:resize', (_event, payload) => {
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

ipcMain.handle('terminal:stop', (_event, id) => {
  const entry = terminals.get(id);
  if (!entry) return false;
  terminals.delete(id);
  killTerminalTree(entry);
  return true;
});

ipcMain.handle('rpc:request', async (_event, method, params) => {
  if (!rpc || !online) {
    throw new Error(lastError || 'app-server 未连接');
  }
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`不允许的方法：${method}`);
  }
  await initPromise;
  return rpc.request(method, params);
});

ipcMain.on('rpc:respond', (_event, id, result, error) => {
  rpc?.respond(id, result, error);
});

ipcMain.handle('app:api-key-status', () => ({
  configured: hasApiKey(),
  env: Boolean(process.env.DEEPSEEK_API_KEY),
}));

ipcMain.handle('app:set-api-key', async (_event, key) => {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed.startsWith('sk-')) throw new Error('API Key 应以 sk- 开头');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持安全存储');
  fs.mkdirSync(path.dirname(apiKeyFile()), { recursive: true });
  fs.writeFileSync(apiKeyFile(), safeStorage.encryptString(trimmed));
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

  app.whenReady().then(() => {
    app.setAppUserModelId('local.deepseek.codex');
    loadApiKey();
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
    shutdownEngineNow();
    killAllTerminals();
  });
}
