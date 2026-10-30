// The change pipeline (M7a) in process, with real sandbox Nova processes: a good change end to end,
// sabotage caught by its tests and never offered, sabotage caught in the canary and rolled back by
// itself with nothing else touched, gates that can't be weakened or skipped, tier 3 every time for
// what Nova or a provider proposes, rolling back by hand, every kind, and the foundry authoring a
// wind-down reminder with the stand-in local model that ships and fires on the test clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { GATES, MIN_CANARY_S, weakens } from '../../src/core/changes/gates.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { filesReply } from '../../scripts/stand-ins/fake-openai.js';
import { CONTRACT_SYSTEM } from '../../src/core/providers/prompt.ts';
import { INSTALLED, hubHardware } from '../support/models.ts';
import { notesSkill, variant, windDown, windDownFiles } from '../support/changes.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

function open(o: { git?: boolean; ollama?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-changes-'));
  if (o.git) execFileSync('git', ['-C', home, 'init', '-q']);
  const clock = { now: new Date('2030-01-15T08:00:00.000Z') };
  const core = createCore({
    home, version: '0.1.0', trustedOrigin: () => true, now: () => clock.now,
    ...(o.ollama ? { models: { ollamaUrl: o.ollama, hardware: async () => hubHardware() as never, watchMs: 100 } } : {}),
  });
  core.profile.set('user', 'timezone', 'UTC', 'settings');
  core.start();
  return { home, clock, core };
}

const checked = (core: Core, id: string) => until(() => core.changes.get(id), (c) => c.state !== 'checking');
const inCanary = (core: Core, id: string) => until(() => core.changes.get(id), (c) => c.state !== 'canary' || !!c.canary?.started_at);
// The canary's window on the test clock: three looks, a third of the window apart and past its end.
async function watch(core: Core, clock: { now: Date }, id: string) {
  const c = core.changes.get(id);
  const step = Math.ceil((c.canary!.window_s * 1000) / 2.5);
  for (let i = 0; i < 3 && core.changes.get(id).state === 'canary'; i++) {
    clock.now = new Date(clock.now.getTime() + step);
    await core.changes.tick();
  }
  return core.changes.get(id);
}
const task = (core: Core, id: string, states = ['done', 'failed', 'cancelled']) => until(() => core.ledger.get(id), (t) => states.includes(t.state));
const stages = (core: Core, id: string) => Object.fromEntries(Object.entries(core.changes.get(id).stages).map(([k, v]) => [k, v!.status]));

test('a good change, end to end: sandbox, tests, health, a release in the home’s history, a canary, promoted, and every stage in the ledger', { timeout: 120_000 }, async () => {
  const { home, clock, core } = open({ git: true });
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    assert.equal(c.state, 'checking');
    assert.equal(c.tier, 1, 'a person’s reminder pack is act-and-report');
    assert.equal(core.triggers.listRules().length, 0, 'nothing is live while it is checked');
    const after = await checked(core, c.id);
    assert.equal(after.state, 'canary', after.reason ?? '');
    assert.deepEqual(Object.entries(stages(core, c.id)).slice(0, 5), [['sandbox', 'passed'], ['tests', 'passed'], ['health', 'passed'], ['release', 'passed'], ['approval', 'passed']]);
    const ev = after.stages.health!.evidence as { probes: { name: string; ok: boolean }[] };
    assert.deepEqual(ev.probes.map((p) => p.name), ['health', 'setup', 'ledger', 'memory', 'approval', 'privacy', 'the reminder is listed']);
    const own = (after.stages.tests!.evidence as { own: { name: string; ok: boolean }[] }).own;
    assert.deepEqual(own.map((x) => [x.name, x.ok]), [['registry', true], ['quiet at noon', true], ['fires at nine in the evening', true]]);
    // The release: files in the home's history, the artifact hashing to the record.
    const rel = after.release!;
    assert.ok(rel.commit, rel.history);
    const art = readFileSync(join(home, rel.dir, 'artifact.json'), 'utf8');
    assert.equal(createHash('sha256').update(art).digest('hex'), after.content_hash);
    assert.match(execFileSync('git', ['-C', home, 'log', '--format=%s', '-1']).toString(), /release Daily wind-down v1\.0\.0/);
    assert.ok(!existsSync(join(home, 'workers', 'changes', c.id)), 'the sandbox copy is gone');
    // Check is verified by Nova reading the release itself.
    const check = core.ledger.get(after.check_task_id!);
    assert.equal(check.state, 'done');
    assert.match(check.verification!.checks[0]!.why, /Nova read the release itself/);

    await inCanary(core, c.id);
    assert.equal(core.triggers.listRules().length, 1, 'live in its canary');
    const live = await watch(core, clock, c.id);
    assert.equal(live.state, 'live', live.reason ?? '');
    assert.equal(live.canary!.runs.length, 3);
    assert.ok(live.canary!.runs.every((r) => r.results.every((x) => x.ok)));
    const ship = await task(core, live.ship_task_id!);
    assert.equal(ship.state, 'done', ship.reason ?? '');
    // Every stage is a ledger event with its evidence.
    const noted = [...core.ledger.events(live.check_task_id!), ...core.ledger.events(live.ship_task_id!)].filter((e) => e.kind === 'stage').map((e) => (e.detail as { stage: string; status: string }));
    assert.deepEqual(noted.map((n) => `${n.stage}:${n.status}`), ['sandbox:passed', 'tests:passed', 'health:passed', 'release:passed', 'approval:passed', 'canary:running', 'canary:passed', 'promote:passed']);
    // It works live: the reminder fires on the clock.
    const fired = await core.triggers.tick(new Date('2030-01-15T21:00:30.000Z'));
    assert.equal(fired.filter((t) => t.message_id).length, 1);
    assert.equal(core.triggers.messages()[0]!.text, 'Time to wind down for the evening.');
    // The record replicates to a standby like the ledger.
    assert.ok(core.db.get(`SELECT 1 FROM sync_log WHERE tbl = 'change_record' AND pk = ?`, c.id));
    assert.equal(core.health().checks.changes.ok, true);
  } finally {
    await core.close();
  }
});

