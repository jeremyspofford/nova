// The promotion drill's tap (M10g, docs/plans/M10g.md §6). The drill proves no private key crosses
// between nodes by scanning everything that did, as the receiver read it. With NOVA_DRILL_TAP set to
// a folder, a node appends what it received over the mesh (decrypted sync batches, the handover,
// rosters, answers) to a file there, one JSON line each. Off unless set; only the drill and its test
// set it, on temp homes.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function tap(kind: string, data: unknown): void {
  const dir = process.env.NOVA_DRILL_TAP;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `received-${process.pid}.jsonl`), `${JSON.stringify({ kind, at: new Date().toISOString(), data })}\n`, { mode: 0o600 });
  } catch { /* a tap that can't write is no reason to stop */ }
}
