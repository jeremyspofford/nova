// Suggested follow-ups (FR-028): up to three prompts after the last completed turn, once per
// turn and cached; a strict-JSON model request through the router, or the deterministic
// heuristic with the mock (and whenever the model fails); empty when the setting is off, for
// temporary chats and while a turn runs or waits.
import { afterEach, describe, expect, it } from 'vitest';
import type { RoutedEvent } from '../src/index.ts';
import {
  SuggestionService,
  heuristicSuggestions,
  parseSuggestions,
  type ModelRouter,
  type RouteTarget,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env;
afterEach(() => env.close());

/** The env's router, but its targets claim to be a cloud provider whose stream the test scripts. */
function scriptedRouter(base: ModelRouter, script: () => RoutedEvent[] | Promise<never>) {
  const requests: unknown[] = [];
  const router: ModelRouter = {
    ...base,
    listModels: (a) => base.listModels(a),
    firstModel: (a) => base.firstModel(a),
    usable: (a, r) => base.usable(a, r),
    pricing: () => Promise.resolve({ costIn: 1, costOut: 2 }),
    route: async (a, ref, o) => {
      const r = await base.route(a, ref, o);
      return {
        ...r,
        targets: r.targets.map((t): RouteTarget => ({ ...t, providerKind: 'openai' })),
      };
    },
    stream: async function* (_route, req) {
      requests.push(req);
      const events = await script();
      for (const e of events) yield e;
    },
  };
  return { router, requests };
}

async function completedThread(text = 'Explain caching') {
  const t = await env.threads.create(ACCOUNT, {});
  const sent = await env.chat.send(ACCOUNT, t.id, { text });
  await env.chat.idle();
  return { threadId: t.id, turnId: sent.turnId! };
}

const on = () => Promise.resolve(true);

describe('GET /threads/:id/suggestions service (FR-028)', () => {
  it('with the mock: the heuristic from the last reply, generated once per turn', async () => {
    env = await makeEnv({
      mock: {
        scripts: [
          {
            when: 'caching',
            steps: [
              {
                textChunks: [
                  '## Cache invalidation\nThe hard part.\n\n- **Write-through caches** keep data fresh.\n',
                ],
              },
            ],
          },
        ],
      },
    });
    const { threadId } = await completedThread();
    let checks = 0;
    const svc = new SuggestionService({
      db: env.db,
      router: env.router,
      enabled: () => (checks++, Promise.resolve(true)),
    });
    const first = await svc.forThread(ACCOUNT, threadId);
    expect(first).toEqual([
      'Tell me more about Cache invalidation',
      'Go deeper on Write-through caches',
      'Can you give me an example?',
    ]);
    expect(await svc.forThread(ACCOUNT, threadId)).toBe(first);
    // A new turn gets new suggestions.
    await env.chat.send(ACCOUNT, threadId, { text: 'ok' });
    await env.chat.idle();
    expect(await svc.forThread(ACCOUNT, threadId)).toEqual([
      'Can you give me an example?',
      'What should I do next?',
      'Explain that more simply',
    ]);
    expect(checks).toBe(3);
  });

  it('asks the model for strict JSON, records its usage and caches the answer', async () => {
    env = await makeEnv();
    const { threadId, turnId } = await completedThread();
    const { router, requests } = scriptedRouter(env.router, () => [
      { type: 'text_delta', text: 'Sure: ["How do I invalidate a key?", ' },
      {
        type: 'text_delta',
        text: '"What is a TTL?", "how do i invalidate a key?", "Give an example"]',
      },
      { type: 'usage', inputTokens: 120, outputTokens: 30 },
      { type: 'stop', reason: 'end' },
    ]);
    const svc = new SuggestionService({ db: env.db, router, enabled: on });
    expect(await svc.forThread(ACCOUNT, threadId)).toEqual([
      'How do I invalidate a key?',
      'What is a TTL?',
      'Give an example',
    ]);
    await svc.forThread(ACCOUNT, threadId);
    expect(requests).toHaveLength(1);
    const req = requests[0] as {
      messages: { role: string; content: { text: string }[] }[];
      maxTokens: number;
      metadata: Record<string, unknown>;
    };
    expect(req.messages[0]!.content[0]!.text).toContain('JSON array');
    expect(req.messages[1]!.content[0]!.text).toContain('<user>\nExplain caching\n</user>');
    expect(req.messages[1]!.content[0]!.text).toContain('You said: Explain caching');
    expect(req.maxTokens).toBe(200);
    expect(req.metadata).toMatchObject({ threadId, purpose: 'suggestions' });
    const usage = env.db.raw
      .prepare(
        "SELECT input_tokens AS i, output_tokens AS o, cost_usd AS c FROM usage_event WHERE turn_id = ? AND provider = 'openai'",
      )
      .all(turnId) as { i: number; o: number; c: number }[];
    expect(usage).toEqual([{ i: 120, o: 30, c: (120 * 1 + 30 * 2) / 1e6 }]);
  });

  it('falls back to the heuristic when the model fails, times out or answers no JSON', async () => {
    env = await makeEnv();
    const expected = heuristicSuggestions('You said: Explain caching');
    for (const script of [
      () => [
        { type: 'text_delta' as const, text: 'no list here' },
        { type: 'stop' as const, reason: 'end' as const },
      ],
      () => [{ type: 'stop' as const, reason: 'error' as const }],
      () => Promise.reject(new Error('network down')),
      () => new Promise<never>(() => undefined),
    ]) {
      const { threadId } = await completedThread();
      const { router } = scriptedRouter(env.router, script);
      const svc = new SuggestionService({ db: env.db, router, enabled: on, timeoutMs: 50 });
      expect(await svc.forThread(ACCOUNT, threadId)).toEqual(expected);
    }
  });

  it('is empty when off, temporary, running, waiting or after a failed turn', async () => {
    env = await makeEnv();
    const svc = (enabled = true) =>
      new SuggestionService({
        db: env.db,
        router: env.router,
        enabled: () => Promise.resolve(enabled),
      });
    const { threadId } = await completedThread();
    expect(await svc(false).forThread(ACCOUNT, threadId)).toEqual([]);

    const temp = await env.threads.create(ACCOUNT, { temporary: true });
    await env.chat.send(ACCOUNT, temp.id, { text: 'secret plans' });
    await env.chat.idle();
    expect(await svc().forThread(ACCOUNT, temp.id)).toEqual([]);

    for (const state of ['streaming', 'waiting_approval', 'waiting_input', 'error']) {
      env.db.raw.prepare('UPDATE thread SET state = ? WHERE id = ?').run(state, threadId);
      expect(await svc().forThread(ACCOUNT, threadId)).toEqual([]);
    }
    env.db.raw.prepare("UPDATE thread SET state = 'idle' WHERE id = ?").run(threadId);
    env.db.raw.prepare("UPDATE turn SET status = 'interrupted' WHERE thread_id = ?").run(threadId);
    expect(await svc().forThread(ACCOUNT, threadId)).toEqual([]);

    const empty = await env.threads.create(ACCOUNT, {});
    expect(await svc().forThread(ACCOUNT, empty.id)).toEqual([]);
  });

  it("is not_found for a thread that is not the account's", async () => {
    env = await makeEnv();
    const { threadId } = await completedThread();
    const svc = new SuggestionService({ db: env.db, router: env.router, enabled: on });
    await expect(
      svc.forThread('01920000-0000-7000-8000-0000000000ff', threadId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      svc.forThread(ACCOUNT, '01920000-0000-7000-8000-0000000000fe'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    svc.close();
  });
});

describe('the heuristic and the parser', () => {
  it('uses topics, code and length, deterministically, at most three', () => {
    expect(heuristicSuggestions('')).toEqual([]);
    expect(heuristicSuggestions('```ts\nconst a = 1;\n```')).toEqual([
      'Explain how this code works step by step',
      'Can you give me an example?',
      'What should I do next?',
    ]);
    const long = `${'word '.repeat(150)}\n1. First step: do this.\n2. Second thing - then that`;
    expect(heuristicSuggestions(long)).toEqual([
      'Tell me more about First step',
      'Go deeper on Second thing',
      'Summarize that in three bullet points',
    ]);
    // Topics that are too short or too long are skipped.
    expect(heuristicSuggestions('- a\n- ' + 'x'.repeat(80))[0]).toBe('Can you give me an example?');
  });

  it('parses the first JSON array, cleans, dedupes, drops long ones and redacts', () => {
    expect(parseSuggestions('nothing')).toEqual([]);
    expect(parseSuggestions('[not json')).toEqual([]);
    expect(parseSuggestions('{"a": [1]}')).toEqual([]);
    expect(parseSuggestions('{"a": 1} ]')).toEqual([]);
    expect(
      parseSuggestions(
        `["  \\"quoted\\"  ", "A\\nB", 3, "${'y'.repeat(130)}", "a b", "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "five"]`,
      ),
    ).toEqual(['quoted', 'A B', 'Use [REDACTED]']);
  });
});
