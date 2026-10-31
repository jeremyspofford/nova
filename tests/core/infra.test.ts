// Infrastructure through chat (M10d, docs/plans/M10d.md): an infrastructure run through the Work
// Ledger, with the stand-in `tofu` (scripts/stand-ins/fake-tofu.js) on a PATH of the test's own and a
// project folder in a temp folder. No real OpenTofu, provider or cloud is involved.
//   - the gate: the plan is shown in full before the apply ask, at tier 3 with a confirmation; the
//     apply takes a checkpoint first and Nova reads the state back;
//   - budget guardrails: over budget alerts and blocks, a resource Nova can't price blocks, 80 % alerts,
//     the apply checks the budget again;
//   - declining applies nothing; a plan changed after review is refused; destroying is tier 3;
//   - the provider's secret (printed by the leaky stand-in) is in no record, report, log or file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { parsePlan } from '../../src/core/infra/tool.ts';
import { priceChanges, validatePrices, verdict } from '../../src/core/infra/budget.ts';
import { PRICES, config, fakeToken, filesHolding, makeProject, tofuCalls, tofuOnPath } from '../support/infra.ts';

function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-infra-home-'));
  const { path } = tofuOnPath();
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, infra: { path: () => path, timeoutS: 60 } });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  return { core, home };
}

