// Checkpoints (M7 amendment §1): restore points of the whole home, kept on this machine. Taken by
// name (tier 1) and by Nova before a database upgrade; listed with sizes; the newest 10 automatic
// ones kept by sequence and named ones until deleted (tier 2); a full disk refused in plain words;
// every forget carried into them; never in a nightly backup or the standby's journal. Restoring
// is in checkpoints-restore.test.ts. Neutral placeholders only; throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupFiles, createCore, loadMigrations, takeCheckpoint, listCheckpoints, KEEP_AUTO } from '../../src/core/index.ts';
import { Db } from '../../src/core/db.ts';
import { journalPath } from '../../src/core/mesh/sync.ts';
import { enroll, hub } from './mesh-support.ts';
import { open, world } from './resilience-support.ts';

const SECRET = 'The spare key is under the blue flowerpot';
const has = (path: string, text: string) => readFileSync(path).includes(Buffer.from(text));
const mode = (p: string) => statSync(p).mode & 0o777;

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...walk(dir, r));
  }
  return out;
}

test('a named checkpoint holds the whole home, identity and vault key included, and nothing that isn’t the home’s; folders 0700, files 0600, a sealed manifest', async () => {
  const h = await hub();
  try {
    h.core.memory.remember({ kind: 'fact', content: 'Bins go out on the first weekday.', recorded_by: 'person' });
    h.core.vault.put('provider/EXAMPLE_KEY', 'placeholder-value');
    mkdirSync(join(h.home, 'memory'), { recursive: true });
    writeFileSync(join(h.home, 'memory', '2026-10-29.md'), '- Bins go out on the first weekday.\n');
    mkdirSync(join(h.home, 'workspace'), { recursive: true });
    writeFileSync(join(h.home, 'workspace', 'notes.md'), 'A note in Nova’s workspace.\n');
    writeFileSync(join(h.home, 'proxy.js'), '// the person’s own, not Nova’s\n');
    for (const d of ['logs', 'kept', 'workers/changes', 'exports', 'backups', '.git']) mkdirSync(join(h.home, d), { recursive: true });
    for (const f of ['logs/extra.log', 'kept/x', 'workers/changes/x', 'exports/e.json', 'backups/nova-old.db', '.git/HEAD', 'nova.pid']) writeFileSync(join(h.home, f), 'x');

    const r = await h.c('POST', '/resilience/checkpoints', { name: 'Before the garden plan' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'named');
    assert.equal(r.body.name, 'Before the garden plan');
    const dir = join(h.home, 'checkpoints', r.body.id);
    assert.ok(existsSync(dir), r.body.id);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const k of ['id', 'seq', 'name', 'kind', 'reason', 'at', 'nova_version', 'schema_version', 'files', 'total_bytes', 'seal']) assert.ok(k in manifest, `manifest has ${k}`);
    assert.match(manifest.seal, /^[0-9a-f]{64}$/);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    for (const p of ['vault/key', 'vault/secrets.json', 'mesh/identity.json', 'memory/2026-10-29.md', 'workspace/notes.md']) assert.ok(paths.includes(p), `${p} is in it: ${paths.join(', ')}`);
    for (const p of paths) assert.ok(!/^(logs|kept|workers|exports|backups|checkpoints|\.git)\/|^nova\.pid$|^nova\.db|^proxy\.js$/.test(p), `${p} is not`);
    assert.ok(has(join(dir, 'nova.db'), 'Bins go out on the first weekday.'), 'the database snapshot');
    // The person's alone, whatever the umask.
    assert.equal(mode(join(h.home, 'checkpoints')), 0o700);
    for (const p of walk(dir)) assert.equal(mode(join(dir, p)), statSync(join(dir, p)).isDirectory() ? 0o700 : 0o600, p);
    assert.equal(mode(dir), 0o700);
  } finally {
    await h.stop();
  }
});

