import { describe, expect, it } from 'vitest';
import { MockProvider, collect, loadFixture, splitWords, toolSteps } from '../src/index.ts';
import type { ChatRequest, StreamEvent } from '../src/index.ts';

const req = (text: string, signal = new AbortController().signal): ChatRequest => ({
  model: 'mock-fast',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  signal,
});
const ctx = { requestId: 'r1' };

async function events(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('MockProvider', () => {
  it('streams a deterministic echo by default, ending with usage and stop', async () => {
    const p = new MockProvider();
    const ev = await events(p.stream(req('Hello there'), ctx));
    expect(ev[0]?.type).toBe('start');
    expect(ev.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(1);
    expect(ev.at(-2)?.type).toBe('usage');
    expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'end' });
    const c = await collect(new MockProvider().stream(req('Hello there'), ctx));
    expect(c.text).toBe('You said: Hello there');
    expect(c.incomplete).toBe(false);
    expect(p.requests).toHaveLength(1);
  });

  it('greets when the user message is empty', async () => {
    const c = await collect(new MockProvider().stream(req(''), ctx));
    expect(c.text).toBe('Hello from the mock provider.');
  });

  it('replays fixture scripts, including tool calls and once-only steps', async () => {
    const p = new MockProvider({ scripts: loadFixture('tool-call') });
    const first = await collect(p.stream(req('please summarize README'), ctx));
    expect(first.stop).toBe('tool_calls');
    expect(first.incomplete).toBe(false);
    expect(first.toolCalls).toEqual([
      { id: 'call_1', name: 'fs.read', args: { path: 'README.md' } },
    ]);
    const second = await collect(p.stream(req('please summarize README'), ctx));
    expect(second.text).toBe('The file describes Nova.');
  });

  it('matches scripts by regular expression', async () => {
    const p = new MockProvider({
      scripts: [
        { when: /^ping$/, steps: [{ type: 'text_delta', text: 'pong' }] },
        {
          steps: [
            { type: 'citation', url: 'https://example.com', title: 'Ex', snippet: 's' },
            { type: 'reasoning_delta', text: 'hmm' },
          ],
        },
      ],
    });
    expect((await collect(p.stream(req('ping'), ctx))).text).toBe('pong');
    const other = await collect(p.stream(req('anything'), ctx));
    expect(other.citations).toEqual([{ url: 'https://example.com', title: 'Ex', snippet: 's' }]);
    expect(other.reasoning).toBe('hmm');
  });

  it('injects errors', async () => {
    const p = new MockProvider({ failWith: { code: 'rate_limited' } });
    const c = await collect(p.stream(req('x'), ctx));
    expect(c.stop).toBe('error');
    expect(c.error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(c.incomplete).toBe(true);
    const q = await collect(
      new MockProvider({ failWith: { code: 'auth_expired', message: 'log in' } }).stream(
        req('x'),
        ctx,
      ),
    );
    expect(q.error).toEqual({ code: 'auth_expired', message: 'log in', retryable: false });
  });

  it('stops on cancel and keeps the partial output (FR-018)', async () => {
    const ac = new AbortController();
    const p = new MockProvider({ timing: { chunkDelayMs: 10 } });
    const words = 'one two three four five six seven eight nine ten';
    const seen: StreamEvent[] = [];
    for await (const e of p.stream(req(words, ac.signal), ctx)) {
      seen.push(e);
      if (seen.filter((x) => x.type === 'text_delta').length === 3) ac.abort();
    }
    expect(seen.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    const text = seen.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(`You said: ${words}`.length);
  });

  it('honours timing presets and explicit delays, and cancels during a delay', async () => {
    const ac = new AbortController();
    const p = new MockProvider({
      timing: 'streamed',
      scripts: [{ steps: [{ delayMs: 5_000 }, { type: 'text_delta', text: 'late' }] }],
    });
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    const c = await collect(p.stream(req('x', ac.signal), ctx));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(c.stop).toBe('cancelled');
    const slow = new MockProvider({
      timing: 'streamed',
      scripts: [{ steps: [{ delayMs: 1 }, { textChunks: ['a', 'b'] }] }],
    });
    expect((await collect(slow.stream(req('x'), ctx))).text).toBe('ab');
  });

  it('lists models and counts tokens', async () => {
    const p = new MockProvider({ capabilities: { vision: true } });
    expect((await p.listModels()).map((m) => m.id)).toEqual(['mock-fast', 'mock-smart']);
    expect(await p.countTokens(req('12345678'))).toBe(2);
    expect(p.capabilities.vision).toBe(true);
  });

  it('splits text into word chunks', () => {
    expect(splitWords('a bc  d')).toEqual(['a ', 'bc  ', 'd']);
    expect(splitWords('')).toEqual(['']);
  });
});

describe('MockProvider tool scripting (M3)', () => {
  const tools = [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object' } }];
  const withTools = (messages: ChatRequest['messages']): ChatRequest => ({
    model: 'mock-fast',
    messages,
    tools,
    signal: new AbortController().signal,
  });

  it('calls the tools named by /tool lines in one step', async () => {
    const p = new MockProvider();
    const c = await collect(
      p.stream(
        withTools([
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'please\n/tool fs.read {"path":"a.txt"}\n/tool fs.list\n/tool x.y {bad',
              },
            ],
          },
        ]),
        ctx,
      ),
    );
    expect(c.stop).toBe('tool_calls');
    expect(c.text).toBe('');
    expect(c.toolCalls).toEqual([
      { id: 'call_1', name: 'fs.read', args: { path: 'a.txt' } },
      { id: 'call_2', name: 'fs.list', args: {} },
      { id: 'call_3', name: 'x.y', args: '{bad' },
    ]);
    expect(c.usage.outputTokens).toBeGreaterThan(0);
  });

  it('answers from the results once they are in the request, without the untrusted envelope', async () => {
    const p = new MockProvider();
    const c = await collect(
      p.stream(
        withTools([
          { role: 'user', content: [{ type: 'text', text: '/tool fs.read {"path":"a"}' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'call_1', name: 'fs.read', args: { path: 'a' } }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                callId: 'call_1',
                untrusted: true,
                content: [
                  { type: 'text', text: '<untrusted_data source="fs.read" id="x">\n' },
                  { type: 'text', text: `${'z'.repeat(250)}` },
                  { type: 'text', text: '\n</untrusted_data id="x">' },
                ],
              },
            ],
          },
        ]),
        ctx,
      ),
    );
    expect(c.text).toBe(`Tool fs.read returned: ${'z'.repeat(200)}`);
    expect(c.stop).toBe('end');
  });

  it('behaves as before without tools or without /tool lines', async () => {
    const p = new MockProvider();
    const noTools = await collect(p.stream(req('/tool fs.read {}'), ctx));
    expect(noTools.text).toBe('You said: /tool fs.read {}');
    const plain = await collect(
      p.stream(withTools([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), ctx),
    );
    expect(plain.text).toBe('You said: hi');
    expect(
      toolSteps(withTools([{ role: 'system', content: [{ type: 'text', text: 'x' }] }])),
    ).toBeNull();
  });
});
