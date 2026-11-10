// Approval tiers as settings (owner ruling 2026-11-09, decision 8, and NOVA-SPEC §6: "Tiers are
// policy, configurable per user and per capability — the mechanism is core, the settings are
// profile"), as a registry: anything that acts registers its capabilities with an effect class, and
// Nova derives each one's floor and starting default from the class. Nova's own workers register
// through the same call; with no overrides every capability is what it was. A floor refuses a
// setting below it; raising is free; lowering needs {confirm: true} (with a passkey on Nova's own
// screen, as every confirmation there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { BUILTINS, DEFAULT_TIERS, EFFECTS, builtin, derive, effectiveOf } from '../../src/core/approvals/index.ts';
import { SEND_TIER, minTierOf } from '../../src/core/browser/plan.ts';
import { OPS, capabilityOf, tierFor, type Op } from '../../src/core/computer/policy.ts';
import { DEFAULT_SERVICE_TIER } from '../../src/core/connectors/home-assistant.ts';
import { CoreError } from '../../src/core/errors.ts';

function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-approvals-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true });
  return { core, home };
}

// Today's tiers, pinned. A change here is a change to Nova's defaults, which is the owner's.
const TODAY: Record<string, number> = {
  'browser.send': 1, 'browser.checkout': 3, 'browser.account': 3,
  'coding.write': 1, 'coding.update': 1, 'coding.check': 2, 'coding.merge': 3,
  'infra.plan': 1, 'infra.apply': 3,
  'network.prepare': 1, 'network.apply': 3,
  'computer.read': 0, 'computer.write': 1, 'computer.outside': 3, 'computer.create': 1, 'computer.create_shared': 2,
  'computer.checkpoint': 1, 'computer.reset': 1, 'computer.reset_discard': 2, 'computer.destroy': 3,
  'providers.enable': 2, 'providers.loosen': 3,
  'vault.delete': 3, 'vault.reset': 3,
};
// The floors, as Nova derives them from each built-in's effect class (and the one stricter floor a
// built-in asks for: an account change needs the person there).
const FLOORS: Record<string, number> = {
  'computer.read': 0, 'infra.plan': 0, 'network.prepare': 0,
  'browser.account': 2,
  'computer.destroy': 3, 'vault.delete': 3, 'vault.reset': 3,
};

test('the built-ins: every default is today’s tier, every floor is derived from its effect class, and none is above its default', () => {
  assert.deepEqual(Object.fromEntries(BUILTINS.map((c) => [c.id, builtin(c.id).default])), TODAY);
  for (const r of BUILTINS) {
    const c = builtin(r.id);
    assert.equal(c.floor, FLOORS[c.id] ?? 1, `${c.id}: floor`);
    assert.ok(c.floor <= c.default, `${c.id}: floor ${c.floor} above default ${c.default}`);
    assert.equal(c.floor, Math.max(EFFECTS[c.effect].floor, r.floor ?? 0), `${c.id}: the floor is the class’s, or stricter`);
    assert.equal(effectiveOf(c, null), c.default);
    assert.equal(DEFAULT_TIERS.effective(c.id), c.default);
  }
  assert.equal(builtin('browser.send').default, SEND_TIER);
});

test('effect classes: Nova derives the floor and the starting default; a registrant only tightens them, and only Nova’s own code goes below the class default', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(EFFECTS).map(([k, v]) => [k, [v.floor, v.default]])), { read: [0, 1], reversible: [1, 2], irreversible: [1, 3], delete: [3, 3] });
  const ext = { kind: 'extension' as const, id: 'acme' };
  const base = { area: 'Acme', name: 'Do a thing' };
  // An extension asking for a looser default than its class gets the class default.
  assert.equal(derive({ ...base, id: 'acme.send', effect: 'irreversible', default: 1 }, ext).default, 3);
  assert.equal(derive({ ...base, id: 'acme.tidy', effect: 'reversible', default: 0 }, ext).default, 2);
  assert.equal(derive({ ...base, id: 'acme.look', effect: 'read', default: 0 }, ext).default, 1);
  // A stricter default, or a stricter floor, is taken.
  assert.equal(derive({ ...base, id: 'acme.tidy2', effect: 'reversible', default: 3 }, ext).default, 3);
  assert.equal(derive({ ...base, id: 'acme.pay', effect: 'irreversible', floor: 2 }, ext).floor, 2);
  // A floor can't be loosened, and deleting is floor 3 whatever is asked.
  assert.equal(derive({ ...base, id: 'acme.purge', effect: 'delete', floor: 0, default: 1 }, ext).floor, 3);
  assert.equal(derive({ ...base, id: 'acme.purge2', effect: 'delete', default: 1 }, ext).default, 3);
  // An extension names its capabilities under its own id.
  assert.throws(() => derive({ ...base, id: 'coding.merge', effect: 'read' }, ext), /acme\.<name>/);
  assert.throws(() => derive({ ...base, id: 'acme.x', effect: 'harmless' as never }, ext), /effect/);
  // Nova's own code may set an owner-ruled default below the class's (a home change is tier 1).
  assert.equal(derive({ ...base, id: 'acme.home', effect: 'irreversible', default: 1 }, { kind: 'core' }).default, 1);
});

