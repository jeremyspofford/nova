// M10h's pilot, end to end (the orchestration ADR Point 6, Decision 4, and the capture data path's gate
// list): Screenpipe's definition, on the stand-in, deployed by a real hub to three real device agents
// (boot agent, sandboxed runtime child) labelled Linux, macOS and Windows, each joined by the real
// pairing flow. Deploying it turns no capture on; promoting it is tier 3; the bytes installed are the
// artifact's; once the person turns a source on, derived capture syncs, dedupes, survives the hub
// going away and coming back without loss or duplication; a forget reaches the device and waits for
// its acknowledgement; a raw fetch is a ledger task with its reason; a signed update switches, and a
// failing one goes back by itself. Temp homes, 127.0.0.1 only, no real Screenpipe anywhere: the
// artifact is scripts/stand-ins/stand-in-screenpipe.js. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, screenpipeDefinition, type Core, type Listener } from '../../src/core/index.ts';
import { Boot, joinHub } from '../../src/device/boot.ts';
import { STAND_IN, STAND_IN_NAME, freePort, getJson, postJson, standInBytes, standInSha, standInUrl } from '../support/workloads.ts';
import { call } from '../core/mesh-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(100); v = await read(); }
  return v;
}

// A hub whose mesh listener can go away and come back on the same port (the hub unreachable).
async function startHub() {
  const home = mkdtempSync(join(tmpdir(), 'nova-m10h-hub-'));
  const meshPort = await freePort();
  const publicUrl = `http://127.0.0.1:${meshPort}`;
  const core: Core = createCore({ home, version: '0.1.0', trustedOrigin: (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h), mesh: { publicUrl, transport: 'network' }, captureRawWaitMs: 20_000 });
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, listener);
    if (!p) return;
    if (await core.handle(req, res, url, p, listener)) return;
    res.writeHead(404); res.end();
  };
  const consoleServer = createServer(handler('console'));
  await new Promise<void>((r) => consoleServer.listen(0, '127.0.0.1', r));
  const consoleBase = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
  let mesh: Server | null = null;
  const up = async () => { mesh = createServer(handler('mesh')); await new Promise<void>((r) => mesh!.listen(meshPort, '127.0.0.1', r)); };
  const down = async () => { const s = mesh; mesh = null; if (!s) return; s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); };
  await up();
  return {
    core, home, mesh: publicUrl, up, down,
    c: (method: string, path: string, body?: unknown) => call(consoleBase, method, `/api/v1${path}`, body),
    async stop() { await down(); consoleServer.closeAllConnections(); consoleServer.close(); await core.close(); },
  };
}

type Hub = Awaited<ReturnType<typeof startHub>>;

// A computer joins the way a person joins one: a code from the hub, the device's own keys, the six
// digits, the approval on the hub (with the roles asked for), then its boot agent runs.
async function joinDevice(h: Hub, name: string, platform: string, roles: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'nova-m10h-device-'));
  const env = { NOVA_DEVICE_PLATFORM: platform, NOVA_DEVICE_HEARTBEAT_MS: '200', NOVA_DEVICE_TICK_MS: '150', NOVA_DEVICE_RETRY_MS: '200', NOVA_DEVICE_BACKOFF_MS: '50', TZ: 'UTC' };
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const joining = joinHub(home, { hub: h.mesh, code, name, roles, pollMs: 100, say: () => {} }, env);
  const req = await until(async () => ((await h.c('GET', '/mesh/requests')).body as { id: string; claims?: { name?: string }; name?: string }[]).find((r) => (r.claims?.name ?? r.name) === name), Boolean, 20_000);
  assert.ok(req, `no request for ${name}`);
  const ok = await h.c('POST', `/mesh/requests/${req!.id}/approve`, { confirm: true, purposes: roles });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const d = await joining;
  const lines: string[] = [];
  const boot = new Boot(home, env, { say: (l) => lines.push(l) });
  await boot.start({ signals: false });
  return { id: d.device_id, name, home, boot, lines, platform };
}

// Nothing of the workload runs on that device: its agent runs no copy, and no stand-in answers on its
// port (another program on this machine may hold a port nobody is using, so the agent's own word counts).
async function nothingRuns(d: { name: string; boot: Boot }, port: number): Promise<void> {
  assert.deepEqual(d.boot.workloads.state().flatMap((s) => s.running), [], `${d.name}: nothing started`);
  const h = await getJson(`http://127.0.0.1:${port}/health`);
  assert.ok(h.status === 0 || h.body?.version === undefined, `${d.name}: no stand-in answers on its port`);
}

