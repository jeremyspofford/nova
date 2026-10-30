// Factory reset (M7 amendment §2): the wipe takes only Nova's own entries in the home, by name,
// and lists what it leaves; Nova's sealed backups go from every folder it ever backed up to, strays
// never; a folder that isn't there is said beforehand and afterwards; the vault's key goes from the
// keychain through the vault's own key abstraction; a reset stopped half way finishes at the next
// start, and a half-reset Nova never runs; only the hub's own screen may ask, confirmed every
// time; afterwards Nova is in first-run state with a new identity and an empty roster.
// Throwaway homes only: every home here is a fresh temp folder passed explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HOME_MARK, RESET_MARKER, RESET_REPORT, ensureMark, finishReset, stagedPending, type KeyStore } from '../../src/core/index.ts';
import { open, world } from './resilience-support.ts';
import { seedHome } from '../../src/home.js';
import { call, enroll, hub } from './mesh-support.ts';

const CONSOLE = { principal: { kind: 'console' as const }, listener: 'console' as const, address: '127.0.0.1' };
const WORDS = 'The spare key is under the blue flowerpot';

// A keychain in memory: the vault's own KeyStore shape, so the real one is never touched.
function standInKeychain() {
  const items = new Map<string, Buffer>();
  const make = (account: string): KeyStore => ({
    kind: 'keychain', name: 'the test keychain',
    available: () => ({ ok: true, detail: 'test' }),
    read: () => items.get(account) ?? null,
    write: (key) => { items.set(account, Buffer.from(key)); },
    remove: () => { items.delete(account); },
  });
  return { items, make };
}

