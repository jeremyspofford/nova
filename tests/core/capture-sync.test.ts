// The capture data path, the hub's side (M10h; the design's gate list, adopted by the orchestration
// ADR): sync and dedupe with provenance; a manifest from an unknown or revoked device, another
// device's, or with a bad signature or checksum, refused and logged; local-only with a cloud hub
// refuses (the device queues); a forget of what a spoke holds waits for its signed acknowledgement
// before it says "deleted everywhere"; a raw fetch is a ledger task with its reason, verified by Nova's
// own check of the file. A real core on loopback, devices that enroll the way the plan says, batches
// the test signs with each device's own key. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  captureBatchMessage, captureItemDigest, generateDeviceKeys, rawManifestMessage, sha256Hex, signMessage, tombstoneAckMessage,
  type CaptureBatchManifest, type CoreOptions, type DeviceKeys,
} from '../../src/core/index.ts';
import { call, enroll, hub } from './mesh-support.ts';
import { until } from './device-support.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function rig(core: Partial<CoreOptions> = {}) {
  const h = await hub({ core: { captureRawWaitMs: 4000, ...core } });
  const join = async (name: string, purposes: string[]) => {
    const { dev, token } = await enroll(h, { name, kind: 'computer', platform: 'darwin arm64', capabilities: ['heartbeat'], purposes });
    // An installed capture workload offers its kinds: the hub lists them as sources, off.
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat', 'capture.screen', 'capture.audio'] }, bearer(token))).status, 200);
    return { id: dev.deviceId, token, keys: dev.keys, name };
  };
  const mac = await join('Test Mac', ['capture-source']);
  const other = await join('Other computer', ['capture-source']);
  const at = (s: number) => new Date(h.clock.t + s * 1000).toISOString();
  let seq = 0;
  const item = (o: { kind?: string; text: string; s: number; id?: string }) => ({ id: o.id ?? `screenpipe:${o.kind === 'audio' ? 'audio' : 'ocr'}:${++seq}`, seq: ++seq, kind: o.kind ?? 'screen', at: at(o.s), ended_at: null, app: 'Editor', window_title: 'Notes', url: null, text: o.text });
  const signed = (items: ReturnType<typeof item>[], keys: DeviceKeys, device: { id: string; name: string }, o: Partial<CaptureBatchManifest> = {}) => {
    const manifest: CaptureBatchManifest = {
      v: 1, batch_id: randomUUID(), device_id: device.id, device_name: device.name, source: 'screenpipe-adapter',
      seq_from: items[0]!.seq, seq_to: items[items.length - 1]!.seq, items: items.map((i) => ({ id: i.id, seq: i.seq, sha256: captureItemDigest(i) })), queued: 0, sent_at: at(0), ...o,
    };
    return { manifest, signature: signMessage(keys.ed25519.privateKey, captureBatchMessage(manifest)), items };
  };
  const send = (token: string, body: unknown) => call(h.mesh, 'POST', '/api/v1/mesh/capture/batch', body, bearer(token));
  const plan = (token: string) => call(h.mesh, 'GET', '/api/v1/mesh/capture/plan', undefined, bearer(token));
  const enable = (deviceId: string, kind: string) => h.c('POST', `/capture/sources/${encodeURIComponent(`device:${deviceId}:${kind}`)}/enable`);
  const events = async () => ((await h.c('GET', '/capture/events?limit=200')).body.events ?? (await h.c('GET', '/capture/events?limit=200')).body) as { id: string; text: string; device: { id: string }; provenance: { transfer: Record<string, unknown> | null; external_id: string } }[];
  return { h, mac, other, item, signed, send, plan, enable, events, at };
}

