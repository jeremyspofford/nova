// Follow-up input (FR-019, docs/09 §2): a message sent while a turn runs either steers that turn
// or waits in a persisted queue (`queued_input`) and starts as its own turn when the running one
// ends. Queued attachments are already stored blobs, so a restart loses nothing.
import { NovaError, type QueuedInputView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { AttachmentKind } from './attachments.ts';

/** An attachment whose bytes are already in the blob store. */
export interface StoredAttachment {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  blobPath: string;
  kind: AttachmentKind;
}

export interface QueuedRow {
  id: string;
  threadId: string;
  accountId: string;
  text: string;
  attachments: StoredAttachment[];
  model: string | null;
  reasoningLevel: string | null;
  createdAt: string;
}

interface RawQueued {
  id: string;
  thread_id: string;
  account_id: string;
  text: string;
  attachments: string | null;
  model: string | null;
  reasoning_level: string | null;
  created_at: string;
}

function fromRaw(r: RawQueued): QueuedRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    text: r.text,
    attachments: parseAttachments(r.attachments),
    model: r.model,
    reasoningLevel: r.reasoning_level,
    createdAt: r.created_at,
  };
}

export function parseAttachments(json: string | null): StoredAttachment[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (a): a is StoredAttachment =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as StoredAttachment).name === 'string' &&
        typeof (a as StoredAttachment).blobPath === 'string',
    );
  } catch {
    return [];
  }
}

/** Pending input for a thread, oldest first. Synchronous so dispatch can reserve atomically. */
export function pendingQueue(db: NovaDatabase, threadId: string): QueuedRow[] {
  return (
    db.raw
      .prepare(
        `SELECT * FROM queued_input WHERE thread_id = ? AND status = 'pending'
         ORDER BY created_at, id`,
      )
      .all(threadId) as unknown as RawQueued[]
  ).map(fromRaw);
}

export function nextQueued(db: NovaDatabase, threadId: string): QueuedRow | null {
  const r = db.raw
    .prepare(
      `SELECT * FROM queued_input WHERE thread_id = ? AND status = 'pending'
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(threadId) as RawQueued | undefined;
  return r ? fromRaw(r) : null;
}

/** Threads that have pending input (startup recovery). */
export function threadsWithQueue(db: NovaDatabase): string[] {
  return (
    db.raw
      .prepare(
        "SELECT DISTINCT thread_id AS id FROM queued_input WHERE status = 'pending' ORDER BY id",
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

export function queueViews(db: NovaDatabase, threadId: string): QueuedInputView[] {
  return pendingQueue(db, threadId).map((q, i) => ({
    id: q.id,
    threadId: q.threadId,
    text: q.text,
    attachmentCount: q.attachments.length,
    position: i + 1,
    createdAt: q.createdAt,
  }));
}

/** 1-based position of a pending item. */
export function queuePosition(db: NovaDatabase, threadId: string, id: string): number {
  const ids = pendingQueue(db, threadId).map((q) => q.id);
  return ids.indexOf(id) + 1;
}

/**
 * Mark a pending item cancelled and drop its attachment list (the blobs are collected by the
 * caller). `not_found` when it does not exist or already started.
 */
export function cancelQueued(
  db: NovaDatabase,
  threadId: string,
  id: string,
  now: string,
): StoredAttachment[] {
  const row = db.raw
    .prepare("SELECT * FROM queued_input WHERE id = ? AND thread_id = ? AND status = 'pending'")
    .get(id, threadId) as RawQueued | undefined;
  if (!row) throw new NovaError('not_found', 'queued message not found or already started');
  db.raw
    .prepare(
      "UPDATE queued_input SET status = 'cancelled', attachments = NULL, updated_at = ? WHERE id = ?",
    )
    .run(now, id);
  return parseAttachments(row.attachments);
}
