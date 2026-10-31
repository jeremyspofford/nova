// Device roles (M10f, docs/plans/M10f.md §1; the orchestration ADR, Point 9 and Decision 2): chosen at
// pairing, confirmed and changeable on the hub's approval screen, stored on the device record,
// editable later at their tiers, and a hub candidate's key pinned in the next roster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPurposes, purposeChange, verifyRoster } from '../../src/core/index.ts';
import { Db, loadMigrations } from '../../src/core/db.ts';
import { Joiner, call, enroll, hub } from './mesh-support.ts';

// Joins and reveals; returns the device, with its request waiting for the person.
async function asking(h: Awaited<ReturnType<typeof hub>>, claims: Record<string, unknown>) {
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, h.nowS, claims);
  const j = await dev.join(code);
  assert.equal(j.status, 201, JSON.stringify(j.body));
  assert.equal((await dev.reveal()).status, 200);
  return dev;
}

test('the roles: what each kind may hold, a thin client is a screen only, and the tier of a change', () => {
  assert.deepEqual(checkPurposes([], 'phone'), ['thin-client']);
  assert.throws(() => checkPurposes(['compute'], 'phone'), /phone can’t be compute[\s\S]*runs no device agent/);
  assert.throws(() => checkPurposes(['thin-client', 'compute'], 'computer'), /screen only/);
  assert.throws(() => checkPurposes(['gpu-box'], 'computer'), /isn’t a role/);
  assert.throws(() => checkPurposes('compute', 'computer'), /list of roles/);
  assert.deepEqual(checkPurposes(['storage', 'compute', 'compute'], 'computer'), ['compute', 'storage']);
  assert.deepEqual(checkPurposes([], 'standby'), ['hub-candidate'], 'a standby is a hub candidate by what it is');
  assert.deepEqual(checkPurposes(['compute'], 'computer', { hub: true }), ['hub-candidate', 'compute', 'general-server'], 'the hub always holds hub candidate and general server');
  assert.throws(() => checkPurposes(['thin-client'], 'computer', { hub: true }), /hub can’t be thin client/);
  assert.deepEqual(purposeChange(['compute'], ['compute', 'storage']), { added: ['storage'], removed: [], tier: 3, candidacy: null });
  assert.deepEqual(purposeChange(['compute', 'storage'], ['compute']), { added: [], removed: ['storage'], tier: 2, candidacy: null });
  assert.deepEqual(purposeChange(['compute'], ['storage']).tier, 3, 'a swap widens, so it is tier 3');
  assert.equal(purposeChange(['compute'], ['hub-candidate', 'compute']).candidacy, 'added');
});

test('pairing with roles: the device asks, the approval screen shows them and the person changes them there', async () => {
  const h = await hub();
  try {
    const dev = await asking(h, { name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['compute', 'storage'] });
    const [req] = (await h.c('GET', '/mesh/requests')).body;
    assert.deepEqual(req.purposes, ['compute', 'storage'], 'what it asked for is on the approval screen');
    assert.deepEqual(req.allowed, ['thin-client', 'hub-candidate', 'compute', 'storage', 'capture-source', 'general-server']);
    // The person keeps compute only.
    const a = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true, purposes: ['compute'] });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.device.purposes, ['compute']);
    const d = (await h.c('GET', '/mesh/devices')).body.find((x: { id: string }) => x.id === a.body.device.id);
    assert.deepEqual(d.purposes, ['compute']);
    assert.equal(d.role, 'spoke', 'the mesh role is untouched: roles are their own field');
    // The device learns what it was approved for.
    const s = await dev.poll();
    assert.deepEqual(s.body.purposes, ['compute']);

    // A phone asks for nothing it can't hold; a computer can't ask for a role that doesn't exist.
    const code = (await h.c('POST', '/mesh/pairings')).body.code;
    const bad = await new Joiner(h.mesh, h.nowS, { kind: 'phone', purposes: ['storage'] }).join(code);
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /phone can’t be storage/);
    const phone = await asking(h, { kind: 'phone', name: 'Phone' });
    const pr = (await h.c('GET', '/mesh/requests')).body.find((r: { id: string }) => r.id === phone.requestId);
    assert.deepEqual(pr.purposes, ['thin-client']);
    assert.deepEqual(pr.allowed, ['thin-client']);
    const pa = await h.c('POST', `/mesh/requests/${phone.requestId}/approve`, { confirm: true, purposes: ['compute'] });
    assert.equal(pa.status, 400, 'the approval screen can’t give a phone work either');
  } finally { await h.stop(); }
});

