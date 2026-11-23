const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const bridgeFile =
  process.env.SHANUI_BRIDGE_FILE || path.join(os.homedir(), '.codex', 'shanui-bridge.json');
const enableBrowser = process.env.SHANUI_ENABLE_BROWSER === '1';
const enableComputer = process.env.SHANUI_ENABLE_COMPUTER === '1';
const enableWebSearch = process.env.SHANUI_ENABLE_WEB_SEARCH === '1';
const enableOcr = process.env.SHANUI_ENABLE_OCR === '1';
const enableFullCdp = process.env.SHANUI_BROWSER_FULL_CDP === '1';
const computerAllowedApps = (() => {
  try {
    const parsed = JSON.parse(process.env.SHANUI_COMPUTER_ALLOWED_APPS || '[]');
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string' && name.trim()) : [];
  } catch {
    return [];
  }
})();

function log(message) {
  process.stderr.write(`[shanui-local-mcp] ${message}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function bridgeRequest(tool, args) {
  return new Promise((resolve, reject) => {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    } catch {
      reject(new Error('内置浏览器桥未就绪，请先启动客户端'));
      return;
    }
    const body = JSON.stringify({ tool, args });
    const request = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-shanui-token': info.token,
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            const payload = JSON.parse(data || '{}');
            if (!payload.ok) reject(new Error(payload.error || '浏览器操作失败'));
            else resolve(payload.result);
          } catch (error) {
            reject(new Error(`浏览器桥响应无效：${error.message}`));
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('浏览器操作超时')));
    request.write(body);
    request.end();
  });
}

function runPowerShell(script, args, timeout = 30000) {
  const encoded = Buffer.from(JSON.stringify(args || {}), 'utf8').toString('base64');
  const command = `$env:SHANUI_ARGS_B64='${encoded}'; $a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SHANUI_ARGS_B64)) | ConvertFrom-Json; ${script}`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', command],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'PowerShell 执行失败').trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function computerScreenshot(args) {
  const file = path.join(os.tmpdir(), `shanui-screen-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const requested = Number(args?.screen);
  const screenIndex = Number.isInteger(requested) ? requested : -1;
  await runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$screens=[System.Windows.Forms.Screen]::AllScreens;
$index=${screenIndex};
if ($index -lt 0) { $screen=[System.Windows.Forms.Screen]::PrimaryScreen } elseif ($index -lt $screens.Count) { $screen=$screens[$index] } else { throw '屏幕索引超出范围' }
$bounds=$screen.Bounds;
$bitmap=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height;
$graphics=[System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size);
$bitmap.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose(); $bitmap.Dispose();
Write-Output $bounds.Width;
Write-Output $bounds.Height;`,
    {},
  );
  const data = fs.readFileSync(file);
  fs.unlinkSync(file);
  return { type: 'image', mimeType: 'image/png', data: data.toString('base64') };
}

async function computerMonitors() {
  return runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms;
$index=0;
$items=@();
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $items += [pscustomobject]@{index=$index;device=$screen.DeviceName;primary=$screen.Primary;x=$screen.Bounds.X;y=$screen.Bounds.Y;width=$screen.Bounds.Width;height=$screen.Bounds.Height};
  $index++;
}
Write-Output ($items | ConvertTo-Json -Compress)`,
    {},
  );
}

async function ensureComputerAppAllowed() {
  if (!computerAllowedApps.length) return;
  const output = await computerActiveWindow();
  let info = null;
  try {
    info = JSON.parse(output);
  } catch {
    info = null;
  }
  const processName = String(info?.process || '').toLowerCase();
  const allowed = computerAllowedApps.some((name) => String(name).toLowerCase() === processName);
  if (!allowed) {
    throw new Error(`当前前台应用 ${info?.process || 'unknown'} 不在允许列表：${computerAllowedApps.join(', ')}`);
  }
}

