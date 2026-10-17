// Conformance of the OpenAI-compatible adapter against a local fake server replaying recorded
// SSE fixtures (docs/07 §15): happy path, reasoning fields, tool calls, auth errors, retries,
// mid-stream drops, cancellation, malformed chunks and timeouts.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenAICompatibleProvider,
  SseParser,
  collect,
  mapHttpError,
  parseRetryAfter,
  type ChatRequest,
  type OpenAICompatibleOptions,
  type StreamEvent,
} from '../src/index.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base: string;
let handlers: Handler[];
let seen: Seen[];

beforeEach(async () => {
  handlers = [];
  seen = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const h = handlers.shift();
      if (!h) {
        res.writeHead(500).end('no handler');
        return;
      }
      h(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/v1`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/openai/${name}.sse`, import.meta.url), 'utf8');

/** Replay an SSE body in small pieces so the parser sees events split across reads. */
const sse =
  (text: string, opts: { pieces?: number; delayMs?: number; end?: boolean } = {}): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const size = Math.max(1, Math.ceil(text.length / (opts.pieces ?? 7)));
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const next = () => {
      const c = chunks.shift();
      if (c === undefined) {
        if (opts.end === false) res.socket?.destroy();
        else res.end();
        return;
      }
      res.write(c);
      setTimeout(next, opts.delayMs ?? 1);
    };
    next();
  };

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'gpt-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  signal: new AbortController().signal,
  ...over,
});
const ctx = { requestId: 'r1' };

const provider = (opts: Partial<OpenAICompatibleOptions> = {}) =>
  new OpenAICompatibleProvider({
    id: 'p1',
    baseUrl: base,
    apiKey: 'sk-test-key-0123456789abcdef',
    retryBaseMs: 1,
    random: () => 0,
    ...opts,
  });

async function events(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('OpenAICompatibleProvider streaming', () => {
  it('streams text and usage, sending the key, stream options and mapped messages', async () => {
    handlers.push(sse(fixture('text')));
    const ev = await events(
      provider().stream(
        req({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            { role: 'user', content: [{ type: 'text', text: 'again' }] },
          ],
          temperature: 0.2,
          maxTokens: 50,
        }),
        ctx,
      ),
    );
    expect(ev[0]).toMatchObject({ type: 'start', messageId: 'chatcmpl-1', model: 'gpt-test' });
    const text = ev.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello, world');
    expect(ev).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 3, cachedTokens: 4 });
    expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'end' });
    const sent = seen[0]!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-test-key-0123456789abcdef');
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 50,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('maps reasoning and reasoning_content to reasoning deltas, never content', async () => {
    handlers.push(sse(fixture('reasoning'), { pieces: 13 }));
    const c = await collect(provider({ kind: 'ollama', apiKey: undefined }).stream(req(), ctx));
    expect(c.reasoning).toBe('Let me think about it. Still thinking.');
    expect(c.text).toBe('The answer is 4.');
    expect(c.stop).toBe('length');
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('accumulates tool calls, maps wire names back and parses arguments', async () => {
    handlers.push(sse(fixture('tool-calls'), { pieces: 20 }));
    const p = provider();
    const ev = await events(
      p.stream(
        req({
          tools: [
            { name: 'fs.read', description: 'read', inputSchema: { type: 'object' } },
            { name: 'web_search', description: 'search', inputSchema: { type: 'object' } },
          ],
          toolChoice: { name: 'fs.read' },
        }),
        ctx,
      ),
    );
    expect(ev.filter((e) => e.type === 'tool_call_start')).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_abc', name: 'fs.read' },
      { type: 'tool_call_start', index: 1, id: 'call_def', name: 'web_search' },
    ]);
    const c = await collect(
      (async function* () {
        await Promise.resolve();
        yield* ev;
      })(),
    );
    expect(c.toolCalls).toEqual([
      { id: 'call_abc', name: 'fs.read', args: { path: 'README.md' } },
      { id: 'call_def', name: 'web_search', args: { q: 'nova' } },
    ]);
    expect(c.stop).toBe('tool_calls');
    const body = JSON.parse(seen[0]!.body);
    expect(body.tools[0].function.name).toBe('fs_read');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'fs_read' } });
  });

  it('sends images as data URLs and tool results as tool messages', async () => {
    handlers.push(sse(fixture('text')));
    await collect(
      provider({ kind: 'openai', baseUrl: base }).stream(
        req({
          maxTokens: 9,
          responseFormat: { type: 'json_schema', schema: { type: 'object' } },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look' },
                { type: 'image', mime: 'image/png', data: 'AAAA' },
              ],
            },
            {
              role: 'assistant',
              content: [{ type: 'tool_call', id: 'c1', name: 'x', args: { a: 1 } }],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool_result',
                  callId: 'c1',
                  content: [{ type: 'text', text: 'ok' }],
                  untrusted: true,
                },
              ],
            },
          ],
        }),
        ctx,
      ),
    );
    const body = JSON.parse(seen[0]!.body);
    expect(body.max_completion_tokens).toBe(9);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });
});

