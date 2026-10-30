// Long-term memory (NOVA-SPEC §7, CONTRACTS §7): durable records with provenance that the person
// can inspect, correct and delete. Corrections supersede and never rewrite; forgetting is real
// deletion of the whole chain, leaving only a content-free audit event. Export is plain files
// (ADR-4) the person owns.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from './errors.ts';
import { sha256 } from './workspace.ts';
import type { Db } from './db.ts';

export const KINDS = ['timeline', 'entity', 'fact', 'preference', 'decision', 'commitment'] as const;
export type Kind = (typeof KINDS)[number];
export const USER_STATES = ['confirmed', 'unreviewed', 'corrected'] as const;
export type UserState = (typeof USER_STATES)[number];

const HEADINGS: Record<Kind, string> = { timeline: 'Timeline', entity: 'People, places and things', fact: 'Facts', preference: 'Preferences', decision: 'Decisions', commitment: 'Commitments' };
const SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// nova, person, import, a worker id, or device:<id> for a note a paired device sent (M4b).
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RECORDER = /^(?:[a-z0-9][a-z0-9._-]{0,63}|device:[0-9a-f-]{36})$/;
const LOW = 0.5;

export interface MemoryInput {
  kind: Kind;
  content: string;
  recorded_by: string;           // nova | person | import | <worker id>
  source?: string;
  observed_at?: string;
  confidence?: number | null;
  scope?: string;
  expires?: string | null;
}

export interface MemoryRecord {
  id: string;
  kind: Kind;
  content: string;
  source: string | null;
  observed_at: string;
  recorded_by: string;
  confidence: number | null;
  scope: string;
  supersedes: string | null;
  superseded_by: string | null;
  expires: string | null;
  user_state: UserState;
  created_at: string;
  low_confidence: boolean;
  active: boolean;
}

export interface MemoryEvent { id: number; at: string; kind: 'remembered' | 'corrected' | 'confirmed' | 'forgotten'; memory_id: string; by: string }
export interface Retrieved { kind: 'memory'; ref: string; sha256: string }
export interface Filter { kind?: Kind; scope?: string; state?: UserState }

type Row = Omit<MemoryRecord, 'low_confidence' | 'active'>;

// Words worth matching on, as Era 2's notes search has them (src/memory.js).
const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
  'just me my no not of on or our so that the their them then there these they this to was we were what when where ' +
  'which who why will with would you your about after again all also am any because been before being both each few ' +
  'more most other over same should some such than too very nova please tell know want need like get got make').split(' '));

export function terms(text: string): string[] {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])]
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => !STOP.has(w));
}

const date = (v: unknown, what: string): string => {
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new CoreError('validation', `${what} must be a date and time, like 2026-01-31T09:00:00Z.`);
  return d.toISOString();
};

export class Memory {
  readonly exportsDir: string;
  #db: Db;
  #now: () => Date;
  #afterForget: (ids: string[]) => void;
  #forgetListeners: ((records: MemoryRecord[]) => void)[] = [];

  // afterForget: where else the forgotten records must go (the backups).
  constructor(o: { db: Db; home: string; now?: () => Date; afterForget?: (ids: string[]) => void }) {
    this.#db = o.db;
    this.#now = o.now ?? (() => new Date());
    this.#afterForget = o.afterForget ?? (() => {});
    this.exportsDir = join(o.home, 'exports');
    // Forgotten content is overwritten on disk, not just unlinked from the table.
    this.#db.raw.exec('PRAGMA secure_delete = ON');
  }

  remember(input: MemoryInput): MemoryRecord {
    const row = this.#validate(input, randomUUID());
    return this.#db.tx(() => this.#insert(row, 'remembered'));
  }

