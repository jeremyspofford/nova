// Structured JSON logging (docs/16 §1). Redaction is applied here, at the boundary, so call
// sites can never leak a secret by forgetting to scrub it.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRedactor, type Redactor } from '@nova/security';

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

/** Whether `level` is at least as severe as `min`. */
export function atLeast(level: Level, min: Level): boolean {
  return RANK[level] >= RANK[min];
}

export interface LogRecord {
  ts: string;
  level: Level;
  module: string;
  msg: string;
  [key: string]: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  module: string;
  level?: Level;
  sinks?: LogSink[];
  redactor?: Redactor;
  /** Bound fields added to every record (correlation ids, request id). */
  bindings?: Record<string, unknown>;
  now?: () => Date;
  /** Per-module level overrides, e.g. { 'hub.http': 'debug' }. */
  moduleLevels?: Record<string, Level>;
}

/**
 * The sinks a logger family writes to. Children share the parent's set, so a sink added later
 * (the diagnostics ring, FR-118) receives records from every module.
 */
class SinkSet {
  readonly list: LogSink[];
  constructor(sinks: readonly LogSink[]) {
    this.list = [...sinks];
  }
}

export class Logger {
  readonly module: string;
  readonly #opts: Required<Omit<LoggerOptions, 'moduleLevels' | 'bindings' | 'sinks'>> & {
    moduleLevels: Record<string, Level>;
    bindings: Record<string, unknown>;
  };
  readonly #sinks: SinkSet;

  constructor(opts: LoggerOptions, shared?: SinkSet) {
    this.module = opts.module;
    this.#sinks = shared ?? new SinkSet(opts.sinks ?? [stderrSink]);
    this.#opts = {
      module: opts.module,
      level: opts.level ?? 'info',
      redactor: opts.redactor ?? defaultRedactor,
      bindings: opts.bindings ?? {},
      now: opts.now ?? (() => new Date()),
      moduleLevels: opts.moduleLevels ?? {},
    };
  }

  /** A logger for a sub-module sharing sinks, level and bindings. */
  child(module: string, bindings: Record<string, unknown> = {}): Logger {
    return new Logger(
      {
        ...this.#opts,
        module: `${this.module}.${module}`,
        bindings: { ...this.#opts.bindings, ...bindings },
      },
      this.#sinks,
    );
  }

  /** A logger with extra bound fields (same module). */
  with(bindings: Record<string, unknown>): Logger {
    return new Logger(
      {
        ...this.#opts,
        module: this.module,
        bindings: { ...this.#opts.bindings, ...bindings },
      },
      this.#sinks,
    );
  }

  /** Add a sink to this logger and every logger that shares its sinks (parent and children). */
  addSink(sink: LogSink): void {
    if (!this.#sinks.list.includes(sink)) this.#sinks.list.push(sink);
  }

  removeSink(sink: LogSink): void {
    const i = this.#sinks.list.indexOf(sink);
    if (i >= 0) this.#sinks.list.splice(i, 1);
  }

  /** The first sink of a given class, e.g. `log.findSink(RingSink)`. */
  findSink<T extends LogSink>(type: abstract new (...args: never[]) => T): T | undefined {
    return this.#sinks.list.find((s): s is T => s instanceof type);
  }

  enabled(level: Level): boolean {
    const threshold = this.#opts.moduleLevels[this.module] ?? this.#opts.level;
    return RANK[level] >= RANK[threshold];
  }

  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled(level)) return;
    const red = this.#opts.redactor;
    const record: LogRecord = {
      ...(red.redact({ ...this.#opts.bindings, ...fields }) as Record<string, unknown>),
      ts: this.#opts.now().toISOString(),
      level,
      module: this.module,
      msg: red.redactString(msg),
    };
    for (const sink of this.#sinks.list) {
      try {
        sink.write(record);
      } catch {
        // A failing sink must never break the caller.
      }
    }
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.log('trace', msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
}

export const stderrSink: LogSink = {
  write(record) {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  },
};

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

/** Append-only JSONL file with size-based rotation (default 10 MB × 5 files, docs/16 §1). */
export class RotatingFileSink implements LogSink {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  #size: number;

  constructor(path: string, opts: { maxBytes?: number; maxFiles?: number } = {}) {
    this.#path = path;
    this.#maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.#maxFiles = opts.maxFiles ?? 5;
    mkdirSync(dirname(path), { recursive: true });
    this.#size = existsSync(path) ? statSync(path).size : 0;
  }

  write(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
    appendFileSync(this.#path, line, { mode: 0o600 });
    this.#size += bytes;
  }

  #rotate(): void {
    rmSync(`${this.#path}.${this.#maxFiles - 1}`, { force: true });
    for (let i = this.#maxFiles - 2; i >= 1; i--) {
      if (existsSync(`${this.#path}.${i}`))
        renameSync(`${this.#path}.${i}`, `${this.#path}.${i + 1}`);
    }
    if (existsSync(this.#path)) renameSync(this.#path, `${this.#path}.1`);
    this.#size = 0;
  }
}
