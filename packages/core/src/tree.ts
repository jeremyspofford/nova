// The message tree (FR-020). Every message points at the one it follows (`parent_id`); editing a
// user message or regenerating a reply adds a sibling, so earlier turns are never mutated. A
// thread's active path is the chain from its `active_leaf_id` up to the root. A branch thread's
// first message follows a message of its parent thread, so walking the chain inherits the
// parent's path up to the branch point without copying rows (FR-033).
import { inArray } from 'drizzle-orm';
import { schema, type NovaDatabase } from '@nova/storage';

const { message } = schema;

export type MessageRow = typeof message.$inferSelect;

/** Upper bound on chain length, a guard against a corrupt (cyclic) parent link. */
const MAX_DEPTH = 100_000;

/**
 * Visible messages on the chain from `leafId` to the root, root first. A message is visible
 * when it is not deleted; an inherited message whose own thread was deleted stays visible in
 * the branch that inherits it (the thread delete stamped it, not the user).
 */
export async function visibleChain(
  db: NovaDatabase,
  leafId: string | null,
  viewThreadId: string,
): Promise<MessageRow[]> {
  if (!leafId) return [];
  const ids = (
    db.raw
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT m.parent_id, c.depth + 1 FROM chain c JOIN message m ON m.id = c.id
           WHERE m.parent_id IS NOT NULL AND c.depth < ${MAX_DEPTH}
         )
         SELECT c.id AS id FROM chain c
         JOIN message m ON m.id = c.id
         JOIN thread t ON t.id = m.thread_id
         WHERE m.deleted_at IS NULL
            OR (m.thread_id <> ? AND t.deleted_at IS NOT NULL AND m.deleted_at = t.deleted_at)
         ORDER BY c.depth DESC`,
      )
      .all(leafId, viewThreadId) as { id: string }[]
  ).map((r) => r.id);
  return loadInOrder(db, ids);
}

/** Every message id on the chain from `leafId` to the root, deleted or not. */
export function chainIds(db: NovaDatabase, leafId: string | null): Set<string> {
  if (!leafId) return new Set();
  const rows = db.raw
    .prepare(
      `WITH RECURSIVE chain(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT m.parent_id, c.depth + 1 FROM chain c JOIN message m ON m.id = c.id
         WHERE m.parent_id IS NOT NULL AND c.depth < ${MAX_DEPTH}
       )
       SELECT id FROM chain`,
    )
    .all(leafId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** The newest live message of `threadId` below `messageId`, or `messageId` itself. */
export function newestDescendant(db: NovaDatabase, messageId: string, threadId: string): string {
  const row = db.raw
    .prepare(
      `WITH RECURSIVE d(id) AS (
         SELECT id FROM message WHERE parent_id = ? AND thread_id = ?
         UNION
         SELECT m.id FROM message m JOIN d ON m.parent_id = d.id WHERE m.thread_id = ?
       )
       SELECT m.id AS id FROM d JOIN message m ON m.id = d.id
       WHERE m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1`,
    )
    .get(messageId, threadId, threadId) as { id: string } | undefined;
  return row?.id ?? messageId;
}

/**
 * Versions per parent among a thread's live messages, oldest first: the key is the parent id
 * ('' for a root). Messages sharing a parent are edits or regenerations of each other.
 */
export function siblingGroups(db: NovaDatabase, threadId: string): Map<string, string[]> {
  const rows = db.raw
    .prepare(
      `SELECT id, parent_id AS parentId FROM message
       WHERE thread_id = ? AND deleted_at IS NULL
       ORDER BY created_at, id`,
    )
    .all(threadId) as { id: string; parentId: string | null }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.parentId ?? '';
    const list = out.get(key) ?? [];
    list.push(r.id);
    out.set(key, list);
  }
  return out;
}

async function loadInOrder(db: NovaDatabase, ids: string[]): Promise<MessageRow[]> {
  if (!ids.length) return [];
  const rows = await db.orm.select().from(message).where(inArray(message.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}
