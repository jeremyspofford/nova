// The change pipeline's guards (M7a review): only the pipeline makes its own tasks and only the
// person's real OK ships a change; the sandbox is inert, so a change's tests reach nothing of the
// person's; a rollback puts back exactly what the change wrote and nothing else; a rollback by hand
// during a canary is immediate; the approval card shows what a rule pack's tasks would do; the
// canary's window can't be cut short by the wall clock, and a change that was tampered with after
// its release isn't applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core, type CoreOptions } from '../../src/core/index.ts';
import { KIND_OPS } from '../../src/core/changes/kinds.ts';
import { inert } from '../../src/core/changes/sandbox.ts';
import { allows } from '../../src/core/mesh/access.ts';
import { notesSkill, variant, windDown } from '../support/changes.ts';
import { world, open as openResilience } from './resilience-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

function open(o: Partial<CoreOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-changes-'));
  const clock = { now: new Date('2030-01-15T08:00:00.000Z') };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => clock.now, ...o });
  core.profile.set('user', 'timezone', 'UTC', 'settings');
  core.start();
  return { home, clock, core };
}

const checked = (core: Core, id: string) => until(() => core.changes.get(id), (c) => c.state !== 'checking');
const inCanary = (core: Core, id: string) => until(() => core.changes.get(id), (c) => c.state !== 'canary' || (!!c.canary?.started_at && c.canary.applied !== false));
const settled = (core: Core, id: string, states = ['done', 'failed', 'cancelled']) => until(() => core.ledger.get(id), (t) => states.includes(t.state));
async function watch(core: Core, clock: { now: Date }, id: string) {
  const c = core.changes.get(id);
  const step = Math.ceil((c.canary!.window_s * 1000) / 2.5);
  for (let i = 0; i < 3 && core.changes.get(id).state === 'canary'; i++) {
    clock.now = new Date(clock.now.getTime() + step);
    await core.changes.tick();
  }
  return core.changes.get(id);
}
const routeOf = (core: Core, method: string, path: string) => core.routes.find((r) => r.method === method && r.path === path)!;
const console_ = { principal: { kind: 'console' as const }, listener: 'console' as const, address: 'console' };
const forged = (id: string, step: string, tier = 0) => ({ title: 'x', owner: 'changes', goal: 'x', evidence_required: [{ kind: 'confirmation' as const }], inputs: { change_id: id, step }, approval_tier: tier as 0, privacy_mode: 'local-only' as const });

// ---- BLOCKER 1: only the pipeline makes its tasks, and only the person's OK ships ---------------

test('a forged ship or rollback task is refused at every way in, and a waiting tier-3 change stays waiting', { timeout: 180_000 }, async () => {
  const { core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() }, { by: 'foundry', author: 'example' });
    const w = await checked(core, c.id);
    assert.equal(w.state, 'waiting', w.reason ?? '');
    assert.equal(w.tier, 3);
    const tasksBefore = core.ledger.list({ limit: 500 }).length;

    // POST /tasks (the person's API, and what a connector's or helper's delegate makes).
    const post = routeOf(core, 'POST', '/tasks');
    for (const step of ['ship', 'rollback', 'check']) {
      await assert.rejects(Promise.resolve().then(() => post.handle({ params: {}, query: new URLSearchParams(), headers: {}, who: console_, body: forged(c.id, step) as never })), /Only Nova’s change pipeline/, `POST /tasks step ${step}`);
    }
    await assert.rejects(Promise.resolve().then(() => post.handle({ params: {}, query: new URLSearchParams(), headers: {}, who: console_, body: { ...forged(c.id, 'ship'), owner: 'foundry', inputs: { need: 'anything at all', kind: 'trigger-rules' } } as never })), /Only Nova’s foundry/);
    // A device's task_request and a connector's delegate both come to the ledger with their origin.
    assert.throws(() => core.ledger.create({ ...forged(c.id, 'ship'), origin: { kind: 'device', ref: 'example-device' }, idempotency_key: 'device:example-device:k1' }), /Only Nova’s change pipeline/);
    assert.throws(() => core.ledger.create({ ...forged(c.id, 'ship', 3), origin: { kind: 'user' } }), /Only Nova’s change pipeline/);
    // A trigger rule (on a schedule, or a webhook's) can't name the pipeline or the foundry.
    assert.throws(() => core.triggers.createRule({ name: 'Ship it', class: 'heartbeat', cron: '* * * * *', action: { kind: 'task', task: forged(c.id, 'ship') } } as never, 'person'), /Only Nova’s change pipeline/);
    assert.throws(() => core.triggers.createRule({ name: 'Ship it', class: 'event', hook: 'example-hook', action: { kind: 'task', task: forged(c.id, 'ship') } } as never, 'person'), /Only Nova’s change pipeline/);
    // And a firing that carries such an action itself starts nothing.
    const fired = await core.triggers.fire({ class: 'proactive', source: 'probe', name: 'Forged', payload: { k: 1 }, dedup_key: 'forged-1', action: { kind: 'task', task: forged(c.id, 'ship') as never } });
    assert.equal(fired!.ledger_task_id, null);

    assert.equal(core.ledger.list({ limit: 500 }).length, tasksBefore, 'no task was made');
    await sleep(300);
    const after = core.changes.get(c.id);
    assert.equal(after.state, 'waiting');
    assert.equal(after.canary?.started_at ?? null, null, 'no canary began');
    assert.equal(after.stages.approval, undefined, 'no approval was recorded');
    assert.equal(core.triggers.listRules().length, 0, 'nothing went live');
  } finally {
    await core.close();
  }
});

