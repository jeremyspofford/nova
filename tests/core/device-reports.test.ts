// A paired device may be buggy or compromised, so the hub doesn't trust its words: every report it
// sends (a heartbeat's versions and hardware, its workloads' `said` for any service, a problem it
// reports, why its capture waits, a capture batch's source) and the name and platform it joins with
// are kept as one bounded line, without terminal escapes, control characters or the format
// characters that make text read backwards. An honest device's messages come through unchanged.
// A real core on loopback; devices enroll the way the plan says. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureBatchMessage, captureItemDigest, signMessage, type CaptureBatchManifest, type ServiceDefinition } from '../../src/core/index.ts';
import { call, enroll, hub } from './mesh-support.ts';
import { STAND_IN_NAME, standInSha, standInUrl } from '../support/workloads.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// An OSC title, SGR colours, a right-to-left override and its pop, NUL, CR LF, a bidi isolate, a
// zero-width space: what a hostile device would put in front of a person.
const HOSTILE = '\u001b]0;pwned\u0007\u001b[31mred\u001b[0m \u202eevil\u202c\u0000nul\r\nnext \u2066iso\u2069 \u200bzw';
const CLEANED = 'red evil nul next iso zw';
// Close to the API's 1 MB body limit (a larger body is refused before any handler reads it).
const HUGE = `${HOSTILE} ${'x'.repeat(900_000)}`;
const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]|\[\d*m|\]0;/u;
const clean = (s: unknown, max: number, what: string) => {
  assert.equal(typeof s, 'string', what);
  assert.doesNotMatch(s as string, BAD, `${what}: no escapes, control or format characters`);
  assert.ok((s as string).length <= max, `${what}: at most ${max} characters, not ${(s as string).length}`);
};

async function computer() {
  const h = await hub();
  const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
  const view = async () => (await h.c('GET', '/mesh/devices')).body.find((d: { id: string }) => d.id === dev.deviceId);
  const beat = (body: Record<string, unknown>) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', body, bearer(token));
  return { h, dev, token, view, beat };
}

