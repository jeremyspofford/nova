// Append-only audit log with a SHA-256 hash chain (FR-104 partial, docs/12 §11, docs/06
// invariant 4). Each row's `hash` covers the canonical JSON of the row without `hash` — which
// includes `seq` and `prev_hash` — so editing, removing or reordering any entry breaks the chain
// from that entry on. Appends read the chain head and insert in one synchronous step inside a
// serialized transaction, so concurrent appends can never fork the chain. Inputs are stored only
// as hashes; every text field is redacted before it is written.
import type { StatementSync } from 'node:sqlite';
import { uuidv7, type AuditEntryView, type AuditVerifyResult, type Page } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditRecord, AuditSink } from '../tools/types.ts';
import { canonicalJson } from '../nodes/crypto.ts';
import { sha256Hex } from './canonical.ts';

/** One `audit_event` row as stored (snake_case, like the SQL). */
export interface AuditRow {
  id: string;
  seq: number;
  account_id: string;
  actor: string;
  kind: string;
  thread_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  action: string;
  resource: string | null;
  input_hash: string | null;
  decision: string | null;
  result: string | null;
  detail_json: string | null;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

const HASHED: readonly Exclude<keyof AuditRow, 'hash'>[] = [
  'id',
  'seq',
  'account_id',
  'actor',
  'kind',
  'thread_id',
  'turn_id',
  'run_id',
  'agent_id',
  'session_id',
  'action',
  'resource',
  'input_hash',
  'decision',
  'result',
  'detail_json',
  'prev_hash',
  'created_at',
];

/** The chain hash of a row: SHA-256 of the canonical JSON of every column except `hash`. */
export function auditRowHash(row: Omit<AuditRow, 'hash'>): string {
  const subject: Record<string, unknown> = {};
  for (const k of HASHED) subject[k] = row[k] ?? null;
  return sha256Hex(canonicalJson(subject));
}

export interface AuditListQuery {
  kind?: string;
  threadId?: string;
  /** `seq` of the last entry of the previous page. */
  cursor?: string;
  limit?: number;
}

export interface AuditLogOptions {
  db: NovaDatabase;
  /** Where `audit.appended` is published (contracts/events.md). */
  events?: EventSink;
  redactor?: Redactor;
  now?: () => Date;
  log?: Logger;
}

const MAX_DETAIL_CHARS = 16_384;
/** A list view's detail is at most this many characters of JSON (the export has it whole). */
export const MAX_VIEW_DETAIL_CHARS = 4_096;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export class AuditLog implements AuditSink {
  readonly #db: NovaDatabase;
  readonly #events: EventSink | undefined;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #log: Logger | undefined;
  #head: StatementSync | null = null;
  #insert: StatementSync | null = null;

  constructor(opts: AuditLogOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log;
  }

  async append(rec: AuditRecord): Promise<void> {
    await this.record(rec);
  }

  /** Append one entry and return it. */
  async record(rec: AuditRecord): Promise<AuditEntryView> {
    const red = (v: string | null | undefined, max: number) =>
      clip(v === null || v === undefined ? null : this.#redactor.redactString(v), max);
    let detail: string | null = null;
    if (rec.detail && Object.keys(rec.detail).length) {
      detail = JSON.stringify(this.#redactor.redact(rec.detail));
      if (detail.length > MAX_DETAIL_CHARS)
        detail = JSON.stringify({ truncated: true, chars: detail.length });
    }
    const draft = {
      id: uuidv7(),
      account_id: rec.accountId,
      actor: clip(rec.actor, 200) ?? 'system',
      kind: rec.kind,
      thread_id: rec.threadId ?? null,
      turn_id: rec.turnId ?? null,
      run_id: null,
      agent_id: null,
      session_id: null,
      action: red(rec.action, 200) ?? '',
      resource: red(rec.resource, 2000),
      input_hash: clip(rec.inputHash, 128),
      decision: red(rec.decision, 200),
      result: red(rec.result, 2000),
      detail_json: detail,
      created_at: this.#now().toISOString(),
    };
    const row = await this.#db.transaction(() => {
      // Head read and insert run without an await between them: nothing can append in between.
      this.#head ??= this.#db.raw.prepare(
        'SELECT seq, hash FROM audit_event ORDER BY seq DESC LIMIT 1',
      );
      this.#insert ??= this.#db.raw.prepare(
        `INSERT INTO audit_event (id, seq, account_id, actor, kind, thread_id, turn_id, run_id,
           agent_id, session_id, action, resource, input_hash, decision, result, detail_json,
           prev_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const head = this.#head.get() as { seq: number; hash: string } | undefined;
      const unhashed = { ...draft, seq: (head?.seq ?? 0) + 1, prev_hash: head?.hash ?? null };
      const full: AuditRow = { ...unhashed, hash: auditRowHash(unhashed) };
      this.#insert.run(
        full.id,
        full.seq,
        full.account_id,
        full.actor,
        full.kind,
        full.thread_id,
        full.turn_id,
        full.run_id,
        full.agent_id,
        full.session_id,
        full.action,
        full.resource,
        full.input_hash,
        full.decision,
        full.result,
        full.detail_json,
        full.prev_hash,
        full.hash,
        full.created_at,
      );
      return full;
    });
    try {
      await this.#events?.emit({
        name: 'audit.appended',
        accountId: row.account_id,
        payload: { auditId: row.id, kind: row.kind, hash: row.hash },
      });
    } catch (err) {
      this.#log?.warn('audit.appended event failed', { err });
    }
    return this.#view(row);
  }

  /**
   * An entry as the API shows it, with its detail redacted again (like the export) and capped,
   * so a list page stays small and nothing that looks like a secret leaves (M7.5).
   */
  #view(r: AuditRow): AuditEntryView {
    let detail: Record<string, unknown> | null = null;
    if (r.detail_json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.detail_json);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const red = this.#redactor.redact(parsed as Record<string, unknown>);
        const chars = JSON.stringify(red).length;
        detail = chars > MAX_VIEW_DETAIL_CHARS ? { truncated: true, chars } : red;
      }
    }
    return { ...toView(r), detail };
  }

  /** Newest first, one account, optionally one kind and one thread. */
  list(accountId: string, q: AuditListQuery = {}): Promise<Page<AuditEntryView>> {
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    const where = ['account_id = ?'];
    const params: (string | number)[] = [accountId];
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.threadId) {
      where.push('thread_id = ?');
      params.push(q.threadId);
    }
    if (q.cursor) {
      const seq = Number(q.cursor);
      if (Number.isInteger(seq)) {
        where.push('seq < ?');
        params.push(seq);
      }
    }
    const rows = this.#db.raw
      .prepare(`SELECT * FROM audit_event WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as unknown as AuditRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Promise.resolve({
      items: page.map((r) => this.#view(r)),
      nextCursor: rows.length > limit && last ? String(last.seq) : null,
    });
  }

  /** Walk the whole chain in order and report the first entry that does not verify. */
  verify(): Promise<AuditVerifyResult> {
    const page = this.#db.raw.prepare(
      'SELECT * FROM audit_event WHERE seq > ? ORDER BY seq ASC LIMIT 1000',
    );
    let checked = 0;
    let prevSeq = 0;
    let prevHash: string | null = null;
    for (;;) {
      const rows = page.all(prevSeq) as unknown as AuditRow[];
      if (!rows.length) break;
      for (const row of rows) {
        checked++;
        const intact =
          row.seq === prevSeq + 1 && row.prev_hash === prevHash && auditRowHash(row) === row.hash;
        if (!intact) return Promise.resolve({ ok: false, checked, brokenAt: row.id });
        prevSeq = row.seq;
        prevHash = row.hash;
      }
    }
    return Promise.resolve({ ok: true, checked, brokenAt: null });
  }

  /**
   * One account's entries oldest first as JSON lines (redacted again on the way out), with the
   * chain fields so an export can be checked offline.
   */
  async *exportLines(accountId: string): AsyncGenerator<string> {
    const page = this.#db.raw.prepare(
      'SELECT * FROM audit_event WHERE account_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500',
    );
    let after = 0;
    for (;;) {
      const rows = page.all(accountId, after) as unknown as AuditRow[];
      if (!rows.length) return;
      for (const r of rows) {
        const line = {
          id: r.id,
          seq: r.seq,
          ts: r.created_at,
          actor: r.actor,
          kind: r.kind,
          action: r.action,
          resource: r.resource,
          inputHash: r.input_hash,
          decision: r.decision,
          result: r.result,
          threadId: r.thread_id,
          turnId: r.turn_id,
          detail: r.detail_json ? (JSON.parse(r.detail_json) as unknown) : null,
          prevHash: r.prev_hash,
          hash: r.hash,
        };
        yield `${JSON.stringify(this.#redactor.redact(line))}\n`;
        after = r.seq;
      }
      // Let other work run between pages of a large export.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

function toView(r: AuditRow): AuditEntryView {
  return {
    id: r.id,
    actor: r.actor,
    kind: r.kind,
    action: r.action,
    resource: r.resource,
    decision: r.decision,
    result: r.result,
    threadId: r.thread_id,
    turnId: r.turn_id,
    createdAt: r.created_at,
    hash: r.hash,
  };
}