test('sabotage caught by the tests stops in the sandbox and is never offered: a broken test, an invalid manifest', { timeout: 120_000 }, async () => {
  const { core } = open();
  try {
    const before = core.extensions.list().map((x) => `${x.id}@${x.version}`);
    const broken = core.changes.propose({ kind: 'trigger-rules', artifact: windDown('1.0.0', { tests: [{ name: 'fires at eight', at: '20:00', expect: { rule: 'Wind down', fires: true } }] }) });
    const b = await checked(core, broken.id);
    assert.equal(b.state, 'stopped');
    assert.match(b.reason!, /^Stopped at tests: .*fires at eight: .*didn’t fire; it should have/);
    assert.equal(b.ship_task_id, null, 'never offered for approval');
    assert.equal(stages(core, broken.id).tests, 'failed');
    assert.equal((await task(core, b.check_task_id!)).state, 'failed');
    assert.equal(core.triggers.listRules().length, 0, 'nothing went live');
    assert.throws(() => core.changes.ship(broken.id, { confirm: true }), /hasn’t passed tests yet\. A change can’t skip a stage/);

    const bad = core.changes.propose({ kind: 'design-system', artifact: variant('example-broken', { drop: ['text/primary'] }) });
    const d = await checked(core, bad.id);
    assert.equal(d.state, 'stopped');
    assert.match(d.reason!, /Stopped at tests: .*Missing token text\/primary/);
    assert.equal(d.ship_task_id, null);
    assert.deepEqual(core.extensions.list().map((x) => `${x.id}@${x.version}`), before, 'nothing installed live');
    assert.equal(core.changes.overview().standout, null, 'nothing waits for the person');
  } finally {
    await core.close();
  }
});