test('a hub candidate asks at tier 3 at pairing, on its own, and its key is pinned in the next roster', async () => {
  const h = await hub();
  try {
    const dev = await asking(h, { name: 'Spare box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['hub-candidate', 'general-server'] });
    const without = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true });
    assert.equal(without.status, 400);
    assert.match(without.body.error, /hub candidate[\s\S]*confirm_candidate/);
    assert.equal((await h.c('GET', '/mesh/roster')).body.roster.candidates, undefined, 'nothing pinned before the person says so');
    const a = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true, confirm_candidate: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const signed = (await h.c('GET', '/mesh/roster')).body;
    const hello = (await h.c('GET', '/mesh/hello')).body;
    assert.ok(verifyRoster(signed, [hello.public_key]), 'the roster with its candidates is signed by the hub');
    assert.deepEqual(signed.roster.candidates.map((c: { id: string; public_key: string }) => [c.id, c.public_key]), [[a.body.device.id, dev.keys.ed25519.publicKey]]);
  } finally { await h.stop(); }
});

test('Settings › Devices: widening is tier 3, narrowing tier 2 saying what stops, a candidacy confirmed every time and unpinned when removed', async () => {
  const h = await hub();
  try {
    const dev = await asking(h, { name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['compute'] });
    const id = (await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).body.device.id;
    const patch = (body: unknown) => h.c('PATCH', `/mesh/devices/${id}`, body);

    const wide = await patch({ purposes: ['compute', 'storage'] });
    assert.equal(wide.status, 400);
    assert.match(wide.body.error, /tier 3[\s\S]*confirm: true/);
    assert.equal((await patch({ purposes: ['compute', 'storage'], approved: true })).status, 400, 'an ask-first OK is not enough to widen');
    assert.deepEqual((await patch({ purposes: ['compute', 'storage'], confirm: true })).body.purposes, ['compute', 'storage']);

    const narrow = await patch({ purposes: ['compute'] });
    assert.equal(narrow.status, 400);
    assert.match(narrow.body.error, /asks first \(tier 2\)[\s\S]*nothing stops/);
    assert.deepEqual((await patch({ purposes: ['compute'], approved: true })).body.purposes, ['compute']);

    // A candidacy later: tier 3 with its own confirmation, then pinned; removed, then unpinned.
    const cand = await patch({ purposes: ['hub-candidate', 'compute'], confirm: true });
    assert.equal(cand.status, 400);
    assert.match(cand.body.error, /confirm_candidate/);
    assert.equal((await patch({ purposes: ['hub-candidate', 'compute'], confirm: true, confirm_candidate: true })).status, 200);
    assert.deepEqual((await h.c('GET', '/mesh/roster')).body.roster.candidates.map((c: { id: string }) => c.id), [id]);
    assert.equal((await patch({ purposes: ['compute'], approved: true })).status, 200);
    assert.equal((await h.c('GET', '/mesh/roster')).body.roster.candidates, undefined, 'removing the role unpins the key in the next roster');

    // The hub keeps what it must hold; a revoked device keeps what it had.
    const hubId = (await h.c('GET', '/mesh/devices')).body.find((d: { role: string }) => d.role === 'hub').id;
    assert.deepEqual((await h.c('GET', '/mesh/devices')).body.find((d: { id: string }) => d.id === hubId).purposes, ['hub-candidate', 'general-server']);
    assert.deepEqual((await h.c('PATCH', `/mesh/devices/${hubId}`, { purposes: ['compute'], confirm: true })).body.purposes, ['hub-candidate', 'compute', 'general-server']);
    assert.equal((await h.c('POST', `/mesh/devices/${id}/revoke`, { confirm: true })).status, 200);
    assert.equal((await patch({ purposes: ['storage'], confirm: true })).status, 409);
  } finally { await h.stop(); }
});