test('defaults unchanged: Nova’s computer, every situation tierFor knows, is its capability’s default', () => {
  const egresses = [{ mode: 'none', hosts: [] }, { mode: 'hosts', hosts: ['example.com'] }] as never[];
  for (const op of OPS as Op[]) for (const egress of egresses) for (const access of [undefined, 'read', 'write'] as const) for (const ownFolder of [true, false]) for (const gitWritable of [true, false]) for (const discard of [true, false]) {
    const o = { op, egress, ...(access ? { access } : {}), ownFolder, gitWritable, discard };
    assert.equal(builtin(capabilityOf(o)).default, tierFor(o), JSON.stringify(o));
  }
});

test('defaults unchanged: browser plans keep their tiers with no overrides', () => {
  const plan = (...steps: string[]) => ({ steps: steps.map((d) => ({ do: d })) }) as never;
  assert.equal(minTierOf(plan('goto', 'read')), 0);
  assert.equal(minTierOf(plan('goto', 'fill', 'click')), SEND_TIER);
  assert.equal(minTierOf(plan('login', 'click')), 1);
  assert.equal(minTierOf(plan('fill', 'checkout')), 3);
  assert.equal(minTierOf(plan('new_password')), 3);
  assert.equal(minTierOf({ ...(plan('goto') as object), account: { change: 'password', site: 'example.com' } } as never), 3);
  // Overrides, through the same function.
  const tiers = { effective: (id: string) => ({ 'browser.send': 2, 'browser.checkout': 1, 'browser.account': 2 } as Record<string, 0 | 1 | 2 | 3>)[id] ?? DEFAULT_TIERS.effective(id) };
  assert.equal(minTierOf(plan('fill'), tiers), 2);
  assert.equal(minTierOf(plan('checkout'), tiers), 1);
  assert.equal(minTierOf(plan('fill', 'checkout'), tiers), 2, 'a plan is at the highest tier any of its parts needs');
});

test('defaults unchanged: each worker’s least tier, on a fresh core, is what it was; Home Assistant registers through its manifest', async () => {
  const { core } = boot();
  try {
    const min = (owner: string, inputs: Record<string, unknown>) => core.ledger.workers.get(owner)!.minTier!({ inputs, evidence_required: [] } as never);
    assert.deepEqual(['write', 'update', 'check', 'merge', 'nonsense'].map((step) => min('coding', { step })), [1, 1, 2, 3, 3]);
    assert.deepEqual(['plan', 'apply', 'nonsense'].map((step) => min('infra', { step })), [1, 3, 3]);
    assert.deepEqual([min('network', { step: 'prepare' }), min('network', { step: 'apply' }), min('network', { step: 'revert', by: 'switch' }), min('network', { step: 'revert', by: 'person' })], [1, 3, 1, 3]);
    for (const r of BUILTINS) assert.equal(core.approvals.effective(r.id), TODAY[r.id], r.id);
    const ha = core.approvals.view('home-assistant.service');
    assert.deepEqual([ha.default, ha.floor, ha.tiers, ha.effect, ha.origin], [DEFAULT_SERVICE_TIER, 1, [1, 2], 'irreversible', 'core']);
    assert.deepEqual(ha.targets?.confirm_every_time, []);
    const view = core.approvals.list();
    assert.equal(view.capabilities.length, BUILTINS.length + 1);
    for (const v of view.capabilities) {
      assert.equal(v.override, null);
      assert.equal(v.effective, v.default);
      assert.ok(v.words.effective && v.words.default && v.words.floor && v.effect_words, `${v.id} says its tiers in words`);
    }
  } finally {
    await core.close();
  }
});

