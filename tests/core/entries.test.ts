// Nova's own entries in a home, by name (M7 amendment): what checkpoints, restore and factory reset
// may touch. Anything else at the top of the home isn't Nova's and is listed as foreign. The list
// must cover everything Nova itself writes at the top of a home: a real one, after a start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOVA_ENTRIES, foreignEntries, isNovaEntry } from '../../src/core/index.ts';
import { open } from './resilience-support.ts';

test('Nova’s own top-level entries, by name; everything else in the home is foreign', async () => {
  for (const n of ['nova.db', 'nova.db-wal', 'nova.db-shm', 'nova.db-journal', 'MEMORY.md', 'memory', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
    'sessions', 'schedules', 'skills', 'permissions.md', 'connectors', 'workspace', 'extensions', 'changes', 'vault', 'mesh', 'logs', 'workers',
    'kept', 'exports', 'backups', 'checkpoints', 'nova.pid', '.git', '.gitignore']) {
    assert.ok(NOVA_ENTRIES.includes(n) || isNovaEntry(n), `${n} is Nova’s`);
    assert.ok(isNovaEntry(n), n);
  }
  assert.ok(isNovaEntry('MEMORY.md.nova-sync-123.tmp'), 'a sync write in progress of one of Nova’s files');
  for (const n of ['proxy.js', 'notes-of-mine', 'nova.db.bak', 'Memory.md', '.env']) assert.equal(isNovaEntry(n), false, n);

  const home = mkdtempSync(join(tmpdir(), 'nova-entries-'));
  const c = open(home);
  try {
    c.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    c.vault.put('provider/EXAMPLE_KEY', 'placeholder');
    c.checkpoints.take({ kind: 'named', name: 'Here' });
    writeFileSync(join(home, 'proxy.js'), '// the person’s own\n');
    mkdirSync(join(home, 'notes-of-mine'));
    // Everything a started core wrote is Nova’s; only what the person put there is foreign.
    assert.deepEqual(foreignEntries(home), ['notes-of-mine', 'proxy.js']);
    // Nova's mark on its home (.nova-home) is neither: never copied, swapped or erased (home-mark.ts).
    assert.deepEqual(readdirSync(home).filter((n) => !isNovaEntry(n) && n !== '.nova-home').sort(), ['notes-of-mine', 'proxy.js']);
  } finally {
    await c.close();
  }
});
