// Enrollment (M4 plan §1, CONTRACTS §5): the happy path end to end, and every refusal: wrong,
// spent and expired codes, a bad signature, a commitment that doesn't match, a replayed reveal and
// poll, a revoked key trying again, and the rate limits. Also: the hub's keys stay in their 0600
// file and out of the database, the log and the home's git history, and so do codes and session
// tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateDeviceKeys, keyFingerprint, normalizePairingCode, verifyRoster } from '../../src/core/index.ts';
import { Joiner, PUBLIC_URL, call, enroll, hub } from './mesh-support.ts';
import { commitHome, ensureGit } from '../../src/home.js';

test('the happy path: code, join, reveal, the same six digits on both screens, tier-3 approval, roster, session', async () => {
  const h = await hub();
  try {
    const p = await h.c('POST', '/mesh/pairings');
    assert.equal(p.status, 201);
    assert.match(p.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(p.body.hub_url, PUBLIC_URL);
    assert.equal(p.body.url, `${PUBLIC_URL}/pair#c=${p.body.code}&h=${p.body.hub_fingerprint}`, 'the code rides in the fragment');
    assert.equal(p.body.command, `curl -fsS ${PUBLIC_URL}/join.sh | sh -s -- ${p.body.code}`);
    assert.equal(Date.parse(p.body.expires_at) - h.clock.t, 5 * 60_000);

    const hello = await call(h.mesh, 'GET', '/api/v1/mesh/hello');
    assert.equal(hello.status, 200);
    assert.equal(hello.body.fingerprint, p.body.hub_fingerprint);
    assert.equal(keyFingerprint(hello.body.public_key), hello.body.fingerprint);
    assert.deepEqual(Object.keys(hello.body).sort(), ['epoch', 'fingerprint', 'id', 'name', 'public_key', 'role', 'roster', 'x25519_public_key']);
    // The roster (M4c, for fencing) carries ids, the hub's address and public keys: no person data.
    assert.deepEqual(Object.keys(hello.body.roster.roster).sort(), ['epoch', 'hub', 'issued_at']);

    const events: [string, unknown][] = [];
    const listen = (c: unknown) => events.push(['device', c]);
    h.core.mesh.devices.on('change', listen);
    const dev = new Joiner(h.mesh, h.nowS);
    // A code as a person might type it.
    const j = await dev.join(p.body.code.toLowerCase().replace('-', ' '));
    assert.equal(j.status, 201, JSON.stringify(j.body));
    assert.equal(j.body.hub_fingerprint, p.body.hub_fingerprint);
    assert.equal((await h.c('GET', '/mesh/requests')).body.length, 0, 'nothing to approve before the digits exist');
    const early = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true });
    assert.equal(early.status, 409, 'no approval before the reveal');

    const r = await dev.reveal();
    assert.equal(r.status, 200);
    assert.match(r.body.confirmation, /^\d{6}$/);
    assert.equal(r.body.confirmation, dev.digits(), 'the device computes the same digits itself');
    const waiting = (await h.c('GET', '/mesh/requests')).body;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].confirmation, r.body.confirmation, 'the hub’s prompt shows the same digits');
    assert.equal(waiting[0].name, 'Test phone');
    assert.equal(waiting[0].kind, 'phone');
    assert.deepEqual(waiting[0].capabilities, ['notify']);
    assert.equal(waiting[0].fingerprint, keyFingerprint(dev.keys.ed25519.publicKey));

    assert.equal((await dev.poll()).body.state, 'pending');
    const noConfirm = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, {});
    assert.equal(noConfirm.status, 400, 'tier 3 needs confirm: true');
    assert.match(noConfirm.body.error, /explicit confirmation/);
    const ok = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.device.kind, 'phone');
    assert.equal(ok.body.device.role, 'client');
    assert.equal(ok.body.device.trust, 'trusted');
    assert.equal(ok.body.device.can_approve, false);
    assert.equal(ok.body.device.public_key, undefined, 'keys aren’t listed, only fingerprints');
    assert.equal((await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 409, 'answered once');

    const done = await dev.poll();
    assert.equal(done.body.state, 'approved');
    assert.equal(done.body.device_id, ok.body.device.id);
    assert.equal(verifyRoster(done.body.roster, [hello.body.public_key]), true, 'the roster is signed by the hub');
    assert.equal(done.body.roster.roster.epoch, 1);
    assert.equal(done.body.roster.roster.hub.url, PUBLIC_URL);
    assert.equal(done.body.roster.roster.hub.public_key, hello.body.public_key);

    const s = await dev.session();
    assert.equal(s.status, 200);
    assert.match(s.body.token, /^nvs_/);
    assert.equal(Date.parse(s.body.expires_at) - h.clock.t, 12 * 3600_000);
    const auth = { authorization: `Bearer ${s.body.token}` };
    assert.equal((await call(h.mesh, 'GET', '/api/v1/tasks', undefined, auth)).status, 200);
    const list = (await call(h.mesh, 'GET', '/api/v1/mesh/devices', undefined, auth)).body;
    assert.deepEqual(list.map((d: { role: string; this: boolean }) => [d.role, d.this]), [['hub', false], ['client', true]], 'this device is marked');
    assert.deepEqual((await h.c('GET', '/mesh/devices')).body.map((d: { this: boolean }) => d.this), [true, false], 'the console is the hub');
    assert.deepEqual(events.map(([e, c]) => [e, (c as { action: string }).action]), [['device', 'approved']]);
    h.core.mesh.devices.off('change', listen);

    const health = (await h.c('GET', '/health')).body.checks.mesh;
    assert.deepEqual({ role: health.role, epoch: health.epoch, counts: health.counts, listening: health.listening }, { role: 'hub', epoch: 1, counts: { trusted: 1, revoked: 0 }, listening: true });

    // The code was spent.
    const again = new Joiner(h.mesh, h.nowS);
    const spent = await again.join(p.body.code);
    assert.equal(spent.status, 400);
    assert.deepEqual(spent.body, { error: 'That code didn’t work.' }, 'no detail');
  } finally {
    await h.stop();
  }
});

