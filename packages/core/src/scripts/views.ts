// A script run as the API shows it (FR-202): its record and the nested calls it made, which are
// tool calls whose parent is the script's own call.
import {
  NovaError,
  type ScriptRunView,
  type ScriptRunsPageView,
  type ToolCallStatus,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { afterTimeCursor, encodeTimeCursor } from '../time-cursor.ts';

interface RunRow {
  id: string;
  thread_id: string | null;
  turn_id: string | null;
  status: ScriptRunView['status'];
  error_code: string | null;
  calls: number;
  cpu_ms: number;
  code_sha256: string;
  created_at: string;
  ended_at: string | null;
}

interface CallRow {
  id: string;
  tool_name: string;
  status: ToolCallStatus;
  decision: string | null;
  approval_id: string | null;
  created_at: string;
  duration_ms: number | null;
}

export function scriptRunView(db: NovaDatabase, accountId: string, id: string): ScriptRunView {
  const r = db.raw
    .prepare('SELECT * FROM script_run WHERE id = ? AND account_id = ?')
    .get(id, accountId) as RunRow | undefined;
  if (!r) throw new NovaError('not_found', 'no such script run');
  const calls = db.raw
    .prepare(
      `SELECT id, tool_name, status, decision, approval_id, created_at, duration_ms FROM tool_call
       WHERE parent_call_id = ? AND account_id = ? ORDER BY created_at, id`,
    )
    .all(id, accountId) as unknown as CallRow[];
  return {
    ...listView(r),
    nested: calls.map((c) => ({
      callId: c.id,
      tool: c.tool_name,
      status: c.status,
      decision: c.decision,
      approvalId: c.approval_id,
      createdAt: c.created_at,
      durationMs: c.duration_ms,
    })),
  };
}

/** The script runs of a thread, newest first. */
export function scriptRunsOfThread(
  db: NovaDatabase,
  accountId: string,
  threadId: string,
): Omit<ScriptRunView, 'nested'>[] {
  return scriptRunsPage(db, accountId, { threadId, limit: 100 }).items;
}

/**
 * Script runs newest first, one thread's or the account's across threads (M7), `limit` at a
 * time. The cursor is the position after the previous page's last run (its time and id), so runs
 * sharing a timestamp at a page boundary are never skipped. Runs of deleted threads are left out.
 */
export function scriptRunsPage(
  db: NovaDatabase,
  accountId: string,
  q: { threadId?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
): ScriptRunsPageView {
  const where = ['s.account_id = ?', '(t.id IS NULL OR t.deleted_at IS NULL)'];
  const args: (string | number)[] = [accountId];
  if (q.threadId) {
    where.push('s.thread_id = ?');
    args.push(q.threadId);
  }
  if (q.cursor) {
    const after = afterTimeCursor(q.cursor, { at: 's.created_at', id: 's.id' });
    where.push(after.sql);
    args.push(...after.args);
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 200);
  const rows = db.raw
    .prepare(
      `SELECT s.* FROM script_run s LEFT JOIN thread t ON t.id = s.thread_id
       WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as unknown as RunRow[];
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(listView),
    nextCursor: rows.length > limit && last ? encodeTimeCursor(last.created_at, last.id) : null,
  };
}

function listView(r: RunRow): Omit<ScriptRunView, 'nested'> {
  return {
    id: r.id,
    threadId: r.thread_id,
    turnId: r.turn_id,
    status: r.status,
    errorCode: r.error_code,
    calls: r.calls,
    cpuMs: r.cpu_ms,
    codeSha256: r.code_sha256,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}
