// Nova Computer hardening (the PR #236 review, item 12): every /computer route goes through the
// console's own checks, against the real server. The list of routes is the server's own (its
// OpenAPI document), so a route added later is checked too. For each:
//  - from the mesh listener with no paired device's session: refused, whatever the method;
//  - a change (POST) without the X-Nova header, or from a foreign or `null` Origin: refused;
//  - a request naming another Host (DNS rebinding): refused;
//  - no CORS header, so another site's page can't read an answer.
// The positive control: the same request from Nova's own page gets past the checks (to the route's
// own answer, a validation error or "not found" here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { blank, stop } from './support.ts';

const raw = (url: string, method: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((ok, fail) => {
  const req = request(url, { method, headers }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, text }));
  });
  req.on('error', fail);
  req.end(body);
});

test('every /computer route goes through the console’s session, header, origin and host checks', { timeout: 120_000 }, async () => {
  const m = blank('nova-m10a-routes-');
  const nova = await m.start({ NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' });
  try {
    const doc = await m.get('/api/v1/openapi.json') as { paths: Record<string, Record<string, unknown>> };
    const routes = Object.entries(doc.paths).filter(([p]) => p.startsWith('/api/v1/computer')).flatMap(([p, ops]) => Object.keys(ops).map((op) => ({ path: p, method: op.toUpperCase() })));
    assert.ok(routes.length >= 9, `the computer's routes are listed (${routes.length})`);
    const fill = (p: string) => p.replace('{id}', 'w0000000000').replace('{task}', 'nosuchtask');
    const console_ = `http://127.0.0.1:${nova.port}`;
    const mesh = nova.mesh!;
    // An empty body: the positive control then stops at the route's own validation, so nothing is made.
    const body = '{}';
    const json = { 'content-type': 'application/json' };
    for (const r of routes) {
      const what = `${r.method} ${r.path}`;
      const url = fill(r.path);
      // From the mesh, with no paired device: refused, with or without Nova's header.
      for (const h of [{}, { 'x-nova': '1' }]) {
        const res = await raw(mesh + url, r.method, { ...json, ...h }, r.method === 'POST' ? body : undefined);
        assert.equal(res.status, 401, `${what} from the mesh with no session: ${res.status} ${res.text}`);
      }
      // Another Host (a rebinding page): refused before anything.
      const host = await raw(console_ + url, r.method, { ...json, host: 'evil.example', 'x-nova': '1' }, r.method === 'POST' ? body : undefined);
      assert.equal(host.status, 421, `${what} with Host evil.example`);
      if (r.method === 'POST') {
        for (const [h, why] of [[{}, /X-Nova/], [{ 'x-nova': '1', origin: 'http://evil.example' }, /Cross-origin/], [{ 'x-nova': '1', origin: 'null' }, /Cross-origin/]] as const) {
          const res = await raw(console_ + url, 'POST', { ...json, ...h }, body);
          assert.equal(res.status, 403, `${what} ${JSON.stringify(h)}: ${res.status} ${res.text}`);
          assert.match(res.text, why);
        }
      }
      // Positive control: Nova's own page gets through to the route itself.
      const own = await raw(console_ + url, r.method, { ...json, 'x-nova': '1', origin: console_ }, r.method === 'POST' ? body : undefined);
      assert.ok(![401, 403, 421].includes(own.status), `${what} from Nova’s own page: ${own.status} ${own.text}`);
      assert.equal(own.headers['access-control-allow-origin'], undefined, `${what}: no CORS header`);
    }
  } finally {
    await stop(nova);
  }
});
