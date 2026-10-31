// The decision log (ADR §3): one record per decision. It has the template and version, the seat,
// the pinned model asked and the model that answered, the mode, egress and opt-in, the state's hash
// and field names (never its content), the full answers and every shadow answer, the bands,
// outcome, action, tier and autonomy, the trust and verdict, and why. It goes to the Work Ledger:
// with the task's id when the decision was made inside a task. The database table is Track 1's
// migration; until then the sink is a JSON-lines file in Nova's home.
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
