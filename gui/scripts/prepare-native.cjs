const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'native', 'wgc-capture', 'wgc_capture.cpp');
const script = path.join(root, 'native', 'wgc-capture', 'build.cmd');
const output = path.join(root, 'native', 'wgc-capture', 'bin', 'wgc-capture.exe');
const vswhere = path.join(
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
);

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

let vcvars = '';
try {
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const install = (found.stdout || '').trim();
  if (install) vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
} catch {
  /* build.cmd has a local fallback */
}

const result = spawnSync('cmd.exe', ['/c', 'call', script], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, WGC_VCVARS: vcvars },
});
if (result.status !== 0 || !fs.existsSync(output)) {
  console.error('WGC native helper build failed');
  process.exit(1);
}
console.log(`native helper ready: ${output}`);
