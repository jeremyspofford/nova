// Scheduled Nova: cron in words and in time, schedule files, the scheduler's
// catch-up rules, and runs end to end through the HTTP API with the scripted
// model, from "Run now" to the report in the main conversation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCron, lastRun, nextRun, parseCron } from '../src/cron.js';
import { Schedules, formatWhen } from '../src/schedules.js';
import { Scheduler } from '../src/scheduler.js';
import { TOOLS } from '../src/tools.js';
import { buildPrompt } from '../src/context.js';
import { reduce } from '../ui/js/reduce.js';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ensureMark } from '../src/core/index.ts';

const root = new URL('..', import.meta.url).pathname;
const LA = 'America/Los_Angeles';
const at = (iso) => new Date(iso);
const local = (d, tz = LA) => d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

test('cron in words', () => {
  const words = {
    '0 7 * * *': 'Every day at 7:00 AM',
    '0 7 * * 1-5': 'Weekdays at 7:00 AM',
    '30 8 * * sat,sun': 'Weekends at 8:30 AM',
    '0 9 * * 1,3,5': 'Mondays, Wednesdays and Fridays at 9:00 AM',
    '0 9,17 * * *': 'Every day at 9:00 AM and 5:00 PM',
    '0 12 * * 0': 'Sundays at 12:00 PM',
    '15 * * * *': 'Every hour at :15',
    '0 * * * 1-5': 'Every hour, on the hour, on weekdays',
    '*/15 * * * *': 'Every 15 minutes',
    '0 */2 * * *': 'Every 2 hours',
    '0 9 1 * *': 'On the 1st of every month at 9:00 AM',
    '0 9 21 10 *': 'Every year on October 21 at 9:00 AM',
    '0 7 * 6-8 *': 'Every day in June, July and August at 7:00 AM',
    '0 0 * * 7': 'Sundays at 12:00 AM',
    '7 3 */3 * *': 'On a custom schedule (7 3 */3 * *)',
  };
  for (const [cron, said] of Object.entries(words)) assert.equal(describeCron(cron), said, cron);
  assert.throws(() => parseCron('1 2 3 4'), /five parts/);
  assert.throws(() => parseCron('61 * * * *'), /out of range for the minute/);
  assert.throws(() => parseCron('0 7 * * funday'), /isn't a valid day of the week/);
  assert.throws(() => parseCron('0 9-5 * * *'), /runs backwards/);
});

test('cron in time: the person’s timezone, daylight saving, both kinds of day', () => {
  assert.equal(local(nextRun('0 7 * * *', at('2026-10-21T19:00:00Z'), LA)), 'Thu, Oct 22, 7:00 AM');
  assert.equal(local(nextRun('0 7 * * 1-5', at('2026-10-23T15:00:00Z'), LA)), 'Mon, Oct 26, 7:00 AM'); // Friday after 7 → Monday
  assert.equal(nextRun('0 7 * * *', at('2026-10-21T19:00:00Z'), 'Asia/Kolkata').toISOString(), '2026-10-22T01:30:00.000Z');
  // 2:30 AM doesn't exist on March 8 in Los Angeles: it runs just after the change.
  assert.equal(local(nextRun('30 2 * * *', at('2026-03-07T12:00:00Z'), LA)), 'Sun, Mar 8, 3:30 AM');
  // 1:30 AM happens twice on November 1: it runs once.
  const first = nextRun('30 1 * * *', at('2026-10-31T12:00:00Z'), LA);
  assert.equal(first.toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(local(nextRun('30 1 * * *', first, LA)), 'Mon, Nov 2, 1:30 AM');
  // Day of the month and day of the week both set: either one will do.
  assert.equal(local(nextRun('0 9 13 * 5', at('2026-10-21T19:00:00Z'), LA)), 'Fri, Oct 23, 9:00 AM');
  assert.equal(nextRun('0 0 30 2 *', at('2026-10-21T19:00:00Z'), LA), null);
  assert.equal(local(lastRun('0 7 * * *', at('2026-10-18T00:00:00Z'), at('2026-10-21T19:00:00Z'), LA)), 'Wed, Oct 21, 7:00 AM');
  assert.equal(formatWhen(at('2026-10-22T14:00:00Z'), LA), 'Thursday, October 22 at 7:00 AM');
});

const homes = () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-sc-'));
  return { home, schedules: new Schedules(root, home, LA) };
};

test('schedule files: set, check, change, pause, remove and put back', () => {
  const { home, schedules } = homes();
  assert.deepEqual(schedules.available().map((s) => s.id), ['morning-digest']);
  assert.throws(() => schedules.plan({ cron: '0 7 * * *', prompt: 'x' }), /needs a name/);
  assert.throws(() => schedules.plan({ name: 'Bills', cron: '0 7 * *', prompt: 'x' }), /five parts/);
  assert.throws(() => schedules.plan({ name: 'Bills', cron: '0 7 * * *' }), /needs instructions/);
  assert.throws(() => schedules.plan({ name: 'Bills', cron: '0 0 30 2 *', prompt: 'x' }), /never happens/);
  assert.throws(() => schedules.plan({ id: 'nope', name: 'Bills', cron: '0 7 * * *', prompt: 'x' }), /no schedule with the id nope/);

  const plan = schedules.plan({ name: 'Bills check', cron: '0 9 * * 1', prompt: 'Look for bills due this week.' }, { from: '2026-10-21-abc123' });
  assert.deepEqual([plan.id, plan.when, plan.deliver, plan.replaces], ['bills-check', 'Mondays at 9:00 AM', '2026-10-21-abc123', null]);
  assert.match(plan.next, /^Monday, \w+ \d+ at 9:00 AM$/);
  assert.equal(schedules.plan({ name: 'x', cron: '0 9 * * 1', prompt: 'y', deliver: 'main' }, { from: '2026-10-21-abc123' }).deliver, 'main');

  schedules.set({ name: 'Bills check', cron: '0 9 * * 1', prompt: 'Look for bills due this week.' });
  assert.match(readFileSync(join(home, 'schedules', 'bills-check.md'), 'utf8'), /^---\nname: Bills check\ncron: 0 9 \* \* 1\ndeliver: main\n---\n\nLook for bills due this week\.\n$/);
  assert.throws(() => schedules.plan({ name: 'Bills check', cron: '0 9 * * 1', prompt: 'again' }), /already a schedule called Bills check \(id bills-check\)/);
  const changed = schedules.set({ id: 'bills-check', name: 'Bills check', cron: '0 8 * * 1', prompt: 'Earlier.' });
  assert.deepEqual([changed.when, changed.prompt], ['Mondays at 8:00 AM', 'Earlier.']);

  const once = schedules.set({ name: 'Call the dentist', cron: '0 9 22 10 *', prompt: 'Remind them.', once: true });
  assert.match(once.when, /^Once, on \w+day, October 22 at 9:00 AM$/); // the weekday depends on which year October 22 is next

  assert.equal(schedules.setPaused('bills-check', true).paused, true);
  assert.equal(schedules.next(schedules.get('bills-check')), null);
  assert.equal(schedules.setPaused('bills-check', false).paused, false);

  const { text } = schedules.remove('bills-check');
  assert.equal(schedules.get('bills-check'), null);
  assert.throws(() => schedules.remove('bills-check'), /already gone/);
  schedules.restore('bills-check', text);
  assert.equal(schedules.get('bills-check').when, 'Mondays at 8:00 AM');

  assert.throws(() => schedules.setup('morning-digest', { time: '25:00' }), /Pick a time/);
  assert.throws(() => schedules.setup('morning-digest', { days: 'sometimes' }), /every day, weekdays or weekends/);
  const digest = schedules.setup('morning-digest', { time: '6:45', days: 'weekdays' });
  assert.deepEqual([digest.cron, digest.when, digest.deliver], ['45 6 * * 1-5', 'Weekdays at 6:45 AM', 'main']);
  assert.match(digest.about, /front page/);
  assert.throws(() => schedules.setup('morning-digest'), /already set up/);
  assert.deepEqual(schedules.available(), []);

  writeFileSync(join(home, 'schedules', 'broken.md'), '---\nname: Broken\ncron: every morning\n---\n\nDo it.\n');
  assert.match(schedules.get('broken').error, /can't read when this runs/);
});

test('Nova can’t write schedule files around the approval', async () => {
  const { home } = homes();
  await assert.rejects(TOOLS.write_file.run({ path: 'schedules/sneaky.md', content: 'x' }, { home }), /schedule_set, which the person approves/);
});

test('the scheduler catches up once on a run missed in the last six hours, and records older ones as missed', async () => {
  const { home, schedules } = homes();
  schedules.set({ name: 'Morning digest', cron: '0 7 * * *', prompt: 'digest' });
  const file = join(home, 'schedules', 'morning-digest.md');
  const twoDaysAgo = at('2026-10-19T20:00:00Z');
  utimesSync(file, twoDaysAgo, twoDaysAgo);
  const ran = [];
  const make = (iso) => {
    const s = new Scheduler({ schedules, runner: null, store: null, timezone: LA, now: () => at(iso) });
    s.enqueue = (id, how) => { ran.push({ id, due: how.due.toISOString(), late: how.late }); return true; };
    return s;
  };
  // Nova starts at 9 AM; 7 AM was missed: it runs now, late.
  make('2026-10-21T16:00:00Z').tick();
  assert.deepEqual(ran, [{ id: 'morning-digest', due: '2026-10-21T14:00:00.000Z', late: true }]);
  // Nova starts at 8 PM: too late for a morning digest. Recorded as missed.
  ran.length = 0;
  const evening = make('2026-10-22T03:00:00Z');
  evening.tick();
  assert.deepEqual(ran, []);
  assert.deepEqual(schedules.runs().map((r) => [r.missed, r.due]), [[true, '2026-10-21T14:00:00.000Z']]);
  // Then it runs on time the next morning.
  evening.now = () => at('2026-10-22T14:00:10Z');
  evening.tick();
  assert.deepEqual(ran, [{ id: 'morning-digest', due: '2026-10-22T14:00:00.000Z', late: false }]);
  // Paused: nothing.
  ran.length = 0;
  schedules.setPaused('morning-digest', true);
  evening.now = () => at('2026-10-23T14:00:10Z');
  evening.tick();
  assert.deepEqual(ran, []);
});

// ---- end to end ----------------------------------------------------------------

let nova;
let base;
before(async () => {
  nova = createNova(loadConfig({
    NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-se-')),
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none',
    NOVA_TZ: LA,
  }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${nova.server.address().port}`;
});
after(() => nova.server.close());

const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
const get = async (path) => (await fetch(base + path)).json();
const wait = async (check) => {
  for (let i = 0; i < 300; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};
const main = () => get('/api/sessions/main');

test('the main conversation is there from the start, and not in the list', async () => {
  const m = await main();
  assert.deepEqual([m.session.id, m.session.title, m.session.turns.length], ['main', 'Main conversation', 0]);
  assert.deepEqual(await get('/api/sessions'), []);
  const v = await get('/api/schedules');
  assert.deepEqual([v.set, v.available.map((s) => s.id), v.timezone], [[], ['morning-digest'], LA]);
});

test('the morning digest: set up, run now, and its report lands in the main conversation', async () => {
  assert.equal((await post('/api/schedules/morning-digest/setup', { time: '7:00', days: 'every' })).status, 200);
  let v = await get('/api/schedules');
  assert.deepEqual([v.set[0].when, v.available], ['Every day at 7:00 AM', []]);
  assert.ok(Date.parse(v.set[0].next) > Date.now());

  assert.deepEqual(await (await post('/api/schedules/morning-digest/run')).json(), { queued: true });
  const m = await wait(async () => { const s = await main(); return s.session.turns.length && s; });
  const report = m.session.turns[0];
  assert.deepEqual([report.kind, report.name, report.ok, report.late], ['handoff', 'Morning digest', true, false]);
  assert.match(report.text, /^A quiet morning: nothing is due today\.\n\n\*\*Needs you\*\*/);

  // The run itself is a conversation log of its own, not listed.
  assert.deepEqual(await get('/api/sessions'), []);
  const run = reduce(nova.store.read(report.run));
  assert.equal(run.turns[0].text, nova.runner.schedules.get('morning-digest').prompt);
  v = await wait(async () => { const x = await get('/api/schedules'); return !x.set[0].running && x.set[0].last && x; });
  assert.deepEqual([v.set[0].last.ok, v.set[0].last.delivered, v.set[0].last.handoff, v.set[0].last.run], [true, 'main', report.id, report.run]);

  // The next message in the main conversation sees the report; Regenerate doesn't touch it.
  assert.equal((await post('/api/sessions/main/regenerate')).status, 409);
  const prompt = buildPrompt(m.session, [], { timezone: LA });
  assert.match(prompt, /<handoff from="Morning digest" schedule="morning-digest" time="[^"]+">\nA quiet morning/);
});

test('a scheduled run waits for an OK without holding up the others; with its switch on, it goes ahead', async () => {
  nova.runner.schedules.set({ name: 'Standup check', cron: '0 9 * * 1-5', prompt: 'Run git status before standup.' });
  nova.runner.schedules.set({ name: 'Quiet one', cron: '0 9 * * 1-5', prompt: 'Say hello.' });
  await post('/api/schedules/standup-check/run');
  await wait(() => nova.scheduler.waiting.has('standup-check'));
  const waiting = (await get('/api/schedules')).set.find((s) => s.id === 'standup-check');
  assert.equal(waiting.running.waiting, true);
  // The next schedule runs while the first one waits.
  await post('/api/schedules/quiet-one/run');
  await wait(async () => (await main()).session.turns.find((t) => t.schedule === 'quiet-one'));
  assert.ok(nova.scheduler.waiting.has('standup-check'));
  const { run } = nova.scheduler.waiting.get('standup-check');
  await post(`/api/sessions/${run}/approvals/${nova.runner.liveState(run).approval}`, { decision: 'allow' });
  const h = await wait(async () => (await main()).session.turns.find((t) => t.schedule === 'standup-check'));
  const exec = reduce(nova.store.read(h.run)).turns[0].items.find((i) => i.kind === 'tool');
  assert.deepEqual([exec.name, exec.approval.decision, !!exec.approval.auto, exec.result.ok], ['exec', 'allow', false, true]);
  assert.match(h.text, /nothing to commit/);
  await wait(() => !nova.scheduler.waiting.has('standup-check'));

  nova.runner.permissions.set('commands', true);
  try {
    await post('/api/schedules/standup-check/run');
    const again = await wait(async () => (await main()).session.turns.filter((t) => t.schedule === 'standup-check')[1]);
    const step = reduce(nova.store.read(again.run)).turns[0].items.find((i) => i.kind === 'tool');
    assert.deepEqual([step.approval.decision, step.approval.auto, step.result.ok], ['allow', true, true]);
  } finally { nova.runner.permissions.set('commands', false); }
  nova.runner.schedules.remove('quiet-one');
});

test('a run that fails says so in the main conversation', async () => {
  nova.runner.schedules.set({ name: 'Doomed', cron: '0 9 * * *', prompt: 'Please fail.' });
  await post('/api/schedules/doomed/run');
  const h = await wait(async () => (await main()).session.turns.find((t) => t.schedule === 'doomed'));
  assert.equal(h.ok, false);
  assert.match(h.text, /^Doomed didn't finish\. /);
  const last = (await get('/api/schedules')).set.find((s) => s.id === 'doomed').last;
  assert.equal(last.ok, false);
});

test('asked in a conversation, Nova sets a reminder only after an OK; a one-time schedule removes itself after it runs', async () => {
  const { id } = await (await post('/api/sessions', { text: 'Remind me tomorrow to call the dentist' })).json();
  const waiting = await wait(async () => { const s = await get(`/api/sessions/${id}`); return s.live?.approval && s; });
  const tool = waiting.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.equal(tool.name, 'schedule_set');
  assert.deepEqual([tool.preview.name, tool.preview.deliver, tool.preview.once], ['Call the dentist', 'here', true]);
  assert.match(tool.preview.when, /^Once, on \w+day, \w+ \d+ at 9:00 AM$/);
  assert.equal(nova.runner.schedules.get('call-the-dentist'), null); // nothing yet
  await post(`/api/sessions/${id}/approvals/${tool.id}`, { decision: 'allow' });
  await wait(async () => (await get(`/api/sessions/${id}`)).live === null);
  const s = nova.runner.schedules.get('call-the-dentist');
  assert.deepEqual([s.once, s.deliver], [true, id]);

  await post('/api/schedules/call-the-dentist/run');
  const h = await wait(async () => (await get(`/api/sessions/${id}`)).session.turns.find((t) => t.kind === 'handoff'));
  assert.equal(h.name, 'Call the dentist');
  assert.equal(nova.runner.schedules.get('call-the-dentist'), null);
  assert.ok(!(await main()).session.turns.some((t) => t.schedule === 'call-the-dentist'));
});

test('pause, resume, remove and undo, through the API', async () => {
  assert.equal((await post('/api/schedules/morning-digest/pause')).status, 200);
  let d = (await get('/api/schedules')).set.find((s) => s.id === 'morning-digest');
  assert.deepEqual([d.paused, d.next], [true, null]);
  await post('/api/schedules/morning-digest/resume');
  d = (await get('/api/schedules')).set.find((s) => s.id === 'morning-digest');
  assert.ok(d.next);
  const { text } = await (await post('/api/schedules/morning-digest/remove')).json();
  assert.ok(!existsSync(join(nova.config.home, 'schedules', 'morning-digest.md')));
  assert.equal((await post('/api/schedules/morning-digest/run')).status, 404);
  assert.equal((await post('/api/schedules/morning-digest/restore', { text })).status, 200);
  assert.equal((await get('/api/schedules')).set.find((s) => s.id === 'morning-digest').when, 'Every day at 7:00 AM');
  assert.equal((await post('/api/schedules/nope/pause')).status, 404);
});

test('a handoff waits for a reply in progress to finish', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-sw-'));
  ensureMark(home);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const n = createNova(loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `FAKE_DELAY=40 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none', NOVA_TZ: LA }));
  n.runner.send('main', 'slow please');
  await n.runner.deliver('main', { type: 'handoff', id: 'h1', schedule: 'x', name: 'X', ok: true, text: 'Report.' });
  const kinds = reduce(n.store.read('main')).turns.map((t) => [t.kind ?? 'user', t.state]);
  assert.deepEqual(kinds, [['user', 'done'], ['handoff', 'done']]);
});
