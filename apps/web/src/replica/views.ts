// The offline copy as the Hub's own views (FR-109, FR-112): chats, a chat's messages, projects,
// spaces and pages built from the copy, with this device's changes that wait to send laid over
// them, so the app's views render while the Hub is unreachable exactly as they do online. What
// the copy does not carry (a chat's model, a page's version, a space's name) comes from the last
// answer this page saw, when there is one. Messages written here wait in the chat's queue strip
// until the Hub has them, as queued follow-ups do.
import {
  SYNC_TOMBSTONE,
  THREAD_MODES,
  type MessageView,
  type Page,
  type PageSummaryView,
  type PageView,
  type PartView,
  type ProjectView,
  type QueuedInputView,
  type SpaceView,
  type SyncKind,
  type ThreadDetail,
  type ThreadMode,
  type ThreadView,
} from '@nova/shared';
import type { QueueItem } from '../offline/queue.ts';
import { hlcMs } from './hlc.ts';
import type { Entity, Replica } from './replica.ts';

/** Richer views from the last answers this page saw (src/offline/reads.ts keeps them). */
export interface ViewHints {
  thread(id: string): ThreadView | null;
  project(id: string): ProjectView | null;
  space(id: string): SpaceView | null;
  spaces(): SpaceView[];
  page(id: string): PageSummaryView | null;
  /** The Hub's own queued follow-ups of a chat, as last seen. */
  queue(threadId: string): QueuedInputView[];
}

export interface ViewSource {
  replica: Replica;
  /** Changes made here that the Hub does not have yet (queued, sending or failed). */
  pending: readonly QueueItem[];
  hints: ViewHints;
}

const EPOCH = new Date(0).toISOString();

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

/** The values this device would see: the copy's, then its own waiting changes in order. */
export function currentFields(src: ViewSource, kind: SyncKind, id: string) {
  const e = src.replica.entity(kind, id);
  const out: Record<string, unknown> = {};
  if (e) for (const [k, f] of Object.entries(e.fields)) out[k] = f.value;
  let touched = !!e;
  for (const item of src.pending)
    for (const op of item.ops)
      if (op.kind === kind && op.id === id && op.field !== SYNC_TOMBSTONE) {
        out[op.field] = op.value;
        touched = true;
      }
  return touched ? out : null;
}

