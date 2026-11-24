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
  session,
  webContents,
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
  'permissionProfile/list',
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
const COMPUTER_TOOL_NAMES = [
  'computer_screenshot',
  'computer_monitors',
  'computer_active_window',
  'computer_list_apps',
  'computer_list_windows',
  'computer_get_window',
  'computer_launch_app',
  'computer_activate_window',
  'computer_window_state',
  'computer_focus_app',
  'computer_move',
  'computer_click',
  'computer_drag',
  'computer_set_value',
  'computer_element_action',
  'computer_type',
  'computer_key',
  'computer_scroll',
];

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

function computerHistoryFile() {
  return path.join(app.getPath('userData'), 'computer-history.json');
}

function downloadsFile() {
  return path.join(app.getPath('userData'), 'browser-downloads.json');
}

function setupDownloadTracking() {
  const browserSession = session.fromPartition('persist:shanui-browser');
  browserSession.on('will-download', (event, item) => {
    if (!browserDownloadAllowed(item.getURL())) {
      event.preventDefault();
      item.cancel();
      return;
    }
    const originalName = item.getFilename() || 'download';
    const downloadsDir = app.getPath('downloads');
    let target = path.join(downloadsDir, originalName);
    let suffix = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      target = path.join(downloadsDir, `${base} (${suffix++})${ext}`);
    }
    try {
      item.setSavePath(target);
    } catch {
      /* keep the default save path */
    }
    item.once('done', (_doneEvent, state) => {
      try {
        let list = [];
        try {
          const parsed = JSON.parse(fs.readFileSync(downloadsFile(), 'utf8'));
          if (Array.isArray(parsed)) list = parsed;
        } catch {
          list = [];
        }
        list.unshift({
          name: path.basename(target),
          url: item.getURL(),
          path: target,
          state,
          size: item.getReceivedBytes(),
          at: Date.now(),
        });
        fs.mkdirSync(path.dirname(downloadsFile()), { recursive: true });
        fs.writeFileSync(downloadsFile(), JSON.stringify(list.slice(0, 100)));
      } catch (error) {
        appendMainLog(`download history failed: ${error?.message || error}`);
      }
    });
  });
}

function isBlockedComputerApp(appId) {
  const normalized = String(appId || '').trim().replace(/\\/g, '/');
  const process = (normalized.split('/').pop() || normalized)
    .toLowerCase()
    .replace(/^process:/, '')
    .replace(/\.exe$/, '');
  return (
    [
      'cmd',
      'powershell',
      'pwsh',
      'windowsterminal',
      'conhost',
      'openconsole',
      'codex',
      'chatgpt',
      'deepseek codex',
      'electron',
      'qoder',
      'securityhealthsystray',
      'securityhealthui',
      'msascui',
      'wdsecurity',
      'windowsdefender',
      'taskmgr',
      'credentialui',
      'consent',
      'lockapp',
      'mstsc',
      'mmc',
      '1password',
      'bitwarden',
      'keepass',
      'keepassxc',
      'lastpass',
      'dashlane',
    ].includes(process) || process.startsWith('deepseek-codex')
  );
}

function normalizeComputerApps(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const apps = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const app = entry.trim().replace(/[\u0000-\u001f]/g, '').replace(/\//g, '\\');
    if (!app || app.length > 1024 || isBlockedComputerApp(app)) continue;
    const key = app.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(app);
  }
  return apps;
}

function writeLocalToolsPrefs(prefs) {
  fs.mkdirSync(path.dirname(localToolsPrefsFile()), { recursive: true });
  fs.writeFileSync(localToolsPrefsFile(), JSON.stringify(prefs));
  return prefs;
}

function readLocalToolsPrefs() {
  const fallback = {
    browser: false,
    computer: false,
    search: false,
    ocr: false,
    searchProvider: 'auto',
    computerAllowedApps: [],
    browserOriginPolicy: 'any',
    browserAllowedOrigins: [],
    browserFullCdp: false,
    browserDownloadPolicy: 'allow',
    browserFileAccess: false,
    browserSitePermissions: {},
    browserSiteDownloadPolicies: {},
  };
  try {
    const saved = JSON.parse(fs.readFileSync(localToolsPrefsFile(), 'utf8'));
    const provider = ['auto', 'deepseek', 'local'].includes(saved?.searchProvider)
      ? saved.searchProvider
      : 'auto';
    const originPolicy =
      saved?.browserOriginPolicy === 'allowlist' ? 'allowlist' : 'any';
    return {
      browser: Boolean(saved?.browser),
      computer: Boolean(saved?.computer),
      search: Boolean(saved?.search),
      ocr: Boolean(saved?.ocr),
      searchProvider: provider,
      computerAllowedApps: normalizeComputerApps(saved?.computerAllowedApps),
      browserOriginPolicy: originPolicy,
      browserAllowedOrigins: Array.isArray(saved?.browserAllowedOrigins)
        ? saved.browserAllowedOrigins
            .filter((origin) => typeof origin === 'string' && origin.trim())
            .map((origin) => origin.trim())
        : [],
      browserFullCdp: Boolean(saved?.browserFullCdp),
      browserDownloadPolicy: saved?.browserDownloadPolicy === 'deny' ? 'deny' : 'allow',
      browserFileAccess: Boolean(saved?.browserFileAccess),
      browserSitePermissions: normalizeBrowserSitePermissions(saved?.browserSitePermissions),
      browserSiteDownloadPolicies: normalizeBrowserSiteDownloadPolicies(
        saved?.browserSiteDownloadPolicies,
      ),
    };
  } catch {
    return fallback;
  }
}

