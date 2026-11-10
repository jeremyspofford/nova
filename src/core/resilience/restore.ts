// What a restore keeps from now (M7 amendment §1), written into the staged copy of the home before
// it is sealed for the next start. Rolling the person's data back never rolls back a trust
// decision or a forget:
//  - Devices: one revoked since the checkpoint stays revoked (its row as it is now); one paired
//    since is dropped and needs pairing again (said in the confirmation); what a device may do is
//    the stricter of then and now; sign-ins that ended since stay ended; no pairing code from then
//    works again.
//  - This node's place in the mesh (mesh/: its keys, its role) is now's: keys replaced since are
//    never put back. The epoch becomes max(now, checkpoint) + 1, so fencing never turns against the
//    restored hub, and a standby that sees its hub at a higher epoch copies it afresh (replica.ts).
//  - Forgets: every checkpoint was cleaned when it happened; anything forgotten since is checked
//    for again here (memories by their "forgotten" notes, capture by its tombstones, day notes by
//    their "note-forgotten" notes: an id and a keyed hash of the words, never the words), and the notes
//    and tombstones come along so nothing forgotten is taken in again.
//  - Problems, as releases carry them: every open or closed problem of now, matched by when, where
//    and what; one resolved since stays resolved.
//  - Nova's records of what exists outside the home (backup runs and drills, the recovery key it
//    showed, its own vault keys), so backups made since stay Nova's and forgets still reach them.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import { cleanDbFile } from '../backups.ts';
import { NOTE_FORGOTTEN, NOTE_RESTORED, dropNotes, forgottenNotes, memoryFiles, noteKeyOf, unfindable, type ForgottenNotes } from '../forgotten-notes.ts';
import type { Vault } from '../vault.ts';
import type { Carried } from './checkpoints.ts';
import { sha256 } from '../workspace.ts';

type Row = Record<string, string | number | null>;

const has = (d: DatabaseSync, table: string) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
const cols = (d: DatabaseSync, table: string) => new Set((d.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));