test('listed newest first with name or reason, kind, date, size in human units and the Nova version; the retention rule is stated', async () => {
  const h = await hub();
  try {
    await h.c('POST', '/resilience/checkpoints', { name: 'First' });
    h.tick(60_000);
    h.core.checkpoints.auto('Before shipping “Example” v1.0.0');
    h.tick(60_000);
    await h.c('POST', '/resilience/checkpoints', { name: 'Third' });
    const r = await h.c('GET', '/resilience/checkpoints');
    assert.equal(r.status, 200);
    const list = r.body.checkpoints;
    assert.deepEqual(list.map((c: { label: string }) => c.label), ['Third', 'Before shipping “Example” v1.0.0', 'First']);
    assert.deepEqual(list.map((c: { kind: string }) => c.kind), ['named', 'auto', 'named']);
    for (const c of list) {
      assert.match(c.size, /^\d+(\.\d)? (bytes|KB|MB|GB)$/);
      assert.ok(c.bytes > 0);
      assert.equal(c.nova_version, '0.1.0');
      assert.ok(!Number.isNaN(Date.parse(c.at)));
    }
    assert.equal(r.body.retention.keep_auto, 10);
    assert.match(r.body.retention.rule, /newest 10 automatic/);
    assert.match(r.body.retention.rule, /never by date/);
    assert.match(r.body.retention.rule, /until you delete/);
    // A name is up to 80 characters, and there must be one.
    assert.equal((await h.c('POST', '/resilience/checkpoints', { name: 'x'.repeat(81) })).status, 400);
    assert.equal((await h.c('POST', '/resilience/checkpoints', { name: '  ' })).status, 400);
  } finally {
    await h.stop();
  }
});

test('retention: the newest 10 automatic checkpoints by sequence, never by date; named ones stay; the new one is complete first', async () => {
  const w = world('nova-cp-keep-');
  const c = open(w.home);
  try {
    // A clock that runs backwards: the dates say the newest is the oldest.
    let t = Date.parse('2030-06-01T00:00:00Z');
    const now = () => new Date((t -= 60_000));
    const named = takeCheckpoint({ home: w.home, db: c.db, kind: 'named', name: 'Mine', version: '0.1.0', now });
    const autos = [];
    for (let i = 0; i < KEEP_AUTO + 3; i++) autos.push(takeCheckpoint({ home: w.home, db: c.db, kind: 'auto', reason: `Automatic ${i}`, version: '0.1.0', now }).id);
    const left = listCheckpoints(w.home);
    assert.equal(left.filter((x) => x.kind === 'auto').length, KEEP_AUTO);
    assert.deepEqual(left.filter((x) => x.kind === 'auto').map((x) => x.id), autos.slice(3).reverse(), 'the newest by sequence, whatever their dates say');
    assert.ok(left.some((x) => x.id === named.id), 'the named one stays');
    // Nothing half-made is left behind.
    assert.deepEqual(readdirSync(join(w.home, 'checkpoints')).filter((n) => n.startsWith('.partial')), []);
  } finally {
    await c.close();
  }
});

test('a disk too full refuses in plain words, keeps nothing half-made, and never deletes a named checkpoint to make room', async () => {
  const w = world('nova-cp-full-');
  let free: number | null = null;
  const c = open(w.home, { checkpoints: { free: () => free } });
  try {
    const mine = c.checkpoints.take({ kind: 'named', name: 'Keep me' });
    free = 10;
    assert.throws(() => c.checkpoints.take({ kind: 'named', name: 'No room' }), (e: Error) => /isn’t enough free space/.test(e.message) && /took none/.test(e.message));
    assert.throws(() => c.checkpoints.auto('Before something'), /isn’t enough free space/);
    assert.deepEqual(c.checkpoints.list().map((x) => x.id), [mine.id], 'the named one is still there; nothing new, nothing half-made');
    assert.deepEqual(readdirSync(join(w.home, 'checkpoints')).filter((n) => !n.startsWith('.') && n !== mine.id && n !== 'restores'), []);
  } finally {
    await c.close();
  }
});