test('the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own', { timeout: 180_000 }, async () => {
  const { clock, core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() }, { by: 'foundry', author: 'example' });
    const w = await checked(core, c.id);
    assert.equal(w.state, 'waiting', w.reason ?? '');
    const brief = (step: string) => ({ envelope: '1', task_id: 'not-the-ship-task', goal: 'x', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 3, evidence_required: [{ kind: 'confirmation' }], idempotency_key: 'x', inputs: { change_id: c.id, step } });
    for (const step of ['check', 'rollback', 'ship']) {
      const r = await core.changes.worker.run(brief(step) as never, new AbortController().signal) as { status: string; summary: string };
      assert.equal(r.status, 'failed', step);
      assert.match(r.summary, /isn’t one of this change’s own tasks/, step);
    }
    // Its own ship task, but not OK'd: it doesn't run either.
    const unapproved = await core.changes.worker.run({ ...brief('ship'), task_id: w.ship_task_id } as never, new AbortController().signal) as { status: string; summary: string };
    assert.equal(unapproved.status, 'failed');
    assert.match(unapproved.summary, /hasn’t been OK’d/);
    assert.equal(core.changes.get(c.id).state, 'waiting');
    assert.equal(core.changes.get(c.id).stages.approval, undefined);

    core.changes.ship(c.id, { confirm: true });
    await inCanary(core, c.id);
    const ship = core.ledger.get(w.ship_task_id!);
    const ev = core.changes.get(c.id).stages.approval!.evidence as { approved_at: string | null; confirmed: boolean; tier: number; task_id: string };
    assert.ok(ev.approved_at, 'the approval time is the ledger’s');
    assert.equal(ev.approved_at, ship.approved_at);
    assert.equal(ev.confirmed, true);
    assert.equal(ev.tier, 3);
    assert.equal(ev.task_id, ship.id);
    assert.equal((await watch(core, clock, c.id)).state, 'live');
  } finally {
    await core.close();
  }
});

// ---- BLOCKER 2: the sandbox is inert ----------------------------------------------------------

