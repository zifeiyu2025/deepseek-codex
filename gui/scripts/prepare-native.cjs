const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'native', 'wgc-capture', 'wgc_capture.cpp');
const script = path.join(root, 'native', 'wgc-capture', 'build.cmd');
const output = path.join(root, 'native', 'wgc-capture', 'bin', 'wgc-capture.exe');

function newerThanOutput(file) {
  try {
    return fs.statSync(file).mtimeMs > fs.statSync(output).mtimeMs;
  } catch {
    return true;
  }
}

if (fs.existsSync(output) && !newerThanOutput(source) && !newerThanOutput(script)) {
  console.log(`native helper ready: ${output}`);
  process.exit(0);
}

const result = spawnSync('cmd.exe', ['/c', 'call', script], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.status !== 0 || !fs.existsSync(output)) {
  console.error('WGC native helper build failed');
  process.exit(1);
}
console.log(`native helper ready: ${output}`);
