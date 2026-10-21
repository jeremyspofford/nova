// Helpers and Activity: work handed off in a conversation, done in the
// background with scoped context, and reported back as a handoff; and the
// timeline of what Nova did, built from the logs. Through the HTTP API with
// the scripted model and a stand-in search engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { buildPrompt } from '../src/context.js';
import { summarize } from '../src/activity.js';
import { reduce } from '../ui/js/reduce.js';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { startFakeGoogle } from '../scripts/fake-google.js';

const root = new URL('..', import.meta.url).pathname;
const LA = 'America/Los_Angeles';
let nova;
let base;
let google;
const calls = []; // every model call: { system, prompt }

before(async () => {
  google = await startFakeGoogle();
  const home = mkdtempSync(join(tmpdir(), 'nova-he-'));
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'bikes.md'), 'Commute: 9 miles, one long hill. Budget $2,000.\n');
  nova = createNova(loadConfig({
    NOVA_HOME: home,
    NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`,
    NOVA_SEARCH_URL: `${google.base}/search`,
    NOVA_TZ: LA,
  }), { agent: (o) => { calls.push({ system: o.system, prompt: o.prompt }); return runAgent(o); } });
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${nova.server.address().port}`;
});
after(() => { nova.server.close(); google.server.close(); });

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
const convo = (id) => get(`/api/sessions/${id}`);
const handoffs = async (id) => (await convo(id)).session.turns.filter((t) => t.kind === 'handoff');
const idle = () => wait(() => nova.runner.active.size === 0 && !nova.helpers.running.size && !nova.helpers.queue.length);

let asked; // the conversation that handed off the e-bike comparison

test('asked in a conversation, Nova hands the work to a helper and the reply ends at once; the report comes back as a handoff', async () => {
  // Something to remember first, so we can check the helper never sees it.
  const { id: other } = await (await post('/api/sessions', { text: 'I take my coffee black, no sugar' })).json();
  await wait(async () => (await convo(other)).live === null);

  const { id } = await (await post('/api/sessions', { text: 'Ask a helper to compare commuter e-bikes under $2,000 using my notes' })).json();
  asked = id;
  const replied = await wait(async () => { const s = await convo(id); return s.live === null && s.session.turns[0].state === 'done' && s; });
  const tool = replied.session.turns[0].items.find((i) => i.kind === 'tool');
  assert.equal(tool.name, 'delegate');
  assert.deepEqual([tool.result.ok, tool.result.summary], [true, 'Compare e-bikes']);
  assert.match(tool.result.link, /^\/activity#a-\d{4}-\d{2}-\d{2}-\w{6}$/);
  assert.match(replied.session.turns[0].items.at(-1).text, /A helper is on it/);

  const [h] = await wait(async () => { const x = await handoffs(id); return x.length && x; });
  assert.deepEqual([h.name, h.ok, h.helper, h.run], ['Compare e-bikes', true, h.run, tool.result.link.slice(12)]);
  assert.match(h.text, /^The \*\*Ridgeline C2\*\* is the one to get.*Your notes say the ride is 9 miles/);

  // The helper's work is a log of its own: not listed, marked as a helper, delivered.
  assert.ok(!(await get('/api/sessions')).some((s) => s.id === h.run));
  const run = reduce(nova.store.read(h.run), h.run);
  assert.deepEqual([run.kind, run.parent, run.title, run.delivered], ['helper', id, 'Compare e-bikes', { to: id, handoff: h.id }]);
  assert.match(run.turns[0].text, /^Compare commuter e-bikes under \$2,000 using my notes\. Report back/);
  assert.deepEqual(run.turns[0].items.filter((i) => i.kind === 'tool').map((i) => i.name), ['web_search']);

  // The next message in the conversation sees the report.
  const prompt = buildPrompt((await convo(id)).session, [], { timezone: LA });
  assert.match(prompt, new RegExp(`<handoff from="Compare e-bikes" helper="${h.run}" time="[^"]+">\\nThe \\*\\*Ridgeline C2`));
});

test("a helper's context is scoped: its brief, who the person is, and the files passed along; not the conversation, memory or schedules", async () => {
  const helper = calls.find((c) => c.system.includes('# You are a helper'));
  assert.ok(helper);
  assert.match(helper.system, /<file path="~\/USER\.md">/);
  assert.match(helper.system, /<file path="~\/workspace\/bikes\.md">\nCommute: 9 miles, one long hill/);
  assert.doesNotMatch(helper.system, /MEMORY\.md">|coffee black|# Recent notes|# Schedules|# Memory blocks/);
  assert.doesNotMatch(helper.system, /^- (delegate|schedule_set|schedule_remove) /m);
  assert.doesNotMatch(helper.prompt, /Ask a helper|coffee|<memory_search>/);
  // The conversation that asked could delegate; it had memory.
  const parent = calls.find((c) => c.prompt.includes('Ask a helper'));
  assert.match(parent.system, /^- delegate /m);
  assert.match(parent.system, /Takes coffee black/);
});

test("a helper can't ask the person anything: what needs an OK is declined, and the report says so", async () => {
  nova.helpers.spawn({ title: 'Workspace check', task: 'Run ls in the workspace and tell me what is there.', parent: asked });
  const h = await wait(async () => (await handoffs(asked)).find((x) => x.name === 'Workspace check'));
  const exec = reduce(nova.store.read(h.run)).turns[0].items.find((i) => i.kind === 'tool');
  assert.deepEqual([exec.name, exec.approval.decision, exec.approval.auto], ['exec', 'deny', true]);
  assert.match(h.text, /helpers can't ask/);
  assert.match(buildPrompt(reduce(nova.store.read(h.run)), [], { timezone: LA }), /Not done: this runs on its own, and no one was there to approve it/);
});

test('briefs and files are checked before a helper starts', () => {
  const spawn = (args) => () => nova.helpers.spawn({ parent: asked, task: 'Look into it.', ...args });
  assert.throws(spawn({ task: '  ' }), /needs a task/);
  assert.throws(spawn({ files: ['workspace/nope.md'] }), /There's no file at workspace\/nope\.md/);
  assert.throws(spawn({ files: ['connectors/gmail/token.json'] }), /can't be passed to a helper/);
  assert.throws(spawn({ files: ['../outside.md'] }), /outside Nova's home/);
  assert.throws(spawn({ files: Array(6).fill('workspace/bikes.md') }), /up to 5 files/);
  assert.throws(spawn({ task: 'x'.repeat(9000) }), /too long/);
});

test('three helpers work at once and a fourth waits; stopping one, working or waiting, says so in the conversation; Try again starts it fresh', async () => {
  await idle();
  const runs = ['one', 'two', 'three', 'four'].map((n) => nova.helpers.spawn({ title: `Slow ${n}`, task: `Take it slow with ${n}.`, parent: asked }));
  assert.deepEqual(runs.map((r) => r.queued), [false, false, false, true]);
  assert.deepEqual([nova.helpers.running.size, nova.helpers.queue.length], [3, 1]);

  // Activity shows them working now, and the fourth waiting its turn.
  const a = await wait(async () => { const x = await get('/api/activity'); return x.now.filter((e) => e.kind === 'helper' && e.state === 'working').length === 3 && x; });
  const queued = a.now.find((e) => e.state === 'queued');
  assert.deepEqual([queued.title, queued.parentTitle], ['Slow four', 'Ask a helper to compare commuter e-bikes under $2,000 using…']);
  assert.ok(a.busy.working >= 4);

  assert.equal((await post(`/api/helpers/${runs[3].run}/stop`)).status, 200); // waiting
  assert.equal((await post(`/api/helpers/${runs[0].run}/stop`)).status, 200); // working
  const stopped = await wait(async () => { const x = (await handoffs(asked)).filter((t) => t.stopped); return x.length === 2 && x; });
  assert.deepEqual(stopped.map((t) => [t.name, t.ok, t.text]).sort(), [
    ['Slow four', false, 'You stopped this helper before it finished.'],
    ['Slow one', false, 'You stopped this helper before it finished.'],
  ]);
  assert.equal((await post(`/api/helpers/${runs[0].run}/stop`)).status, 409);
  for (const r of runs.slice(1, 3)) await post(`/api/helpers/${r.run}/stop`);
  await idle();

  const again = await (await post(`/api/helpers/${runs[0].run}/retry`)).json();
  assert.equal(again.title, 'Slow one');
  assert.equal(reduce(nova.store.read(again.run)).parent, asked);
  await post(`/api/helpers/${again.run}/stop`);
  await idle();
  assert.equal((await post('/api/helpers/2026-01-01-zzzzzz/retry')).status, 404);
});

test("if Nova stops while a helper works, the conversation hears so when it starts again", async () => {
  const run = nova.store.newId();
  nova.store.append(run, { type: 'session', id: run, title: 'Interrupted', kind: 'helper', parent: asked, files: [], v: 1 });
  nova.store.append(run, { type: 'user', turn: 't1', text: 'Something long.' });
  assert.equal(await nova.helpers.recover(), 1);
  const h = (await handoffs(asked)).find((t) => t.name === 'Interrupted');
  assert.deepEqual([h.ok, h.text], [false, "Interrupted didn't finish: Nova stopped before it was done."]);
  assert.equal(await nova.helpers.recover(), 0); // only once
});

test('Activity: each reply, run and helper as an entry with its steps, newest first, in the person’s days', async () => {
  // A scheduled run, and a reply that waits on an approval.
  nova.runner.schedules.setup('morning-digest', { time: '7:00', days: 'every' });
  await post('/api/schedules/morning-digest/run');
  await wait(async () => (await handoffs('main')).length);
  const { id } = await (await post('/api/sessions', { text: 'Run git status in my workspace' })).json();
  await wait(async () => (await convo(id)).live?.approval);

  const a = await get('/api/activity');
  assert.equal(a.timezone, LA);
  const today = a.days[0];
  const kinds = today.entries.map((e) => e.kind);
  assert.ok(['reply', 'helper', 'schedule'].every((k) => kinds.includes(k)));
  assert.ok(today.entries.every((e, i, l) => !i || l[i - 1].started >= e.started));

  const waiting = a.now.find((e) => e.session === id);
  assert.deepEqual([waiting.state, waiting.kind, waiting.text, waiting.approval], ['waiting', 'reply', 'Run git status in my workspace', waiting.steps[0].id]);
  assert.deepEqual(a.busy, { working: 1, waiting: 1 });

  const helper = today.entries.find((e) => e.title === 'Compare e-bikes');
  assert.deepEqual([helper.state, helper.parent, helper.report.to, helper.report.toTitle], ['done', asked, asked, 'Ask a helper to compare commuter e-bikes under $2,000 using…']);
  assert.match(helper.brief, /^Compare commuter e-bikes/);
  assert.deepEqual(helper.steps.map((s) => [s.name, s.args.query, s.result.summary]), [['web_search', 'best commuter e-bikes under $2000 2026', '3 results']]);

  const digest = today.entries.find((e) => e.kind === 'schedule');
  assert.deepEqual([digest.title, digest.manual, digest.report.to, digest.report.toTitle], ['Morning digest', true, 'main', 'Main conversation']);

  const coffee = today.entries.find((e) => e.text === 'I take my coffee black, no sugar');
  assert.deepEqual(coffee.steps, [{ kind: 'memory', kept: 2, forgot: 0 }]);
  const delegated = today.entries.find((e) => e.session === asked);
  assert.deepEqual(delegated.steps.map((s) => [s.name, s.result.summary]), [['delegate', 'Compare e-bikes']]);

  // Answer it, and the day's numbers count it.
  await post(`/api/sessions/${id}/approvals/${waiting.approval}`, { decision: 'deny' });
  await wait(async () => (await convo(id)).live === null);
  const after = await get('/api/activity');
  assert.equal(after.now.length, 0);
  const n = after.days[0].summary;
  assert.deepEqual([n.asked, n.declined, n.notAsked, n.schedules, n.kept], [1, 1, 1, 1, 2]);
  assert.ok(n.helpers >= 6 && n.replies >= 3);
});

test('Activity pages by week, and says when there is more', async () => {
  const a = await get('/api/activity');
  assert.equal(a.more, false);
  const today = a.days[0].day;
  const earlier = await get(`/api/activity?before=${a.before}`);
  assert.deepEqual([earlier.days, earlier.more], [[], false]);
  // A conversation from last month makes the earlier pages worth asking for.
  nova.store.append('2026-09-01-aaaaaa', { type: 'session', id: '2026-09-01-aaaaaa', title: 'Old', v: 1 });
  assert.equal((await get('/api/activity')).more, true);
  assert.equal((await fetch(`${base}/api/activity?before=yesterday`)).status, 400);
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
});

test('missed runs are in the timeline; the summary counts what was asked and what ran on its own', () => {
  const n = summarize([
    { kind: 'reply', steps: [{ kind: 'tool', approval: { decision: 'allow' } }, { kind: 'tool', approval: { decision: 'deny' } }, { kind: 'memory', kept: 1 }] },
    { kind: 'schedule', missed: true, steps: [] },
    { kind: 'helper', steps: [{ kind: 'tool', approval: { decision: 'deny', auto: true } }] },
  ]);
  assert.deepEqual(n, { replies: 1, schedules: 0, helpers: 1, missed: 1, asked: 2, allowed: 1, declined: 1, notAsked: 1, kept: 1 });
});
