// The promotion drill's tap (M10g, docs/plans/M10g.md §6). The drill proves no private key crosses
// between nodes by scanning everything that did, as the receiver read it. With NOVA_DRILL_TAP set to
// a folder, a node appends what it received over the mesh (decrypted sync batches, the handover,
// rosters, answers) to a file there, one JSON line each. Off unless set; only the drill and its test
// set it, on temp homes.
//
// The core turns it on (`setTap`) only in a test or the drill, on a temp home (handover.ts `testing`);
// anywhere else it is refused. Nothing it writes holds key material in clear: the vault's key, which a
// sync batch carries to a standby sealed, is replaced by its digest.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let dir: string | null = null;
export function setTap(to: string | null): void { dir = to; }

const digest = (v: string) => `[vault key, sha256 ${createHash('sha256').update(v).digest('hex').slice(0, 16)}]`;
function clean(kind: string, data: unknown): unknown {
  if (kind !== 'sync' || !data || typeof data !== 'object') return data;
  const p = data as { rows?: { tbl?: string; row?: string | null }[] };
  if (!Array.isArray(p.rows)) return data;
  return { ...p, rows: p.rows.map((r) => {
    if (r?.tbl !== 'vault' || typeof r.row !== 'string') return r;
    try { const v = JSON.parse(r.row) as { key?: string }; return typeof v.key === 'string' ? { ...r, row: JSON.stringify({ ...v, key: digest(v.key) }) } : r; } catch { return r; }
  }) };
}

export function tap(kind: string, data: unknown): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `received-${process.pid}.jsonl`), `${JSON.stringify({ kind, at: new Date().toISOString(), data: clean(kind, data) })}\n`, { mode: 0o600 });
  } catch { /* a tap that can't write is no reason to stop */ }
}
