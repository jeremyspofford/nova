import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Profile } from '../../src/core/profile.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import { Decisions, JevProvider, RulesProvider, Templates, type DecisionProvider } from '../../src/core/decide.ts';
import { Triggers, type RuleInput } from '../../src/core/triggers.ts';

function setup(opts: { providers?: (rules: RulesProvider) => DecisionProvider[]; at?: string } = {}) {
  const db = new Db(':memory:');
  db.migrate();
  let clock = new Date(opts.at ?? '2026-03-02T12:00:10Z');
  const now = () => clock;
  const log = new Log(db, null);
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-triggers-')), 'workspace'));
  const verifier = new Verifier(ws, now);
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules, now });
  const profile = new Profile(db, now);
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(ws), templates.worker], defaultPrivacy: () => profile.privacyDefault(), now });
  templates.bind(ledger);
  const decisions = new Decisions({ templates, providers: opts.providers?.(rules) ?? [rules], privacy: () => profile.privacyDefault(), log });
  const triggers = new Triggers({
    db, log, ledger, templates, rules, decisions, now,
    policy: () => profile.section('policy'),
    timezone: () => profile.get<string>('user', 'timezone') ?? 'UTC',
  });
  const seen: string[] = [];
  triggers.on('trigger', (t) => seen.push(t.triage.decision));
  return { db, log, ledger, profile, templates, triggers, seen, at: (iso: string) => { clock = new Date(iso); return clock; } };
}

const note = (path = 'notes/hook.md'): RuleInput['action'] => ({
  kind: 'task',
  task: { title: 'Note the event', owner: 'workspace', goal: 'The event is noted.', evidence_required: [{ kind: 'read_back', target: `workspace:${path}` }], inputs: { action: 'write', path, content: 'event\n' } },
});

test('triage.v1 ships as an active template, and a webhook rule turns an event into a ledger task traced to its trigger', async () => {
  const { templates, triggers, ledger } = setup();
  assert.equal(templates.get('triage')?.state, 'active');
  assert.equal(templates.get('triage')?.version, 1);

  const created = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note() }, 'person');
  assert.equal(created.rule.source, 'webhook:example');
  assert.match(created.token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(JSON.stringify(triggers.listRules()).includes(created.token), false, 'the token is shown once, never listed');
  assert.equal(JSON.stringify(triggers.listRules()).includes('hook_token_hash'), false);

  const t = await triggers.hook('example', created.token, { n: 1 });
  assert.equal(t.triage.decision, 'act');
  assert.deepEqual(t.triage.model, { provider: 'rules', template_id: 'triage', version: 1 });
  assert.ok(t.ledger_task_id);
  assert.match(t.payload_ref ?? '', /^[0-9a-f]{64}$/);
  const task = ledger.get(t.ledger_task_id!);
  assert.deepEqual(task.origin, { kind: 'trigger', ref: t.trigger_id });
  await ledger.idle();
  assert.equal(ledger.get(task.id).state, 'done');
  assert.equal(templates.get('triage')?.stats.uses, 1);
});

test('webhooks: unknown is not found, a wrong or missing token is refused, a paused rule records a drop', async () => {
  const { triggers, ledger } = setup();
  const { rule, token } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note() }, 'person');
  await assert.rejects(triggers.hook('nothing', token, {}), { name: 'CoreError', code: 'not_found' });
  await assert.rejects(triggers.hook('example', 'wrong', {}), { name: 'CoreError', code: 'forbidden' });
  await assert.rejects(triggers.hook('example', undefined, {}), { name: 'CoreError', code: 'forbidden' });
  assert.equal(triggers.list().length, 0, 'refused calls are not firings');

  triggers.pause(rule.id);
  const t = await triggers.hook('example', token, {});
  assert.equal(t.triage.decision, 'drop');
  assert.match(t.triage.reason, /paused/i);
  assert.equal(t.ledger_task_id, null);
  assert.equal(ledger.list().length, 0);
});

test('dedup: the same event within the window is dropped as the same as the earlier one', async () => {
  const { triggers, at } = setup();
  const { token } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note(), dedup_window_s: 60 }, 'person');
  const first = await triggers.hook('example', token, { n: 1 });
  at('2026-03-02T12:00:40Z');
  const second = await triggers.hook('example', token, { n: 1 });
  assert.equal(second.triage.decision, 'drop');
  assert.equal(second.triage.reason, `Same as trigger ${first.trigger_id}.`);
  assert.equal(second.dedup_key, first.dedup_key);
  const other = await triggers.hook('example', token, { n: 2 });
  assert.equal(other.triage.decision, 'act');
  const keyed = await triggers.hook('example', token, { n: 3 }, 'fact-1');
  const keyedAgain = await triggers.hook('example', token, { n: 4 }, 'fact-1');
  assert.equal(keyed.triage.decision, 'act');
  assert.equal(keyedAgain.triage.decision, 'drop', 'an explicit dedup key wins over the payload');
  at('2026-03-02T12:02:00Z');
  assert.equal((await triggers.hook('example', token, { n: 1 })).triage.decision, 'act', 'after the window it counts again');
});

