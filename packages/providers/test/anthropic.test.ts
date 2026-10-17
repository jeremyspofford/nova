// Anthropic adapter specifics beyond the shared conformance suite: request mapping (system
// split, content blocks, merged turns), thinking and effort per model generation, tool choice,
// fast mode, caching hints, model-list pagination, refusals and in-stream errors.
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_FAST_BETA,
  AnthropicProvider,
  anthropicTraits,
  collect,
  mapAnthropicError,
  parseClaudeId,
  type AnthropicOptions,
  type ChatRequest,
} from '../src/index.ts';
import { events, fixture, json, sse, useFakeServer } from './fake-server.ts';

const srv = useFakeServer();
const KEY = 'sk-ant-test-0123456789abcdef';
const ctx = { requestId: 'a1' };

const provider = (o: Partial<AnthropicOptions> = {}) =>
  new AnthropicProvider({
    id: 'a',
    baseUrl: srv.origin,
    apiKey: KEY,
    maxRetries: 0,
    retryBaseMs: 1,
    random: () => 0,
    ...o,
  });

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  signal: new AbortController().signal,
  ...over,
});

/** Stream once against the text fixture and return the JSON body that was sent. */
async function sent(r: Partial<ChatRequest>, o: Partial<AnthropicOptions> = {}) {
  srv.handlers.push(sse(fixture('anthropic', 'text')));
  await collect(provider(o).stream(req(r), ctx));
  const s = srv.seen.at(-1)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON
  return { body: JSON.parse(s.body) as Record<string, any>, headers: s.headers };
}

