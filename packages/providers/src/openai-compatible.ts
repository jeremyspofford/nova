// OpenAI-compatible chat-completions adapter (docs/07 §3, §5, §9, §12, §14). One adapter serves
// OpenAI itself, Ollama's /v1 endpoint, llama.cpp-style servers and any other compatible API.
// Plain `fetch` + SSE; no vendor SDK. `stream()` never throws: every outcome, including errors
// and cancellation, ends with a `stop` event.
import { NovaError, uuidv7, type ProviderErrorCode } from '@nova/shared';
import { SseParser } from './sse.ts';
import type {
  AgentErrorShape,
  CallContext,
  ChatRequest,
  ContentPart,
  ModelInfo,
  NormalizedMessage,
  Provider,
  ProviderCapabilities,
  StopReason,
  StreamEvent,
} from './types.ts';

export type OpenAICompatibleKind = 'openai_compatible' | 'openai' | 'ollama';

export const DEFAULT_BASE_URLS: Record<'openai' | 'ollama', string> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};

export interface OpenAICompatibleOptions {
  id: string;
  kind?: OpenAICompatibleKind;
  /** Required for `openai_compatible`; defaults per kind otherwise. */
  baseUrl?: string;
  /** Resolved per request, so a rotated key applies at once and the value is not held. */
  apiKey?: string | (() => Promise<string | null>);
  capabilities?: Partial<ProviderCapabilities>;
  /** Time allowed until response headers arrive (docs/07 §9: 10 s). */
  connectTimeoutMs?: number;
  /** Longest silence allowed while streaming (docs/07 §9: 90 s). */
  idleTimeoutMs?: number;
  /** Retries before the first byte only (default 2). */
  maxRetries?: number;
  retryBaseMs?: number;
  /** A Retry-After longer than this is reported instead of waited out. */
  maxRetryAfterMs?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  random?: () => number;
}

const BASE_CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: false,
  promptCache: 'none',
  structuredOutput: false,
  imageGeneration: false,
  maxContextTokens: 32_000,
  maxOutputTokens: 4_096,
};

