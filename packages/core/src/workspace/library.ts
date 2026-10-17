// The Library (FR-041): one paged, searchable list of what the account has in Nova, newest
// first: artifacts (`file` artifacts as files), chat attachments (images on their own) and
// uploaded project sources. Files of project folders are not listed; they stay on disk and are
// browsed in the file browser. Temporary and deleted chats contribute nothing. Every item links
// to where it opens in the app: its chat message, the artifact pane or the project page.
import { NovaError, type LibraryItemView, type LibraryKind, type Page } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

export interface LibraryQuery {
  kind?: LibraryKind | undefined;
  /** Matches titles, case-insensitively. */
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

interface LibraryRow {
  kind: LibraryKind;
  id: string;
  title: string;
  mime: string | null;
  size: number | null;
  threadId: string | null;
  projectId: string | null;
  messageId: string | null;
  createdAt: string;
}

const ITEMS = `
  SELECT CASE WHEN a.kind = 'file' THEN 'file' ELSE 'artifact' END AS kind, a.id AS id,
    COALESCE(NULLIF(a.title, ''), a.kind) AS title, a.mime AS mime, v.size AS size,
    a.thread_id AS threadId, t.project_id AS projectId, a.message_id AS messageId,
    a.created_at AS createdAt
  FROM artifact a
  LEFT JOIN thread t ON t.id = a.thread_id
  LEFT JOIN artifact_version v ON v.artifact_id = a.id AND v.version = a.version
  WHERE a.account_id = :account
    AND (a.thread_id IS NULL OR (t.deleted_at IS NULL AND t.temporary = 0))
  UNION ALL
  SELECT CASE WHEN lower(COALESCE(x.mime, '')) LIKE 'image/%' THEN 'image' ELSE 'attachment' END,
    x.id, x.name, x.mime, x.size, t.id, t.project_id, x.message_id, x.created_at
  FROM attachment x
  LEFT JOIN message m ON m.id = x.message_id
  JOIN thread t ON t.id = COALESCE(x.thread_id, m.thread_id)
  WHERE t.account_id = :account AND t.deleted_at IS NULL AND t.temporary = 0
    AND m.deleted_at IS NULL
  UNION ALL
  SELECT 'source', s.id, s.name, s.mime, s.size, NULL, s.project_id, NULL, s.created_at
  FROM source s
  JOIN project p ON p.id = s.project_id
  WHERE s.account_id = :account AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM project_folder_file f WHERE f.source_id = s.id)`;

export class LibraryService {
  readonly #db: NovaDatabase;

  constructor(opts: { db: NovaDatabase }) {
    this.#db = opts.db;
  }

  list(accountId: string, query: LibraryQuery = {}): Promise<Page<LibraryItemView>> {
    try {
      return Promise.resolve(this.#list(accountId, query));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #list(accountId: string, query: LibraryQuery): Page<LibraryItemView> {
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
    const where: string[] = [];
    const params: Record<string, string | number> = { account: accountId, limit: limit + 1 };
    if (query.kind) {
      where.push('kind = :kind');
      params.kind = query.kind;
    }
    const q = query.q?.trim();
    if (q) {
      where.push("title LIKE :q ESCAPE '\\'");
      params.q = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      where.push('(createdAt < :cAt OR (createdAt = :cAt AND id < :cId))');
      params.cAt = c.createdAt;
      params.cId = c.id;
    }
    const sql = `SELECT * FROM (${ITEMS}) ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY createdAt DESC, id DESC LIMIT :limit`;
    const rows = this.#db.raw.prepare(sql).all(params) as unknown as LibraryRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }
}

function toItem(r: LibraryRow): LibraryItemView {
  return {
    kind: r.kind,
    id: r.id,
    title: r.title,
    mime: r.mime,
    size: r.size,
    threadId: r.threadId,
    projectId: r.projectId,
    href: hrefOf(r),
    createdAt: r.createdAt,
  };
}

/** Where an item opens: its message in the chat, the artifact pane, or the project page. */
export function hrefOf(
  r: Pick<LibraryRow, 'kind' | 'id' | 'threadId' | 'projectId' | 'messageId'>,
): string {
  const e = encodeURIComponent;
  if (r.kind === 'source') return `/projects/${e(r.projectId ?? '')}?source=${e(r.id)}`;
  if (r.kind === 'artifact' || r.kind === 'file') {
    if (!r.threadId) return `/library?artifact=${e(r.id)}`;
    const m = r.messageId ? `m=${e(r.messageId)}&` : '';
    return `/chat/${e(r.threadId)}?${m}artifact=${e(r.id)}`;
  }
  const base = `/chat/${e(r.threadId ?? '')}`;
  return r.messageId ? `${base}?m=${e(r.messageId)}` : base;
}

function encodeCursor(r: LibraryRow): string {
  return Buffer.from(JSON.stringify([r.createdAt, r.id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
      return { createdAt: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'invalid cursor');
}
