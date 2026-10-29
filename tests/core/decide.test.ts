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
import { Decisions, JevProvider, RulesProvider, Templates, noulCertainty, validateTemplate, type DecisionProvider, type DryRunCase, type TemplateDef } from '../../src/core/decide.ts';
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
  assert.doesNotThrow(() => validateTemplate({ ...sorter(), questions: [{ id: 'x', type: 'noul' }] }));
  assert.throws(() => validateTemplate({ ...sorter(), questions: [{ id: 'x', type: 'noul', options: ['yes', 'no', 'unknown'] } as never] }), (e: Error & { details?: string[] }) => /yes\/no probability/.test(e.details?.join(' ') ?? ''));
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
  const spy: DecisionProvider = { id: jev.id, egress: jev.egress, questionTypes: jev.questionTypes, decide: (t, i) => { calls += 1; return jev.decide(t, i); } };
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

// Noul: Jev's yes/no type, one calibrated probability that the answer is yes. No separate confidence.
const asker = (over: Partial<TemplateDef> = {}): TemplateDef => ({
  template_id: 'example.ask',
  version: 1,
  situation: 'Is this note worth mentioning today?',
  inputs: { subject: 'string' },
  questions: [{ id: 'mention', type: 'noul' }],
  escalation: { confidence_floor: 0.6 },
  ...over,
});

test('Noul certainty comes from the probability alone: 0.5 is the least certain', () => {
  assert.equal(noulCertainty(0.5), 0);
  assert.equal(noulCertainty(1), 1);
  assert.equal(noulCertainty(0), 1);
  assert.ok(Math.abs(noulCertainty(0.9) - 0.8) < 1e-9);
});

test('a Noul answer carries its own certainty; a separate stated confidence is ignored', async () => {
  const { rules, templates, ledger, decisions } = setup();
  let p = 0.9;
  rules.add('example.ask', () => ({ answers: { mention: p }, confidence: 0.01, why: 'test rule' }));
  await author(templates, ledger, asker(), [{ inputs: { subject: 'a' } }]);
  const sure = await decisions.decide('example.ask', { subject: 'a' });
  assert.equal(sure?.answers.mention, 0.9);
  assert.ok(Math.abs((sure?.confidence ?? 0) - 0.8) < 1e-9, 'certainty 0.8 from p = 0.9, not the stated 0.01');
  assert.equal(sure?.escalate, false);
  p = 0.5;
  const unsure = await decisions.decide('example.ask', { subject: 'a' });
  assert.equal(unsure?.confidence, 0);
  assert.equal(unsure?.escalate, true, 'p = 0.5 is maximum uncertainty and escalates');
  p = 1.4;
  const broken = await decisions.decide('example.ask', { subject: 'a' });
  assert.equal(broken?.answers.mention, 0.5, 'out of range becomes the least certain answer');
  assert.equal(broken?.escalate, true);
});

test('with Noul and other questions, the decision is only as certain as its weakest part', async () => {
  const { rules, templates, ledger, decisions } = setup();
  rules.add('example.mixed', () => ({ answers: { mention: 0.95, pile: 'keep' }, confidence: 0.7, why: 'test rule' }));
  const def = asker({ template_id: 'example.mixed', questions: [{ id: 'mention', type: 'noul' }, { id: 'pile', type: 'choice', options: ['keep', 'unknown'] }] });
  await author(templates, ledger, def, [{ inputs: { subject: 'a' } }]);
  const d = await decisions.decide('example.mixed', { subject: 'a' });
  assert.equal(d?.confidence, 0.7, 'min(certainty 0.9, stated 0.7)');
});

test('a provider is only asked questions it can answer; the Jev stub declares Noul', async () => {
  assert.ok(new JevProvider().questionTypes.includes('noul'));
  let asked = 0;
  const choicesOnly: DecisionProvider = { id: 'choices-only', egress: 'none', questionTypes: ['choice', 'score'], decide: async () => { asked += 1; throw new Error('should not be asked'); } };
  const { rules, templates, ledger, decisions } = setup({ providers: (r) => [choicesOnly, r] });
  rules.add('example.ask', () => ({ answers: { mention: 0.2 }, confidence: 1, why: 'test rule' }));
  await author(templates, ledger, asker(), [{ inputs: { subject: 'a' } }]);
  const d = await decisions.decide('example.ask', { subject: 'a' });
  assert.equal(d?.provider, 'rules');
  assert.equal(asked, 0);
});