test('refusals: wrong and expired codes, bad signatures, a broken commitment, replays, a revoked key', async () => {
  const h = await hub();
  try {
    const wrong = await new Joiner(h.mesh, h.nowS).join('ABCD-EFGH');
    assert.deepEqual([wrong.status, wrong.body], [400, { error: 'That code didn’t work.' }]);
    const junk = await new Joiner(h.mesh, h.nowS).join('not a code');
    assert.deepEqual([junk.status, junk.body], [400, { error: 'That code didn’t work.' }]);

    // Expired: five minutes and a second later.
    const old = (await h.c('POST', '/mesh/pairings')).body.code;
    h.tick(5 * 60_000 + 1000);
    assert.deepEqual((await new Joiner(h.mesh, h.nowS).join(old)).body, { error: 'That code didn’t work.' });

    // A request that isn't complete is refused with its problems, and doesn't spend the code.
    const code = (await h.c('POST', '/mesh/pairings')).body.code;
    const d = new Joiner(h.mesh, h.nowS);
    const bad = await d.join(code, { x25519_sig: 'A'.repeat(86), claims: { name: '', kind: 'toaster' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.some((x: string) => /x25519_sig/.test(x)));
    assert.ok(bad.body.details.some((x: string) => /kind/.test(x)));
    assert.equal((await d.join(code)).status, 201);

    // A reveal signed by another key, a stale time, then a commitment that doesn't match.
    const stranger = generateDeviceKeys();
    assert.equal((await d.reveal(d.revealBody(d.time(), stranger.ed25519.privateKey))).status, 401);
    assert.equal((await d.reveal(d.revealBody(h.nowS() - 120))).status, 401, 'a time two minutes old');
    const realNonce = d.nonce;
    d.nonce = 'x'.repeat(43);
    const broken = await d.reveal();
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /check failed/);
    d.nonce = realNonce;
    assert.equal((await d.reveal()).status, 409, 'the request is over');
    assert.equal((await d.poll()).body.state, 'denied');
    assert.ok((await h.c('GET', '/problems')).body.some((p: { message: string }) => /check didn’t match/.test(p.message)), 'recorded as a problem');

    // Replays: the same reveal twice, the same poll twice.
    const code2 = (await h.c('POST', '/mesh/pairings')).body.code;
    const e = new Joiner(h.mesh, h.nowS);
    await e.join(code2);
    const body = e.revealBody();
    assert.equal((await e.reveal(body)).status, 200);
    assert.equal((await e.reveal(body)).status, 409, 'a replayed reveal');
    const t = e.time();
    assert.equal((await e.poll(t)).status, 200);
    assert.equal((await e.poll(t)).status, 401, 'a replayed poll');
    assert.equal((await e.poll(t - 1)).status, 401, 'an older poll');

    // Approve, revoke, and the same key tries again.
    await h.c('POST', `/mesh/requests/${e.requestId}/approve`, { confirm: true });
    await e.poll();
    assert.equal((await h.c('POST', `/mesh/devices/${e.deviceId}/revoke`, { reason: 'lost' })).status, 400, 'revoking is tier 3');
    const rv = await h.c('POST', `/mesh/devices/${e.deviceId}/revoke`, { confirm: true, reason: 'Lost it.' });
    assert.equal(rv.status, 200);
    assert.equal(rv.body.trust, 'revoked');
    assert.equal(rv.body.revoked_reason, 'Lost it.');
    assert.equal((await e.session()).status, 401, 'a revoked key can’t start a session');
    const code3 = (await h.c('POST', '/mesh/pairings')).body.code;
    const back = new Joiner(h.mesh, h.nowS, {}, e.keys);
    const refused = await back.join(code3);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /revoked/);
    // A new key is welcome.
    assert.equal((await new Joiner(h.mesh, h.nowS).join(code3)).status, 201, 'the code wasn’t spent by the refusal');

    // A request nobody answers expires, and that is worth a problem.
    const code4 = (await h.c('POST', '/mesh/pairings')).body.code;
    const f = new Joiner(h.mesh, h.nowS, { name: 'Unanswered' });
    await f.join(code4);
    await f.reveal();
    h.tick(10 * 60_000 + 1000);
    assert.equal((await f.poll()).body.state, 'expired');
    assert.equal((await h.c('POST', `/mesh/requests/${f.requestId}/approve`, { confirm: true })).status, 409);
    assert.ok((await h.c('GET', '/problems')).body.some((p: { message: string }) => /Unanswered.*wasn’t answered in time/.test(p.message)));
    // One never revealed expires quietly.
    const code5 = (await h.c('POST', '/mesh/pairings')).body.code;
    const g = new Joiner(h.mesh, h.nowS);
    await g.join(code5);
    h.tick(2 * 60_000 + 1000);
    assert.equal((await g.reveal()).status, 409);
  } finally {
    await h.stop();
  }
});