test('sabotage that passes the sandbox but fails live: rolled back by itself, the previous version restored, Failed with the probe’s reason, a problem opened, nothing else changed', { timeout: 180_000 }, async () => {
  const { home, clock, core } = open();
  try {
    const v1 = core.changes.propose({ kind: 'extension', artifact: notesSkill('1.0.0') });
    await checked(core, v1.id);
    await inCanary(core, v1.id);
    assert.equal((await watch(core, clock, v1.id)).state, 'live');
    const skill = join(home, 'extensions', 'example-notes', 'SKILL.md');
    const v1Text = readFileSync(skill, 'utf8');
    // Something else of the person's that must not be touched.
    core.triggers.createRule({ name: 'Weekly review', class: 'heartbeat', cron: '0 9 * * 1', action: { kind: 'message', text: 'Weekly review time.' } }, 'person');
    core.profile.set('user', 'name', 'Example Person', 'settings');
    const others = () => JSON.stringify({ rules: core.triggers.listRules().map((r) => [r.id, r.name, r.cron, r.paused]), profile: core.profile.all(), design: core.design.active(), ext: core.extensions.list().filter((x) => x.id !== 'example-notes').map((x) => [x.id, x.version, x.state]) });
    const untouched = others();

    // v2 says live memories stay few: true on the sandbox copy, false once live data grows.
    const v2 = core.changes.propose({ kind: 'extension', artifact: notesSkill('2.0.0', { maxMemories: 2, text: 'Write each note as two lines.' }) });
    const passed = await checked(core, v2.id);
    assert.equal(stages(core, v2.id).health, 'passed', passed.reason ?? '');
    await inCanary(core, v2.id);
    assert.equal(core.extensions.get('example-notes').version, '2.0.0', 'in its canary');
    for (const n of ['one', 'two', 'three']) core.memory.remember({ kind: 'fact', content: `Example note ${n}`, recorded_by: 'person' });
    clock.now = new Date(clock.now.getTime() + 60_000);
    const [look] = await core.changes.tick();
    assert.equal(look!.state, 'rolled_back');
    const after = core.changes.get(v2.id);
    assert.equal(after.state, 'rolled_back');
    assert.match(after.reason!, /Rolled back by itself: The canary’s probe failed: memories stay few: length is 3, expected lte 2\. Version 1\.0\.0 is back\./);
    assert.equal(stages(core, v2.id).canary, 'failed');
    // The previous version, exactly.
    assert.equal(core.extensions.get('example-notes').version, '1.0.0');
    assert.equal(readFileSync(skill, 'utf8'), v1Text);
    assert.equal(core.changes.get(v1.id).state, 'live');
    // The ledger: Ship ended Failed with the probe's reason, and the problem says so plainly.
    const ship = await task(core, after.ship_task_id!);
    assert.equal(ship.state, 'failed');
    assert.match(ship.reason!, /Nova rolled back “Example notes” v2\.0\.0: The canary’s probe failed: memories stay few: length is 3, expected lte 2\. Version 1\.0\.0 is back, as it was\./);
    assert.ok(core.log.problems({ open: true }).some((p) => p.task_id === ship.id && /memories stay few/.test(p.message)));
    // Nothing else changed.
    assert.equal(others(), untouched);
  } finally {
    await core.close();
  }
});

test('the gates can’t be weakened or skipped: a change that tries is refused and kept on the record', { timeout: 60_000 }, async () => {
  assert.ok(Object.isFrozen(GATES) && Object.isFrozen(GATES.stages) && Object.isFrozen(GATES.min_canary_s));
  assert.throws(() => { (GATES.min_canary_s as Record<string, number>).config = 1; }, TypeError);
  assert.match(weakens('config', {}, { section: 'policy', key: 'canary_window' }) ?? '', /about the pipeline/);
  const { core } = open();
  try {
    const tries: [string, () => unknown, RegExp][] = [
      ['skip a stage', () => core.changes.propose({ kind: 'trigger-rules', artifact: windDown(), skip_stages: ['tests'] }), /sets skip_stages, which only the pipeline decides/],
      ['set its own tier', () => core.changes.propose({ kind: 'trigger-rules', artifact: { ...windDown(), tier: 0 } }), /sets tier/],
      ['shorten the canary', () => core.changes.propose({ kind: 'trigger-rules', artifact: windDown(), canary: { window_s: 60 } }), new RegExp(`at least ${MIN_CANARY_S['trigger-rules']} s`)],
      ['change the gates’ settings', () => core.changes.propose({ kind: 'config', artifact: { section: 'changes', key: 'min_canary_s', value: 0 } }), /hold the pipeline’s gates/],
      ['write the pipeline’s records', () => core.changes.propose({ kind: 'extension', artifact: notesSkill('1.0.0', { manifest: { permissions: [{ kind: 'data-write', target: 'changes', why: 'to mark itself passed' }] } }) }), /change the pipeline’s own records/],
      ['replace the core probes', () => core.changes.propose({ kind: 'trigger-rules', artifact: { ...windDown(), probe: { name: 'x', path: '/health', expect: [{ op: 'exists' }], replaces: 'core' } } }), /replace the core probes/],
    ];
    for (const [what, fn, why] of tries) {
      assert.throws(fn, (e: Error & { status?: number }) => e.status === 403 && why.test(e.message), what);
    }
    const refused = core.changes.list().filter((c) => c.state === 'refused');
    assert.equal(refused.length, tries.length, 'each attempt is on the record');
    assert.ok(refused.every((c) => !c.check_task_id), 'none of them ran');
    // Stages can't be entered out of order, by anyone.
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() });
    assert.throws(() => core.changes.enter(c.id, 'canary', { status: 'passed', summary: 'skip', evidence: null }), /can’t enter canary: sandbox hasn’t passed\. A change can’t skip a stage/);
    assert.throws(() => core.changes.ship(c.id, { confirm: true }), /A change can’t skip a stage/);
    await checked(core, c.id);
  } finally {
    await core.close();
  }
});

