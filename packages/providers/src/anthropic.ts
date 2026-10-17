// Anthropic Messages API adapter (docs/07 §3, §5, §6, §7, §9, §14): SSE over plain `fetch`, no
// vendor SDK. The system prompt is split out, content maps to text / image / tool_use /
// tool_result blocks, and reasoning levels map to the model's thinking controls. `stream()`
// never throws: every outcome ends with a `stop` event.
import { NovaError, uuidv7 } from '@nova/shared';
import { DEFAULT_BASE_URLS } from './defaults.ts';
import { CONTEXT_TOO_LONG, parseArgs } from './openai-compatible.ts';
import type {
  AgentErrorShape,
  CallContext,
  ChatRequest,
  ContentPart,
  ModelInfo,
  NormalizedMessage,
  Provider,
  ProviderCapabilities,
  ReasoningLevel,
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

export const ANTHROPIC_VERSION = '2023-06-01';
/** Beta flag that unlocks the faster output tier on the models that have one. */
export const ANTHROPIC_FAST_BETA = 'fast-mode-2026-02-01';

export interface AnthropicOptions {
  id: string;
  /** Defaults to the official endpoint; `/v1` is appended when missing. */
  baseUrl?: string;
  apiKey?: string | (() => Promise<string | null>);
  capabilities?: Partial<ProviderCapabilities>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Retries before the first byte only (default 2; the Hub's router retries instead, so 0). */
  maxRetries?: number;
  retryBaseMs?: number;
  maxRetryAfterMs?: number;
  /** Output allowance when the request sets none (the API requires `max_tokens`). */
  defaultMaxTokens?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  random?: () => number;
}

const CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  vision: true,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: 'budget',
  promptCache: 'both',
  structuredOutput: true,
  imageGeneration: false,
  maxContextTokens: 200_000,
  maxOutputTokens: 64_000,
};

// ---- model traits -----------------------------------------------------------------------

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** How a model takes thinking, effort and sampling controls. */
export interface AnthropicTraits {
  /** `adaptive` (effort-controlled), `budget` (budget_tokens), or no thinking at all. */
  thinking: 'adaptive' | 'budget' | 'none';
  /** Leaving `thinking` out still runs adaptive thinking (it cannot be fully turned off). */
  alwaysThinks: boolean;
  efforts: readonly Effort[];
  /** temperature / top_p are accepted. */
  sampling: boolean;
  /** tool_choice `any` / `tool` are accepted. */
  forcedTools: boolean;
  /** Has a fast output tier (`speed: "fast"`). */
  fast: boolean;
  maxOutput: number;
  vision: boolean;
}

interface ClaudeId {
  family: string;
  /** major * 100 + minor, so 4.6 → 406 and 5 → 500. */
  version: number;
}

/** `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-3-7-sonnet-…`. */
export function parseClaudeId(id: string): ClaudeId | null {
  // A one- or two-digit minor; an eight-digit date suffix is not a version.
  const modern = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=-|$|@)/.exec(id);
  if (modern)
    return { family: modern[1]!, version: Number(modern[2]) * 100 + Number(modern[3] ?? 0) };
  const legacy = /claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)/.exec(id);
  if (legacy)
    return { family: legacy[3]!, version: Number(legacy[1]) * 100 + Number(legacy[2] ?? 0) };
  return null;
}

/**
 * Traits from the model id, following Anthropic's published model generations: 4.6 and later
 * use adaptive thinking with effort levels (budget_tokens is rejected from 4.7 on, and from 5
 * on thinking cannot be fully turned off); 3.7 to 4.5 take budget_tokens; older models have no
 * thinking. Capabilities reported by the models endpoint override these (`traitsFromReported`).
 */