// Everything a lived-in home has, Era 2's files and Nova's state, plus two files that aren't Nova's.
function liveIn(home: string) {
  for (const d of ['checkpoints/000001-before', 'backups', 'logs', 'workers/scratch', 'kept/x', 'connectors/gmail', 'sessions', 'skills/a', 'schedules', 'exports/memory-1', 'extensions/x', '.git/objects', 'memory', 'workspace']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, 'checkpoints/000001-before/manifest.json'), '{}');
  writeFileSync(join(home, 'backups/nova-2026-10-29.db'), 'old');
  writeFileSync(join(home, 'connectors/gmail/token.json'), '{"token":"placeholder"}');
  writeFileSync(join(home, 'sessions/s1.jsonl'), `{"text":"${WORDS}"}\n`);
  for (const f of ['MEMORY.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'permissions.md', '.gitignore', 'nova.pid']) writeFileSync(join(home, f), `${f}\n`);
  writeFileSync(join(home, 'MEMORY.md'), `- ${WORDS}\n`);
  writeFileSync(join(home, 'my-proxy.js'), '// a file of the person’s own\n');
  writeFileSync(join(home, 'notes-of-mine.txt'), 'not Nova’s\n');
}

test('the wipe takes every Nova entry by name, keeps the person’s own files and lists them; afterwards it is first run, new identity, empty roster', async () => {
  const w = world('nova-reset-');
  const c = open(w.home);
  liveIn(w.home);
  const before = { id: c.mesh.identity.id, fp: c.mesh.identity.fingerprint };
  c.memory.remember({ kind: 'fact', content: WORDS, recorded_by: 'person' });
  c.vault.put('provider/API_KEY', 'sk-placeholder-0123456789');
  c.setup.answer('Sam');
  // What the confirmation lists, before anything happens.
  const p = c.reset.preview();
  for (const n of ['nova.db', 'mesh', 'vault', 'checkpoints', 'backups', 'logs', 'workers', 'kept', 'connectors', '.git', 'nova.pid', 'MEMORY.md', 'memory', 'sessions']) assert.ok(p.wipes.home.includes(n), `${n} is listed to be wiped: ${p.wipes.home}`);
  assert.deepEqual(p.keeps.foreign.sort(), ['my-proxy.js', 'notes-of-mine.txt']);
  assert.match(p.keeps.releases, /code releases stay/);
  const s = await c.reset.stage({ confirm: true, who: CONSOLE });
  assert.equal(s.staged, true);
  await s.done;
  assert.ok(existsSync(join(w.home, RESET_MARKER)), 'staged as a marker first');
  await c.close();

  // The next start finishes it, before anything opens the database.
  const n = open(w.home);
  try {
    assert.ok(!existsSync(join(w.home, RESET_MARKER)), 'the marker is gone once it is done');
    const left = readdirSync(w.home);
    for (const gone of ['checkpoints', 'backups', 'workers', 'kept', 'connectors', 'sessions', 'skills', 'schedules', 'exports', '.git', 'memory', 'MEMORY.md', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'permissions.md', '.gitignore', 'nova.pid']) assert.ok(!left.includes(gone), `${gone} is gone: ${left}`);
    // A new Nova makes its own fresh folders again; nothing of the old ones is in them.
    assert.ok(!existsSync(join(w.home, 'extensions', 'x')));
    assert.equal(readFileSync(join(w.home, 'my-proxy.js'), 'utf8'), '// a file of the person’s own\n', 'foreign files stay as they were');
    assert.ok(existsSync(join(w.home, 'notes-of-mine.txt')));
    const report = JSON.parse(readFileSync(join(w.home, RESET_REPORT), 'utf8'));
    assert.deepEqual(report.left.foreign.sort(), ['my-proxy.js', 'notes-of-mine.txt'], 'and are listed afterwards');
    assert.ok(report.wiped.home.includes('nova.db') && report.wiped.home.includes('mesh'));
    assert.match(report.left.releases, /code releases stay/);
    // First run: a new identity, only the hub in the roster, setup not done, nothing remembered.
    assert.notEqual(n.mesh.identity.id, before.id);
    assert.notEqual(n.mesh.identity.fingerprint, before.fp);
    assert.deepEqual(n.mesh.devices.list().map((d) => d.role), ['hub']);
    assert.equal(n.mesh.devices.roster().roster.standby, undefined);
    assert.equal(n.setup.view().done, false);
    assert.equal(n.setup.view().transcript.filter((t) => t.from === 'person').length, 0);
    assert.equal(n.memory.list().length, 0);
    assert.equal(n.vault.status().secrets, 0);
    assert.deepEqual(n.reset.report()?.id, report.id, 'the first-run screen gets the report');
  } finally {
    await n.close();
  }
});

test('backups go from every folder Nova ever backed up to, its own sealed ones only; strays stay; an unreachable folder is said before and after', async () => {
  const w = world('nova-reset-bk-');
  const third = join(w.dir, 'drive');
  mkdirSync(third);
  const c = open(w.home);
  c.memory.remember({ kind: 'fact', content: WORDS, recorded_by: 'person' });
  c.resilience.setSettings({ target: third });
  c.resilience.nightly.run();
  c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
  c.resilience.nightly.run();
  c.resilience.nightly.run();
  // Not Nova's: a stray named like a backup, and the person's own file in the same folder.
  mkdirSync(join(w.target, 'nova-backup-000099'));
  writeFileSync(join(w.target, 'nova-backup-000099', 'manifest.json'), '{"id":"nova-backup-000099"}');
  writeFileSync(join(w.target, 'holiday.jpg'), 'pixels');
  writeFileSync(join(w.second, 'nova-backup-000050.nbk'), 'not one of Nova’s');
  // The drive is unplugged: its folder isn't there.
  renameSync(third, `${third}-away`);
  const p = c.reset.preview();
  assert.deepEqual(p.keeps.unreachable.map((u) => u.folder), [third], 'the unreachable folder is named beforehand');
  assert.match(p.keeps.unreachable[0]!.said, /isn’t there/);
  assert.deepEqual(p.wipes.backups.map((b) => [b.folder, b.count]).sort(), [[w.target, 2], [w.second, 2]]);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  const n = open(w.home);
  try {
    assert.deepEqual(readdirSync(w.target).sort(), ['holiday.jpg', 'nova-backup-000099'], 'only Nova’s own backups went');
    assert.deepEqual(readdirSync(w.second), ['nova-backup-000050.nbk'], 'the encrypted copies went; the stray stayed');
    assert.deepEqual(readdirSync(`${third}-away`), ['nova-backup-000001'], 'a folder that wasn’t there is untouched');
    const r = n.reset.report()!;
    assert.deepEqual(r.wiped.folders.sort(), [w.second, w.target].sort());
    assert.deepEqual(r.left.unreachable.map((u) => u.folder), [third], 'and named afterwards: it still holds backups');
    assert.ok(r.left.strays.includes(join(w.target, 'nova-backup-000099')));
  } finally {
    await n.close();
  }
});

test('the vault’s key leaves the keychain, through the vault’s own key abstraction', async () => {
  const w = world('nova-reset-kc-');
  const kc = standInKeychain();
  const vault = { mode: 'auto' as const, keychain: kc.make };
  const c = open(w.home, { vault });
  c.vault.put('provider/API_KEY', 'sk-placeholder-0123456789');
  assert.equal(kc.items.size, 1, 'the key is in the keychain');
  assert.ok(!existsSync(join(w.home, 'vault', 'key')));
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  const n = open(w.home, { vault });
  try {
    assert.equal(kc.items.size, 0, 'removed from the keychain');
    assert.match(n.reset.report()!.wiped.keychain ?? '', /test keychain/);
  } finally {
    await n.close();
  }
});

test('a reset stopped half way finishes at the next start; a half-reset Nova never runs', async () => {
  const w = world('nova-reset-crash-');
  const c = open(w.home);
  liveIn(w.home);
  c.resilience.setSettings({ target: w.target });
  c.resilience.nightly.run();
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  // The power goes out after the backups and two of the home's entries went.
  let n = 0;
  assert.throws(() => finishReset(w.home, { vault: { mode: 'file', keychain: null }, step: (what) => { if (what.startsWith('home:') && ++n > 2) throw new Error('power cut'); } }), /power cut/);
  assert.ok(existsSync(join(w.home, RESET_MARKER)), 'the marker stays until it is all done');
  assert.ok(existsSync(join(w.home, 'nova.db')) || existsSync(join(w.home, 'mesh')), 'some of Nova is still there');
  // A start that can't finish it doesn't run on what is left.
  assert.throws(() => open(w.home, { reset: { step: () => { throw new Error('still no power'); } } }), /still no power/);
  // The next start that can, does: the rest goes, and the report is written.
  const again = open(w.home);
  try {
    assert.ok(!existsSync(join(w.home, RESET_MARKER)));
    assert.deepEqual(readdirSync(w.target), [], 'the backups are gone');
    for (const gone of ['checkpoints', 'sessions', 'MEMORY.md', 'connectors']) assert.ok(!existsSync(join(w.home, gone)), gone);
    assert.equal(again.setup.view().done, false);
    assert.ok(again.reset.report());
  } finally {
    await again.close();
  }
});

test('only the hub’s own screen may reset or export, and a reset is confirmed every time', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h);
    const asPhone = (method: string, path: string, body?: unknown) => call(h.mesh, method, `/api/v1${path}`, body, { authorization: `Bearer ${token}` });
    for (const [m, path, body] of [['GET', '/reset'], ['POST', '/reset', { confirm: true }], ['POST', '/reset/export', { folder: h.home }], ['GET', '/reset/report']] as const) {
      const r = await asPhone(m, path, body);
      assert.equal(r.status, 403, `${m} ${path} from a phone: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /hub’s own screen/);
    }
    const no = await h.c('POST', '/reset', {});
    assert.equal(no.status, 400);
    assert.match(no.body.error, /confirm/);
    assert.ok(!existsSync(join(h.home, RESET_MARKER)), 'nothing was staged');
    const view = await h.c('GET', '/reset');
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.devices.cant_tell.map((d: { name: string }) => d.name), ['Test phone'], 'a phone with nothing open can’t be told, and is named');
  } finally {
    await h.stop();
  }
});

// A supervisor link that records what it was asked, and whether work had stopped by then.
function standInSupervisor(home: string, ok: boolean, halted: () => boolean) {
  const asked: { type: string; staged?: boolean; pending: boolean; halted: boolean }[] = [];
  const link = {
    state: () => null,
    onProblem: () => {},
    request: async (type: 'deploy' | 'rollback' | 'restart', o: { staged?: boolean } = {}) => {
      asked.push({ type, ...(o.staged ? { staged: true } : {}), pending: stagedPending(home), halted: halted() });
      return ok ? { ok: true, said: 'Restarting.' } : { ok: false, said: 'The supervisor is busy.' };
    },
  };
  return { asked, link };
}

test('once devices are told, work stops and Nova restarts in place to finish: under the supervisor, a staged restart', async () => {
  const w = world('nova-reset-restart-');
  let halted = false;
  const sup = standInSupervisor(w.home, true, () => halted);
  const c = open(w.home, { supervisor: sup.link });
  const halt = c.ledger.halt.bind(c.ledger);
  c.ledger.halt = (why?: string) => { halted = true; return halt(why); };
  try {
    const s = c.reset.stage({ confirm: true, who: CONSOLE });
    assert.equal(s.restart, 'in-place', 'no manual restart');
    assert.equal(stagedPending(w.home), true, 'the supervisor sees it staged');
    await s.done;
    assert.deepEqual(sup.asked, [{ type: 'restart', staged: true, pending: true, halted: true }], 'work stopped before the restart');
  } finally {
    await c.close();
  }
});

test('a restart that fails: the reset finishes when Nova starts next, said plainly, and nothing new is taken until then', async () => {
  const w = world('nova-reset-norestart-');
  const sup = standInSupervisor(w.home, false, () => false);
  const c = open(w.home, { supervisor: sup.link });
  try {
    await c.reset.stage({ confirm: true, who: CONSOLE }).done;
    const p = c.reset.preview();
    assert.equal(p.staged, true);
    assert.match(p.staged_said ?? '', /couldn’t restart itself/);
    assert.match(p.staged_said ?? '', /finishes erasing itself when Nova starts next/);
    assert.ok(c.log.problems({ open: true }).some((x) => /finishes erasing itself when Nova starts next/.test(x.message)));
    assert.match(c.reset.blocks('POST', '/api/v1/memory') ?? '', /erasing itself/, 'still refused until then');
  } finally {
    await c.close();
  }
  const n = open(w.home);
  try {
    assert.equal(n.setup.view().done, false, 'and it did, at the next start');
    assert.ok(n.reset.report());
  } finally {
    await n.close();
  }
});

// A marker Nova didn't write is never acted on (review finding 1): Nova starts as it was, says so,
// and keeps the file aside. Forged (its plain sha256 recomputed, as anyone could), changed, or junk.
const problemsOf = (c: ReturnType<typeof open>) => c.log.problems({ open: true }).map((p) => p.message);
const asideIn = (home: string) => readdirSync(home).filter((n) => n.startsWith(`${RESET_MARKER}.set-aside-`));

test('a forged reset marker (one Nova didn’t seal) erases nothing: Nova starts as it was, says so, and keeps it aside', async () => {
  const w = world('nova-reset-forged-');
  const c = open(w.home);
  c.memory.remember({ kind: 'fact', content: WORDS, recorded_by: 'person' });
  liveIn(w.home);
  const id = c.mesh.identity.id;
  await c.close();
  // What a file write into the home could make: every field right, and a plain sha256 over them.
  const forged: Record<string, unknown> = { v: 1, id: '00000000-0000-4000-8000-000000000000', kind: 'hub', home: w.home, staged_at: '2026-10-30T00:00:00.000Z', version: '0.1.0', vault_ids: [], own: [], backups: [], strays: [], unreachable: [], devices: null, export: null };
  forged.sum = createHash('sha256').update(JSON.stringify(forged)).digest('hex');
  writeFileSync(join(w.home, RESET_MARKER), JSON.stringify(forged));
  const n = open(w.home);
  try {
    assert.equal(n.mesh.identity.id, id, 'the same Nova, nothing erased');
    assert.equal(n.memory.list()[0]?.content, WORDS);
    assert.ok(existsSync(join(w.home, 'sessions', 's1.jsonl')));
    assert.ok(!existsSync(join(w.home, RESET_MARKER)));
    assert.equal(asideIn(w.home).length, 1, 'kept aside for the person to see');
    assert.ok(problemsOf(n).some((m) => /found a note asking to erase it that Nova didn’t write/.test(m)), problemsOf(n).join(' | '));
  } finally {
    await n.close();
  }
});

test('a marker changed since it was staged, or junk, is never acted on either: a normal start, said, kept aside', async () => {
  const w = world('nova-reset-tamper-');
  const c = open(w.home);
  c.memory.remember({ kind: 'fact', content: WORDS, recorded_by: 'person' });
  await c.reset.stage({ confirm: true, who: CONSOLE }).done;
  await c.close();
  const file = join(w.home, RESET_MARKER);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.backups.push({ path: join(w.dir, 'elsewhere'), folder: w.dir, kind: 'folder', check: null });
  writeFileSync(file, JSON.stringify(m));
  let n = open(w.home);
  try {
    assert.equal(n.memory.list()[0]?.content, WORDS, 'nothing was erased');
    assert.ok(problemsOf(n).some((x) => /didn’t write/.test(x)));
  } finally {
    await n.close();
  }
  writeFileSync(file, 'not json at all');
  n = open(w.home);
  try {
    assert.equal(n.memory.list()[0]?.content, WORDS);
    assert.equal(asideIn(w.home).length, 2);
  } finally {
    await n.close();
  }
});

// Only a folder that is Nova's alone is ever erased (review finding 2).
test('a reset is refused for a home that is your own home folder (or contains it), and for a folder without Nova’s mark', async () => {
  const w = world('nova-reset-unsafe-');
  const fakeUser = join(w.dir, 'person');
  mkdirSync(fakeUser);
  const saved = process.env.HOME;
  process.env.HOME = fakeUser;
  try {
    for (const home of [fakeUser, w.dir]) {
      const c = open(home);
      try {
        assert.ok(!existsSync(join(home, HOME_MARK)), 'Nova never marks such a folder as its own');
        assert.throws(() => c.reset.stage({ confirm: true, who: CONSOLE }), /your own home folder/);
        assert.ok(!existsSync(join(home, RESET_MARKER)));
      } finally {
        await c.close();
      }
    }
  } finally {
    process.env.HOME = saved;
  }
  const c = open(w.home);
  try {
    assert.ok(existsSync(join(w.home, HOME_MARK)), 'a home Nova set up carries its mark');
    rmSync(join(w.home, HOME_MARK));
    assert.throws(() => c.reset.stage({ confirm: true, who: CONSOLE }), /doesn’t carry Nova’s mark/);
  } finally {
    await c.close();
  }
});

test('an existing home from before the mark gets it at its next start; one holding another database doesn’t', async () => {
  const w = world('nova-reset-mark-');
  await open(w.home).close();
  rmSync(join(w.home, HOME_MARK));
  await open(w.home).close();
  const mark = JSON.parse(readFileSync(join(w.home, HOME_MARK), 'utf8'));
  assert.match(mark.id, /^[0-9a-f-]{36}$/);
  assert.equal(statSync(join(w.home, HOME_MARK)).mode & 0o777, 0o600);
  const other = join(w.dir, 'other');
  mkdirSync(other);
  const db = new DatabaseSync(join(other, 'nova.db'));
  db.exec('CREATE TABLE notes (x TEXT)');
  db.close();
  assert.equal(ensureMark(other), null);
  assert.ok(!existsSync(join(other, HOME_MARK)));
});

// Backups made after the reset was staged are found and erased too, and half-written ones (the
// database in the clear) go (review finding 4).
test('a backup that finishes after staging, and a half-written one, are erased too', async () => {
  const w = world('nova-reset-late-');
  const c = open(w.home);
  c.resilience.setSettings({ target: w.target });
  c.resilience.nightly.run();
  mkdirSync(join(w.target, '.nova-backup-000009.partial'));
  writeFileSync(join(w.target, '.nova-backup-000009.partial', 'nova.db'), WORDS);
  const s = c.reset.stage({ confirm: true, who: CONSOLE });
  // It was already running when the reset was staged, and finishes now.
  const late = c.resilience.nightly.run();
  await s.done;
  const m = JSON.parse(readFileSync(join(w.home, RESET_MARKER), 'utf8'));
  assert.ok(m.backups.some((b: { path: string }) => b.path === late.path), 'listed again once work had stopped');
  await c.close();
  const n = open(w.home);
  try {
    assert.deepEqual(readdirSync(w.target), [], 'all of them, the half-written one too');
    assert.ok(n.reset.report()!.wiped.backups.includes(late.path!));
  } finally {
    await n.close();
  }
});

// An encrypted copy is erased only if it opens under the backup key (review finding 7).
test('a file named like an encrypted copy that doesn’t open under the backup key is never erased', async () => {
  const w = world('nova-reset-nbk-');
  const c = open(w.home);
  c.resilience.setSettings({ target: w.target, encrypted_target: w.second });
  c.resilience.nightly.run();
  const copy = join(w.second, readdirSync(w.second)[0]!);
  // Its header (unsigned), followed by something else.
  const real = readFileSync(copy);
  const headLen = 12 + real.readUInt32BE(8);
  writeFileSync(copy, Buffer.concat([real.subarray(0, headLen), Buffer.alloc(4096, 7)]));
  const p = c.reset.preview();
  assert.deepEqual(p.wipes.backups.filter((b) => b.kind === 'encrypted'), []);
  assert.ok(p.keeps.strays.includes(copy));
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  await open(w.home).close();
  assert.ok(existsSync(copy), 'left as it is');
});

// Re-review finding 1, final form: Nova adopts a folder that already holds things only if none of
// them has the name of one of Nova's own entries; otherwise its data would end up inside the
// person's folders, out of a reset's reach. Other things already there are left alone through a
// reset, and said.
test('a folder already holding workspace/ and .git/ that aren’t Nova’s is refused at start, in plain words', () => {
  const w = world('nova-reset-clash-');
  mkdirSync(join(w.home, 'workspace', 'my-project'), { recursive: true });
  mkdirSync(join(w.home, '.git'));
  writeFileSync(join(w.home, 'notes.txt'), 'mine\n');
  assert.throws(() => open(w.home), (e: Error) => e.message === 'This folder already has .git/ and workspace/ that aren’t Nova’s. Choose an empty folder for Nova’s home, or move them.');
  assert.ok(!existsSync(join(w.home, HOME_MARK)) && !existsSync(join(w.home, 'nova.db')), 'nothing written');
});

test('an Era 2 home (its standing files, memory and workspace, no nova.db yet) is Nova’s own: adopted whole', async () => {
  const w = world('nova-reset-era2-');
  seedHome(w.home, join(import.meta.dirname, '../../templates/home'));
  writeFileSync(join(w.home, 'memory', '2026-10-29.md'), '- a day note\n');
  writeFileSync(join(w.home, 'workspace', 'plan.md'), '- a plan\n');
  const c = open(w.home);
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(w.home, HOME_MARK), 'utf8')).before, []);
    assert.ok(c.reset.preview().wipes.home.includes('workspace'));
  } finally {
    await c.close();
  }
  // One entry of Nova’s name, said in the singular.
  const one = world('nova-reset-one-');
  mkdirSync(join(one.home, 'workspace'), { recursive: true });
  assert.throws(() => open(one.home), (e: Error) => e.message === 'This folder already has workspace/ that isn’t Nova’s. Choose an empty folder for Nova’s home, or move it.');
});

test('things already there that aren’t named like Nova’s are adopted, left alone through a reset, and said', async () => {
  const w = world('nova-reset-before-');
  mkdirSync(join(w.home, 'photos'), { recursive: true });
  writeFileSync(join(w.home, 'photos', 'beach.jpg'), 'pixels');
  writeFileSync(join(w.home, 'notes.txt'), 'mine\n');
  const c = open(w.home);
  assert.deepEqual(JSON.parse(readFileSync(join(w.home, HOME_MARK), 'utf8')).before, ['notes.txt', 'photos']);
  assert.deepEqual(c.reset.preview().keeps.foreign, ['notes.txt', 'photos']);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  const n = open(w.home);
  try {
    assert.equal(readFileSync(join(w.home, 'photos', 'beach.jpg'), 'utf8'), 'pixels');
    assert.equal(readFileSync(join(w.home, 'notes.txt'), 'utf8'), 'mine\n');
    assert.deepEqual(n.reset.report()!.left.foreign, ['notes.txt', 'photos']);
  } finally {
    await n.close();
  }
});

// Final review item 3: work handed to Relay stays in Relay's own storage; said when Relay was on or used.
test('when Relay was on or used, the confirmation and the result say its work stays in Relay', async () => {
  const w = world('nova-reset-relay-');
  const c = open(w.home);
  assert.equal(c.reset.preview().keeps.relay, null, 'not said when Relay was never on or used');
  c.providers.enable('relay', { approved: true });
  const p = c.reset.preview();
  assert.match(p.keeps.relay ?? '', /Work handed to Relay stays in Relay’s own storage: erasing Nova doesn’t erase it\./);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  const n = open(w.home);
  try {
    assert.match(n.reset.report()!.said, /Work handed to Relay stays in Relay’s own storage/);
  } finally {
    await n.close();
  }
});

test('a home that was new and empty is erased whole; so is an existing Nova home', async () => {
  const fresh = world('nova-reset-fresh-');
  mkdirSync(fresh.home);
  const c = open(fresh.home);
  mkdirSync(join(fresh.home, '.git'));
  writeFileSync(join(fresh.home, 'workspace', 'later.md'), 'made with Nova\n');
  assert.deepEqual(c.reset.preview().keeps.before, []);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  await open(fresh.home).close();
  assert.ok(!existsSync(join(fresh.home, '.git')) && !existsSync(join(fresh.home, 'workspace', 'later.md')));
  // A home from before the mark: its nova.db is Nova's, so all of Nova's entries are.
  const old = world('nova-reset-oldhome-');
  await open(old.home).close();
  rmSync(join(old.home, HOME_MARK));
  mkdirSync(join(old.home, '.git'));
  const o = open(old.home);
  assert.deepEqual(o.reset.preview().keeps.before, []);
  await (await o.reset.stage({ confirm: true, who: CONSOLE })).done;
  await o.close();
  await open(old.home).close();
  assert.ok(!existsSync(join(old.home, '.git')));
});

// Re-review finding 5: stopped after the mark got its new key but before the marker went, the next
// start recognises a reset that is done and finishes quietly.
test('a finished reset whose marker was left behind is recognised and cleared quietly', async () => {
  const w = world('nova-reset-done-');
  const c = open(w.home);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  const marker = readFileSync(join(w.home, RESET_MARKER));
  await c.close();
  await open(w.home).close();
  writeFileSync(join(w.home, RESET_MARKER), marker);
  const n = open(w.home);
  try {
    assert.ok(!existsSync(join(w.home, RESET_MARKER)));
    assert.deepEqual(asideIn(w.home), [], 'nothing set aside');
    assert.ok(!problemsOf(n).some((m) => /didn’t write/.test(m)), problemsOf(n).join(' | '));
  } finally {
    await n.close();
  }
});

// Re-review finding 4: what the browser kept is cleared on the hub's own screen only, once per reset.
test('after a reset, the hub’s own screen is told once to clear what it kept; a paired device never', async () => {
  const w = world('nova-reset-csd-');
  const c = open(w.home);
  await (await c.reset.stage({ confirm: true, who: CONSOLE })).done;
  await c.close();
  const n = open(w.home);
  try {
    const id = n.reset.report()!.id;
    const first = n.reset.clearHeaders({ kind: 'console' }, undefined);
    assert.equal(first['clear-site-data'], '"cache", "storage"');
    assert.match(first['set-cookie'] ?? '', new RegExp(`nova-reset-cleared=${id}`));
    assert.deepEqual(n.reset.clearHeaders({ kind: 'console' }, `nova-reset-cleared=${id}`), {}, 'once per reset');
    assert.deepEqual(n.reset.clearHeaders({ kind: 'device' }, undefined), {}, 'never a paired device');
  } finally {
    await n.close();
  }
});