  // Brings in a record kept somewhere else first (Era 2's MEMORY.md), keeping its own id. An id
  // that is already here, or was forgotten, is skipped, so importing again adds nothing.
  importRecord(input: MemoryInput & { id: string }): { record: MemoryRecord | null; imported: boolean } {
    const id = input?.id;
    if (typeof id !== 'string' || !NAME.test(id)) throw new CoreError('validation', 'id must be a short name in letters, digits, ., - or _.');
    const row = this.#validate(input, id);
    return this.#db.tx(() => {
      if (this.#db.get('SELECT 1 FROM memory_event WHERE memory_id = ? AND kind = ?', id, 'forgotten')) return { record: null, imported: false };
      if (this.#db.get('SELECT 1 FROM memory WHERE id = ?', id)) return { record: this.get(id), imported: false };
      return { record: this.#insert(row, 'remembered'), imported: true };
    });
  }

  // A new record replaces the old one going forward; the old one is kept, marked corrected.
  // source says where the correction came from (a conversation, say); by default "correction".
  correct(id: string, content: string, by: string, o: { source?: string } = {}): MemoryRecord {
    const text = this.#content(content);
    const who = this.#by(by);
    if (o.source != null && typeof o.source !== 'string') throw new CoreError('validation', 'source must be text.');
    return this.#db.tx(() => {
      const old = this.#row(id);
      if (old.superseded_by) throw new CoreError('conflict', `That memory has already been corrected; correct the newer one (${old.superseded_by}) instead.`);
      const at = this.#now().toISOString();
      const next = this.#insert({
        id: randomUUID(), kind: old.kind, content: text, source: o.source?.trim() || 'correction', observed_at: at, recorded_by: who,
        confidence: who === 'person' ? null : old.confidence, scope: old.scope, supersedes: old.id, superseded_by: null,
        expires: old.expires, user_state: this.#stateFor(who), created_at: at,
      }, 'corrected');
      this.#db.run("UPDATE memory SET superseded_by = ?, user_state = 'corrected' WHERE id = ?", next.id, old.id);
      return next;
    });
  }

  confirm(id: string, by = 'person'): MemoryRecord {
    return this.#db.tx(() => {
      const r = this.#row(id);
      if (r.superseded_by) throw new CoreError('conflict', `That memory has been corrected since; confirm the newer one (${r.superseded_by}) instead.`);
      this.#db.run("UPDATE memory SET user_state = 'confirmed' WHERE id = ?", id);
      this.#event('confirmed', id, this.#by(by));
      return this.get(id);
    });
  }

  // Real deletion of the record and everything it corrected or was corrected by.
  // Called with the forgotten records (words included) after they are gone from the database, so
  // the other places that may hold the same words (rendered files, day notes) can follow.
  onForget(fn: (records: MemoryRecord[]) => void): void {
    this.#forgetListeners.push(fn);
  }

  forget(id: string, by = 'person'): { forgotten: string[] } {
    const who = this.#by(by);
    const records = this.history(id);
    const ids = this.#db.tx(() => {
      const chain = this.history(id).map((r) => r.id);
      for (const m of chain) this.#db.run('DELETE FROM memory WHERE id = ?', m);
      for (const m of chain) this.#event('forgotten', m, who);
      return chain;
    });
    // Old pages in the write-ahead log could still hold the content; fold them in now.
    if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#afterForget(ids);
    for (const fn of this.#forgetListeners) fn(records);
    return { forgotten: ids };
  }

  get(id: string): MemoryRecord {
    return this.#shape(this.#row(id));
  }

  // The record's whole chain, oldest first.
  history(id: string): MemoryRecord[] {
    let first = this.#row(id);
    while (first.supersedes) first = this.#row(first.supersedes);
    const out = [first];
    for (let r = first; r.superseded_by;) { r = this.#row(r.superseded_by); out.push(r); }
    return out.map((r) => this.#shape(r));
  }

  // Every stored record, newest first, including corrected and expired ones, for inspection.
  list(f: Filter = {}): MemoryRecord[] {
    if (f.kind !== undefined && !KINDS.includes(f.kind)) throw new CoreError('validation', `kind must be one of ${KINDS.join(', ')}.`);
    if (f.state !== undefined && !USER_STATES.includes(f.state)) throw new CoreError('validation', `state must be one of ${USER_STATES.join(', ')}.`);
    const where: string[] = [];
    const args: string[] = [];
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.scope) { where.push('scope = ?'); args.push(f.scope); }
    if (f.state) { where.push('user_state = ?'); args.push(f.state); }
    return this.#db.all<Row>(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC`, ...args).map((r) => this.#shape(r));
  }

  // What Nova currently holds as true: not corrected, not expired.
  active(f: Omit<Filter, 'state'> = {}): MemoryRecord[] {
    return this.list(f).filter((r) => r.active);
  }

  search(query: string, o: { scope?: string; limit?: number } = {}): { records: MemoryRecord[]; retrieved: Retrieved[] } {
    const limit = o.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CoreError('validation', 'limit must be a whole number from 1 to 50.');
    const q = terms(query ?? '');
    if (!q.length) return { records: [], retrieved: [] };
    const need = q.length <= 2 ? 1 : 2;
    const hits = this.active(o.scope ? { scope: o.scope } : {})
      .map((r) => { const have = new Set(terms(r.content)); return { r, score: q.filter((w) => have.has(w)).length }; })
      .filter((h) => h.score >= need);
    // Stable sort keeps newest first among equal scores.
    const records = hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.r);
    return { records, retrieved: records.map((r) => ({ kind: 'memory', ref: r.id, sha256: sha256(r.content) })) };
  }

  events(memoryId: string): MemoryEvent[] {
    return this.#db.all<MemoryEvent>('SELECT * FROM memory_event WHERE memory_id = ? ORDER BY id', memoryId);
  }

  counts(): { active: number; unreviewed: number; low_confidence: number } {
    const a = this.active();
    return { active: a.length, unreviewed: a.filter((r) => r.user_state === 'unreviewed').length, low_confidence: a.filter((r) => r.low_confidence).length };
  }

  // Plain files the person owns: every field as JSON, and a readable page grouped by kind.
  export(): { dir: string; json: string; markdown: string; count: number } {
    const at = this.#now().toISOString();
    const dir = join(this.exportsDir, `memory-${at.replace(/[:.]/g, '-')}`);
    const records = this.active().map(({ active: _a, low_confidence: _l, ...r }) => r);
    mkdirSync(dir, { recursive: true });
    const json = join(dir, 'memory.json');
    const markdown = join(dir, 'memory.md');
    writeFileSync(json, `${JSON.stringify({ exported_at: at, records }, null, 2)}\n`);
    const lines = ['# Memory', '', `Exported ${at}. ${records.length} ${records.length === 1 ? 'record' : 'records'}.`];
    for (const kind of KINDS) {
      const mine = records.filter((r) => r.kind === kind);
      if (!mine.length) continue;
      lines.push('', `## ${HEADINGS[kind]}`, '');
      for (const r of mine) {
        const notes = [
          r.confidence != null && r.confidence < LOW ? `low confidence, ${r.confidence}` : null,
          r.user_state === 'unreviewed' ? 'not yet reviewed' : null,
          `noted ${r.observed_at.slice(0, 10)} by ${r.recorded_by}`,
          r.source ? `from ${r.source}` : null,
          r.expires ? `until ${r.expires.slice(0, 10)}` : null,
        ].filter(Boolean);
        lines.push(`- ${r.content.replace(/\s+/g, ' ')} (${notes.join('; ')})`);
      }
    }
    writeFileSync(markdown, `${lines.join('\n')}\n`);
    return { dir, json, markdown, count: records.length };
  }

  #validate(input: MemoryInput, id: string): Row {
    const i = (input ?? {}) as Partial<MemoryInput>;
    if (!KINDS.includes(i.kind as Kind)) throw new CoreError('validation', `kind must be one of ${KINDS.join(', ')}.`);
    const content = this.#content(i.content);
    const by = this.#by(i.recorded_by);
    if (i.confidence != null && (typeof i.confidence !== 'number' || !(i.confidence >= 0 && i.confidence <= 1))) throw new CoreError('validation', 'confidence must be a number from 0 to 1, or left out.');
    const scope = i.scope ?? 'personal';
    if (typeof scope !== 'string' || !SCOPE.test(scope)) throw new CoreError('validation', 'scope must be a short name in lowercase letters, digits, - or _, like "personal" or "work".');
    if (i.source != null && typeof i.source !== 'string') throw new CoreError('validation', 'source must be text.');
    const at = this.#now().toISOString();
    const observed = i.observed_at == null ? at : date(i.observed_at, 'observed_at');
    const expires = i.expires == null ? null : date(i.expires, 'expires');
    return {
      id, kind: i.kind as Kind, content, source: i.source?.trim() || null, observed_at: observed, recorded_by: by,
      confidence: i.confidence ?? null, scope, supersedes: null, superseded_by: null, expires, user_state: this.#stateFor(by), created_at: at,
    };
  }

  #insert(r: Row, event: 'remembered' | 'corrected'): MemoryRecord {
    this.#db.run(
      `INSERT INTO memory (id, kind, content, source, observed_at, recorded_by, confidence, scope, supersedes, superseded_by, expires, user_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.kind, r.content, r.source, r.observed_at, r.recorded_by, r.confidence, r.scope, r.supersedes, r.superseded_by, r.expires, r.user_state, r.created_at,
    );
    this.#event(event, r.supersedes ?? r.id, r.recorded_by);
    if (r.supersedes) this.#event('remembered', r.id, r.recorded_by);
    return this.get(r.id);
  }

  #event(kind: MemoryEvent['kind'], id: string, by: string): void {
    this.#db.run('INSERT INTO memory_event (at, kind, memory_id, by) VALUES (?, ?, ?, ?)', this.#now().toISOString(), kind, id, by);
  }

  #row(id: string): Row {
    const r = this.#db.get<Row>('SELECT * FROM memory WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', `There is no memory with id "${id}".`);
    return r;
  }

  #shape(r: Row): MemoryRecord {
    const now = this.#now().toISOString();
    return { ...r, low_confidence: r.confidence != null && r.confidence < LOW, active: !r.superseded_by && !(r.expires && r.expires <= now) };
  }

  #content(v: unknown): string {
    if (typeof v !== 'string' || !v.trim()) throw new CoreError('validation', 'A memory needs something to remember: content is empty.');
    return v.trim();
  }

  #by(v: unknown): string {
    if (typeof v !== 'string' || !RECORDER.test(v)) throw new CoreError('validation', 'A memory must say who recorded it: nova, person, import, a worker id, or device:<id>.');
    return v;
  }

  #stateFor(by: string): UserState {
    return by === 'person' ? 'confirmed' : 'unreviewed';
  }
}