function newestMs(e: Entity | null): number | null {
  if (!e) return null;
  let max: number | null = null;
  for (const f of Object.values(e.fields)) {
    const t = hlcMs(f.hlc);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

const later = (...isos: (string | null | undefined)[]) =>
  isos.filter((v): v is string => !!v).reduce((a, b) => (a > b ? a : b), EPOCH);

// ---- messages -------------------------------------------------------------------------------------

interface MessageBody {
  threadId: string;
  role: string;
  text: string;
  parentId: string | null;
  status: string;
  model: string | null;
  files: { attachmentId: string; name: string; mime: string | null; size: number }[];
  createdAt: string | null;
  /** `offline`: an answer a device's own model wrote (FR-128). */
  provenance: string | null;
}

function bodyOf(e: Entity): MessageBody | null {
  const b = e.fields.body?.value;
  if (typeof b !== 'object' || b === null) return null;
  const r = b as Record<string, unknown>;
  const threadId = str(r.threadId);
  if (!threadId) return null;
  return {
    threadId,
    role: str(r.role) ?? 'user',
    text: str(r.text) ?? '',
    parentId: str(r.parentId),
    status: str(r.status) ?? 'complete',
    model: str(r.model),
    files: Array.isArray(r.files)
      ? (r.files as MessageBody['files']).filter((f) => typeof f.attachmentId === 'string')
      : [],
    createdAt: str(r.createdAt),
    provenance: str(r.provenance),
  };
}

const ROLES = new Set(['user', 'assistant', 'system', 'tool', 'summary']);
const STATUSES = new Set(['complete', 'incomplete', 'error']);

function messageView(e: Entity, b: MessageBody): MessageView {
  const parts: PartView[] = [];
  if (b.text) parts.push({ type: 'text', text: b.text });
  for (const f of b.files)
    parts.push({
      type: 'file',
      attachmentId: f.attachmentId,
      name: f.name,
      mime: f.mime ?? 'application/octet-stream',
      size: f.size,
    });
  return {
    id: e.id,
    threadId: b.threadId,
    turnId: null,
    role: (ROLES.has(b.role) ? b.role : 'user') as MessageView['role'],
    status: (STATUSES.has(b.status) ? b.status : 'complete') as MessageView['status'],
    parts,
    model: b.model,
    usage: null,
    createdAt: b.createdAt ?? iso(newestMs(e)) ?? EPOCH,
    parentId: b.parentId,
    // An answer from a device's model, or a user message a device wrote offline and synced.
    ...(b.role === 'assistant' && b.provenance === 'offline'
      ? { provenance: 'offline' as const }
      : b.role === 'user' && e.fields.body?.deviceId
        ? { provenance: 'sync' as const }
        : {}),
  };
}

/** Every message of every chat in the copy, grouped by chat. */
function messagesByThread(replica: Replica): Map<string, MessageView[]> {
  const out = new Map<string, MessageView[]>();
  for (const e of replica.list('message')) {
    const b = bodyOf(e);
    if (!b) continue;
    const list = out.get(b.threadId) ?? [];
    list.push(messageView(e, b));
    out.set(b.threadId, list);
  }
  return out;
}

/**
 * The active path of a chat: from its newest message back through its parents, oldest first.
 * (The Hub keeps which version is active; the copy does not, so the newest one is shown.)
 */
export function activePath(messages: readonly MessageView[]): MessageView[] {
  if (!messages.length) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const newest = [...messages].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )[0]!;
  const path: MessageView[] = [];
  const seen = new Set<string>();
  let cur: MessageView | undefined = newest;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

// ---- chats ------------------------------------------------------------------------------------------

function isMode(v: unknown): v is ThreadMode {
  return typeof v === 'string' && (THREAD_MODES as readonly string[]).includes(v);
}

export function threadView(
  src: ViewSource,
  id: string,
  lastMessageAt: string | null = null,
): ThreadView | null {
  const e = src.replica.entity('thread', id);
  const creating = src.pending.find((i) => i.kind === 'chat' && i.entityId === id);
  if (!e && !creating) return null;
  const f = currentFields(src, 'thread', id) ?? {};
  const hint = src.hints.thread(id);
  const own = src.pending.filter((i) => i.threadId === id || i.entityId === id);
  return {
    id,
    mode: isMode(f.mode) ? f.mode : (hint?.mode ?? 'chat'),
    title: str(f.title),
    projectId: str(f.project),
    pinned: f.pinned === true,
    archived: f.archived === true,
    unread: false,
    temporary: false,
    state: 'idle',
    model: hint?.model ?? null,
    reasoningLevel: hint?.reasoningLevel ?? null,
    parentThreadId: hint?.parentThreadId ?? null,
    branchFromMessageId: hint?.branchFromMessageId ?? null,
    side: false,
    memoryOptOut: hint?.memoryOptOut ?? false,
    runId: hint?.runId ?? null,
    codeSessionId: hint?.codeSessionId ?? null,
    createdAt: str(f.createdAt) ?? creating?.createdAt ?? hint?.createdAt ?? EPOCH,
    updatedAt: later(
      iso(newestMs(e)),
      lastMessageAt,
      hint?.updatedAt,
      ...own.map((i) => i.createdAt),
    ),
  };
}

export interface ThreadQuery {
  mode?: string;
  archived?: boolean;
  projectId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/** `GET /api/v1/threads` from the copy (the Hub's filters and order; one page, no cursor). */
export function threadList(src: ViewSource, q: ThreadQuery): Page<ThreadView> {
  if (q.cursor) return { items: [], nextCursor: null };
  const messages = messagesByThread(src.replica);
  const ids = new Set(src.replica.list('thread').map((e) => e.id));
  for (const i of src.pending) if (i.kind === 'chat') ids.add(i.entityId);
  const needle = q.q?.trim().toLowerCase() ?? '';
  const items: ThreadView[] = [];
  for (const id of ids) {
    const msgs = messages.get(id) ?? [];
    const last = msgs.reduce<string | null>(
      (a, m) => (a && a > m.createdAt ? a : m.createdAt),
      null,
    );
    const v = threadView(src, id, last);
    if (!v || v.archived !== (q.archived ?? false)) continue;
    if (q.mode && v.mode !== q.mode) continue;
    if (q.projectId && v.projectId !== q.projectId) continue;
    if (
      needle &&
      !(v.title ?? '').toLowerCase().includes(needle) &&
      !msgs.some((m) =>
        m.parts.some((p) => p.type === 'text' && p.text.toLowerCase().includes(needle)),
      )
    )
      continue;
    items.push(v);
  }
  items.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.id.localeCompare(a.id),
  );
  return { items: items.slice(0, Math.min(200, Math.max(1, q.limit ?? 50))), nextCursor: null };
}

/** The chat's messages written here that wait for the Hub, as the queue strip shows them. */
export function pendingQueue(src: ViewSource, threadId: string): QueuedInputView[] {
  const hub = src.hints.queue(threadId);
  const mine = src.pending
    .filter((i) => i.kind === 'message' && i.threadId === threadId)
    .map((i, n) => ({
      id: i.entityId,
      threadId,
      text: i.text ?? '',
      attachmentCount: 0,
      position: hub.length + n + 1,
      createdAt: i.createdAt,
    }));
  return [...hub, ...mine];
}

/** `GET /api/v1/threads/:id` from the copy, or null when the copy does not have the chat. */
export function threadDetail(src: ViewSource, id: string): ThreadDetail | null {
  const msgs = messagesByThread(src.replica).get(id) ?? [];
  const path = activePath(msgs);
  const thread = threadView(src, id, path.at(-1)?.createdAt ?? null);
  if (!thread) return null;
  return { thread, messages: path, queue: pendingQueue(src, id) };
}

/** A chat's active path as plain turns, for a model on this computer (FR-128). */
export function threadTranscript(src: ViewSource, id: string): MessageView[] {
  return activePath(messagesByThread(src.replica).get(id) ?? []);
}

// ---- projects ---------------------------------------------------------------------------------------

export function projectView(src: ViewSource, id: string, threadCount?: number): ProjectView | null {
  const e = src.replica.entity('project', id);
  if (!e) return null;
  const f = currentFields(src, 'project', id) ?? {};
  const hint = src.hints.project(id);
  const count =
    threadCount ??
    threadList(src, { projectId: id, limit: 200 }).items.filter((t) => t.mode === 'chat').length;
  return {
    id,
    name: str(f.name) ?? hint?.name ?? 'Project',
    instructions: str(f.instructions),
    memoryScope: hint?.memoryScope ?? 'shared',
    threadCount: count,
    sourceCount: hint?.sourceCount ?? 0,
    createdAt: str(f.createdAt) ?? hint?.createdAt ?? EPOCH,
    updatedAt: later(iso(newestMs(e)), hint?.updatedAt),
  };
}

export function projectList(src: ViewSource): ProjectView[] {
  const counts = new Map<string, number>();
  for (const t of threadList(src, { limit: 200 }).items)
    if (t.projectId) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  return src.replica
    .list('project')
    .map((e) => projectView(src, e.id, counts.get(e.id) ?? 0))
    .filter((p): p is ProjectView => p !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

// ---- spaces and pages -------------------------------------------------------------------------------

function pagesOf(src: ViewSource, spaceId: string): Entity[] {
  return src.replica.list('page').filter((e) => e.fields.space?.value === spaceId);
}

const UNNAMED_SPACE = 'Unnamed space';

export function spaceView(src: ViewSource, id: string): SpaceView | null {
  const pages = pagesOf(src, id);
  const e = src.replica.entity('space', id);
  const f = currentFields(src, 'space', id) ?? {};
  const hint = src.hints.space(id);
  if (!e && !hint && !pages.length) return null;
  return {
    id,
    name: str(f.name) ?? hint?.name ?? UNNAMED_SPACE,
    description: hint?.description ?? null,
    projectId: hint?.projectId ?? null,
    agentEdits: hint?.agentEdits ?? 'propose',
    pageCount: pages.length,
    createdAt: str(f.createdAt) ?? hint?.createdAt ?? EPOCH,
    updatedAt: later(iso(newestMs(e)), hint?.updatedAt, ...pages.map((p) => iso(newestMs(p)))),
  };
}

export function spaceList(src: ViewSource): SpaceView[] {
  const ids = new Set(src.hints.spaces().map((s) => s.id));
  for (const s of src.replica.list('space')) ids.add(s.id);
  for (const p of src.replica.list('page')) {
    const s = str(p.fields.space?.value);
    if (s) ids.add(s);
  }
  return [...ids]
    .map((id) => spaceView(src, id))
    .filter((s): s is SpaceView => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${s || 'page'}.html`;
}

export function pageView(src: ViewSource, spaceId: string, pageId: string): PageView | null {
  const e = src.replica.entity('page', pageId);
  if (!e || e.fields.space?.value !== spaceId) return null;
  const f = currentFields(src, 'page', pageId) ?? {};
  const hint = src.hints.page(pageId);
  const title = str(f.title) ?? hint?.title ?? 'Untitled';
  const waiting = src.pending.filter((i) => i.kind === 'page' && i.entityId === pageId).length;
  const synced = typeof f.version === 'number' ? f.version : null;
  return {
    id: pageId,
    spaceId,
    title,
    slug: hint?.slug ?? slug(title),
    position: hint?.position ?? 0,
    version: (synced ?? hint?.version ?? 1) + waiting,
    updatedBy: hint?.updatedBy ?? 'user',
    openComments: hint?.openComments ?? 0,
    openProposals: hint?.openProposals ?? 0,
    createdAt: str(f.createdAt) ?? hint?.createdAt ?? EPOCH,
    updatedAt: later(iso(newestMs(e)), hint?.updatedAt),
    content: str(f.content) ?? '',
  };
}

export function pageList(src: ViewSource, spaceId: string): PageSummaryView[] {
  return pagesOf(src, spaceId)
    .map((e) => pageView(src, spaceId, e.id))
    .filter((p): p is PageView => p !== null)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .map(({ content: _content, ...summary }) => summary);
}

// ---- labels -----------------------------------------------------------------------------------------

function clip(s: string, n = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** A short name for an entity of the copy (the merge log, queue labels), or null. */
export function entityName(replica: Replica | null, kind: SyncKind, id: string): string | null {
  const e = replica?.entity(kind, id);
  if (!e) return kind === 'setting' ? id : null;
  const v = (f: string) => str(e.fields[f]?.value);
  switch (kind) {
    case 'thread':
      return v('title') ? clip(v('title')!) : null;
    case 'project':
      return v('name');
    case 'page':
      return v('title');
    case 'space':
      return v('name');
    case 'memory':
      return v('content') ? clip(v('content')!) : null;
    case 'schedule':
      return v('title');
    case 'setting':
      return id;
    case 'message': {
      const b = bodyOf(e);
      return b?.text ? clip(b.text) : null;
    }
  }
}
