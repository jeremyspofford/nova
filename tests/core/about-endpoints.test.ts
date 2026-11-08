// GET /api/v1/changelog and /api/v1/pipeline (About, the changelog and the pipeline dashboard), held
// to the endpoint exposure audit (docs/builder-packet/nova-endpoint-exposure-audit-2026-11-08.md):
// who may read them (the hub's own screen and a paired person's browser or phone, as /version), that
// nothing else may (no session, a paired computer, a write), and what they expose (only what the
// repository's own records say, as repository paths; never a file the request names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChangelog } from '../../src/core/changelog.ts';
import { call, enroll, hub } from './mesh-support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const A = 'a'.repeat(40);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('the changelog and the pipeline: read-only, person access only, and only the records they are made from', async () => {
  const h = await hub({ core: { version: '0.1.0-alpha.1', build: { env: { NOVA_BUILD_COMMIT: A } } } });
  try {
    // The hub's own screen.
    const log = await h.c('GET', '/changelog');
    assert.equal(log.status, 200);
    assert.equal(log.headers.get('cache-control'), 'no-store');
    assert.deepEqual(log.body.running, { version: '0.1.0-alpha.1', commit_short: 'aaaaaaaa' });
    assert.deepEqual(log.body.versions, parseChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).versions, 'exactly CHANGELOG.md');
    assert.deepEqual(Object.keys(log.body).sort(), ['newest', 'problems', 'running', 'versions', 'waiting']);
    const pipe = await h.c('GET', '/pipeline');
    assert.equal(pipe.status, 200);
    assert.deepEqual(Object.keys(pipe.body).sort(), ['counts', 'problems', 'sources', 'workstreams']);
    assert.equal(pipe.body.workstreams[0].name, 'Roadmap');
    for (const body of [log.body, pipe.body]) {
      const text = JSON.stringify(body);
      assert.ok(!text.includes(ROOT), 'no absolute path of the code’s checkout');
      assert.ok(!text.includes(h.home), 'nothing of Nova’s home');
    }
    for (const w of pipe.body.workstreams) for (const it of w.items) assert.match(it.evidence.path, /^(docs\/|CHANGELOG\.md$)/, 'evidence is a repository record');

    // Read-only, and no parameter reaches a file.
    for (const path of ['/changelog', '/pipeline']) {
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await h.c(method, path, {})).status, 405, `${method} ${path}`);
      assert.equal((await h.c('GET', `${path}/..%2F..%2Fpackage.json`)).status, 404, `${path}: no sub-path`);
      assert.deepEqual((await h.c('GET', `${path}?file=../../package.json&root=/etc`)).body, (await h.c('GET', path)).body, `${path}: a query names no file`);
    }

    // Over the mesh: nothing without a session; a paired phone (a person) reads; a paired computer can't.
    for (const path of ['/api/v1/changelog', '/api/v1/pipeline']) assert.equal((await call(h.mesh, 'GET', path)).status, 401, `${path}: no session, nothing learned`);
    const phone = await enroll(h, { kind: 'phone', name: 'Example phone' });
    const computer = await enroll(h, { kind: 'computer', name: 'Example computer', platform: 'linux x64', capabilities: ['heartbeat'] });
    for (const path of ['/api/v1/changelog', '/api/v1/pipeline']) {
      assert.equal((await call(h.mesh, 'GET', path, undefined, bearer(phone.token))).status, 200, `${path}: a paired phone reads it`);
      assert.equal((await call(h.mesh, 'GET', path, undefined, bearer(computer.token))).status, 403, `${path}: a paired computer can't`);
    }

    // In the API document, at person access (no x-nova-access marking anything wider).
    const doc = (await h.c('GET', '/openapi.json')).body;
    for (const path of ['/api/v1/changelog', '/api/v1/pipeline']) {
      assert.ok(doc.paths[path].get, `${path} is documented`);
      assert.equal(doc.paths[path].get['x-nova-access'], undefined, `${path} is person access`);
    }
  } finally {
    await h.stop();
  }
});