const refused = (fn: () => unknown, code: string, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof CoreError && e.code === code && re.test(e.message), String(re));

test('the floor: the vault never goes below 3, nothing goes to 0, and the message names the floor and why', async () => {
  const { core } = boot();
  try {
    refused(() => core.approvals.set('vault.delete', 1, { confirm: true }), 'validation', /tier 3.*vault/i);
    refused(() => core.approvals.set('vault.reset', 2, { confirm: true }), 'validation', /can’t go below tier 3/);
    refused(() => core.approvals.set('computer.destroy', 1, { confirm: true }), 'validation', /can’t go below tier 3.*deletes/);
    refused(() => core.approvals.set('browser.account', 1, { confirm: true }), 'validation', /can’t go below tier 2.*you’re there/);
    refused(() => core.approvals.set('coding.write', 0, { confirm: true }), 'validation', /can’t go below tier 1.*silent/);
    refused(() => core.approvals.set('home-assistant.service', 3, {}), 'validation', /1 or 2/);
    refused(() => core.approvals.set('coding.merge', 4, {}), 'validation', /tier is 0, 1, 2 or 3/);
    refused(() => core.approvals.set('nothing.here', 1, {}), 'not_found', /no capability/i);
    assert.equal(core.approvals.effective('vault.delete'), 3);
    // Even a value written around the route can't take a capability below its floor.
    core.profile.set('policy', 'approvals', { 'vault.delete': 0, 'coding.write': 0 }, 'settings');
    assert.equal(core.approvals.effective('vault.delete'), 3);
    assert.equal(core.approvals.effective('coding.write'), 1);
  } finally {
    await core.close();
  }
});

test('raising is free; lowering needs confirm; null goes back to the default (lowering too)', async () => {
  const { core, home } = boot();
  try {
    const v = core.approvals.set('coding.write', 2, {});
    assert.equal(v.effective, 2);
    assert.equal(v.override, 2);
    assert.equal(core.ledger.workers.get('coding')!.minTier!({ inputs: { step: 'write' }, evidence_required: [] } as never), 2, 'the worker follows');
    refused(() => core.approvals.set('coding.write', 1, {}), 'validation', /loosens.*confirm: true/);
    refused(() => core.approvals.set('coding.write', null, {}), 'validation', /confirm: true/);
    assert.equal(core.approvals.set('coding.write', null, { confirm: true }).override, null);
    assert.equal(core.approvals.effective('coding.write'), 1);
    refused(() => core.approvals.set('coding.merge', 1, {}), 'validation', /confirm: true/);
    assert.equal(core.approvals.set('coding.merge', 1, { confirm: true }).effective, 1);
    assert.equal(core.approvals.set('coding.merge', 3, {}).effective, 3, 'raising back asks nothing');
    // Stored in the profile, the way other settings are.
    assert.deepEqual(core.profile.get('policy', 'approvals'), { 'coding.merge': 3 });
    // Recorded, every change.
    const log = readFileSync(join(home, 'logs', 'nova.log'), 'utf8').split('\n').filter((l) => l.includes('"approvals"'));
    assert.equal(log.length, 4, log.join('\n'));
    assert.match(log[0]!, /coding\.write/);
  } finally {
    await core.close();
  }
});

// A stand-in extension that acts: a sprinkler controller, as someone else might write one.
const SPRINKLER = {
  id: 'acme-sprinkler', version: '1.0.0', kind: 'plugin', name: 'Acme sprinkler', capabilities: ['garden.water'],
  permissions: [{ kind: 'device', target: 'the garden sprinkler', why: 'to water when you ask' }], secrets: [], config_schema: {}, setup_flow: null, health_check: {},
  nova_compat: '>=0.1.0 <1.0.0', on_remove: { delete: [], keep: [], export: [] },
  // It asks to run without asking, and to be removable without a confirmation: Nova doesn't take that.
  approvals: [
    { id: 'water', name: 'Water the garden', effect: 'irreversible', default: 1, tools: ['sprinkle'], guard: 'water the garden' },
    { id: 'schedule', name: 'Change the watering schedule', effect: 'reversible' },
    { id: 'wipe', name: 'Forget the watering history', effect: 'delete', default: 0, floor: 0 },
  ],
};