const devicesOf = async (h: Hub) => (await h.c('GET', '/mesh/devices')).body as { id: string; online: boolean; purposes: string[] }[];
const status = async (h: Hub, deviceId: string, service = 'screenpipe') => ((await h.c('GET', '/services/devices')).body.services as { service: string; device: { id: string }; live: string | null; versions: { version: string; status: string; said: string | null }[] }[]).find((s) => s.service === service && s.device.id === deviceId);
const versionOf = async (h: Hub, deviceId: string, version: string) => (await status(h, deviceId))?.versions.find((v) => v.version === version);
const events = async (h: Hub) => ((await h.c('GET', '/capture/events?limit=500')).body.events ?? (await h.c('GET', '/capture/events?limit=500')).body) as { id: string; text: string; kind: string; device: { id: string }; provenance: { external_id: string; transfer: Record<string, unknown> | null } }[];

test('M10h pilot: Screenpipe (stand-in) on Linux, macOS and Windows stand-ins: consent stays off, tier 3, sync, offline resume, tombstones, raw fetch, update and rollback', { timeout: 300_000 }, async () => {
  const h = await startHub();
  const devices: Awaited<ReturnType<typeof joinDevice>>[] = [];
  try {
    const linux = await joinDevice(h, 'Linux box', 'linux-x64', ['capture-source']);
    const mac = await joinDevice(h, 'Test Mac', 'darwin-arm64', ['capture-source']);
    const win = await joinDevice(h, 'Windows box', 'win32-x64', ['capture-source']);
    devices.push(linux, mac, win);
    await until(() => devicesOf(h), (ds) => [linux, mac, win].every((d) => ds.find((x) => x.id === d.id)?.online), 30_000);

    // 1. Deploy Screenpipe's definition to each: every platform's program is the stand-in, pinned by
    //    its SHA-256 (the publisher's file in a real deployment; the build installs no real Screenpipe).
    const ports = { [linux.id]: await freePort(), [mac.id]: await freePort(), [win.id]: await freePort() };
    const program = (command = ['node', STAND_IN_NAME]) => Object.fromEntries(['linux-x64', 'darwin-arm64', 'win32-x64'].map((p) => [p, { url: standInUrl(), sha256: standInSha(), command }]));
    const def = (d: { id: string }, version: string, command?: string[]) => ({ ...screenpipeDefinition({ version, device: d.id, program: program(command) }), ports: [{ name: 'api', port: ports[d.id]! }] });
    assert.ok(STAND_IN.endsWith('scripts/stand-ins/stand-in-screenpipe.js'), 'the artifact is the stand-in');
    for (const d of [linux, mac, win]) {
      const ask = await h.c('POST', '/services/devices/deploy', { definition: def(d, '1.0.0') });
      assert.equal(ask.status, 400);
      assert.match(ask.body.error, /asks first \(tier 3\): type screenpipe@1\.0\.0/);
      const ok = await h.c('POST', '/services/devices/deploy', { definition: def(d, '1.0.0'), confirm: 'screenpipe@1.0.0' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    }
    for (const d of [linux, mac, win]) {
      const v = await until(() => versionOf(h, d.id, '1.0.0'), (x) => x?.status === 'ready', 60_000);
      assert.equal(v?.status, 'ready', `${d.name}: ${JSON.stringify(v)}\n${d.lines.join('\n')}`);
      // Installed exactly as published: the same bytes, never signed again by Nova.
      assert.deepEqual(readFileSync(join(d.home, 'workloads', 'screenpipe', 'v', '1.0.0', STAND_IN_NAME)), standInBytes(), d.name);
      const m = JSON.parse(readFileSync(join(d.home, 'workloads', 'screenpipe', 'v', '1.0.0', 'manifest.json'), 'utf8'));
      assert.equal(m.manifest.platform, d.platform);
      assert.equal(m.manifest.files[STAND_IN_NAME], standInSha());
    }
    // 2. Deploying turned no capture on: its sources are listed, every one off; nothing runs.
    const sources = async () => ((await h.c('GET', '/capture')).body.sources as { id: string; device: string | null; enabled: boolean }[]);
    const listed = await until(sources, (s) => [linux, mac, win].every((d) => s.some((x) => x.id === `device:${d.id}:screen`)), 20_000);
    assert.ok(listed.every((s) => !s.enabled), 'consent off throughout deployment');
    for (const d of [linux, mac, win]) await nothingRuns(d, ports[d.id]!);

    // 3. Promote on the Mac: tier 3, typed. It goes live, but capture is still off there, so it isn't started.
    const promote = (d: { id: string }, version: string, confirm?: string) => h.c('POST', `/services/devices/${d.id}/screenpipe/promote`, { version, ...(confirm ? { confirm } : {}) });
    assert.match((await promote(mac, '1.0.0')).body.error, /tier 3/);
    assert.equal((await promote(mac, '1.0.0', 'screenpipe@1.0.0')).status, 200);
    const live = await until(() => versionOf(h, mac.id, '1.0.0'), (x) => x?.status === 'live', 30_000);
    assert.match(live!.said ?? '', /capture is off on this device/);
    await nothingRuns(mac, ports[mac.id]!);

    // 4. The person turns on the Mac's screen source (audio stays off). Now it starts, and derived
    //    capture syncs: private windows and audio never leave the Mac.
    assert.equal((await h.c('POST', `/capture/sources/${encodeURIComponent(`device:${mac.id}:screen`)}/enable`)).status, 200);
    const sp = `http://127.0.0.1:${ports[mac.id]}`;
    assert.equal((await until(() => getJson(`${sp}/health`), (r) => r.status === 200, 30_000)).body.version, '1.0.0', mac.lines.join('\n'));
    await sleep(300);
    const now = () => new Date().toISOString();
    await postJson(`${sp}/__items`, { items: [
      { type: 'ocr', at: now(), app: 'Editor', window: 'Notes', text: 'PILOT-ONE: the test lamp is in the hall.', raw: 'stand-in frame one' },
      { type: 'ocr', at: now(), app: 'Browser', window: 'Private', text: 'PILOT-PRIVATE', private: true },
      { type: 'audio', at: now(), text: 'PILOT-AUDIO-OFF' },
    ] });
    const one = await until(() => events(h), (es) => es.some((e) => e.text === 'PILOT-ONE: the test lamp is in the hall.'), 30_000);
    const e1 = one.find((e) => e.text === 'PILOT-ONE: the test lamp is in the hall.')!;
    assert.equal(e1.device.id, mac.id);
    assert.equal(e1.provenance.transfer?.device_name, 'Test Mac');
    assert.equal(e1.provenance.transfer?.source, 'screenpipe-adapter');
    await sleep(1000);
    assert.ok(!JSON.stringify(await events(h)).includes('PILOT-PRIVATE'), 'a private window never left the device');
    assert.ok(!JSON.stringify(await events(h)).includes('PILOT-AUDIO-OFF'), 'audio is off');

    // 5. The hub goes away. Capture keeps working on the Mac and queues; the hub comes back; every
    //    item arrives once.
    await h.down();
    const offline = Array.from({ length: 12 }, (_, i) => `PILOT-OFFLINE-${i}`);
    await postJson(`${sp}/__items`, { items: offline.map((text) => ({ type: 'ocr', at: now(), app: 'Editor', window: 'Notes', text })) });
    await until(() => mac.boot.carrier.status().queued, (n) => n >= offline.length, 20_000);
    assert.ok(mac.boot.carrier.status().queued >= offline.length, 'queued on the Mac while the hub is away');
    await h.up();
    const back = await until(() => events(h), (es) => offline.every((t) => es.some((e) => e.text === t)), 60_000);
    for (const t of offline) assert.equal(back.filter((e) => e.text === t).length, 1, `${t} arrived exactly once`);
    assert.equal((await until(() => mac.boot.carrier.status().queued, (n) => n === 0, 20_000)), 0);
    const lag = ((await h.c('GET', '/capture/devices')).body.devices as { device_id: string; said: string }[]).find((d) => d.device_id === mac.id)!;
    assert.match(lag.said, /^Test Mac capture: synced to \d\d:\d\d · 0 queued$/);

    // 6. A forget reaches the Mac: deleted there (from Screenpipe's own store), acknowledged, then
    //    "deleted everywhere".
    const target = back.find((e) => e.text === 'PILOT-OFFLINE-3')!;
    const nativeId = Number(target.provenance.external_id.split(':').pop());
    assert.ok((await getJson(`${sp}/__items`)).body.ids.includes(nativeId));
    const f = await h.c('DELETE', `/capture/events/${target.id}`);
    assert.equal(f.body.everywhere, false);
    assert.match(f.body.said, /Waiting for Test Mac to confirm/);
    const confirmed = await until(async () => (await h.c('GET', '/capture/forgets')).body.forgets[0], (x) => !!x?.acknowledged_at, 30_000);
    assert.match(confirmed.said, /Deleted on Test Mac too \(it confirmed\)/);
    assert.ok(!(await getJson(`${sp}/__items`)).body.ids.includes(nativeId), 'gone from the Mac’s capture store too');

    // 7. A raw fetch: a ledger task naming the item and the reason; the original arrives signed and checked.
    const asked = await h.c('POST', `/capture/events/${e1.id}/raw`, { reason: 'To check what the frame showed.' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.match(asked.body.task.brief.goal, /because: To check what the frame showed\./);
    const task = await until(async () => (await h.c('GET', `/tasks/${asked.body.task.id}`)).body, (t) => t.state === 'done', 40_000);
    assert.equal(task.state, 'done', JSON.stringify(task));
    const fetchId = asked.body.task.brief.inputs.fetch_id;
    assert.equal(Buffer.from((await h.c('GET', `/capture/raw/${fetchId}`)).body.data, 'base64').toString(), 'stand-in frame one');

    // 8. A signed update on the Mac: same command, no ask; ready, promoted at tier 3, live; 1.0.0 kept.
    //    Screenpipe's store carries over (it is the service's, not the version's).
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: def(mac, '1.1.0') })).status, 200);
    await until(() => versionOf(h, mac.id, '1.1.0'), (x) => x?.status === 'ready', 60_000);
    assert.equal((await promote(mac, '1.1.0', 'screenpipe@1.1.0')).status, 200);
    assert.equal((await until(() => getJson(`${sp}/health`), (r) => r.body?.version === '1.1.0', 30_000)).body.version, '1.1.0');
    assert.equal((await until(() => versionOf(h, mac.id, '1.0.0'), (x) => x?.status === 'kept', 20_000))?.status, 'kept');
    assert.ok((await getJson(`${sp}/__items`)).body.ids.length >= offline.length, 'its store carried over');
    // A failing update (a changed command asks again, typed): switched to, unhealthy, back to 1.1.0 by itself.
    const sick = def(mac, '1.2.0', ['node', STAND_IN_NAME, '--sick']);
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: sick })).status, 400);
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: sick, confirm: 'screenpipe@1.2.0' })).status, 200);
    await until(() => versionOf(h, mac.id, '1.2.0'), (x) => x?.status === 'ready', 60_000);
    assert.equal((await promote(mac, '1.2.0', 'screenpipe@1.2.0')).status, 200);
    const rolled = await until(() => versionOf(h, mac.id, '1.2.0'), (x) => x?.status === 'rolled_back', 60_000);
    assert.equal(rolled?.status, 'rolled_back', mac.lines.join('\n'));
    assert.equal((await until(() => getJson(`${sp}/health`), (r) => r.body?.version === '1.1.0', 30_000)).body.version, '1.1.0');
    assert.equal((await status(h, mac.id))?.live, '1.1.0');
    // Still syncing after all that.
    await postJson(`${sp}/__items`, { items: [{ type: 'ocr', at: now(), app: 'Editor', window: 'Notes', text: 'PILOT-AFTER-ROLLBACK' }] });
    await until(() => events(h), (es) => es.some((e) => e.text === 'PILOT-AFTER-ROLLBACK'), 30_000);

    // 9. Linux and Windows never had capture turned on: nothing started there, nothing synced from them.
    for (const d of [linux, win]) {
      await nothingRuns(d, ports[d.id]!);
      assert.ok(!(await events(h)).some((e) => e.device.id === d.id), `${d.name}: nothing synced`);
      assert.deepEqual(readdirSync(join(d.home, 'capture', 'outbox')), []);
    }
    assert.ok(((await sources()).filter((s) => s.enabled).map((s) => s.id)).every((id) => id === `device:${mac.id}:screen`), 'only the source the person turned on is on');
  } finally {
    for (const d of devices) await d.boot.shutdown(0).catch(() => {});
    await h.stop();
  }
});
