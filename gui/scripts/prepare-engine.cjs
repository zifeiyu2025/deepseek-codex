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

fs.copyFileSync(source, target);
console.log(`engine ready: ${source} -> ${target}`);