// Writes `row` into `table` of the staged database, keeping only columns it has.
function upsert(d: DatabaseSync, table: string, row: Row, verb = 'INSERT OR REPLACE'): void {
  const c = cols(d, table);
  const keys = Object.keys(row).filter((k) => c.has(k));
  d.prepare(`${verb} INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] ?? null));
}

// What restoring this checkpoint would drop: devices paired since (they need pairing again).
export function droppedDevices(stagedDb: string, live: Db, hubId: string): { id: string; name: string; kind: string }[] {
  const d = new DatabaseSync(stagedDb, { readOnly: true });
  try {
    const then = has(d, 'device') ? new Set((d.prepare('SELECT id FROM device').all() as { id: string }[]).map((r) => r.id)) : new Set<string>();
    return live.all<{ id: string; name: string; kind: string }>(`SELECT id, name, kind FROM device WHERE trust = 'trusted' AND id != ?`, hubId).filter((r) => !then.has(r.id));
  } finally {
    d.close();
  }
}

export interface CarryOptions {
  home: string;
  staged: string;
  live: Db;
  hubId: string;
  now: Date;
  // The staged home's vault, opened the way this Nova opens its own.
  vaultAt: (home: string) => Vault;
  vault: Vault;
  // Put the vault as it is now in place of the staged one (F-014). False for an emergency promotion
  // from a backup, whose vault rule is its own.
  keepVault?: boolean;
}

export function carryOver(o: CarryOptions): Carried {
  const file = join(o.staged, 'nova.db');
  const at = o.now.toISOString();
  const out: Carried = {
    revoked: [], dropped: [], epoch: { now: 0, checkpoint: 0, restored: 0 }, standby_resync: false,
    problems: { carried: 0, resolved: 0 }, forgotten: { memories: 0, capture: 0 }, sessions_ended: 0, backup_records: 0,
    identity: '', vault: '',
  };
  const live = o.live;
  const forgottenIds: string[] = [];
  const forgottenCapture: string[] = [];
  let notes: ForgottenNotes = { ids: new Set(), hashes: new Set(), count: 0, keyed: 0, key: null };
  const d = new DatabaseSync(file);
  try {
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec('BEGIN');
    // ---- devices and sign-ins ----
    if (has(d, 'device')) {
      const then = new Map((d.prepare('SELECT * FROM device').all() as Row[]).map((r) => [String(r.id), r]));
      for (const l of live.all<Row>('SELECT * FROM device')) {
        const id = String(l.id);
        const t = then.get(id);
        if (id === o.hubId) {
          // This node's keys are now's: the row that names them comes along.
          if (t) upsert(d, 'device', { ...t, public_key: l.public_key ?? null, x25519_public_key: l.x25519_public_key ?? null, fingerprint: l.fingerprint ?? null });
          else upsert(d, 'device', l);
          continue;
        }
        if (l.trust === 'revoked') {
          upsert(d, 'device', l);
          if (!t || t.trust !== 'revoked') out.revoked.push({ id, name: String(l.name) });
        } else if (!t) out.dropped.push({ id, name: String(l.name), kind: String(l.kind) });
        else if (Number(t.can_approve) === 1 && Number(l.can_approve) !== 1) d.prepare('UPDATE device SET can_approve = 0 WHERE id = ?').run(id);
      }
    }
    if (has(d, 'device_session')) {
      const kept = new Set(live.all<{ token_hash: string }>('SELECT token_hash FROM device_session').map((r) => r.token_hash));
      const ended = (d.prepare(`SELECT s.token_hash AS t FROM device_session s LEFT JOIN device dv ON dv.id = s.device_id WHERE dv.trust IS NOT 'trusted'`).all() as { t: string }[]).map((r) => r.t);
      for (const r of d.prepare('SELECT token_hash FROM device_session').all() as { token_hash: string }[]) if (!kept.has(r.token_hash)) ended.push(r.token_hash);
      const del = d.prepare('DELETE FROM device_session WHERE token_hash = ?');
      for (const t of new Set(ended)) { del.run(t); out.sessions_ended++; }
    }
    if (has(d, 'join_request')) d.exec(`UPDATE join_request SET state = 'expired' WHERE state = 'pending'`);
    if (has(d, 'pairing')) d.prepare('UPDATE pairing SET used_at = COALESCE(used_at, ?)').run(at);
    // ---- the mesh: epoch, standby, sync ----
    const liveState = live.get<Row>('SELECT * FROM mesh_state WHERE id = 1');
    if (has(d, 'mesh_state')) {
      const thenState = d.prepare('SELECT * FROM mesh_state WHERE id = 1').get() as Row | undefined;
      const now = Number(liveState?.epoch ?? 1);
      const then = Number(thenState?.epoch ?? 1);
      const epoch = Math.max(now, then) + 1;
      out.epoch = { now, checkpoint: then, restored: epoch };
      let standby = (thenState?.standby_id as string | null) ?? null;
      if (standby) {
        const s = d.prepare('SELECT trust FROM device WHERE id = ?').get(standby) as { trust: string } | undefined;
        if (s?.trust !== 'trusted') standby = null;
      }
      out.standby_resync = !!standby;
      upsert(d, 'mesh_state', { id: 1, epoch, role: 'hub', hub_id: o.hubId, standby_id: standby, updated_at: at });
    }
    if (has(d, 'sync_state')) d.exec('UPDATE sync_state SET acked_seq = 0, acked_at = NULL, behind_since = NULL, cursor = 0 WHERE id = 1');
    // ---- forgets made since ----
    if (has(d, 'memory_event') && has(d, 'memory')) {
      const notes = live.all<Row>(`SELECT * FROM memory_event WHERE kind = 'forgotten'`);
      const known = new Set((d.prepare(`SELECT memory_id FROM memory_event WHERE kind = 'forgotten'`).all() as { memory_id: string }[]).map((r) => r.memory_id));
      const q = d.prepare('SELECT 1 FROM memory WHERE id = ?');
      for (const n of notes) {
        const id = String(n.memory_id);
        if (q.get(id)) forgottenIds.push(id);
        if (!known.has(id)) { const { id: _seq, ...rest } = n; upsert(d, 'memory_event', rest, 'INSERT'); known.add(id); }
      }
    }
    // Day notes forgotten since (they have no record): their content-free notes come along, and
    // their entries leave the staged MEMORY.md and day notes below, by id or by the keyed hash of their words.
    const noteRows = live.all<Row>(`SELECT * FROM memory_event WHERE kind IN ('${NOTE_FORGOTTEN}', '${NOTE_RESTORED}') ORDER BY id`);
    // Found by their keyed hash under this hub's note key (in its vault). A note that can only be
    // found that way, with the key out of reach, stops the restore: never put back unchecked.
    notes = forgottenNotes(noteRows.map((r) => ({ kind: String(r.kind), memory_id: String(r.memory_id) })), noteRows.length ? noteKeyOf(o.vault) : null);
    const missing = unfindable(notes);
    if (missing) throw new Error(`${missing}, so the restore could bring them back`);
    if (noteRows.length && has(d, 'memory_event')) {
      const sig = (r: Row) => `${r.at}\0${r.kind}\0${r.memory_id}`;
      const known = new Set((d.prepare(`SELECT at, kind, memory_id FROM memory_event WHERE kind IN ('${NOTE_FORGOTTEN}', '${NOTE_RESTORED}')`).all() as Row[]).map(sig));
      for (const n of noteRows) if (!known.has(sig(n))) { const { id: _seq, ...rest } = n; upsert(d, 'memory_event', rest, 'INSERT'); known.add(sig(n)); }
    }
    if (has(d, 'capture_tombstone')) {
      const tombs = live.all<Row>('SELECT * FROM capture_tombstone');
      for (const t of tombs) upsert(d, 'capture_tombstone', t, 'INSERT OR IGNORE');
      if (tombs.length && has(d, 'capture_event')) {
        const keys = new Set(tombs.map((t) => `${t.source_id}\0${t.key}`));
        for (const r of d.prepare('SELECT id, source_id, external_id FROM capture_event WHERE external_id IS NOT NULL').all() as { id: string; source_id: string; external_id: string }[]) {
          if (keys.has(`${r.source_id}\0${sha256(`${r.source_id}\0${r.external_id}`)}`)) forgottenCapture.push(String(r.id));
        }
      }
    }
    // ---- problems ----
    if (has(d, 'problem')) {
      const key = (r: Row) => `${r.at}\0${r.source}\0${r.message}`;
      const then = new Map((d.prepare('SELECT id, at, source, message, resolved_at FROM problem').all() as Row[]).map((r) => [key(r), r]));
      const playbooks = has(d, 'problem_playbook') && live.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'problem_playbook'`);
      for (const p of live.all<Row>('SELECT * FROM problem ORDER BY id')) {
        const t = then.get(key(p));
        if (t) {
          if (!t.resolved_at && p.resolved_at) { d.prepare('UPDATE problem SET resolved_at = ? WHERE id = ?').run(p.resolved_at, t.id as number); out.problems.resolved++; }
          continue;
        }
        const { id: oldId, ...rest } = p;
        upsert(d, 'problem', rest, 'INSERT');
        out.problems.carried++;
        if (playbooks) {
          const pb = live.get<Row>('SELECT * FROM problem_playbook WHERE problem_id = ?', oldId as number);
          if (pb) upsert(d, 'problem_playbook', { ...pb, problem_id: Number((d.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id) });
        }
      }
    }
    // ---- Nova's records of what is outside the home ----
    for (const table of ['backup_run', 'backup_drill']) {
      if (!has(d, table)) continue;
      for (const r of live.all<Row>(`SELECT * FROM ${table}`)) { upsert(d, table, r); out.backup_records++; }
    }
    if (has(d, 'profile')) {
      const r = live.get<Row>(`SELECT * FROM profile WHERE section = 'backups' AND key = 'recovery_shown'`);
      if (r) upsert(d, 'profile', r);
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw e;
  } finally {
    d.close();
  }
  // Forgotten rows go the way every forget does: deleted and the freed pages overwritten.
  if (forgottenIds.length) cleanDbFile(file, 'memory', forgottenIds);
  if (forgottenCapture.length) cleanDbFile(file, 'capture_event', forgottenCapture);
  // Forgotten day notes leave the staged files. The staged sync log's copies of those files go too
  // (they may hold the notes; the next start logs the files again as they are).
  let notesDropped = 0;
  for (const rel of memoryFiles(o.staged)) {
    const p = join(o.staged, rel);
    const r = dropNotes(readFileSync(p, 'utf8'), notes);
    if (!r) continue;
    writeFileSync(p, r.text);
    notesDropped += r.dropped;
  }
  if (notesDropped) {
    const s = new DatabaseSync(file);
    try {
      s.exec('PRAGMA secure_delete = ON');
      if (has(s, 'sync_log')) s.exec(`DELETE FROM sync_log WHERE tbl = 'file' AND (pk = 'MEMORY.md' OR pk LIKE 'memory/%')`);
      s.exec('VACUUM');
    } finally {
      s.close();
    }
  }
  out.forgotten = { memories: forgottenIds.length, capture: forgottenCapture.length, notes: notesDropped };

  // ---- this node's place in the mesh: now's ----
  const meshNow = join(o.home, 'mesh');
  const meshThen = join(o.staged, 'mesh');
  if (existsSync(meshNow)) {
    rmSync(meshThen, { recursive: true, force: true });
    cpSync(meshNow, meshThen, { recursive: true });
    out.identity = 'This node’s identity and keys are as they are now (keys are never put back).';
  } else out.identity = 'This node’s identity comes from the checkpoint.';

  // ---- the vault: now's, whole (F-014) ----
  // Deleting a secret rotates the vault's key, so the guarantee is that it is gone for good. A
  // checkpoint from before held the old key and the deleted secret (checkpoints no longer take the
  // vault at all, but older ones did), so a restore never puts the vault back: secrets, Nova's own
  // keys and the key itself are as they are now. A secret added since the checkpoint stays.
  if (o.keepVault === false) return out;
  const vaultNow = join(o.home, 'vault');
  const vaultThen = join(o.staged, 'vault');
  rmSync(vaultThen, { recursive: true, force: true });
  if (existsSync(vaultNow)) {
    cpSync(vaultNow, vaultThen, { recursive: true });
    out.vault = 'Your saved secrets are as they are now: a restore never brings back one you deleted.';
  } else out.vault = 'You have no saved secrets now, and a restore never brings back one you deleted.';
  return out;
}

