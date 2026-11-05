// The old hub's probe loop (M10g step 6) stays one loop. The new hub says, signed, that it is failing
// (the stable name didn't move), but its stand-down never comes back, so the old hub keeps watching
// rather than take the role back. That path used to start a second probe loop beside the running one
// each time, so probes ran two, then three, then four at a time. Two cores over HTTP on loopback
// (m10g-support.ts); the loop's timers run on the test's clock, so every round is counted exactly.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pair, promote, stop } from './m10g-support.ts';

test('after a roll-back the new hub never acknowledged, exactly one probe loop runs and probes never overlap', { timeout: 60_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 3600, probeMs: 150 } });
  // The new hub's stand-down answer is lost on the way back: everything else passes through.
  // (node:http, not fetch: fetch's own timers would stop on the test's clock.)
  const proxy = createServer((req, res) => {
    if (req.url!.endsWith('/promotion/stand-down')) { req.resume(); res.writeHead(502); res.end(); return; }
    const up = request(`${p.b.mesh}${req.url}`, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  p.toB!.point(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  // Every probe() the loop starts waits at a gate the test opens, so overlap is counted, not raced.
  const pr = p.a.core.mesh.promotions;
  const real = pr.probe.bind(pr);
  const waiting: Array<() => void> = [];
  const runs: Promise<unknown>[] = [];
  let live = 0;
  let most = 0;
  let first: () => void = () => {};
  const started = new Promise<void>((r) => { first = r; });
  pr.probe = () => {
    const run = (async () => {
      live++; most = Math.max(most, live);
      try { await new Promise<void>((go) => { waiting.push(go); first(); }); return await real(); } finally { live--; }
    })();
    runs.push(run);
    return run;
  };
  try {
    p.name.stuck(true);
    assert.equal((await promote(p)).status, 202);
    await started;
    mock.timers.enable({ apis: ['setTimeout'] });
    const perRound: number[] = [];
    for (let i = 0; i < 6; i++) {
      perRound.push(waiting.length);
      for (const go of waiting.splice(0)) go();
      await Promise.allSettled(runs.splice(0));
      mock.timers.tick(pr.probeMs);
    }
    const rec = pr.record()!;
    assert.ok(rec.told?.includes('no-stand-down'), `the roll-back path ran: ${JSON.stringify(rec.told)} ${JSON.stringify(rec.probes.map((x) => [x.result, x.checks.find((c) => c.name === 'reach')?.said]))}`);
    assert.equal(rec.state, 'verifying', 'it kept watching');
    assert.equal(p.a.core.mesh.role.role(), 'standby', 'and never took the role back by itself');
    assert.deepEqual(perRound, [1, 1, 1, 1, 1, 1], 'one probe per round: one loop');
    assert.equal(most, 1, 'probes never overlap');
  } finally {
    mock.timers.reset();
    for (const go of waiting.splice(0)) go();
    proxy.closeAllConnections(); proxy.close();
    await stop(p);
  }
});
