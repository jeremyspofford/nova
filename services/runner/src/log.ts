// A small structured logger for the runner: JSON lines on stderr. The runner is a separate,
// permissively licensed package (ADR-023), so it carries its own logger instead of the Hub's.
// Values under secret-looking keys never reach a line (bearer tokens, credentials), and the runner
// never logs commands, file contents or command output (task content stays in the environment).

export type RunnerLogLevel = 'info' | 'warn' | 'error';

export interface RunnerLogRecord {
  ts: string;
  level: RunnerLogLevel;
  module: 'runner';
  msg: string;
  [key: string]: unknown;
}

export interface RunnerLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEY = /token|authorization|secret|password|passphrase|cookie|credential/i;

function clean(value: unknown, key: string, depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, '', depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clean(v, k, depth + 1)]),
  );
}

function record(
  level: RunnerLogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): RunnerLogRecord {
  const out: RunnerLogRecord = { ts: new Date().toISOString(), level, module: 'runner', msg };
  for (const [k, v] of Object.entries(fields)) out[k] = clean(v, k);
  return out;
}

/** JSON lines through `write` (default stderr). */
export function streamLog(
  write: (line: string) => void = (l) => process.stderr.write(l),
): RunnerLog {
  const emit = (level: RunnerLogLevel) => (msg: string, fields?: Record<string, unknown>) =>
    write(`${JSON.stringify(record(level, msg, fields))}\n`);
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Keeps records in memory (tests). */
export class MemoryLog implements RunnerLog {
  readonly records: RunnerLogRecord[] = [];
  info(msg: string, fields?: Record<string, unknown>): void {
    this.records.push(record('info', msg, fields));
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.records.push(record('warn', msg, fields));
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.records.push(record('error', msg, fields));
  }
}

/** Drops everything. */
export const silentLog: RunnerLog = { info: () => {}, warn: () => {}, error: () => {} };
