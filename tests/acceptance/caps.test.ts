// Hard caps on autonomy cost (Amendment 2026-10-31-B Part 5), end to end: a scheduled run through
// the real Work Ledger, chat-run worker and runner, with a stand-in model stuck in a loop (it asks
// for the same tool call forever). With the caps wired, the loop is stopped before its 5th
// identical call; the task fails with plain words saying what was spent and why; the report says so
// in the main conversation; the resume waits for the person's OK as a new task; approved, it
// continues the same conversation with a fresh allowance and hands over its report. The day's
// ceiling stops the next task before its first model call. Without caps the same loop runs to
// max_tool_steps (today's only bound). Neutral placeholders; temp homes only; no real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { TERMINAL } from '../../src/core/index.ts';
import { reduce } from '../../ui/js/reduce.js';
import { blank } from './support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hubHardware } from '../support/models.ts';

const LOOP_CALL = '<tool_call name="read_file">{"path": "AGENTS.md"}</tool_call>';

// Loops until the conversation shows it was stopped at a ceiling (the resumed turn), then reports.
const looping = async ({ prompt, onText }: { prompt: string; onText?: (t: string) => void }) => {
  const resumed = (prompt.match(/<user/g) ?? []).length > 1;
  const turn = prompt.slice(prompt.lastIndexOf('<user'));
  const results = (turn.match(/<tool_result /g) ?? []).length;
  const text = resumed && results >= 2 ? 'Report: the notes are in order.' : `Checking again.\n${LOOP_CALL}`;
  onText?.(text);
  return { text, aborted: false };
};