test('tier 3 every time for what a provider or the foundry proposes, and for privacy settings; the OK needs confirming and comes after the sandbox evidence', { timeout: 120_000 }, async () => {
  const { clock, core } = open();
  try {
    const c = core.changes.propose({ kind: 'trigger-rules', artifact: windDown() }, { by: 'provider:example-agent' });
    assert.equal(c.tier, 3);
    const privacy = core.changes.propose({ kind: 'config', artifact: { section: 'privacy', key: 'default', value: 'local-preferred' } });
    assert.equal(privacy.tier, 3, 'a privacy setting is a security change');
    const w = await checked(core, c.id);
    assert.equal(w.state, 'waiting');
    assert.equal(core.changes.overview().standout, c.id, 'the one standout: the first that waits');
    assert.equal((await checked(core, privacy.id)).state, 'waiting');
    core.changes.decline(privacy.id);
    assert.equal(core.changes.get(privacy.id).state, 'declined');
    assert.equal(core.profile.privacyDefault(), 'local-only', 'nothing of it went live');
    const v = core.changes.view(w);
    assert.equal(v.status, 'Needs you');
    assert.match(v.words, /confirmed|every time/);
    assert.ok(v.stages_in_order.slice(0, 4).every((s) => s.status === 'passed'), 'the sandbox evidence is there to show with the OK');
    assert.equal(core.ledger.get(w.ship_task_id!).reason, 'Needs your OK before it runs.');
    assert.throws(() => core.changes.ship(c.id), /tier-3 task: approving it needs an explicit confirmation/);
    assert.equal(core.triggers.listRules().length, 0);
    core.changes.ship(c.id, { confirm: true });
    await inCanary(core, c.id);
    const approval = core.changes.get(c.id).stages.approval!;
    assert.equal((approval.evidence as { confirmed: boolean }).confirmed, true);
    assert.equal((await watch(core, clock, c.id)).state, 'live');
  } finally {
    await core.close();
  }
});

test('rolling back by hand: tier 2, the previous version comes back and is live again', { timeout: 180_000 }, async () => {
  const { clock, core } = open();
  try {
    const v1 = core.changes.propose({ kind: 'trigger-rules', artifact: windDown('1.0.0') });
    assert.equal((await checked(core, v1.id)).state, 'canary', core.changes.get(v1.id).reason ?? '');
    await inCanary(core, v1.id);
    assert.equal((await watch(core, clock, v1.id)).state, 'live');
    const ruleId = core.triggers.listRules()[0]!.id;
    const v2 = core.changes.propose({ kind: 'trigger-rules', artifact: windDown('1.1.0', { text: 'Screens off soon: time to wind down.', cron: '30 21 * * *', tests: [{ name: 'fires at half past nine', at: '21:30', expect: { rule: 'Wind down', fires: true } }] }) });
    assert.equal((await checked(core, v2.id)).state, 'canary', core.changes.get(v2.id).reason ?? '');
    await inCanary(core, v2.id);
    assert.equal((await watch(core, clock, v2.id)).state, 'live');
    assert.equal(core.changes.get(v1.id).state, 'replaced');
    assert.equal(core.triggers.rule(ruleId).cron, '30 21 * * *', 'changed in place, its history kept');
    assert.throws(() => core.changes.rollback(v1.id, { confirm: true }), /isn’t live/);
    assert.throws(() => core.changes.rollback(v2.id), /puts back v1\.0\.0\. It needs your OK/);
    const r = core.changes.rollback(v2.id, { confirm: true });
    const t = await task(core, r.rollback_task_id!);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(t.approval_tier, 2);
    assert.equal(core.changes.get(v2.id).state, 'rolled_back');
    assert.equal(core.changes.get(v1.id).state, 'live');
    const rule = core.triggers.rule(ruleId);
    assert.deepEqual([rule.cron, (rule.action as { text: string }).text], ['0 21 * * *', 'Time to wind down for the evening.']);
  } finally {
    await core.close();
  }
});

