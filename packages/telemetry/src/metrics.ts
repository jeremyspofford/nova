// Content-free metrics (docs/16 §2, FR-223): counters, histograms and observed gauges, kept as
// cumulative values since the meter started and read by `collect()` (the OTLP exporter reads them
// on its metrics interval). Attribute sets per instrument are capped so a careless attribute can
// never grow memory without bound.
import type { Attributes } from './trace.ts';

export interface InstrumentOptions {
  description?: string;
  unit?: string;
}

export interface NumberPoint {
  attributes: Attributes;
  value: number;
}

export interface HistogramPoint {
  attributes: Attributes;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** One more than `boundaries`: the last counts values above the last boundary. */
  bucketCounts: number[];
}

interface Common {
  name: string;
  description: string;
  unit: string;
  startTimeMs: number;
  timeMs: number;
}

export type MetricData =
  | (Common & { kind: 'sum'; points: NumberPoint[] })
  | (Common & { kind: 'gauge'; points: NumberPoint[] })
  | (Common & { kind: 'histogram'; boundaries: number[]; points: HistogramPoint[] });

export interface Counter {
  add(value: number, attributes?: Attributes): void;
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

/** Default histogram boundaries for durations in seconds (OpenTelemetry's HTTP advice). */
export const DURATION_BOUNDARIES_S = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** Attribute sets kept per instrument; points for further sets are dropped and counted. */
export const MAX_ATTRIBUTE_SETS = 1000;

const keyOf = (a: Attributes) =>
  JSON.stringify(
    Object.entries(a)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  );

type Observe = () => number | NumberPoint[];

interface SumState {
  kind: 'sum';
  opts: InstrumentOptions;
  points: Map<string, NumberPoint>;
}
interface HistState {
  kind: 'histogram';
  opts: InstrumentOptions;
  boundaries: number[];
  points: Map<string, HistogramPoint>;
}
interface GaugeState {
  kind: 'gauge';
  opts: InstrumentOptions;
  observe: Observe;
}

export class Meter {
  readonly #now: () => number;
  readonly #start: number;
  readonly #instruments = new Map<string, SumState | HistState | GaugeState>();
  #overflow = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#start = this.#now();
  }

  /** Points dropped because an instrument had too many attribute sets. */
  get overflow(): number {
    return this.#overflow;
  }

  /** A monotonic counter; the same name returns the same counter. */
  counter(name: string, opts: InstrumentOptions = {}): Counter {
    const s = this.#state(name, () => ({ kind: 'sum' as const, opts, points: new Map() }));
    if (s.kind !== 'sum') throw new TypeError(`${name} is not a counter`);
    return {
      add: (value, attributes = {}) => {
        if (!(value >= 0) || !Number.isFinite(value)) return;
        const p = this.#point(s.points, attributes, () => ({
          attributes: { ...attributes },
          value: 0,
        }));
        if (p) p.value += value;
      },
    };
  }

  histogram(name: string, opts: InstrumentOptions & { boundaries?: number[] } = {}): Histogram {
    const boundaries = [...(opts.boundaries ?? DURATION_BOUNDARIES_S)].sort((a, b) => a - b);
    const s = this.#state(name, () => ({
      kind: 'histogram' as const,
      opts,
      boundaries,
      points: new Map(),
    }));
    if (s.kind !== 'histogram') throw new TypeError(`${name} is not a histogram`);
    return {
      record: (value, attributes = {}) => {
        if (!Number.isFinite(value)) return;
        const p = this.#point(s.points, attributes, () => ({
          attributes: { ...attributes },
          count: 0,
          sum: 0,
          min: value,
          max: value,
          bucketCounts: new Array<number>(s.boundaries.length + 1).fill(0),
        }));
        if (!p) return;
        p.count += 1;
        p.sum += value;
        p.min = Math.min(p.min, value);
        p.max = Math.max(p.max, value);
        let i = s.boundaries.findIndex((b) => value <= b);
        if (i < 0) i = s.boundaries.length;
        p.bucketCounts[i] = (p.bucketCounts[i] ?? 0) + 1;
      },
    };
  }

  /** A gauge read at collection time; a callback that throws is skipped. */
  gauge(name: string, opts: InstrumentOptions, observe: Observe): void {
    this.#instruments.set(name, { kind: 'gauge', opts, observe });
  }

  /** Every instrument's cumulative state now. */
  collect(): MetricData[] {
    const timeMs = this.#now();
    const out: MetricData[] = [];
    for (const [name, s] of this.#instruments) {
      const common = {
        name,
        description: s.opts.description ?? '',
        unit: s.opts.unit ?? '',
        startTimeMs: this.#start,
        timeMs,
      };
      if (s.kind === 'sum') {
        if (s.points.size)
          out.push({
            ...common,
            kind: 'sum',
            points: [...s.points.values()].map((p) => ({ ...p })),
          });
      } else if (s.kind === 'histogram') {
        if (s.points.size)
          out.push({
            ...common,
            kind: 'histogram',
            boundaries: [...s.boundaries],
            points: [...s.points.values()].map((p) => ({
              ...p,
              bucketCounts: [...p.bucketCounts],
            })),
          });
      } else {
        try {
          const v = s.observe();
          const points = typeof v === 'number' ? [{ attributes: {}, value: v }] : v;
          if (points.length) out.push({ ...common, kind: 'gauge', points });
        } catch {
          // a failing gauge is left out of this collection
        }
      }
    }
    return out;
  }

  #state<T extends SumState | HistState | GaugeState>(
    name: string,
    make: () => T,
  ): SumState | HistState | GaugeState {
    const existing = this.#instruments.get(name);
    if (existing) return existing;
    const s = make();
    this.#instruments.set(name, s);
    return s;
  }

  #point<P>(points: Map<string, P>, attributes: Attributes, make: () => P): P | null {
    const key = keyOf(attributes);
    let p = points.get(key);
    if (!p) {
      if (points.size >= MAX_ATTRIBUTE_SETS) {
        this.#overflow += 1;
        return null;
      }
      p = make();
      points.set(key, p);
    }
    return p;
  }
}