describe('AnthropicProvider request mapping', () => {
  it('sends the key and version headers, splits the system prompt and maps content blocks', async () => {
    const { body, headers } = await sent({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_call', id: 'toolu_1', name: 'fs.read', args: { path: 'a' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'toolu_1',
              content: [{ type: 'text', text: 'contents' }],
              isError: true,
              untrusted: true,
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      ],
      tools: [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object' } }],
      metadata: { threadId: 't1' },
    });
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(body.system).toBe('be brief');
    expect(body.stream).toBe(true);
    expect(body.metadata).toBeUndefined();
    expect(body.max_tokens).toBe(32_000);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'fs_read', input: { path: 'a' } }],
      },
      {
        // The tool result and the next user text form one user turn.
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'contents' }],
            is_error: true,
          },
          { type: 'text', text: 'and now?' },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      { name: 'fs_read', description: 'read', input_schema: { type: 'object' } },
    ]);
  });

  it('maps reasoning levels to budget_tokens on budget-era models', async () => {
    const on = await sent({ reasoning: { level: 'high' }, temperature: 0.3 });
    expect(on.body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
    expect(on.body.max_tokens).toBe(48_384);
    expect(on.body.temperature).toBeUndefined();
    const off = await sent({ reasoning: { level: 'off' }, temperature: 0.3 });
    expect(off.body.thinking).toBeUndefined();
    expect(off.body.temperature).toBe(0.3);
    const custom = await sent({ reasoning: { budgetTokens: 100 }, maxTokens: 500 });
    expect(custom.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1_024 });
    expect(custom.body.max_tokens).toBe(2_048);
    const max = await sent({ model: 'claude-opus-4-1', reasoning: { level: 'max' } });
    expect(max.body.max_tokens).toBe(32_000);
    expect(max.body.thinking.budget_tokens).toBeLessThan(32_000);
  });

  it('maps reasoning levels to adaptive thinking and effort on current models', async () => {
    const high = await sent({ model: 'claude-opus-4-8', reasoning: { level: 'high' } });
    expect(high.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(high.body.output_config).toEqual({ effort: 'high' });
    const off = await sent({ model: 'claude-opus-4-8', reasoning: { level: 'off' } });
    expect(off.body.thinking).toBeUndefined();
    expect(off.body.output_config).toBeUndefined();
    // 4.6 has no xhigh: the nearest lower level is used.
    const xhigh = await sent({ model: 'claude-opus-4-6', reasoning: { level: 'xhigh' } });
    expect(xhigh.body.output_config).toEqual({ effort: 'high' });
    // Thinking cannot be turned off on 5.x: "off" becomes the lowest effort.
    const always = await sent({
      model: 'claude-opus-5-5',
      reasoning: { level: 'off' },
      temperature: 0.5,
    });
    expect(always.body.thinking).toBeUndefined();
    expect(always.body.output_config).toEqual({ effort: 'low' });
    expect(always.body.temperature).toBeUndefined();
    const budget = await sent({ model: 'claude-opus-5', reasoning: { budgetTokens: 6_000 } });
    expect(budget.body.output_config).toEqual({ effort: 'medium' });
    const legacy = await sent({ model: 'claude-3-5-haiku-latest', reasoning: { level: 'high' } });
    expect(legacy.body.thinking).toBeUndefined();
    expect(legacy.body.max_tokens).toBe(8_192);
  });

  it('downgrades forced tool choice where the model or thinking refuses it', async () => {
    const tools = [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object' } }];
    const choice = async (r: Partial<ChatRequest>) =>
      (await sent({ tools, ...r })).body.tool_choice as unknown;
    expect(await choice({ toolChoice: 'required' })).toEqual({ type: 'any' });
    expect(await choice({ toolChoice: { name: 'fs.read' } })).toEqual({
      type: 'tool',
      name: 'fs_read',
    });
    expect(await choice({ toolChoice: 'none' })).toEqual({ type: 'none' });
    expect(await choice({ toolChoice: 'required', reasoning: { level: 'low' } })).toEqual({
      type: 'auto',
    });
    expect(await choice({ model: 'claude-opus-5-5', toolChoice: 'required' })).toEqual({
      type: 'auto',
    });
  });

  it('asks for the fast tier only on models that have one', async () => {
    const fast = await sent({ model: 'claude-opus-4-8', speed: 'fast' });
    expect(fast.headers['anthropic-beta']).toBe(ANTHROPIC_FAST_BETA);
    expect(fast.body.speed).toBe('fast');
    const plain = await sent({ model: 'claude-sonnet-4-5', speed: 'fast' });
    expect(plain.headers['anthropic-beta']).toBeUndefined();
    expect(plain.body.speed).toBeUndefined();
  });

  it('places cache breakpoints and structured output when asked', async () => {
    const { body } = await sent({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
      ],
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
      cacheHints: { system: true, tools: true, history: true },
      responseFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });

  it('honours a base URL with or without /v1 and defaults to the official endpoint', () => {
    expect(new AnthropicProvider({ id: 'x' }).baseUrl).toBe('https://api.anthropic.com/v1');
    expect(new AnthropicProvider({ id: 'x', baseUrl: 'http://box:9/v1/' }).baseUrl).toBe(
      'http://box:9/v1',
    );
    expect(new AnthropicProvider({ id: 'x', baseUrl: 'http://box:9/proxy' }).baseUrl).toBe(
      'http://box:9/proxy/v1',
    );
    expect(() => new AnthropicProvider({ id: 'x', baseUrl: 'file:///etc' })).toThrow(
      /http or https/,
    );
  });
});

describe('AnthropicProvider model list', () => {
  it('follows pagination and learns reported capabilities, which then drive requests', async () => {
    srv.handlers.push(
      json(200, {
        data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
        has_more: true,
        last_id: 'claude-sonnet-4-5',
      }),
    );
    srv.handlers.push(
      json(200, {
        data: [
          {
            id: 'house-model',
            display_name: 'House',
            max_input_tokens: 500_000,
            max_tokens: 20_000,
            capabilities: {
              image_input: { supported: false },
              thinking: {
                supported: true,
                types: { enabled: { supported: false }, adaptive: { supported: true } },
              },
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                xhigh: { supported: false },
                max: { supported: false },
              },
            },
          },
        ],
        has_more: false,
        last_id: 'house-model',
      }),
    );
    const p = provider();
    const models = await p.listModels();
    expect(srv.seen[1]!.url).toBe('/v1/models?limit=1000&after_id=claude-sonnet-4-5');
    expect(models).toEqual([
      {
        id: 'claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        capabilities: {
          vision: true,
          reasoning: 'budget',
          maxOutputTokens: 64_000,
          fastTier: false,
        },
      },
      {
        id: 'house-model',
        label: 'House',
        capabilities: {
          vision: false,
          reasoning: 'levels',
          maxOutputTokens: 20_000,
          fastTier: false,
          maxContextTokens: 500_000,
        },
      },
    ]);
    srv.handlers.push(sse(fixture('anthropic', 'text')));
    await collect(p.stream(req({ model: 'house-model', reasoning: { level: 'max' } }), ctx));
    const body = JSON.parse(srv.seen[2]!.body);
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.max_tokens).toBe(20_000);
  });
});

