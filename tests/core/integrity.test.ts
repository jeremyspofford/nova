// The integrity scrub and disk-health signals (Amendment 2026-10-31-B Part 6; plan
// docs/plans/integrity-scrub.md): damage is found, a full disk is found, the result is metadata
// only, the time bound holds, and nothing is written. Temp homes and neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCore, integrityRoutes, runScrub, takeCheckpoint } from '../../src/core/index.ts';
import { CoreError } from '../../src/core/errors.ts';

const CANARY = 'canary-integrity-5d1e8a7b3c09';
const GiB = 1024 ** 3;
const roomy = () => ({ bavail: 100 * GiB / 4096, bsize: 4096, blocks: 200 * GiB / 4096, files: 1_000_000, ffree: 900_000 });

// A stopped home: a database with rows of planted content, and a memory file named after the canary.
function home(prefix = 'nova-integrity-'): string {
  const h = mkdtempSync(join(tmpdir(), `${prefix}${CANARY}-`));
  const d = new DatabaseSync(join(h, 'nova.db'));
  d.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX note_body ON note(body);');
  const ins = d.prepare('INSERT INTO note (body) VALUES (?)');
  for (let i = 0; i < 4000; i++) ins.run(`${CANARY} row ${i} ${'x'.repeat(40)}`);
  d.close();
  mkdirSync(join(h, 'memory'));
  writeFileSync(join(h, 'memory', `${CANARY}.md`), `${CANARY} private words\n`);
  return h;
}

const overwrite = (file: string, at: number, bytes: number) => { const fd = openSync(file, 'r+'); try { writeSync(fd, Buffer.alloc(bytes, 0x41), 0, bytes, at); } finally { closeSync(fd); } };

