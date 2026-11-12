import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT, DEFAULT_ADVISORY, loadTimings, plan, shards, STALE_DAYS, TIMINGS, unmeasured } from '../scripts/ui-shard.js';
import { parseJob, titleMatchers } from '../scripts/ui-timings.js';

const files = readdirSync('tests/ui').filter((f) => f.endsWith('.test.ts'));
const timings = loadTimings();
// 8 is CI's shard count since the owner's pipeline ruling of 2026-11-11 (was 4, still covered).
const COUNTS = [1, 2, 3, 4, 6, 8];
// New UI files get DEFAULT until the next `npm run ui:timings`. A few is fine; more than this and the
// shards are guesswork, so the committed timings must be refreshed.
const MAX_UNMEASURED = 8;

const tmp = mkdtempSync(join(tmpdir(), 'ui-shard-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };

function coversOnce(t, n, label) {
  const all = shards(files, n, t).flat();
  assert.equal(all.length, files.length, `${label}, ${n} shards: no file twice`);
  assert.deepEqual([...all].sort(), [...files].sort(), `${label}, ${n} shards: no file left out`);
}

test('UI shards: every UI test file runs in exactly one shard, at every shard count', () => {
  for (const n of COUNTS) coversOnce(timings, n, 'measured timings');
});

test('UI shards: with no timings at all, every file still runs in exactly one shard', () => {
  const none = loadTimings(join(tmp, 'absent.json'));
  for (const n of COUNTS) coversOnce(none, n, 'no timings');
});

test('UI shards: the five slowest measured files never share a shard when there are at least five', () => {
  const slow = Object.entries(timings.seconds).filter(([f]) => files.includes(f))
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f);
  assert.equal(slow.length, 5);
  for (const n of [5, 6, 8]) {
    const where = shards(files, n, timings).map((s) => s.filter((f) => slow.includes(f)).length);
    assert.ok(where.every((c) => c <= 1), `${n} shards, slow files per shard: ${where}`);
  }
  const four = shards(files, 4, timings).map((s) => s.filter((f) => slow.slice(0, 4).includes(f)).length);
  assert.ok(four.every((c) => c === 1), `4 shards, the four slowest one each: ${four}`);
});

// CI runs eight shards since the owner's pipeline ruling of 2026-11-11; four (the old count) is kept
// to the same 5% bound, so the check covers both and is no looser.
test('UI shards: at CI\'s eight shards (and the former four), the projected totals are within 5% of each other', () => {
  for (const n of [4, 8]) {
    const totals = plan(files, n, timings).map((s) => s.seconds);
    assert.ok(Math.max(...totals) <= 1.05 * Math.min(...totals), `${n} shards, projected seconds: ${totals.map(Math.round)}`);
  }
});

test('UI shards: the workflow matrix is the shard count balanced here, and the advisory runs in shard 1', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const matrix = /shard: \[([^\]]*)\]/.exec(yml)?.[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(matrix, Array.from({ length: 8 }, (_, i) => `${i + 1}/8`));
  assert.match(yml, /matrix\.shard == '1\/8'/, 'the accessibility advisory runs in the shard ui-shard.js lightens for it');
});

test('UI timings: the committed JSON loads and measures the current UI files', () => {
  const json = JSON.parse(readFileSync(TIMINGS, 'utf8'));
  assert.ok(Number.isFinite(Date.parse(json.generated)), 'generated is a date');
  assert.ok(Array.isArray(json.runs) && json.runs.length >= 3, 'measured over at least three runs');
  assert.ok(Number.isFinite(json.advisorySeconds), 'the advisory step is measured');
  assert.deepEqual(timings.warnings.filter((w) => !/days old/.test(w)), [], 'loads without a fallback');
  for (const [f, s] of Object.entries(json.seconds)) {
    assert.match(f, /\.test\.ts$/, `${f} is a UI test file name`);
    assert.ok(Number.isInteger(s) && s >= 0, `${f}: whole seconds`);
  }
  const missing = unmeasured(files, timings);
  assert.ok(missing.length <= MAX_UNMEASURED, `${missing.length} UI files have no measured time (${missing.join(', ')}): run npm run ui:timings and commit scripts/ui-timings.json`);
});