async function computerMouse(action, args) {
  const x = Math.round(Number(args?.x));
  const y = Math.round(Number(args?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标无效');
  await ensureComputerAppAllowed();
  const button = ['left', 'right', 'middle'].includes(args?.button) ? args.button : 'left';
  if (action === 'move') {
    await runPowerShell(
      `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShanuiMouseMove {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
'@;
[ShanuiMouseMove]::SetCursorPos(${x},${y}) | Out-Null`,
      {},
    );
    return `已移动鼠标到 (${x}, ${y})`;
  }
  const down = button === 'right' ? 0x0008 : button === 'middle' ? 0x0020 : 0x0002;
  const up = button === 'right' ? 0x0010 : button === 'middle' ? 0x0040 : 0x0004;
  await runPowerShell(
    `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShanuiMouseClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
'@;
[ShanuiMouseClick]::SetCursorPos(${x},${y}) | Out-Null;
[ShanuiMouseClick]::mouse_event(${down},0,0,0,[UIntPtr]::Zero);
[ShanuiMouseClick]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`,
    {},
  );
  return `已${button === 'right' ? '右键' : button === 'middle' ? '中键' : '左键'}点击 (${x}, ${y})`;
}

async function computerScroll(args) {
  await ensureComputerAppAllowed();
  const direction = args?.direction === 'up' ? 1 : -1;
  const pages = Math.max(1, Math.min(20, Number(args?.pages) || 1));
  const delta = direction * pages * 120;
  await runPowerShell(
    `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShanuiMouseWheel {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
'@;
[ShanuiMouseWheel]::mouse_event(0x0800,0,0,${delta},[UIntPtr]::Zero)`,
    {},
  );
  return `已向${direction > 0 ? '上' : '下'}滚动 ${pages} 屏`;
}

const KEY_MAP = {
  enter: '{ENTER}',
  escape: '{ESC}',
  esc: '{ESC}',
  tab: '{TAB}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  'ctrl+a': '^a',
  'ctrl+c': '^c',
  'ctrl+v': '^v',
  'ctrl+x': '^x',
  'ctrl+z': '^z',
  'ctrl+s': '^s',
  'alt+tab': '%{TAB}',
  f5: '{F5}',
  f11: '{F11}',
};

async function computerKey(args) {
  const requested = String(args?.key || '').toLowerCase().trim();
  const mapped = KEY_MAP[requested];
  if (!mapped) throw new Error(`不支持的按键：${requested}`);
  await ensureComputerAppAllowed();
  await runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${mapped.replace(/'/g, "''")}');`,
    {},
  );
  return `已按下 ${requested}`;
}

async function computerType(args) {
  const text = typeof args?.text === 'string' ? args.text : '';
  if (!text) throw new Error('缺少输入文本');
  await ensureComputerAppAllowed();
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  await runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms;
$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
$previous=Get-Clipboard -Raw -ErrorAction SilentlyContinue;
Set-Clipboard -Value $text;
[System.Windows.Forms.SendKeys]::SendWait('^v');
Start-Sleep -Milliseconds 120;
if ($null -ne $previous) { Set-Clipboard -Value $previous } else { Set-Clipboard -Value '' }
Write-Output 'ok'`,
    {},
  );
  return `已输入 ${text.length} 个字符`;
}

async function computerActiveWindow() {
  const output = await runPowerShell(
    `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ShanuiWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@;
$handle=[ShanuiWindow]::GetForegroundWindow();
$buffer=New-Object System.Text.StringBuilder 512;
[ShanuiWindow]::GetWindowText($handle,$buffer,$buffer.Capacity) | Out-Null;
$processId=0;
[ShanuiWindow]::GetWindowThreadProcessId($handle,[ref]$processId) | Out-Null;
$process=Get-Process -Id $processId -ErrorAction SilentlyContinue;
Write-Output ([pscustomobject]@{title=$buffer.ToString();processId=$processId;process=$process.ProcessName} | ConvertTo-Json -Compress)`,
    {},
  );
  return output;
}

const browserTools = [
  {
    name: 'open_browser',
    description:
      'Open the in-app browser panel beside the conversation, optionally navigating to a URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional absolute http(s) URL' } },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the in-app browser. Only http/https URLs are allowed.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the current in-app browser page title, URL, visible text, and interactive elements.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the in-app browser by snapshot ref, CSS selector, exact visible text, or viewport coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, such as e3' },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input in the in-app browser and optionally submit.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Input ref from browser_snapshot, such as e4' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'Replace existing content; defaults to true' },
        submit: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a navigation or editing key in the in-app browser.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['enter', 'tab', 'escape', 'backspace', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'],
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the in-app browser page.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        pages: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_back',
    description: 'Go back in the in-app browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_forward',
    description: 'Go forward in the in-app browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_reload',
    description: 'Reload the in-app browser page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a short time for the page to update.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the in-app browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

if (enableFullCdp) {
  browserTools.push({
    name: 'browser_eval',
    description:
      'Execute JavaScript in the active in-app browser page and return its JSON-serializable result. Only available when full CDP access is enabled.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JavaScript expression or IIFE' } },
      required: ['script'],
    },
  });
}