export function anthropicTraits(id: string): AnthropicTraits {
  const c = parseClaudeId(id);
  const base: AnthropicTraits = {
    thinking: 'none',
    alwaysThinks: false,
    efforts: [],
    sampling: true,
    forcedTools: true,
    fast: false,
    maxOutput: 8_192,
    vision: true,
  };
  if (!c) return base;
  const { family, version: v } = c;
  const flagship = family === 'fable' || family === 'mythos';
  const adaptive = flagship || (family === 'haiku' ? v >= 500 : v >= 406);
  if (adaptive) {
    return {
      thinking: 'adaptive',
      alwaysThinks: flagship || v >= 500,
      efforts: flagship || v >= 407 ? EFFORTS : ['low', 'medium', 'high', 'max'],
      sampling: !flagship && v === 406,
      forcedTools: flagship ? v < 501 : family === 'haiku' || v < 505,
      fast: family === 'opus' && v >= 408,
      maxOutput: 128_000,
      vision: true,
    };
  }
  if (v >= 307)
    return { ...base, thinking: 'budget', maxOutput: family === 'opus' ? 32_000 : 64_000 };
  if (v >= 305) return base;
  return { ...base, maxOutput: 4_096 };
}

/** Override id-based traits with what the models endpoint reports for the model. */
export function traitsFromReported(
  t: AnthropicTraits,
  m: Record<string, unknown>,
): AnthropicTraits {
  const out = { ...t };
  const caps = isRecord(m.capabilities) ? m.capabilities : null;
  const yes = (v: unknown) => isRecord(v) && v.supported === true;
  if (caps) {
    if (isRecord(caps.image_input)) out.vision = yes(caps.image_input);
    const th = isRecord(caps.thinking) ? caps.thinking : null;
    if (th) {
      const types = isRecord(th.types) ? th.types : {};
      if (th.supported === false) out.thinking = 'none';
      else if (yes(types.adaptive)) out.thinking = 'adaptive';
      else if (yes(types.enabled)) out.thinking = 'budget';
    }
    const ef = isRecord(caps.effort) ? caps.effort : null;
    if (ef) out.efforts = ef.supported === false ? [] : EFFORTS.filter((e) => yes(ef[e]));
  }
  if (typeof m.max_tokens === 'number' && m.max_tokens > 0) out.maxOutput = m.max_tokens;
  return out;
}

// Thinking budgets per level for budget-style models (docs/07 §6: scaled; xhigh/max = max).
const BUDGET: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_000,
  max: 32_000,
};

/** The highest supported effort at or below the wanted one (the lowest supported if none). */
function pickEffort(want: Effort, have: readonly Effort[]): Effort | undefined {
  const i = EFFORTS.indexOf(want);
  for (let j = i; j >= 0; j--) if (have.includes(EFFORTS[j]!)) return EFFORTS[j];
  return have[0];
}

function effortFor(r: NonNullable<ChatRequest['reasoning']>): Effort {
  if ('budgetTokens' in r) {
    if (r.budgetTokens <= 2_048) return 'low';
    if (r.budgetTokens <= 8_192) return 'medium';
    if (r.budgetTokens <= 16_384) return 'high';
    return 'max';
  }
  switch (r.level) {
    case 'off':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
  }
}