// Every file under a folder, with its hash and modification time.
function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    const rel = p.slice(dir.length + 1);
    if (skip(rel)) continue;
    out[rel] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}@${statSync(p).mtimeMs}`;
  }
  return out;
}

// Every string anywhere in a value.
const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];

test('a healthy stopped home scrubs ok, with every check said', async () => {
  const h = home();
  const r = await runScrub({ home: h, statfs: roomy });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true, 'SMART and fs_errors that can’t run on this platform don’t make it incomplete');
  assert.equal(r.format_version, 2);
  assert.equal(r.stops, false);
  assert.equal(r.checks.database.state, 'ok');
  assert.equal(r.checks.checkpoint.state, 'none');
  assert.equal(r.checks.disk.state, 'ok');
  assert.equal(r.checks.smart.state, 'unavailable', 'SMART is never claimed healthy');
  assert.deepEqual(r.problems, []);
});

test('a corrupt database is detected, and one SQLite can’t open at all', async () => {
  const h = home();
  overwrite(join(h, 'nova.db'), 4096 * 2, 4096 * 3);
  const r = await runScrub({ home: h, statfs: roomy });
  assert.equal(r.checks.database.state, 'problem');
  assert.ok(r.checks.database.findings > 0);
  assert.equal(r.ok, false);
  assert.equal(r.stops, true, 'a damaged database stops Nova: red');
  assert.match(r.problems[0]!.message, /database is damaged/);
  assert.equal(r.problems[0]!.source, 'integrity');

  const full = await runScrub({ home: h, statfs: roomy, full: true });
  assert.equal(full.checks.database.mode, 'integrity_check');
  assert.equal(full.checks.database.state, 'problem');

  const g = home();
  overwrite(join(g, 'nova.db'), 0, 100);
  const header = await runScrub({ home: g, statfs: roomy });
  assert.equal(header.checks.database.state, 'problem');
  assert.match(header.problems[0]!.message, /can’t read it as a database/);
  assert.equal(header.problems[0]!.stops, 1);
});

test('a full disk is detected: red when a checkpoint wouldn’t fit, amber when it is getting full, and inodes too', async () => {
  const h = home();
  const full = await runScrub({ home: h, statfs: () => ({ bavail: 10, bsize: 4096, blocks: 1_000_000, files: 1_000_000, ffree: 900_000 }) });
  assert.equal(full.checks.disk.state, 'problem');
  assert.equal(full.stops, true);
  assert.match(full.problems.map((p) => p.message).join(' '), /too little for a checkpoint/);

  const low = await runScrub({ home: h, statfs: () => ({ bavail: GiB / 4096, bsize: 4096, blocks: 100 * GiB / 4096, files: 1_000_000, ffree: 900_000 }) });
  assert.equal(low.checks.disk.state, 'problem');
  assert.equal(low.stops, false);
  assert.deepEqual(low.problems.map((p) => p.stops), [0]);

  const inodes = await runScrub({ home: h, statfs: () => ({ ...roomy(), files: 1_000_000, ffree: 50 }) });
  assert.equal(inodes.stops, true);
  assert.match(inodes.problems.map((p) => p.message).join(' '), /room for new files/);

  const noInodes = await runScrub({ home: h, statfs: () => ({ ...roomy(), files: 0, ffree: 0 }) });
  assert.equal(noInodes.checks.disk.state, 'ok', 'a filesystem without fixed inodes isn’t a problem');
});

test('a damaged checkpoint is found against its own sealed manifest; the I/O budget gives partial, never ok', async () => {
  const h = home();
  const m = takeCheckpoint({ home: h, kind: 'named', name: `${CANARY} restore point`, version: '0.1.0' });
  const clean = await runScrub({ home: h, statfs: roomy });
  assert.equal(clean.checks.checkpoint.state, 'ok');
  assert.equal(clean.checks.checkpoint.checked, clean.checks.checkpoint.of);

  const budget = await runScrub({ home: h, statfs: roomy, ioBytes: 10 });
  assert.equal(budget.checks.checkpoint.state, 'partial');
  assert.ok(budget.incomplete.includes('checkpoint'));
  assert.equal(budget.ok, false, 'partial is never ok');
  assert.equal(budget.complete, false);

  const dir = join(h, 'checkpoints', m.id);
  writeFileSync(join(dir, 'files', 'memory', `${CANARY}.md`), 'changed\n');
  const r = await runScrub({ home: h, statfs: roomy });
  assert.equal(r.checks.checkpoint.state, 'problem');
  assert.deepEqual(r.checks.checkpoint.damaged_in, { memory: 1 }, 'where, as Nova’s own entry name only');
  assert.match(r.problems.map((p) => p.message).join(' '), /newest checkpoint is damaged/);
  assert.equal(r.stops, false);
});

// A home whose checkpoint has a large database copy and three small memory files of 1,000 bytes.
function bigAndSmall() {
  const h = home();
  for (const name of ['a', 'b', 'c']) writeFileSync(join(h, 'memory', `${name}.md`), 'x'.repeat(1000));
  const m = takeCheckpoint({ home: h, kind: 'auto', reason: 'Example', version: '0.1.0' });
  return { h, m, dbBytes: m.db.bytes, small: m.files.length };
}

test('a file over the budget is skipped while the others are still checked, smallest first, and ok stays false', async () => {
  const { h, dbBytes, small } = bigAndSmall();
  assert.ok(dbBytes > 100_000, 'the database copy is the large file');
  const r = await runScrub({ home: h, statfs: roomy, ioBytes: 64 * 1024 });
  const c = r.checks.checkpoint;
  assert.equal(c.of, small + 1);
  assert.equal(c.checked, small, 'every small file was hashed although the database copy came first in the manifest');
  assert.equal(c.skipped_too_large, 1);
  assert.equal(c.larger_than_budget, 1);
  assert.ok(c.bytes! > 0 && c.bytes! <= 64 * 1024);
  assert.equal(c.state, 'partial');
  assert.equal(c.stopped_by, 'budget');
  assert.equal(r.ok, false, 'anything skipped: never ok');
  assert.equal(r.complete, false);
  assert.deepEqual(r.problems, [], 'skipping isn’t damage');
  assert.ok(r.incomplete.includes('checkpoint'));
});

test('repeated scrubs rotate through what the budget can’t cover at once (in memory only)', async () => {
  // Whichever 1,000-byte file is damaged (same size, different bytes), two scrubs find it, although
  // the budget fits all the small files but one: smallest-first alone would skip the same one forever.
  for (const target of ['a', 'b', 'c']) {
    const { h, m, small } = bigAndSmall();
    const budget = m.files.reduce((s, f) => s + f.bytes, 0) - 1000 + 10;
    writeFileSync(join(h, 'checkpoints', m.id, 'files', 'memory', `${target}.md`), 'y'.repeat(1000));
    const before = snapshot(h);
    const first = await runScrub({ home: h, statfs: roomy, ioBytes: budget });
    const second = await runScrub({ home: h, statfs: roomy, ioBytes: budget });
    assert.equal(first.checks.checkpoint.checked, small - 1);
    assert.equal(first.checks.checkpoint.verified_earlier, 0);
    assert.ok(second.checks.checkpoint.verified_earlier! >= small - 2, 'the second scrub starts with what the first didn’t verify');
    assert.ok([first, second].some((r) => r.checks.checkpoint.state === 'problem'), `memory/${target}.md is reached by the rotation`);
    assert.deepEqual(snapshot(h), before, 'the rotation is never written to disk');
    for (const r of [first, second]) assert.ok(!JSON.stringify(r).includes(`${target}.md`), 'no file name');
  }
});

test('the output is redacted by construction: no path, no file or checkpoint name, no content', async () => {
  const h = home();
  const m = takeCheckpoint({ home: h, kind: 'named', name: `${CANARY} restore point`, version: '0.1.0' });
  writeFileSync(join(h, 'checkpoints', m.id, 'files', 'memory', `${CANARY}.md`), 'changed\n');
  overwrite(join(h, 'nova.db'), 4096 * 2, 4096 * 3);
  const sys = mkdtempSync(join(tmpdir(), `nova-integrity-sys-${CANARY}-`));
  mkdirSync(join(sys, 'proc', 'self'), { recursive: true });
  writeFileSync(join(sys, 'proc', 'self', 'mountinfo'), `25 1 8:3 / / rw,relatime - ext4 /dev/sdz9 rw\n`);
  mkdirSync(join(sys, 'sys', 'fs', 'ext4', 'sdz9'), { recursive: true });
  writeFileSync(join(sys, 'sys', 'fs', 'ext4', 'sdz9', 'errors_count'), '3\n');
  for (const full of [false, true]) {
    const r = await runScrub({ home: h, full, sysRoot: sys, statfs: () => ({ bavail: 10, bsize: 4096, blocks: 1_000_000, files: 1_000_000, ffree: 10 }) });
    assert.ok(r.problems.length >= 4, 'every kind of finding is in this result');
    const text = JSON.stringify(r);
    assert.ok(!text.includes(CANARY), 'no planted content, file name or checkpoint name');
    assert.ok(!text.includes(h) && !text.includes(tmpdir()), 'no home or other path');
    assert.ok(!text.includes(m.id) && !text.includes('sdz9'), 'no checkpoint id, no device');
    for (const s of strings(r)) assert.ok(!s.includes('/') && !s.includes('\\'), `a string that looks like a path: ${s}`);
    for (const s of strings(r)) assert.ok(!/row \d+|never used|btreeInitPage|Tree \d|note_body|\bnote\b/.test(s), `SQLite's own text: ${s}`);
  }
});

