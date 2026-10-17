// Secret scan over the tracked files (FR-101, docs/12 §5). Uses the redactor's patterns through
// packages/security/src/scan.ts; fixtures stay quiet when obviously fake or marked with
// `secret-scan: fake`. Exits 1 on a finding, 2 when the file list cannot be read.
// Usage: node scripts/secret-scan.mjs [--root DIR] [--no-git]
//   --no-git walks the directory instead of asking git for the tracked files.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { scanText } from '../packages/security/src/scan.ts';

const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  '.turbo',
  'target',
  'test-results',
  'playwright-report',
]);

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = resolve(rootArg >= 0 ? (args[rootArg + 1] ?? '.') : join(import.meta.dirname, '..'));
const useGit = !args.includes('--no-git');

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), files);
    } else if (entry.isFile()) {
      files.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return files;
}

/** Binary files (a NUL in the first 8 KB) are skipped, like most scanners do. */
function isBinary(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

let files;
try {
  files = useGit ? trackedFiles() : walk(root);
} catch (err) {
  console.error(`secret-scan: cannot list files in ${root}: ${err.message}`);
  process.exit(2);
}

const findings = [];
let scanned = 0;
for (const file of files) {
  const abs = join(root, file);
  let size;
  try {
    const st = statSync(abs);
    if (!st.isFile()) continue;
    size = st.size;
  } catch {
    continue; // deleted in the working tree
  }
  if (size === 0 || size > MAX_BYTES || isBinary(abs)) continue;
  scanned++;
  findings.push(...scanText(file, readFileSync(abs, 'utf8')));
}

for (const f of findings) {
  console.error(`${f.path}:${f.line}:${f.column}  ${f.rule}  ${f.preview}`);
}
if (findings.length) {
  console.error(
    `\nsecret-scan: ${findings.length} possible secret(s) in ${scanned} files. Move real secrets to ` +
      'the vault (secret:// references); mark test fixtures with a "secret-scan: fake" comment.',
  );
  process.exit(1);
}
console.log(`secret-scan: no secrets found in ${scanned} files`);
