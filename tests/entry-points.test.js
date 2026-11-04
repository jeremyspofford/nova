// B5: the server and the supervisor run their main block from any path, including one that needs
// URL encoding (a space here; a native Windows path is the same mismatch). The repo is reached
// through a symlink in a folder with a space, and --preserve-symlinks-main keeps that path in
// import.meta.url, so `file://${argv[1]}` can't match it but pathToFileURL can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function viaSpacedPath(rel, args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-entry-'));
  try {
    mkdirSync(join(dir, 'my code'));
    symlinkSync(ROOT, join(dir, 'my code', 'nova'), 'dir');
    return spawnSync(process.execPath, ['--preserve-symlinks-main', join(dir, 'my code', 'nova', rel), ...args], {
      encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: dir, NOVA_HOME: join(dir, 'home'), ...env },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the supervisor runs its main block from a path with a space', () => {
  const r = viaSpacedPath('src/supervisor/main.ts', ['help'], {});
  assert.match(r.stdout, /Usage:/, `stdout: ${r.stdout} stderr: ${r.stderr}`);
});

test('the server runs its main block from a path with a space', () => {
  const r = viaSpacedPath('src/server.js', [], { NOVA_MESH_URL: 'not an address' });
  assert.match(r.stderr, /Nova didn't start: NOVA_MESH_URL isn't an address/, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.equal(r.status, 1);
});
