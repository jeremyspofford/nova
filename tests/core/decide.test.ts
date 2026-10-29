import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import { Decisions, JevProvider, RulesProvider, Templates, validateTemplate, type DecisionProvider, type DryRunCase, type TemplateDef } from '../../src/core/decide.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

function setup(opts: { privacy?: PrivacyMode; providers?: (rules: RulesProvider) => DecisionProvider[] } = {}) {
  const db = new Db(':memory:');
  db.migrate();
  const log = new Log(db, null);
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-decide-')), 'workspace'));
  const verifier = new Verifier(ws);
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules });
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(ws), templates.worker], defaultPrivacy: () => opts.privacy ?? 'local-only' });
  templates.bind(ledger);
  let privacy: PrivacyMode = opts.privacy ?? 'local-only';
  const decisions = new Decisions({ templates, providers: opts.providers?.(rules) ?? [rules], privacy: () => privacy, log });
  return { db, ledger, rules, templates, decisions, verifier, setPrivacy: (p: PrivacyMode) => { privacy = p; } };
}

const sorter = (over: Partial<TemplateDef> = {}): TemplateDef => ({
  template_id: 'example.sort',
  version: 1,
  situation: 'A note arrived. Which pile does it go on?',
  inputs: { subject: 'string', size: 'number' },
  questions: [
    { id: 'pile', type: 'choice', options: ['keep', 'archive', 'unknown'] },
    { id: 'urgency', type: 'score', min: 0, max: 10 },
  ],
  escalation: { confidence_floor: 0.7 },
  ...over,
});

async function author(templates: Templates, ledger: Ledger, def: TemplateDef, cases: DryRunCase[]) {
  templates.propose(def, 'person');
  assert.equal(templates.dryRun(def.template_id, def.version, cases).ok, true);
  const t = templates.activate(def.template_id, def.version);
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done', ledger.get(t.id).reason ?? '');
}

