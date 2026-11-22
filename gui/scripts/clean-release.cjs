const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const apply = process.argv.includes('--yes');
const targets = [
  'release-041',
  'release-042',
  'release-043',
  'release-044',
  'release/win-unpacked',
  'release/codex.exe',
];

function sizeOf(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) total += sizeOf(child);
      else total += fs.statSync(child).size;
    } catch {
      /* ignore locked descendants */
    }
  }
  return total;
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

console.log(apply ? 'CLEAN_RELEASE_APPLY' : 'CLEAN_RELEASE_DRY_RUN');
const failures = [];
for (const relative of targets) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  const size = sizeOf(target);
  if (!apply) {
    console.log(`WOULD_DELETE ${relative} (${formatSize(size)})`);
    continue;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`DELETED ${relative} (${formatSize(size)})`);
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    console.error(`DELETE_FAILED ${relative}: ${error.message}`);
  }
}

if (!apply) console.log('Use --yes to delete the listed paths.');
if (failures.length > 0) process.exit(1);
