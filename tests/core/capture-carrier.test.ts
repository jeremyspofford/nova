// The capture carrier on a device (M10h; the capture data path design, part 2): the boot agent's data
// channel, against the stand-in Screenpipe run as a workload would run it and a stand-in hub. Nothing
// is skipped when much is captured at once (the pull reads time windows whole, smaller when one is too
// big); an item reported late is still taken; what was captured while its kind was off is deleted
// where it was captured and never sent; a full queue pauses and says so, and nothing is lost or sent
// twice once there is room. Neutral placeholders only; 127.0.0.1 and temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBatchMessage, captureItemDigest, generateDeviceKeys, verifyDeviceSignature, type CaptureBatchManifest } from '../../src/core/index.ts';
import { Carrier, type CarrierItem } from '../../src/device/carrier.ts';
import { STAND_IN, freePort, getJson, postJson } from '../support/workloads.ts';
import { until } from './device-support.ts';

async function standIn(): Promise<{ port: number; proc: ChildProcess; url: string }> {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), 'nova-carrier-sp-'));
  const proc = spawn(process.execPath, [STAND_IN], { env: { PORT: String(port), NOVA_SERVICE_STATE: state, NOVA_SERVICE_VERSION: '1.0.0' }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  await until(() => getJson(`${url}/health`), (h) => h.status === 200, 10_000);
  return { port, proc, url };
}

function rig(port: number, o: { kinds: Record<string, string>; maxQueue?: number; sync?: boolean } ) {
  const keys = generateDeviceKeys();
  const got: CarrierItem[] = [];
  let sync = o.sync ?? true;
  const c = new Carrier({
    home: mkdtempSync(join(tmpdir(), 'nova-carrier-')), keys, deviceId: () => 'dev-1', deviceName: () => 'Test Mac',
    capture: () => ({ port, kinds: ['screen', 'audio'] }), stopCapture: async () => {}, ...(o.maxQueue ? { maxQueue: o.maxQueue } : {}),
    hub: async (method, path, body) => {
      if (path === '/api/v1/mesh/capture/plan') return { status: 200, body: { kinds: o.kinds, sync: sync ? { allowed: true, why: null } : { allowed: false, why: 'Waiting, for the test.' }, tombstones: 0, raw: 0 } };
      if (path === '/api/v1/mesh/capture/batch' && method === 'POST') {
        const b = body as { manifest: CaptureBatchManifest; signature: string; items: CarrierItem[] };
        assert.ok(verifyDeviceSignature(keys.ed25519.publicKey, captureBatchMessage(b.manifest), b.signature), 'signed with the device key');
        b.items.forEach((it, i) => assert.equal(captureItemDigest(it), b.manifest.items[i]!.sha256));
        got.push(...b.items);
        return { status: 200, body: { results: b.items.map((i) => ({ id: i.id, status: 'kept', reason: null })) } };
      }
      if (path === '/api/v1/mesh/capture/status') return { status: 200, body: { ok: true } };
      return { status: 404, body: {} };
    },
  });
  return { c, got, keys, allow: () => { sync = true; } };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('a big burst is read whole, in windows, and sent once each; off kinds are deleted on the device and never sent; a late item is still taken', { timeout: 120_000 }, async () => {
  const sp = await standIn();
  try {
    const consent = ago(20 * 60_000);
    // 6500 screen items within one minute (more than one read of 25 pages holds), and audio while
    // audio is off.
    const items = Array.from({ length: 6500 }, (_, i) => ({ type: 'ocr', at: ago(10 * 60_000 - i * 9), app: 'Editor', window: 'Notes', text: `BURST-${i}` }));
    for (let i = 0; i < items.length; i += 1000) await postJson(`${sp.url}/__items`, { items: items.slice(i, i + 1000) });
    await postJson(`${sp.url}/__items`, { items: [{ type: 'audio', at: ago(9 * 60_000), text: 'AUDIO-WHILE-OFF' }, { type: 'audio', at: ago(8 * 60_000), text: 'AUDIO-WHILE-OFF-2' }] });
    const r = rig(sp.port, { kinds: { screen: consent } });
    for (let i = 0; i < 20 && r.got.length < 6500; i++) await r.c.tick();
    assert.equal(r.got.length, 6500, `all 6500 sent (${r.got.length})`);
    assert.equal(new Set(r.got.map((g) => g.id)).size, 6500, 'each once');
    assert.ok(!r.got.some((g) => g.kind === 'audio'), 'audio is off: never sent');
    // In sequence order, as captured.
    const seqs = r.got.map((g) => g.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    // What was captured while audio was off is gone from the program's own store.
    const left = (await getJson(`${sp.url}/__items`)).body.ids as number[];
    assert.equal(left.length, 6500, 'the two audio items were deleted on the device');
    // Reported late: an item stamped two minutes ago, added now, is still taken.
    await postJson(`${sp.url}/__items`, { items: [{ type: 'ocr', at: ago(2 * 60_000), app: 'Editor', window: 'Notes', text: 'LATE-ITEM' }] });
    await r.c.tick();
    assert.ok(r.got.some((g) => g.text === 'LATE-ITEM'));
    assert.equal(r.got.length, 6501);
    // Ticks with nothing new send nothing new.
    await r.c.tick(); await r.c.tick();
    assert.equal(r.got.length, 6501);
  } finally { sp.proc.kill('SIGKILL'); }
});

test('a full queue pauses and says so; nothing is lost, and nothing is sent twice, once there is room', { timeout: 60_000 }, async () => {
  const sp = await standIn();
  try {
    await postJson(`${sp.url}/__items`, { items: Array.from({ length: 250 }, (_, i) => ({ type: 'ocr', at: ago(5 * 60_000 - i * 100), text: `Q-${i}` })) });
    const r = rig(sp.port, { kinds: { screen: ago(30 * 60_000) }, maxQueue: 100, sync: false });
    await r.c.tick();
    await r.c.tick();
    const st = r.c.status();
    assert.equal(st.queued, 100, 'the queue holds its maximum');
    assert.match(st.paused ?? '', /The capture queue is full \(100 items waiting for the hub\), so taking more is paused\. Nothing is lost/);
    assert.equal(r.got.length, 0, 'nothing sent while sync isn’t allowed');
    r.allow();
    for (let i = 0; i < 10 && r.got.length < 250; i++) await r.c.tick();
    assert.equal(r.got.length, 250);
    assert.equal(new Set(r.got.map((g) => g.text)).size, 250, 'each once');
    assert.equal(r.c.status().queued, 0);
  } finally { sp.proc.kill('SIGKILL'); }
});
