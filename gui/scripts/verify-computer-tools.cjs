const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = path.join(os.tmpdir(), `shanui-computer-${process.pid}.txt`);
fs.writeFileSync(fixture, '');
const fixtureName = path.basename(fixture);
const notepad = spawn('notepad.exe', [fixture], { stdio: 'ignore', windowsHide: false });
const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'shanui-local-mcp.cjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SHANUI_ENABLE_COMPUTER: '1',
    SHANUI_COMPUTER_ALLOWED_APPS: JSON.stringify(['notepad']),
    SHANUI_WGC_CAPTURE: path.join(
      __dirname,
      '..',
      '..',
      'native',
      'wgc-capture',
      'bin',
      'wgc-capture.exe',
    ),
  },
});

let nextId = 1;
let buffer = '';
const pending = new Map();
mcp.stderr.on('data', (chunk) => process.stderr.write(chunk));
mcp.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function tool(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  const text = (result.content || []).find((entry) => entry.type === 'text')?.text || '';
  return text;
}

function parseJson(text) {
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let notepadPid = null;
  try {
    await sleep(1800);
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-computer', version: '1' },
    });
    const windows = parseJson(await tool('computer_list_windows', {})).windows;
    const window = windows.find(
      (entry) =>
        /notepad/i.test(entry.process || entry.app || '') &&
        String(entry.title || '').includes(fixtureName),
    );
    if (!window) throw new Error('notepad window not found');
    notepadPid = window.processId;
    const rehydrated = parseJson(await tool('computer_get_window', { window }));
    const state = parseJson(
      await tool('computer_window_state', {
        window,
        include_screenshot: true,
        include_text: true,
      }),
    );
    const screenshot = state.screenshots?.[0];
    if (!screenshot?.id || !screenshot.width) throw new Error('window screenshot missing');
    if (screenshot.captureMethod !== 'wgc') {
      throw new Error(`expected WGC capture, got ${screenshot.captureMethod || 'unknown'}`);
    }
    const bodyX = Math.max(40, Math.round(screenshot.width * 0.5));
    const bodyY = Math.max(40, Math.round(screenshot.height * 0.35));
    await tool('computer_click', {
      window: state.window,
      screenshotId: screenshot.id,
      x: bodyX,
      y: bodyY,
    });
    await tool('computer_type', { window: state.window, text: 'SHANUI_COMPUTER_OK' });
    await tool('computer_key', { window: state.window, key: 'Control_L+a' });
    const after = parseJson(
      await tool('computer_window_state', {
        window: state.window,
        include_screenshot: true,
        include_text: true,
      }),
    );
    const afterScreenshot = after.screenshots?.[0];
    await tool('computer_drag', {
      window: after.window,
      screenshotId: afterScreenshot?.id,
      from_x: Math.round(screenshot.width * 0.25),
      from_y: bodyY,
      to_x: Math.round(screenshot.width * 0.65),
      to_y: bodyY,
    });
    await tool('computer_scroll', {
      window: after.window,
      screenshotId: afterScreenshot?.id,
      x: bodyX,
      y: bodyY,
      scrollX: 0,
      scrollY: 120,
    });
    const documentText = `${after.accessibility?.document_text || ''} ${after.accessibility?.tree || ''}`;
    if (!documentText.includes('SHANUI_COMPUTER_OK')) {
      throw new Error('typed text not found in accessibility state');
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          window: { id: rehydrated.id, title: rehydrated.title, app: rehydrated.app },
          screenshot: {
            width: screenshot.width,
            height: screenshot.height,
            captureMethod: screenshot.captureMethod,
          },
          typed: true,
          screenshotId: screenshot.id,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      notepad.kill();
    } catch {
      /* ignore */
    }
    if (notepadPid) {
      spawn('taskkill', ['/PID', String(notepadPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    mcp.kill();
    fs.rmSync(fixture, { force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