test('cooldown: a rule that just acted stays silent until the cooldown ends', async () => {
  const { triggers, at } = setup();
  const { token } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note(), cooldown_s: 300, dedup_window_s: 0 }, 'person');
  const first = await triggers.hook('example', token, { n: 1 });
  assert.equal(first.cooldown_until, '2026-03-02T12:05:10.000Z');
  at('2026-03-02T12:01:00Z');
  const second = await triggers.hook('example', token, { n: 2 });
  assert.equal(second.triage.decision, 'silent');
  assert.match(second.triage.reason, /Cooling down until 2026-03-02T12:05:10/);
  at('2026-03-02T12:06:00Z');
  assert.equal((await triggers.hook('example', token, { n: 3 })).triage.decision, 'act');
});

test('batching: an event while the rule’s earlier task is still waiting is added to it, not made a second task', async () => {
  const { triggers, ledger } = setup();
  const action = note();
  if (action.kind === 'task') action.task.approval_tier = 2;
  const { token } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action }, 'person');
  const first = await triggers.hook('example', token, { n: 1 });
  await ledger.idle();
  assert.equal(ledger.get(first.ledger_task_id!).state, 'waiting');
  const second = await triggers.hook('example', token, { n: 2 });
  assert.equal(second.triage.decision, 'queue');
  assert.equal(second.triage.reason, 'Added to "Note the event".');
  assert.equal(second.ledger_task_id, first.ledger_task_id);
  assert.equal(ledger.list().length, 1);
});

test('a proactive message traces to its trigger; in quiet hours it is held, then delivered when they end', async () => {
  const { triggers, profile, at, seen } = setup({ at: '2026-03-02T23:00:00Z' });
  profile.set('user', 'timezone', 'UTC', 'settings');
  profile.set('policy', 'quiet_hours', { start: '22:00', end: '07:00' }, 'settings');
  const { rule } = triggers.createRule({ name: 'Check-in', class: 'proactive', action: { kind: 'message', text: 'A reminder you asked for.' } }, 'person');
  const delivered: string[] = [];
  triggers.on('message', (m) => delivered.push(m.id));

  const t = await triggers.fireRule(rule.id, { n: 1 });
  assert.equal(t.triage.decision, 'queue');
  assert.match(t.triage.reason, /quiet hours/i);
  const [held] = triggers.messages({ state: 'held' });
  assert.equal(held?.id, t.message_id);
  assert.equal(held?.delivered_at, null);
  assert.deepEqual(triggers.messages(), [], 'nothing is delivered in quiet hours');

  await triggers.tick(at('2026-03-03T06:59:00Z'));
  assert.equal(triggers.messages().length, 0);
  await triggers.tick(at('2026-03-03T07:00:30Z'));
  const [msg] = triggers.messages();
  assert.equal(msg?.text, 'A reminder you asked for.');
  assert.equal(msg?.delivered_at, '2026-03-03T07:00:30.000Z');
  assert.deepEqual(delivered, [msg!.id]);
  const origin = triggers.get(msg!.trigger_id);
  assert.equal(origin.trigger_id, t.trigger_id);
  assert.equal(origin.message_id, msg!.id);
  assert.equal(origin.class, 'proactive');
  assert.ok(seen.includes('queue'));

  const read = triggers.read(msg!.id);
  assert.equal(read.read_at, '2026-03-03T07:00:30.000Z');

  const outside = await triggers.fireRule(rule.id, { n: 2 });
  assert.equal(outside.triage.decision, 'act');
  assert.equal(triggers.messages().length, 2);
});

test('a category the person turned off is dropped, with the reason', async () => {
  const { triggers, profile } = setup();
  profile.set('policy', 'proactive_off', ['proactive'], 'settings');
  const { rule } = triggers.createRule({ name: 'Check-in', class: 'proactive', action: { kind: 'message', text: 'Hello.' } }, 'person');
  const t = await triggers.fireRule(rule.id, {});
  assert.equal(t.triage.decision, 'drop');
  assert.match(t.triage.reason, /turned off/i);
  assert.equal(t.message_id, null);
});

