// Work runs on the real chat loop with the Mock provider (ADR-076, FR-051, FR-186): the
// ChatService starts the run's turns through TurnStarter, asks the run extension for context,
// bounds and onEnd, and offers each thread only its own run tools (ToolListScope). The Mock
// calls the tools named in `/tool` lines of the newest user message, offline.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunService, type ToolSourceProvider } from '../src/index.ts';
import { ACCOUNT, makeToolEnv, toolCards, type ToolEnv } from './helpers.ts';

let env: ToolEnv;
let runs: RunService;
const settings = { escalation: 'propose' as 'propose' | 'auto' | 'off' };

beforeEach(async () => {
  let late: RunService | null = null;
  const source: ToolSourceProvider = {
    source: 'builtin',
    list: (accountId, scope) =>
      late ? late.toolSource.list(accountId, scope) : Promise.resolve([]),
  };
  env = await makeToolEnv({ sources: [source] });
  runs = new RunService({
    db: env.db,
    events: env.events,
    threads: env.threads,
    settings: {
      defaultBudgets: async () => ({ timeSeconds: 3600, tokens: 2_000_000, costUsd: null }),
      autonomy: async () => 'standard',
      subagents: async () => ({ maxChildren: 6, maxConcurrent: 4 }),
      escalation: async () => settings.escalation,
    },
  });
  late = runs;
  env.chat.useExtension(runs.extension);
  runs.useTurns(env.chat.turnStarter);
});

afterEach(async () => {
  await runs.close();
  await env.close();
});

describe('a run on the chat loop', () => {
  it('plans, saves an artifact and completes through scripted tool calls (J5 shape)', async () => {
    const objective = [
      'Summarize the notes into a Markdown artifact.',
      '/tool plan.set {"steps":[{"title":"Read"},{"title":"Write"}]}',
      '/tool plan.update {"idx":0,"status":"done"}',
      '/tool artifact.create {"kind":"markdown","title":"Summary","content":"# Summary\\n\\nShort."}',
      '/tool plan.update {"idx":1,"status":"done"}',
      '/tool run.complete {"summary":"Saved the summary.","evidence":["artifact created"]}',
    ].join('\n');
    const v = await runs.create({
      accountId: ACCOUNT,
      objective,
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      expectedOutput: { kind: 'artifact', ref: 'Summary' },
    });
    const fin = await runs.whenFinished(ACCOUNT, v.id);
    expect(fin.status).toBe('done');
    const r = await runs.get(ACCOUNT, v.id);
    expect(r.result).toMatchObject({ summary: 'Saved the summary.' });
    expect(r.result?.artifactIds).toHaveLength(1);
    expect(r.plan?.map((s) => s.status)).toEqual(['done', 'done']);
    expect(r.outputVerifiedAt).not.toBeNull();
    expect(r.used.tokens).toBeGreaterThan(0);
    // The turn belongs to the run; the objective is the run's user-role message.
    const turn = env.db.raw
      .prepare('SELECT run_id AS runId, trigger FROM turn WHERE thread_id = ?')
      .get(v.threadId) as { runId: string; trigger: string };
    expect(turn).toEqual({ runId: v.id, trigger: 'user' });
    const cards = await toolCards(env, v.threadId);
    expect(cards.map((c) => [c.tool, c.status])).toEqual([
      ['plan.set', 'ok'],
      ['plan.update', 'ok'],
      ['artifact.create', 'ok'],
      ['plan.update', 'ok'],
      ['run.complete', 'ok'],
    ]);
  });

  it('a chat offers work.start but not the run tools; Start runs the proposal', async () => {
    const chat = await env.threads.create(ACCOUNT, { mode: 'chat' });
    await env.chat.send(ACCOUNT, chat.id, {
      text: [
        'Please do this big job.',
        '/tool plan.set {"steps":[{"title":"x"}]}',
        '/tool work.start {"objective":"Do the big job"}',
      ].join('\n'),
    });
    await env.chat.idle();
    const cards = await toolCards(env, chat.id);
    expect(cards.map((c) => [c.tool, c.status])).toEqual([
      ['plan.set', 'error'],
      ['work.start', 'ok'],
    ]);
    const proposed = (await runs.list(ACCOUNT)).items[0]!;
    expect(proposed).toMatchObject({
      status: 'planning',
      origin: 'chat_escalation',
      originRef: chat.id,
    });
    await runs.start(ACCOUNT, proposed.id);
    const fin = await runs.whenFinished(ACCOUNT, proposed.id);
    expect(fin.status).toBe('done');
    // The run's first message is the objective, now with the user's authority.
    const first = env.db.raw
      .prepare(
        `SELECT p.content AS text, m.author_kind AS kind FROM message m
         JOIN message_part p ON p.message_id = m.id AND p.type = 'text'
         WHERE m.thread_id = ? AND m.role = 'user' ORDER BY m.created_at LIMIT 1`,
      )
      .get(proposed.threadId) as { text: string; kind: string };
    expect(first).toEqual({ text: 'Do the big job', kind: 'run' });
  });
});
