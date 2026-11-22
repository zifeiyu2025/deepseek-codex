const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const guiRoot = path.resolve(__dirname, '..');
const electron = path.join(
  guiRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const entry = path.join(guiRoot, 'dist', 'index.html');

if (!fs.existsSync(entry)) {
  console.error('dist/index.html not found. Run npm run build first.');
  process.exit(1);
}
if (!fs.existsSync(electron)) {
  console.error(`Electron executable not found: ${electron}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timeout')));
  });
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      if (
        Array.isArray(targets) &&
        targets.some((target) => target.type === 'page' && target.url.includes('index.html'))
      ) {
        return;
      }
    } catch {
      /* not ready */
    }
    await sleep(300);
  }
  throw new Error(`renderer page did not appear on port ${port}`);
}

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

(async () => {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-codex-smoke-'));
  let logs = '';
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${port}`],
    {
      cwd: guiRoot,
      env: { ...process.env, DEEPSEEK_CODEX_USER_DATA: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  let code = 1;
  try {
    await waitForPage(port, 30000);
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'e2e-smoke.cjs'), String(port)],
      { cwd: guiRoot, stdio: 'inherit' },
    );
    code = result.status ?? 1;
  } catch (error) {
    console.error(`SMOKE_HARNESS_ERROR ${error.message}`);
  } finally {
    if (!exited) {
      stopTree(child.pid);
      for (let i = 0; i < 20 && !exited; i += 1) await sleep(100);
    }
    if (code === 0) {
      fs.rmSync(profile, { recursive: true, force: true });
    } else {
      console.error(`Smoke profile kept for diagnosis: ${profile}`);
      if (logs.trim()) console.error(logs.trim().split('\n').slice(-30).join('\n'));
    }
  }
  process.exit(code);
})().catch((error) => {
  console.error(`SMOKE_HARNESS_FATAL ${error.message}`);
  process.exit(1);
});
