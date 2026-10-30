// The export a factory reset offers first (M7 amendment §2): the encrypted-copy format under a
// fresh recovery key shown once, plus the plain memory files; never the vault (saved secrets), its
// key or this node's identity; into a folder the person names, which Nova never creates; and a
// reset never touches it. Throwaway homes and folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openEncrypted } from '../../src/core/index.ts';
import { open, world } from './resilience-support.ts';

const CONSOLE = { principal: { kind: 'console' as const }, listener: 'console' as const, address: '127.0.0.1' };
const MEMORY = 'Prefers tea in the afternoon.';
const SECRET = 'sk-placeholder-0123456789abcdef';

const files = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)]));
const hashes = (dir: string) => Object.fromEntries(files(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));

test('the export opens with the recovery key shown once, has the memory files in plain text, and holds no secrets, vault key or identity', async () => {
  const w = world('nova-export-');
  const out = join(w.dir, 'my-export');
  const c = open(w.home);
  let closed = false;
  try {
    c.memory.remember({ kind: 'preference', content: MEMORY, recorded_by: 'person' });
    c.vault.put('provider/API_KEY', SECRET);
    mkdirSync(join(w.home, 'workspace', 'lists'), { recursive: true });
    writeFileSync(join(w.home, 'workspace', 'lists', 'shopping.md'), '- bread\n');

    // Nova never creates the folder, and never puts it inside its own home.
    assert.throws(() => c.reset.exportTo(out), /isn’t a folder Nova can see/);
    assert.throws(() => c.reset.exportTo(join(w.home, 'workspace')), /inside Nova’s home/);
    assert.throws(() => c.reset.exportTo('relative/path'), /full path/);
    mkdirSync(out, { mode: 0o700 });

    const e = c.reset.exportTo(out);
    assert.match(e.recovery_key, /^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    assert.match(e.said, /Your saved passwords and keys aren’t in the export; you’ll add them again\./);
    assert.ok(e.folder.startsWith(out) && existsSync(e.file));
    // Shown once: nowhere in Nova afterwards, and not in the export's folder.
    assert.ok(!JSON.stringify(c.reset.preview()).includes(e.recovery_key));
    const everything = files(out).map((f) => readFileSync(join(out, f)).toString('latin1')).join('\n');
    assert.ok(!everything.includes(e.recovery_key) && !everything.includes(e.recovery_key.replaceAll('-', '')), 'the key isn’t written next to the export');
    assert.ok(!everything.includes(SECRET), 'no saved secret, in any form that reads');

    // The plain memory files, from the memory export.
    const json = JSON.parse(readFileSync(join(e.folder, 'memory.json'), 'utf8'));
    assert.deepEqual(json.records.map((r: { content: string }) => r.content), [MEMORY]);
    assert.match(readFileSync(join(e.folder, 'memory.md'), 'utf8'), /Prefers tea in the afternoon\./);

    // It opens with the recovery key alone, on any machine.
    const opened = join(w.dir, 'opened');
    assert.throws(() => openEncrypted(e.file, '00000000-00000000-00000000-00000000-00000000-00000000-00000000-00000000', join(w.dir, 'wrong')), /doesn’t open/);
    const m = openEncrypted(e.file, e.recovery_key, opened);
    const inside = files(join(opened, 'files'));
    assert.ok(!inside.some((f) => f.startsWith('vault') || f.startsWith('mesh')), `no vault and no identity: ${inside}`);
    assert.ok(m.excluded.some((x) => /saved passwords and keys/.test(x)), 'the manifest says what was left out');
    const db = new DatabaseSync(join(opened, 'nova.db'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT content FROM memory').get() as { content: string }).content, MEMORY);
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally {
      db.close();
    }

    // A factory reset never touches the export's folder.
    const before = hashes(out);
    await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
    await c.close();
    closed = true;
    const n = open(w.home);
    try {
      assert.deepEqual(hashes(out), before);
      assert.equal(n.reset.report()?.left.export, e.folder, 'the report says where the export is');
    } finally {
      await n.close();
    }
  } finally {
    if (!closed) await c.close();
  }
});