async function settle(core: Core, id: string) {
  for (let i = 0; i < 800; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

const taskOf = (core: Core, run: string, step: string) => {
  const ref = core.infra.view(run).tasks.filter((x) => x.step === step).at(-1);
  return ref ? core.ledger.get(ref.id) : null;
};

function project(core: Core, o: { budget?: number; conf?: string; prices?: unknown } = {}) {
  const { dir, folder } = makeProject(o.conf);
  const token = fakeToken();
  const p = core.infra.createProject({ name: `Example ${dir.slice(-6)}`, folder, budget_usd_month: o.budget ?? 20, prices: o.prices ?? PRICES, secrets: ['STANDIN_TOKEN'] });
  core.infra.setSecret(p.id, 'STANDIN_TOKEN', token);
  return { p, folder, token, dir };
}

// Starts a run and takes it to where it stands after the plan.
async function planned(core: Core, projectId: string, more: Record<string, unknown> = {}) {
  const { run: { id: run }, task } = core.infra.start({ project: projectId, ...more });
  const plan = await settle(core, task.id);
  return { run, plan };
}

const messages = (core: Core) => core.db.all<{ text: string }>('SELECT text FROM message').map((m) => m.text).join('\n');
const problems = (core: Core) => core.log.problems({ open: true }).map((p) => p.message).join('\n');

test('M10d gate: a plan is shown in full before apply, and apply asks at tier 3; confirmed, a checkpoint comes first and Nova reads the state back', { timeout: 60_000 }, async () => {
  const { core, home } = boot();
  const { p, folder, token, dir } = project(core);
  try {
    const { run, plan } = await planned(core, p.id);
    // Plan: tier 1, automatic, changes nothing.
    assert.equal(plan.state, 'done', plan.reason ?? '');
    assert.equal(plan.approval_tier, 1);
    assert.ok(plan.verification?.ok);
    assert.match(plan.verification!.checks[0]!.why, /Nova read its saved plan itself: sha256 [0-9a-f]{12}…, as recorded/);
    assert.equal(existsSync(join(folder, 'terraform.tfstate')), false, 'planning changed nothing');
    assert.ok(!tofuCalls(folder).some((c) => c.args[0] === 'apply'));
    // Shown in full, and priced.
    const v = core.infra.view(run);
    assert.equal(v.state, 'review');
    assert.match(String(v.plan_text), /# standin_server\.web will be created[\s\S]*size = "small"[\s\S]*Plan: 2 to add, 0 to change, 0 to destroy\./);
    assert.deepEqual(v.changes.map((c) => [c.address, c.action, c.delta_usd]), [['standin_server.web', 'create', 5], ['standin_dns_record.www', 'create', 0]]);
    assert.equal(v.budget!.words, '$5.00 a month of the $20.00 budget (25 %)');
    // Apply: tier 3, every time; refused without the confirmation.
    const apply = taskOf(core, run, 'apply')!;
    assert.equal(apply.state, 'waiting');
    assert.equal(apply.approval_tier, 3);
    assert.throws(() => core.ledger.approve(apply.id), /explicit confirmation/);
    assert.match(messages(core), /The plan for “Example .*” is ready for you to review: 2 to add, \+\$5\.00 a month/);
    const checkpointsBefore = core.checkpoints.list().length;
    core.ledger.approve(apply.id, { confirm: true });
    const done = await settle(core, apply.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.ok(done.verification?.ok);
    assert.match(done.verification!.checks[0]!.why, /Nova read OpenTofu’s state itself: 2 planned changes, each as planned/);
    // The checkpoint came first: its database has no record of the resources the apply made.
    const after = core.infra.view(run);
    assert.equal(after.state, 'applied');
    assert.equal(core.checkpoints.list().length, checkpointsBefore + 1);
    const cp = core.checkpoints.list().find((c) => c.id === after.checkpoint)!;
    assert.match(String(cp.reason), /Before applying the infrastructure plan for “Example/);
    const { DatabaseSync } = await import('node:sqlite');
    const cpDir = readdirSync(join(home, 'checkpoints')).map((n) => join(home, 'checkpoints', n)).find((d) => { try { return JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')).id === cp.id; } catch { return false; } })!;
    const snap = new DatabaseSync(join(cpDir, 'nova.db'), { readOnly: true });
    assert.equal((snap.prepare('SELECT COUNT(*) AS n FROM infra_resource').get() as { n: number }).n, 0, 'the checkpoint is from before the apply');
    snap.close();
    assert.equal(after.state_before, 'none: the state isn’t in the project’s folder', 'there was no state file before the first apply');
    const state = JSON.parse(readFileSync(join(folder, 'terraform.tfstate'), 'utf8'));
    assert.deepEqual(state.resources.map((r: { type: string; name: string }) => `${r.type}.${r.name}`).sort(), ['standin_dns_record.www', 'standin_server.web']);
    // Every resource Nova provisioned has a budget guardrail and an alert.
    const proj = core.infra.project(p.id);
    assert.deepEqual(proj.resources.map((r) => [r.address, r.monthly_usd]), [['standin_dns_record.www', 0], ['standin_server.web', 5]]);
    for (const r of proj.resources) { assert.match(r.budget, /\$5\.00 a month of the \$20\.00 budget/); assert.match(r.alert, /alerts at 80 %/); }
    assert.match(messages(core), /Applied the plan for “Example .*”: 2 to add/);
    // The tool ran with nothing of Nova's: no NOVA_* variable, no home of the person's.
    for (const c of tofuCalls(folder)) {
      assert.ok(!c.env.some((k) => k.startsWith('NOVA_')), c.env.join(','));
      assert.deepEqual(c.env.filter((k) => !['PATH', 'HOME', 'TF_IN_AUTOMATION', 'TF_INPUT', 'CHECKPOINT_DISABLE', 'NO_COLOR', 'LANG', 'STANDIN_TOKEN', 'PWD', 'SHLVL', '_'].includes(k)), []);
    }
    // A second plan of the same configuration has nothing to do.
    const again = await planned(core, p.id);
    assert.equal(core.infra.view(again.run).state, 'nothing');
    // The leaky provider printed its token on every plan and apply: it is nowhere Nova keeps things.
    const kept = JSON.stringify([core.infra.view(run), core.infra.list(), core.ledger.get(plan.id), done, core.ledger.events(apply.id), core.ledger.events(plan.id), core.log.problems()]);
    assert.ok(!kept.includes(token), 'not in the run, the tasks, their reports or events');
    assert.match(String(core.infra.view(run).apply_out), /authenticated with token \[redacted\]/, 'the tool said it; Nova redacted it');
    assert.deepEqual(filesHolding(home, [token]), [], 'no file in Nova’s home holds it (the vault keeps it encrypted)');
    assert.deepEqual(filesHolding(folder, [token]), [], 'nor the project’s folder');
  } finally {
    await core.close();
    void dir;
  }
});

test('M10d: declining the apply applies nothing', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const { p, folder } = project(core);
  try {
    const { run } = await planned(core, p.id);
    const apply = taskOf(core, run, 'apply')!;
    const v = core.infra.decline(run);
    assert.equal(v.state, 'declined');
    assert.equal(core.ledger.get(apply.id).state, 'cancelled');
    assert.equal(existsSync(join(folder, 'terraform.tfstate')), false);
    assert.ok(!tofuCalls(folder).some((c) => c.args[0] === 'apply'), 'apply never ran');
    assert.deepEqual(core.infra.project(p.id).resources, []);
  } finally { await core.close(); }
});

test('M10d gate: a budget breach alerts and blocks: no apply is offered, a problem and a message say why', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const big = config({ standin_server: { web: { size: 'large' }, db: { size: 'large' } } });
  const { p, folder } = project(core, { budget: 50, conf: big });
  try {
    const { run, plan } = await planned(core, p.id);
    assert.equal(plan.state, 'done');
    const v = core.infra.view(run);
    assert.equal(v.state, 'over_budget');
    assert.equal(v.budget!.level, 'over');
    assert.match(String(v.reason), /\+\$80\.00 a month, taking it to \$80\.00 a month of the \$50\.00 budget \(160 %\): over budget\. Nova applied nothing/);
    assert.equal(taskOf(core, run, 'apply'), null, 'no apply task exists');
    assert.match(problems(core), /Budget alert: The plan for “Example .*” would cost \+\$80\.00 a month/);
    assert.match(messages(core), /Budget alert: The plan for/);
    assert.ok(!tofuCalls(folder).some((c) => c.args[0] === 'apply'));
  } finally { await core.close(); }
});

test('M10d: a resource Nova can’t price is never offered for apply', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const conf = config({ standin_server: { web: { size: 'small' } }, standin_bucket: { files: { tier: 'hot' } } });
  const { p } = project(core, { conf });
  try {
    const { run } = await planned(core, p.id);
    const v = core.infra.view(run);
    assert.equal(v.state, 'unpriced');
    assert.deepEqual(v.unpriced, ['standin_bucket.files (standin_bucket)']);
    assert.equal(taskOf(core, run, 'apply'), null);
    assert.match(problems(core), /Budget guardrail: Nova can’t price standin_bucket\.files/);
  } finally { await core.close(); }
});

test('M10d: at 80 % the apply is offered with an alert; the apply checks the budget again as it runs', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const conf = config({ standin_server: { a: { size: 'small' }, b: { size: 'small' } } });
  const { p, folder } = project(core, { budget: 12, conf });
  try {
    const { run } = await planned(core, p.id);
    assert.equal(core.infra.view(run).state, 'review');
    assert.equal(core.infra.view(run).budget!.level, 'warn');
    assert.match(messages(core), /Budget alert: applying the plan for “Example .*” would take it to \$10\.00 a month of the \$12\.00 budget \(83 %\), past 80 %/);
    // The person lowers the budget before confirming: the apply refuses, with an alert.
    core.infra.updateProject(p.id, { budget_usd_month: 8 });
    const apply = taskOf(core, run, 'apply')!;
    core.ledger.approve(apply.id, { confirm: true });
    const t = await settle(core, apply.id);
    assert.equal(t.state, 'failed');
    assert.match(String(t.reason), /\$10\.00 a month of the \$8\.00 budget \(125 %\): over budget\. Nova applied nothing/);
    assert.ok(!tofuCalls(folder).some((c) => c.args[0] === 'apply'), 'nothing was applied');
    assert.match(problems(core), /Budget alert: applying the plan for “Example .*” now would take it to/);
  } finally { await core.close(); }
});

test('M10d: a saved plan changed after review is refused; destroying is tier 3 and takes the resources off the record', { timeout: 90_000 }, async () => {
  const { core, home } = boot();
  const { p, folder } = project(core);
  try {
    const first = await planned(core, p.id);
    writeFileSync(join(home, 'workers', 'infra', 'runs', first.run, 'plan.tfplan'), JSON.stringify({ format: 'fake-tofu-plan', lineage: 'x', serial: 0, resource_changes: [] }));
    const apply = taskOf(core, first.run, 'apply')!;
    core.ledger.approve(apply.id, { confirm: true });
    const t = await settle(core, apply.id);
    assert.equal(t.state, 'failed');
    assert.match(String(t.reason), /The saved plan isn’t the one you reviewed any more, so Nova applied nothing/);
    assert.ok(!tofuCalls(folder).some((c) => c.args[0] === 'apply'));

    const second = await planned(core, p.id);
    const a2 = taskOf(core, second.run, 'apply')!;
    core.ledger.approve(a2.id, { confirm: true });
    assert.equal((await settle(core, a2.id)).state, 'done');
    assert.equal(core.infra.project(p.id).resources.length, 2);
    const gone = await planned(core, p.id, { destroy: true });
    const v = core.infra.view(gone.run);
    assert.deepEqual(v.changes.map((c) => c.action), ['delete', 'delete']);
    assert.equal(v.delta_usd, -5);
    const a3 = taskOf(core, gone.run, 'apply')!;
    assert.equal(a3.approval_tier, 3, 'destroying is tier 3');
    core.ledger.approve(a3.id, { confirm: true });
    const d = await settle(core, a3.id);
    assert.equal(d.state, 'done', d.reason ?? '');
    assert.deepEqual(core.infra.project(p.id).resources, []);
    assert.match(String(core.infra.view(gone.run).state_before), /^[0-9a-f]{64}$/, 'the state before the destroy was copied');
  } finally { await core.close(); }
});

test('M10d: a provider secret not in the vault stops the plan and says where it goes (never chat); projects need a budget and a configuration', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const { folder } = makeProject();
  try {
    assert.throws(() => core.infra.createProject({ name: 'No budget', folder, prices: PRICES }), /budget_usd_month is the most this project may cost a month/);
    assert.throws(() => core.infra.createProject({ name: 'Bad prices', folder, budget_usd_month: 5, prices: { standin_server: -1 } }), /price sheet can’t be used/);
    const empty = makeProject().folder;
    writeFileSync(join(empty, 'main.tf.json'), '');
    const p = core.infra.createProject({ name: 'Example', folder, budget_usd_month: 5, prices: PRICES, secrets: ['STANDIN_TOKEN'] });
    const { plan } = await planned(core, p.id);
    assert.equal(plan.state, 'failed');
    assert.match(String(plan.reason), /STANDIN_TOKEN isn’t in the vault yet\. Save it with PUT \/infra\/projects\/p[0-9a-f]+\/secrets\/STANDIN_TOKEN \(never in chat\)/);
    assert.equal(core.ledger.closed('infra') !== null, true, 'only Nova’s runs make infra tasks');
  } finally { await core.close(); }
});

test('M10d budget: prices by attribute, deltas for create, update, replace and delete, the verdict’s levels', () => {
  const sheet = validatePrices(PRICES);
  const changes = parsePlan(JSON.stringify({ resource_changes: [
    { address: 'standin_server.a', type: 'standin_server', name: 'a', mode: 'managed', change: { actions: ['create'], before: null, after: { size: 'large' } } },
    { address: 'standin_server.b', type: 'standin_server', name: 'b', mode: 'managed', change: { actions: ['update'], before: { size: 'small' }, after: { size: 'large' } } },
    { address: 'standin_server.c', type: 'standin_server', name: 'c', mode: 'managed', change: { actions: ['delete', 'create'], before: { size: 'large' }, after: { size: 'small' } } },
    { address: 'standin_server.d', type: 'standin_server', name: 'd', mode: 'managed', change: { actions: ['delete'], before: { size: 'large' }, after: null } },
    { address: 'data.standin_zone.z', type: 'standin_zone', name: 'z', mode: 'data', change: { actions: ['read'] } },
  ] }));
  assert.deepEqual(changes.map((c) => c.action), ['create', 'update', 'replace', 'delete']);
  const p = priceChanges(changes, sheet, new Map([['standin_server.d', 4000]]));
  assert.deepEqual(p.lines.map((l) => l.delta_cents), [4000, 3500, -3500, -4000]);
  assert.equal(p.delta_cents, 0);
  assert.deepEqual(p.unpriced, []);
  assert.deepEqual(priceChanges(parsePlan(JSON.stringify({ resource_changes: [{ address: 'standin_server.x', type: 'standin_server', name: 'x', change: { actions: ['create'], after: { size: 'huge' } } }] })), sheet, new Map()).unpriced, ['standin_server.x (standin_server)']);
  assert.equal(verdict(0, 500, 2000).level, 'ok');
  assert.equal(verdict(1500, 100, 2000).level, 'warn');
  assert.equal(verdict(1500, 600, 2000).blocks, true);
  assert.equal(verdict(3000, -500, 2000).blocks, false, 'a plan that only takes cost away is never blocked');
  assert.equal(verdict(0, 1, 0).blocks, true, 'a zero budget allows nothing that costs');
});

test('M10d: a project past 80 % once applied raises one alert, not one per heartbeat; over budget raises another', { timeout: 60_000 }, async () => {
  const { core } = boot();
  const { p } = project(core, { budget: 6 });
  try {
    const { run } = await planned(core, p.id);
    const apply = taskOf(core, run, 'apply')!;
    core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(core, apply.id)).state, 'done');
    const level = () => core.log.problems({ open: true }).filter((x) => /is past 80 % of its budget|is over its budget/.test(x.message)).map((x) => x.message);
    assert.deepEqual(level(), ['Budget alert: “' + p.name + '” is past 80 % of its budget: $5.00 a month of the $6.00 budget (83 %).']);
    core.infra.sweep();
    core.infra.sweep();
    assert.equal(level().length, 1, 'the heartbeat doesn’t repeat it');
    // The person lowers the budget under what it costs: over budget, one more alert.
    core.infra.updateProject(p.id, { budget_usd_month: 4 });
    core.infra.sweep();
    assert.equal(level().length, 2);
    assert.match(level()[0]!, /is over its budget: \$5\.00 a month of the \$4\.00 budget \(125 %\)\. Nova won’t apply any plan that adds to it\./);
    assert.equal(core.infra.project(p.id).alert_level, 'over');
  } finally { await core.close(); }
});