test('a choice question must offer "unknown", and must have 1 to 255 options', () => {
  assert.doesNotThrow(() => validateTemplate(sorter()));
  assert.throws(() => validateTemplate(sorter({ questions: [{ id: 'pile', type: 'choice', options: ['keep', 'archive'] }] })), (e: Error & { details?: string[] }) => /unknown/.test(e.details?.join(' ') ?? ''));
  const many = Array.from({ length: 255 }, (_, i) => `o${i}`);
  assert.throws(() => validateTemplate(sorter({ questions: [{ id: 'pile', type: 'choice', options: [...many, 'unknown'] }] })), (e: Error & { details?: string[] }) => /255/.test(e.details?.join(' ') ?? ''));
  assert.doesNotThrow(() => validateTemplate(sorter({ questions: [{ id: 'pile', type: 'choice', options: [...many.slice(1), 'unknown'] }] })));
  assert.throws(() => validateTemplate(sorter({ questions: [{ id: 'u', type: 'score', min: 5, max: 1 }] })), (e: Error & { details?: string[] }) => /min/.test(e.details?.join(' ') ?? ''));
  assert.throws(() => validateTemplate({ ...sorter(), questions: [{ id: 'x', type: 'noul' }] }), /doesn't match/);
  assert.throws(() => validateTemplate({ ...sorter(), escalation: { confidence_floor: 2 } }));
  assert.throws(() => validateTemplate({ ...sorter(), inputs: { subject: 'date' } }));
});

test('a template that was never authored is a miss, not a made-up schema', () => {
  const { templates } = setup();
  assert.equal(templates.get('example.sort'), null);
  templates.builtIn(sorter());
  assert.equal(templates.get('example.sort')?.state, 'active', 'a built-in ships active');
  assert.deepEqual(templates.events('example.sort').map((e) => e.kind), ['built_in']);
});

test('authoring: propose, dry-run, then activation is a ledger task the verifier checks by re-running the dry runs', async () => {
  const { templates, rules, ledger } = setup();
  rules.add('example.sort', (inputs) => ({ answers: { pile: Number(inputs.size) > 100 ? 'archive' : 'keep', urgency: 3 }, confidence: 0.9, why: 'size rule' }));
  const draft = templates.propose(sorter(), 'person');
  assert.equal(draft.state, 'draft');
  assert.equal(templates.get('example.sort'), null, 'a draft is not served');
  assert.throws(() => templates.activate('example.sort', 1), /dry run/);

  const bad = templates.dryRun('example.sort', 1, [{ inputs: { subject: 'a', size: 500 }, expect: { pile: 'keep' } }]);
  assert.equal(bad.ok, false);
  assert.throws(() => templates.activate('example.sort', 1), /dry run/);

  const good = templates.dryRun('example.sort', 1, [
    { inputs: { subject: 'a', size: 500 }, expect: { pile: 'archive' } },
    { inputs: { subject: 'b', size: 5 }, expect: { pile: 'keep' } },
  ]);
  assert.equal(good.ok, true);
  const task = templates.activate('example.sort', 1);
  assert.equal(task.owner, 'templates');
  await ledger.idle();
  const done = ledger.get(task.id);
  assert.equal(done.state, 'done', done.reason ?? '');
  assert.equal(done.verification?.checks[0]?.evidence?.kind, 'test_result');
  assert.match(done.verification!.checks[0]!.why, /re-ran 2 dry runs/);
  assert.equal(templates.get('example.sort')?.state, 'active');
  assert.equal(templates.get('example.sort')?.activation_task_id, task.id);
  assert.deepEqual(templates.events('example.sort').map((e) => e.kind), ['proposed', 'dry_run', 'dry_run', 'activation_started', 'activated']);
});

test('the verifier re-runs the dry runs itself: a report claiming they passed is not believed', async () => {
  const { templates, rules, ledger, verifier } = setup();
  let size = 100;
  rules.add('example.sort', (inputs) => ({ answers: { pile: Number(inputs.size) > size ? 'archive' : 'keep', urgency: 1 }, confidence: 0.9, why: 'size rule' }));
  templates.propose(sorter(), 'person');
  templates.dryRun('example.sort', 1, [{ inputs: { subject: 'a', size: 500 }, expect: { pile: 'archive' } }]);
  const task = templates.activate('example.sort', 1);
  size = 1000; // the rule changes before anything runs
  const brief = ledger.get(task.id).brief;
  const forged = { envelope: '1' as const, task_id: task.id, status: 'done' as const, summary: 'all good', evidence: [{ kind: 'test_result' as const, name: 'template:example.sort@1', passed: true }], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] };
  const v = verifier.verify(brief, forged);
  assert.equal(v.ok, false);
  assert.match(v.checks[0]!.why, /re-ran the dry runs itself and 1 of 1 failed/);
  await ledger.idle();
  assert.equal(ledger.get(task.id).state, 'failed');
  assert.equal(templates.get('example.sort'), null, 'it stays a draft');
  assert.equal(templates.version('example.sort', 1)?.state, 'draft');
  assert.ok(templates.events('example.sort').some((e) => e.kind === 'activation_failed'));
});

test('a test result Nova has no way to re-run never counts as proof', () => {
  const { verifier } = setup();
  const brief = { envelope: '1' as const, task_id: 't', goal: 'g', context_refs: [], constraints: {}, privacy_mode: 'local-only' as const, approval_tier: 1 as const, evidence_required: [{ kind: 'test_result' as const }], idempotency_key: 'k' };
  const v = verifier.verify(brief, { envelope: '1', task_id: 't', status: 'done', summary: 's', evidence: [{ kind: 'test_result', name: 'suite:other', passed: true }], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] });
  assert.equal(v.ok, false);
  assert.match(v.checks[0]!.why, /can't re-run the test "suite:other"/);
});