test('a rule pack whose task would run elsewhere is stopped before its tests, and the person’s real backup folder is untouched (the reviewer’s leak)', { timeout: 120_000 }, async () => {
  const w = world('nova-changes-leak-');
  const core = openResilience(w.home);
  core.profile.set('user', 'timezone', 'UTC', 'settings');
  core.start();
  try {
    core.resilience.setSettings({ target: w.target, keep: 1 });
    assert.equal(core.resilience.nightly.run().ok, true);
    const before = readdirSync(w.target).sort();
    const runsBefore = core.resilience.nightly.runs().length;
    const pack = {
      pack: { id: 'hourly-safety', name: 'Hourly safety', version: '1.0.0' },
      rules: [{ name: 'Back up', class: 'heartbeat', cron: '0 21 * * *', action: { kind: 'task', task: { title: 'Backup', owner: 'resilience', goal: 'Back up.', evidence_required: [{ kind: 'confirmation' }], approval_tier: 0, inputs: { action: 'backup' } } } }],
      tests: [{ name: 'fires at nine', at: '21:00', expect: { rule: 'Back up', fires: true } }],
    };
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: pack });
    const after = await checked(core, c.id);
    assert.equal(after.state, 'stopped', after.reason ?? '');
    assert.match(after.reason!, /Stopped at tests: .*“Back up” starts work for resilience.*tier 2/);
    assert.deepEqual(readdirSync(w.target).sort(), before, 'the backup folder is as it was');
    assert.equal(core.resilience.nightly.runs().length, runsBefore);
    // The pack's own tests never ran on the sandbox: the contract stopped it first.
    assert.equal((after.stages.tests!.evidence as { own?: unknown }).own, undefined);

    // Never the pipeline or the foundry, at any tier.
    const never = (owner: string) => ({ ...pack, pack: { ...pack.pack, id: `never-${owner}` }, rules: [{ ...pack.rules[0]!, action: { kind: 'task', task: { ...pack.rules[0]!.action.task, owner, approval_tier: 3 } } }] });
    for (const owner of ['changes', 'foundry']) assert.throws(() => core.changes.propose({ kind: 'trigger-rules', artifact: never(owner) }), /would start the pipeline’s own work/);
  } finally {
    await core.close();
  }
});

test('a sandbox copy is inert: backup, capture, provider and model settings are blanked', { timeout: 60_000 }, async () => {
  // inert() on a copy that has the person's outward settings.
  const w = world('nova-changes-inert-');
  const live = openResilience(w.home);
  live.resilience.setSettings({ target: w.target, encrypted_target: w.second, keep: 3 });
  live.db.run(`INSERT INTO capture_source (id, device_id, adapter, name, kinds, config, enabled, consent_at, consent_by, status, created_at, updated_at) VALUES ('src-1', 'dev-1', 'screenpipe', 'Screen', '["screen"]', '{"url":"http://127.0.0.1:3030"}', 1, '2030-01-01T00:00:00Z', 'person', 'on', '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`);
  const copy = join(w.dir, 'copy.db');
  live.db.raw.exec(`VACUUM INTO '${copy}'`);
  await live.close();
  inert(copy);
  const db = new DatabaseSync(copy);
  try {
    assert.deepEqual(db.prepare(`SELECT key FROM profile WHERE section = 'backups'`).all(), [], 'no backup folder, no encrypted copy');
    assert.deepEqual(db.prepare('SELECT enabled, config FROM capture_source').all().map((r) => ({ ...r })), [{ enabled: 0, config: '{}' }]);
  } finally {
    db.close();
  }
});

test('in a sandbox copy a firing rule records its task without starting it', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-changes-sbx-'));
  const sbx = createCore({ home, version: '0.1.0', trustedOrigin: () => true, sandbox: true, now: () => new Date('2030-01-15T08:00:00.000Z') });
  try {
    sbx.profile.set('user', 'timezone', 'UTC', 'settings');
    sbx.triggers.createRule({ name: 'Write a note', class: 'heartbeat', cron: '0 21 * * *', action: { kind: 'task', task: { title: 'Note', owner: 'workspace', goal: 'A note.', evidence_required: [{ kind: 'read_back', target: 'workspace:n.txt' }], approval_tier: 0, inputs: { action: 'write', path: 'n.txt', content: 'x' } } } }, 'person');
    const before = sbx.ledger.list({ limit: 500 }).length;
    const rule = sbx.triggers.listRules().find((r) => r.name === 'Write a note')!;
    const fired = (await sbx.triggers.tick(new Date('2030-01-15T21:00:30.000Z'))).filter((x) => x.rule_id === rule.id);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.triage.decision, 'act', 'it fired, as its test expects');
    assert.equal(fired[0]!.ledger_task_id, null);
    assert.match(fired[0]!.triage.reason, /sandbox copy/);
    assert.equal(sbx.ledger.list({ limit: 500 }).length, before, 'no task started');
  } finally {
    await sbx.close();
  }
});

// ---- BLOCKER 3: rollback is exact -------------------------------------------------------------