test('UI timings: a missing or broken file falls back to DEFAULT, with a warning', () => {
  for (const path of [join(tmp, 'absent.json'), fixture('broken.json', '{ not json'), fixture('shape.json', '{"seconds":[1,2]}')]) {
    const t = loadTimings(path);
    assert.deepEqual(t.seconds, {}, path);
    assert.equal(t.advisorySeconds, DEFAULT_ADVISORY, path);
    assert.match(t.warnings.join('\n'), /npm run ui:timings/, path);
    // Every file costs DEFAULT, so the shards are even by count (shard 1 a little lighter for the
    // advisory): uneven in real time, but no file lost or doubled.
    const totals = plan(files, 4, t).map((s) => s.seconds);
    assert.ok(Math.max(...totals) - Math.min(...totals) <= DEFAULT, `even by projected seconds: ${totals}`);
  }
});

test('UI timings: an old file still shards, but warns; a fresh one doesn\'t; an unlisted file costs DEFAULT', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-11-08T00:00:00Z');
  const path = fixture('t.json', JSON.stringify({ generated: '2026-11-01T00:00:00Z', advisorySeconds: 100, seconds: { 'a.test.ts': 50 } }));
  assert.deepEqual(loadTimings(path, now).warnings, []);
  const old = loadTimings(path, now + STALE_DAYS * day);
  assert.match(old.warnings.join('\n'), /days old/);
  assert.deepEqual(old.seconds, { 'a.test.ts': 50 }, 'old numbers are still used: better than none');
  const p = plan(['a.test.ts', 'new.test.ts'], 1, old);
  assert.equal(p[0].seconds, 100 + 50 + DEFAULT);
  assert.deepEqual(unmeasured(['a.test.ts', 'new.test.ts'], old), ['new.test.ts']);
});

test('UI shards: the CLI prints only file paths on stdout, the same on every call', () => {
  const run = () => execFileSync(process.execPath, ['scripts/ui-shard.js', '2/4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const out = run();
  assert.equal(out, run(), 'deterministic');
  const lines = out.trim().split('\n');
  assert.ok(lines.length > 0 && lines.every((l) => /^tests\/ui\/[\w.-]+\.test\.ts$/.test(l)), out);
});

test('UI timings: log titles map to their files in run order, and a file\'s time is wall clock', () => {
  const m = {
    'a.test.ts': titleMatchers("test('alpha: the first one', () => {});\ntest(`alpha ${b}: per browser`, () => {});"),
    'b.test.ts': titleMatchers('it("beta works", async () => {}); test(`${x}`, () => {});'),
    'c.test.ts': titleMatchers("test('gamma: alpha: the first one', () => {});"),
  };
  assert.equal(m['b.test.ts'].length, 1, 'an all-${} title is too vague to match on');
  const log = [
    '2026-11-09T00:00:00.000Z no-Kubernetes tripwire: armed',
    '2026-11-09T00:00:10.000Z ✔ alpha: the first one (9000ms)',
    '2026-11-09T00:00:30.000Z ✔ alpha chromium: per browser (20000ms)',
    '2026-11-09T00:00:31.000Z   ✔ a nested step (5ms)',
    '2026-11-09T00:01:00.000Z ✔ beta works (25000ms)',
    '2026-11-09T00:01:05.000Z ✔ something computed (1000ms)',
    '2026-11-09T00:01:45.000Z ✔ gamma: alpha: the first one (39000ms)',
    '2026-11-09T00:01:46.000Z ℹ duration_ms 106000.5',
  ].join('\n');
  const r = parseJob(log, Object.keys(m), m);
  assert.deepEqual(r.files, { 'a.test.ts': 30, 'b.test.ts': 35, 'c.test.ts': 41 });
  assert.equal(r.tests, 5);
  assert.equal(r.unmatched, 1, 'the unmatched title stays with the file before it');
  assert.equal(r.total, 106);
});
