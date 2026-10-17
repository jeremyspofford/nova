// OpenAI-compatible chat-completions adapter (docs/07 §3, §5, §6, §9, §12, §14). One adapter
// serves OpenAI itself, OpenRouter, Ollama's /v1 endpoint, llama.cpp servers and any other
// compatible API. Plain `fetch` + SSE; no vendor SDK. `stream()` never throws: every outcome,
// including errors and cancellation, ends with a `stop` event.
import { NovaError, uuidv7 } from '@nova/shared';
import { DEFAULT_BASE_URLS } from './defaults.ts';
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
import {
  ToolNames,
  connectSse,
  err,
  getJson,
  isRecord,
  normalizeBase,
  readSseData,
  resolveKey,
  scrub,
  stopError,
} from './wire.ts';

export { parseRetryAfter } from './wire.ts';

export type OpenAICompatibleKind =
  'openai_compatible' | 'openai' | 'ollama' | 'openrouter' | 'llamacpp';

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
  /** Retries before the first byte only (default 2; the Hub's router retries instead, so 0). */
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
  // Per-model vision and reasoning come from OpenRouter's model list.
  openrouter: {
    parallelToolCalls: true,
    reasoning: 'levels',
    structuredOutput: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  ollama: {},
  llamacpp: {},
  openai_compatible: {},
};

