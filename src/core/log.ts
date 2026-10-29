// Structured logging and problems. The log is a JSON-lines file for diagnosis; a problem is an
// error that matters to the person, stored in the database and pushed to every open client.
// Anything worth a `problem()` must never live only in the log (NOVA-SPEC §8).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Db } from './db.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Problem {
  id: number;
  at: string;
  source: string;
  message: string;
  detail: string | null;
  task_id: string | null;
  resolved_at: string | null;
}

// Keys whose values never reach the log, whatever the caller passes.
const SECRET = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

export class Log extends EventEmitter {
  readonly file: string | null;
  #db: Db;
  #now: () => Date;

  constructor(db: Db, file: string | null, now: () => Date = () => new Date()) {
    super();
    this.#db = db;
    this.file = file;
    this.#now = now;
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(level: Level, source: string, msg: string, data: Record<string, unknown> = {}): void {
    if (!this.file) return;
    const line = { at: this.#now().toISOString(), level, source, msg, ...(redact(data) as object) };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }

  info(source: string, msg: string, data?: Record<string, unknown>): void { this.write('info', source, msg, data); }
  warn(source: string, msg: string, data?: Record<string, unknown>): void { this.write('warn', source, msg, data); }

  // Record something the person needs to know about. The message is in plain words; the detail
  // (a stack, an exit code) is one tap away.
  problem(source: string, message: string, opts: { detail?: string; taskId?: string } = {}): Problem {
    const at = this.#now().toISOString();
    this.#db.run('INSERT INTO problem (at, source, message, detail, task_id) VALUES (?, ?, ?, ?, ?)', at, source, message, opts.detail ?? null, opts.taskId ?? null);
    const row = this.#db.get<Problem>('SELECT * FROM problem WHERE id = last_insert_rowid()')!;
    this.write('error', source, message, { detail: opts.detail, task: opts.taskId });
    this.emit('problem', row);
    return row;
  }

  problems(opts: { open?: boolean } = {}): Problem[] {
    return this.#db.all<Problem>(`SELECT * FROM problem ${opts.open ? 'WHERE resolved_at IS NULL' : ''} ORDER BY id DESC LIMIT 200`);
  }

  resolve(id: number): void {
    this.#db.run('UPDATE problem SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', this.#now().toISOString(), id);
  }
}