async function start({ caps = true } = {}) {
  const machine = blank('nova-caps-e2e-');
  const home = machine.home;
  // createNova reads the vault mode from process.env, not loadConfig's env object.
  const runtime = await startFakeOllama({ models: [] });
  const prior = Object.fromEntries(Object.keys(machine.env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, machine.env);
  const restore = () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'example-model-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0, commit: false } as ReturnType<typeof loadConfig>;
  let nova: ReturnType<typeof createNova>;
  try { nova = createNova(config, { agent: looping, secrets: () => null, models: { ollamaUrl: runtime.url, hardware: async () => hubHardware() } }); } catch (e) { await runtime.close(); restore(); throw e; }
  const c = nova.core.caps;
  if (!caps) nova.runner.caps = null;
  const ledger = nova.core.ledger;
  const settled = async (id: string, states: readonly string[] = TERMINAL) => {
    for (let i = 0; i < 1000; i++) { const t = ledger.get(id); if (states.includes(t.state)) return t; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error(`task ${id} never settled: ${ledger.get(id).state} ${ledger.get(id).reason}`);
  };
  const chatRuns = () => ledger.list({ limit: 50 }).filter((t) => t.owner === 'chat-run');
  const runSchedule = async (name: string) => {
    const before = new Set(chatRuns().map((t) => t.id));
    const s = nova.runner.schedules.set({ name, cron: '0 7 * * *', prompt: 'Check the notes and report.' });
    assert.ok(nova.scheduler.runNow(s.id));
    for (let i = 0; i < 500; i++) { const t = chatRuns().find((x) => !before.has(x.id) && !x.brief.inputs?.resume); if (t) return settled(t.id); await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('the scheduled run never became a task');
  };
  const main = () => reduce(nova.runner.store.read('main')).turns.filter((t: { kind?: string }) => t.kind === 'handoff') as { text: string; ok: boolean }[];
  return { nova, c, ledger, settled, chatRuns, runSchedule, main, close: async () => { try { nova.scheduler.stop(); await nova.core.close(); } finally { await runtime.close(); restore(); } } };
}

const toolsOf = (nova: ReturnType<typeof createNova>, run: string) => reduce(nova.runner.store.read(run)).turns.map((t: { items: { kind: string }[] }) => t.items.filter((i) => i.kind === 'tool').length);

test('a stuck loop is stopped before its 5th identical call, says what it spent, and its resume waits for an OK; approved, it continues and reports', async () => {
  const h = await start();
  try {
    assert.ok(h.c, 'normal createNova owns Caps without test injection');
    assert.equal(h.nova.runner.caps, h.c, 'runner uses the Core-owned instance');
    const t = await h.runSchedule('Notes check');
    assert.equal(t.state, 'failed');
    assert.match(t.reason ?? '', /Stopped at this task’s ceiling: 24 steps\. The same tool call kept repeating, so each repeat counted extra: it looked stuck in a loop\./);
    assert.match(t.reason ?? '', /This task spent 16 steps, [\d,]+ tokens \(estimated\), \$0\.00\./);
    const run = t.brief.inputs!.run as string;
    assert.deepEqual(toolsOf(h.nova, run), [4], 'four calls ran; the fifth was refused before it ran');
    // The report the person reads.
    assert.match(h.main().at(-1)!.text, /^Notes check didn't finish\. Stopped at this task’s ceiling/);
    // The resume: a new task, waiting for the person's OK.
    const resume = h.chatRuns().find((x) => x.brief.inputs?.resume === t.id)!;
    assert.ok(resume, 'a resume task is offered');
    assert.equal(resume.state, 'waiting');
    assert.equal(resume.reason, 'Needs your OK before it runs.');
    assert.equal(resume.approval_tier, 2);
    assert.equal(resume.title, 'Resume: Notes check');
    assert.equal(resume.parent_id, t.id);
    // Approved: the same conversation continues with a fresh allowance, and reports.
    h.ledger.approve(resume.id);
    const done = await h.settled(resume.id);
    assert.equal(done.state, 'done', `${done.state}: ${done.reason}`);
    assert.deepEqual(toolsOf(h.nova, run), [4, 2], 'a second turn in the same conversation');
    assert.equal(h.main().at(-1)!.text, 'Report: the notes are in order.');
    // Offered once: no second resume for the same task, none for the one that finished.
    assert.equal(h.chatRuns().filter((x) => x.brief.inputs?.resume).length, 1);
    // The spend: both segments, by task, in the month per provider.
    const m = h.c.month();
    assert.equal(m.providers.length, 1);
    assert.equal(m.providers[0]!.provider, 'example-model-command');
    assert.equal(h.c.day().iterations, 16 + 1 + 3, "the resume is a fresh segment: its repeats count from 1 again");
  } finally {
    await h.close();
  }
});

test('the day’s ceiling stops the next task before its first model call, and offers its resume', async () => {
  const h = await start();
  try {
    h.c.setLimits({ day: { tokens: 20_000 } });
    const first = await h.runSchedule('First check');
    assert.match(first.reason ?? '', /Stopped at today’s ceiling for all tasks: 20,000 tokens\./);
    const second = await h.runSchedule('Second check');
    assert.equal(second.state, 'failed');
    assert.match(second.reason ?? '', /Second check didn't finish\. Stopped at today’s ceiling for all tasks: 20,000 tokens\. Today’s tasks spent \d+ steps, [\d,]+ tokens \(estimated\), \$0\.00; this one, 0 steps, 0 tokens, \$0\.00\./);
    assert.deepEqual(toolsOf(h.nova, second.brief.inputs!.run as string), [0], 'no step, no model call');
    assert.doesNotMatch(second.reason ?? '', /Health/);
    assert.match(second.reason ?? '', /Resuming waits for your OK in Tasks, and runs once there is room under today’s ceiling \(it starts again at midnight\)\./);
    assert.ok(h.chatRuns().some((x) => x.brief.inputs?.resume === second.id && x.state === 'waiting'));
  } finally {
    await h.close();
  }
});

test('without the caps, the same loop runs to max_tool_steps (today’s only bound), and nothing is offered', async () => {
  const h = await start({ caps: false });
  try {
    const t = await h.runSchedule('Notes check');
    assert.equal(t.state, 'failed');
    assert.match(t.reason ?? '', /stopped after 8 tool steps/);
    assert.deepEqual(toolsOf(h.nova, t.brief.inputs!.run as string), [8]);
    assert.ok(!h.chatRuns().some((x) => x.brief.inputs?.resume));
  } finally {
    await h.close();
  }
});

test('a person’s own conversation is metered even above every autonomous ceiling', async () => {
  const h = await start();
  try {
    h.c.setLimits({ task: { iterations: 1, tokens: 1, usd: 0.001 }, day: { iterations: 1, tokens: 1, usd: 0.001 } });
    h.nova.runner.send('main', 'Check my notes.');
    for (let i = 0; i < 1000 && h.nova.runner.active.has('main'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.nova.runner.active.has('main'), false);
    assert.deepEqual(toolsOf(h.nova, 'main'), [8], 'autonomous ceilings never stop the person’s reply');
    assert.match(h.nova.runner.report('main').failure, /stopped after 8 tool steps/);
    assert.ok(h.c.month().total.tokens_in > 1, 'conversation usage is recorded');
    assert.equal(h.c.month().providers[0]!.calls, 9, 'each model call is counted once');
    assert.equal(h.c.day().tokens_in, 0, 'conversation does not consume task daily allowance');
    assert.equal(h.c.day().iterations, 0);
    assert.equal(h.chatRuns().length, 0, 'no autonomous resume approval for a conversation');
  } finally { await h.close(); }
});
