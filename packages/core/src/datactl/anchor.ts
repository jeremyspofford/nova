// Audit retention keeps the hash chain verifiable (FR-105, FR-104; ADR-097 D5). Pruning removes the
// oldest entries and records where the kept chain starts (`audit_anchor`: the last pruned entry's
// seq and hash), and the prune is itself an audit entry the caller appends. Verification walks
// from the anchor, so an entry edited, removed or reordered after it still breaks the chain, and
// so does a forged anchor that does not match the first kept entry's `prev_hash`. The anchor must
// also be vouched for by its prune's own entry in the kept chain (`data.retention.audit_pruned`
// with the anchor's hash and seq, written in the prune's transaction): a database writer who drops
// the head of the log and writes an anchor has no such entry (M8 data review).
import type { DatabaseSync } from 'node:sqlite';
import type { AuditVerifyResult } from '@nova/shared';
import { auditRowHash, type AuditRow } from '../ops/audit.ts';
import { quoteIdent } from './codec.ts';

/** The action of the entry a prune writes (its `input_hash` is the anchor's hash). */
export const AUDIT_PRUNED_ACTION = 'data.retention.audit_pruned';

export interface AuditAnchor {
  seq: number;
  hash: string;
  prunedAt: string;
}

/** Where the kept chain starts, or null when nothing was ever pruned. */
export function auditAnchor(db: DatabaseSync): AuditAnchor | null {
  const row = db.prepare('SELECT seq, hash, pruned_at FROM audit_anchor WHERE id = 1').get() as
    { seq: number | bigint; hash: string; pruned_at: string } | undefined;
  return row ? { seq: Number(row.seq), hash: row.hash, prunedAt: row.pruned_at } : null;
}

/** Walk the chain from its anchor (or its start) and report the first entry that does not verify. */
export function verifyAuditChain(db: DatabaseSync): AuditVerifyResult {
  const anchor = auditAnchor(db);
  if (anchor && !anchorVouched(db, anchor)) {
    const first = db.prepare('SELECT id FROM audit_event ORDER BY seq ASC LIMIT 1').get() as
      { id: string } | undefined;
    return { ok: false, checked: 0, brokenAt: first?.id ?? 'audit_anchor' };
  }
  const page = db.prepare('SELECT * FROM audit_event WHERE seq > ? ORDER BY seq ASC LIMIT 1000');
  let checked = 0;
  let prevSeq = anchor?.seq ?? 0;
  let prevHash: string | null = anchor?.hash ?? null;
  for (;;) {
    const rows = page.all(prevSeq) as unknown as AuditRow[];
    if (!rows.length) break;
    for (const row of rows) {
      checked++;
      const intact =
        Number(row.seq) === prevSeq + 1 &&
        row.prev_hash === prevHash &&
        auditRowHash(row) === row.hash;
      if (!intact) return { ok: false, checked, brokenAt: row.id };
      prevSeq = Number(row.seq);
      prevHash = row.hash;
    }
  }
  return { ok: true, checked, brokenAt: null };
}

/** Whether the kept chain holds the prune entry that set this anchor. */
function anchorVouched(db: DatabaseSync, anchor: AuditAnchor): boolean {
  const rows = db
    .prepare(
      'SELECT detail_json FROM audit_event WHERE action = ? AND input_hash = ? AND seq > ? ORDER BY seq DESC',
    )
    .all(AUDIT_PRUNED_ACTION, anchor.hash, anchor.seq) as { detail_json: string | null }[];
  return rows.some((r) => {
    try {
      const d = JSON.parse(r.detail_json ?? '{}') as { anchorSeq?: unknown };
      return d.anchorSeq === anchor.seq;
    } catch {
      return false;
    }
  });
}

/**
 * Remove the entries created before `cutoff` and move the anchor to the last one removed. Call
 * inside a transaction. Returns how many went and the new anchor.
 */
export function pruneAuditBefore(
  db: DatabaseSync,
  cutoff: string,
  now: string,
): { removed: number; anchor: AuditAnchor | null } {
  const last = db
    .prepare(
      'SELECT seq, hash FROM audit_event WHERE seq = (SELECT max(seq) FROM audit_event WHERE created_at < ?)',
    )
    .get(cutoff) as { seq: number | bigint; hash: string } | undefined;
  if (!last) return { removed: 0, anchor: auditAnchor(db) };
  const guards = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_event' AND sql LIKE '%RAISE(%'",
    )
    .all() as { name: string; sql: string }[];
  for (const g of guards) db.exec(`DROP TRIGGER ${quoteIdent(g.name)}`);
  let removed: number;
  try {
    removed = Number(
      db.prepare('DELETE FROM audit_event WHERE seq <= ?').run(Number(last.seq)).changes,
    );
  } finally {
    for (const g of guards) db.exec(g.sql);
  }
  db.prepare(
    `INSERT INTO audit_anchor (id, seq, hash, pruned_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, pruned_at = excluded.pruned_at`,
  ).run(Number(last.seq), last.hash, now);
  return { removed, anchor: { seq: Number(last.seq), hash: last.hash, prunedAt: now } };
}