describe('OpenAICompatibleProvider errors (docs/07 §14)', () => {
  it('maps 401 to auth_expired with a key, never echoing the key', async () => {
    handlers.push(
      json(401, {
        error: { message: 'Incorrect API key provided: sk-test-key-0123456789abcdef' },
      }),
    );
    const c = await collect(provider().stream(req(), ctx));
    expect(c.stop).toBe('error');
    expect(c.error).toMatchObject({ code: 'auth_expired', retryable: false });
    expect(c.error!.message).not.toContain('sk-test-key-0123456789abcdef');
    expect(c.error!.message).toContain('[REDACTED]');
    expect(seen).toHaveLength(1);
  });

  it('maps 401/403 without a key to auth_missing', async () => {
    handlers.push(json(403, { error: 'forbidden' }));
    const c = await collect(provider({ apiKey: () => Promise.resolve(null) }).stream(req(), ctx));
    expect(c.error).toMatchObject({ code: 'auth_missing', action: 'Add an API key' });
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    handlers.push(json(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }));
    handlers.push(json(503, { error: { message: 'busy' } }));
    handlers.push(sse(fixture('text')));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.text).toBe('Hello, world');
    expect(c.stop).toBe('end');
    expect(seen).toHaveLength(3);
  });

  it('gives up after two retries and reports the last error', async () => {
    for (let i = 0; i < 3; i++) handlers.push(json(429, { error: { message: 'no' } }));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(seen).toHaveLength(3);
  });

  it('does not wait out a Retry-After longer than the cap', async () => {
    handlers.push(json(429, { error: { message: 'later' } }, { 'retry-after': '120' }));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.error?.code).toBe('rate_limited');
    expect(seen).toHaveLength(1);
  });

  it('maps quota, context-length, not-found and server errors', () => {
    expect(
      mapHttpError(429, '{"error":{"code":"insufficient_quota","message":"x"}}', true).code,
    ).toBe('over_budget');
    expect(
      mapHttpError(400, '{"error":{"code":"context_length_exceeded","message":"too long"}}', true),
    ).toMatchObject({ code: 'context_length', action: 'Reduce context' });
    expect(mapHttpError(400, 'This model maximum context length is 8192', true).code).toBe(
      'context_length',
    );
    expect(mapHttpError(404, '{"error":"model not found"}', true).code).toBe('invalid_request');
    expect(mapHttpError(422, '', true).code).toBe('invalid_request');
    expect(mapHttpError(408, '', true)).toMatchObject({ code: 'timeout', retryable: true });
    expect(mapHttpError(502, 'bad gateway', true)).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    expect(mapHttpError(0, '{"error":{"message":"boom"}}', true).code).toBe('provider_error');
  });

  it('reports a dropped connection mid-stream as a network error, keeping the partial text', async () => {
    const partial = fixture('text').split(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    )[0]!;
    handlers.push(sse(partial, { end: false }));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.text).toBe('Hello, world');
    expect(c.stop).toBe('error');
    expect(c.error).toMatchObject({ code: 'network', retryable: true });
    expect(seen).toHaveLength(1);
  });

  it('cancels mid-stream on abort and stops reading', async () => {
    const ac = new AbortController();
    handlers.push(sse(fixture('text'), { pieces: 40, delayMs: 20 }));
    const ev: StreamEvent[] = [];
    for await (const e of provider().stream(req({ signal: ac.signal }), ctx)) {
      ev.push(e);
      if (e.type === 'start') ac.abort();
    }
    expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
  });

  it('cancels before connecting and during a retry wait', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await collect(provider().stream(req({ signal: ac.signal }), ctx))).stop).toBe(
      'cancelled',
    );
    const ac2 = new AbortController();
    handlers.push(json(503, {}));
    setTimeout(() => ac2.abort(), 30);
    const c = await collect(
      provider({ retryBaseMs: 5_000 }).stream(req({ signal: ac2.signal }), ctx),
    );
    expect(c.stop).toBe('cancelled');
  });

  it('fails a malformed chunk with provider_error', async () => {
    handlers.push(
      sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {not json}\n\ndata: [DONE]\n\n'),
    );
    const c = await collect(provider().stream(req(), ctx));
    expect(c.text).toBe('ok');
    expect(c.error).toMatchObject({ code: 'provider_error', retryable: false });
  });

  it('maps an error object sent inside the stream', async () => {
    handlers.push(sse('data: {"error":{"message":"prompt is too long"}}\n\n'));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.error?.code).toBe('context_length');
  });

  it('times out an idle stream and a slow connect', async () => {
    handlers.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    });
    const idle = await collect(provider({ idleTimeoutMs: 50 }).stream(req(), ctx));
    expect(idle.text).toBe('x');
    expect(idle.error).toMatchObject({ code: 'timeout', retryable: true });

    handlers.push(() => undefined); // never answers
    const slow = await collect(
      provider({ connectTimeoutMs: 40, maxRetries: 0 }).stream(req(), ctx),
    );
    expect(slow.error).toMatchObject({ code: 'timeout' });
  });

  it('reports an unreachable server as a retryable network error', async () => {
    const c = await collect(
      provider({ baseUrl: 'http://127.0.0.1:9/v1', maxRetries: 0 }).stream(req(), ctx),
    );
    expect(c.error).toMatchObject({ code: 'network', retryable: true });
  });

  it('reports a credential that cannot be read', async () => {
    const c = await collect(
      provider({
        apiKey: () => Promise.reject(new Error('vault locked')),
      }).stream(req(), ctx),
    );
    expect(c.error?.code).toBe('auth_missing');
  });

  it('flags content filtering and treats a stream without [DONE] after finish as complete', async () => {
    handlers.push(
      sse('data: {"choices":[{"delta":{"content":"a"},"finish_reason":"content_filter"}]}\n\n'),
    );
    expect((await collect(provider().stream(req(), ctx))).error?.code).toBe('content_filter');
    handlers.push(sse('data: {"choices":[{"delta":{"content":"a"},"finish_reason":"stop"}]}'));
    const c = await collect(provider().stream(req(), ctx));
    expect(c.stop).toBe('end');
    expect(c.text).toBe('a');
  });
});

