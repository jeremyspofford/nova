// A small structured logger for the Relay: JSON lines on stderr. The Relay is a separate,
// permissively licensed package (ADR-023), so it carries its own logger instead of the Hub's.
// Values under secret-looking keys never reach a line (route tokens, registration tokens).

export type RelayLogLevel = 'info' | 'warn' | 'error';

export interface RelayLogRecord {
  ts: string;
  level: RelayLogLevel;
  module: 'relay';
  msg: string;
  [key: string]: unknown;
}

export interface RelayLog {
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
  level: RelayLogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): RelayLogRecord {
  const out: RelayLogRecord = { ts: new Date().toISOString(), level, module: 'relay', msg };
  for (const [k, v] of Object.entries(fields)) out[k] = clean(v, k);
  return out;
}

/** JSON lines through `write` (default stderr). */
export function streamLog(
  write: (line: string) => void = (l) => process.stderr.write(l),
): RelayLog {
  const emit = (level: RelayLogLevel) => (msg: string, fields?: Record<string, unknown>) =>
    write(`${JSON.stringify(record(level, msg, fields))}\n`);
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Keeps records in memory (tests). */
export class MemoryLog implements RelayLog {
  readonly records: RelayLogRecord[] = [];
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
export const silentLog: RelayLog = { info: () => {}, warn: () => {}, error: () => {} };