function deepseekApiKey() {
  return apiKey || process.env.DEEPSEEK_API_KEY || '';
}

function deepseekBaseUrl() {
  if (process.env.DEEPSEEK_BASE_URL) return process.env.DEEPSEEK_BASE_URL.replace(/\/+$/, '');
  try {
    const raw = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const providerMatch = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(raw);
    const provider = providerMatch?.[1] || 'deepseek';
    const section = new RegExp(
      `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([\\s\\S]*?)(?=^\\s*\\[|$)`,
      'm',
    ).exec(raw);
    const base = section && /^\s*base_url\s*=\s*"([^"]+)"/m.exec(section[1]);
    if (base) return base[1].replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return 'https://api.deepseek.com';
}

async function deepseekApi(pathname, options = {}) {
  const key = deepseekApiKey();
  if (!key) throw new Error('尚未配置 DeepSeek API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const response = await fetch(`${deepseekBaseUrl()}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${key}`,
        ...(options.headers || {}),
      },
      body:
        options.body instanceof FormData
          ? options.body
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text.trim() ? JSON.parse(text.trim()) : null;
    } catch {
      data = null;
    }
    if (!response.ok || data?.error) {
      const message = data?.error?.message || `DeepSeek 接口返回 ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('DeepSeek 接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function deepseekSearch(query, count, oriQuestion) {
  const data = await deepseekApi('/v1/tools/search', {
    method: 'POST',
    body: {
      query,
      count: Math.max(1, Math.min(50, Number(count) || 10)),
      need_content: false,
      ...(oriQuestion ? { ori_question: oriQuestion } : {}),
    },
    timeoutMs: 30000,
  });
  return (data?.results || []).map((result) => ({
    title: result.title || result.site_name || result.url || '',
    url: result.url || '',
    snippet: result.snippet || (result.summary || '').slice(0, 200),
    summary: result.summary || '',
    site: result.site_name || '',
    date: result.date || null,
    authority: result.authority ?? -1,
    score: result.rerank_score ?? 0,
  }));
}

async function deepseekFetchPage(url) {
  const data = await deepseekApi('/v1/tools/fetch', {
    method: 'POST',
    body: { url },
    timeoutMs: 30000,
  });
  return {
    title: data?.title || '',
    content: data?.content || '',
  };
}

function localMcpServerConfig(prefs) {
  if (!prefs.browser && !prefs.computer && !prefs.search && !prefs.ocr) return null;
  return {
    command: process.execPath,
    args: [localMcpScriptPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      SHANUI_BRIDGE_FILE: browserBridgeFile(),
      SHANUI_ENABLE_BROWSER: prefs.browser ? '1' : '0',
      SHANUI_ENABLE_COMPUTER: prefs.computer ? '1' : '0',
      SHANUI_ENABLE_WEB_SEARCH: prefs.search ? '1' : '0',
      SHANUI_ENABLE_OCR: prefs.ocr ? '1' : '0',
      SHANUI_COMPUTER_ALLOWED_APPS: JSON.stringify(prefs.computerAllowedApps || []),
      SHANUI_LOCAL_TOOLS_FILE: localToolsPrefsFile(),
      SHANUI_BROWSER_FULL_CDP: prefs.browserFullCdp ? '1' : '0',
      SHANUI_COMPUTER_HISTORY_FILE: computerHistoryFile(),
    },
    ...(() => {
      const approvals = {};
      if (prefs.computer) {
        for (const name of COMPUTER_TOOL_NAMES) {
          approvals[name] = { approval_mode: 'approve' };
        }
      }
      if (prefs.browser) approvals.browser_upload = { approval_mode: 'approve' };
      return Object.keys(approvals).length ? { tools: approvals } : {};
    })(),
    default_tools_approval_mode: 'prompt',
    tool_timeout_sec: 120,
  };
}

function withLocalMcpConfig(method, params) {
  if (!THREAD_CONFIG_METHODS.has(method)) return params;
  const prefs = readLocalToolsPrefs();
  const server = localMcpServerConfig(prefs);
  const config = { ...(params?.config || {}) };
  let changed = false;
  if (server) {
    config['mcp_servers.shanui_local'] = server;
    changed = true;
  }
  if (prefs.search && hasApiKey()) {
    config['features.standalone_web_search'] = true;
    config['model_providers.deepseek.supports_standalone_web_search'] = true;
    changed = true;
  }
  if (!changed) return params;
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

const BROWSER_SITE_PERMISSION_NAMES = new Set([
  'media',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fileSystem',
  'midiSysex',
  'usb',
  'serial',
  'hid',
]);

function normalizeBrowserSitePermissions(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  let count = 0;
  for (const [rawOrigin, rawPermissions] of Object.entries(value)) {
    if (count >= 200) break;
    const origin = normalizeBrowserOrigin(rawOrigin);
    if (!origin || !Array.isArray(rawPermissions)) continue;
    const permissions = [
      ...new Set(
        rawPermissions.filter(
          (permission) =>
            typeof permission === 'string' && BROWSER_SITE_PERMISSION_NAMES.has(permission),
        ),
      ),
    ].sort();
    if (!permissions.length) continue;
    result[origin] = permissions;
    count += 1;
  }
  return result;
}

function normalizeBrowserSiteDownloadPolicies(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  let count = 0;
  for (const [rawOrigin, policy] of Object.entries(value)) {
    if (count >= 200) break;
    const origin = normalizeBrowserOrigin(rawOrigin);
    if (!origin || (policy !== 'allow' && policy !== 'deny')) continue;
    result[origin] = policy;
    count += 1;
  }
  return result;
}

function browserSitePermissionAllowed(permission, rawOrigin, prefs = readLocalToolsPrefs()) {
  if (permission === 'fullscreen') return true;
  if (permission === 'fileSystem' && prefs.browserFileAccess) return true;
  if (!BROWSER_SITE_PERMISSION_NAMES.has(permission)) return false;
  const origin = normalizeBrowserOrigin(rawOrigin);
  if (!origin) return false;
  return (prefs.browserSitePermissions?.[origin] || []).includes(permission);
}

function browserDownloadAllowed(rawUrl, prefs = readLocalToolsPrefs()) {
  const origin = normalizeBrowserOrigin(rawUrl);
  const sitePolicy = origin ? prefs.browserSiteDownloadPolicies?.[origin] : null;
  if (sitePolicy === 'deny') return false;
  if (sitePolicy === 'allow') return true;
  return prefs.browserDownloadPolicy !== 'deny';
}

function browserRequestOrigin(contents, details, requestingOrigin) {
  let candidate = requestingOrigin || '';
  if (!candidate) {
    try {
      candidate = details?.requestingUrl || contents?.getURL() || '';
    } catch {
      candidate = '';
    }
  }
  return normalizeBrowserOrigin(candidate);
}

function browserPermissionAllowedForRequest(
  contents,
  permission,
  details,
  requestingOrigin,
) {
  return browserSitePermissionAllowed(
    permission,
    browserRequestOrigin(contents, details, requestingOrigin),
  );
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
  contents.session.setPermissionRequestHandler((requesting, permission, callback, details) =>
    callback(browserPermissionAllowedForRequest(requesting, permission, details)),
  );
  contents.session.setPermissionCheckHandler(
    (requesting, permission, requestingOrigin, details) =>
      browserPermissionAllowedForRequest(
        requesting,
        permission,
        details,
        requestingOrigin,
      ),
  );
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
  assertBrowserOrigin(url);
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

function browserOriginAllowed(rawUrl) {
  const prefs = readLocalToolsPrefs();
  if (prefs.browserOriginPolicy !== 'allowlist') return true;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  return prefs.browserAllowedOrigins.some((entry) => {
    const value = String(entry).trim().toLowerCase();
    if (!value) return false;
    if (value.startsWith('*.')) {
      const suffix = value.slice(2);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return host === value || hostname === value;
  });
}

function assertBrowserOrigin(rawUrl) {
  if (browserOriginAllowed(rawUrl)) return;
  let host = rawUrl;
  try {
    host = new URL(rawUrl).host;
  } catch {
    /* keep raw */
  }
  throw new Error(`站点不在允许列表：${host}`);
}

function assertCurrentBrowserOrigin(guest) {
  let current = '';
  try {
    current = guest.getURL() || '';
  } catch {
    return;
  }
  if (/^https?:/i.test(current)) assertBrowserOrigin(current);
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

async function localWebSearch(query, limit) {
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
  return data.results;
}

async function localWebFetch(url, maxChars) {
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
  return data;
}

async function ocrFile(filePath, purpose) {
  if (!readLocalToolsPrefs().ocr) throw new Error('文档识别（OCR）未启用');
  const target = await realpathNearest(path.resolve(filePath));
  assertPathAllowed(target, '文件不在允许范围');
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('只能识别文件');
  if (stat.size > 100 * 1024 * 1024) throw new Error('OCR 文件不能超过 100 MiB');
  const mode =
    purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition';
  const buffer = await fs.promises.readFile(target);
  const form = new FormData();
  form.append('purpose', mode);
  form.append('file', new Blob([buffer]), path.basename(target));
  const data = await deepseekApi('/v1/tools/ocr', {
    method: 'POST',
    body: form,
    timeoutMs: 180000,
  });
  const pages = (data?.pages || []).map((page) => ({
    index: page.index,
    finishReason: page.finish_reason || '',
    text: String(page.text || ''),
  }));
  const fullText = pages
    .map((page) => `--- 第 ${Number(page.index) + 1} 页 ---\n${page.text}`)
    .join('\n\n');
  const maxChars = 120000;
  return {
    name: path.basename(target),
    path: target,
    purpose: data?.purpose || mode,
    pageCount: data?.page_count ?? pages.length,
    usage: data?.usage || null,
    text: fullText.slice(0, maxChars),
    truncated: fullText.length > maxChars,
  };
}

async function handleBrowserTool(tool, args) {
  if (tool === 'web_search') {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('缺少搜索关键词');
    const limit = Math.max(1, Math.min(10, Number(args?.count) || 6));
    const prefs = readLocalToolsPrefs();
    let fallbackReason = '';
    if (prefs.searchProvider !== 'local' && hasApiKey()) {
      try {
        const results = await deepseekSearch(query, limit);
        if (results.length) {
          return {
            type: 'text',
            text: JSON.stringify({ query, engine: 'deepseek', results }, null, 2),
          };
        }
        fallbackReason = 'DeepSeek 搜索没有返回结果';
      } catch (error) {
        if (prefs.searchProvider === 'deepseek') throw error;
        fallbackReason = error?.message || String(error);
      }
    } else if (prefs.searchProvider === 'deepseek') {
      throw new Error('DeepSeek 搜索需要先配置 API Key');
    }
    const results = await localWebSearch(query, limit);
    return {
      type: 'text',
      text: JSON.stringify(
        { query, engine: 'bing', results, ...(fallbackReason ? { fallbackReason } : {}) },
        null,
        2,
      ),
    };
  }
  if (tool === 'web_fetch') {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!raw) throw new Error('缺少目标 URL');
    const maxChars = Math.max(1000, Math.min(30000, Number(args?.maxChars) || 12000));
    const url = parseHttpUrl(raw);
    const prefs = readLocalToolsPrefs();
    let fallbackReason = '';
    if (prefs.searchProvider !== 'local' && hasApiKey()) {
      try {
        const fetched = await deepseekFetchPage(url);
        if (fetched.content) {
          return {
            type: 'text',
            text: JSON.stringify(
              {
                title: fetched.title,
                url,
                description: '',
                content: fetched.content.slice(0, maxChars),
                requestedUrl: url,
                engine: 'deepseek',
              },
              null,
              2,
            ),
          };
        }
        fallbackReason = 'DeepSeek Fetch 没有返回正文';
      } catch (error) {
        if (prefs.searchProvider === 'deepseek') throw error;
        fallbackReason = error?.message || String(error);
      }
    } else if (prefs.searchProvider === 'deepseek') {
      throw new Error('DeepSeek Fetch 需要先配置 API Key');
    }
    const data = await localWebFetch(url, maxChars);
    return {
      type: 'text',
      text: JSON.stringify(
        { ...data, requestedUrl: url, engine: 'bing', ...(fallbackReason ? { fallbackReason } : {}) },
        null,
        2,
      ),
    };
  }
  if (tool === 'ocr') {
    const filePath = typeof args?.path === 'string' ? args.path.trim() : '';
    if (!filePath) throw new Error('缺少文件路径');
    const result = await ocrFile(filePath, args?.purpose);
    return { type: 'text', text: JSON.stringify(result, null, 2) };
  }
  const guest = await ensureBrowserGuest();
  if (tool !== 'open_browser' && tool !== 'browser_navigate') {
    assertCurrentBrowserOrigin(guest);
  }
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
  if (tool === 'browser_eval') {
    if (!readLocalToolsPrefs().browserFullCdp) throw new Error('完整 CDP 未启用');
    const script = typeof args?.script === 'string' ? args.script : '';
    if (!script.trim()) throw new Error('缺少脚本内容');
    const value = await guest.executeJavaScript(script, true);
    return {
      type: 'text',
      text: JSON.stringify({ result: value === undefined ? null : value }, null, 2),
    };
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
  if (tool === 'browser_upload') {
    const rawPaths = Array.isArray(args?.paths)
      ? args.paths
      : typeof args?.path === 'string'
        ? [args.path]
        : [];
    const paths = [...new Set(rawPaths.filter((entry) => typeof entry === 'string' && entry.trim()))];
    if (!paths.length) throw new Error('缺少上传文件路径');
    if (paths.length > 10) throw new Error('一次最多上传 10 个文件');
    let totalBytes = 0;
    const files = paths.map((entry) => {
      const absolute = path.resolve(entry.trim());
      if (!path.isAbsolute(entry.trim())) throw new Error(`上传路径必须是绝对路径：${entry}`);
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        throw new Error(`文件不存在：${absolute}`);
      }
      if (!stat.isFile()) throw new Error(`不是普通文件：${absolute}`);
      if (stat.size > 100 * 1024 * 1024) throw new Error(`文件超过 100MB：${absolute}`);
      totalBytes += stat.size;
      return absolute;
    });
    if (totalBytes > 250 * 1024 * 1024) throw new Error('上传文件总大小超过 250MB');
    let pageUrl = '';
    try {
      pageUrl = guest.getURL() || '';
    } catch {
      pageUrl = '';
    }
    const site = normalizeBrowserOrigin(pageUrl) || pageUrl || '当前页面';
    const fileNames = files.map((file) => path.basename(file));
    if (!win) throw new Error('主窗口不可用，无法确认文件上传');
    const confirmation = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['允许上传', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '确认上传文件',
      message: `允许 AI 将 ${files.length} 个文件上传到 ${site}？`,
      detail: `文件：\n${files.slice(0, 8).join('\n')}${files.length > 8 ? '\n…' : ''}\n\n上传会将本地文件内容发送到该网站。`,
    });
    if (confirmation.response !== 0) throw new Error('已取消文件上传');
    const marker = crypto.randomBytes(8).toString('hex');
    const spec = JSON.stringify({
      ref: typeof args?.ref === 'string' ? args.ref : null,
      selector: typeof args?.selector === 'string' ? args.selector : null,
    });
    const input = await guest.executeJavaScript(
      `(() => {
        const spec = ${spec};
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        let el = null;
        if (spec.ref) el = document.querySelector('[data-shanui-ref="' + CSS.escape(spec.ref) + '"]');
        if (!el && spec.selector) el = document.querySelector(spec.selector);
        if (!el) el = inputs.length === 1 ? inputs[0] : null;
        if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('未找到文件输入元素');
        if (!el.multiple && ${files.length} > 1) throw new Error('该文件输入只允许单个文件');
        el.setAttribute('data-shanui-upload-id', ${JSON.stringify(marker)});
        return { multiple: el.multiple, accept: el.accept || '' };
      })()`,
      true,
    );
    try {
      await guestInput(guest, 'DOM.enable');
      const documentNode = await guestInput(guest, 'DOM.getDocument', {
        depth: 1,
        pierce: true,
      });
      const query = await guestInput(guest, 'DOM.querySelector', {
        nodeId: documentNode.root.nodeId,
        selector: `input[data-shanui-upload-id="${marker}"]`,
      });
      if (!query?.nodeId) throw new Error('文件输入元素已失效，请重新获取页面快照');
      await guestInput(guest, 'DOM.setFileInputFiles', {
        files,
        nodeId: query.nodeId,
      });
    } finally {
      await guest
        .executeJavaScript(
          `document.querySelector('input[data-shanui-upload-id="${marker}"]')?.removeAttribute('data-shanui-upload-id'); true`,
          true,
        )
        .catch(() => null);
    }
    return {
      type: 'text',
      text: `已向 ${site} 上传 ${files.length} 个文件：${fileNames.join('、')}${input.multiple ? '（允许多选）' : ''}`,
    };
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
  client.on('serverRequest', (message) => {
    if (message.method === 'mcpServer/elicitation/request' && win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    sendToRenderer('rpc:serverRequest', message);
  });
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
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          extensions: {
            'openai/standard-form-input': {},
          },
        },
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
    contents.session.setPermissionRequestHandler(
      (requesting, permission, callback, details) => {
        callback(browserPermissionAllowedForRequest(requesting, permission, details));
      },
    );
    contents.session.setPermissionCheckHandler(
      (requesting, permission, requestingOrigin, details) =>
        browserPermissionAllowedForRequest(
          requesting,
          permission,
          details,
          requestingOrigin,
        ),
    );
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

handleIpc('app:ocr-file', async (_event, payload) => {
  const filePath = typeof payload?.path === 'string' ? payload.path : '';
  if (!filePath) throw new Error('缺少文件路径');
  return ocrFile(filePath, payload?.purpose);
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

handleIpc('app:capture-screen', async () => {
  const file = path.join(
    attachmentsDir,
    `screen-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height;
$graphics=[System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size);
$bitmap.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose(); $bitmap.Dispose();`;
  await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message || '截屏失败').trim()));
        else resolve();
      },
    );
  });
  addAllowedRoot(path.dirname(file));
  return file;
});

handleIpc('browser:save-page-shot', async (_event, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('页面截图数据无效');
  }
  const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error('页面截图大小无效');
  const file = path.join(
    attachmentsDir,
    `page-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );
  await fs.promises.writeFile(file, buffer);
  addAllowedRoot(path.dirname(file));
  return file;
});

function normalizeBrowserOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeBrowserHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

async function listBrowserSiteData(historyOrigins) {
  const sites = new Map();
  const ensureSite = (host) => {
    let site = sites.get(host);
    if (!site) {
      site = {
        host,
        origins: new Set(),
        cookieCount: 0,
        partitions: new Set(),
        hasHistory: false,
      };
      sites.set(host, site);
    }
    return site;
  };
  for (const value of Array.isArray(historyOrigins) ? historyOrigins : []) {
    const origin = normalizeBrowserOrigin(value);
    if (!origin) continue;
    const host = normalizeBrowserHost(new URL(origin).hostname);
    if (!host) continue;
    const site = ensureSite(host);
    site.origins.add(origin);
    site.hasHistory = true;
  }
  for (const partition of ['persist:shanui-browser', 'persist:shanui-web-tools']) {
    const target = session.fromPartition(partition);
    let cookies = [];
    try {
      cookies = await target.cookies.get({});
    } catch {
      cookies = [];
    }
    for (const cookie of cookies) {
      const host = normalizeBrowserHost(String(cookie.domain || '').replace(/^\./, ''));
      if (!host) continue;
      const site = ensureSite(host);
      site.cookieCount += 1;
      site.partitions.add(partition === 'persist:shanui-browser' ? 'browser' : 'webTools');
      if (!site.origins.size) site.origins.add(`https://${host}`);
    }
  }
  const prefs = readLocalToolsPrefs();
  return [...sites.values()]
    .map((site) => {
      const origins = [...site.origins].slice(0, 20);
      const permissions = [
        ...new Set(
          origins.flatMap((origin) => prefs.browserSitePermissions?.[origin] || []),
        ),
      ].sort();
      const policies = origins
        .map((origin) => prefs.browserSiteDownloadPolicies?.[origin])
        .filter(Boolean);
      const downloadPolicy =
        policies.length === 0
          ? 'default'
          : policies.every((policy) => policy === 'allow')
            ? 'allow'
            : policies.every((policy) => policy === 'deny')
              ? 'deny'
              : 'mixed';
      return {
        host: site.host,
        origins,
        cookieCount: site.cookieCount,
        hasHistory: site.hasHistory,
        partitions: [...site.partitions],
        permissions,
        downloadPolicy,
      };
    })
    .filter((site) => site.cookieCount > 0 || site.hasHistory)
    .sort(
      (left, right) =>
        Number(right.cookieCount > 0) - Number(left.cookieCount > 0) ||
        right.cookieCount - left.cookieCount ||
        left.host.localeCompare(right.host),
    )
    .slice(0, 50);
}