describe('AnthropicProvider stream outcomes', () => {
  const stream = (body: string) => {
    srv.handlers.push(sse(body));
    return collect(provider().stream(req(), ctx));
  };
  const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  const start = ev({
    type: 'message_start',
    message: { id: 'm', model: 'c', usage: { input_tokens: 5 } },
  });
  const text = (t: string) =>
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
  const stop = (reason: string) =>
    ev({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2 } }) +
    ev({ type: 'message_stop' });

  it('maps a refusal to content_filter', async () => {
    const c = await stream(start + text('I') + stop('refusal'));
    expect(c.error).toMatchObject({ code: 'content_filter', retryable: false });
  });

  it('maps an in-stream overloaded error to a retryable provider error, keeping text', async () => {
    const c = await stream(
      start +
        text('partial') +
        ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    );
    expect(c.text).toBe('partial');
    expect(c.error).toMatchObject({ code: 'provider_error', retryable: true });
    expect(c.usage.inputTokens).toBe(5);
  });

  it('treats a stream that ends after its stop reason as complete, and maps stop reasons', async () => {
    const done = await stream(
      start + text('a') + ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    );
    expect(done.stop).toBe('end');
    expect((await stream(start + text('a') + stop('pause_turn'))).stop).toBe('end');
    expect((await stream(start + text('a') + stop('model_context_window_exceeded'))).stop).toBe(
      'length',
    );
  });

  it('emits citations and fails a malformed event', async () => {
    const cited = await stream(
      start +
        ev({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              url: 'https://example.org',
              title: 'Example',
              cited_text: 'quote',
            },
          },
        }) +
        stop('end_turn'),
    );
    expect(cited.citations).toEqual([
      { url: 'https://example.org', title: 'Example', snippet: 'quote' },
    ]);
    const bad = await stream(`${start}data: {nope\n\n`);
    expect(bad.error).toMatchObject({ code: 'provider_error', retryable: false });
  });

  it('reports usage seen so far when cancelled mid-stream', async () => {
    const ac = new AbortController();
    srv.handlers.push(sse(fixture('anthropic', 'text'), { pieces: 40, delayMs: 20 }));
    const out = await events(
      (async function* () {
        for await (const e of provider().stream(req({ signal: ac.signal }), ctx)) {
          if (e.type === 'start') ac.abort();
          yield e;
        }
      })(),
    );
    expect(out.at(-2)).toMatchObject({ type: 'usage', inputTokens: 12 });
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
  });

  it('reports a credential that cannot be read', async () => {
    const c = await collect(
      provider({ apiKey: () => Promise.reject(new Error('locked')) }).stream(req(), ctx),
    );
    expect(c.error?.code).toBe('auth_missing');
  });
});

describe('Anthropic errors and model ids', () => {
  it('maps HTTP statuses and error types (docs/07 §14)', () => {
    const body = (type: string, message = 'x') =>
      JSON.stringify({ type: 'error', error: { type, message } });
    expect(mapAnthropicError(401, body('authentication_error'))).toMatchObject({
      code: 'auth_missing',
      retryable: false,
    });
    expect(mapAnthropicError(403, body('permission_error')).code).toBe('auth_missing');
    expect(mapAnthropicError(402, body('billing_error')).code).toBe('over_budget');
    expect(mapAnthropicError(404, body('not_found_error'))).toMatchObject({
      code: 'invalid_request',
      action: 'Switch model',
    });
    expect(mapAnthropicError(413, body('request_too_large')).code).toBe('invalid_request');
    expect(mapAnthropicError(429, body('rate_limit_error'))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(mapAnthropicError(529, body('overloaded_error'))).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    expect(mapAnthropicError(504, '')).toMatchObject({ code: 'timeout', retryable: true });
    expect(mapAnthropicError(502, 'bad gateway')).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    expect(
      mapAnthropicError(400, body('invalid_request_error', 'prompt is too long: 9 > 8')).code,
    ).toBe('context_length');
    expect(mapAnthropicError(0, body('weird')).code).toBe('provider_error');
    expect(
      mapAnthropicError(401, body('authentication_error', 'bad sk-1234'), (t) =>
        t.replace('sk-1234', '[REDACTED]'),
      ).message,
    ).toContain('[REDACTED]');
  });

  it('parses model ids across naming generations', () => {
    expect(parseClaudeId('claude-opus-4-8')).toEqual({ family: 'opus', version: 408 });
    expect(parseClaudeId('claude-sonnet-5')).toEqual({ family: 'sonnet', version: 500 });
    expect(parseClaudeId('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', version: 405 });
    expect(parseClaudeId('claude-opus-4-20250514')).toEqual({ family: 'opus', version: 400 });
    expect(parseClaudeId('claude-3-7-sonnet-20250219')).toEqual({ family: 'sonnet', version: 307 });
    expect(parseClaudeId('claude-3-opus-20240229')).toEqual({ family: 'opus', version: 300 });
    expect(parseClaudeId('gpt-4o')).toBeNull();
    expect(anthropicTraits('claude-fable-5-1')).toMatchObject({
      thinking: 'adaptive',
      alwaysThinks: true,
      forcedTools: false,
    });
    expect(anthropicTraits('claude-haiku-4-5')).toMatchObject({ thinking: 'budget' });
    expect(anthropicTraits('claude-haiku-5-5')).toMatchObject({
      thinking: 'adaptive',
      forcedTools: true,
    });
    expect(anthropicTraits('claude-3-haiku-20240307').maxOutput).toBe(4_096);
    expect(anthropicTraits('proxy-alias')).toMatchObject({ thinking: 'none', maxOutput: 8_192 });
  });
});