test('rate limits: wrong codes per address, every public call per address, new codes per hour; a refusal is one problem', async () => {
  const h = await hub();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await new Joiner(h.mesh, h.nowS).join('ABCD-EFGH')).status);
    assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
    assert.equal((await new Joiner(h.mesh, h.nowS).join('ABCD-EFGH')).status, 429);
    const rate = (await h.c('GET', '/problems')).body.filter((p: { message: string }) => /turned away/.test(p.message));
    assert.equal(rate.length, 1, 'one problem, not one per refusal');
    assert.match(rate[0].message, /127\.0\.0\.1/);
    h.tick(5 * 60_000 + 1);
    assert.equal((await new Joiner(h.mesh, h.nowS).join('ABCD-EFGH')).status, 400, 'the window moves on');

    h.tick(60_000);
    const all: number[] = [];
    for (let i = 0; i < 31; i++) all.push((await call(h.mesh, 'POST', '/api/v1/mesh/session', { device_id: 'x', time: h.nowS(), signature: 'y' })).status);
    assert.equal(all.at(-1), 429, 'every public call counts');
    assert.equal(all.filter((s) => s === 429).length, 1);

    for (let i = 0; i < 20; i++) assert.equal((await h.c('POST', '/mesh/pairings')).status, 201);
    assert.equal((await h.c('POST', '/mesh/pairings')).status, 429, 'twenty new codes an hour');
  } finally {
    await h.stop();
  }
});

test('joining and sessions only over the mesh listener; no mesh address means no codes', async () => {
  const h = await hub();
  try {
    const code = (await h.c('POST', '/mesh/pairings')).body.code;
    const d = new Joiner(h.console, h.nowS);
    const r = await d.join(code);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /hub\.example/);
    assert.equal((await new Joiner(h.mesh, h.nowS).join(code)).status, 201, 'the code still works where it should');
  } finally {
    await h.stop();
  }
  const bare = await hub({ mesh: false });
  try {
    const p = await bare.c('POST', '/mesh/pairings');
    assert.equal(p.status, 409);
    assert.match(p.body.error, /can’t reach this Nova/);
    assert.equal((await bare.c('GET', '/mesh/status')).body.listening, false);
  } finally {
    await bare.stop();
  }
});