async function clearBrowserSiteData(payload) {
  const host = normalizeBrowserHost(payload?.host);
  if (!host) throw new Error('站点 host 无效');
  const origins = new Set([`http://${host}`, `https://${host}`]);
  for (const value of Array.isArray(payload?.origins) ? payload.origins : []) {
    const origin = normalizeBrowserOrigin(value);
    if (origin && normalizeBrowserHost(new URL(origin).hostname) === host) origins.add(origin);
  }
  for (const partition of ['persist:shanui-browser', 'persist:shanui-web-tools']) {
    const target = session.fromPartition(partition);
    const cookies = await target.cookies.get({}).catch(() => []);
    for (const cookie of cookies) {
      const cookieHost = normalizeBrowserHost(String(cookie.domain || '').replace(/^\./, ''));
      if (!cookieHost || (cookieHost !== host && !cookieHost.endsWith(`.${host}`))) continue;
      const scheme = cookie.secure ? 'https' : 'http';
      const cookiePath = cookie.path || '/';
      await target.cookies
        .remove(`${scheme}://${cookieHost}${cookiePath}`, cookie.name)
        .catch(() => null);
    }
    for (const origin of origins) {
      await target
        .clearData({
          origins: [origin],
          dataTypes: [
            'cache',
            'fileSystems',
            'indexedDB',
            'localStorage',
            'serviceWorkers',
            'webSQL',
          ],
        })
        .catch(() => null);
    }
  }
  return true;
}