test('a heartbeat’s versions are kept clean and bounded; honest ones unchanged', async () => {
  const { h, view, beat } = await computer();
  try {
    // Honest: exactly as sent.
    assert.equal((await beat({ version: '0.1.0', runtime_version: '0.1.0+abc123def456' })).status, 200);
    assert.equal((await view()).agent.version, '0.1.0');
    assert.equal((await view()).agent.runtime_version, '0.1.0+abc123def456');
    // Hostile.
    const r = await beat({ version: HUGE, runtime_version: HOSTILE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await view();
    clean(v.agent.version, 80, 'version');
    assert.ok(v.agent.version.startsWith(CLEANED), v.agent.version);
    clean(v.agent.runtime_version, 80, 'runtime_version');
    assert.equal(v.agent.runtime_version, CLEANED);
  } finally {
    await h.stop();
  }
});

test('the hardware a heartbeat reports is kept clean and bounded; honest names unchanged', async () => {
  const { h, dev, beat } = await computer();
  try {
    const hardware = (name: string) => ({ platform: 'linux', arch: 'x64', ram_bytes: 16 * 1024 ** 3, cpu: { model: name, threads: 8 }, gpus: [{ vendor: 'nvidia', name: `${name} GPU`, vram_bytes: 8 * 1024 ** 3 }] });
    const stored = () => {
      const db = new DatabaseSync(join(h.home, 'nova.db'), { readOnly: true });
      try { return JSON.parse((db.prepare('SELECT hardware FROM device_hardware WHERE device_id = ?').get(dev.deviceId) as { hardware: string }).hardware); } finally { db.close(); }
    };
    assert.equal((await beat({ version: '0.1.0', hardware: hardware('Example CPU (8 cores)') })).status, 200);
    assert.equal(stored().gpus[0].name, 'Example CPU (8 cores) GPU');
    assert.equal((await beat({ version: '0.1.0', hardware: hardware(`${HOSTILE} ${'x'.repeat(400_000)}`) })).status, 200);
    const hw = stored();
    clean(hw.cpu.model, 120, 'cpu model');
    assert.ok(hw.cpu.model.startsWith(CLEANED));
    clean(hw.gpus[0].name, 120, 'gpu name');
  } finally {
    await h.stop();
  }
});

test('what a device says about a workload, for any service, is kept clean and bounded; honest words unchanged', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Linux box', platform: 'linux x64', capabilities: ['heartbeat'], purposes: ['general-server'] });
    const beat = (body: Record<string, unknown> = {}) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], ...body }, bearer(token));
    assert.equal((await beat()).status, 200);
    // Any service a person adds: a stand-in, not one the hub knows by name.
    const definition: ServiceDefinition = {
      service: 'stand-in', version: '1.0.0', artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } },
      ports: [{ name: 'api', port: 18794 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none',
      placement: { mode: 'pinned', device: dev.deviceId, roles: ['general-server'] }, secrets: [], egress: 'none', os_permissions: [],
    };
    const d = await h.c('POST', '/services/devices/deploy', { definition, confirm: 'stand-in@1.0.0' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const report = (status: string, said: string) => beat({ workloads: [{ service: 'stand-in', version: '1.0.0', status, health: null, since: new Date(h.clock.t).toISOString(), said }] });
    const status = async () => (await h.c('GET', '/services/devices')).body.services.find((s: { service: string }) => s.service === 'stand-in');

    // Honest: exactly as sent.
    const honest = 'Installed stand-in 1.0.0: signed by the hub, every file as pinned.';
    assert.equal((await report('installed', honest)).status, 200);
    let s = await status();
    assert.equal(s.versions.find((x: { version: string }) => x.version === '1.0.0').said, honest);
    assert.equal(s.history[0].said, honest);

    // Hostile: a 900 kB said with escapes, NUL, CR LF and bidi overrides.
    h.tick(1000);
    const r = await report('ready', HUGE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s = await status();
    const said = s.versions.find((x: { version: string }) => x.version === '1.0.0').said;
    clean(said, 300, 'versions[].said');
    assert.ok(said.startsWith(`${CLEANED} xxx`), said.slice(0, 60));
    clean(s.history[0].said, 300, 'history[].said');
    assert.ok(s.history[0].said.startsWith(CLEANED));
    // The topology's projection reads the same record.
    const t = await h.c('GET', '/services/topology');
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const topo = JSON.stringify(t.body);
    assert.doesNotMatch(topo, /[\u202e\u2066]|\\u0000|\\u001b|\[31m/i);
  } finally {
    await h.stop();
  }
});

test('a problem a device reports is said clean and bounded', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    const r = await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/report', { problem: 'workload_refused', detail: HUGE }, bearer(token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = (await h.c('GET', '/problems')).body.find((x: { message: string }) => /refused a workload/.test(x.message));
    assert.ok(p, 'the problem is said');
    clean(p.message, 600, 'problem message');
    assert.match(p.message, new RegExp(`refused a workload: ${CLEANED} x+ Nothing it refused was run\\.$`));
  } finally {
    await h.stop();
  }
});

async function captureDevice() {
  const h = await hub();
  const { dev, token } = await enroll(h, { name: 'Test Mac', kind: 'computer', platform: 'darwin arm64', capabilities: ['heartbeat'], purposes: ['capture-source'] });
  assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat', 'capture.screen'] }, bearer(token))).status, 200);
  return { h, dev, token };
}

