const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', 'codex.exe');
const candidates = [
  process.env.CODEX_BIN,
  path.resolve(__dirname, '..', '..', 'dist', 'codex.exe'),
  path.resolve(__dirname, '..', '..', 'build', 'release', 'codex.exe'),
].filter(Boolean);

const source = candidates.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!source) {
  console.error('codex.exe not found. Build the engine first (bash build.sh).');
  process.exit(1);
}

if (fs.existsSync(target)) {
  try {
    const fd = fs.openSync(target, 'a');
    fs.closeSync(fd);
  } catch {
    console.error('codex.exe is locked by a running app. Stop it before packaging.');
    process.exit(1);
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const temp = `${target}.tmp-${process.pid}`;
try {
  fs.copyFileSync(source, temp);
  const sourceHash = sha256(source);
  const tempHash = sha256(temp);
  if (sourceHash !== tempHash) {
    throw new Error(`engine copy hash mismatch: ${sourceHash} != ${tempHash}`);
  }
  fs.renameSync(temp, target);
  console.log(`engine ready: ${source} -> ${target} (sha256 ${sourceHash})`);
} catch (error) {
  try {
    fs.unlinkSync(temp);
  } catch {
    /* ignore */
  }
  console.error(`engine copy failed: ${error.message}`);
  process.exit(1);
}