handleIpc('browser:list-site-data', (_event, historyOrigins) =>
  listBrowserSiteData(historyOrigins),
);

handleIpc('browser:clear-site-data', (_event, payload) => clearBrowserSiteData(payload));

handleIpc('browser:set-site-permissions', (_event, payload) => {
  const origins = [
    ...new Set(
      (Array.isArray(payload?.origins) ? payload.origins : [])
        .slice(0, 50)
        .map(normalizeBrowserOrigin)
        .filter(Boolean),
    ),
  ];
  const permissions = [
    ...new Set(
      (Array.isArray(payload?.permissions) ? payload.permissions : [])
        .slice(0, 20)
        .filter(
          (permission) =>
            typeof permission === 'string' &&
            BROWSER_SITE_PERMISSION_NAMES.has(permission),
        ),
    ),
  ];
  if (!origins.length) throw new Error('站点 origin 无效');
  if (!permissions.length) throw new Error('站点权限无效');
  const enabled = Boolean(payload?.enabled);
  const prefs = readLocalToolsPrefs();
  const next = { ...prefs.browserSitePermissions };
  for (const origin of origins) {
    const current = new Set(next[origin] || []);
    for (const permission of permissions) {
      if (enabled) current.add(permission);
      else current.delete(permission);
    }
    if (current.size) next[origin] = [...current].sort();
    else delete next[origin];
  }
  prefs.browserSitePermissions = normalizeBrowserSitePermissions(next);
  return writeLocalToolsPrefs(prefs);
});