// v1 installed by hand and never enabled (its permission never OK'd), with a binary file and a
// large one in its folder; v2 (which overwrites the large one) fails its canary and is rolled back.
async function rolledBackExtension() {
  const { home, clock, core } = open();
  const perm = [{ kind: 'network', target: '127.0.0.1:9', why: 'To check a local service.' }];
  const v1 = notesSkill('1.0.0', { manifest: { permissions: perm } });
  core.extensions.install(v1.manifest);
  const dir = core.extensions.dataDir('example-notes');
  writeFileSync(join(dir, 'SKILL.md'), v1.files['SKILL.md']);
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
  writeFileSync(join(dir, 'icon.png'), bin);
  const big = Buffer.alloc(300 * 1024, 0x61);
  writeFileSync(join(dir, 'big.txt'), big);
  assert.equal(core.extensions.get('example-notes').state, 'installed');
  const art = notesSkill('2.0.0', { maxMemories: 2, manifest: { permissions: perm } });
  const v2 = core.changes.propose({ kind: 'extension', artifact: { ...art, files: { ...art.files, 'big.txt': 'small now' } } });
  const c = await checked(core, v2.id);
  assert.equal(c.state, 'waiting', c.reason ?? '');
  core.changes.ship(v2.id, { confirm: true });
  await inCanary(core, v2.id);
  assert.equal(core.extensions.get('example-notes').state, 'enabled', 'enabled for its canary');
  assert.equal(readFileSync(join(dir, 'big.txt'), 'utf8'), 'small now');
  for (const n of ['one', 'two', 'three']) core.memory.remember({ kind: 'fact', content: `Example note ${n}`, recorded_by: 'person' });
  clock.now = new Date(clock.now.getTime() + 60_000);
  await core.changes.tick();
  assert.equal(core.changes.get(v2.id).state, 'rolled_back', core.changes.get(v2.id).reason ?? '');
  return { home, core, dir, v1, bin, big };
}

test('rolling back an extension puts its state back exactly: installed, not enabled', { timeout: 120_000 }, async () => {
  const { core } = await rolledBackExtension();
  try {
    assert.equal(core.extensions.get('example-notes').state, 'installed');
    assert.equal(core.extensions.get('example-notes').version, '1.0.0');
  } finally {
    await core.close();
  }
});

test('rolling back an extension leaves a binary file it never touched byte for byte', { timeout: 120_000 }, async () => {
  const { core, dir, v1, bin } = await rolledBackExtension();
  try {
    assert.ok(readFileSync(join(dir, 'icon.png')).equals(bin));
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), v1.files['SKILL.md']);
  } finally {
    await core.close();
  }
});

test('rolling back an extension puts back a large file it overwrote', { timeout: 120_000 }, async () => {
  const { core, dir, big } = await rolledBackExtension();
  try {
    assert.ok(existsSync(join(dir, 'big.txt')), 'not deleted');
    assert.ok(readFileSync(join(dir, 'big.txt')).equals(big));
  } finally {
    await core.close();
  }
});

test('rolling back a brand-new extension leaves nothing behind, whatever it keeps or exports on removal', { timeout: 120_000 }, async () => {
  const { home, clock, core } = open();
  try {
    const fresh = notesSkill('1.0.0', { manifest: { id: 'example-fresh', name: 'Fresh', on_remove: { delete: [], keep: ['SKILL.md'], export: ['SKILL.md'] } } });
    const f = core.changes.propose({ kind: 'extension', artifact: fresh });
    const fc = await checked(core, f.id);
    assert.ok(fc.state === 'waiting' || fc.state === 'canary', fc.reason ?? '');
    if (fc.state === 'waiting') core.changes.ship(f.id, { confirm: true });
    await inCanary(core, f.id);
    assert.equal((await watch(core, clock, f.id)).state, 'live');
    assert.ok(core.extensions.list().some((x) => x.id === 'example-fresh'));
    const back = core.changes.rollback(f.id, { confirm: true });
    assert.equal((await settled(core, back.rollback_task_id!)).state, 'done');
    assert.equal(core.changes.get(f.id).state, 'rolled_back');
    assert.ok(!core.extensions.list().some((x) => x.id === 'example-fresh'));
    assert.ok(!existsSync(join(home, 'kept', 'example-fresh')), 'nothing kept');
    assert.ok(!existsSync(join(home, 'exports')) || !readdirSync(join(home, 'exports')).some((x) => x.startsWith('example-fresh')), 'nothing exported');
    assert.ok(!existsSync(core.extensions.dataDir('example-fresh')));
  } finally {
    await core.close();
  }
});