test('every kind goes through: a design system on one device then everyone, a setting, a decision template', { timeout: 180_000 }, async () => {
  const { clock, core } = open();
  try {
    const hub = core.mesh.identity.id;
    const ds = core.changes.propose({ kind: 'design-system', artifact: variant('example-dusk') });
    await checked(core, ds.id); await inCanary(core, ds.id);
    assert.equal(core.design.active(hub).id, 'example-dusk', 'on the canary device');
    assert.equal(core.design.active('another-device-1').id, 'orb-teal', 'and nowhere else yet');
    assert.equal((await watch(core, clock, ds.id)).state, 'live');
    assert.equal(core.design.active('another-device-1').id, 'example-dusk', 'then everyone');

    const set = core.changes.propose({ kind: 'config', artifact: { section: 'user', key: 'greeting', value: 'Good evening' } });
    await checked(core, set.id); await inCanary(core, set.id);
    assert.equal((await watch(core, clock, set.id)).state, 'live');
    assert.equal(core.profile.get('user', 'greeting'), 'Good evening');

    const tpl = core.changes.propose({ kind: 'template', artifact: {
      template: { template_id: 'example-sort', version: 1, situation: 'Is this note worth keeping?', inputs: { words: 'number' }, questions: [{ id: 'keep', type: 'choice', options: ['yes', 'no', 'unknown'] }], escalation: { confidence_floor: 0.6 } },
      dry_runs: [{ inputs: { words: 3 } }, { inputs: { words: 40 } }],
    } });
    const t = await checked(core, tpl.id);
    assert.notEqual(t.state, 'stopped', t.reason ?? '');
    await inCanary(core, tpl.id);
    assert.equal(core.templates.get('example-sort')?.version, 1);
    assert.equal((await watch(core, clock, tpl.id)).state, 'live');
  } finally {
    await core.close();
  }
});

test('the foundry: the stand-in local model writes a wind-down reminder pack in its own folder; proposed at tier 3, it ships after the OK and fires on the test clock', { timeout: 180_000 }, async () => {
  const ollama = await startFakeOllama({
    models: INSTALLED,
    reply: (req: { messages?: { role: string; content: string }[] }) => (req.messages?.[0]?.content === CONTRACT_SYSTEM ? filesReply(windDownFiles(), 'A daily wind-down reminder at nine.') : 'ok'),
  });
  const { home, clock, core } = open({ ollama: ollama.url });
  try {
    await core.models.assign('reasoner', { model: 'example-deep:32b' });
    assert.throws(() => core.foundry.request({ need: 'x', kind: 'trigger-rules' }), /need is what you want/);
    const t = core.foundry.request({ need: 'Remind me to wind down at nine every evening', kind: 'trigger-rules' });
    const done = await task(core, t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.match(done.verification!.checks[0]!.why, /proposed by the foundry, at tier 3/);
    // The model's files went to the foundry's own folder; one receipt for the call, local.
    assert.ok(existsSync(join(home, 'workers', 'foundry', t.id, 'manifest.json')));
    const receipts = core.receipts.list({ task_id: t.id });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.egress, 'local');
    const c = core.changes.list().find((x) => x.proposed_by === 'foundry')!;
    assert.equal(c.tier, 3);
    assert.equal(c.author, 'ollama:example-deep:32b');
    assert.equal(core.triggers.listRules().length, 0, 'installed nowhere live until it has passed every gate');
    const w = await checked(core, c.id);
    assert.equal(w.state, 'waiting', w.reason ?? '');
    core.changes.ship(c.id, { confirm: true });
    await inCanary(core, c.id);
    assert.equal((await watch(core, clock, c.id)).state, 'live');
    const fired = await core.triggers.tick(new Date('2030-01-15T21:00:30.000Z'));
    assert.equal(fired.filter((x) => x.message_id).length, 1);
    assert.equal(core.triggers.messages()[0]!.text, 'Time to wind down for the evening.');
  } finally {
    await core.close();
    await ollama.close();
  }
});
