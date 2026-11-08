// Splits the UI suite (tests/ui/*.test.ts) into balanced CI shards by measured run time, and prints
// one shard's files. Node's own --test-shard deals files round-robin by name, which left one half at
// ~32 minutes and the other at ~17 (runs 42431924304–42436887738), because five files are half the
// suite. Here the slowest file goes to the least-loaded shard, then the next, and so on. Every file
// lands in exactly one shard, so the shards together still run the whole suite (tests/ui-shard.test.js).
// Usage: node scripts/ui-shard.js 2/4     → that shard's files, one per line
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Seconds per file, from CI run 42436887738 (both halves' logs). Files not listed count as DEFAULT.
// shortcut: hand-copied timings drift as tests change; re-measure when the shard job times in CI drift apart by more than a few minutes.
const SECONDS = {
  'm9-contrast.test.ts': 433, 'fold-postures.test.ts': 306, 'm9-vitals.test.ts': 254,
  'ui-rebuild-compositions.test.ts': 205, 'models-screen-app.test.ts': 204, 'm10b-hostile-login.test.ts': 75,
  'orb-states.test.ts': 73, 'health-caps-diagnostics.test.ts': 72, 'm10i-topology.test.ts': 70,
  'backups-settings-styleguide.test.ts': 65, 'passkey-styleguide.test.ts': 63, 'navigation-reachability.test.ts': 58,
  'ui-fixes.test.ts': 49, 'm10i-vitals.test.ts': 48, 'm4-mesh.test.ts': 44, 'models-screen-styleguide.test.ts': 41,
  'm9-progress.test.ts': 41, 'backups-settings-visual.test.ts': 40, 'backups-settings.test.ts': 38,
  'compositions.test.ts': 36, 'ux-review-1.test.ts': 35, 'm10i-styleguide.test.ts': 25, 'm9-fold.test.ts': 34,
  'health-styleguide.test.ts': 34, 'ios-status-bar.test.ts': 33, 'config-doors-styleguide.test.ts': 31,
  'm10b-review2.test.ts': 26, 'ui-review.test.ts': 26, 'posture-sweep.test.ts': 25, 'm9-skew.test.ts': 23,
  'offline.test.ts': 22, 'm9-skeleton.test.ts': 21, 'm10f-onboarding.test.ts': 20,
};
const DEFAULT = 10;
// The accessibility advisory (~126 s) runs after the tests in shard 1's job only (ci.yml).
const HEAD_START = { 1: 126 };

export function shards(files, total) {
  const load = Array.from({ length: total }, (_, i) => HEAD_START[i + 1] ?? 0);
  const out = Array.from({ length: total }, () => []);
  const cost = (f) => SECONDS[f] ?? DEFAULT;
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const i = load.indexOf(Math.min(...load));
    out[i].push(f);
    load[i] += cost(f);
  }
  return out.map((s) => s.sort());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
  const [k, n] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || k < 1 || k > n) {
    console.error('usage: node scripts/ui-shard.js <k>/<n>, e.g. 2/4');
    process.exit(2);
  }
  const files = readdirSync('tests/ui').filter((f) => f.endsWith('.test.ts'));
  for (const f of shards(files, n)[k - 1]) console.log(`tests/ui/${f}`);
}
