// FR-188 in the loop: the signed-in user's answer to `ask_user` carries their authority for the
// rest of the turn (a loop hook, not an untrusted tool result), even in a turn that started
// without it (a goal continuation); an answer that did not come from a Nova client does not, and
// stays untrusted data for the model.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ContentPart } from '@nova/providers';
import {
  builtinDescriptor,
  ok,
  requestToolSource,
  userAskTool,
  type AskResult,
  type BuiltinTool,
} from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';
import { recordingGate, type GateCall } from './team-env.ts';

let env: ToolEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
});

const probe: BuiltinTool = {
  origin: null,
  descriptor: builtinDescriptor({
    name: 'probe.act',
    title: 'Act',
    description: 'does something consequential',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }),
  handler: () => Promise.resolve(ok('acted')),
};

const call = (name: string, args: unknown, id: string) => [
  { type: 'tool_call_start' as const, index: 0, id, name },
  { type: 'tool_call_delta' as const, index: 0, argsDelta: JSON.stringify(args) },
  { type: 'tool_call_end' as const, index: 0, args },
  { type: 'stop' as const, reason: 'tool_calls' as const },
];

async function run(answer: AskResult, authority: 'user' | 'none') {
  const calls: GateCall[] = [];
  const asked = userAskTool({
    broker: { ask: () => Promise.resolve(answer) },
    threadMode: () => Promise.resolve('work'),
  });
  env = await makeToolEnv({
    gate: recordingGate(calls),
    sources: [
      requestToolSource([asked]),
      { source: 'builtin', list: () => Promise.resolve([probe]) },
    ],
    mock: {
      scripts: [
        { once: true, steps: call('ask_user', { question: 'Push to main?' }, 'c1') },
        { once: true, steps: call('probe.act', {}, 'c2') },
        { steps: [{ textChunks: ['finished'] }] },
      ],
    },
  });
  const t = await env.threads.create(ACCOUNT, { mode: 'work' });
  const started = await env.chat.turnStarter.startTurn({
    accountId: ACCOUNT,
    threadId: t.id,
    text: 'Continue the goal',
    trigger: authority === 'user' ? 'user' : 'goal',
    authority:
      authority === 'user' ? { kind: 'user', source: 'test' } : { kind: 'none', origin: 'system' },
    authorKind: authority === 'user' ? 'user' : 'goal',
  });
  await started.done;
  const requests = env.mock.requests;
  return { calls, requests, started };
}

/** The texts of the tool result for `ask_user` the model got in its last request. */
function askResultTexts(requests: ChatRequest[]): string[] {
  const last = requests.at(-1)!;
  const parts = last.messages.flatMap((m) => m.content);
  const res = parts.find(
    (p): p is Extract<ContentPart, { type: 'tool_result' }> =>
      p.type === 'tool_result' && p.callId === 'c1',
  );
  return (res?.content ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : []));
}

describe("the user's answer to ask_user (FR-188)", () => {
  it('gives the rest of a goal turn their instruction, and reaches the model as their words', async () => {
    const { calls, requests, started } = await run(
      { status: 'resolved', result: { text: 'yes, push' }, by: 'user' },
      'none',
    );
    expect(calls.map((c) => [c.tool, c.userInstruction])).toEqual([
      ['ask_user', null],
      ['probe.act', expect.stringMatching(/^answer:/) as unknown],
    ]);
    const texts = askResultTexts(requests);
    expect(texts.join('')).toContain('The user answered: yes, push');
    expect(texts.join('')).not.toMatch(/untrusted/);
    expect((await started.done).status).toBe('completed');
  });

  it('gives nothing when the answer did not come from a signed-in Nova client', async () => {
    const { calls, requests } = await run(
      { status: 'resolved', result: { text: 'yes, push' }, by: 'channel' },
      'none',
    );
    expect(calls.map((c) => [c.tool, c.userInstruction])).toEqual([
      ['ask_user', null],
      ['probe.act', null],
    ]);
    expect(askResultTexts(requests).join('')).toMatch(/untrusted/);
  });

  it("keeps a typed turn's own instruction", async () => {
    const { calls } = await run(
      { status: 'resolved', result: { choice: 'main' }, by: 'user' },
      'user',
    );
    expect(calls[0]!.userInstruction).not.toBeNull();
    expect(calls[0]!.userInstruction).not.toMatch(/^answer:/);
    expect(calls[1]!.userInstruction).toBe(calls[0]!.userInstruction);
  });
});
