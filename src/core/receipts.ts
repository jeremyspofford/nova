// Context receipts (CONTRACTS §2, ADR-10): for every model call, what it was told (as references
// and hashes, never the content) and where it went. The egress log is every remote receipt.
// A remote call under local-only is a violation: it is refused and recorded as a problem, so it
// can never sit in the log looking like an allowed call.
import { randomUUID } from 'node:crypto';
import { CoreError } from './errors.ts';
import { PRIVACY_MODES, type PrivacyMode } from './envelope.ts';
import type { Db } from './db.ts';
import { redactText, type Log } from './log.ts';

export const ITEM_KINDS = ['memory', 'file', 'skill', 'session', 'standing'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface ContextItem { kind: ItemKind; ref: string; sha256: string }

export interface ReceiptInput {
  task_id?: string | undefined;
  session_id?: string | undefined;
  provider: string;
  model: string;
  purpose: string;
  privacy_mode: PrivacyMode;
  egress: string;                // 'local' | 'remote:<name>'
  context_items: ContextItem[];
}

export interface Receipt {
  id: string;
  at: string;
  task_id: string | null;
  session_id: string | null;
  provider: string;
  model: string;
  purpose: string;
  privacy_mode: PrivacyMode;
  egress: string;
  context_items: ContextItem[];
}

const EGRESS = /^(local|remote:[a-z0-9][a-z0-9._-]{0,63})$/;
const SHA = /^[0-9a-f]{64}$/;

type Row = Omit<Receipt, 'context_items'> & { context_items: string };

export class Receipts {
  #db: Db;
  #log: Log;
  #now: () => Date;

  constructor(o: { db: Db; log: Log; now?: () => Date }) {
    this.#db = o.db;
    this.#log = o.log;
    this.#now = o.now ?? (() => new Date());
  }

  record(input: ReceiptInput): Receipt {
    const i = (input ?? {}) as Partial<ReceiptInput>;
    const text = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !v.trim()) throw new CoreError('validation', `${what} is required.`);
      // A receipt says where things went, never a secret that went with them (vault.ts).
      return redactText(v.trim());
    };
    const optional = (v: unknown, what: string) => (v == null || v === '' ? null : text(v, what));
    const r: Receipt = {
      id: randomUUID(),
      at: this.#now().toISOString(),
      task_id: optional(i.task_id, 'task_id'),
      session_id: optional(i.session_id, 'session_id'),
      provider: text(i.provider, 'provider'),
      model: text(i.model, 'model'),
      purpose: text(i.purpose, 'purpose'),
      privacy_mode: i.privacy_mode as PrivacyMode,
      egress: typeof i.egress === 'string' ? i.egress : '',
      context_items: [],
    };
    if (!PRIVACY_MODES.includes(r.privacy_mode)) throw new CoreError('validation', `privacy_mode must be one of ${PRIVACY_MODES.join(', ')}.`);
    if (!EGRESS.test(r.egress)) throw new CoreError('validation', 'egress must be "local" or "remote:<name>", naming where the call went.');
    if (!Array.isArray(i.context_items)) throw new CoreError('validation', 'context_items must be a list, even an empty one.');
    r.context_items = i.context_items.map((c, n) => {
      const where = `context item ${n + 1}`;
      if (!ITEM_KINDS.includes(c?.kind)) throw new CoreError('validation', `${where}: kind must be one of ${ITEM_KINDS.join(', ')}.`);
      if (typeof c.ref !== 'string' || !c.ref.trim()) throw new CoreError('validation', `${where}: ref is required.`);
      if (typeof c.sha256 !== 'string' || !SHA.test(c.sha256)) throw new CoreError('validation', `${where}: sha256 must be the 64-character hex hash of what was sent.`);
      return { kind: c.kind, ref: redactText(c.ref), sha256: c.sha256 };
    });

    if (r.privacy_mode === 'local-only' && r.egress !== 'local') {
      const to = r.egress.slice('remote:'.length);
      const known = r.task_id && this.#db.get('SELECT 1 FROM task WHERE id = ?', r.task_id);
      this.#log.problem('receipts', `A model call for "${r.purpose}" was going to send context to ${to} while Nova is set to local-only. It was refused.`, {
        detail: `provider ${r.provider}, model ${r.model}, ${r.context_items.length} context items${r.task_id ? `, task ${r.task_id}` : ''}${r.session_id ? `, session ${r.session_id}` : ''}`,
        ...(known ? { taskId: r.task_id! } : {}),
        // A security refusal stops Nova (DESIGN-SYSTEM §1).
        stops: true,
      });
      throw new CoreError('forbidden', `Local-only mode doesn't allow sending context to ${to}. Nothing was recorded as allowed, and it has been noted as a problem.`);
    }

    this.#db.run(
      'INSERT INTO receipt (id, at, task_id, session_id, provider, model, purpose, privacy_mode, egress, context_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.at, r.task_id, r.session_id, r.provider, r.model, r.purpose, r.privacy_mode, r.egress, JSON.stringify(r.context_items),
    );
    return r;
  }

  get(id: string): Receipt {
    const row = this.#db.get<Row>('SELECT * FROM receipt WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `There is no receipt with id "${id}".`);
    return this.#shape(row);
  }

  // Newest first. egress 'remote' is the egress log: everything that left the device.
  list(f: { task_id?: string; session_id?: string; egress?: 'local' | 'remote'; limit?: number } = {}): Receipt[] {
    const limit = f.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CoreError('validation', 'limit must be a whole number from 1 to 1000.');
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.task_id) { where.push('task_id = ?'); args.push(f.task_id); }
    if (f.session_id) { where.push('session_id = ?'); args.push(f.session_id); }
    if (f.egress === 'remote') where.push("egress LIKE 'remote:%'");
    else if (f.egress === 'local') where.push("egress = 'local'");
    else if (f.egress !== undefined) throw new CoreError('validation', 'egress must be local or remote.');
    return this.#db.all<Row>(`SELECT * FROM receipt ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`, ...args, limit).map((r) => this.#shape(r));
  }

  counts(): { total: number; remote: number } {
    const c = this.#db.get<{ total: number; remote: number | null }>("SELECT COUNT(*) AS total, SUM(egress LIKE 'remote:%') AS remote FROM receipt");
    return { total: c?.total ?? 0, remote: c?.remote ?? 0 };
  }

  #shape(row: Row): Receipt {
    return { ...row, context_items: JSON.parse(row.context_items) as ContextItem[] };
  }
}
