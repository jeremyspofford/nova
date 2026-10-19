// Opt-in OTLP export (FR-223; docs/16 §1; ADR-097 D6): traces, metrics and logs sent over
// OTLP/HTTP with JSON encoding (no protobuf dependency) to the collector the owner names. Off until
// configured. Everything passes the redactor at the export boundary, again, whatever the producer
// did; content attributes (prompts, completions, tool arguments and results, captured text) are
// removed unless `includeContent` is on. Each signal has a bounded queue (the oldest item is
// dropped and counted when it is full); a failed send backs off exponentially with jitter (or as
// the collector's Retry-After says) and never blocks or breaks the Hub. Redirects are refused, so
// data only ever reaches the configured endpoint.
import { defaultRedactor, type Redactor } from '@nova/security';
import { LEVELS, type Level, type LogRecord, type LogSink } from './logger.ts';
import type { MetricData } from './metrics.ts';
import type { AttributeValue, Attributes, SpanData, SpanKind } from './trace.ts';

export const OTLP_SIGNAL_NAMES = ['traces', 'metrics', 'logs'] as const;
export type OtlpSignalName = (typeof OTLP_SIGNAL_NAMES)[number];

export interface OtlpConfig {
  /** The collector's base URL; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended. */
  endpoint: string;
  /** Sent with every request (resolved from the vault by the caller); never logged. */
  headers?: Record<string, string>;
  signals: Record<OtlpSignalName, boolean>;
  includeContent: boolean;
  /** Resource attributes, e.g. `service.name`. */
  resource?: Attributes;
}

export interface OtlpExporterOptions {
  fetch?: typeof globalThis.fetch;
  redactor?: Redactor;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Items kept per signal (default 2,048). */
  maxQueue?: number;
  /** Items per request (default 512). */
  maxBatch?: number;
  /** How often queued items are sent (default 5 s; 0 turns the timer off, tests flush). */
  flushIntervalMs?: number;
  /** How often metrics are collected and queued (default 60 s; 0 off). */
  metricsIntervalMs?: number;
  /** One request's limit (default 10 s). */
  timeoutMs?: number;
  /** Retry delays: the first, doubling up to the cap (default 1 s up to 5 min). */
  backoff?: { initialMs?: number; maxMs?: number };
  /** For the jitter (0..1); the delay is scaled by 0.8..1.2. */
  random?: () => number;
  /** Where metrics come from when the metrics signal is on. */
  metrics?: () => MetricData[];
  scope?: { name: string; version?: string };
}

export interface OtlpStats {
  active: boolean;
  queued: Record<OtlpSignalName, number>;
  dropped: Record<OtlpSignalName, number>;
  sent: Record<OtlpSignalName, number>;
  /** Consecutive failed sends (0 after a success). */
  failures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
}

/** The OTLP JSON encoding of an AnyValue (proto3 JSON mapping: int64 as strings). */
export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } };
export interface KeyValue {
  key: string;
  value: AnyValue;
}

/**
 * Content attributes, removed unless `includeContent` is on: the `content.` and `nova.content.`
 * prefixes, the OpenTelemetry GenAI message attributes, and keys whose last segment names content
 * (`message` included: an error object goes out as its name only).
 */
const CONTENT_PREFIXES = ['content.', 'nova.content.'];
const CONTENT_GENAI =
  /^gen_ai\.(prompt|completion|input\.messages|output\.messages|system_instructions|tool\.call\.(arguments|result))(\.|$)/;
const CONTENT_WORDS = new Set([
  'prompt',
  'prompts',
  'completion',
  'content',
  'text',
  'body',
  'args',
  'arguments',
  'result',
  'results',
  'input',
  'output',
  'query',
  'messages',
  'transcript',
  'snippet',
  'preview',
  // Error and free-text messages often quote what the user wrote (M8 review).
  'message',
]);

export function isContentAttribute(key: string): boolean {
  if (CONTENT_PREFIXES.some((p) => key.startsWith(p))) return true;
  if (CONTENT_GENAI.test(key)) return true;
  const last = key.split('.').at(-1) ?? key;
  return CONTENT_WORDS.has(last.toLowerCase());
}