test('devices paired before roles: phones and browsers are thin clients, the standby a hub candidate, computers what they already do, the hub its own', () => {
  const db = new Db(':memory:');
  const all = loadMigrations();
  db.migrate({ migrations: all.filter((m) => m.version < 19) });
  const at = '2026-10-01T00:00:00.000Z';
  const row = (id: string, kind: string, role: string) => db.run(
    `INSERT INTO device (id, name, platform, kind, role, public_key, x25519_public_key, fingerprint, capabilities, trust, can_approve, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?, ?, '[]', 'trusted', 0, ?)`,
    id, id, kind, role, `pk-${id}`, `xk-${id}`, `fp-${id}`, at,
  );
  row('p', 'phone', 'client'); row('b', 'browser', 'client'); row('s', 'standby', 'standby'); row('c', 'computer', 'spoke'); row('h', 'computer', 'hub');
  // Computers already doing work (review finding 2): one serving a model role, one with a capture
  // source, one with both.
  row('m', 'computer', 'spoke'); row('k', 'computer', 'spoke'); row('mk', 'computer', 'spoke');
  for (const [role, dev] of [['reasoner', 'm'], ['embedder', 'mk']]) db.run(`INSERT INTO profile (section, key, value, source, updated_at) VALUES ('models', ?, ?, 'settings', ?)`, `role.${role}`, JSON.stringify({ device: dev, runtime: 'ollama', url: 'http://192.0.2.5:11434', model: 'example' }), at);
  for (const dev of ['k', 'mk']) db.run(`INSERT INTO capture_source (id, device_id, adapter, name, kinds, created_at, updated_at) VALUES (?, ?, 'device', 'App activity', '["app-activity"]', ?, ?)`, `device:${dev}:app-activity`, dev, at, at);
  db.migrate({ migrations: all });
  const of = (id: string) => JSON.parse(db.get<{ purposes: string }>('SELECT purposes FROM device WHERE id = ?', id)!.purposes);
  assert.deepEqual([of('p'), of('b'), of('s'), of('c'), of('h')], [['thin-client'], ['thin-client'], ['hub-candidate'], [], ['hub-candidate', 'general-server']]);
  assert.deepEqual([of('m'), of('k'), of('mk')], [['compute'], ['capture-source'], ['compute', 'capture-source']], 'what already runs there keeps running');
  // The standby copies the column: a change to it is logged with it, every column there.
  const before = db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM sync_log')!.m ?? 0;
  db.run(`UPDATE device SET purposes = '["compute"]' WHERE id = 'c'`);
  const logged = db.all<{ op: string; row: string | null }>("SELECT op, row FROM sync_log WHERE tbl = 'device' AND pk = 'c' AND seq > ?", before);
  assert.equal(logged.length, 1, JSON.stringify(logged));
  assert.equal(logged[0]!.op, 'put');
  const sent = JSON.parse(logged[0]!.row!) as Record<string, unknown>;
  assert.equal(sent.purposes, '["compute"]');
  const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('device')").map((c) => c.name).sort();
  assert.deepEqual(Object.keys(sent).sort(), columns, 'the logged row carries every column, the new one included');
});

test('the hub tells a computer its roles in every heartbeat answer, and a dry run of placement refuses its thin client', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['thin-client'] });
    const auth = { authorization: `Bearer ${token}` };
    const hb = await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0' }, auth);
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    assert.deepEqual(hb.body.purposes, ['thin-client']);
    const service = { service: 'stand-in', version: '1.0.0', artifact: { program: { 'linux-x64': { url: 'file:///opt/stand-in/s.js', sha256: 'a'.repeat(64), command: ['node', 's.js'] } } }, ports: [{ name: 'api', port: 18080 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'full', secrets: [], egress: 'local', os_permissions: [] };
    const thin = await h.c('POST', '/services/placement', { definition: { ...service, placement: { mode: 'pinned', device: dev.deviceId } } });
    assert.equal(thin.status, 200);
    assert.equal(thin.body.resolution.ok, false);
    assert.match(thin.body.resolution.why, /Desk box is a thin client, which never receives workloads/);
    const onHub = await h.c('POST', '/services/placement', { definition: { ...service, placement: { mode: 'preferred' } } });
    assert.equal(onHub.body.resolution.ok, true, JSON.stringify(onHub.body));
    assert.equal(onHub.body.resolution.devices[0].name, 'Hub', 'the hub holds general server; the thin client doesn’t');
  } finally { await h.stop(); }
});