const KIND_CAPS: Record<OpenAICompatibleKind, Partial<ProviderCapabilities>> = {
  openai: {
    parallelToolCalls: true,
    vision: true,
    reasoning: 'levels',
    promptCache: 'short',
    structuredOutput: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  ollama: {},
  openai_compatible: {},
};

const MAX_ERROR_BODY = 8_192;

type Outcome =
  | { ok: true; res: Response; conn: AbortController }
  | { ok: false; error: AgentErrorShape; retryAfterMs?: number };

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly kind: OpenAICompatibleKind;
  readonly baseUrl: string;
  readonly capabilities: ProviderCapabilities;
  readonly #opts: OpenAICompatibleOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.kind = opts.kind ?? 'openai_compatible';
    const base =
      opts.baseUrl ??
      (this.kind === 'openai_compatible' ? undefined : DEFAULT_BASE_URLS[this.kind]);
    if (!base) throw new NovaError('validation', 'a base URL is required for this provider');
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new NovaError('validation', 'the base URL must use http or https');
    const trimmed = base.replace(/\/+$/, '');
    // Local servers are often entered as their bare address; their OpenAI-style API lives at /v1.
    this.baseUrl = this.kind === 'ollama' && !/\/v1$/.test(trimmed) ? `${trimmed}/v1` : trimmed;
    this.capabilities = { ...BASE_CAPS, ...KIND_CAPS[this.kind], ...opts.capabilities };
    this.#opts = opts;
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  get #host(): string {
    return new URL(this.baseUrl).host;
  }

  async #key(): Promise<string | null> {
    const k = this.#opts.apiKey;
    if (typeof k === 'function') return k();
    return k ?? null;
  }

  #headers(key: string | null, accept: string): Record<string, string> {
    const h: Record<string, string> = { accept, ...this.#opts.headers };
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  /** Strip the credential from any text that came back from the server. */
  #scrub(text: string, key: string | null): string {
    const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return key && key.length >= 4 ? clipped.split(key).join('[REDACTED]') : clipped;
  }

  // ---- models ---------------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    const key = await this.#key();
    try {
      const body = await this.#getJson(`${this.baseUrl}/models`, key);
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const ids = data.flatMap((m) => (isRecord(m) && typeof m.id === 'string' ? [m.id] : []));
      return toModels(ids);
    } catch (err) {
      // Ollama detection (docs/07 §12): older servers lack /v1/models but always have /api/tags.
      if (this.kind === 'openai') throw err;
      const origin = this.baseUrl.replace(/\/v1$/, '');
      try {
        const tags = await this.#getJson(`${origin}/api/tags`, key);
        const list = isRecord(tags) && Array.isArray(tags.models) ? tags.models : [];
        const ids = list.flatMap((m) =>
          isRecord(m) && typeof (m.model ?? m.name) === 'string' ? [String(m.model ?? m.name)] : [],
        );
        return toModels(ids);
      } catch {
        throw err;
      }
    }
  }

  async #getJson(url: string, key: string | null): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#opts.connectTimeoutMs ?? 10_000);
    try {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          headers: this.#headers(key, 'application/json'),
          signal: ac.signal,
        });
      } catch {
        throw new NovaError(
          ac.signal.aborted ? 'timeout' : 'network',
          ac.signal.aborted
            ? `${this.#host} did not answer in time`
            : `could not reach ${this.#host}`,
        );
      }
      if (!res.ok) {
        const e = mapHttpError(res.status, await readCapped(res), key !== null, (t) =>
          this.#scrub(t, key),
        );
        throw new NovaError(e.code, e.message, { retryable: e.retryable, action: e.action });
      }
      try {
        return await res.json();
      } catch {
        throw new NovaError('provider_error', `${this.#host} returned a response that is not JSON`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- streaming ------------------------------------------------------------------------

  async *stream(req: ChatRequest, _ctx: CallContext): AsyncIterable<StreamEvent> {
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    let key: string | null;
    try {
      key = await this.#key();
    } catch {
      yield stopError('auth_missing', 'the credential for this provider could not be read', false);
      return;
    }
    const names = new ToolNames(req.tools?.map((t) => t.name) ?? []);
    const body = JSON.stringify(this.#body(req, names));
    const url = `${this.baseUrl}/chat/completions`;
    const maxRetries = this.#opts.maxRetries ?? 2;

    let outcome: Outcome;
    for (let attempt = 0; ; attempt++) {
      outcome = await this.#connect(url, body, key, req.signal);
      if (outcome.ok) break;
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      const maxWait = this.#opts.maxRetryAfterMs ?? 30_000;
      const wait = Math.max(this.#backoff(attempt), outcome.retryAfterMs ?? 0);
      if (!outcome.error.retryable || attempt >= maxRetries || wait > maxWait) {
        yield { type: 'stop', reason: 'error', error: outcome.error };
        return;
      }
      if (!(await sleep(wait, req.signal))) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
    }
    yield* this.#read(outcome.res, outcome.conn, req, names, key);
  }

  #backoff(attempt: number): number {
    const base = this.#opts.retryBaseMs ?? 500;
    const random = this.#opts.random ?? Math.random;
    return Math.round(base * 2 ** attempt + random() * base);
  }

  #body(req: ChatRequest, names: ToolNames): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.flatMap(toWire),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: names.wire(t.name),
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      if (req.toolChoice) {
        body.tool_choice =
          typeof req.toolChoice === 'string'
            ? req.toolChoice
            : { type: 'function', function: { name: names.wire(req.toolChoice.name) } };
      }
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) {
      body[this.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
    }
    if (req.responseFormat?.type === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: req.responseFormat.schema },
      };
    }
    return body;
  }

  async #connect(
    url: string,
    body: string,
    key: string | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const conn = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.abort();
    }, this.#opts.connectTimeoutMs ?? 10_000);
    try {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: 'POST',
          headers: {
            ...this.#headers(key, 'text/event-stream'),
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.any([signal, conn.signal]),
        });
      } catch {
        if (signal.aborted) return { ok: false, error: err('cancelled', 'cancelled', false) };
        return {
          ok: false,
          error: timedOut
            ? err('timeout', `${this.#host} did not answer within the connect timeout`, true)
            : err('network', `could not reach ${this.#host}`, true),
        };
      }
      if (res.ok && res.body) return { ok: true, res, conn };
      const text = res.ok ? '' : await readCapped(res);
      const retryAfterMs = parseRetryAfter(res.headers);
      const error = res.ok
        ? err('provider_error', `${this.#host} returned an empty response`, true)
        : mapHttpError(res.status, text, key !== null, (t) => this.#scrub(t, key));
      return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async *#read(
    res: Response,
    conn: AbortController,
    req: ChatRequest,
    names: ToolNames,
    key: string | null,
  ): AsyncGenerator<StreamEvent> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const tools = new ToolCallAccumulator(names);
    const idleMs = this.#opts.idleTimeoutMs ?? 90_000;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let idleFired = false;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        idleFired = true;
        conn.abort();
      }, idleMs);
    };
    let finish: string | null = null;
    let done = false;
    let failure: AgentErrorShape | null = null;
    let started = false;

    armIdle();
    try {
      outer: for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (req.signal.aborted) break;
          failure = idleFired
            ? err(
                'timeout',
                `${this.#host} stopped sending for ${Math.round(idleMs / 1000)} s`,
                true,
              )
            : err('network', `the connection to ${this.#host} was lost mid-response`, true);
          break;
        }
        const datas = chunk.done
          ? parser.end()
          : parser.push(decoder.decode(chunk.value, { stream: true }));
        if (!chunk.done) armIdle();
        for (const data of datas) {
          if (data === '[DONE]') {
            done = true;
            break outer;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            failure = err('provider_error', `${this.#host} sent a malformed stream event`, false);
            break outer;
          }
          if (!isRecord(parsed)) continue;
          if (isRecord(parsed.error)) {
            failure = mapHttpError(0, JSON.stringify(parsed), key !== null, (t) =>
              this.#scrub(t, key),
            );
            break outer;
          }
          if (!started) {
            started = true;
            yield {
              type: 'start',
              messageId: typeof parsed.id === 'string' ? parsed.id : uuidv7(),
              model: typeof parsed.model === 'string' ? parsed.model : req.model,
            };
          }
          const choice = Array.isArray(parsed.choices)
            ? (parsed.choices as unknown[])[0]
            : undefined;
          if (isRecord(choice)) {
            const delta = isRecord(choice.delta) ? choice.delta : {};
            // Local servers put thinking in `reasoning` / `reasoning_content`; never content.
            const reasoning = delta.reasoning ?? delta.reasoning_content;
            if (typeof reasoning === 'string' && reasoning)
              yield { type: 'reasoning_delta', text: reasoning };
            if (typeof delta.content === 'string' && delta.content)
              yield { type: 'text_delta', text: delta.content };
            if (Array.isArray(delta.tool_calls)) yield* tools.push(delta.tool_calls);
            if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
              finish = choice.finish_reason;
              yield* tools.end();
            }
          }
          if (isRecord(parsed.usage)) yield toUsage(parsed.usage);
          if (req.signal.aborted) break outer;
        }
        if (chunk.done || req.signal.aborted) break;
      }
    } finally {
      clearTimeout(idle);
      if (!done) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    if (failure) {
      yield { type: 'stop', reason: 'error', error: failure };
      return;
    }
    if (!done && finish === null) {
      yield stopError(
        'network',
        `the connection to ${this.#host} closed before the response finished`,
        true,
      );
      return;
    }
    yield* tools.end();
    if (finish === 'content_filter') {
      yield stopError(
        'content_filter',
        'the provider stopped the response (content filter)',
        false,
      );
      return;
    }
    yield { type: 'stop', reason: toStop(finish) };
  }
}