handleIpc('browser:set-site-download-policy', (_event, payload) => {
  const origins = [
    ...new Set(
      (Array.isArray(payload?.origins) ? payload.origins : [])
        .slice(0, 50)
        .map(normalizeBrowserOrigin)
        .filter(Boolean),
    ),
  ];
  const policy = ['default', 'allow', 'deny'].includes(payload?.policy)
    ? payload.policy
    : null;
  if (!origins.length) throw new Error('站点 origin 无效');
  if (!policy) throw new Error('下载策略无效');
  const prefs = readLocalToolsPrefs();
  const next = { ...prefs.browserSiteDownloadPolicies };
  for (const origin of origins) {
    if (policy === 'default') delete next[origin];
    else next[origin] = policy;
  }
  prefs.browserSiteDownloadPolicies = normalizeBrowserSiteDownloadPolicies(next);
  return writeLocalToolsPrefs(prefs);
});

handleIpc('browser:clear-data', async (_event, payload) => {
  const partitions = ['persist:shanui-browser', 'persist:shanui-web-tools'];
  for (const partition of partitions) {
    const target = session.fromPartition(partition);
    if (payload?.cache) await target.clearCache();
    if (payload?.cookies) {
      await target.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
      });
      await target.clearAuthCache();
    }
  }
  return true;
});