// ---- SHOULD-FIX 4: rolling back by hand during a canary is immediate ----------------------------

test('rolling back by hand during a canary happens now, and ends the canary', { timeout: 120_000 }, async () => {
  const { core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    await checked(core, c.id);
    await inCanary(core, c.id);
    assert.equal(core.triggers.listRules().length, 1);
    const r = core.changes.rollback(c.id, { confirm: true });
    const t = await settled(core, r.rollback_task_id!, ['done', 'failed', 'cancelled']);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(core.changes.get(c.id).state, 'rolled_back');
    assert.equal(core.triggers.listRules().length, 0);
    const ship = await settled(core, c.ship_task_id ?? core.changes.get(c.id).ship_task_id!, ['done', 'failed', 'cancelled']);
    assert.equal(ship.state, 'cancelled', 'the canary ended');
    assert.match(ship.reason!, /You rolled it back/);
    assert.equal(core.log.problems({ open: true }).filter((p) => p.task_id === ship.id).length, 0, 'the person’s own decision isn’t a problem');
  } finally {
    await core.close();
  }
});

// ---- SHOULD-FIX 5: the approval card shows what ships -------------------------------------------

test('a rule pack’s approval shows each task’s worker, inputs, tier and privacy', () => {
  const pack = {
    pack: { id: 'example-notes-pack', name: 'Notes', version: '1.0.0' },
    rules: [{ name: 'Write', class: 'heartbeat', cron: '0 21 * * *', action: { kind: 'task', task: { title: 'Write a note', owner: 'workspace', goal: 'g', evidence_required: [{ kind: 'confirmation' }], approval_tier: 0, privacy_mode: 'local-only', inputs: { action: 'write', path: 'notes/a.txt', content: 'example' } } } }],
  };
  const asks = KIND_OPS['trigger-rules'].asks(pack);
  assert.equal(asks.length, 1);
  assert.match(asks[0]!, /workspace/);
  assert.match(asks[0]!, /tier 0/);
  assert.match(asks[0]!, /local-only/);
  assert.match(asks[0]!, /"path":"notes\/a\.txt"/);
  assert.match(asks[0]!, /without asking/);
});

// ---- SHOULD-FIX 6 and 7: who may ship, and where a canary may show --------------------------------

test('ship and roll back are for an approver, not any paired phone or browser', async () => {
  const { core } = open();
  try {
    for (const path of ['/changes/{id}/ship', '/changes/{id}/rollback']) {
      const r = routeOf(core, 'POST', path);
      const phone = { kind: 'device' as const, device: { kind: 'phone', can_approve: false } as never };
      assert.equal(allows(r.access ?? 'person', phone), 'forbidden', path);
      assert.equal(allows(r.access ?? 'person', { kind: 'device', device: { kind: 'phone', can_approve: true } as never }), 'ok', path);
    }
  } finally {
    await core.close();
  }
});

test('a design system’s canary device must be the hub or one of the person’s paired devices', { timeout: 60_000 }, async () => {
  const { core } = open();
  try {
    assert.throws(() => core.changes.propose({ kind: 'design-system', artifact: variant('example-dusk'), canary: { device_id: 'no-such-device-1' } }), /isn’t one of your devices/);
    const ok = core.changes.propose({ kind: 'design-system', artifact: variant('example-dusk'), canary: { device_id: core.mesh.identity.id } });
    assert.equal(ok.canary?.device, core.mesh.identity.id);
    await checked(core, ok.id);
  } finally {
    await core.close();
  }
});

// ---- MINOR -----------------------------------------------------------------------------------

test('a canary’s window is measured on a clock that can’t jump: the wall clock leaping ahead doesn’t promote it', { timeout: 120_000 }, async () => {
  let mono = 0;
  const { clock, core } = open({ changes: { monotonic: () => mono } } as never);
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    await checked(core, c.id);
    await inCanary(core, c.id);
    for (let i = 0; i < 3; i++) {
      clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
      await core.changes.tick();
    }
    assert.equal(core.changes.get(c.id).state, 'canary', 'a day of wall clock in a moment is not the window');
    const window = core.changes.get(c.id).canary!.window_s * 1000;
    for (let i = 0; i < 3; i++) { mono += window / 2.5; await core.changes.tick(); }
    assert.equal(core.changes.get(c.id).state, 'live');
  } finally {
    await core.close();
  }
});