test('activating a new version retires the old one', async () => {
  const { templates, rules, ledger } = setup();
  rules.add('example.sort', () => ({ answers: { pile: 'keep', urgency: 1 }, confidence: 1, why: 'always keep' }));
  for (const version of [1, 2]) {
    templates.propose(sorter({ version }), 'person');
    templates.dryRun('example.sort', version, [{ inputs: { subject: 'a', size: 1 }, expect: { pile: 'keep' } }]);
    templates.activate('example.sort', version);
    await ledger.idle();
  }
  assert.equal(templates.get('example.sort')?.version, 2);
  assert.equal(templates.version('example.sort', 1)?.state, 'retired');
});

test('decide(): a confident answer acts; below the floor or "unknown" escalates; every call counts a use', async () => {
  const { templates, rules, decisions, ledger } = setup();
  let confidence = 0.9;
  let pile = 'keep';
  rules.add('example.sort', () => ({ answers: { pile, urgency: 2 }, confidence, why: 'test' }));
  await author(templates, ledger, sorter(), [{ inputs: { subject: 'a', size: 1 }, expect: { pile: 'keep' } }]);

  const a = await decisions.decide('example.sort', { subject: 'a', size: 1 });
  assert.equal(a?.escalate, false);
  assert.equal(a?.answers.pile, 'keep');
  assert.equal(a?.provider, 'rules');
  confidence = 0.5;
  assert.equal((await decisions.decide('example.sort', { subject: 'a', size: 1 }))?.escalate, true);
  confidence = 0.95;
  pile = 'unknown';
  assert.equal((await decisions.decide('example.sort', { subject: 'a', size: 1 }))?.escalate, true);
  pile = 'nonsense';
  const bad = await decisions.decide('example.sort', { subject: 'a', size: 1 });
  assert.equal(bad?.answers.pile, 'unknown', 'an answer outside the options becomes unknown');
  assert.equal(bad?.escalate, true);
  assert.equal(templates.get('example.sort')?.stats.uses, 4);

  assert.equal(await decisions.decide('example.missing', {}), null, 'a miss is null; the caller falls back to rules');
  await assert.rejects(decisions.decide('example.sort', { subject: 1, size: 1 }), /subject/);
});

test('a template with no local rule answers unknown and escalates instead of guessing', async () => {
  const { templates, decisions, ledger } = setup();
  await author(templates, ledger, sorter(), [{ inputs: { subject: 'a', size: 1 } }]);
  const d = await decisions.decide('example.sort', { subject: 'a', size: 1 });
  assert.equal(d?.answers.pile, 'unknown');
  assert.equal(d?.confidence, 0);
  assert.equal(d?.escalate, true);
});

test('local-only never calls a remote decision provider, even when it is registered first', async () => {
  let calls = 0;
  const jev = new JevProvider();
  const spy: DecisionProvider = { id: jev.id, egress: jev.egress, decide: (t, i) => { calls += 1; return jev.decide(t, i); } };
  const { decisions, templates, ledger, setPrivacy } = setup({ providers: (rules) => [spy, rules] });
  await author(templates, ledger, sorter(), [{ inputs: { subject: 'a', size: 1 } }]);
  const d = await decisions.decide('example.sort', { subject: 'a', size: 1 });
  assert.equal(d?.provider, 'rules');
  assert.equal(calls, 0);

  setPrivacy('cloud-allowed');
  const e = await decisions.decide('example.sort', { subject: 'a', size: 1 });
  assert.equal(calls, 1, 'with cloud allowed it is tried');
  assert.equal(e?.provider, 'rules', 'and when it is not configured, the local provider answers');
});

test('the remote provider is a stub until it is configured', async () => {
  const jev = new JevProvider();
  assert.equal(jev.egress, 'remote');
  const { templates } = setup();
  templates.propose(sorter(), 'person');
  await assert.rejects(jev.decide(templates.version('example.sort', 1)!, {}), /not configured/);
});
