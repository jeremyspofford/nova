// The broker's own audit log (§8): the authority. Append-only, hash-chained, 0600, in its own
// folder. One record per verb: when, the device, the verb, the ref, the target in canonical form,
// the scope item (method and path, never a query string), the outcome, the tier, the approval or
// consent id, the task and the caller's role. Never a value, a part, a length or any encoding of
// one, a hash of one, headers, bodies or query strings. Core copies each record (it comes back in
// the answer) into the Work Ledger under its task; a gap shows in Health.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AuditRecord, Role } from './protocol.ts';

export type Entry = Omit<AuditRecord, 'seq' | 'at' | 'prev' | 'hash' | 'device'>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Audit {
  readonly path: string;
  #device: string;
  #seq = 0;
  #prev = '0'.repeat(64);
  #now: () => Date;

  constructor(path: string, device: string, now: () => Date = () => new Date()) {
    this.path = path;
    this.#device = device;
    this.#now = now;
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    chmodSync(path, 0o600);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const last = lines.at(-1);
    if (last) { const r = JSON.parse(last) as AuditRecord; this.#seq = r.seq; this.#prev = r.hash; }
  }

  write(e: Entry): AuditRecord {
    const body = { seq: this.#seq + 1, at: this.#now().toISOString(), device: this.#device, verb: e.verb, ref: e.ref, target: e.target, scope_item: e.scope_item, outcome: e.outcome, tier: e.tier, approval_id: e.approval_id, task: e.task, role: e.role as Role, prev: this.#prev };
    const rec: AuditRecord = { ...body, hash: sha(JSON.stringify(body)) };
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    this.#seq = rec.seq;
    this.#prev = rec.hash;
    return rec;
  }
}

// The chain, checked: every record's hash is its own, and each names the one before.
export function verifyChain(text: string): { ok: boolean; records: number; broken_at: number | null } {
  let prev = '0'.repeat(64);
  const lines = text.split('\n').filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const { hash, ...body } = JSON.parse(line) as AuditRecord;
    if (body.prev !== prev || sha(JSON.stringify(body)) !== hash) return { ok: false, records: lines.length, broken_at: i + 1 };
    prev = hash;
  }
  return { ok: true, records: lines.length, broken_at: null };
}
