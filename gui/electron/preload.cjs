const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('codex', {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  rendererReady: () => ipcRenderer.send('app:renderer-ready'),
  request: (method, params) => ipcRenderer.invoke('rpc:request', method, params),
  respond: (id, result, error) => ipcRenderer.send('rpc:respond', id, result, error),
  setApiKey: (key) => ipcRenderer.invoke('app:set-api-key', key),
  apiKeyStatus: () => ipcRenderer.invoke('app:api-key-status'),
  pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
  pickFiles: () => ipcRenderer.invoke('app:pick-files'),
  pickImages: () => ipcRenderer.invoke('app:pick-images'),
  ocrFile: (payload) => ipcRenderer.invoke('app:ocr-file', payload),
  browserClearData: (payload) => ipcRenderer.invoke('browser:clear-data', payload),
  browserActivate: (webContentsId) => ipcRenderer.invoke('browser:activate', webContentsId),
  savePastedImage: () => ipcRenderer.invoke('app:save-pasted-image'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  createWorktree: (repoPath) => ipcRenderer.invoke('app:create-worktree', repoPath),
  imageDataUrl: (filePath) => ipcRenderer.invoke('app:image-data-url', filePath),
  showInFolder: (targetPath) => ipcRenderer.invoke('app:show-in-folder', targetPath),
  openPath: (targetPath) => ipcRenderer.invoke('app:open-path', targetPath),
  restartEngine: () => ipcRenderer.invoke('app:restart-engine'),
  localToolsStatus: () => ipcRenderer.invoke('app:get-local-tools'),
  setLocalTools: (prefs) => ipcRenderer.invoke('app:set-local-tools', prefs),
  gitInfo: (targetPath) => ipcRenderer.invoke('app:git-info', targetPath),
  listDir: (payload) => ipcRenderer.invoke('app:list-dir', payload),
  readFile: (payload) => ipcRenderer.invoke('app:read-file', payload),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),
  terminalStart: (payload) => ipcRenderer.invoke('terminal:start', payload),
  terminalInput: (payload) => ipcRenderer.invoke('terminal:input', payload),
  terminalResize: (payload) => ipcRenderer.invoke('terminal:resize', payload),
  terminalStop: (id) => ipcRenderer.invoke('terminal:stop', id),
  gitReview: (payload) => ipcRenderer.invoke('app:git-review', payload),
  gitStage: (payload) => ipcRenderer.invoke('app:git-stage', payload),
  gitUnstage: (payload) => ipcRenderer.invoke('app:git-unstage', payload),
  gitDiscard: (payload) => ipcRenderer.invoke('app:git-discard', payload),
  gitHunk: (payload) => ipcRenderer.invoke('app:git-hunk', payload),
  gitCommit: (payload) => ipcRenderer.invoke('app:git-commit', payload),
  gitPush: (payload) => ipcRenderer.invoke('app:git-push', payload),
  onTerminalData: (callback) => subscribe('terminal:data', callback),
  onTerminalExit: (callback) => subscribe('terminal:exit', callback),
  applyWorktree: (payload) => ipcRenderer.invoke('app:worktree-apply', payload),
  removeWorktree: (payload) => ipcRenderer.invoke('app:worktree-remove', payload),
  onNotification: (callback) => subscribe('rpc:notification', callback),
  onServerRequest: (callback) => subscribe('rpc:serverRequest', callback),
  onStatus: (callback) => subscribe('app:status', callback),
  onTrayAction: (callback) => subscribe('tray:action', callback),
  onBrowserOpen: (callback) => subscribe('browser:open', callback),
});

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximized: (callback) => subscribe('window:maximized', callback),
});
