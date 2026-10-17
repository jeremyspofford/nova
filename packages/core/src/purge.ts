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
    // Tool calls and artifacts first: they reference the thread's messages (0006).
    for (const p of purgeToolRows(db, id)) blobs.add(p);
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

/** Delete one thread's tool calls and artifacts; returns the artifact blob paths. */
function purgeToolRows(db: NovaDatabase, threadId: string): string[] {
  const raw = db.raw;
  const inThread = 'SELECT id FROM message WHERE thread_id = ?';
  raw
    .prepare(`DELETE FROM tool_call WHERE thread_id = ? OR message_id IN (${inThread})`)
    .run(threadId, threadId);
  const arts = `SELECT id FROM artifact WHERE thread_id = ? OR message_id IN (${inThread})`;
  const blobs = (
    raw
      .prepare(`SELECT blob_path AS p FROM artifact_version WHERE artifact_id IN (${arts})`)
      .all(threadId, threadId) as { p: string }[]
  ).map((r) => r.p);
  for (const r of raw
    .prepare(`SELECT blob_path AS p FROM artifact WHERE id IN (${arts}) AND blob_path IS NOT NULL`)
    .all(threadId, threadId) as { p: string }[])
    blobs.push(r.p);
  raw
    .prepare(`DELETE FROM artifact_version WHERE artifact_id IN (${arts})`)
    .run(threadId, threadId);
  raw
    .prepare(`DELETE FROM artifact WHERE thread_id = ? OR message_id IN (${inThread})`)
    .run(threadId, threadId);
  return blobs;
}

/**
 * Remove blobs nothing refers to any more: no attachment, source, artifact (or artifact version)
 * or pending queued input. Blobs are content-addressed, so they may be shared.
 */
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
      db.raw.prepare('SELECT 1 AS x FROM artifact WHERE blob_path = ? LIMIT 1').get(p) ??
      db.raw.prepare('SELECT 1 AS x FROM artifact_version WHERE blob_path = ? LIMIT 1').get(p) ??
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
