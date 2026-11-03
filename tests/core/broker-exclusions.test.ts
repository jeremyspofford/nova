import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGit, inSecretDir } from '../../src/home.js';
import { backupFiles } from '../../src/core/resilience/backup.ts';
import { journalPath } from '../../src/core/mesh/sync.ts';
import { world, open } from './resilience-support.ts';

test('actual git, backup, journal and checkpoint selections exclude broker keys, headers, logs and runtime', async () => {
  const w = world('nova-broker-exclusions-'); const c = open(w.home);
  const files = ['device.key', 'sign.key', 'device.json', 'vault.json', 'audit.log', 'run/programs/retained/key', 'items/cipher.json'];
  try {
    for (const f of files) { const path = join(w.home, 'broker', f); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'synthetic-' + f); }
    await ensureGit(w.home);
    for (const f of files) {
      const rel = `broker/${f}`;
      assert.equal(inSecretDir(rel), 'broker');
      assert.equal(journalPath(rel), null);
      assert.equal(execFileSync('git', ['-C', w.home, 'check-ignore', rel], { encoding: 'utf8', env: { HOME: w.dir, PATH: process.env.PATH! } }).trim(), rel);
    }
    assert.deepEqual(backupFiles(w.home).filter((p) => p.startsWith('broker/')), ['broker/items/cipher.json']);
    c.checkpoints.take({ kind: 'named', name: 'broker exclusions' });
    assert.equal(readdirSync(join(w.home, 'checkpoints'), { recursive: true }).map(String).some((p) => p.split('/').includes('broker')), false);
  } finally { await c.close(); }
});