handleIpc('browser:activate', (_event, webContentsId) => {
  const id = Number(webContentsId);
  if (!Number.isInteger(id)) return false;
  const guest = webContents.fromId(id);
  if (!guest || guest.isDestroyed()) return false;
  browserGuest = guest;
  return true;
});

handleIpc('app:get-downloads', () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(downloadsFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
});

handleIpc('app:clear-downloads', () => {
  try {
    fs.rmSync(downloadsFile(), { force: true });
  } catch {
    /* ignore */
  }
  return true;
});

handleIpc('app:show-download', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) throw new Error('无效路径');
  const target = await realpathNearest(path.resolve(targetPath));
  const root = await realpathNearest(app.getPath('downloads'));
  if (!isPathInside(root, target)) throw new Error('下载路径不在允许范围');
  shell.showItemInFolder(target);
  return true;
});

handleIpc('app:get-computer-history', () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(computerHistoryFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
});

handleIpc('app:clear-computer-history', () => {
  try {
    fs.rmSync(computerHistoryFile(), { force: true });
  } catch {
    /* ignore */
  }
  return true;
});

async function getCurrentComputerApp() {
  const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ShanuiForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@;
$window = [ShanuiForegroundWindow]::GetForegroundWindow();
if ($window -eq [IntPtr]::Zero) { Write-Output 'null'; exit 0 }
$processId = [uint32]0;
[void][ShanuiForegroundWindow]::GetWindowThreadProcessId($window, [ref]$processId);
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue;
if (-not $process) { Write-Output 'null'; exit 0 }
$buffer = New-Object System.Text.StringBuilder 512;
[void][ShanuiForegroundWindow]::GetWindowText($window, $buffer, $buffer.Capacity);
$executablePath = '';
try { $executablePath = [string]$process.Path } catch {}
Write-Output ([pscustomobject]@{
  hwnd = $window.ToInt64();
  processId = $processId;
  process = $process.ProcessName;
  path = $executablePath;
  title = $buffer.ToString()
} | ConvertTo-Json -Compress)`;
  const output = await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || '').trim());
      },
    );
  });
  if (!output || output === 'null') return null;
  const info = JSON.parse(output);
  const process = String(info?.process || '').trim();
  if (!process) return null;
  const executablePath = String(info?.path || '').trim();
  return {
    appId: executablePath || `process:${process}`,
    displayName: process,
    process,
    path: executablePath,
    title: String(info?.title || ''),
    hwnd: Number(info?.hwnd || 0),
    processId: Number(info?.processId || 0),
  };
}

async function listComputerApps() {
  const script = `$items=@();
foreach ($process in Get-Process) {
  if ($process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
  $executablePath='';
  try { $executablePath=[string]$process.Path } catch {}
  $name=[string]$process.ProcessName;
  $items += [pscustomobject]@{
    appId=$(if ($executablePath) { $executablePath } else { "process:$name" });
    displayName=$name;
    process=$name;
    path=$executablePath;
    title=[string]$process.MainWindowTitle;
    hwnd=$process.MainWindowHandle.ToInt64();
    processId=$process.Id
  }
}
Write-Output ([pscustomobject]@{apps=@($items | Sort-Object displayName)} | ConvertTo-Json -Depth 5 -Compress)`;
  const output = await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || '').trim());
      },
    );
  });
  const parsed = JSON.parse(output || '{"apps":[]}');
  return (Array.isArray(parsed?.apps) ? parsed.apps : [])
    .filter((app) => app?.process && !isBlockedComputerApp(app.process))
    .map((app) => ({
      appId: String(app.path || '').trim() || `process:${app.process}`,
      displayName: String(app.process),
      process: String(app.process),
      path: String(app.path || ''),
      title: String(app.title || ''),
      hwnd: Number(app.hwnd || 0),
      processId: Number(app.processId || 0),
    }));
}

handleIpc('app:get-local-tools', () => readLocalToolsPrefs());

handleIpc('app:set-local-tools', async (_event, payload) => {
  const prefs = {
    browser: Boolean(payload?.browser),
    computer: Boolean(payload?.computer),
    search: Boolean(payload?.search),
    ocr: Boolean(payload?.ocr),
    searchProvider: ['auto', 'deepseek', 'local'].includes(payload?.searchProvider)
      ? payload.searchProvider
      : 'auto',
    computerAllowedApps: normalizeComputerApps(payload?.computerAllowedApps),
    browserOriginPolicy: payload?.browserOriginPolicy === 'allowlist' ? 'allowlist' : 'any',
    browserAllowedOrigins: Array.isArray(payload?.browserAllowedOrigins)
      ? payload.browserAllowedOrigins
          .filter((origin) => typeof origin === 'string' && origin.trim())
          .map((origin) => origin.trim())
      : [],
    browserFullCdp: Boolean(payload?.browserFullCdp),
    browserDownloadPolicy: payload?.browserDownloadPolicy === 'deny' ? 'deny' : 'allow',
    browserFileAccess: Boolean(payload?.browserFileAccess),
    browserSitePermissions: normalizeBrowserSitePermissions(
      payload?.browserSitePermissions,
    ),
    browserSiteDownloadPolicies: normalizeBrowserSiteDownloadPolicies(
      payload?.browserSiteDownloadPolicies,
    ),
  };
  return writeLocalToolsPrefs(prefs);
});

handleIpc('app:get-current-computer-app', () => getCurrentComputerApp());
handleIpc('app:list-computer-apps', () => listComputerApps());

handleIpc('app:allow-computer-app', (_event, appId) => {
  if (isBlockedComputerApp(appId)) {
    throw new Error('终端、安全软件与客户端自身禁止自动控制');
  }
  const prefs = readLocalToolsPrefs();
  const normalized = normalizeComputerApps([appId]);
  if (!normalized.length) throw new Error('应用标识无效');
  const existing = new Set(prefs.computerAllowedApps.map((app) => app.toLowerCase()));
  prefs.computerAllowedApps = [
    ...prefs.computerAllowedApps,
    ...normalized.filter((app) => !existing.has(app.toLowerCase())),
  ];
  return writeLocalToolsPrefs(prefs);
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
  if (extension === '.pdf') {
    if (stat.size > 30 * 1024 * 1024) throw new Error('PDF 超过 30MB，请在外部阅读器中打开');
    const data = await fs.promises.readFile(target);
    return {
      kind: 'pdf',
      dataUrl: `data:application/pdf;base64,${data.toString('base64')}`,
      size: stat.size,
      path: file,
      absolutePath: target,
    };
  }
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
    setupDownloadTracking();
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
