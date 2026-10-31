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
  // 1 when the problem stops Nova (work can't proceed, a dead-man's switch fired, a security
  // refusal): the orb shows it red. 0, the default, is a problem that needs the person while Nova
  // keeps running: amber (DESIGN-SYSTEM §1; owner decision 2026-10-31).
  stops: number;
}

export const UNSAVED_FROM = -1_000_000_000;

// Keys whose values never reach the log, whatever the caller passes.
const SECRET = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

// Values the vault holds, wherever they turn up (an error message quoting a token, a URL with one
// in it). The vault adds each value it reads or writes; short values are skipped, since replacing
// every “on” in a log would hide more than it protects.
const SECRET_VALUES = new Set<string>();
export function addSecretValue(value: string): void {
  if (typeof value !== 'string') return;
  // A JSON value (Gmail's saved sign-in) is also redacted field by field.
  if (value.length >= 8) SECRET_VALUES.add(value);
  if (value.startsWith('{')) {
    try {
      for (const v of Object.values(JSON.parse(value) as Record<string, unknown>)) if (typeof v === 'string' && v.length >= 8) SECRET_VALUES.add(v);
    } catch { /* not JSON after all */ }
  }
}
export function redactText(text: string): string {
  let out = text;
  for (const v of SECRET_VALUES) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

export class Log extends EventEmitter {
  readonly file: string | null;
  #db: Db;
  #now: () => Date;
  // True on a standby, whose problem table is a copy of the hub's: its own problems take ids below
  // zero, so the hub's never overwrite them.
  local: () => boolean = () => false;
  // Problems the database couldn't take (a full disk). Their ids are far below any standby's own.
  #unsaved: Problem[] = [];
  #unsavedId = UNSAVED_FROM;

  constructor(db: Db, file: string | null, now: () => Date = () => new Date()) {
    super();
    this.#db = db;
    this.file = file;
    this.#now = now;
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(level: Level, source: string, msg: string, data: Record<string, unknown> = {}): void {
    if (!this.file) return;
    const line = { at: this.#now().toISOString(), level, source, msg: redactText(msg), ...(redact(data) as object) };
    // A log that can't be written (a full disk) never stops what was being logged.
    try { appendFileSync(this.file, `${JSON.stringify(line)}\n`); } catch { /* the problem itself is still shown */ }
  }

  info(source: string, msg: string, data?: Record<string, unknown>): void { this.write('info', source, msg, data); }
  warn(source: string, msg: string, data?: Record<string, unknown>): void { this.write('warn', source, msg, data); }

  // Record something the person needs to know about. The message is in plain words; the detail
  // (a stack, an exit code) is one tap away. `stops`: only where what went wrong stops Nova (the
  // Failed class: work can't proceed, a dead-man's switch fired, a security refusal); everything
  // else needs the person while Nova keeps running.
  problem(source: string, said: string, opts: { detail?: string; taskId?: string; stops?: boolean } = {}): Problem {
    const at = this.#now().toISOString();
    // Problems are stored, shown and copied to the standby: no secret value gets that far.
    const message = redactText(said);
    if (opts.detail) opts = { ...opts, detail: redactText(opts.detail) };
    const stops = opts.stops ? 1 : 0;
    let row: Problem;
    try {
      if (this.local()) this.#db.run('INSERT INTO problem (id, at, source, message, detail, task_id, stops) VALUES ((SELECT MIN(0, IFNULL(MIN(id), 0)) - 1 FROM problem), ?, ?, ?, ?, ?, ?)', at, source, message, opts.detail ?? null, opts.taskId ?? null, stops);
      else this.#db.run('INSERT INTO problem (at, source, message, detail, task_id, stops) VALUES (?, ?, ?, ?, ?, ?)', at, source, message, opts.detail ?? null, opts.taskId ?? null, stops);
      row = this.#db.get<Problem>('SELECT * FROM problem WHERE id = last_insert_rowid()')!;
    } catch (e) {
      // The database can't take it (the disk is full, M7b's chaos pass): the problem is still
      // shown and listed, kept in memory until Nova restarts, and written to the log file.
      row = { id: --this.#unsavedId, at, source, message, detail: `${opts.detail ? `${opts.detail}\n` : ''}(Not saved: ${(e as Error).message})`, task_id: opts.taskId ?? null, resolved_at: null, stops };
      this.#unsaved = [row, ...this.#unsaved].slice(0, 50);
    }
    this.write('error', source, message, { detail: opts.detail, task: opts.taskId });
    this.emit('problem', row);
    return row;
  }

  problems(opts: { open?: boolean } = {}): Problem[] {
    const kept = this.#unsaved.filter((p) => !opts.open || !p.resolved_at);
    return [...kept, ...this.#db.all<Problem>(`SELECT * FROM problem ${opts.open ? 'WHERE resolved_at IS NULL' : ''} ORDER BY id DESC LIMIT 200`)];
  }

  // A problem that couldn't be saved (its id is below UNSAVED_FROM), or null.
  unsaved(id: number): Problem | null {
    return this.#unsaved.find((p) => p.id === id) ?? null;
  }

  resolve(id: number): void {
    const u = this.#unsaved.find((p) => p.id === id);
    if (u) { u.resolved_at ??= this.#now().toISOString(); return; }
    this.#db.run('UPDATE problem SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', this.#now().toISOString(), id);
  }
}