test('heartbeat: a due time runs once, however many times Nova ticks (claim-once)', async () => {
  const { triggers, ledger, db, at } = setup();
  const { rule } = triggers.createRule({ name: 'Every minute', class: 'heartbeat', cron: '* * * * *', action: note('notes/beat.md') }, 'person');
  assert.deepEqual(await triggers.tick(at('2026-03-02T12:00:50Z')), [], 'nothing is due yet');
  const fired = await triggers.tick(at('2026-03-02T12:01:05Z'));
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.claim_key, `rule:${rule.id}@2026-03-02T12:01:00.000Z`);
  assert.equal((await triggers.tick(at('2026-03-02T12:01:05Z'))).length, 0);
  db.run('UPDATE trigger_rule SET last_due_at = NULL WHERE id = ?', rule.id); // as if two ticks raced
  assert.equal((await triggers.tick(at('2026-03-02T12:01:06Z'))).length, 0, 'the claim holds even when the rule forgets');
  assert.equal(ledger.list().length, 1);

  const caught = await triggers.tick(at('2026-03-02T12:03:30Z'));
  assert.equal(caught.length, 1, 'two missed minutes catch up once');
  assert.equal(caught[0]?.claim_key, `rule:${rule.id}@2026-03-02T12:03:00.000Z`);
  await ledger.idle();
  assert.equal(ledger.list().length, 2);
  assert.ok(ledger.list().every((t) => t.state === 'done' && t.origin.kind === 'trigger'));
});

test('heartbeat: runs missed more than 6 hours ago are recorded as dropped; the latest recent one catches up', async () => {
  const { triggers, ledger, at } = setup({ at: '2026-03-02T00:00:30Z' });
  const { rule } = triggers.createRule({ name: 'Hourly', class: 'heartbeat', cron: '0 * * * *', action: note('notes/hourly.md') }, 'person');
  const out = await triggers.tick(at('2026-03-02T10:30:00Z'));
  assert.deepEqual(out.map((t) => t.triage.decision), ['drop', 'act']);
  assert.equal(out[0]?.triage.reason, 'Missed while Nova was off.');
  assert.equal(out[1]?.claim_key, `rule:${rule.id}@2026-03-02T10:00:00.000Z`);
  assert.equal(ledger.list().length, 1);
  assert.equal((await triggers.tick(at('2026-03-02T10:31:00Z'))).length, 0);
});

test('a paused heartbeat does not run, and does not catch up for the time it was paused', async () => {
  const { triggers, ledger, at } = setup();
  const { rule } = triggers.createRule({ name: 'Every minute', class: 'heartbeat', cron: '* * * * *', action: note('notes/beat.md') }, 'person');
  triggers.pause(rule.id);
  assert.equal((await triggers.tick(at('2026-03-02T12:05:00Z'))).length, 0);
  triggers.resume(rule.id);
  assert.equal((await triggers.tick(at('2026-03-02T12:05:30Z'))).length, 0);
  assert.equal((await triggers.tick(at('2026-03-02T12:06:01Z'))).length, 1);
  assert.equal(ledger.list().length, 1);
});

test('in local-only mode the remote decision provider is never called, even when registered first', async () => {
  let calls = 0;
  const jev = new JevProvider();
  const spy: DecisionProvider = { id: jev.id, egress: jev.egress, questionTypes: jev.questionTypes, decide: (t, i) => { calls += 1; return jev.decide(t, i); } };
  const { triggers, profile } = setup({ providers: (rules) => [spy, rules] });
  assert.equal(profile.privacyDefault(), 'local-only');
  const { rule } = triggers.createRule({ name: 'Check-in', class: 'proactive', action: { kind: 'message', text: 'Hello.' } }, 'person');
  const t = await triggers.fireRule(rule.id, {});
  assert.equal(t.triage.model?.provider, 'rules');
  assert.equal(calls, 0);
});

test('an unsure triage does not act alone: the task waits for the person', async () => {
  const unsure: DecisionProvider = { id: 'unsure', egress: 'none', questionTypes: ['choice'], decide: async (t) => ({ template_id: t.template_id, version: t.version, answers: { decision: 'act' }, confidence: 0.2, provider: 'unsure', escalate: false, why: 'guessing' }) };
  const { triggers, ledger } = setup({ providers: (rules) => [unsure, rules] });
  const { token } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note() }, 'person');
  const t = await triggers.hook('example', token, {});
  assert.equal(t.triage.decision, 'queue');
  assert.match(t.triage.reason, /not sure/i);
  await ledger.idle();
  const task = ledger.get(t.ledger_task_id!);
  assert.equal(task.state, 'waiting');
  assert.equal(task.reason, 'Needs your OK before it runs.');
});

test('with the triage template retired, triage falls back to the local rules and says no model was used', async () => {
  const { triggers, templates } = setup();
  templates.retire('triage', 1, 'test');
  const { rule } = triggers.createRule({ name: 'Check-in', class: 'proactive', action: { kind: 'message', text: 'Hello.' } }, 'person');
  const t = await triggers.fireRule(rule.id, {});
  assert.equal(t.triage.decision, 'act');
  assert.equal(t.triage.model, null);
});

