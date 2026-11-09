// Infrastructure looks OpenTofu up on PATH without holding the event loop (#428 follow-up). On a WSL
// PATH of slow /mnt/c folders one synchronous lookup held Nova for up to a second and a half; the
// health check was moved off it, and this covers the rest: the infra page (GET /infra), starting a
// run (POST /infra/runs and the chat's infra_plan) and every tool call a run makes.
// A PATH of thousands of folders that don't exist stands in for the slow ones (no /mnt/c needed): a
// lookup that holds the loop lets no setImmediate tick through until it is over, one that doesn't
// lets the loop turn between folders. Counting ticks, not milliseconds, keeps it deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { openTofu } from '../../src/core/infra/tool.ts';
import { Redactor } from '../../src/core/browser/logins.ts';
import { PRICES, makeProject, tofuOnPath } from '../support/infra.ts';

const FOLDERS = 5000;
const longPath = (end?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'nova-long-path-'));
  return [...Array.from({ length: FOLDERS }, (_, i) => join(root, `missing-${i}`)), ...(end ? [end] : [])].join(delimiter);
};

// Calls f and counts the setImmediate ticks the event loop gets through before what it returns
// settles, with the longest stretch the loop went without one.
async function loopDuring<T>(f: () => T): Promise<{ ticks: number; held: number; settled: PromiseSettledResult<Awaited<T>> }> {
  let ticks = 0;
  let held = 0;
  let on = true;
  let last = performance.now();
  const tick = () => {
    if (!on) return;
    const now = performance.now();
    held = Math.max(held, now - last);
    last = now;
    ticks++;
    setImmediate(tick);
  };
  setImmediate(tick);
  last = performance.now();
  const [settled] = await Promise.allSettled([(async () => f())()]);
  on = false;
  held = Math.max(held, performance.now() - last);
  return { ticks, held: Math.round(held), settled: settled as PromiseSettledResult<Awaited<T>> };
}

const enough = 100;
const says = (what: string, r: { ticks: number; held: number }) => `${what}: ${r.ticks} loop ticks during a ${FOLDERS}-folder PATH lookup, the loop held at most ${r.held} ms`;

function boot(path: () => string) {
  const home = mkdtempSync(join(tmpdir(), 'nova-infra-path-home-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, infra: { path, timeoutS: 60 } });
  return core;
}

test('the infra page (GET /infra) looks tofu up without holding the event loop, and still says whether it is there', { timeout: 60_000 }, async () => {
  const { bin } = tofuOnPath();
  let path = longPath(bin);
  const core = boot(() => path);
  try {
    const there = await loopDuring(() => core.infra.list());
    console.log(says('GET /infra, tofu last on PATH', there));
    assert.equal(there.settled.status, 'fulfilled');
    assert.equal(there.settled.status === 'fulfilled' && there.settled.value.tool.installed, true);
    assert.ok(there.ticks >= enough, says('GET /infra held the event loop', there));

    path = longPath();
    const missing = await loopDuring(() => core.infra.list());
    console.log(says('GET /infra, no tofu', missing));
    assert.equal(missing.settled.status === 'fulfilled' && missing.settled.value.tool.installed, false);
    assert.ok(missing.ticks >= enough, says('GET /infra held the event loop', missing));
  } finally { await core.close(); }
});

test('starting a run (POST /infra/runs) looks tofu up without holding the event loop, and still refuses clearly when it is missing', { timeout: 60_000 }, async () => {
  const path = longPath();
  const core = boot(() => path);
  try {
    const { folder } = makeProject();
    const p = core.infra.createProject({ name: 'Example', folder, budget_usd_month: 20, prices: PRICES });
    const r = await loopDuring(() => core.infra.start({ project: p.id }));
    console.log(says('POST /infra/runs, no tofu', r));
    assert.equal(r.settled.status, 'rejected');
    assert.match(String(r.settled.status === 'rejected' && (r.settled.reason as Error).message), /OpenTofu isn’t on this computer \(no tofu on PATH\)\. Nova doesn’t install it\./);
    assert.ok(r.ticks >= enough, says('POST /infra/runs held the event loop', r));
    assert.equal((await core.infra.list()).runs.length, 0, 'a refused start leaves no run behind');
  } finally { await core.close(); }
});

test('each tool call of a run looks tofu up without holding the event loop, and refuses clearly when it is missing', { timeout: 60_000 }, async () => {
  const path = longPath();
  const tool = openTofu({ path: () => path });
  const dir = mkdtempSync(join(tmpdir(), 'nova-infra-path-run-'));
  const r = await loopDuring(() => tool.init({ dir, env: {}, red: new Redactor() }));
  console.log(says('tofu init, no tofu', r));
  assert.equal(r.settled.status, 'rejected');
  assert.match(String(r.settled.status === 'rejected' && (r.settled.reason as Error).message), /OpenTofu isn’t on this computer \(no tofu on PATH\)/);
  assert.ok(r.ticks >= enough, says('a tool call held the event loop', r));
});