test('a standby: one at a time, its address in the roster; computers and standbys are spokes and standbys', async () => {
  const h = await hub();
  try {
    const { dev: sb } = await enroll(h, { kind: 'standby', name: 'Standby', address: 'https://standby.example:4320/ignored' });
    const roster = (await h.c('GET', '/mesh/roster')).body;
    assert.equal(roster.roster.standby.id, sb.deviceId);
    assert.equal(roster.roster.standby.url, 'https://standby.example:4320');
    assert.equal(roster.roster.standby.x25519_public_key, sb.keys.x25519.publicKey);
    assert.equal((await h.c('GET', '/health')).body.checks.mesh.standby.id, sb.deviceId);
    const code = (await h.c('POST', '/mesh/pairings')).body.code;
    const second = new Joiner(h.mesh, h.nowS, { kind: 'standby', name: 'Second' });
    await second.join(code);
    await second.reveal();
    const two = await h.c('POST', `/mesh/requests/${second.requestId}/approve`, { confirm: true });
    assert.equal(two.status, 409);
    assert.match(two.body.error, /one standby/);
    const { dev: pc } = await enroll(h, { kind: 'computer', name: 'Desk computer' });
    const roles = (await h.c('GET', '/mesh/devices')).body.map((x: { id: string; role: string }) => [x.id, x.role]);
    assert.deepEqual(new Map(roles).get(pc.deviceId), 'spoke');
    assert.deepEqual(new Map(roles).get(sb.deviceId), 'standby');
    await h.c('POST', `/mesh/devices/${sb.deviceId}/revoke`, { confirm: true });
    assert.equal((await h.c('GET', '/mesh/roster')).body.roster.standby, undefined, 'a revoked standby leaves the roster');
  } finally {
    await h.stop();
  }
});

test('keys, codes and tokens stay out of the database, the log and git history; the identity file is 0600', async () => {
  const h = await hub();
  try {
    const p = await h.c('POST', '/mesh/pairings');
    const { token } = await enroll(h);
    const file = join(h.home, 'mesh', 'identity.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const id = JSON.parse(readFileSync(file, 'utf8'));
    const secrets = [id.ed25519.private, id.x25519.private, p.body.code, normalizePairingCode(p.body.code)!, token, token.slice(4)];
    h.core.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const places = [join(h.home, 'nova.db'), join(h.home, 'nova.db-wal'), join(h.home, 'logs', 'nova.log')].filter(existsSync);
    assert.ok(places.length >= 2);
    for (const place of places) {
      const bytes = readFileSync(place).toString('latin1');
      for (const s of secrets) assert.equal(bytes.includes(s), false, `${s.slice(0, 6)}… found in ${place}`);
    }
    // The home is a git repository (src/home.js), committed after every turn: every object in it,
    // packed or loose, reachable or not.
    assert.equal(await ensureGit(h.home), true);
    await commitHome(h.home, 'Nova: turn');
    const objects = execFileSync('git', ['-C', h.home, 'cat-file', '--batch-all-objects', '--batch'], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(objects.length > 0);
    for (const s of secrets) assert.equal(objects.includes(s), false, `${s.slice(0, 6)}… found in the home's git objects`);
    assert.equal(JSON.stringify(h.core.mesh.identity).includes(id.ed25519.private), false, 'serializing the identity shows public parts only');
  } finally {
    await h.stop();
  }
  // A file others could read is tightened at the next start, and that is a problem worth knowing.
  const again = await hub();
  const home = again.home;
  await again.stop();
  chmodSync(join(home, 'mesh', 'identity.json'), 0o644);
  const { createCore } = await import('../../src/core/index.ts');
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true });
  try {
    assert.equal(statSync(join(home, 'mesh', 'identity.json')).mode & 0o777, 0o600);
    assert.ok(core.log.problems().some((p) => /could be read by other users/.test(p.message)));
  } finally {
    await core.close();
  }
});