test('the time bound holds: a database check that never answers is stopped, and is unfinished, not ok', async () => {
  const h = home();
  const fixtures = mkdtempSync(join(tmpdir(), 'nova-integrity-worker-'));
  const checking = "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ phase: 'opening' });\nparentPort.postMessage({ phase: 'checking' });\nsetInterval(() => {}, 1000);\n";
  for (const [name, body, at] of [['hang.mjs', 'setInterval(() => {}, 1000);\n', 'starting'], ['spin.mjs', 'for (;;) {}\n', 'starting'], ['checking.mjs', checking, 'checking']] as const) {
    writeFileSync(join(fixtures, name), body);
    const started = Date.now();
    const r = await runScrub({ home: h, statfs: roomy, timeMs: 300, worker: pathToFileURL(join(fixtures, name)) });
    const took = Date.now() - started;
    assert.ok(took < 300 + 2000, `${name}: the scrub took ${took} ms`);
    assert.equal(r.checks.database.state, 'unfinished');
    assert.equal(r.checks.database.stopped_at, at, 'where the worker stopped, so a real unfinished run can be diagnosed');
    assert.ok(r.incomplete.includes('database'));
    assert.equal(r.ok, false, 'an unknown result never reads as healthy');
    assert.equal(r.complete, false);
    assert.equal(r.stops, false, 'unfinished isn’t a fault either: not red');
    assert.match(r.problems.map((p) => p.message).join(' '), /didn’t finish within/);
    assert.equal(r.problems[0]!.stops, 0);
  }
});

