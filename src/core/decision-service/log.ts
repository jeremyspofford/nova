// The decision log (ADR §3): one record per decision. It has the template and version, the seat,
// the pinned model asked and the model that answered, the mode, egress and opt-in, the state's hash
// and field names (never its content), the full answers and every shadow answer, the bands,
// outcome, action, tier and autonomy, the trust and verdict, and why. It goes to the Work Ledger:
// with the task's id when the decision was made inside a task. The core writes it to the
// decision_record table (DbLog, migration 0019); FileLog (JSON lines) and MemoryLog remain for
// tools and tests.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecisionRecord } from './types.ts';

export interface DecisionLog { write(r: DecisionRecord): void }

export class MemoryLog implements DecisionLog {
  readonly records: DecisionRecord[] = [];
  write(r: DecisionRecord): void { this.records.push(r); }
}

// <home>/logs/decisions.jsonl. A log that can't be written never stops the decision.
export class FileLog implements DecisionLog {
  readonly file: string;
  #onError: ((e: Error) => void) | undefined;
  constructor(file: string, o: { onError?: (e: Error) => void } = {}) {
    this.file = file;
    this.#onError = o.onError;
    mkdirSync(dirname(file), { recursive: true });
  }
  write(r: DecisionRecord): void {
    try { appendFileSync(this.file, `${JSON.stringify(r)}\n`); } catch (e) { this.#onError?.(e as Error); }
  }
}

// The decision_record table (migration 0019, DS1 NOTE 5): one INSERT per record. JSON columns for
// the field names, usage, answers, bands, shadows and failures. Like every sink, it never holds the
// state itself, and a write that fails never stops the decision.
export interface RecordDb { run(sql: string, ...params: (string | number | null)[]): void }

export class DbLog implements DecisionLog {
  #db: RecordDb;
  #onError: ((e: Error) => void) | undefined;
  constructor(db: RecordDb, o: { onError?: (e: Error) => void } = {}) {
    this.#db = db;
    this.#onError = o.onError;
  }
  write(r: DecisionRecord): void {
    const j = (v: unknown) => JSON.stringify(v);
    try {
      this.#db.run(
        `INSERT INTO decision_record (id, at, task_id, subsystem, template_id, version, seat, model_asked, model, privacy_mode, egress, opt_in,
          state_sha256, state_fields, pieces, requests, usage, answers, bands, shadows, failures, outcome, action, tier, autonomy, quality, trust, verdict_ref, why)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, r.at, r.task_id, r.subsystem, r.template_id, r.version, r.seat, r.model_asked, r.model, r.privacy_mode, r.egress, r.opt_in,
        r.state_sha256, j(r.state_fields), r.pieces, r.requests, j(r.usage), r.answers ? j(r.answers) : null, r.bands ? j(r.bands) : null, j(r.shadows), j(r.failures),
        r.outcome, r.action, r.tier, r.autonomy, r.quality, r.trust, r.verdict_ref, r.why,
      );
    } catch (e) { this.#onError?.(e as Error); }
  }

  // Records go with what they were about (review finding 8): a forgotten item's records are deleted,
  // and a subsystem's records older than its retention are swept with it.
  forget(ids: string[]): void {
    for (const id of ids) this.#db.run('DELETE FROM decision_record WHERE id = ?', id);
  }
  prune(subsystem: string, before: string): void {
    this.#db.run('DELETE FROM decision_record WHERE subsystem = ? AND at < ?', subsystem, before);
  }
}
