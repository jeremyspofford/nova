// Roles bound the work Nova puts on a paired computer (M10f review, finding 2): model roles and
// downloads need compute; capture from a computer needs capture source. A thin client, or a computer
// with neither, gets none of it, and narrowing a computer's roles says what actually stops, and stops
// it. The hub runs Nova and its own local models whatever its roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, LIBRARY, hubHardware } from '../support/models.ts';
import { call, enroll, hub } from './mesh-support.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function withSpoke(purposes: string[], run: (o: { h: Awaited<ReturnType<typeof hub>>; id: string; token: string; spokeUrl: string }) => Promise<void>) {
  const hubOllama = await startFakeOllama({ models: INSTALLED, library: LIBRARY });
  const spokeOllama = await startFakeOllama({ models: INSTALLED, library: LIBRARY });
  const hw = hubHardware();
  const h = await hub({ core: { models: { ollamaUrl: hubOllama.url, hardware: async () => hw as never, watchMs: 100_000 } } });
  try {
    const { dev, token } = await enroll(h, { name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes });
    const spokeHw = hubHardware({ hostname: 'desk-box', network: [{ name: 'eth0', mac: '02:00:00:00:00:02', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.255.255.255' }] });
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', hardware: spokeHw, capabilities: ['heartbeat', 'capture.app-activity'] }, bearer(token))).status, 200);
    await run({ h, id: dev.deviceId, token, spokeUrl: spokeOllama.url });
  } finally {
    await h.stop();
    await hubOllama.close?.();
    await spokeOllama.close?.();
  }
}

test('a thin client, or a computer without compute, gets no model role and no download (the reviewer’s probe)', async () => {
  for (const purposes of [['thin-client'], [], ['storage']]) {
    await withSpoke(purposes, async ({ h, id, spokeUrl }) => {
      const role = await h.c('PUT', '/models/roles/reasoner', { device: id, url: spokeUrl, model: 'example-deep:32b' });
      assert.equal(role.status, 409, `${purposes}: ${JSON.stringify(role.body)}`);
      assert.match(role.body.error, /Desk box isn’t a compute device[\s\S]*Settings › Devices/);
      const pull = await h.c('POST', '/models/pull', { device: id, model: 'example-new:7b' });
      assert.equal(pull.status, 409, JSON.stringify(pull.body));
      assert.match(pull.body.error, /isn’t a compute device/);
    });
  }
});

test('with compute it may; taking compute away says its reasoner model stops there, and no model work goes to it after', async () => {
  await withSpoke(['compute'], async ({ h, id, spokeUrl }) => {
    const role = await h.c('PUT', '/models/roles/reasoner', { device: id, url: spokeUrl, model: 'example-deep:32b' });
    assert.equal(role.status, 200, JSON.stringify(role.body));
    // The review sheet's dry run: what it would stop, nothing changed.
    const dry = await h.c('PATCH', `/mesh/devices/${id}`, { purposes: [], dry_run: true });
    assert.deepEqual([dry.status, dry.body.stops, dry.body.purposes], [200, ['its thinking and writing model'], ['compute']]);
    const ask = await h.c('PATCH', `/mesh/devices/${id}`, { purposes: [] });
    assert.equal(ask.status, 400);
    assert.match(ask.body.error, /It would stop its thinking and writing model there/);
    assert.equal((await h.c('PATCH', `/mesh/devices/${id}`, { purposes: [], approved: true })).status, 200);
    // The role is still named, but nothing is sent there: a download refused, inference refused.
    assert.match((await h.c('POST', '/models/pull', { device: id, model: 'example-new:7b' })).body.error, /isn’t a compute device/);
    await assert.rejects(h.core.models.infer({ role: 'reasoner', messages: [{ role: 'user', content: 'hello' }], privacy_mode: 'local-only' }), /Desk box isn’t a compute device/);
  });
});

test('capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off', async () => {
  await withSpoke([], async ({ h, id, token }) => {
    assert.deepEqual((await h.c('GET', '/capture')).body.sources, [], 'nothing offered by a computer that isn’t a capture source');
    const r = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'cap-00000001', kind: 'capture_event', body: { kind: 'app-activity', at: new Date(h.clock.t).toISOString(), app: 'Editor', text: 'NOT-A-CAPTURE-SOURCE' } }] }, bearer(token));
    assert.equal(r.body.results[0].status, 'refused');
    assert.match(r.body.results[0].reason, /isn’t a capture source/);
  });
  await withSpoke(['capture-source'], async ({ h, id, token }) => {
    const src = `device:${id}:app-activity`;
    assert.deepEqual((await h.c('GET', '/capture')).body.sources.map((s: { id: string }) => s.id), [src]);
    assert.equal((await h.c('POST', `/capture/sources/${encodeURIComponent(src)}/enable`)).status, 200);
    const ask = await h.c('PATCH', `/mesh/devices/${id}`, { purposes: [] });
    assert.match(ask.body.error, /It would stop App activity there/);
    assert.equal((await h.c('PATCH', `/mesh/devices/${id}`, { purposes: [], approved: true })).status, 200);
    const s = (await h.c('GET', '/capture')).body.sources.find((x: { id: string }) => x.id === src);
    assert.equal(s.enabled, false, 'it stopped');
    const again = await h.c('POST', `/capture/sources/${encodeURIComponent(src)}/enable`);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /isn’t a capture source/);
    const r = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'cap-00000002', kind: 'capture_event', body: { kind: 'app-activity', at: new Date(h.clock.t).toISOString(), app: 'Editor', text: 'AFTER-NARROWING' } }] }, bearer(token));
    assert.equal(r.body.results[0].status, 'refused');
  });
});
