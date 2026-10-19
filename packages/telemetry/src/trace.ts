// Spans in the OpenTelemetry shape (docs/16 §1, FR-223). A span goes to the processors listening
// when it ends (the OTLP exporter when traces are exported); with none, starting a span is cheap
// and nothing is kept. Nothing leaves the Hub unless the owner turns OTLP export on.
import { randomBytes } from 'node:crypto';

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
/** Attributes as given; null and undefined values are left out when exported. */
export type Attributes = Record<string, AttributeValue | null | undefined>;

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatusCode = 'unset' | 'ok' | 'error';

export interface SpanContext {
  /** 32 lower-case hex characters. */
  traceId: string;
  /** 16 lower-case hex characters. */
  spanId: string;
}

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

/** A finished span. Times are Unix epoch milliseconds (fractions allowed). */
export interface SpanData extends SpanContext {
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  status: { code: SpanStatusCode; message?: string };
}

export type SpanProcessor = (span: SpanData) => void;

export interface TracerOptions {
  /** Epoch milliseconds; defaults to a high-resolution clock. */
  now?: () => number;
}

/** At most this many events per span; later ones are dropped. */
const MAX_EVENTS = 128;

const hrNow = () => performance.timeOrigin + performance.now();

export class Span {
  readonly #tracer: Tracer;
  readonly #data: SpanData;
  #ended = false;

  constructor(tracer: Tracer, data: SpanData) {
    this.#tracer = tracer;
    this.#data = data;
  }

  get context(): SpanContext {
    return { traceId: this.#data.traceId, spanId: this.#data.spanId };
  }

  get ended(): boolean {
    return this.#ended;
  }

  setAttribute(key: string, value: AttributeValue | null | undefined): this {
    if (!this.#ended) this.#data.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    if (!this.#ended) Object.assign(this.#data.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes: Attributes = {}): this {
    if (!this.#ended && this.#data.events.length < MAX_EVENTS)
      this.#data.events.push({ name, timeMs: this.#tracer.now(), attributes });
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    if (!this.#ended) this.#data.status = message ? { code, message } : { code };
    return this;
  }

  /** End the span once; later calls do nothing. */
  end(endTimeMs?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#data.endTimeMs = endTimeMs ?? this.#tracer.now();
    this.#tracer.finish(this.#data);
  }
}

export class Tracer {
  readonly now: () => number;
  readonly #processors = new Set<SpanProcessor>();

  constructor(opts: TracerOptions = {}) {
    this.now = opts.now ?? hrNow;
  }

  /** Whether any processor listens (callers may skip building attributes when none does). */
  get recording(): boolean {
    return this.#processors.size > 0;
  }

  addProcessor(p: SpanProcessor): () => void {
    this.#processors.add(p);
    return () => this.#processors.delete(p);
  }

  startSpan(
    name: string,
    opts: {
      kind?: SpanKind;
      attributes?: Attributes;
      parent?: SpanContext | null;
      startTimeMs?: number;
    } = {},
  ): Span {
    const parent = opts.parent ?? null;
    return new Span(this, {
      traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent?.spanId ?? null,
      name,
      kind: opts.kind ?? 'internal',
      startTimeMs: opts.startTimeMs ?? this.now(),
      endTimeMs: 0,
      attributes: { ...(opts.attributes ?? {}) },
      events: [],
      status: { code: 'unset' },
    });
  }

  /** Called by Span.end. A processor that throws never breaks the caller. */
  finish(span: SpanData): void {
    for (const p of this.#processors) {
      try {
        p(span);
      } catch {
        // ignored: telemetry must never break the Hub
      }
    }
  }
}
