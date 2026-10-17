// ProviderConformance (docs/07 §15): one suite every HTTP adapter passes against a fake server
// replaying its recorded fixtures. Streaming text, reasoning, tool calls (start/delta/end with
// parsed arguments), usage, error mapping with `retryable`, Retry-After, cancellation, images
// in the input, dropped connections and model lists.
import { describe, expect, it } from 'vitest';
import type { ProviderErrorCode } from '@nova/shared';
import { collect, type ChatRequest, type Provider, type StreamEvent } from '../src/index.ts';
import { cutBefore, events, json, sse, useFakeServer, type Seen } from './fake-server.ts';

export const KEY = 'sk-conformance-key-0123456789abcdef';

export type ErrorKind = 'auth' | 'rate' | 'server' | 'bad' | 'context';

export interface ConformanceSpec {
  name: string;
  /** Build the adapter against the fake server's origin (`http://127.0.0.1:<port>`). */
  make(
    origin: string,
    opts: { apiKey: string | null; maxRetries: number; retryBaseMs?: number },
  ): Provider;
  /** Path of the streaming endpoint, e.g. `/v1/chat/completions`. */
  streamPath: string;
  /** Path prefix of the model list. */
  modelsPath: string;
  fixtures: { text: string; reasoning: string; toolCalls: string };
  /** Marker inside the text fixture's final event, to simulate a dropped connection. */
  finalMarker: string;
  /** A model list naming `a-model` and `b-model`. */
  modelsBody: unknown;
  toolIds: [string, string];
  errorBody(kind: ErrorKind, message: string): unknown;
  /** Code for a 401 when a key was sent. */
  authCode: ProviderErrorCode;
  /** The credential header value the adapter sent, or undefined. */
  credential(seen: Seen): string | undefined;
  /** The image block in a sent body whose first message is [text, image]. */
  imageOf(body: Record<string, unknown>): unknown;
  expectedImage: unknown;
  /** Wire tool names in a sent body. */
  toolNames(body: Record<string, unknown>): string[];
}

const ctx = { requestId: 'conformance' };

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  signal: new AbortController().signal,
  ...over,
});

const TOOLS: ChatRequest['tools'] = [
  { name: 'fs.read', description: 'read', inputSchema: { type: 'object' } },
  { name: 'web_search', description: 'search', inputSchema: { type: 'object' } },
];

