// In-memory ring of recent log records for the Diagnostics log viewer and log export (FR-118,
// docs/16 §1). Records arrive already redacted by the Logger; queries redact again on the way
// out so a secret registered after a record was written (a key read later) is still masked.
import { defaultRedactor, type Redactor } from '@nova/security';
import { atLeast, type Level, type LogRecord, type LogSink } from './logger.ts';

export interface LogQuery {
  /** Minimum severity. */
  level?: Level;
  /** A module and its sub-modules: `hub.mcp` matches `hub.mcp` and `hub.mcp.client`. */
  module?: string;
  /** ISO timestamp; records at or after it. */
  since?: string;
  /** Most recent first; default 200. */
  limit?: number;
}

export interface LogEntry {
  ts: string;
  level: Level;
  module: string;
  msg: string;
  /** Structured fields other than ts, level, module and msg. */
  fields: Record<string, unknown>;
}

export class RingSink implements LogSink {
  readonly capacity: number;
  readonly #buf: (LogRecord | undefined)[];
  readonly #redactor: Redactor;
  #next = 0;
  #size = 0;

  constructor(capacity = 5000, redactor: Redactor = defaultRedactor) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be ≥ 1');
    this.capacity = capacity;
    this.#buf = new Array<LogRecord | undefined>(capacity);
    this.#redactor = redactor;
  }

  write(record: LogRecord): void {
    this.#buf[this.#next] = record;
    this.#next = (this.#next + 1) % this.capacity;
    this.#size = Math.min(this.#size + 1, this.capacity);
  }

  get size(): number {
    return this.#size;
  }

  /** Records oldest first. */
  *#records(): Generator<LogRecord> {
    const start = (this.#next - this.#size + this.capacity) % this.capacity;
    for (let i = 0; i < this.#size; i++) {
      const r = this.#buf[(start + i) % this.capacity];
      if (r) yield r;
    }
  }

  /** Matching records, most recent first, redacted. */
  query(q: LogQuery = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(q.limit ?? 200, this.capacity));
    const all = [...this.#records()];
    const out: LogEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const r = all[i]!;
      if (q.level && !atLeast(r.level, q.level)) continue;
      if (q.module && r.module !== q.module && !r.module.startsWith(`${q.module}.`)) continue;
      if (q.since && r.ts < q.since) continue;
      out.push(this.#entry(r));
    }
    return out;
  }

  /** Every record oldest first as redacted JSON lines, for a bug-report export. */
  *exportLines(): Generator<string> {
    for (const r of this.#records()) {
      const e = this.#entry(r);
      yield `${JSON.stringify({ ts: e.ts, level: e.level, module: e.module, msg: e.msg, ...e.fields })}\n`;
    }
  }

  #entry(r: LogRecord): LogEntry {
    const { ts, level, module, msg, ...fields } = r;
    return {
      ts,
      level,
      module,
      msg: this.#redactor.redactString(msg),
      fields: this.#redactor.redact(fields),
    };
  }
}
