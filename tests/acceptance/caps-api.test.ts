// Real production API composition, private subprocess home and file-held vault only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, stop } from './support.ts';
import { Joiner, call } from '../core/mesh-support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hardwareFile } from '../support/models.ts';

const expected = { task: { iterations: 24, tokens: 150_000, usd: 0.5 }, day: { iterations: 300, tokens: 1_500_000, usd: 5 } };

test('production caps API persists ceilings, validates input and preserves person and mutation guards', async (t) => {
  // Cleanup registered as each part is made: a start that fails ends the test, not the run.
  const m = blank('nova-caps-api-', t);
  const runtime = await startFakeOllama({ models: [] });
  t.after(() => runtime.close());
  const env = { NOVA_OLLAMA_URL: runtime.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir), NOVA_AGENT_CMD: 'example-unused-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: 'http://127.0.0.1:0' };
  let r = await m.start(env);
  const c = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(m.base, method, path, body, headers);
  try {
    const first = await c('GET', '/api/v1/caps');
    assert.equal(first.status, 200, 'normal production API mounts capsRoutes');
    assert.deepEqual(first.body.limits, expected);
    assert.deepEqual(first.body.defaults, expected);
    assert.equal(first.body.accounting.provider_reports_included, false);
    assert.equal(first.body.accounting.scope, 'this-node-runner');
    assert.match(first.body.accounting.words, /Provider-owned loops are not live capped/);
    assert.equal((await c('PUT', '/api/v1/vault/EXAMPLE_CAPS_TEST', { value: 'synthetic-caps-test-value' })).status, 200);
    assert.equal((await c('GET', '/api/v1/vault')).body.key, 'file');
    const saved = { task: { iterations: 7, tokens: 2222, usd: 0.25 }, day: { iterations: 90, tokens: 9999, usd: null } };
    assert.equal((await c('PUT', '/api/v1/caps/limits', saved)).status, 200);
    assert.deepEqual((await c('GET', '/api/v1/caps')).body.limits, saved);
    for (const body of [null, [], { week: {} }, { task: { tokens: 0 } }, { day: { usd: -1 } }, { task: { iterations: 1.5 } }, { task: { tokens: '2' } }, { task: { steps: 1 } }]) {
      assert.equal((await c('PUT', '/api/v1/caps/limits', body)).status, 400, JSON.stringify(body));
      assert.deepEqual((await c('GET', '/api/v1/caps')).body.limits, saved, 'refusal does not disable ceilings');
    }
    const overflow = await fetch(m.base + '/api/v1/caps/limits', { method: 'PUT', headers: { 'x-nova': '1', 'content-type': 'application/json' }, body: '{"task":{"tokens":1e309}}' });
    assert.equal(overflow.status, 400, 'non-finite parsed JSON is refused');
    assert.equal((await c('PUT', '/api/v1/caps/limits', { task: { tokens: 20 } }, { 'x-nova': '' })).status, 403);
    assert.equal((await c('PUT', '/api/v1/caps/limits', { task: { tokens: 20 } }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(r.mesh!, 'GET', '/api/v1/caps')).status, 401);
    assert.equal((await call(r.mesh!, 'PUT', '/api/v1/caps/limits', saved)).status, 401);

    for (const kind of ['browser', 'phone', 'computer', 'standby']) {
      const code = (await c('POST', '/api/v1/mesh/pairings')).body.code;
      const dev = new Joiner(r.mesh!, () => Math.floor(Date.now() / 1000), { kind, name: `Example ${kind}` });
      assert.equal((await dev.join(code)).status, 201);
      assert.equal((await dev.reveal()).status, 200);
      assert.equal((await c('POST', `/api/v1/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
      await dev.poll();
      const session = await dev.session({ cookie: kind === 'browser' });
      assert.equal(session.status, 200);
      const auth: Record<string, string> = kind === 'browser' ? { cookie: /nova_session=[^;]+/.exec(session.headers.get('set-cookie') ?? '')![0] } : { authorization: `Bearer ${session.body.token}` };
      const status = kind === 'browser' || kind === 'phone' ? 200 : 403;
      assert.equal((await call(r.mesh!, 'GET', '/api/v1/caps', undefined, auth)).status, status, kind);
      assert.equal((await call(r.mesh!, 'PUT', '/api/v1/caps/limits', saved, auth)).status, status, kind);
      if (status === 200) {
        assert.equal((await call(r.mesh!, 'PUT', '/api/v1/caps/limits', saved, { ...auth, 'x-nova': '' })).status, 403);
        assert.equal((await call(r.mesh!, 'PUT', '/api/v1/caps/limits', saved, { ...auth, origin: 'https://evil.example' })).status, 403);
      }
    }
    await stop(r);
    r = await m.start(env);
    assert.deepEqual((await c('GET', '/api/v1/caps')).body.limits, saved, 'ceilings survive a real process restart');
  } finally { await stop(r); }
});