export function runConformance(spec: ConformanceSpec): void {
  describe(`ProviderConformance: ${spec.name}`, () => {
    const srv = useFakeServer();
    const make = (o: Partial<{ apiKey: string | null; maxRetries: number }> = {}) =>
      spec.make(srv.origin, { apiKey: KEY, maxRetries: 0, retryBaseMs: 1, ...o });

    it('streams text with a start event, usage and an end stop', async () => {
      srv.handlers.push(sse(spec.fixtures.text));
      const ev = await events(make().stream(req(), ctx));
      expect(ev[0]).toMatchObject({ type: 'start' });
      const text = ev.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
      expect(text).toBe('Hello, world');
      expect(ev).toContainEqual({
        type: 'usage',
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: 4,
      });
      expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'end' });
      expect(srv.seen[0]).toMatchObject({ method: 'POST', url: spec.streamPath });
      expect(spec.credential(srv.seen[0]!)).toBe(KEY);
    });

    it('keeps reasoning apart from the answer', async () => {
      srv.handlers.push(sse(spec.fixtures.reasoning, { pieces: 13 }));
      const c = await collect(make().stream(req(), ctx));
      expect(c.reasoning).toBe('Let me think about it. Still thinking.');
      expect(c.text).toBe('The answer is 4.');
      expect(c.stop).toBe('length');
    });

    it('streams tool calls as start, delta and end with parsed arguments', async () => {
      srv.handlers.push(sse(spec.fixtures.toolCalls, { pieces: 20 }));
      const ev = await events(make().stream(req({ tools: TOOLS }), ctx));
      expect(ev.filter((e) => e.type === 'tool_call_start')).toEqual([
        { type: 'tool_call_start', index: 0, id: spec.toolIds[0], name: 'fs.read' },
        { type: 'tool_call_start', index: 1, id: spec.toolIds[1], name: 'web_search' },
      ]);
      const deltas = ev.flatMap((e) =>
        e.type === 'tool_call_delta' && e.index === 0 ? [e.argsDelta] : [],
      );
      expect(deltas.join('')).toBe('{"path":"README.md"}');
      expect(ev.filter((e) => e.type === 'tool_call_end')).toEqual([
        { type: 'tool_call_end', index: 0, args: { path: 'README.md' } },
        { type: 'tool_call_end', index: 1, args: { q: 'nova' } },
      ]);
      expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'tool_calls' });
      expect(spec.toolNames(JSON.parse(srv.seen[0]!.body))).toEqual(['fs_read', 'web_search']);
    });

    it.each([
      [401, 'auth' as const, 'auth', false],
      [429, 'rate' as const, 'rate_limited', true],
      [500, 'server' as const, 'provider_error', true],
      [503, 'server' as const, 'provider_error', true],
      [400, 'bad' as const, 'invalid_request', false],
      [400, 'context' as const, 'context_length', false],
    ])('maps HTTP %i (%s) to a normalized error', async (status, kind, code, retryable) => {
      const message =
        kind === 'context'
          ? 'prompt is too long: 250000 tokens > 200000 maximum'
          : `failure for key ${KEY}`;
      srv.handlers.push(json(status, spec.errorBody(kind, message)));
      const c = await collect(make().stream(req(), ctx));
      expect(c.stop).toBe('error');
      expect(c.error).toMatchObject({
        code: code === 'auth' ? spec.authCode : code,
        retryable,
      });
      expect(c.error!.message).not.toContain(KEY);
      expect(srv.seen).toHaveLength(1);
    });

    it('surfaces Retry-After on a rate limit it does not wait out', async () => {
      srv.handlers.push(json(429, spec.errorBody('rate', 'slow down'), { 'retry-after': '3' }));
      const c = await collect(make().stream(req(), ctx));
      expect(c.error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 3000 });
    });

    it('retries before the first byte when asked to, honouring Retry-After', async () => {
      srv.handlers.push(json(429, spec.errorBody('rate', 'wait'), { 'retry-after': '0' }));
      srv.handlers.push(json(503, spec.errorBody('server', 'busy')));
      srv.handlers.push(sse(spec.fixtures.text));
      const c = await collect(make({ maxRetries: 2 }).stream(req(), ctx));
      expect(c.text).toBe('Hello, world');
      expect(srv.seen).toHaveLength(3);
    });

    it('cancels mid-stream, and before connecting without a request', async () => {
      const ac = new AbortController();
      srv.handlers.push(sse(spec.fixtures.text, { pieces: 40, delayMs: 20 }));
      const ev: StreamEvent[] = [];
      for await (const e of make().stream(req({ signal: ac.signal }), ctx)) {
        ev.push(e);
        if (e.type === 'start') ac.abort();
      }
      expect(ev.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
      const gone = new AbortController();
      gone.abort();
      expect((await collect(make().stream(req({ signal: gone.signal }), ctx))).stop).toBe(
        'cancelled',
      );
      expect(srv.seen).toHaveLength(1);
    });

    it('sends images in the provider wire format', async () => {
      srv.handlers.push(sse(spec.fixtures.text));
      await collect(
        make().stream(
          req({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'look' },
                  { type: 'image', mime: 'image/png', data: 'AAAA' },
                ],
              },
            ],
          }),
          ctx,
        ),
      );
      expect(spec.imageOf(JSON.parse(srv.seen[0]!.body))).toEqual(spec.expectedImage);
    });

    it('reports a dropped connection as a retryable network error, keeping partial text', async () => {
      srv.handlers.push(sse(cutBefore(spec.fixtures.text, spec.finalMarker), { end: false }));
      const c = await collect(make().stream(req(), ctx));
      expect(c.text).toBe('Hello, world');
      expect(c.error).toMatchObject({ code: 'network', retryable: true });
    });

    it('sends no credential when it has none', async () => {
      srv.handlers.push(sse(spec.fixtures.text));
      await collect(make({ apiKey: null }).stream(req(), ctx));
      expect(spec.credential(srv.seen[0]!)).toBeUndefined();
    });

    it('lists models', async () => {
      srv.handlers.push(json(200, spec.modelsBody));
      const models = await make().listModels();
      expect(models.map((m) => m.id).sort()).toEqual(['a-model', 'b-model']);
      expect(srv.seen[0]!.url.startsWith(spec.modelsPath)).toBe(true);
    });

    it('raises a typed error when the model list fails', async () => {
      srv.handlers.push(json(401, spec.errorBody('auth', 'nope')));
      await expect(make().listModels()).rejects.toMatchObject({ code: spec.authCode });
    });
  });
}
