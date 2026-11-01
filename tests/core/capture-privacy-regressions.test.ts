import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hub, enroll, call } from './mesh-support.ts';
import { createCore, captureBatchMessage, captureItemDigest, generateDeviceKeys, rawManifestMessage, sha256Hex, signMessage } from '../../src/core/index.ts';
import { Carrier } from '../../src/device/carrier.ts';

async function rawRig() {
  let site: 'home' | 'cloud' = 'home';
  const h = await hub({ core: { site: () => site, captureRawWaitMs: 4000 } });
  const { dev, token } = await enroll(h, { name: 'Synthetic capture device', kind: 'computer', platform: 'linux x64', capabilities: ['heartbeat'], purposes: ['capture-source'] });
  const headers = { authorization: `Bearer ${token}` };
  const api = (method: string, path: string, body?: unknown) => call(h.mesh, method, `/api/v1/mesh/capture${path}`, body, headers);
  await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat', 'capture.screen'] }, headers);
  const source = encodeURIComponent(`device:${dev.deviceId}:screen`);
  assert.equal((await h.c('POST', `/capture/sources/${source}/enable`)).status, 200);
  h.tick(10000);
  const item = { id: 'screenpipe:ocr:1', seq: 1, kind: 'screen', at: new Date(h.clock.t).toISOString(), ended_at: null, app: 'Editor', window_title: 'Notes', url: null, text: 'Synthetic safe capture text' };
  const manifest = { v: 1 as const, batch_id: randomUUID(), device_id: dev.deviceId, device_name: 'Synthetic capture device', source: 'screenpipe-adapter', seq_from: 1, seq_to: 1, items: [{ id: item.id, seq: item.seq, sha256: captureItemDigest(item) }], queued: 0, sent_at: item.at };
  assert.equal((await api('POST', '/batch', { manifest, signature: signMessage(dev.keys.ed25519.privateKey, captureBatchMessage(manifest)), items: [item] })).body.results[0].status, 'kept');
  const eventBody = (await h.c('GET', '/capture/events')).body;
  const event = (eventBody.events ?? eventBody).find((e: any) => e.provenance.external_id === item.id);
  const asked = await h.c('POST', `/capture/events/${event.id}/raw`, { reason: 'Synthetic privacy regression' });
  assert.equal(asked.status, 200);
  const id = asked.body.task.brief.inputs.fetch_id;
  const data = Buffer.from('Synthetic raw bytes for regression only');
  const raw = { v: 1 as const, request_id: id, device_id: dev.deviceId, item: item.id, sha256: sha256Hex(data), size: data.length, sent_at: item.at };
  return { h, api, id, event, data, source, cloud: () => { site = 'cloud'; }, upload: () => api('POST', `/raw/${id}`, { manifest: raw, signature: signMessage(dev.keys.ed25519.privateKey, rawManifestMessage(raw)), data: data.toString('base64') }) };
}

for (const transition of ['cloud-local-only', 'cloud-local-preferred', 'paused', 'disabled'] as const) {
  test(`pending raw is withheld and refused after ${transition}`, async () => {
    const r = await rawRig();
    try {
      if (transition.startsWith('cloud')) {
        r.cloud();
        if (transition === 'cloud-local-preferred') await r.h.c('PUT', '/profile/privacy/default', { value: 'local-preferred' });
      } else {
        assert.equal((await r.h.c('POST', `/capture/sources/${r.source}/${transition === 'paused' ? 'pause' : 'disable'}`)).status, 200);
      }
      const offered = (await r.api('GET', '/raw')).body.requests;
      const uploaded = await r.upload();
      assert.deepEqual(offered, [], 'current policy must withhold a previously authorized raw request');
      assert.equal(uploaded.status, 409, 'an in-flight upload must recheck current policy');
      assert.equal(existsSync(join(r.h.home, 'capture', 'raw', r.id)), false);
    } finally { await r.h.stop(); rmSync(r.h.home, { recursive: true, force: true }); }
  });
}

