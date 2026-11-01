// Native workloads, the hub's side (M10h; the orchestration ADR Points 5, 6(a) and 9): where a workload
// may go, and what the hub hands a device. Containers only on Linux nodes (and, with no K3s driver, on
// no device yet); native programs onto any enrolled device whose roles allow them; never a thin
// client; capture only onto a capture source; no credential to a spoke. The manifest is signed by the
// hub for that device alone, the program served exactly as published (Screenpipe is never re-signed),
// promotion at its tier, and what the device reports becomes the status. Stand-in devices labelled
// Linux, macOS and Windows; temp homes and loopback only. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenpipeDefinition, sha256Hex, verifyDeviceSignature, workloadManifestMessage, type ServiceDefinition,
} from '../../src/core/index.ts';
import { verifyWorkload } from '../../src/device/workloads.ts';
import { call, enroll, hub } from './mesh-support.ts';
import { STAND_IN_NAME, standInBytes, standInSha, standInUrl } from '../support/workloads.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const program = (plats: string[], command = ['node', STAND_IN_NAME]) => Object.fromEntries(plats.map((p) => [p, { url: standInUrl(), sha256: standInSha(), command }]));
const ALL = ['linux-x64', 'darwin-arm64', 'win32-x64'];

function service(o: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    service: 'stand-in', version: '1.0.0', artifact: { program: program(ALL) }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 },
    contract_tests: [], alongside: 'none', placement: { mode: 'preferred', roles: ['general-server'] }, secrets: [], egress: 'none', os_permissions: [], ...o,
  };
}

async function rig() {
  const h = await hub();
  const join = async (name: string, platform: string, purposes: string[], kind = 'computer') => {
    const { dev, token } = await enroll(h, { name, kind, platform, capabilities: ['heartbeat'], purposes });
    if (kind === 'computer') assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'] }, bearer(token))).status, 200);
    return { id: dev.deviceId, token, keys: dev.keys, name };
  };
  const linux = await join('Linux box', 'linux x64', ['general-server', 'capture-source']);
  const mac = await join('Test Mac', 'darwin arm64', ['general-server', 'capture-source']);
  const win = await join('Windows box', 'win32 x64', ['general-server']);
  const phone = await join('Phone', 'ios', ['thin-client'], 'phone');
  const deploy = (definition: unknown, confirm?: string) => h.c('POST', '/services/devices/deploy', { definition, ...(confirm ? { confirm } : {}) });
  const heartbeat = (token: string, body: Record<string, unknown> = {}) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], ...body }, bearer(token));
  return { h, linux, mac, win, phone, deploy, heartbeat };
}