test('deleting a named checkpoint is tier 2: confirmed, an approver only; automatic ones are kept by the rule', async () => {
  const h = await hub();
  try {
    const mine = (await h.c('POST', '/resilience/checkpoints', { name: 'Mine' })).body;
    const auto = h.core.checkpoints.auto('Before upgrading');
    const { token } = await enroll(h);
    const phone = await fetch(`${h.mesh}/api/v1/resilience/checkpoints/${mine.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1', authorization: `Bearer ${token}` }, body: JSON.stringify({ confirm: true }) });
    assert.equal(phone.status, 403, 'a paired phone that may not approve can’t delete one');
    assert.equal((await h.c('POST', `/resilience/checkpoints/${mine.id}/delete`, {})).status, 400, 'not without the OK');
    assert.equal((await h.c('POST', `/resilience/checkpoints/${auto.id}/delete`, { confirm: true })).status, 409);
    assert.equal((await h.c('POST', `/resilience/checkpoints/${mine.id}/delete`, { confirm: true })).status, 200);
    assert.deepEqual(h.core.checkpoints.list().map((x) => x.id), [auto.id]);
  } finally {
    await h.stop();
  }
});

test('forgetting reaches every checkpoint: its database and its memory files, hashes rewritten and sealed; one that can’t be cleaned is destroyed and reported', async () => {
  const w = world('nova-cp-forget-');
  const c = open(w.home);
  try {
    const m = c.memory.remember({ kind: 'fact', content: SECRET, recorded_by: 'person' });
    mkdirSync(join(w.home, 'memory'), { recursive: true });
    writeFileSync(join(w.home, 'memory', 'today.md'), `- ${SECRET}\n- Water the ferns.\n`);
    const a = c.checkpoints.take({ kind: 'named', name: 'Clean me' });
    const b = c.checkpoints.auto('Before breaking');
    const dirA = join(w.home, 'checkpoints', a.id);
    const dirB = join(w.home, 'checkpoints', b.id);
    assert.ok(has(join(dirA, 'nova.db'), SECRET) && has(join(dirA, 'files', 'memory', 'today.md'), SECRET));
    // One can't be cleaned: its database isn't a database any more.
    writeFileSync(join(dirB, 'nova.db'), 'not a database');

    c.memory.forget(m.id);

    assert.equal(has(join(dirA, 'nova.db'), SECRET), false, 'gone from the checkpoint’s database');
    assert.equal(has(join(dirA, 'files', 'memory', 'today.md'), SECRET), false, 'gone from its memory files');
    assert.ok(has(join(dirA, 'files', 'memory', 'today.md'), 'Water the ferns.'), 'the rest stays');
    const listed = c.checkpoints.list();
    assert.ok(listed.some((x) => x.id === a.id), 'still Nova’s: the manifest is sealed again with the new hashes');
    assert.equal(existsSync(dirB), false, 'the one that couldn’t be cleaned is gone');
    assert.ok(c.log.problems({ open: true }).some((p) => /checkpoint couldn’t be cleaned/.test(p.message)), 'and that is said');
  } finally {
    await c.close();
  }
});

test('nightly backups and the standby’s journal leave checkpoints out', async () => {
  const w = world('nova-cp-out-');
  const c = open(w.home);
  try {
    c.checkpoints.take({ kind: 'named', name: 'Here' });
    assert.ok(readdirSync(join(w.home, 'checkpoints')).length);
    assert.deepEqual(backupFiles(w.home).filter((p) => p.startsWith('checkpoints/')), []);
    c.resilience.setSettings({ target: w.target });
    const r = c.resilience.nightly.run();
    assert.ok(r.manifest.excluded.some((e) => e.startsWith('checkpoints: ')), r.manifest.excluded.join('\n'));
    assert.equal(journalPath('checkpoints/000001-here/manifest.json'), null);
  } finally {
    await c.close();
  }
});

test('Nova takes an automatic checkpoint before a database upgrade, beside the pre-upgrade copy', async () => {
  const w = world('nova-cp-upgrade-');
  mkdirSync(w.home, { recursive: true });
  const all = loadMigrations();
  const older = new Db(join(w.home, 'nova.db'));
  older.migrate({ migrations: all.slice(0, -1), backupDir: join(w.home, 'backups') });
  older.close();
  const c = open(w.home);
  try {
    const list = c.checkpoints.list();
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.equal(list[0]!.kind, 'auto');
    assert.match(list[0]!.reason!, /^Before upgrading the database from version \d+/);
    assert.equal(list[0]!.schema_version, all.length - 1, 'it holds the database as it was before');
    assert.ok(readdirSync(join(w.home, 'backups')).some((f) => f.endsWith('.db')), 'the pre-upgrade copy is still made');
    const d = new DatabaseSync(join(w.home, 'checkpoints', list[0]!.id, 'nova.db'), { readOnly: true });
    try { assert.equal((d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v, all.length - 1); } finally { d.close(); }
  } finally {
    await c.close();
  }
});

test('a fresh home and a sandbox copy take no checkpoint at start', async () => {
  const w = world('nova-cp-fresh-');
  const c = createCore({ home: w.home, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file', keychain: null } });
  try {
    assert.deepEqual(c.checkpoints.list(), []);
  } finally {
    await c.close();
  }
});