test('a promotion that fails rolls the change back instead of leaving it in its canary', { timeout: 120_000 }, async () => {
  const { clock, core } = open();
  const ops = KIND_OPS['trigger-rules'] as { promote: (...a: unknown[]) => Promise<void> };
  const promote = ops.promote;
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    await checked(core, c.id);
    await inCanary(core, c.id);
    ops.promote = async () => { throw new Error('the disk is full'); };
    const after = await watch(core, clock, c.id);
    assert.equal(after.state, 'rolled_back', after.reason ?? '');
    assert.match(after.reason!, /couldn’t be made live for everyone: the disk is full/);
    assert.equal(core.triggers.listRules().length, 0);
  } finally {
    ops.promote = promote;
    await core.close();
  }
});

test('a change whose canary began but whose apply never finished is applied when its task runs again', { timeout: 120_000 }, async () => {
  const { core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() }, { by: 'foundry', author: 'example' });
    const w = await checked(core, c.id);
    assert.equal(w.state, 'waiting');
    // As if Nova stopped between saving the canary's start and applying the change.
    const started = new Date('2030-01-15T08:00:00.000Z');
    core.db.run('UPDATE change_record SET canary = ?, previous = ? WHERE id = ?', JSON.stringify({ ...w.canary, scope: 'its first firings', started_at: started.toISOString(), ends_at: new Date(started.getTime() + 900_000).toISOString(), probes: ['health'], runs: [], baseline: { problem_id: 0, healthy: [] }, applied: false }), JSON.stringify({ exists: false, rules: [] }), c.id);
    core.changes.ship(c.id, { confirm: true });
    await until(() => core.triggers.listRules().length, (n) => n > 0, 10_000);
    assert.equal(core.triggers.listRules().length, 1, 'applied, not canaried unapplied');
    assert.equal(core.changes.get(c.id).canary!.applied, true);
  } finally {
    await core.close();
  }
});

test('a change whose artifact no longer matches its release isn’t applied', { timeout: 120_000 }, async () => {
  const { core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() }, { by: 'foundry', author: 'example' });
    assert.equal((await checked(core, c.id)).state, 'waiting');
    const tampered = windDown('1.0.0', { text: 'Something else entirely.' });
    core.db.run('UPDATE change_record SET artifact = ? WHERE id = ?', JSON.stringify(tampered), c.id);
    core.changes.ship(c.id, { confirm: true });
    const after = await until(() => core.changes.get(c.id), (x) => x.state !== 'waiting' && x.state !== 'canary', 10_000);
    assert.equal(after.state, 'stopped', after.reason ?? '');
    assert.match(after.reason!, /no longer matches/);
    assert.equal(core.triggers.listRules().length, 0, 'nothing applied');
  } finally {
    await core.close();
  }
});

test('rolling back a design system puts back only what it changed, not another device’s choice', { timeout: 120_000 }, async () => {
  const { clock, core } = open();
  try {
    const hub = core.mesh.identity.id;
    const ds = core.changes.propose({ kind: 'design-system', artifact: variant('example-dusk') });
    await checked(core, ds.id);
    await inCanary(core, ds.id);
    assert.equal(core.design.active(hub).id, 'example-dusk');
    // Meanwhile the person picks a look on another device.
    core.design.apply('orb-teal', { scope: 'device', device_id: 'another-device-1' });
    assert.equal((await watch(core, clock, ds.id)).state, 'live');
    assert.equal(core.design.active('a-third-device-1').id, 'example-dusk');
    const r = core.changes.rollback(ds.id, { confirm: true });
    assert.equal((await settled(core, r.rollback_task_id!)).state, 'done');
    assert.equal(core.design.appearance().device_overrides['another-device-1'], 'orb-teal', 'their own choice stays');
    assert.equal(core.design.appearance().device_overrides[hub], undefined);
    assert.equal(core.design.active('a-third-device-1').id, 'orb-teal', 'everyone else is back to what they had');
  } finally {
    await core.close();
  }
});