test('placement: containers only on Linux and on no device without K3s; native onto any device whose roles allow; never a thin client; no secrets to a spoke', async () => {
  const r = await rig();
  try {
    const image = { image: `registry.example/stand-in@sha256:${'a'.repeat(64)}` };
    // An image-only service pinned to the Mac or the Windows box: refused, containers run only on Linux.
    for (const d of [r.mac, r.win]) {
      const res = await r.deploy(service({ artifact: image, placement: { mode: 'pinned', device: d.id } }));
      assert.equal(res.status >= 400, true);
      assert.match(JSON.stringify(res.body), /containers run only on Linux/, d.name);
    }
    // On Linux it is still refused: containers on devices need the K3s driver, not built yet.
    const lin = await r.deploy(service({ artifact: image, placement: { mode: 'pinned', device: r.linux.id } }));
    assert.match(lin.body.error, /Containers run only on Linux, and on devices only with the K3s driver, which isn’t built yet \(M10j\)/);
    // A native program goes to each of Linux, macOS and Windows when its roles allow.
    for (const d of [r.linux, r.mac, r.win]) {
      const res = await r.deploy(service({ placement: { mode: 'pinned', device: d.id, roles: ['general-server'] } }), 'stand-in@1.0.0');
      assert.equal(res.status, 200, `${d.name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.device.id, d.id);
      assert.match(res.body.said, new RegExp(`Sent stand-in 1\\.0\\.0 to ${d.name}: its device agent installs it, checks it, and reports\\. Nothing takes traffic until you promote it`));
    }
    // No program for its platform: refused.
    const noWin = await r.deploy(service({ version: '1.0.1', artifact: { program: program(['linux-x64']) }, placement: { mode: 'pinned', device: r.win.id } }));
    assert.match(noWin.body.error, /Windows box is win32-x64, and there is no program for it/);
    // A thin client never: the resolver refuses it before any device is told.
    const thin = await r.deploy(service({ placement: { mode: 'pinned', device: r.phone.id } }));
    assert.match(thin.body.error, /Phone is a phone: a thin client, which never receives workloads/);
    // Secrets to a spoke: refused, with why (the vault broker isn't built).
    const secret = await r.deploy(service({ version: '1.0.2', secrets: ['secret://services/stand-in/TOKEN'], placement: { mode: 'pinned', device: r.linux.id } }));
    assert.match(secret.body.error, /No credential goes to another device yet: that needs the vault broker, which isn’t built/);
    // A program at a web address: Nova downloads none in this build.
    const web = await r.deploy(service({ version: '1.0.3', artifact: { program: { 'linux-x64': { url: `https://downloads.example/${STAND_IN_NAME}`, sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, placement: { mode: 'pinned', device: r.linux.id } }));
    assert.match(web.body.error, /Its program is at a web address\. In this build the hub serves only a program from a file on this computer/);
    // Nothing was assigned to the phone, and what was refused reached no device.
    const phoneHb = await r.heartbeat(r.phone.token);
    assert.deepEqual(phoneHb.body.workloads ?? [], []);
  } finally { await r.h.stop(); }
});

test('capture only onto a capture source: the validator, the resolver and the device each hold it', async () => {
  const r = await rig();
  try {
    const sp = (device: string, version = '1.0.0') => ({ ...screenpipeDefinition({ version, device, program: program(ALL) }), ports: [{ name: 'api', port: 18791 }] });
    // A capture permission placed by another role: the validator refuses it.
    const bad = await r.deploy({ ...sp(r.linux.id), placement: { mode: 'pinned', device: r.linux.id, roles: ['general-server'] } });
    assert.match(JSON.stringify(bad.body), /it captures: its placement.roles must include capture-source/);
    // The Windows box isn't a capture source: refused.
    const win = await r.deploy(sp(r.win.id));
    assert.match(JSON.stringify(win.body), /Windows box isn’t capture source|No device .* has the roles it asks for/);
    // The Mac is: deploying asks at tier 3 (OS permissions), typed.
    const ask = await r.deploy(sp(r.mac.id));
    assert.equal(ask.status, 400);
    assert.match(ask.body.error, /asks first \(tier 3\): type screenpipe@1\.0\.0/);
    const ok = await r.deploy(sp(r.mac.id), 'screenpipe@1.0.0');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.said, /capture stays off until you turn on one of its sources/);
    // Deploying turned no capture on: no source of the Mac is on.
    const cap = await r.h.c('GET', '/capture');
    assert.ok(!cap.body.sources.some((s: { device: string | null; enabled: boolean }) => s.enabled), 'nothing is capturing');
    // The device's own check: the manifest's roles against a device that isn't a capture source.
    const hb = await r.heartbeat(r.mac.token);
    assert.equal(hb.body.workloads[0].capture, true);
    const signed = (await call(r.h.mesh, 'GET', '/api/v1/mesh/workloads/screenpipe/1.0.0', undefined, bearer(r.mac.token))).body;
    const v = verifyWorkload(signed, { pinned: [r.h.core.mesh.identity.publicKey], deviceId: r.mac.id, platform: 'darwin-arm64', purposes: ['general-server'] });
    assert.ok(!v.ok && /needs capture-source, which this device isn’t/.test(v.reason));
  } finally { await r.h.stop(); }
});

test('a device gets only its own manifest, signed by the hub, and the program exactly as published (not re-signed)', async () => {
  const r = await rig();
  try {
    const def = { ...screenpipeDefinition({ version: '1.0.0', device: r.mac.id, program: program(ALL) }), ports: [{ name: 'api', port: 18792 }] };
    assert.equal((await r.deploy(def, 'screenpipe@1.0.0')).status, 200);
    const got = await call(r.h.mesh, 'GET', '/api/v1/mesh/workloads/screenpipe/1.0.0', undefined, bearer(r.mac.token));
    assert.equal(got.status, 200);
    const s = got.body;
    assert.equal(s.signer, r.h.core.mesh.identity.publicKey, 'signed by the hub’s own key');
    assert.ok(verifyDeviceSignature(s.signer, workloadManifestMessage(s.manifest), s.signature));
    assert.deepEqual(
      { device: s.manifest.device_id, platform: s.manifest.platform, files: s.manifest.files, command: s.manifest.command, roles: s.manifest.roles, capture: s.manifest.capture, alongside: s.manifest.alongside },
      { device: r.mac.id, platform: 'darwin-arm64', files: { [STAND_IN_NAME]: standInSha() }, command: ['node', STAND_IN_NAME], roles: ['capture-source'], capture: { adapter: 'screenpipe', kinds: ['screen', 'audio'] }, alongside: 'none' },
    );
    assert.equal(verifyWorkload(s, { pinned: [r.h.core.mesh.identity.publicKey], deviceId: r.mac.id, platform: 'darwin-arm64', purposes: ['capture-source'] }).ok, true);
    // The program: byte for byte the artifact the definition pins (the publisher's own file).
    const res = await fetch(`${r.h.mesh}/api/v1/mesh/workloads/screenpipe/1.0.0/file/${STAND_IN_NAME}`, { headers: bearer(r.mac.token) });
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(bytes, standInBytes());
    assert.equal(sha256Hex(bytes), standInSha());
    // Another device: nothing, neither the manifest nor the file.
    assert.equal((await call(r.h.mesh, 'GET', '/api/v1/mesh/workloads/screenpipe/1.0.0', undefined, bearer(r.linux.token))).status, 404);
    assert.equal((await fetch(`${r.h.mesh}/api/v1/mesh/workloads/screenpipe/1.0.0/file/${STAND_IN_NAME}`, { headers: bearer(r.linux.token) })).status, 404);
    // Not a version it was assigned, not a file its manifest pins.
    assert.equal((await call(r.h.mesh, 'GET', '/api/v1/mesh/workloads/screenpipe/0.9.0', undefined, bearer(r.mac.token))).status, 404);
    assert.equal((await fetch(`${r.h.mesh}/api/v1/mesh/workloads/screenpipe/1.0.0/file/..%2F..%2Fmesh%2Fidentity.json`, { headers: bearer(r.mac.token) })).status, 404);
    // Without a device session: no.
    assert.equal((await call(r.h.mesh, 'GET', '/api/v1/mesh/workloads/screenpipe/1.0.0')).status, 401);
  } finally { await r.h.stop(); }
});

test('promotion only once the device reports it ready, at its tier; a device that goes back by itself is followed and said', async () => {
  const r = await rig();
  try {
    const def = (version: string) => ({ ...screenpipeDefinition({ version, device: r.mac.id, program: program(ALL) }), ports: [{ name: 'api', port: 18793 }] });
    assert.equal((await r.deploy(def('1.0.0'), 'screenpipe@1.0.0')).status, 200);
    const promote = (version: string, confirm?: string) => r.h.c('POST', `/services/devices/${r.mac.id}/screenpipe/promote`, { version, ...(confirm ? { confirm } : {}) });
    // Not ready until the device says so.
    const early = await promote('1.0.0', 'screenpipe@1.0.0');
    assert.equal(early.status, 409);
    assert.match(early.body.error, /isn’t ready to promote .* Only a version that passed its contract tests and health takes traffic/);
    const hb = await r.heartbeat(r.mac.token, { workloads: [{ service: 'screenpipe', version: '1.0.0', status: 'ready', health: null, since: new Date(r.h.clock.t).toISOString(), said: 'Installed and checked.' }] });
    assert.deepEqual(hb.body.workloads.map((w: { version: string; want: string }) => [w.version, w.want]), [['1.0.0', 'alongside']]);
    // Tier 3 every time: it captures.
    const ask = await promote('1.0.0');
    assert.equal(ask.status, 400);
    assert.match(ask.body.error, /tier 3.*type screenpipe@1\.0\.0/);
    const ok = await promote('1.0.0', 'screenpipe@1.0.0');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.said, /Promoting doesn’t turn it on|promoting doesn’t turn it on/);
    assert.equal((await r.heartbeat(r.mac.token)).body.workloads[0].want, 'live');
    await r.heartbeat(r.mac.token, { workloads: [{ service: 'screenpipe', version: '1.0.0', status: 'live', health: true, since: new Date(r.h.clock.t).toISOString(), said: 'Switched.' }] });

    // 2.0.0, deployed and promoted; the device reports it failed and went back by itself.
    assert.equal((await r.deploy(def('2.0.0'))).status, 200, 'the same command as the approved version: no ask');
    await r.heartbeat(r.mac.token, { workloads: [{ service: 'screenpipe', version: '2.0.0', status: 'ready', health: null, since: new Date(r.h.clock.t).toISOString(), said: 'Installed.' }] });
    assert.equal((await promote('2.0.0', 'screenpipe@2.0.0')).status, 200);
    const a = (await r.heartbeat(r.mac.token)).body.workloads[0];
    assert.deepEqual([a.version, a.want, a.previous], ['2.0.0', 'live', '1.0.0']);
    await r.heartbeat(r.mac.token, { workloads: [
      { service: 'screenpipe', version: '2.0.0', status: 'rolled_back', health: false, since: new Date(r.h.clock.t).toISOString(), said: 'Its health failed after it was switched to, so the device went back to 1.0.0 by itself.' },
      { service: 'screenpipe', version: '1.0.0', status: 'live', health: true, since: new Date(r.h.clock.t).toISOString(), said: 'Live again.' },
    ] });
    const after = (await r.heartbeat(r.mac.token)).body.workloads[0];
    assert.deepEqual([after.version, after.want], ['1.0.0', 'live'], 'the assignment follows the device back');
    const st = (await r.h.c('GET', '/services/devices')).body.services.find((s: { service: string }) => s.service === 'screenpipe');
    assert.equal(st.live, '1.0.0');
    assert.equal(st.device.name, 'Test Mac');
    assert.ok(st.history.some((x: { outcome: string; version: string }) => x.outcome === 'rolled_back' && x.version === '2.0.0'));
    const problems = (await r.h.c('GET', '/problems')).body;
    assert.ok(JSON.stringify(problems).includes('failed its health on Test Mac after it was switched to, so the device went back to 1.0.0 by itself'));
    // A device can't report on a service it wasn't assigned.
    await r.heartbeat(r.linux.token, { workloads: [{ service: 'screenpipe', version: '9.9.9', status: 'live', health: true, since: new Date(r.h.clock.t).toISOString(), said: 'made up' }] });
    assert.ok(!(await r.h.c('GET', '/services/devices')).body.services.some((s: { device: { id: string } }) => s.device.id === r.linux.id));
    // Rollback asked for: tier 2, typed; one step, nothing to download.
    assert.equal((await r.h.c('POST', `/services/devices/${r.mac.id}/screenpipe/rollback`, {})).status, 400);
  } finally { await r.h.stop(); }
});