test('why a device’s capture waits is kept clean and bounded', async () => {
  const { h, dev, token } = await captureDevice();
  try {
    const lag = async () => (await h.c('GET', '/capture/devices')).body.devices.find((d: { device_id: string }) => d.device_id === dev.deviceId);

    // Honest.
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/capture/status', { queued: 7, paused: 'Nova is in local-only mode.' }, bearer(token))).status, 200);
    assert.equal((await lag()).paused, 'Nova is in local-only mode.');
    // Hostile.
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/capture/status', { queued: 7, paused: HUGE }, bearer(token))).status, 200);
    const l = await lag();
    clean(l.paused, 300, 'paused');
    assert.ok(l.paused.startsWith(CLEANED));
    clean(l.said, 400, 'lag said');
  } finally {
    await h.stop();
  }
});

test('a capture batch’s source, and a device id it claims, are kept clean and bounded', async () => {
  const { h, dev, token } = await captureDevice();
  try {
    // A signed batch whose source is the device's word.
    assert.equal((await h.c('POST', `/capture/sources/${encodeURIComponent(`device:${dev.deviceId}:screen`)}/enable`)).status, 200);
    h.tick(5000);
    const item = { id: 'screenpipe:ocr:1', seq: 1, kind: 'screen', at: new Date(h.clock.t + 1000).toISOString(), ended_at: null, app: 'Editor', window_title: 'Notes', url: null, text: 'A line on the screen.' };
    const batch = (source: string, device_id = dev.deviceId) => {
      const manifest: CaptureBatchManifest = { v: 1, batch_id: randomUUID(), device_id, device_name: 'Test Mac', source, seq_from: 1, seq_to: 1, items: [{ id: item.id, seq: 1, sha256: captureItemDigest(item) }], queued: 0, sent_at: item.at };
      return { manifest, signature: signMessage(dev.keys.ed25519.privateKey, captureBatchMessage(manifest)), items: [item] };
    };
    const res = await call(h.mesh, 'POST', '/api/v1/mesh/capture/batch', batch(HOSTILE), bearer(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.results[0].status, 'kept');
    const got = (await h.c('GET', '/capture/events?limit=50')).body;
    const ev = ((got.events ?? got) as { text: string; provenance: { transfer: { source: string } } }[]).find((e) => e.text === 'A line on the screen.')!;
    clean(ev.provenance.transfer.source, 40, 'source');
    assert.equal(ev.provenance.transfer.source, CLEANED);
    // A manifest naming a device Nova doesn't know: refused, and the problem doesn't repeat its escapes.
    const bad = await call(h.mesh, 'POST', '/api/v1/mesh/capture/batch', batch('screenpipe-adapter', `${HOSTILE}${'y'.repeat(5000)}`), bearer(token));
    assert.equal(bad.status, 403);
    const p = (await h.c('GET', '/problems')).body.find((x: { message: string }) => /names a device Nova doesn’t know/.test(x.message));
    assert.ok(p);
    clean(p.message, 400, 'refusal problem');
    assert.match(p.message, new RegExp(`\\(${CLEANED}`));
  } finally {
    await h.stop();
  }
});

test('the name and platform a device joins with are one plain line: no bidi override, escape or control character', async () => {
  const h = await hub();
  try {
    const { dev } = await enroll(h, { kind: 'computer', name: 'Desk\u202e computer\u0000\u001b[2J\r\n', platform: 'linux\u2066 x64\u001b[0m\u0085' });
    const d = (await h.c('GET', '/mesh/devices')).body.find((x: { id: string }) => x.id === dev.deviceId);
    assert.deepEqual({ name: d.name, platform: d.platform }, { name: 'Desk computer', platform: 'linux x64' });
    // A plain name is unchanged.
    const { dev: plain } = await enroll(h, { kind: 'computer', name: 'Kitchen Mac mini', platform: 'darwin arm64' });
    const p = (await h.c('GET', '/mesh/devices')).body.find((x: { id: string }) => x.id === plain.deviceId);
    assert.deepEqual([p.name, p.platform], ['Kitchen Mac mini', 'darwin arm64']);
  } finally {
    await h.stop();
  }
});