/** Kinds whose servers run on the user's hardware; their bare address gets the `/v1` path. */
const LOCAL_SERVER_KINDS = new Set<OpenAICompatibleKind>(['ollama', 'llamacpp']);

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
    // Local servers are often entered as their bare address; their OpenAI-style API lives at /v1.
    this.baseUrl = normalizeBase(base, LOCAL_SERVER_KINDS.has(this.kind));
    this.capabilities = { ...BASE_CAPS, ...KIND_CAPS[this.kind], ...opts.capabilities };
    this.#opts = opts;
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  get #host(): string {
    return new URL(this.baseUrl).host;
  }

  #headers(key: string | null, accept: string): Record<string, string> {
    const h: Record<string, string> = { accept, ...this.#opts.headers };
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  // ---- models ---------------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    const key = await resolveKey(this.#opts.apiKey);
    try {
      const body = await this.#getJson(`${this.baseUrl}/models`, key);
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      if (this.kind === 'openrouter') return openRouterModels(data);
      const ids = data.flatMap((m) => (isRecord(m) && typeof m.id === 'string' ? [m.id] : []));
      return toModels(ids, this.kind);
    } catch (e) {
      // Ollama detection (docs/07 §12): older servers lack /v1/models but always have /api/tags.
      if (this.kind === 'openai' || this.kind === 'openrouter') throw e;
      const origin = this.baseUrl.replace(/\/v1$/, '');
      try {
        const tags = await this.#getJson(`${origin}/api/tags`, key);
        return toModels(ollamaTagIds(tags), this.kind);
      } catch {
        throw e;
      }
    }
  }

  #getJson(url: string, key: string | null): Promise<unknown> {
    return getJson({
      url,
      headers: this.#headers(key, 'application/json'),
      fetch: this.#fetch,
      host: this.#host,
      timeoutMs: this.#opts.connectTimeoutMs ?? 10_000,
      mapError: (status, text) => mapHttpError(status, text, key !== null, (t) => scrub(t, key)),
      toError: (e) =>
        new NovaError(e.code, e.message, { retryable: e.retryable, action: e.action }),
    });
  }

  // ---- streaming ------------------------------------------------------------------------

  async *stream(req: ChatRequest, _ctx: CallContext): AsyncIterable<StreamEvent> {
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    let key: string | null;
    try {
      key = await resolveKey(this.#opts.apiKey);
    } catch {
      yield stopError('auth_missing', 'the credential for this provider could not be read', false);
      return;
    }
    const names = new ToolNames(req.tools?.map((t) => t.name) ?? []);
    const connected = await connectSse({
      url: `${this.baseUrl}/chat/completions`,
      body: JSON.stringify(this.#body(req, names)),
      headers: { ...this.#headers(key, 'text/event-stream'), 'content-type': 'application/json' },
      signal: req.signal,
      fetch: this.#fetch,
      host: this.#host,
      connectTimeoutMs: this.#opts.connectTimeoutMs ?? 10_000,
      maxRetries: this.#opts.maxRetries ?? 2,
      retryBaseMs: this.#opts.retryBaseMs ?? 500,
      maxRetryAfterMs: this.#opts.maxRetryAfterMs ?? 30_000,
      random: this.#opts.random ?? Math.random,
      mapError: (status, text) => mapHttpError(status, text, key !== null, (t) => scrub(t, key)),
    });
    if (!connected.ok) {
      yield connected.stop;
      return;
    }
    yield* this.#read(connected.res, connected.conn, req, names, key);
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
    // Reasoning levels (docs/07 §6): OpenAI takes `reasoning_effort`; OpenRouter passes its
    // `reasoning` object through to the upstream model. Local servers: not applicable.
    if (req.reasoning && this.kind === 'openai')
      body.reasoning_effort = openAIEffort(req.reasoning);
    if (req.reasoning && this.kind === 'openrouter')
      body.reasoning = openRouterReasoning(req.reasoning);
    return body;
  }

  async *#read(
    res: Response,
    conn: AbortController,
    req: ChatRequest,
    names: ToolNames,
    key: string | null,
  ): AsyncGenerator<StreamEvent> {
    const tools = new ToolCallAccumulator(names);
    const idleMs = this.#opts.idleTimeoutMs ?? 90_000;
    let finish: string | null = null;
    let done = false;
    let failure: AgentErrorShape | null = null;
    let started = false;

    for await (const item of readSseData(res, conn, req.signal, idleMs, this.#host)) {
      if ('failure' in item) {
        failure = item.failure;
        break;
      }
      if (item.data === '[DONE]') {
        done = true;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.data);
      } catch {
        failure = err('provider_error', `${this.#host} sent a malformed stream event`, false);
        break;
      }
      if (!isRecord(parsed)) continue;
      if (isRecord(parsed.error)) {
        failure = mapHttpError(0, JSON.stringify(parsed), key !== null, (t) => scrub(t, key));
        break;
      }
      if (!started) {
        started = true;
        yield {
          type: 'start',
          messageId: typeof parsed.id === 'string' ? parsed.id : uuidv7(),
          model: typeof parsed.model === 'string' ? parsed.model : req.model,
        };
      }
      const choice = Array.isArray(parsed.choices) ? (parsed.choices as unknown[])[0] : undefined;
      if (isRecord(choice)) {
        const delta = isRecord(choice.delta) ? choice.delta : {};
        // Local servers and OpenRouter put thinking in `reasoning` / `reasoning_content`; never content.
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
      if (req.signal.aborted) break;
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

// ---- reasoning (docs/07 §6) -------------------------------------------------------------

/** Nova level → OpenAI `reasoning_effort`: off → none; xhigh/max → high. */
export function openAIEffort(r: NonNullable<ChatRequest['reasoning']>): string {
  if ('budgetTokens' in r) return effortForBudget(r.budgetTokens);
  switch (r.level) {
    case 'off':
      return 'none';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    default:
      return 'high';
  }
}

/** Nova level → OpenRouter's normalized `reasoning` object, passed through to the model. */
export function openRouterReasoning(
  r: NonNullable<ChatRequest['reasoning']>,
): Record<string, unknown> {
  if ('budgetTokens' in r) return { max_tokens: r.budgetTokens };
  if (r.level === 'off') return { enabled: false };
  return { effort: openAIEffort(r) };
}

function effortForBudget(n: number): string {
  if (n <= 2_048) return 'low';
  if (n <= 8_192) return 'medium';
  return 'high';
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
      yield { type: 'tool_call_end', index, args: parseArgs(call.args) };
    }
  }
}

/** Parsed tool arguments; malformed JSON is left as the raw string for the runtime to reject. */
export function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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

// ---- model lists ------------------------------------------------------------------------

function ollamaTagIds(tags: unknown): string[] {
  const list = isRecord(tags) && Array.isArray(tags.models) ? tags.models : [];
  return list.flatMap((m) =>
    isRecord(m) && typeof (m.model ?? m.name) === 'string' ? [String(m.model ?? m.name)] : [],
  );
}

function toModels(ids: string[], kind: OpenAICompatibleKind): ModelInfo[] {
  return [...new Set(ids)].sort().map((id) => ({
    id,
    label: id,
    capabilities: kind === 'openai' ? openAIModelCaps(id) : {},
  }));
}

// OpenAI's /models reports ids only; capabilities follow its published model families.
const OPENAI_REASONING = /^(o\d|gpt-5)(?!.*-chat)/;
const OPENAI_VISION =
  /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4\.5|gpt-5|o1(?!-mini)|o3(?!-mini)|o4)/;

export function openAIModelCaps(id: string): Partial<ProviderCapabilities> {
  return {
    reasoning: OPENAI_REASONING.test(id) ? 'levels' : false,
    vision: OPENAI_VISION.test(id),
  };
}

/** OpenRouter reports modalities, supported parameters and per-token prices per model. */
function openRouterModels(data: unknown[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of data) {
    if (!isRecord(m) || typeof m.id !== 'string') continue;
    const arch = isRecord(m.architecture) ? m.architecture : {};
    const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const caps: Partial<ProviderCapabilities> = {
      vision: inputs.includes('image'),
      reasoning: params.includes('reasoning') ? 'levels' : false,
    };
    if (params.length) caps.tools = params.includes('tools');
    if (typeof m.context_length === 'number') caps.maxContextTokens = m.context_length;
    const info: ModelInfo = {
      id: m.id,
      label: typeof m.name === 'string' && m.name ? m.name : m.id,
      capabilities: caps,
    };
    const pricing = isRecord(m.pricing) ? m.pricing : {};
    const costIn = perMillion(pricing.prompt);
    const costOut = perMillion(pricing.completion);
    if (costIn !== undefined) info.costIn = costIn;
    if (costOut !== undefined) info.costOut = costOut;
    out.push(info);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** A per-token USD price string as USD per 1M tokens; negative means variable (unknown). */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
}

// ---- errors (docs/07 §14) ---------------------------------------------------------------

export const CONTEXT_TOO_LONG =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|reduce the length/i;

export function mapHttpError(
  status: number,
  bodyText: string,
  hadKey: boolean,
  clean: (text: string) => string = (t) => t,
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
  detail = clean(detail);
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
  if (
    (status === 429 || status === 402) &&
    /insufficient_quota|billing|credit/i.test(code + detail)
  ) {
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
  if (/context_length/i.test(code) || CONTEXT_TOO_LONG.test(detail)) {
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