// ---- wire mapping -----------------------------------------------------------------------

function toWire(m: NormalizedMessage): Record<string, unknown>[] {
  const text = m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  const results = m.content.filter(
    (p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result',
  );
  if (m.role === 'tool' || results.length) {
    return results.map((r) => ({
      role: 'tool',
      tool_call_id: r.callId,
      content: r.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
    }));
  }
  if (m.role === 'assistant') {
    const calls = m.content.flatMap((p) =>
      p.type === 'tool_call'
        ? [
            {
              id: p.id,
              type: 'function',
              function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
            },
          ]
        : [],
    );
    const out: Record<string, unknown> = { role: 'assistant', content: text || null };
    if (calls.length) out.tool_calls = calls;
    return [out];
  }
  if (m.role === 'user' && m.content.some((p) => p.type === 'image')) {
    return [
      {
        role: 'user',
        content: m.content.flatMap((p): Record<string, unknown>[] => {
          if (p.type === 'text') return [{ type: 'text', text: p.text }];
          if (p.type === 'image')
            return [{ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }];
          return [];
        }),
      },
    ];
  }
  return [{ role: m.role, content: text }];
}

/** Function names must match ^[a-zA-Z0-9_-]+$ on the wire; Nova names use dots (docs/07 §7). */
class ToolNames {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();
  constructor(names: string[]) {
    for (const n of names) {
      let w = n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
      for (let i = 2; this.#fromWire.has(w); i++) w = `${w.slice(0, 60)}_${i}`;
      this.#toWire.set(n, w);
      this.#fromWire.set(w, n);
    }
  }
  wire(name: string): string {
    return this.#toWire.get(name) ?? name;
  }
  original(wire: string): string {
    return this.#fromWire.get(wire) ?? wire;
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
}

/** Accumulates streamed tool-call fragments and parses the arguments at the end. */
class ToolCallAccumulator {
  readonly #calls = new Map<number, PendingCall>();
  readonly #names: ToolNames;
  constructor(names: ToolNames) {
    this.#names = names;
  }

  *push(deltas: unknown[]): Generator<StreamEvent> {
    for (const d of deltas) {
      if (!isRecord(d)) continue;
      const index = typeof d.index === 'number' ? d.index : this.#calls.size;
      const fn = isRecord(d.function) ? d.function : {};
      let call = this.#calls.get(index);
      if (!call) {
        call = { id: '', name: '', args: '', started: false, ended: false };
        this.#calls.set(index, call);
      }
      if (typeof d.id === 'string' && d.id && !call.id) call.id = d.id;
      if (typeof fn.name === 'string' && fn.name && !call.started) call.name += fn.name;
      const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
      if (!call.started && call.name) {
        call.started = true;
        call.id ||= `call_${index}`;
        yield {
          type: 'tool_call_start',
          index,
          id: call.id,
          name: this.#names.original(call.name),
        };
        if (call.args) yield { type: 'tool_call_delta', index, argsDelta: call.args };
      }
      call.args += argsDelta;
      if (call.started && argsDelta) yield { type: 'tool_call_delta', index, argsDelta };
    }
  }

  *end(): Generator<StreamEvent> {
    for (const [index, call] of [...this.#calls].sort((a, b) => a[0] - b[0])) {
      if (call.ended) continue;
      call.ended = true;
      if (!call.started) {
        call.id ||= `call_${index}`;
        yield { type: 'tool_call_start', index, id: call.id, name: call.name || 'unknown' };
      }
      let args: unknown = {};
      if (call.args.trim()) {
        try {
          args = JSON.parse(call.args);
        } catch {
          // Left as the raw string: the runtime validates arguments before running a tool.
          args = call.args;
        }
      }
      yield { type: 'tool_call_end', index, args };
    }
  }
}

function toUsage(u: Record<string, unknown>): StreamEvent {
  const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const ev: Extract<StreamEvent, { type: 'usage' }> = { type: 'usage' };
  if (typeof u.prompt_tokens === 'number') ev.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') ev.outputTokens = u.completion_tokens;
  if (typeof details.cached_tokens === 'number') ev.cachedTokens = details.cached_tokens;
  return ev;
}

function toStop(finish: string | null): StopReason {
  switch (finish) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'end';
  }
}

function toModels(ids: string[]): ModelInfo[] {
  return [...new Set(ids)].sort().map((id) => ({ id, label: id, capabilities: {} }));
}

// ---- errors (docs/07 §14) ---------------------------------------------------------------

const CONTEXT =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|reduce the length/i;

export function mapHttpError(
  status: number,
  bodyText: string,
  hadKey: boolean,
  scrub: (text: string) => string = (t) => t,
): AgentErrorShape {
  let detail = bodyText.trim();
  let code = '';
  try {
    // `{error: {message, code, type}}` (OpenAI and most servers) or `{error: "..."}` (Ollama).
    const body: unknown = JSON.parse(bodyText);
    const e = isRecord(body) ? body.error : undefined;
    if (typeof e === 'string') detail = e;
    if (isRecord(e)) {
      detail = typeof e.message === 'string' ? e.message : '';
      code = [e.code, e.type].filter((v) => typeof v === 'string').join(' ');
    }
  } catch {
    // not JSON: keep the text
  }
  detail = scrub(detail);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return hadKey
      ? err(
          'auth_expired',
          `the provider rejected the credential (${status})${suffix}`,
          false,
          'Reconnect account',
        )
      : err(
          'auth_missing',
          `the provider requires a credential (${status})${suffix}`,
          false,
          'Add an API key',
        );
  }
  if (status === 429 && /insufficient_quota|billing/i.test(code + detail)) {
    return err(
      'over_budget',
      `the provider account is out of credit${suffix}`,
      false,
      'Check billing',
    );
  }
  if (status === 429)
    return err(
      'rate_limited',
      `rate limited by the provider${suffix}`,
      true,
      'Wait or switch model',
    );
  if (/context_length/i.test(code) || CONTEXT.test(detail)) {
    return err(
      'context_length',
      `the conversation is too long for this model${suffix}`,
      false,
      'Reduce context',
    );
  }
  if (status === 408) return err('timeout', `the provider timed out${suffix}`, true);
  if (status >= 500) return err('provider_error', `the provider failed (${status})${suffix}`, true);
  if (status === 404)
    return err('invalid_request', `model or endpoint not found${suffix}`, false, 'Switch model');
  if (status >= 400)
    return err('invalid_request', `the provider refused the request (${status})${suffix}`, false);
  return err('provider_error', `the provider reported an error${suffix}`, false);
}

export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const v = headers.get('retry-after');
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.max(0, Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function err(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  action?: string,
): AgentErrorShape {
  const e: AgentErrorShape = { code, message: capitalize(message), retryable };
  if (action) e.action = action;
  return e;
}

function stopError(code: ProviderErrorCode, message: string, retryable: boolean): StreamEvent {
  return { type: 'stop', reason: 'error', error: err(code, message, retryable) };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function readCapped(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_ERROR_BODY);
  } catch {
    return '';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
