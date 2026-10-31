// The adversarial review of PR #241 (M10d), one test per item, each written first and seen failing
// against the code the review read (docs/evidence/m10d-gate.md, "The adversarial review of PR #241").
// Stand-ins only: the stand-in tofu on a PATH of the test's own, the loopback stand-in network target
// over a file in a temp folder, phones enrolled the way the plan says. A phone's requests carry the
// address a TLS proxy in front of the mesh listener would report (192.0.2.x, documentation space), as
// the mesh's `proxy` transport takes it: a device on the hub's own machine never counts as contact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { priceOf, validatePrices } from '../../src/core/infra/budget.ts';
import { mask, secretPaths, validatePatch } from '../../src/core/network/targets.ts';
import { validatePlan } from '../../src/core/browser/plan.ts';
import { Redactor } from '../../src/core/browser/logins.ts';
import { ACCOUNT_PRESENT_MS } from '../../src/core/browser/worker.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';
import { PUBLIC_URL, call, enroll, hub } from './mesh-support.ts';
import { PRICES, config, fakeToken, filesHolding, makeProject, tofuCalls, tofuOnPath } from '../support/infra.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AWAY = { 'x-forwarded-for': '192.0.2.50' };
const PROXY = { publicUrl: PUBLIC_URL, transport: 'proxy' as const };

async function settle(core: Core, id: string, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state) || Date.now() > end) return t;
    await sleep(20);
  }
}
async function until<T>(read: () => T, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = read();
  while (!done(v) && Date.now() < end) { await sleep(20); v = read(); }
  return v;
}

// ---- infrastructure ------------------------------------------------------------------------------

function infraCore() {
  const home = mkdtempSync(join(tmpdir(), 'nova-review-infra-'));
  const { path } = tofuOnPath();
  const clock = { t: Date.parse('2026-10-31T10:00:00.000Z') };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock.t), infra: { path: () => path, timeoutS: 60 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  return { core, home, clock };
}
function seedState(folder: string, resources: { type: string; name: string; attrs: Record<string, unknown> }[]) {
  writeFileSync(join(folder, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, lineage: 'seed-lineage', resources: resources.map((r) => ({ mode: 'managed', type: r.type, name: r.name, instances: [{ attributes: r.attrs }] })) }, null, 2));
}
function project(core: Core, folder: string, budget: number) {
  const p = core.infra.createProject({ name: `Example ${folder.slice(-12, -8)}`, folder, budget_usd_month: budget, prices: PRICES, secrets: ['STANDIN_TOKEN'] });
  core.infra.setSecret(p.id, 'STANDIN_TOKEN', fakeToken());
  return p;
}
async function plan(core: Core, projectId: string) {
  const { run: { id }, task } = core.infra.start({ project: projectId });
  const t = await settle(core, task.id);
  const apply = core.infra.view(id).tasks.find((x) => x.step === 'apply');
  return { id, plan: t, apply: apply ? core.ledger.get(apply.id) : null };
}

test('review B2: the month is priced from the plan’s whole result, so a resource Nova never recorded counts', { timeout: 60_000 }, async () => {
  const { core } = infraCore();
  try {
    // A $40 server existed before the project was registered. The plan replaces it with another one.
    const a = makeProject(config({ standin_server: { fresh: { size: 'large' } } }));
    seedState(a.folder, [{ type: 'standin_server', name: 'legacy', attrs: { size: 'large' } }]);
    const pa = project(core, a.folder, 10);
    const ra = await plan(core, pa.id);
    const va = core.infra.view(ra.id);
    assert.equal(va.budget!.monthly_usd_now, 40, 'what is there now is priced, recorded by Nova or not');
    assert.equal(va.state, 'over_budget', String(va.reason));
    assert.equal(ra.apply, null, 'no apply is offered');
    // Shrinking a resource Nova never recorded doesn't pay for a new one.
    const b = makeProject(config({ standin_server: { legacy: { size: 'small' }, fresh: { size: 'large' } } }));
    seedState(b.folder, [{ type: 'standin_server', name: 'legacy', attrs: { size: 'large' } }]);
    const pb = project(core, b.folder, 30);
    const rb = await plan(core, pb.id);
    const vb = core.infra.view(rb.id);
    assert.equal(vb.budget!.monthly_usd_after, 45);
    assert.equal(vb.state, 'over_budget', String(vb.reason));
    assert.ok(!tofuCalls(b.folder).some((c) => c.args[0] === 'apply'));
  } finally { await core.close(); }
});