test('a firing whose rule lives elsewhere (a schedule file) brings its own action: recorded, triaged, claimed once, and traced to its task', async () => {
  const { triggers, ledger, profile } = setup();
  const input = { class: 'heartbeat' as const, source: 'schedule:example', name: 'Example schedule', payload: { due: '2026-03-02T12:00:00.000Z' }, claim_key: 'schedule:example@2026-03-02T12:00:00.000Z', action: note('notes/schedule.md') };
  const t = await triggers.fire(input);
  assert.ok(t);
  assert.deepEqual([t.class, t.source, t.rule_id, t.triage.decision], ['heartbeat', 'schedule:example', null, 'act']);
  const task = ledger.get(t.ledger_task_id!);
  assert.deepEqual(task.origin, { kind: 'trigger', ref: t.trigger_id });
  assert.equal(await triggers.fire(input), null, 'the same due time is claimed once');
  await ledger.idle();
  assert.equal(ledger.get(task.id).state, 'done');

  // Turned off by name in the person's policy: dropped. A task the ledger refuses: dropped, with the reason.
  profile.set('policy', 'proactive_off', ['example schedule'], 'settings');
  const off = await triggers.fire({ ...input, claim_key: 'schedule:example@2026-03-02T13:00:00.000Z' });
  assert.equal(off?.triage.decision, 'drop');
  assert.equal(off?.ledger_task_id, null);
  profile.set('policy', 'proactive_off', [], 'settings');
  const refused = await triggers.fire({ ...input, claim_key: 'schedule:example@2026-03-02T14:00:00.000Z', action: { kind: 'task', task: { ...(note() as { kind: 'task'; task: Record<string, unknown> }).task, owner: 'nobody' } } as never });
  assert.equal(refused?.triage.decision, 'drop');
  assert.match(refused?.triage.reason ?? '', /Nova couldn't start the task for "Example schedule": There is no worker called "nobody"/);
});

test('a task the person delegates is recorded as a reactive trigger linked to it', () => {
  const { triggers, ledger } = setup();
  const task = ledger.create({ title: 'Write a note', owner: 'workspace', goal: 'g', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'workspace:a.md' }], inputs: { action: 'write', path: 'a.md', content: 'a' } });
  const t = triggers.reactive(task);
  assert.equal(t.class, 'reactive');
  assert.equal(t.rule_id, null);
  assert.equal(t.ledger_task_id, task.id);
  assert.equal(t.triage.decision, 'act');
});

test('the registry: rules are validated, editable, pausable and removable, and every change is kept', () => {
  const { triggers } = setup();
  assert.throws(() => triggers.createRule({ name: '', class: 'event', hook: 'x', action: note() }, 'person'), /name/);
  assert.throws(() => triggers.createRule({ name: 'Bad', class: 'heartbeat', cron: 'every so often', action: note() }, 'person'), /five parts/);
  assert.throws(() => triggers.createRule({ name: 'Bad', class: 'event', hook: 'Not A Name', action: note() }, 'person'), /hook/);
  assert.throws(() => triggers.createRule({ name: 'Bad', class: 'proactive', action: { kind: 'message', text: '' } }, 'person'), /text/);
  assert.throws(() => triggers.createRule({ name: 'Bad', class: 'proactive', action: { kind: 'task', task: { ...(note() as { task: Record<string, unknown> }).task, owner: 'nobody' } } } as RuleInput, 'person'), /nobody/);
  assert.throws(() => triggers.createRule({ name: 'Bad', class: 'nightly', action: note() } as unknown as RuleInput, 'person'), /class/);

  const { rule } = triggers.createRule({ name: 'Example events', class: 'event', hook: 'example', action: note() }, 'person');
  assert.throws(() => triggers.createRule({ name: 'Again', class: 'event', hook: 'example', action: note() }, 'person'), /already a webhook/);
  const beat = triggers.createRule({ name: 'Mornings', class: 'heartbeat', cron: '0 7 * * 1-5', action: note() }, 'person').rule;
  assert.equal(beat.schedule, 'Weekdays at 7:00 AM');
  assert.equal(triggers.updateRule(rule.id, { name: 'Renamed', cooldown_s: 30 }).name, 'Renamed');
  assert.throws(() => triggers.updateRule(rule.id, { cooldown_s: -1 }), /cooldown_s/);
  assert.equal(triggers.pause(rule.id).paused, true);
  assert.equal(triggers.resume(rule.id).paused, false);
  triggers.deleteRule(rule.id);
  assert.throws(() => triggers.rule(rule.id), /No trigger rule/);
  assert.deepEqual(triggers.ruleEvents(rule.id).map((e) => e.kind), ['created', 'updated', 'paused', 'resumed', 'deleted']);
  assert.equal(triggers.listRules().length, 1);
});