test('nothing is written: a stopped home stays byte-identical, and a running Nova’s home gains no file', async () => {
  const h = home();
  takeCheckpoint({ home: h, kind: 'named', name: 'Example', version: '0.1.0' });
  const before = snapshot(h);
  await runScrub({ home: h, statfs: roomy, full: true });
  await runScrub({ home: h, statfs: roomy });
  assert.deepEqual(snapshot(h), before, 'no file created, changed or touched');

  const live = mkdtempSync(join(tmpdir(), 'nova-integrity-live-'));
  const core = createCore({ home: live, version: '0.1.0', trustedOrigin: () => true });
  try {
    core.memory.remember({ kind: 'fact', content: 'Example fact', recorded_by: 'person' });
    const route = core.routes.find((r) => r.method === 'GET' && r.path === '/integrity');
    assert.ok(route, 'createCore mounts the scrub');
    const names = () => readdirSync(live, { recursive: true }).map(String).sort();
    const db = () => readFileSync(join(live, 'nova.db'));
    const listed = names();
    const main = db();
    const r = await route.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: {} as never }) as Awaited<ReturnType<typeof runScrub>>;
    assert.equal(r.checks.database.state, 'ok', 'a live WAL database reads clean alongside its writer');
    assert.deepEqual(names(), listed, 'no file created under a running Nova’s home');
    assert.ok(main.equals(db()), 'the database file is unchanged');
  } finally {
    await core.close();
  }
});

test('mounted beside diagnostics at the same person access, and refused while something writes, while one runs, and in the cool-down', async () => {
  const live = mkdtempSync(join(tmpdir(), 'nova-integrity-route-'));
  const core = createCore({ home: live, version: '0.1.0', trustedOrigin: () => true });
  try {
    const diag = core.routes.find((r) => r.path === '/diagnostics')!;
    const scrub = core.routes.find((r) => r.path === '/integrity')!;
    assert.equal(scrub.access, diag.access, 'the same access level as diagnostics');
    assert.equal(scrub.access ?? 'person', 'person');
  } finally {
    await core.close();
  }

  const h = home();
  mkdirSync(join(h, 'checkpoints', '.partial-000001-example'), { recursive: true });
  await assert.rejects(runScrub({ home: h, statfs: roomy }), (e: unknown) => e instanceof CoreError && /being written/.test(e.message));
  const g = home();
  writeFileSync(join(g, 'factory-reset.json'), '{}');
  await assert.rejects(runScrub({ home: g, statfs: roomy }), /factory reset is staged/);
  await assert.rejects(runScrub({ home: home(), statfs: roomy, busy: () => 'A handover between machines is in progress.' }), /handover/);

  let clock = 0;
  let release: () => void = () => {};
  const call = (route: ReturnType<typeof integrityRoutes>[number]) => route.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: {} as never });
  const [slow] = integrityRoutes(() => new Promise((r) => { release = () => r({} as never); }), { now: () => clock, cooldownMs: 1000 });
  const first = call(slow!);
  await assert.rejects(Promise.resolve(call(slow!)), /already running/);
  release();
  await first;
  await assert.rejects(Promise.resolve(call(slow!)), /a moment ago/);
  clock = 1001;
  const again = call(slow!);
  release();
  await again;

  const [refused] = integrityRoutes(() => Promise.reject(new CoreError('conflict', 'busy')), { now: () => 0, cooldownMs: 1000 });
  await assert.rejects(Promise.resolve(call(refused!)), /busy/);
  await assert.rejects(Promise.resolve(call(refused!)), /busy/, 'a refusal before reading doesn’t start the cool-down');
});

test('filesystem errors are read without root where ext4 reports them, and said unavailable elsewhere', async () => {
  const h = home();
  const sys = mkdtempSync(join(tmpdir(), 'nova-integrity-sys-'));
  mkdirSync(join(sys, 'proc', 'self'), { recursive: true });
  mkdirSync(join(sys, 'sys', 'fs', 'ext4', 'sdz9'), { recursive: true });
  writeFileSync(join(sys, 'sys', 'fs', 'ext4', 'sdz9', 'errors_count'), '0\n');
  writeFileSync(join(sys, 'proc', 'self', 'mountinfo'), '25 1 8:3 / / rw - ext4 /dev/sdz9 rw\n');
  assert.equal((await runScrub({ home: h, statfs: roomy, sysRoot: sys })).checks.fs_errors.state, 'ok');
  writeFileSync(join(sys, 'sys', 'fs', 'ext4', 'sdz9', 'errors_count'), '2\n');
  const bad = await runScrub({ home: h, statfs: roomy, sysRoot: sys });
  assert.equal(bad.checks.fs_errors.state, 'problem');
  assert.match(bad.problems.map((p) => p.message).join(' '), /recorded 2 errors/);
  writeFileSync(join(sys, 'proc', 'self', 'mountinfo'), '25 1 0:3 / / rw - btrfs /dev/sdz9 rw\n');
  const other = await runScrub({ home: h, statfs: roomy, sysRoot: sys });
  assert.equal(other.checks.fs_errors.state, 'unavailable');
  assert.ok(other.incomplete.includes('fs_errors'));
});