test('sync and dedupe: consent first, each item taken in once, every item answered, provenance kept, lag in words', async () => {
  const r = await rig();
  try {
    // Off by default: the plan names no kind, and nothing sent is kept.
    assert.deepEqual((await r.plan(r.mac.token)).body, { kinds: {}, sync: { allowed: true, why: null }, tombstones: 0, raw: 0 });
    const early = r.signed([r.item({ text: 'BEFORE-CONSENT', s: 1 })], r.mac.keys, r.mac);
    const e0 = await r.send(r.mac.token, early);
    assert.equal(e0.status, 200);
    assert.equal(e0.body.results[0].status, 'not_kept');
    assert.match(e0.body.results[0].reason, /off/);
    // Screen turned on (consent, per source and device); audio stays off.
    assert.equal((await r.enable(r.mac.id, 'screen')).status, 200);
    const p = (await r.plan(r.mac.token)).body;
    assert.deepEqual(Object.keys(p.kinds), ['screen']);
    r.h.tick(5000);
    const b = r.signed([r.item({ text: 'The test lamp is in the hall.', s: 6 }), r.item({ text: 'A second line.', s: 7 }), r.item({ kind: 'audio', text: 'AUDIO-IS-OFF', s: 8 })], r.mac.keys, r.mac, { queued: 212 });
    const res = await r.send(r.mac.token, b);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.results.map((x: { status: string }) => x.status), ['kept', 'kept', 'not_kept']);
    assert.equal(res.body.acked_to, b.manifest.seq_to);
    // Sent again (the reply was lost): answered as duplicates, nothing twice.
    const again = await r.send(r.mac.token, r.signed(b.items, r.mac.keys, r.mac, { queued: 212 }));
    assert.deepEqual(again.body.results.map((x: { status: string }) => x.status), ['duplicate', 'duplicate', 'not_kept']);
    const evs = (await r.events()).filter((e) => e.device.id === r.mac.id);
    assert.deepEqual(evs.map((e) => e.text).sort(), ['A second line.', 'The test lamp is in the hall.']);
    assert.ok(!JSON.stringify(evs).includes('AUDIO-IS-OFF') && !JSON.stringify(evs).includes('BEFORE-CONSENT'));
    // Provenance: which machine, which source, its sequence, the batch, both clocks.
    const t = evs.find((e) => e.text === 'A second line.')!.provenance.transfer!;
    assert.deepEqual({ device: t.device_id, name: t.device_name, source: t.source, seq: t.seq, batch: t.batch_id, path: t.path }, { device: r.mac.id, name: 'Test Mac', source: 'screenpipe-adapter', seq: b.items[1]!.seq, batch: b.manifest.batch_id, path: 'capture-sync' });
    assert.equal(t.device_time, b.items[1]!.at);
    assert.ok(typeof t.received_at === 'string');
    // The lag, as a number and in words.
    const lag = (await r.h.c('GET', '/capture/devices')).body.devices.find((d: { device_id: string }) => d.device_id === r.mac.id);
    assert.equal(lag.acked_seq, b.manifest.seq_to);
    assert.equal(lag.queued, 212);
    assert.match(lag.said, /^Test Mac capture: synced to \d\d:\d\d · 212 queued$/);
  } finally { await r.h.stop(); }
});