test('review S1: a size named like a built-in JavaScript property can’t be priced, and blocks before anything is applied', { timeout: 60_000 }, async () => {
  const sheet = validatePrices(PRICES);
  for (const size of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.equal(priceOf(sheet, 'standin_server', { size }), null, size);
  assert.equal(priceOf(sheet, 'constructor', null), null, 'a type named like one either');
  const { core } = infraCore();
  try {
    const f = makeProject(config({ standin_server: { odd: { size: 'constructor' } } }));
    const p = project(core, f.folder, 1);
    const r = await plan(core, p.id);
    assert.equal(core.infra.view(r.id).state, 'unpriced');
    assert.equal(r.apply, null);
    assert.deepEqual(core.db.all('SELECT address FROM infra_resource'), []);
  } finally { await core.close(); }
});

test('review S6: sensitive attributes are masked wherever Nova stores or shows them, the database and checkpoints included', { timeout: 90_000 }, async () => {
  const { core, home } = infraCore();
  const secret = `example-db-pass-${fakeToken().slice(-10)}`;
  const region = `example-region-${fakeToken().slice(-6)}`;
  try {
    const f = makeProject(config({ standin_server: { db: { size: 'small', region, admin_password: secret } } }));
    const p = project(core, f.folder, 50);
    const r = await plan(core, p.id);
    const v = core.infra.view(r.id);
    assert.match(String(v.plan_text), /admin_password = \(sensitive value\)/);
    // The record keeps only what the review needs: no resource's values, sensitive or not.
    assert.ok(!core.db.get<{ changes: string }>('SELECT changes FROM infra_run WHERE id = ?', r.id)!.changes.includes(region));
    core.ledger.approve(r.apply!.id, { confirm: true });
    assert.equal((await settle(core, r.apply!.id)).state, 'done');
    // A second apply, so that a state copy (which holds it) is taken too.
    writeFileSync(join(f.folder, 'main.tf.json'), config({ standin_server: { db: { size: 'large', admin_password: secret } } }));
    const r2 = await plan(core, p.id);
    core.ledger.approve(r2.apply!.id, { confirm: true });
    assert.equal((await settle(core, r2.apply!.id)).state, 'done');
    await core.ledger.idle();
    assert.ok(!JSON.stringify([core.infra.view(r.id), core.infra.view(r2.id), core.infra.list()]).includes(secret));
    assert.deepEqual(filesHolding(home, [secret]), [], 'no file under Nova’s home holds it: nova.db, its WAL, checkpoints, the state copy');
  } finally { await core.close(); }
});

test('review minor: a plan too large to show in full is never offered for apply', { timeout: 60_000 }, async () => {
  const { core } = infraCore();
  try {
    const f = makeProject(config({ standin_dns_record: { big: { name: 'x.example.test', value: 'x'.repeat(1_200_000) } } }));
    const p = project(core, f.folder, 50);
    const r = await plan(core, p.id);
    assert.equal(r.apply, null);
    assert.match(String(core.infra.view(r.id).reason), /too large to show in full/);
  } finally { await core.close(); }
});

test('review minor: the plan says plainly that planning runs the project’s providers', { timeout: 60_000 }, async () => {
  const { core } = infraCore();
  try {
    const f = makeProject();
    const p = project(core, f.folder, 50);
    const r = await plan(core, p.id);
    assert.match(r.plan.brief.goal, /It changes no infrastructure, but OpenTofu runs the project’s providers and data sources/);
  } finally { await core.close(); }
});

// ---- networking -------------------------------------------------------------------------------------

const ROUTER = {
  firewall: { allow: ['mesh', 'web'] },
  vpn: { peers: [{ name: 'p1', public_key: 'pub-1', preshared_key: 'example-psk-original-1234' }] },
  wifi: { ssid: 'example-net', key: 'example-wifi-key-5678abcd', channel: 6 },
  admin: { user: 'root', pwd: 'example-admin-pwd-90ab', ui: true },
  wg: { privkey: 'example-wg-privkey-cdef' },
  snmp: { community: 'example-community-1357' },
  tls: { note: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAexampleexampleexampleexample' },
};
const SECRETS = ['example-psk-original-1234', 'example-wifi-key-5678abcd', 'example-admin-pwd-90ab', 'example-wg-privkey-cdef', 'example-community-1357', 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAexampleexampleexampleexample'];

async function net(o: { initial?: unknown; text?: string; windowMs?: number; netOpts?: Record<string, unknown>; kind?: string; transport?: 'proxy' | 'network'; target?: Record<string, unknown> } = {}) {
  const h = await hub({ core: { mesh: o.transport === 'network' ? { publicUrl: PUBLIC_URL, transport: 'network' } : PROXY, network: { windowMs: o.windowMs ?? 800, retryMs: 200 } } });
  const dir = mkdtempSync(join(tmpdir(), 'nova-review-net-'));
  const token = fakeToken();
  const file = join(dir, 'router.json');
  if (o.text !== undefined) writeFileSync(file, o.text);
  const n = await startNetconfig({ file, token, initial: o.text !== undefined ? null : (o.initial ?? ROUTER), ...(o.netOpts ?? {}) });
  const t = h.core.network.createTarget({ name: 'Example router', kind: 'router', url: n.url, ...(o.target ?? {}) });
  h.core.network.setToken(t.id, token);
  const phone = await enroll(h, { name: 'Example phone', kind: o.kind ?? 'phone' });
  const s = {
    h, n, t, token, file, phone,
    // The phone reaches the hub through the proxy, from another machine, while `on`.
    on: false,
    ended: false,
    async stop() { s.on = false; s.ended = true; await sleep(60); await s.n.close(); await h.stop(); },
  };
  void (async () => { while (!s.ended) { await sleep(40); if (s.on) await call(h.mesh, 'GET', '/api/v1/health', undefined, { authorization: `Bearer ${phone.token}`, ...AWAY }).catch(() => null); } })();
  return s;
}
async function toApply(core: Core, target: string, patch: unknown) {
  const { change, task } = core.network.start({ target, patch, title: 'Example change' });
  const prep = await settle(core, task.id);
  const ref = core.network.view(change.id).tasks.find((x) => x.step === 'apply');
  return { id: change.id, prep, apply: ref ? core.ledger.get(ref.id) : null };
}

test('review B1: a patch that sets a secret anywhere, inside arrays too, is refused', () => {
  assert.throws(() => validatePatch({ vpn: { peers: [{ name: 'p1', preshared_key: 'x' }] } }), /vpn\.peers\[0\]\.preshared_key/);
  assert.deepEqual(secretPaths({ a: [[{ b: { psk: 1 } }]] }), ['a[0][0].b.psk']);
});

test('review B1: a change that alters a secret value, or whose diff would show nothing, is never offered; the patch isn’t kept in clear', { timeout: 60_000 }, async () => {
  const s = await net();
  const { core } = s.h;
  try {
    assert.throws(() => core.network.start({ target: s.t.id, patch: { vpn: { peers: [{ name: 'p1', public_key: 'pub-1', preshared_key: 'MODEL-CHOSEN-psk-9999' }] } } }), /secrets aren’t changed from chat/);
    // Replacing the list drops the peer's key: a secret value changes, though the patch names none.
    const r = await toApply(core, s.t.id, { vpn: { peers: [{ name: 'p1' }] } });
    assert.equal(r.prep.state, 'failed');
    assert.match(String(r.prep.reason), /a secret value changes at .*vpn\.peers\[0\]\.preshared_key/);
    assert.equal(r.apply, null, 'nothing to approve');
    // The patch as proposed isn't in the database in clear.
    const marker = `example-ssid-${fakeToken().slice(-8)}`;
    const r2 = await toApply(core, s.t.id, { wifi: { ssid: marker } });
    assert.ok(r2.apply);
    assert.match(String(core.network.view(r2.id).diff), new RegExp(marker), 'the person sees it in the diff');
    const row = core.db.get<{ patch: string }>('SELECT patch FROM network_change WHERE id = ?', r2.id)!;
    assert.ok(!row.patch.includes(marker), 'the row keeps the patch’s shape only');
    assert.deepEqual(core.network.view(r2.id).patch, { wifi: { ssid: '…' } });
  } finally { await s.stop(); }
});

test('review S2: secret-looking keys and values are masked in every view and refused in patches, failing closed', { timeout: 60_000 }, async () => {
  for (const p of [{ wifi: { key: 'x' } }, { admin: { pwd: 'x' } }, { wg: { privkey: 'x' } }, { snmp: { community: 'x' } }]) assert.throws(() => validatePatch(p), /secrets aren’t changed from chat/, JSON.stringify(p));
  const m = JSON.stringify(mask(ROUTER as never));
  for (const x of SECRETS) assert.ok(!m.includes(x), x);
  const s = await net();
  const { core } = s.h;
  try {
    const r = await toApply(core, s.t.id, { wifi: { channel: 11 }, admin: { ui: false }, tls: { enabled: true } });
    assert.ok(r.apply, String(r.prep.reason));
    const all = JSON.stringify([core.network.view(r.id), core.network.list(), core.ledger.get(r.apply.id), core.ledger.get(r.prep.id)]);
    for (const x of SECRETS) assert.ok(!all.includes(x), x);
    const api = await s.h.c('GET', `/network/changes/${r.id}`);
    for (const x of SECRETS) assert.ok(!JSON.stringify(api.body).includes(x), x);
    await core.ledger.idle();
    assert.deepEqual(filesHolding(s.h.home, SECRETS), [], 'nor any file under Nova’s home (the database and its WAL included)');
  } finally { await s.stop(); }
});

test('review S3: the switch keeps putting the snapshot back while the target is unreachable, and the problem stays open until it lands', { timeout: 60_000 }, async () => {
  const s = await net();
  const { core } = s.h;
  try {
    const before = s.n.text();
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    assert.equal((await settle(core, r.apply!.id)).state, 'done');
    // The router restarts after taking its configuration: unreachable for a while.
    const port = s.n.port;
    await s.n.close();
    await until(() => core.network.view(r.id).tasks.filter((x) => x.step === 'revert' && x.state === 'failed').length, (n) => n >= 2, 15_000);
    assert.equal(core.network.view(r.id).state, 'reverting', 'it keeps trying');
    const open = () => core.log.problems({ open: true }).filter((p) => /lost contact with your devices/.test(p.message));
    assert.equal(open().length, 1, 'one problem, open');
    s.n = await startNetconfig({ file: s.file, token: s.token, port });
    const v = await until(() => core.network.view(r.id), (x) => x.state === 'reverted', 15_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    assert.equal(s.n.text(), before);
    assert.equal(open().length, 0, 'the problem closes once the snapshot is back');
  } finally { await s.stop(); }
});

test('review S4: a target that stamps its configuration on each write: the apply verifies, and the switch still puts the snapshot back', { timeout: 60_000 }, async () => {
  const s = await net({ initial: { firewall: { allow: ['mesh', 'web'] }, revision: 0 }, netOpts: { stamp: 'revision', etagOnPut: false } });
  const { core } = s.h;
  try {
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    const a = await settle(core, r.apply!.id);
    assert.equal(a.state, 'done', String(a.reason));
    assert.match(String(a.report?.summary), /set revision itself/);
    const v = await until(() => core.network.view(r.id), (x) => ['reverted', 'revert_failed'].includes(x.state), 15_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    assert.deepEqual(s.n.config().firewall.allow, ['mesh', 'web']);
  } finally { await s.stop(); }
});

test('review S5: only a successful request from a person’s device off the hub’s machine counts as contact', { timeout: 90_000 }, async () => {
  // A computer (an unattended device agent) doesn't count by default.
  const c = await net({ kind: 'computer' });
  try {
    assert.throws(() => c.h.core.network.start({ target: c.t.id, patch: { firewall: { allow: ['web'] } } }), /none is paired/);
  } finally { await c.stop(); }
  const s = await net();
  const { core } = s.h;
  try {
    const agent = await enroll(s.h, { name: 'Example desktop agent', kind: 'computer' });
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    assert.deepEqual(core.network.view(r.id).counts, ['Example phone'], 'the sheet says which devices count');
    core.ledger.approve(r.apply!.id, { confirm: true });
    await settle(core, r.apply!.id);
    // The agent's heartbeat; the phone from the hub's own machine; the phone's refused request.
    await call(s.h.mesh, 'GET', '/api/v1/tasks', undefined, { authorization: `Bearer ${agent.token}`, ...AWAY });
    await call(s.h.mesh, 'GET', '/api/v1/health', undefined, { authorization: `Bearer ${s.phone.token}` });
    await call(s.h.mesh, 'GET', '/api/v1/no-such-thing', undefined, { authorization: `Bearer ${s.phone.token}`, ...AWAY });
    const v = await until(() => core.network.view(r.id), (x) => ['kept', 'reverted'].includes(x.state), 10_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    // A phone's successful request through the proxy, from elsewhere, does count.
    const r2 = await toApply(core, s.t.id, { dns: { upstream: ['192.0.2.53'] } });
    core.ledger.approve(r2.apply!.id, { confirm: true });
    await settle(core, r2.apply!.id);
    s.on = true;
    const v2 = await until(() => core.network.view(r2.id), (x) => x.state !== 'watching', 10_000);
    assert.equal(v2.state, 'kept', String(v2.reason));
  } finally { await s.stop(); }
});

test('review S7: numbers Nova can’t carry exactly are refused; a revert writes back the snapshot’s exact bytes', { timeout: 60_000 }, async () => {
  const lossy = await net({ text: '{"firewall": {"allow": ["mesh"]}, "serial": 12345678901234567891, "mtu": 1500.0}\n' });
  try {
    const r = await toApply(lossy.h.core, lossy.t.id, { firewall: { allow: ['mesh', 'web'] } });
    assert.equal(r.prep.state, 'failed');
    assert.match(String(r.prep.reason), /can’t carry exactly through a change \(12345678901234567891, 1500\.0\)/);
    assert.equal(r.apply, null);
  } finally { await lossy.stop(); }
  // An odd but exact layout: compact, its own key order, no newline at the end.
  const raw = '{"wifi":{"ssid":"example-net","channel":6},"firewall":{"allow":["mesh","web"]}}';
  const s = await net({ text: raw });
  const { core } = s.h;
  try {
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    await settle(core, r.apply!.id);
    assert.notEqual(readFileSync(s.file, 'utf8'), raw, 'the change landed');
    await until(() => core.network.view(r.id).state, (x) => x === 'reverted', 15_000);
    assert.equal(readFileSync(s.file, 'utf8'), raw, 'byte for byte');
  } finally { await s.stop(); }
});

test('review minor: a target whose revert failed takes no new change until the person settles it', { timeout: 60_000 }, async () => {
  const s = await net();
  const { core } = s.h;
  try {
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    await settle(core, r.apply!.id);
    // Someone else changes it by hand: the switch won't overwrite them.
    writeFileSync(s.file, `${JSON.stringify({ ...ROUTER, firewall: { allow: ['web', 'ssh'] } }, null, 2)}\n`);
    await until(() => core.network.view(r.id).state, (x) => x === 'revert_failed', 15_000);
    assert.throws(() => core.network.start({ target: s.t.id, patch: { dns: { upstream: ['192.0.2.53'] } } }), /isn’t settled/);
    assert.throws(() => core.network.settle(r.id, {}), /confirm/);
    assert.equal(core.network.settle(r.id, { confirm: true }).state, 'settled');
    assert.ok(core.network.start({ target: s.t.id, patch: { dns: { upstream: ['192.0.2.53'] } } }).change.id);
  } finally { await s.stop(); }
});

test('review minor: a kept change keeps its sealed snapshot for 30 days, then lets it go', { timeout: 60_000 }, async () => {
  const s = await net();
  const { core } = s.h;
  try {
    s.on = true;
    const r = await toApply(core, s.t.id, { dns: { upstream: ['192.0.2.53'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    await settle(core, r.apply!.id);
    await until(() => core.network.view(r.id).state, (x) => x === 'kept', 10_000);
    const dir = join(s.h.home, 'workers', 'network', r.id);
    assert.ok(existsSync(join(dir, 'snapshot.json')));
    s.h.tick(31 * 24 * 3600_000);
    core.network.sweep();
    assert.equal(existsSync(join(dir, 'snapshot.json')), false);
    assert.equal(core.vault.list('network/').filter((n) => n.includes(r.id)).length, 0, 'its key left the vault');
    assert.throws(() => core.network.revert(r.id), /snapshot was let go after 30 days/);
  } finally { await s.stop(); }
});

test('review minor: a clock that went backwards counts as past the switch’s deadline', { timeout: 60_000 }, async () => {
  const s = await net({ windowMs: 3_600_000 });
  const { core } = s.h;
  try {
    const r = await toApply(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(r.apply!.id, { confirm: true });
    await settle(core, r.apply!.id);
    s.h.tick(-2 * 3600_000);
    core.network.sweep();
    const v = await until(() => core.network.view(r.id), (x) => x.state === 'reverted', 10_000);
    assert.equal(v.state, 'reverted');
  } finally { await s.stop(); }
});

// ---- accounts -------------------------------------------------------------------------------------

const SITE = '127.0.0.1:5000';
const mfa = (steps: unknown[]) => ({ allowed_hosts: [SITE], account: { change: 'mfa', site: SITE }, steps: [{ do: 'navigate', url: `http://${SITE}/security` }, ...steps, { do: 'code', why: 'The code from your app.', done_when: '.ok' }] });
const refused = (inputs: unknown, why: RegExp) => assert.throws(() => validatePlan(inputs), (e: any) => why.test(e.details.join(' ')), JSON.stringify(inputs));

test('review minor: an account plan neither fills a code-like field nor reads the page', () => {
  refused(mfa([{ do: 'fill', selector: '[autocomplete=one-time-code]', value: '482913' }]), /password or code field/);
  refused(mfa([{ do: 'fill', selector: 'input[name=token]', value: '482913' }]), /password or code field/);
  refused(mfa([{ do: 'fill', selector: '#mfa-code', value: '482913' }]), /password or code field/);
  refused(mfa([{ do: 'fill', selector: 'input[name=code]', value: '482913' }]), /password or code field/);
  refused(mfa([{ do: 'read', selector: '.setup-key' }]), /An account plan reads nothing from the page/);
  refused(mfa([{ do: 'read', selector: '.recovery-codes' }]), /An account plan reads nothing from the page/);
  // Outside an account plan, an ordinary code-named field still fills.
  validatePlan({ allowed_hosts: [SITE], steps: [{ do: 'fill', selector: '#postcode', value: '12345' }, { do: 'fill', selector: '#promo-code', value: 'EXAMPLE' }] });
});

test('review minor: a clock that went backwards counts as past the 10 minutes an account step waits', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-review-acct-'));
  const clock = { t: Date.parse('2026-10-31T10:00:00.000Z') };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock.t) });
  try {
    core.browser.saveLogin(SITE, { username: 'example-user', password: 'example-pw-0123456789' });
    const t = core.browser.account({ change: 'password', site: SITE, steps: [{ do: 'navigate', url: `http://${SITE}/password` }, { do: 'new_password', password: '#new', submit: '#save', done_when: '#ok' }], verify: { url: `http://${SITE}/status`, expect: ['ok'] } });
    core.ledger.approve(t.id, { confirm: true });
    clock.t -= ACCOUNT_PRESENT_MS;
    await core.ledger.idle();
    assert.match(String(core.ledger.get(t.id).reason), /only while you’re here/);
  } finally { await core.close(); }
});

test('review minor: the redactor masks a secret’s base64, hex and URL-encoded forms too', () => {
  const r = new Redactor();
  const v = 'example pw/with+chars=1';
  r.add(v);
  for (const form of [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url'), Buffer.from(v).toString('hex'), encodeURIComponent(v)]) {
    assert.ok(!r.text(`before ${form} after`).includes(form), form);
  }
});

void readdirSync;
