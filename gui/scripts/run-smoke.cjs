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

function writeSmokePdf(file) {
  const pageOne = 'BT /F1 24 Tf 72 720 Td (Smoke PDF Page 1) Tj ET';
  const pageTwo = 'BT /F1 24 Tf 72 720 Td (Smoke PDF Page 2) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(pageOne)} >>\nstream\n${pageOne}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n',
    `6 0 obj\n<< /Length ${Buffer.byteLength(pageTwo)} >>\nstream\n${pageTwo}\nendstream\nendobj\n`,
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, Buffer.from(pdf, 'ascii'));
}

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
  const pdfFixture = path.join(profile, 'smoke-preview.pdf');
  writeSmokePdf(pdfFixture);
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
      {
        cwd: guiRoot,
        stdio: 'inherit',
        env: { ...process.env, SMOKE_PDF_FIXTURE: pdfFixture },
      },
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