test('manifest refusal: an unknown device, a revoked one, another device’s, a bad signature or checksum: nothing kept, and logged', async () => {
  const r = await rig();
  try {
    await r.enable(r.mac.id, 'screen');
    await r.enable(r.other.id, 'screen');
    r.h.tick(5000);
    const refused = async (body: unknown, token: string, why: RegExp) => {
      const res = await r.send(token, body);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(res.body.error, /This capture batch was refused, and nothing in it was kept/);
      assert.match(res.body.error, why);
    };
    const one = () => [r.item({ text: 'REFUSED-WORDS', s: 6 })];
    // Signed by a key that isn't the device's.
    await refused(r.signed(one(), generateDeviceKeys(), r.mac), r.mac.token, /signature isn’t Test Mac’s key/);
    // A device Nova doesn't know.
    await refused(r.signed(one(), r.mac.keys, { id: 'not-a-device', name: 'Ghost' }), r.mac.token, /names a device Nova doesn’t know/);
    // Another device's, over this device's session (even signed by that device's own key).
    await refused(r.signed(one(), r.other.keys, r.other), r.mac.token, /says it is from Other computer, but came over Test Mac’s session/);
    // An item changed after it was listed.
    const b = r.signed(one(), r.mac.keys, r.mac);
    await refused({ ...b, items: [{ ...b.items[0], text: 'CHANGED' }] }, r.mac.token, /checksum doesn’t match/);
    // Out of the device's sequence.
    const two = [r.item({ text: 'x', s: 6 }), r.item({ text: 'y', s: 7 })].reverse();
    await refused(r.signed(two, r.mac.keys, r.mac, { seq_from: two[0]!.seq, seq_to: two[1]!.seq }), r.mac.token, /sequence order/);
    // Revoked: its session ends, and a manifest naming it is refused whoever sends it.
    assert.equal((await r.h.c('POST', `/mesh/devices/${r.other.id}/revoke`, { confirm: true })).status, 200);
    assert.equal((await r.send(r.other.token, r.signed(one(), r.other.keys, r.other))).status, 401, 'a revoked device has no session');
    await refused(r.signed(one(), r.other.keys, r.other), r.mac.token, /from Other computer, which was revoked/);
    assert.ok(!JSON.stringify(await r.events()).includes('REFUSED-WORDS'), 'nothing refused was kept');
    const problems = JSON.stringify((await r.h.c('GET', '/problems')).body);
    assert.match(problems, /Nova refused capture sent over Test Mac’s connection, and kept none of it/);
  } finally { await r.h.stop(); }
});