test('replica recovery copies remove forgotten raw and preserve its readable metadata until forgetting', async () => {
  const r = await rawRig();
  const home = mkdtempSync(join(tmpdir(), 'nova-raw-replica-regression-'));
  const replica = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(r.h.clock.t), mesh: null });
  replica.mesh.sync.setLogging(false);
  replica.mesh.sync.fresh();
  let cursor = 0;
  const replicate = () => {
    r.h.core.mesh.sync.scan();
    for (;;) {
      const batch = r.h.core.mesh.sync.batch(cursor, { peerSchema: replica.mesh.sync.schema() });
      replica.mesh.sync.apply(batch, () => {});
      cursor = batch.upto;
      if (!batch.more) break;
    }
  };
  try {
    assert.equal((await r.upload()).status, 200);
    replicate();
    const checkpoint = replica.checkpoints.take({ kind: 'named', name: 'Synthetic raw recovery regression' });
    const rawPath = `capture/raw/${r.id}`;
    const backupFile = join(home, 'checkpoints', checkpoint.id, 'files', rawPath);
    assert.ok(existsSync(backupFile));
    const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
    const metadata = db.prepare('SELECT * FROM capture_raw_fetch WHERE id = ?').get(r.id);
    db.close();
    assert.equal((await r.h.c('DELETE', `/capture/events/${r.event.id}`)).status, 200);
    replicate();
    assert.equal(existsSync(backupFile), false, 'forgotten raw must not remain in replica recovery copies');
    assert.equal(existsSync(join(home, rawPath)), false);
    assert.equal(metadata?.event_id, r.event.id, 'replica needs the event-to-file mapping for recall and forgetting');
    const manifest = JSON.parse(readFileSync(join(home, 'checkpoints', checkpoint.id, 'manifest.json'), 'utf8'));
    assert.ok(!manifest.files.some((f: { path: string }) => f.path === rawPath));
  } finally { await r.h.stop(); await replica.close(); rmSync(r.h.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('off-kind deletion survives transient failure and carrier restart', async () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  const at = new Date(now.getTime() - 60000).toISOString();
  let store = [{ type: 'Audio', content: { chunk_id: 1, timestamp: at, transcription: 'SYNTHETIC AUDIO WHILE OFF' } }];
  let failDelete = true;
  let active = true;
  let screenOn = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    for await (const _ of req) { /* consume synthetic request */ }
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/search') return res.end(JSON.stringify({ data: store.filter((x) => x.content.timestamp >= url.searchParams.get('start_time')! && x.content.timestamp <= url.searchParams.get('end_time')!) }));
    if (url.pathname === '/__delete') {
      if (failDelete) { res.statusCode = 503; return res.end('{}'); }
      store = [];
      return res.end(JSON.stringify({ removed: 1 }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), 'nova-carrier-delete-regression-'));
  const keys = generateDeviceKeys();
  const make = () => new Carrier({ home, keys, active: () => active, deviceId: () => 'synthetic-device', deviceName: () => 'Synthetic device', now: () => now, capture: () => ({ port, kinds: ['screen', 'audio'] }), stopCapture: async () => {}, hub: async () => ({ status: 200, body: { kinds: screenOn ? { screen: '2026-11-01T11:00:00.000Z' } : {}, sync: { allowed: true, why: null }, tombstones: 0, raw: 0 } }) });
  try {
    const first = make();
    await first.tick();
    assert.equal(store.length, 1);
    const failure = first.status().last_error;
    screenOn = false;
    await first.tick();
    active = false;
    failDelete = false;
    const restarted = make();
    await restarted.tick();
    assert.equal(store.length, 0, 'restarting must retry the deletion even though the item was already seen');
    assert.match(failure ?? '', /delet|remov/i, 'a failed privacy deletion must be reported');
    assert.equal(restarted.status().last_error, null);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

for (const transition of ['before-read', 'before-send', 'sync-denied-initial', 'sync-denied-before-send', 'plan-unavailable-before-send'] as const) {
  test(`carrier checks raw permission ${transition}`, async () => {
    let allowed = true;
    let reads = 0;
    let uploads = 0;
    let batches = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/search')) { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }
      reads++; allowed = false; res.end('SYNTHETIC RAW');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'nova-carrier-policy-regression-'));
    const carrier = new Carrier({ home, keys: generateDeviceKeys(), deviceId: () => 'synthetic-device', deviceName: () => 'Synthetic device', capture: () => ({ port, kinds: ['screen'] }), stopCapture: async () => {}, hub: async (_method, path) => {
      if (path.endsWith('/plan') && transition === 'plan-unavailable-before-send' && !allowed) return null;
      if (path.endsWith('/plan')) return { status: 200, body: { kinds: { screen: new Date().toISOString() }, sync: { allowed: transition === 'sync-denied-initial' ? false : allowed, why: null }, raw_allowed: transition.startsWith('sync-denied') ? true : allowed, tombstones: 0, raw: 1 } };
      if (path.endsWith('/raw')) { if (transition === 'before-read') allowed = false; return { status: 200, body: { requests: [{ id: 'synthetic-request', item: 'screenpipe:ocr:1', reason: 'Synthetic test' }] } }; }
      if (path.endsWith('/raw/synthetic-request')) { uploads++; return { status: 200, body: { ok: true } }; }
      if (path.endsWith('/batch')) { batches++; return { status: 200, body: { results: [{ id: 'screenpipe:ocr:queued', status: 'kept' }] } }; }
      return null;
    } });
    writeFileSync(join(home, 'capture', 'outbox', '000000000001.json'), JSON.stringify({ id: 'screenpipe:ocr:queued', seq: 1, kind: 'screen', at: new Date().toISOString(), ended_at: null, app: 'Editor', window_title: 'Notes', url: null, text: 'Synthetic queued event' }));
    try {
      await carrier.tick();
      assert.equal(reads, transition === 'before-read' || transition === 'sync-denied-initial' ? 0 : 1);
      assert.equal(uploads, 0, 'a changed permission must stop raw bytes before upload');
      assert.equal(batches, 0, 'a refreshed privacy refusal must also hold the derived queue');
      assert.equal(carrier.status().queued, 1, 'held derived data stays queued for later delivery');
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
  });
}

for (const transition of ['denied', 'unavailable'] as const) {
  test(`derived sync holds its next batch when policy becomes ${transition} after an acknowledgement`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'nova-carrier-batch-policy-regression-'));
    let held = false;
    const received: string[] = [];
    const carrier = new Carrier({
      home, keys: generateDeviceKeys(), deviceId: () => 'synthetic-device', deviceName: () => 'Synthetic device',
      capture: () => null, stopCapture: async () => {},
      hub: async (_method, path, body) => {
        if (path.endsWith('/plan')) {
          if (held && transition === 'unavailable') return null;
          return { status: 200, body: { kinds: { screen: '2026-11-01T11:00:00.000Z' }, sync: { allowed: !held, why: held ? 'Synthetic policy now denies transfer.' : null }, raw_allowed: false, tombstones: 0, raw: 0 } };
        }
        if (path.endsWith('/batch')) {
          const items = (body as { items: { id: string }[] }).items;
          received.push(...items.map((i) => i.id));
          held = true;
          return { status: 200, body: { results: items.map((i) => ({ id: i.id, status: 'kept' })) } };
        }
        if (path.endsWith('/status')) return { status: 200, body: { ok: true } };
        return null;
      },
    });
    for (let seq = 1; seq <= 101; seq++) writeFileSync(join(home, 'capture', 'outbox', `${String(seq).padStart(12, '0')}.json`), JSON.stringify({ id: `screenpipe:ocr:${seq}`, seq, kind: 'screen', at: '2026-11-01T12:00:00.000Z', ended_at: null, app: 'Editor', window_title: 'Notes', url: null, text: `Synthetic queued event ${seq}` }));
    try {
      await carrier.tick();
      assert.equal(received.length, 100, 'only the batch authorized before the policy change may leave');
      assert.deepEqual(carrier.queued().map((i) => i.id), ['screenpipe:ocr:101'], 'the unsent batch must remain durable');
      assert.match(carrier.status().paused ?? '', /policy|refresh|waiting/i, 'a held queue must report why it stopped');
      held = false;
      await carrier.tick();
      assert.equal(received.length, 101);
      assert.equal(new Set(received).size, 101, 'resuming must not resend acknowledged events');
      assert.equal(carrier.status().queued, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
