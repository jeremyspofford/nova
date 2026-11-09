// Splits the UI suite (tests/ui/*.test.ts) into balanced CI shards by measured run time, and prints
// one shard's files. Node's own --test-shard deals files round-robin by name, which left one half at
// ~32 minutes and the other at ~17 (runs 42431924304–42436887738), because five files are half the
// suite. Here the slowest file goes to the least-loaded shard, then the next, and so on. Every file
// lands in exactly one shard, so the shards together still run the whole suite (tests/ui-shard.test.js).
// Usage: node scripts/ui-shard.js 2/4     → that shard's files, one per line
//        node scripts/ui-shard.js --plan 4 → each shard's projected seconds and files
//
// The times come from scripts/ui-timings.json, measured from recent main runs' logs by
// scripts/ui-timings.js (npm run ui:timings) and committed. Only the committed file is read, so every
// shard of a run deals the same files. Files it doesn't list count as DEFAULT; a missing, unreadable or
// stale file still shards every file exactly once, and says so as a CI warning on each shard's job.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TIMINGS = fileURLToPath(new URL('./ui-timings.json', import.meta.url));
export const DEFAULT = 10;
// The accessibility advisory runs after the tests in shard 1's job only (ci.yml); measured with the rest.
export const DEFAULT_ADVISORY = 126;
export const STALE_DAYS = 30;

// → { seconds, advisorySeconds, generated, warnings }. Never throws: sharding must still cover every file.
export function loadTimings(path = TIMINGS, now = Date.now()) {
  const warnings = [];
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
    if (!json || typeof json.seconds !== 'object' || Array.isArray(json.seconds)) throw new Error('no "seconds" table');
  } catch (e) {
    warnings.push(`UI shard timings unusable (${e.code ?? e.message}); every file counts as ${DEFAULT} s, so shards may be uneven. Run: npm run ui:timings`);
    return { seconds: {}, advisorySeconds: DEFAULT_ADVISORY, generated: null, warnings };
  }
  const seconds = Object.fromEntries(Object.entries(json.seconds).filter(([, s]) => Number.isFinite(s) && s >= 0));
  const age = (now - Date.parse(json.generated)) / 86_400_000;
  if (!(age <= STALE_DAYS)) warnings.push(`UI shard timings are ${Number.isFinite(age) ? `${Math.floor(age)} days` : 'of unknown age'} old (over ${STALE_DAYS}). Run: npm run ui:timings`);
  const advisorySeconds = Number.isFinite(json.advisorySeconds) ? json.advisorySeconds : DEFAULT_ADVISORY;
  return { seconds, advisorySeconds, generated: json.generated, warnings };
}

// Files with no measured time (new since the last measurement).
export const unmeasured = (files, timings) => files.filter((f) => !(f in timings.seconds));

export function plan(files, total, timings = loadTimings()) {
  const load = Array.from({ length: total }, (_, i) => (i === 0 ? timings.advisorySeconds : 0));
  const out = Array.from({ length: total }, () => []);
  const cost = (f) => timings.seconds[f] ?? DEFAULT;
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const i = load.indexOf(Math.min(...load));
    out[i].push(f);
    load[i] += cost(f);
  }
  return out.map((s, i) => ({ files: s.sort(), seconds: load[i] }));
}

export const shards = (files, total, timings) => plan(files, total, timings).map((s) => s.files);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = readdirSync('tests/ui').filter((f) => f.endsWith('.test.ts'));
  const timings = loadTimings();
  const missing = unmeasured(files, timings);
  if (missing.length) timings.warnings.push(`no measured time for ${missing.length} UI file(s), counted as ${DEFAULT} s each: ${missing.join(', ')}. Run: npm run ui:timings`);
  // stderr: the shard's file list on stdout stays clean; ::warning:: shows on the job in GitHub.
  for (const w of timings.warnings) console.error(`::warning title=UI shard timings::${w}`);
  if (process.argv[2] === '--plan') {
    const n = Number(process.argv[3]);
    if (!(n >= 1)) { console.error('usage: node scripts/ui-shard.js --plan <n>'); process.exit(2); }
    plan(files, n, timings).forEach((s, i) => console.log(`${i + 1}/${n}: ${Math.round(s.seconds)} s, ${s.files.length} files`));
    process.exit(0);
  }
  const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
  const [k, n] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || k < 1 || k > n) {
    console.error('usage: node scripts/ui-shard.js <k>/<n>, e.g. 2/4');
    process.exit(2);
  }
  for (const f of shards(files, n, timings)[k - 1]) console.log(`tests/ui/${f}`);
}