test('local-only with a cloud hub: the plan says it waits, and a batch is refused; local-preferred takes it', async () => {
  const r = await rig({ site: () => 'cloud' });
  try {
    await r.enable(r.mac.id, 'screen');
    r.h.tick(5000);
    const p = (await r.plan(r.mac.token)).body;
    assert.equal(p.sync.allowed, false);
    assert.match(p.sync.why, /local-only mode and its hub runs in the cloud, so captured words stay on this device, queued/);
    const res = await r.send(r.mac.token, r.signed([r.item({ text: 'CLOUD-LOCAL-ONLY', s: 6 })], r.mac.keys, r.mac));
    assert.equal(res.status, 409);
    assert.ok(!JSON.stringify(await r.events()).includes('CLOUD-LOCAL-ONLY'));
    // What waits there is known, though (a count and why: no content).
    assert.equal((await call(r.h.mesh, 'POST', '/api/v1/mesh/capture/status', { queued: 7, paused: p.sync.why }, bearer(r.mac.token))).status, 200);
    const lag = (await r.h.c('GET', '/capture/devices')).body.devices[0];
    assert.match(lag.said, /Test Mac capture: nothing synced yet · 7 queued \(paused: Nova is in local-only mode/);
    // A raw fetch to a cloud hub: refused (the per-device opt-in isn't built).
    // Local-preferred (the design's "local-first"): the cloud hub's policy applies, and it is taken.
    assert.equal((await r.h.c('PUT', '/profile/privacy/default', { value: 'local-preferred' })).status, 200);
    assert.equal((await r.plan(r.mac.token)).body.sync.allowed, true);
    const ok = await r.send(r.mac.token, r.signed([r.item({ text: 'CLOUD-LOCAL-FIRST', s: 7 })], r.mac.keys, r.mac));
    assert.equal(ok.body.results[0].status, 'kept');
    const ev = (await r.events()).find((e) => e.text === 'CLOUD-LOCAL-FIRST')!;
    const raw = await r.h.c('POST', `/capture/events/${ev.id}/raw`, { reason: 'To see the original.' });
    assert.equal(raw.status, 409);
    assert.match(raw.body.error, /runs in the cloud\. Fetching an original to a cloud hub needs a per-device opt-in, which isn’t built/);
  } finally { await r.h.stop(); }
});

test('a forget reaches the device that holds it, and says "deleted everywhere" only once that device has acknowledged, signed', async () => {
  const r = await rig();
  try {
    await r.enable(r.mac.id, 'screen');
    r.h.tick(5000);
    const b = r.signed([r.item({ text: 'FORGET-ME', s: 6 })], r.mac.keys, r.mac);
    await r.send(r.mac.token, b);
    const ev = (await r.events()).find((e) => e.text === 'FORGET-ME')!;
    const f = await r.h.c('DELETE', `/capture/events/${ev.id}`);
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.everywhere, false);
    assert.match(f.body.said, /Deleted here\. Waiting for Test Mac to confirm it has deleted its copy too\./);
    assert.deepEqual(f.body.elsewhere.map((e: { name: string; acknowledged: boolean }) => [e.name, e.acknowledged]), [['Test Mac', false]]);
    assert.equal((await r.plan(r.mac.token)).body.tombstones, 1);
    const ts = (await call(r.h.mesh, 'GET', '/api/v1/mesh/capture/tombstones', undefined, bearer(r.mac.token))).body.tombstones;
    assert.deepEqual(ts.map((t: { items: string[] }) => t.items), [[b.items[0]!.id]], 'the device’s own id for it, no words');
    // Another device sees none of it.
    assert.deepEqual((await call(r.h.mesh, 'GET', '/api/v1/mesh/capture/tombstones', undefined, bearer(r.other.token))).body.tombstones, []);
    const ack = (removed: string[], keys = r.mac.keys) => call(r.h.mesh, 'POST', `/api/v1/mesh/capture/tombstones/${ts[0].id}/ack`, { removed, signature: signMessage(keys.ed25519.privateKey, tombstoneAckMessage(r.mac.id, ts[0].id, removed)) }, bearer(r.mac.token));
    assert.equal((await ack([b.items[0]!.id], generateDeviceKeys())).status, 403, 'not signed by the device');
    assert.equal((await ack([])).status, 409, 'it must remove all of it');
    const forgets = async () => (await r.h.c('GET', '/capture/forgets')).body.forgets[0];
    assert.match((await forgets()).said, /waiting for Test Mac to confirm/);
    assert.equal((await ack([b.items[0]!.id])).status, 200);
    const done = await forgets();
    assert.match(done.said, /Deleted on Test Mac too \(it confirmed\)/);
    assert.ok(done.acknowledged_at);
    assert.equal((await r.plan(r.mac.token)).body.tombstones, 0);
    // Sent again later, it doesn't come back.
    const back = await r.send(r.mac.token, r.signed(b.items, r.mac.keys, r.mac));
    assert.equal(back.body.results[0].status, 'not_kept');
    assert.match(back.body.results[0].reason, /forget/);
  } finally { await r.h.stop(); }
});

