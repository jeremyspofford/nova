// Scheduled runs and helpers as Work Ledger tasks (M2 §4): each is a task for the chat-run
// worker, a scheduled run traces to a heartbeat trigger record, "done" means Nova found the
// report in the conversation itself, queued work survives a restart, and the privacy rules
// are the ledger's. Through the HTTP API with the scripted model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce } from '../ui/js/reduce.js';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createCore, ensureMark } from '../src/core/index.ts';
import { SessionStore } from '../src/sessions.js';
import { Helpers } from '../src/helpers.js';
import { SYSTEM } from '../src/chat-run.js';

const root = new URL('..', import.meta.url).pathname;
const LA = 'America/Los_Angeles';
const fakeAgent = (delay = 1) => `FAKE_DELAY=${delay} node ${join(root, 'scripts/fake-agent.js')}`;

let nova;
let base;
before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-cr-'));
  ensureMark(home);
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'notes.md'), 'Example notes.\n');
  nova = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: fakeAgent(), NOVA_AGENT_EGRESS: 'none', NOVA_TZ: LA }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${nova.server.address().port}`;
});
after(async () => { nova.server.close(); await nova.core.close(); });

const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
const get = async (path) => (await fetch(base + path)).json();
const wait = async (check, tries = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};
const chatRunTasks = (n, kind) => n.core.ledger.list({ limit: 500 }).filter((t) => t.owner === 'chat-run' && t.brief.inputs.kind === kind);

test('a scheduled run is a heartbeat trigger record plus a chat-run task, done only once Nova finds the report in the conversation', async () => {
  nova.runner.schedules.set({ name: 'Example check', cron: '0 9 * * *', prompt: 'Say hello.' });
  assert.deepEqual(await (await post('/api/schedules/example-check/run')).json(), { queued: true });
  const task = await wait(() => chatRunTasks(nova, 'schedule').find((t) => t.brief.inputs.schedule === 'example-check' && t.state === 'done'));

  // The trigger record: a heartbeat from the schedule, triaged, and linked to the task.
  assert.equal(task.origin.kind, 'trigger');
  const trigger = await get(`/api/v1/triggers/${task.origin.ref}`);
  assert.deepEqual([trigger.class, trigger.source, trigger.rule_id, trigger.triage.decision, trigger.ledger_task_id], ['heartbeat', 'schedule:example-check', null, 'act', task.id]);

  // The task: owned by chat-run, its evidence a delivered report Nova read back itself.
  const full = await get(`/api/v1/tasks/${task.id}`);
  assert.equal(full.title, 'Example check');
  assert.deepEqual(full.report.evidence.map((e) => [e.kind, e.system]), [['confirmation', SYSTEM]]);
  assert.equal(full.verification.ok, true);
  assert.match(full.verification.checks[0].why, /^Nova read the main conversation itself: report \w{8} is there/);
  const events = (await get(`/api/v1/tasks/${task.id}/events`)).map((e) => e.kind);
  assert.deepEqual(events, ['created', 'dispatched', 'reported', 'verifying', 'verified']);
  const handoff = nova.store.read('main').find((e) => e.type === 'handoff' && e.id === full.report.evidence[0].id);
  assert.deepEqual([handoff.schedule, handoff.task, handoff.run], ['example-check', task.id, task.brief.inputs.run]);
  assert.equal(nova.store.read(handoff.run)[0].task, task.id, 'the run’s conversation names its task');
  assert.equal(nova.runner.schedules.latest().get('example-check').task, task.id, 'and so does the run record');
});

test('a run waiting for the person’s OK steps aside in the ledger, and comes back to hand over its report once answered', async () => {
  nova.runner.schedules.set({ name: 'Status check', cron: '0 9 * * *', prompt: 'Run git status.' });
  await post('/api/schedules/status-check/run');
  const waiting = await wait(() => chatRunTasks(nova, 'schedule').find((t) => t.brief.inputs.schedule === 'status-check' && t.state === 'waiting'));
  assert.equal(waiting.reason, 'Blocked: Waiting for your OK on a step.');
  assert.equal(waiting.user_visibility, 'attention');
  const { run } = waiting.brief.inputs;
  await post(`/api/sessions/${run}/approvals/${nova.runner.liveState(run).approval}`, { decision: 'deny' });
  const done = await wait(() => { const t = nova.core.ledger.get(waiting.id); return t.state === 'done' && t; });
  assert.equal(done.verification.ok, true);
  const events = nova.core.ledger.events(done.id);
  assert.deepEqual(events.map((e) => e.kind), ['created', 'dispatched', 'reported', 'blocked', 'retried', 'dispatched', 'reported', 'verifying', 'verified']);
  assert.match(events.find((e) => e.kind === 'retried').detail.reason, /finished after waiting for you/);
  assert.equal(reduce(nova.store.read(run)).turns.length, 1, 'the run went on where it was; it was not started again');
});

test('a due time is queued once: while it is on its way, and again after it ran', async () => {
  nova.runner.schedules.set({ name: 'Once only', cron: '0 9 * * *', prompt: 'Say hello.' });
  const due = new Date('2026-10-21T16:00:00Z');
  assert.equal(nova.scheduler.enqueue('once-only', { due }), true);
  assert.equal(nova.scheduler.enqueue('once-only', { due }), false, 'already on its way');
  await nova.scheduler.busy;
  await wait(() => chatRunTasks(nova, 'schedule').find((t) => t.brief.inputs.schedule === 'once-only' && t.state === 'done'));
  nova.scheduler.enqueue('once-only', { due }); // a second tick for the same time, say after a restart
  await nova.scheduler.busy;
  assert.equal(chatRunTasks(nova, 'schedule').filter((t) => t.brief.inputs.schedule === 'once-only').length, 1);
  assert.equal(nova.core.triggers.list().filter((t) => t.source === 'schedule:once-only').length, 1);
});

test('the nova-sessions checker reads the conversation itself: a report that isn’t there, or belongs to other work, doesn’t count', async () => {
  const task = chatRunTasks(nova, 'schedule').find((t) => t.state === 'done');
  const { run } = task.brief.inputs;
  const check = (id) => nova.chatRun.confirm({ kind: 'confirmation', system: SYSTEM, id }, task.brief);
  assert.equal(check(task.report.evidence[0].id).ok, true);
  assert.match(check('00000000').why, /doesn’t say report 00000000 was handed over/);
  // The run's log claims a delivery that never reached the conversation.
  nova.store.append(run, { type: 'delivered', to: 'main', handoff: 'ffffffff', ok: true, task: task.id });
  assert.deepEqual(check('ffffffff'), { ok: false, why: 'Nova read the main conversation itself and report ffffffff isn’t in it.' });
  // A report that is there, but for some other task.
  nova.store.append('main', { type: 'handoff', id: 'eeeeeeee', name: 'Other', ok: true, text: 'x', task: 'another-task' });
  nova.store.append(run, { type: 'delivered', to: 'main', handoff: 'eeeeeeee', ok: true, task: task.id });
  assert.match(check('eeeeeeee').why, /belongs to other work/);
});

test('a helper is a chat-run task linked to the conversation that asked, with the files it was given', async () => {
  const parent = nova.store.newId();
  nova.store.append(parent, { type: 'session', id: parent, title: 'Asking', v: 1 });
  const h = nova.helpers.spawn({ title: 'Summarize notes', task: 'Summarize my notes.', files: ['workspace/notes.md'], parent, turn: 't1' });
  const task = await wait(() => { const t = nova.core.ledger.get(h.task); return t.state === 'done' && t; });
  assert.deepEqual([task.owner, task.title, task.goal ?? task.brief.goal], ['chat-run', 'Summarize notes', 'Summarize my notes.']);
  assert.deepEqual(task.origin, { kind: 'user', ref: `session:${parent}/t1` });
  assert.deepEqual(task.brief.context_refs.map((r) => [r.kind, r.ref, r.sha256.length]), [['file', '~/workspace/notes.md', 64]]);
  assert.equal(task.verification.ok, true);
  const handoff = (await get(`/api/sessions/${parent}`)).session.turns.find((t) => t.kind === 'handoff');
  assert.equal(handoff.helper, h.run);
  assert.equal(nova.store.read(parent).find((e) => e.type === 'handoff').task, task.id);
  assert.equal(reduce(nova.store.read(h.run)).delivered.to, parent);
});

test('after a restart, a queued helper still runs; one that was working is not run again, and its conversation hears it didn’t finish', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-cr-restart-'));
  ensureMark(home);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const store = new SessionStore(home, LA);
  const parent = store.newId();
  store.append(parent, { type: 'session', id: parent, title: 'Asking', v: 1 });

  // The first Nova: its chat-run worker takes one helper at a time and never finishes it.
  const hang = { id: 'chat-run', name: 'chat-run', about: 'x', egress: 'none', evidence: ['confirmation'], health: () => ({ ok: true }), lane: (b) => ({ key: b.inputs.kind, max: 1 }), run: () => new Promise(() => {}) };
  const first = createCore({ home, version: '0.1.0', trustedOrigin: () => true, workers: [hang] });
  const helpers = new Helpers({ runner: { config: { home }, record: (id, ev) => store.append(id, ev) }, store, ledger: first.ledger });
  const working = helpers.spawn({ title: 'Working one', task: 'Summarize the first thing.', parent });
  const queued = helpers.spawn({ title: 'Queued one', task: 'Summarize the second thing.', parent });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([first.ledger.get(working.task).state, first.ledger.get(queued.task).state], ['active', 'queued']);
  store.append(working.run, { type: 'user', turn: 't1', text: 'Summarize the first thing.' }); // it had started
  first.db.close(); // Nova stops here

  const second = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: fakeAgent(), NOVA_AGENT_EGRESS: 'none', NOVA_TZ: LA }));
  try {
    const recovered = second.core.start();
    assert.deepEqual(recovered.requeued, [working.task]);
    const done = await wait(() => {
      const [a, b] = [second.core.ledger.get(working.task), second.core.ledger.get(queued.task)];
      return ['failed', 'cancelled', 'done'].includes(a.state) && b.state === 'done' && [a, b];
    });
    assert.equal(done[0].state, 'failed');
    assert.match(done[0].reason, /Working one didn't finish: Nova stopped before it was done\./);
    const said = reduce(second.store.read(parent)).turns.filter((t) => t.kind === 'handoff').map((t) => [t.name, t.ok]);
    assert.deepEqual(said.sort(), [['Queued one', true], ['Working one', false]]);
    assert.equal(reduce(second.store.read(working.run)).turns.length, 1, 'the interrupted helper was not run again');
    assert.equal(reduce(second.store.read(queued.run)).turns[0].state, 'done', 'the queued helper ran');
    assert.equal(await second.helpers.recover(), 0, 'nothing left for the old recovery to tell');
  } finally {
    await second.core.close();
  }
});

test('local-only with a model in the cloud: the ledger refuses a scheduled run (and says so) and a helper, and the model is never called', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-cr-privacy-'));
  ensureMark(home);
  const called = join(home, 'model-was-called');
  // Its egress is undeclared, so it counts as cloud.
  const n = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `touch ${called} && ${fakeAgent()}`, NOVA_TZ: LA }));
  try {
    assert.equal(n.core.profile.privacyDefault(), 'local-only');
    n.runner.schedules.set({ name: 'Example check', cron: '0 9 * * *', prompt: 'Say hello.' });
    assert.equal(n.scheduler.runNow('example-check'), true);
    await n.scheduler.busy;
    const said = reduce(n.store.read('main')).turns.find((t) => t.kind === 'handoff');
    assert.equal(said.ok, false);
    assert.match(said.text, /^Example check didn't run\. Nova couldn't start the task for "Example check": Nova's chat model \(touch\) sends data off your devices, and this task is local-only/);
    const [trigger] = n.core.triggers.list().filter((t) => t.source === 'schedule:example-check');
    assert.deepEqual([trigger.triage.decision, trigger.ledger_task_id], ['drop', null]);
    assert.equal(chatRunTasks(n, 'schedule').length, 0);
    assert.equal(n.runner.schedules.latest().get('example-check').ok, false);

    const parent = n.store.newId();
    n.store.append(parent, { type: 'session', id: parent, title: 'Asking', v: 1 });
    assert.throws(() => n.helpers.spawn({ task: 'Summarize my notes.', parent }), /sends data off your devices, and this task is local-only/);
    await n.core.ledger.idle();
    assert.equal(existsSync(called), false, 'the model command never ran');
  } finally {
    await n.core.close();
  }
});

test('work queued under a looser setting waits on local capacity once the setting is local-only; Activity shows it waiting its turn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-cr-privacy-'));
  ensureMark(home);
  const called = join(home, 'model-was-called');
  const n = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `touch ${called} && ${fakeAgent()}`, NOVA_TZ: LA }));
  await new Promise((r) => n.server.listen(0, '127.0.0.1', r));
  try {
    n.core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    const parent = n.store.newId();
    n.store.append(parent, { type: 'session', id: parent, title: 'Asking', v: 1 });
    const h = n.helpers.spawn({ title: 'Cloud work', task: 'Summarize my notes.', parent });
    n.core.profile.set('privacy', 'default', 'local-only', 'settings'); // before it starts
    await n.core.ledger.idle();
    const t = n.core.ledger.get(h.task);
    assert.equal(t.privacy_mode, 'cloud-allowed');
    assert.equal(t.state, 'waiting');
    assert.match(t.reason, /Waiting on local capacity: Nova's chat model \(touch\) would send this off your devices, and your privacy setting is local-only\./);
    assert.equal(t.user_visibility, 'attention');
    assert.equal(existsSync(called), false, 'the model command never ran');

    const a = await (await fetch(`http://localhost:${n.server.address().port}/api/activity`)).json();
    const entry = a.now.find((e) => e.session === h.run);
    assert.deepEqual([entry.kind, entry.state, entry.title, entry.task], ['helper', 'queued', 'Cloud work', h.task]);
    assert.equal(a.busy.working, 1);

    // Loosening the setting again releases it, without anyone retrying it by hand.
    n.core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    for (let i = 0; i < 200 && !existsSync(called); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(existsSync(called), true, 'the run went ahead once the setting allowed it');
    assert.ok(n.core.ledger.events(h.task).some((e) => e.kind === 'retried' && /privacy setting changed/.test(e.detail?.reason ?? '')));
  } finally {
    n.server.close();
    await n.core.close();
  }
});