test('an extension registers its capabilities on install: listed, derived from their effect class, lowered with confirm, and gone on removal; the override is kept for a reinstall', async () => {
  const { core } = boot();
  try {
    core.extensions.install(SPRINKLER);
    const water = core.approvals.view('acme-sprinkler.water');
    assert.deepEqual([water.default, water.floor, water.origin, water.effect], [3, 1, 'extension:acme-sprinkler', 'irreversible'], 'it asked for 1; its class starts at 3');
    assert.deepEqual([core.approvals.view('acme-sprinkler.schedule').default, core.approvals.view('acme-sprinkler.schedule').floor], [2, 1]);
    assert.deepEqual([core.approvals.view('acme-sprinkler.wipe').default, core.approvals.view('acme-sprinkler.wipe').floor], [3, 3]);
    assert.ok(core.approvals.list().capabilities.some((c) => c.id === 'acme-sprinkler.water'));
    // The person lowers it, as the owner wants possible: with a confirmation.
    refused(() => core.approvals.set('acme-sprinkler.water', 1, {}), 'validation', /confirm: true/);
    assert.equal(core.approvals.set('acme-sprinkler.water', 1, { confirm: true }).effective, 1);
    refused(() => core.approvals.set('acme-sprinkler.wipe', 1, { confirm: true }), 'validation', /can’t go below tier 3/);
    // Its chat tool is guarded after outside content, like Nova's own.
    assert.equal(core.approvals.guardWords('sprinkle'), 'water the garden');
    // Removed: gone from the list and the guard; the person's setting stays, by id.
    core.extensions.remove('acme-sprinkler');
    assert.equal(core.approvals.has('acme-sprinkler.water'), false);
    assert.ok(!core.approvals.list().capabilities.some((c) => c.id.startsWith('acme-sprinkler.')));
    assert.equal(core.approvals.guardWords('sprinkle'), null);
    assert.deepEqual(core.profile.get('policy', 'approvals'), { 'acme-sprinkler.water': 1 });
    core.extensions.install(SPRINKLER);
    assert.equal(core.approvals.effective('acme-sprinkler.water'), 1, 'a reinstall finds the person’s setting');
  } finally {
    await core.close();
  }
});

test('an extension can’t take a capability that is Nova’s own or another’s, or declare one Nova can’t take', async () => {
  const { core } = boot();
  try {
    const clash = { ...SPRINKLER, id: 'coding', name: 'Not coding', approvals: [{ id: 'merge', name: 'Merge', effect: 'read' }] };
    assert.throws(() => core.extensions.install(clash), (e: unknown) => e instanceof CoreError && e.details.some((d) => /coding\.merge is already Nova’s/.test(d)));
    assert.equal(core.approvals.capability('coding.merge').origin.kind, 'core');
    assert.equal(core.approvals.effective('coding.merge'), 3);
    const odd = { ...SPRINKLER, id: 'acme-odd', approvals: [{ id: 'x', name: 'X', effect: 'harmless' }] };
    assert.throws(() => core.extensions.install(odd), /manifest isn’t valid/);
  } finally {
    await core.close();
  }
});

test('the profile route and a configuration file can’t set approvals around the checks', async () => {
  const { core } = boot();
  try {
    const put = core.routes.find((r) => r.method === 'PUT' && r.path === '/profile/{section}/{key}')!;
    await assert.rejects(Promise.resolve().then(() => put.handle({ params: { section: 'policy', key: 'approvals' }, query: new URLSearchParams(), body: { value: { 'coding.merge': 1 } }, headers: {}, who: { principal: { kind: 'console' }, listener: 'console', address: 'console' } })), /\/api\/v1\/approvals/);
    assert.equal(core.approvals.effective('coding.merge'), 3);
  } finally {
    await core.close();
  }
});

test('providers: loosening a permission follows its tier (3 by default, asks nothing at 1)', async () => {
  const { core } = boot();
  try {
    refused(() => core.providers.setTestPolicy('allow', false), 'validation', /confirm: true/);
    core.approvals.set('providers.loosen', 1, { confirm: true });
    core.providers.setTestPolicy('allow', false);
    assert.equal(core.profile.get('policy', 'task_tests'), 'allow');
  } finally {
    await core.close();
  }
});