// ---- adapter ----------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderCapabilities;
  readonly #opts: AnthropicOptions;
  readonly #fetch: typeof fetch;
  /** Traits learned from the models endpoint, by model id. */
  readonly #reported = new Map<string, AnthropicTraits>();

  constructor(opts: AnthropicOptions) {
    this.id = opts.id;
    this.baseUrl = normalizeBase(opts.baseUrl ?? DEFAULT_BASE_URLS.anthropic, true);
    this.capabilities = { ...CAPS, ...opts.capabilities };
    this.#opts = opts;
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  get #host(): string {
    return new URL(this.baseUrl).host;
  }

  #headers(key: string | null, accept: string, beta?: string): Record<string, string> {
    const h: Record<string, string> = {
      accept,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.#opts.headers,
    };
    if (key) h['x-api-key'] = key;
    if (beta) h['anthropic-beta'] = beta;
    return h;
  }

  /** Traits for a model: what the models endpoint reported, else the id-based rules. */
  traits(model: string): AnthropicTraits {
    return this.#reported.get(model) ?? anthropicTraits(model);
  }

  // ---- models ---------------------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    const key = await resolveKey(this.#opts.apiKey);
    const out: ModelInfo[] = [];
    let after: string | null = null;
    // The list is paginated; ten pages of 1000 is far beyond any real catalog.
    for (let page = 0; page < 10; page++) {
      const q = after ? `?limit=1000&after_id=${encodeURIComponent(after)}` : '?limit=1000';
      const body = await getJson({
        url: `${this.baseUrl}/models${q}`,
        headers: this.#headers(key, 'application/json'),
        fetch: this.#fetch,
        host: this.#host,
        timeoutMs: this.#opts.connectTimeoutMs ?? 10_000,
        mapError: (status, text) => mapAnthropicError(status, text, (t) => scrub(t, key)),
        toError: (e) =>
          new NovaError(e.code, e.message, { retryable: e.retryable, action: e.action }),
      });
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      for (const m of data) {
        if (!isRecord(m) || typeof m.id !== 'string') continue;
        const t = traitsFromReported(anthropicTraits(m.id), m);
        this.#reported.set(m.id, t);
        const caps: Partial<ProviderCapabilities> = {
          vision: t.vision,
          reasoning:
            t.thinking === 'none' ? false : t.thinking === 'adaptive' ? 'levels' : 'budget',
          maxOutputTokens: t.maxOutput,
          fastTier: t.fast,
        };
        if (typeof m.max_input_tokens === 'number') caps.maxContextTokens = m.max_input_tokens;
        out.push({
          id: m.id,
          label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id,
          capabilities: caps,
        });
      }
      const last = isRecord(body) && typeof body.last_id === 'string' ? body.last_id : null;
      if (!(isRecord(body) && body.has_more === true && last)) break;
      after = last;
    }
    return out;
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
    const traits = this.traits(req.model);
    const { body, beta } = buildBody(req, names, traits, this.#opts.defaultMaxTokens ?? 32_000);
    const connected = await connectSse({
      url: `${this.baseUrl}/messages`,
      body: JSON.stringify(body),
      headers: {
        ...this.#headers(key, 'text/event-stream', beta),
        'content-type': 'application/json',
      },
      signal: req.signal,
      fetch: this.#fetch,
      host: this.#host,
      connectTimeoutMs: this.#opts.connectTimeoutMs ?? 10_000,
      maxRetries: this.#opts.maxRetries ?? 2,
      retryBaseMs: this.#opts.retryBaseMs ?? 500,
      maxRetryAfterMs: this.#opts.maxRetryAfterMs ?? 30_000,
      random: this.#opts.random ?? Math.random,
      mapError: (status, text) => mapAnthropicError(status, text, (t) => scrub(t, key)),
    });
    if (!connected.ok) {
      yield connected.stop;
      return;
    }
    yield* this.#read(connected.res, connected.conn, req, names, key);
  }

  async *#read(
    res: Response,
    conn: AbortController,
    req: ChatRequest,
    names: ToolNames,
    key: string | null,
  ): AsyncGenerator<StreamEvent> {
    const idleMs = this.#opts.idleTimeoutMs ?? 90_000;
    // Content block index → tool-call index (tool calls are numbered 0, 1, … across blocks).
    const tools = new Map<number, { index: number; json: string }>();
    let toolCount = 0;
    let started = false;
    let stopReason: string | null = null;
    let finished = false;
    let failure: AgentErrorShape | null = null;
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, seen: false, sent: false };
    const usageEvent = (): StreamEvent => {
      usage.sent = true;
      const ev: Extract<StreamEvent, { type: 'usage' }> = {
        type: 'usage',
        // Nova counts every prompt token as input; cached reads are the subset served from cache.
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
      };
      if (usage.cacheRead) ev.cachedTokens = usage.cacheRead;
      return ev;
    };

    for await (const item of readSseData(res, conn, req.signal, idleMs, this.#host)) {
      if ('failure' in item) {
        failure = item.failure;
        break;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(item.data);
      } catch {
        failure = err('provider_error', `${this.#host} sent a malformed stream event`, false);
        break;
      }
      if (!isRecord(ev)) continue;
      switch (ev.type) {
        case 'message_start': {
          const m = isRecord(ev.message) ? ev.message : {};
          readUsage(m.usage, usage);
          if (!started) {
            started = true;
            yield {
              type: 'start',
              messageId: typeof m.id === 'string' ? m.id : uuidv7(),
              model: typeof m.model === 'string' ? m.model : req.model,
            };
          }
          break;
        }
        case 'content_block_start': {
          const b = isRecord(ev.content_block) ? ev.content_block : {};
          const at = typeof ev.index === 'number' ? ev.index : -1;
          if (b.type === 'tool_use') {
            const index = toolCount++;
            tools.set(at, { index, json: '' });
            yield {
              type: 'tool_call_start',
              index,
              id: typeof b.id === 'string' && b.id ? b.id : `call_${index}`,
              name: names.original(typeof b.name === 'string' ? b.name : 'unknown'),
            };
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            yield { type: 'text_delta', text: b.text };
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
            yield { type: 'reasoning_delta', text: b.thinking };
          }
          break;
        }
        case 'content_block_delta': {
          const d = isRecord(ev.delta) ? ev.delta : {};
          const at = typeof ev.index === 'number' ? ev.index : -1;
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text)
            yield { type: 'text_delta', text: d.text };
          else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking)
            yield { type: 'reasoning_delta', text: d.thinking };
          else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const t = tools.get(at);
            if (t && d.partial_json) {
              t.json += d.partial_json;
              yield { type: 'tool_call_delta', index: t.index, argsDelta: d.partial_json };
            }
          } else if (d.type === 'citations_delta' && isRecord(d.citation)) {
            const c = toCitation(d.citation);
            if (c) yield c;
          }
          break;
        }
        case 'content_block_stop': {
          const at = typeof ev.index === 'number' ? ev.index : -1;
          const t = tools.get(at);
          if (t) {
            tools.delete(at);
            yield { type: 'tool_call_end', index: t.index, args: parseArgs(t.json) };
          }
          break;
        }
        case 'message_delta': {
          const d = isRecord(ev.delta) ? ev.delta : {};
          if (typeof d.stop_reason === 'string') stopReason = d.stop_reason;
          readUsage(ev.usage, usage);
          break;
        }
        case 'message_stop':
          finished = true;
          break;
        case 'error':
          failure = mapAnthropicError(0, JSON.stringify(ev), (t) => scrub(t, key));
          break;
        default:
          // ping and future event types
          break;
      }
      if (finished || failure || req.signal.aborted) break;
    }

    if (usage.seen && !usage.sent) yield usageEvent();
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    if (failure) {
      yield { type: 'stop', reason: 'error', error: failure };
      return;
    }
    if (!finished && stopReason === null) {
      yield stopError(
        'network',
        `the connection to ${this.#host} closed before the response finished`,
        true,
      );
      return;
    }
    // Close tool calls left open by a stream that ended without content_block_stop.
    for (const t of [...tools.values()].sort((a, b) => a.index - b.index))
      yield { type: 'tool_call_end', index: t.index, args: parseArgs(t.json) };
    if (stopReason === 'refusal') {
      yield stopError('content_filter', 'the model declined to answer this request', false);
      return;
    }
    yield { type: 'stop', reason: toStop(stopReason) };
  }
}