/** https, or http only to a loopback collector (docs/16 §1); no credentials, query or fragment. */
export function isAllowedOtlpEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const loopback = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/i.test(u.hostname);
    const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
    return scheme && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

const SEVERITY: Record<Level, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17 };
const SPAN_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};
const STATUS = { unset: 0, ok: 1, error: 2 } as const;
/** Collector answers worth retrying (OTLP/HTTP spec); anything else drops the batch. */
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_DEPTH = 4;
/** How long `close` may take in all. */
const CLOSE_TIMEOUT_MS = 5000;
const MAX_STRING = 32_768;

/** Unix nanoseconds as a decimal string, from epoch milliseconds. */
export function nanos(ms: number): string {
  const whole = Math.floor(ms);
  const frac = Math.round((ms - whole) * 1e6);
  return (BigInt(whole) * 1_000_000n + BigInt(frac)).toString();
}

type Item = Record<string, unknown>;

export class OtlpExporter {
  readonly #fetch: typeof globalThis.fetch;
  readonly #redactor: Redactor;
  readonly #now: () => number;
  readonly #maxQueue: number;
  readonly #maxBatch: number;
  readonly #timeoutMs: number;
  readonly #initialMs: number;
  readonly #maxMs: number;
  readonly #random: () => number;
  readonly #metricsSource: (() => MetricData[]) | null;
  readonly #scope: { name: string; version?: string };
  readonly #flushIntervalMs: number;
  readonly #metricsIntervalMs: number;
  #config: OtlpConfig | null = null;
  #queues: Record<OtlpSignalName, Item[]> = { traces: [], metrics: [], logs: [] };
  #dropped: Record<OtlpSignalName, number> = { traces: 0, metrics: 0, logs: 0 };
  #sent: Record<OtlpSignalName, number> = { traces: 0, metrics: 0, logs: 0 };
  #failures = 0;
  #lastError: string | null = null;
  #lastSuccessAt: number | null = null;
  #nextAttemptAt = 0;
  #sending: Promise<void> | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Aborted when `close` runs out of time: requests still running end at once. */
  readonly #closing = new AbortController();
  #metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: OtlpExporterOptions = {}) {
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#now = opts.now ?? (() => Date.now());
    this.#maxQueue = Math.max(1, opts.maxQueue ?? 2048);
    this.#maxBatch = Math.max(1, opts.maxBatch ?? 512);
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#initialMs = opts.backoff?.initialMs ?? 1000;
    this.#maxMs = opts.backoff?.maxMs ?? 300_000;
    this.#random = opts.random ?? Math.random;
    this.#metricsSource = opts.metrics ?? null;
    this.#scope = opts.scope ?? { name: 'nova' };
    this.#flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.#metricsIntervalMs = opts.metricsIntervalMs ?? 60_000;
  }

  /**
   * Start, change or stop the export (null stops it and drops what is queued). An endpoint that is
   * neither https nor a loopback http collector is refused: the export stays off.
   */
  configure(config: OtlpConfig | null): void {
    if (config && !isAllowedOtlpEndpoint(config.endpoint)) {
      this.#lastError = 'the endpoint must be https, or http to this machine';
      config = null;
    }
    const wasOn = this.#config !== null;
    this.#config = config && OTLP_SIGNAL_NAMES.some((s) => config.signals[s]) ? config : null;
    for (const s of OTLP_SIGNAL_NAMES) if (!this.signalOn(s)) this.#queues[s] = [];
    if (!this.#config) {
      this.#stopTimers();
      return;
    }
    if (!wasOn) {
      this.#failures = 0;
      this.#nextAttemptAt = 0;
      this.#lastError = null;
    }
    this.#startTimers();
  }

  get active(): boolean {
    return this.#config !== null;
  }

  signalOn(signal: OtlpSignalName): boolean {
    return this.#config?.signals[signal] === true;
  }

  /** Queue a finished span (when traces are exported). */
  span(s: SpanData): void {
    if (!this.signalOn('traces')) return;
    const item: Item = {
      traceId: s.traceId,
      spanId: s.spanId,
      name: this.#str(s.name),
      kind: SPAN_KIND[s.kind],
      startTimeUnixNano: nanos(s.startTimeMs),
      endTimeUnixNano: nanos(s.endTimeMs),
      attributes: this.#attributes(s.attributes),
      events: s.events.map((e) => ({
        timeUnixNano: nanos(e.timeMs),
        name: this.#str(e.name),
        attributes: this.#attributes(e.attributes),
      })),
      status: {
        code: STATUS[s.status.code],
        ...(s.status.message ? { message: this.#str(s.status.message) } : {}),
      },
    };
    if (s.parentSpanId) item.parentSpanId = s.parentSpanId;
    this.#push('traces', item);
  }

  /** Queue a log record (when logs are exported). */
  log(r: LogRecord): void {
    if (!this.signalOn('logs')) return;
    const { ts, level, module, msg, ...fields } = r;
    const t = Date.parse(ts);
    const time = Number.isFinite(t) ? t : this.#now();
    this.#push('logs', {
      timeUnixNano: nanos(time),
      observedTimeUnixNano: nanos(this.#now()),
      severityNumber: SEVERITY[(LEVELS as readonly string[]).includes(level) ? level : 'info'],
      severityText: level.toUpperCase(),
      body: { stringValue: this.#str(msg) },
      attributes: [
        { key: 'nova.module', value: { stringValue: this.#str(module) } },
        ...this.#attributes(fields as Attributes),
      ],
    });
  }

  /** Queue metric snapshots (when metrics are exported). */
  metrics(data: readonly MetricData[]): void {
    if (!this.signalOn('metrics')) return;
    for (const m of data) this.#push('metrics', this.#metric(m));
  }

  /** Collect from the metrics source now and queue it. */
  collectMetrics(): void {
    if (!this.signalOn('metrics') || !this.#metricsSource) return;
    try {
      this.metrics(this.#metricsSource());
    } catch {
      // a failing source skips this round
    }
  }

  /**
   * Send what is queued, one request per signal and batch, unless a failure's backoff is still
   * running (`force` ignores it). Never throws.
   */
  async flush(opts: { force?: boolean } = {}): Promise<void> {
    if (this.#sending) return this.#sending;
    this.#sending = this.#drain(opts.force === true).finally(() => {
      this.#sending = null;
    });
    return this.#sending;
  }

  /** Send one log record now, outside the queue (the settings page's test button). */
  async sendTest(
    config: OtlpConfig,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    if (!isAllowedOtlpEndpoint(config.endpoint))
      return {
        ok: false,
        status: null,
        error: 'the endpoint must be https, or http to this machine',
      };
    const now = this.#now();
    const body = this.#envelope('logs', config, [
      {
        timeUnixNano: nanos(now),
        observedTimeUnixNano: nanos(now),
        severityNumber: SEVERITY.info,
        severityText: 'INFO',
        body: { stringValue: 'Nova OTLP export test' },
        attributes: [{ key: 'nova.module', value: { stringValue: 'hub.otlp' } }],
      },
    ]);
    const res = await this.#post(config, 'logs', body);
    return { ok: res.ok, status: res.status, error: res.ok ? null : res.error };
  }

  stats(): OtlpStats {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      active: this.active,
      queued: {
        traces: this.#queues.traces.length,
        metrics: this.#queues.metrics.length,
        logs: this.#queues.logs.length,
      },
      dropped: { ...this.#dropped },
      sent: { ...this.#sent },
      failures: this.#failures,
      lastError: this.#lastError,
      lastSuccessAt: iso(this.#lastSuccessAt),
      nextAttemptAt: this.#nextAttemptAt > this.#now() ? iso(this.#nextAttemptAt) : null,
    };
  }

  /** Stop the timers after one last attempt to send (bounded by the request timeout). */
  /**
   * Stop the timers after one last attempt to send, bounded as a whole (default 5 s): requests
   * still running then are cancelled, and what is left is dropped. Never blocks a shutdown longer.
   */
  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.#stopTimers();
    if (!this.#config) return;
    this.collectMetrics();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.flush({ force: true }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.#closing.abort();
          resolve();
        }, opts.timeoutMs ?? CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  // ---- internals -------------------------------------------------------------------------

  #startTimers(): void {
    if (!this.#flushTimer && this.#flushIntervalMs > 0) {
      this.#flushTimer = setInterval(() => void this.flush(), this.#flushIntervalMs);
      this.#flushTimer.unref();
    }
    if (!this.#metricsTimer && this.#metricsIntervalMs > 0 && this.#metricsSource) {
      this.#metricsTimer = setInterval(() => this.collectMetrics(), this.#metricsIntervalMs);
      this.#metricsTimer.unref();
    }
  }

  #stopTimers(): void {
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#metricsTimer) clearInterval(this.#metricsTimer);
    this.#flushTimer = null;
    this.#metricsTimer = null;
  }

  #push(signal: OtlpSignalName, item: Item): void {
    const q = this.#queues[signal];
    q.push(item);
    while (q.length > this.#maxQueue) {
      q.shift();
      this.#dropped[signal] += 1;
    }
  }

  async #drain(force: boolean): Promise<void> {
    for (const signal of OTLP_SIGNAL_NAMES) {
      while (this.#config && this.#queues[signal].length) {
        if (!force && this.#now() < this.#nextAttemptAt) return;
        const config = this.#config;
        const batch = this.#queues[signal].splice(0, this.#maxBatch);
        const res = await this.#post(config, signal, this.#envelope(signal, config, batch));
        // The export was turned off or changed while sending: what was taken is gone.
        if (this.#config !== config) {
          if (!res.ok) this.#dropped[signal] += batch.length;
          return;
        }
        if (res.ok) {
          this.#sent[signal] += batch.length - res.rejected;
          this.#dropped[signal] += res.rejected;
          this.#failures = 0;
          this.#nextAttemptAt = 0;
          this.#lastSuccessAt = this.#now();
          if (res.rejected) this.#lastError = `the collector rejected ${res.rejected} ${signal}`;
          continue;
        }
        this.#lastError = res.error;
        if (!res.retry) {
          this.#dropped[signal] += batch.length;
          continue;
        }
        // Retry later: the batch goes back in front, still within the bound.
        this.#queues[signal].unshift(...batch);
        while (this.#queues[signal].length > this.#maxQueue) {
          this.#queues[signal].shift();
          this.#dropped[signal] += 1;
        }
        this.#failures += 1;
        const base = Math.min(this.#maxMs, this.#initialMs * 2 ** (this.#failures - 1));
        const jittered = Math.round(base * (0.8 + 0.4 * this.#random()));
        this.#nextAttemptAt = this.#now() + Math.min(this.#maxMs, res.retryAfterMs ?? jittered);
        return;
      }
    }
  }

  async #post(
    config: OtlpConfig,
    signal: OtlpSignalName,
    body: unknown,
  ): Promise<
    | { ok: true; status: number; rejected: number }
    | {
        ok: false;
        status: number | null;
        retry: boolean;
        retryAfterMs: number | null;
        error: string;
      }
  > {
    const url = `${config.endpoint.replace(/\/+$/, '')}/v1/${signal}`;
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { ...(config.headers ?? {}), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), this.#closing.signal]),
      });
      const text = await res.text().catch(() => '');
      if (res.ok) return { ok: true, status: res.status, rejected: rejectedCount(text) };
      const after = retryAfter(res.headers.get('retry-after'), this.#now());
      return {
        ok: false,
        status: res.status,
        retry: RETRYABLE.has(res.status),
        retryAfterMs: after,
        error: `the collector answered ${res.status}`,
      };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return {
        ok: false,
        status: null,
        retry: true,
        retryAfterMs: null,
        error:
          name === 'TimeoutError' || name === 'AbortError'
            ? 'the collector did not answer in time'
            : 'the collector could not be reached',
      };
    }
  }

  #envelope(signal: OtlpSignalName, config: OtlpConfig, items: Item[]): unknown {
    const resource = { attributes: this.#attributes(config.resource ?? {}, true) };
    const scope = {
      name: this.#scope.name,
      ...(this.#scope.version ? { version: this.#scope.version } : {}),
    };
    if (signal === 'traces')
      return { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: items }] }] };
    if (signal === 'metrics')
      return { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: items }] }] };
    return { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: items }] }] };
  }

  #metric(m: MetricData): Item {
    const base = { name: m.name, description: m.description, unit: m.unit };
    const times = { startTimeUnixNano: nanos(m.startTimeMs), timeUnixNano: nanos(m.timeMs) };
    if (m.kind === 'histogram')
      return {
        ...base,
        histogram: {
          aggregationTemporality: 2,
          dataPoints: m.points.map((p) => ({
            attributes: this.#attributes(p.attributes),
            ...times,
            count: String(p.count),
            sum: p.sum,
            min: p.min,
            max: p.max,
            bucketCounts: p.bucketCounts.map(String),
            explicitBounds: m.boundaries,
          })),
        },
      };
    const dataPoints = m.points.map((p) => ({
      attributes: this.#attributes(p.attributes),
      ...times,
      ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
    }));
    return m.kind === 'sum'
      ? { ...base, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints } }
      : { ...base, gauge: { dataPoints } };
  }

  /**
   * Attributes as OTLP key-values: content removed unless allowed, secrets redacted, empty values
   * left out. Resource attributes are the Hub's own (never content).
   */
  #attributes(attrs: Attributes, resource = false): KeyValue[] {
    const allowContent = this.#config?.includeContent === true;
    const red = this.#redactor.redact(attrs);
    const out: KeyValue[] = [];
    for (const [key, value] of Object.entries(red)) {
      if (value === null || value === undefined) continue;
      if (!resource && !allowContent && isContentAttribute(key)) continue;
      const v = this.#any(value, 0, allowContent);
      if (v) out.push({ key, value: v });
    }
    return out;
  }

  #any(value: unknown, depth: number, allowContent: boolean): AnyValue | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return { stringValue: this.#str(value) };
    if (typeof value === 'boolean') return { boolValue: value };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { stringValue: String(value) };
      return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === 'bigint') return { intValue: value.toString() };
    if (depth >= MAX_DEPTH) return { stringValue: '[nested too deep]' };
    if (Array.isArray(value))
      return {
        arrayValue: {
          values: value
            .map((v) => this.#any(v, depth + 1, allowContent))
            .filter((v): v is AnyValue => v !== null),
        },
      };
    if (typeof value === 'object') {
      const values: KeyValue[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!allowContent && isContentAttribute(k)) continue;
        const a = this.#any(v, depth + 1, allowContent);
        if (a) values.push({ key: k, value: a });
      }
      return { kvlistValue: { values } };
    }
    return null;
  }

  #str(s: string): string {
    const r = this.#redactor.redactString(s);
    return r.length > MAX_STRING ? `${r.slice(0, MAX_STRING)}[truncated]` : r;
  }
}

/** A log sink that queues records for OTLP export, except those `skip` names (the exporter's own). */
export class OtlpLogSink implements LogSink {
  readonly #exporter: OtlpExporter;
  readonly #skip: (r: LogRecord) => boolean;
  constructor(exporter: OtlpExporter, skip: (r: LogRecord) => boolean = () => false) {
    this.#exporter = exporter;
    this.#skip = skip;
  }
  write(record: LogRecord): void {
    if (!this.#skip(record)) this.#exporter.log(record);
  }
}

/** Items a collector's partial success rejected (`rejectedSpans`, `...DataPoints`, `...LogRecords`). */
function rejectedCount(text: string): number {
  if (!text) return 0;
  try {
    const v = JSON.parse(text) as { partialSuccess?: Record<string, unknown> };
    const p = v.partialSuccess;
    if (!p) return 0;
    for (const k of ['rejectedSpans', 'rejectedDataPoints', 'rejectedLogRecords']) {
      const n = Number(p[k] ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Retry-After as seconds or an HTTP date, in milliseconds from now; null when absent or bad. */
function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export type { AttributeValue };