test('a raw fetch is a ledger task naming the item and the reason; the device’s signed original is checked by Nova itself', async () => {
  const r = await rig();
  const target = mkdtempSync(join(tmpdir(), 'nova-raw-backups-'));
  const second = mkdtempSync(join(tmpdir(), 'nova-raw-encrypted-'));
  try {
    await r.enable(r.mac.id, 'screen');
    r.h.tick(5000);
    const b = r.signed([r.item({ text: 'HAS-AN-ORIGINAL', s: 6 })], r.mac.keys, r.mac);
    await r.send(r.mac.token, b);
    const ev = (await r.events()).find((e) => e.text === 'HAS-AN-ORIGINAL')!;
    assert.equal((await r.h.c('POST', `/capture/events/${ev.id}/raw`, {})).status, 400, 'a reason is required');
    const asked = await r.h.c('POST', `/capture/events/${ev.id}/raw`, { reason: 'To read the chart in the frame.' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const task = asked.body.task;
    assert.match(task.title, /Fetch the original capture from Test Mac/);
    assert.match(task.brief.goal, new RegExp(`${ev.id} \\(${b.items[0]!.id}\\) from Test Mac to the hub, because: To read the chart in the frame\\.`));
    const reqs = (await call(r.h.mesh, 'GET', '/api/v1/mesh/capture/raw', undefined, bearer(r.mac.token))).body.requests;
    assert.deepEqual(reqs.map((q: { item: string; reason: string }) => [q.item, q.reason]), [[b.items[0]!.id, 'To read the chart in the frame.']]);
    assert.deepEqual((await call(r.h.mesh, 'GET', '/api/v1/mesh/capture/raw', undefined, bearer(r.other.token))).body.requests, []);
    const data = Buffer.from('stand-in frame bytes, not an image of anything');
    const manifest = { v: 1 as const, request_id: reqs[0].id, device_id: r.mac.id, item: b.items[0]!.id, sha256: sha256Hex(data), size: data.length, sent_at: r.at(10) };
    const up = (o: { data?: Buffer; keys?: DeviceKeys } = {}) => call(r.h.mesh, 'POST', `/api/v1/mesh/capture/raw/${reqs[0].id}`, { manifest, signature: signMessage((o.keys ?? r.mac.keys).ed25519.privateKey, rawManifestMessage(manifest)), data: (o.data ?? data).toString('base64') }, bearer(r.mac.token));
    assert.equal((await up({ keys: generateDeviceKeys() })).status, 403);
    assert.equal((await up({ data: Buffer.from('something else') })).status, 403);
    assert.equal((await up()).status, 200);
    const t = await until(async () => (await r.h.c('GET', `/tasks/${task.id}`)).body, (x) => x.state === 'done', 10_000);
    assert.equal(t.state, 'done', JSON.stringify(t));
    assert.match(JSON.stringify(t.verification ?? t), /the checksum the device signed/);
    const got = (await r.h.c('GET', `/capture/raw/${reqs[0].id}`)).body;
    assert.equal(Buffer.from(got.data, 'base64').toString(), data.toString());
    assert.equal(got.reason, 'To read the chart in the frame.');
    r.h.core.resilience.setSettings({ target, encrypted_target: second });
    const backup = r.h.core.resilience.nightly.run();
    assert.ok(backup.ok, backup.error ?? 'backup failed');
    const rawPath = `capture/raw/${reqs[0].id}`;
    assert.ok(existsSync(join(backup.path!, 'files', rawPath)), 'the backup held the original before forgetting');
    const checkpoint = r.h.core.checkpoints.take({ kind: 'named', name: 'Before forgetting the original' });
    assert.ok(existsSync(join(r.h.home, 'checkpoints', checkpoint.id, 'files', rawPath)), 'capture originals belong to Nova and follow home recovery/reset');
    // Forgetting the event forgets the original fetched with it.
    await r.h.c('DELETE', `/capture/events/${ev.id}`);
    assert.equal((await r.h.c('GET', `/capture/raw/${reqs[0].id}`)).status, 404);
    const opened = join(target, 'opened');
    r.h.core.resilience.nightly.decrypt(backup.encrypted_path!, opened);
    for (const dir of [backup.path!, opened, join(r.h.home, 'checkpoints', checkpoint.id)]) {
      assert.equal(existsSync(join(dir, 'files', rawPath)), false, 'no recovery copy keeps the forgotten original');
      const db = new DatabaseSync(join(dir, 'nova.db'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_raw_fetch WHERE event_id = ?').get(ev.id)!.n, 0); }
      finally { db.close(); }
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      assert.ok(!manifest.files.some((f: { path: string }) => f.path === rawPath), 'a restore never expects the removed file');
    }
  } finally {
    await r.h.stop();
    rmSync(target, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