function readUsage(
  u: unknown,
  into: { input: number; cacheRead: number; cacheWrite: number; output: number; seen: boolean },
): void {
  if (!isRecord(u)) return;
  into.seen = true;
  if (typeof u.input_tokens === 'number') into.input = u.input_tokens;
  if (typeof u.cache_read_input_tokens === 'number') into.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number')
    into.cacheWrite = u.cache_creation_input_tokens;
  // output_tokens is cumulative in every event that carries it.
  if (typeof u.output_tokens === 'number') into.output = u.output_tokens;
}

function toCitation(c: Record<string, unknown>): StreamEvent | null {
  if (typeof c.url !== 'string') return null;
  const ev: Extract<StreamEvent, { type: 'citation' }> = { type: 'citation', url: c.url };
  if (typeof c.title === 'string') ev.title = c.title;
  if (typeof c.cited_text === 'string') ev.snippet = c.cited_text;
  return ev;
}

function toStop(reason: string | null): StopReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'end';
  }
}

// ---- request body -----------------------------------------------------------------------

type Block = Record<string, unknown>;

/** The Messages API body for a request, plus the beta header it needs (if any). */
export function buildBody(
  req: ChatRequest,
  names: ToolNames,
  traits: AnthropicTraits,
  defaultMaxTokens: number,
): { body: Record<string, unknown>; beta?: string } {
  const { system, messages } = toAnthropicMessages(req.messages, names);
  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  if (system.length) {
    const text = system.join('\n\n');
    body.system = req.cacheHints?.system
      ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      : text;
  }
  if (req.cacheHints?.history) {
    const tail = messages.at(-1)?.content.at(-1);
    if (tail) tail.cache_control = { type: 'ephemeral' };
  }

  // Thinking and effort (docs/07 §6).
  const output: Record<string, unknown> = {};
  let thinkingOn = false;
  let budget = 0;
  const r = req.reasoning;
  if (r && traits.thinking === 'adaptive') {
    const off = 'level' in r && r.level === 'off';
    if (!off) {
      thinkingOn = true;
      body.thinking = { type: 'adaptive', display: 'summarized' };
    }
    // Where thinking cannot be turned off, "off" becomes the lowest effort.
    if (!off || traits.alwaysThinks) {
      const e = pickEffort(effortFor(r), traits.efforts);
      if (e) output.effort = e;
    }
  } else if (r && traits.thinking === 'budget') {
    if ('budgetTokens' in r) budget = Math.max(1_024, r.budgetTokens);
    else if (r.level !== 'off') budget = BUDGET[r.level];
    if (budget) thinkingOn = true;
  }
  const allowance = req.maxTokens ?? Math.min(defaultMaxTokens, traits.maxOutput);
  let maxTokens = Math.min(traits.maxOutput, allowance + budget);
  if (budget) {
    // budget_tokens must stay below max_tokens; keep room for the answer itself.
    if (maxTokens < 2_048) maxTokens = Math.min(traits.maxOutput, 2_048);
    budget = Math.max(1_024, Math.min(budget, maxTokens - 1_024));
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  body.max_tokens = maxTokens;

  // Sampling is rejected with thinking on, and by the newest models at all.
  const thinks = thinkingOn || traits.alwaysThinks;
  if (traits.sampling && !thinks) {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
  }

  if (req.tools?.length) {
    const tools: Block[] = req.tools.map((t) => ({
      name: names.wire(t.name),
      description: t.description,
      input_schema: t.inputSchema,
    }));
    if (req.cacheHints?.tools) tools.at(-1)!.cache_control = { type: 'ephemeral' };
    body.tools = tools;
    if (req.toolChoice) body.tool_choice = toolChoice(req.toolChoice, names, traits, thinks);
  }
  if (req.responseFormat?.type === 'json_schema')
    output.format = { type: 'json_schema', schema: req.responseFormat.schema };
  if (Object.keys(output).length) body.output_config = output;

  if (req.speed === 'fast' && traits.fast) {
    body.speed = 'fast';
    return { body, beta: ANTHROPIC_FAST_BETA };
  }
  return { body };
}

function toolChoice(
  c: NonNullable<ChatRequest['toolChoice']>,
  names: ToolNames,
  traits: AnthropicTraits,
  thinks: boolean,
): Block {
  if (c === 'none') return { type: 'none' };
  // Forcing a tool is refused with thinking on and by the newest models: ask, do not force.
  if (c === 'auto' || !traits.forcedTools || thinks) return { type: 'auto' };
  if (c === 'required') return { type: 'any' };
  return { type: 'tool', name: names.wire(c.name) };
}

/** Split out the system prompt and map messages to content blocks, merging same-role runs. */
export function toAnthropicMessages(
  messages: NormalizedMessage[],
  names: ToolNames,
): { system: string[]; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      if (text) system.push(text);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content.flatMap((p) => toBlock(p, role, names));
    if (!content.length) continue;
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  return { system, messages: out };
}

function toBlock(p: ContentPart, role: 'user' | 'assistant', names: ToolNames): Block[] {
  switch (p.type) {
    case 'text':
      // Empty text blocks are rejected by the API.
      return p.text ? [{ type: 'text', text: p.text }] : [];
    case 'image':
      return [{ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }];
    case 'tool_call':
      if (role !== 'assistant') return [];
      return [
        {
          type: 'tool_use',
          id: p.id,
          name: names.wire(p.name),
          input: isRecord(p.args) ? p.args : {},
        },
      ];
    case 'tool_result': {
      const content = p.content.flatMap((c) => toBlock(c, 'user', names));
      const block: Block = { type: 'tool_result', tool_use_id: p.callId, content };
      if (p.isError) block.is_error = true;
      return [block];
    }
  }
}

// ---- errors (docs/07 §14) ---------------------------------------------------------------

/** Map an HTTP error (or, with status 0, an in-stream `error` event) to the normalized shape. */
export function mapAnthropicError(
  status: number,
  bodyText: string,
  clean: (text: string) => string = (t) => t,
): AgentErrorShape {
  let type = '';
  let detail = bodyText.trim();
  try {
    // `{type: "error", error: {type, message}}`
    const body: unknown = JSON.parse(bodyText);
    const e = isRecord(body) ? body.error : undefined;
    if (isRecord(e)) {
      type = typeof e.type === 'string' ? e.type : '';
      detail = typeof e.message === 'string' ? e.message : '';
    }
  } catch {
    // not JSON: keep the text
  }
  detail = clean(detail);
  const suffix = detail ? `: ${detail}` : '';
  const is = (t: string, s: number) => type === t || status === s;
  if (is('authentication_error', 401))
    return err('auth_missing', `the API key was not accepted${suffix}`, false, 'Check the API key');
  if (is('permission_error', 403))
    return err(
      'auth_missing',
      `this API key may not use this model or feature${suffix}`,
      false,
      'Check account access',
    );
  if (is('billing_error', 402))
    return err(
      'over_budget',
      `the provider account has a billing problem${suffix}`,
      false,
      'Check billing',
    );
  if (is('rate_limit_error', 429))
    return err(
      'rate_limited',
      `rate limited by the provider${suffix}`,
      true,
      'Wait or switch model',
    );
  if (is('overloaded_error', 529))
    return err('provider_error', `the provider is overloaded${suffix}`, true, 'Try again shortly');
  if (is('timeout_error', 504) || status === 408)
    return err('timeout', `the provider timed out${suffix}`, true);
  if (type === 'api_error' || status >= 500)
    return err(
      'provider_error',
      `the provider failed${status ? ` (${status})` : ''}${suffix}`,
      true,
    );
  if (CONTEXT_TOO_LONG.test(detail))
    return err(
      'context_length',
      `the conversation is too long for this model${suffix}`,
      false,
      'Reduce context',
    );
  if (is('not_found_error', 404))
    return err('invalid_request', `model or endpoint not found${suffix}`, false, 'Switch model');
  if (is('request_too_large', 413))
    return err('invalid_request', `the request is too large${suffix}`, false, 'Remove attachments');
  if (type === 'invalid_request_error' || status >= 400)
    return err(
      'invalid_request',
      `the provider refused the request${status ? ` (${status})` : ''}${suffix}`,
      false,
    );
  return err('provider_error', `the provider reported an error${suffix}`, false);
}
