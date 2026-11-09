// The integrity scrub through a live server process: the production code path (src/server.js, its
// worker thread, the database Nova holds open). The scrub's database check must finish, fast, on a
// small healthy database while the server is running. Temp home only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, stop } from './support.ts';

test('a running Nova scrubs its own live database: the database check finishes ok, well inside the bound', async () => {
  const m = blank('nova-integrity-live-');
  const r = await m.start();
  try {
    const started = Date.now();
    const res = await fetch(`${m.base}/api/v1/integrity`);
    const took = Date.now() - started;
    const body = await res.json() as { ok: boolean; complete: boolean; checks: { database: { state: string; ms: number } }; bounds: { time_ms: number } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.checks.database.state, 'ok', `database check: ${JSON.stringify(body.checks.database)}\n${r.out.join('').slice(-2000)}`);
    assert.ok(body.checks.database.ms < 3000, `the database check took ${body.checks.database.ms} ms`);
    assert.ok(took < body.bounds.time_ms, `the request took ${took} ms`);
  } finally {
    await stop(r);
  }
});
