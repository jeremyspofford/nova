// Hard deletion of temporary chats (FR-027): rows, parts, attachments and their blobs, search
// rows (by trigger), citations and queued input all go. Usage rows stay for spend accounting but
// lose their thread and turn ids. Blobs are content-addressed and may be shared, so a blob is
// removed only when nothing else refers to it.
import { rmSync } from 'node:fs';
import { resolveWithin } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { parseAttachments } from './followups.ts';

/** Every live or deleted descendant thread of `rootId` (branches and side chats), deepest last. */
export function descendantThreads(db: NovaDatabase, rootId: string): string[] {
  return (
    db.raw
      .prepare(
        `WITH RECURSIVE d(id, depth) AS (
           SELECT id, 1 FROM thread WHERE parent_thread_id = ?
           UNION
           SELECT t.id, d.depth + 1 FROM thread t JOIN d ON t.parent_thread_id = d.id
           WHERE d.depth < 1000
         )
         SELECT id FROM d ORDER BY depth, id`,
      )
      .all(rootId) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Delete the threads and everything in them. Call inside `db.transaction`; returns blob paths
 * that may now be unreferenced (pass them to `removeUnreferencedBlobs` after the commit).
 */
export function purgeThreadRows(db: NovaDatabase, threadIds: string[]): string[] {
  const raw = db.raw;
  const blobs = new Set<string>();
  // Children before parents (thread.parent_thread_id is a foreign key).
  const ordered = [...threadIds].reverse();
  for (const id of ordered) {
    for (const r of raw.prepare('SELECT blob_path FROM attachment WHERE thread_id = ?').all(id) as {
      blob_path: string;
    }[])
      blobs.add(r.blob_path);
    for (const r of raw
      .prepare('SELECT attachments FROM queued_input WHERE thread_id = ?')
      .all(id) as { attachments: string | null }[])
      for (const a of parseAttachments(r.attachments)) blobs.add(a.blobPath);
    const inThread = 'SELECT id FROM message WHERE thread_id = ?';
    raw.prepare(`DELETE FROM citation WHERE message_id IN (${inThread})`).run(id);
    raw.prepare(`DELETE FROM message_part WHERE message_id IN (${inThread})`).run(id);
    raw
      .prepare(`DELETE FROM attachment WHERE thread_id = ? OR message_id IN (${inThread})`)
      .run(id, id);
    raw.prepare('DELETE FROM message WHERE thread_id = ?').run(id);
    raw
      .prepare('UPDATE usage_event SET thread_id = NULL, turn_id = NULL WHERE thread_id = ?')
      .run(id);
    raw.prepare('DELETE FROM turn WHERE thread_id = ?').run(id);
    raw.prepare('DELETE FROM queued_input WHERE thread_id = ?').run(id);
    raw.prepare('UPDATE thread SET parent_thread_id = NULL WHERE parent_thread_id = ?').run(id);
    raw.prepare('DELETE FROM thread WHERE id = ?').run(id);
  }
  return [...blobs];
}

/** Remove blobs that no attachment, source or queued input refers to any more. */
export function removeUnreferencedBlobs(
  db: NovaDatabase,
  dataDir: string,
  paths: readonly string[],
): number {
  let removed = 0;
  for (const p of new Set(paths)) {
    const used =
      db.raw.prepare('SELECT 1 AS x FROM attachment WHERE blob_path = ? LIMIT 1').get(p) ??
      db.raw.prepare('SELECT 1 AS x FROM source WHERE blob_path = ? LIMIT 1').get(p) ??
      db.raw
        .prepare(
          "SELECT 1 AS x FROM queued_input WHERE status = 'pending' AND instr(attachments, ?) > 0 LIMIT 1",
        )
        .get(JSON.stringify(p));
    if (used) continue;
    try {
      rmSync(resolveWithin([dataDir], p), { force: true });
      removed++;
    } catch {
      // a path outside the data directory or an unreadable file: leave it
    }
  }
  return removed;
}