const searchTools = [  {
    name: 'web_search',
    description:
      'Search the public web in the background with DeepSeek Search when configured, falling back to Bing. Returns result titles, URLs, and snippets; use web_fetch to read a result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        count: { type: 'number', description: 'Number of results, 1-10; defaults to 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a public web page in the background with DeepSeek Fetch when configured, falling back to a local renderer. Returns title, URL, description, and main text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        maxChars: { type: 'number', description: 'Maximum content characters, 1000-30000; defaults to 12000' },
      },
      required: ['url'],
    },
  },
];

const ocrTools = [
  {
    name: 'ocr',
    description:
      'Recognize text from a local PDF, Word, PowerPoint, or image file with DeepSeek OCR. Returns page-separated text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a local document or image' },
        purpose: {
          type: 'string',
          enum: ['text_recognition', 'rich_layout_recognition'],
          description: 'text_recognition extracts text; rich_layout_recognition keeps layout markers',
        },
      },
      required: ['path'],
    },
  },
];

const computerTools = [
  {
    name: 'computer_screenshot',
    description:
      'Capture a PNG screenshot of a display. Defaults to the primary display; use computer_monitors for indexes.',
    inputSchema: {
      type: 'object',
      properties: { screen: { type: 'number', description: 'Zero-based monitor index' } },
    },
  },
  {
    name: 'computer_monitors',
    description: 'List connected displays with index, device name, primary flag, and bounds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'computer_active_window',
    description: 'Return the active window title and process.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'computer_move',
    description: 'Move the mouse to absolute screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_click',
    description: 'Click at absolute screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_type',
    description: 'Type text into the active window using the clipboard.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'computer_key',
    description: 'Press a supported key or shortcut (enter, tab, escape, ctrl+a, alt+tab, f5...).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll the mouse wheel.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        pages: { type: 'number' },
      },
    },
  },
];

async function callTool(name, args) {
  if (name === 'web_search' || name === 'web_fetch') {
    if (!enableWebSearch) throw new Error('网页搜索未启用');
    const result = await bridgeRequest(name, args || {});
    return { content: [{ type: 'text', text: result.text || '' }] };
  }
  if (name === 'ocr') {
    if (!enableOcr) throw new Error('文档识别（OCR）未启用');
    const result = await bridgeRequest(name, args || {});
    return { content: [{ type: 'text', text: result.text || '' }] };
  }
  if (name.startsWith('browser_')) {
    if (!enableBrowser) throw new Error('浏览器控制未启用');
    const result = await bridgeRequest(name, args || {});
    return {
      content:
        result.type === 'image'
          ? [{ type: 'image', data: result.data, mimeType: result.mimeType || 'image/png' }]
          : [{ type: 'text', text: result.text || '' }],
    };
  }
  if (name === 'open_browser') {
    if (!enableBrowser) throw new Error('浏览器控制未启用');
    const result = await bridgeRequest(name, args || {});
    return { content: [{ type: 'text', text: result.text || '' }] };
  }
  if (name.startsWith('computer_')) {
    if (!enableComputer) throw new Error('电脑控制未启用');
    if (name === 'computer_screenshot') {
      const image = await computerScreenshot(args || {});
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
    }
    if (name === 'computer_monitors') {
      return { content: [{ type: 'text', text: await computerMonitors() }] };
    }
    if (name === 'computer_active_window') {
      return { content: [{ type: 'text', text: await computerActiveWindow() }] };
    }
    if (name === 'computer_move') {
      return { content: [{ type: 'text', text: await computerMouse('move', args || {}) }] };
    }
    if (name === 'computer_click') {
      return { content: [{ type: 'text', text: await computerMouse('click', args || {}) }] };
    }
    if (name === 'computer_type') {
      return { content: [{ type: 'text', text: await computerType(args || {}) }] };
    }
    if (name === 'computer_key') {
      return { content: [{ type: 'text', text: await computerKey(args || {}) }] };
    }
    if (name === 'computer_scroll') {
      return { content: [{ type: 'text', text: await computerScroll(args || {}) }] };
    }
  }
  throw new Error(`未知工具：${name}`);
}

const tools = [
  ...(enableBrowser ? browserTools : []),
  ...(enableWebSearch ? searchTools : []),
  ...(enableOcr ? ocrTools : []),
  ...(enableComputer ? computerTools : []),
];

function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.id === undefined) return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'shanui-local-tools', version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    callTool(name, args)
      .then((result) => reply(id, result))
      .catch((error) =>
        reply(id, {
          content: [{ type: 'text', text: error?.message || String(error) }],
          isError: true,
        }),
      );
    return;
  }
  replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log(`bad message: ${error.message}`);
    }
  }
});
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandled: ${error}`));
log(`started browser=${enableBrowser} computer=${enableComputer}`);
