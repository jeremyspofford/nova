// Run cargo for services/novad: natively when cargo is installed, otherwise in the official Rust
// container (R-006). Usage: node scripts/cargo.mjs <cargo args...>
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const crate = join(root, 'services', 'novad');
const args = process.argv.slice(2);
const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;

let result;
if (hasCargo) {
  result = spawnSync('cargo', args, { cwd: crate, stdio: 'inherit' });
} else {
  const cache = join(homedir(), '.cache', 'nova-cargo');
  mkdirSync(join(cache, 'registry'), { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${uid}:${gid}`,
      '-e',
      'CARGO_HOME=/cargo',
      '-v',
      `${cache}:/cargo`,
      '-v',
      `${crate}:/src`,
      '-w',
      '/src',
      'rust:1-slim-bookworm',
      'cargo',
      ...args,
    ],
    { stdio: 'inherit' },
  );
}
process.exit(result.status ?? 1);