test('the vault’s routes still need confirm, whatever is asked', async () => {
  const { core } = boot();
  try {
    const del = core.routes.find((r) => r.method === 'DELETE' && r.path === '/vault/{name}')!;
    const who = { principal: { kind: 'console' as const }, listener: 'console' as const, address: 'console' };
    await assert.rejects(Promise.resolve().then(() => del.handle({ params: { name: 'API_KEY' }, query: new URLSearchParams(), body: {}, headers: {}, who })), /tier 3/);
  } finally {
    await core.close();
  }
});

// Over real HTTP, with the core's own approval hook: who is asking is set by the test (the console,
// a paired phone not allowed to approve, or one that is).
async function serve(core: Core) {
  const phone = { kind: 'device', device: { id: 'dev-phone', name: 'Phone', kind: 'phone', can_approve: false } } as never;
  const approver = { kind: 'device', device: { id: 'dev-approver', name: 'Approver phone', kind: 'phone', can_approve: true } } as never;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    void core.handle(req, res, url, req.headers['x-test-who'] === 'phone' ? phone : req.headers['x-test-who'] === 'approver' ? approver : { kind: 'console' }, 'console').then((done) => { if (!done) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (who: 'console' | 'phone' | 'approver', method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-nova': '1', 'x-test-who': who }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  return { send, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('routes: GET /approvals lists what is registered; PUT raises freely, lowers with confirm (a passkey on Nova’s own screen, the confirm alone from an approver device, never from one not allowed to approve), and refuses below the floor', { timeout: 30_000 }, async () => {
  const { core } = boot();
  const h = await serve(core);
  try {
    const list = await h.send('phone', 'GET', '/approvals');
    assert.equal(list.status, 200);
    const merge = list.body.capabilities.find((c: { id: string }) => c.id === 'coding.merge');
    assert.deepEqual([merge.default, merge.floor, merge.override, merge.effective], [3, 1, null, 3]);
    assert.match(merge.words.effective, /confirm/i);
    assert.ok(Array.isArray(list.body.fixed) && list.body.fixed.length === 2, 'what no setting changes is said too');
    assert.ok(list.body.effects.delete, 'and the effect classes');

    // Raising: free, from either.
    assert.equal((await h.send('console', 'PUT', '/approvals/coding.write', { tier: 2 })).status, 200);
    assert.equal((await h.send('phone', 'PUT', '/approvals/infra.plan', { tier: 2 })).status, 200);

    // Lowering without confirm: refused.
    const bare = await h.send('approver', 'PUT', '/approvals/coding.merge', { tier: 1 });
    assert.equal(bare.status, 400);
    assert.match(bare.body.error, /confirm: true/);
    // On Nova's own screen, confirm needs a passkey: the existing approval hook asks.
    const screen = await h.send('console', 'PUT', '/approvals/coding.merge', { tier: 1, confirm: true });
    assert.equal(screen.status, 403);
    assert.match(screen.body.error, /passkey/);
    assert.equal(core.approvals.effective('coding.merge'), 3, 'nothing changed');
    // A paired device not allowed to approve can't lower a gate, confirm or not (owner ruling D1).
    const phone = await h.send('phone', 'PUT', '/approvals/coding.merge', { tier: 1, confirm: true });
    assert.equal(phone.status, 403);
    assert.match(phone.body.error, /allowed to approve/);
    assert.equal(core.approvals.effective('coding.merge'), 3, 'a body flag is never the authorization');
    // An approver device confirms with the confirm alone.
    const ok = await h.send('approver', 'PUT', '/approvals/coding.merge', { tier: 1, confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.effective, 1);
    assert.equal(core.approvals.effective('coding.merge'), 1);

    // The floor, by name and reason.
    const vault = await h.send('approver', 'PUT', '/approvals/vault.delete', { tier: 1, confirm: true });
    assert.equal(vault.status, 400);
    assert.match(vault.body.error, /can’t go below tier 3/);
    assert.equal((await h.send('phone', 'PUT', '/approvals/nothing', { tier: 1 })).status, 404);
    assert.equal((await h.send('phone', 'PUT', '/approvals/coding.merge', {})).status, 400, 'a tier is required');
  } finally {
    await h.close();
    await core.close();
  }
});