describe('OpenAICompatibleProvider models and config', () => {
  it('lists models from /models', async () => {
    handlers.push(json(200, { data: [{ id: 'b-model' }, { id: 'a-model' }, { nope: 1 }] }));
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(['a-model', 'b-model']);
    expect(seen[0]!.url).toBe('/v1/models');
  });

  it("falls back to Ollama's /api/tags when /models fails", async () => {
    handlers.push(json(404, { error: 'not found' }));
    handlers.push(
      json(200, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'llama3' }] }),
    );
    const models = await provider({ kind: 'ollama' }).listModels();
    expect(models.map((m) => m.id)).toEqual(['llama3', 'qwen3:8b']);
    expect(seen[1]!.url).toBe('/api/tags');
  });

  it('raises a typed error when listing fails', async () => {
    handlers.push(json(401, { error: { message: 'bad key' } }));
    await expect(provider({ kind: 'openai', baseUrl: base }).listModels()).rejects.toMatchObject({
      code: 'auth_expired',
    });
    handlers.push((_r, res) => res.writeHead(200).end('<html>'));
    handlers.push(json(500, {}));
    await expect(provider().listModels()).rejects.toMatchObject({ code: 'provider_error' });
    await expect(provider({ baseUrl: 'http://127.0.0.1:9/v1' }).listModels()).rejects.toMatchObject(
      { code: 'network' },
    );
  });

  it('applies per-kind defaults and validates the base URL', () => {
    expect(new OpenAICompatibleProvider({ id: 'o', kind: 'openai' }).baseUrl).toBe(
      'https://api.openai.com/v1',
    );
    const ollama = new OpenAICompatibleProvider({ id: 'l', kind: 'ollama' });
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434/v1');
    // A bare local address gets the /v1 API path; one that already has it is kept.
    expect(
      new OpenAICompatibleProvider({ id: 'l2', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/' })
        .baseUrl,
    ).toBe('http://127.0.0.1:11434/v1');
    expect(
      new OpenAICompatibleProvider({ id: 'l3', kind: 'ollama', baseUrl: 'http://box:11434/v1' })
        .baseUrl,
    ).toBe('http://box:11434/v1');
    expect(ollama.capabilities.vision).toBe(false);
    expect(new OpenAICompatibleProvider({ id: 'o', kind: 'openai' }).capabilities.vision).toBe(
      true,
    );
    expect(() => new OpenAICompatibleProvider({ id: 'x' })).toThrow(/base URL is required/);
    expect(() => new OpenAICompatibleProvider({ id: 'x', baseUrl: 'file:///etc' })).toThrow(
      /http or https/,
    );
  });

  it('parses Retry-After as seconds, milliseconds or a date', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '150' }))).toBe(150);
    const now = Date.parse('2026-10-17T00:00:00Z');
    expect(
      parseRetryAfter(new Headers({ 'retry-after': 'Sat, 17 Oct 2026 00:00:05 GMT' }), now),
    ).toBe(5000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});

describe('SseParser', () => {
  it('joins multi-line data, ignores comments and other fields, and handles CRLF splits', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\ndata: b\r\n\r\n: c\nevent: x\nid: 1\ndata:d\n')).toEqual(['a\nb']);
    expect(p.push('\n')).toEqual(['d']);
    expect(p.push('data')).toEqual([]);
    expect(p.end()).toEqual(['']);
  });
});
