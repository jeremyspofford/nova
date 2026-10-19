// The tray and quick overlay status list (FR-008, FR-215, docs/04 §1.1): every chat, Work run, Code
// session and agent with the one status the Hub derived, Needs input first, then Blocked, Running
// and Ready, most recent first within a group. The shell never derives a status itself.
import type { DerivedStatus, ShellStatusItemView } from '@nova/shared';
import type { StatusSources } from './hub-client.ts';

export const STATUS_LABEL: Record<DerivedStatus, string> = {
  needs_input: 'Needs input',
  blocked: 'Blocked',
  running: 'Running',
  ready: 'Ready',
};

const RANK: Record<DerivedStatus, number> = { needs_input: 0, blocked: 1, running: 2, ready: 3 };

function lastPart(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The merged, sorted list; at most `limit` rows. */
export function statusItems(src: StatusSources, limit = 8): ShellStatusItemView[] {
  const items: ShellStatusItemView[] = [];
  for (const t of src.threads) {
    // A run's or session's own thread is listed as the run or the session.
    if (t.archived || t.temporary || t.side || t.runId || t.codeSessionId || t.mode !== 'chat')
      continue;
    items.push({
      kind: 'thread',
      id: t.id,
      title: t.title ?? 'New chat',
      status: t.derived?.status ?? 'ready',
      reason: t.derived?.reason ?? null,
      path: `/chat/${encodeURIComponent(t.id)}`,
      updatedAt: t.updatedAt,
    });
  }
  for (const r of src.runs) {
    if (r.parentRunId) continue;
    items.push({
      kind: 'run',
      id: r.id,
      title: r.title,
      status: r.derived.status,
      reason: r.derived.reason,
      path: `/work/${encodeURIComponent(r.id)}`,
      updatedAt: r.updatedAt,
    });
  }
  for (const s of src.sessions) {
    items.push({
      kind: 'session',
      id: s.id,
      title: s.title ?? lastPart(s.folder.path),
      status: s.derived.status,
      reason: s.derived.reason,
      path: `/code/${encodeURIComponent(s.id)}`,
      updatedAt: s.updatedAt,
    });
  }
  for (const a of src.agents) {
    items.push({
      kind: 'agent',
      id: a.id,
      title: a.name,
      status: a.derived.status,
      reason: a.derived.reason,
      path: `/agents/${encodeURIComponent(a.id)}`,
      updatedAt: a.updatedAt,
    });
  }
  items.sort(
    (a, b) => RANK[a.status] - RANK[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  return items.slice(0, limit);
}

/** The tray tooltip: what needs the user, in a few words. */
export function statusSummary(items: readonly ShellStatusItemView[]): string {
  const needs = items.filter((i) => i.status === 'needs_input').length;
  const blocked = items.filter((i) => i.status === 'blocked').length;
  const parts: string[] = [];
  if (needs) parts.push(`${needs} ${needs === 1 ? 'needs' : 'need'} input`);
  if (blocked) parts.push(`${blocked} blocked`);
  return parts.length ? `Nova: ${parts.join(', ')}` : 'Nova';
}

const KIND_LABEL: Record<ShellStatusItemView['kind'], string> = {
  thread: 'Chat',
  run: 'Work run',
  session: 'Code',
  agent: 'Agent',
};

/** One tray menu row: status first, as the overlay shows it (docs/04 §1.1). */
export function statusMenuLabel(item: ShellStatusItemView): string {
  const title = item.title.length > 40 ? `${item.title.slice(0, 39)}…` : item.title;
  const detail = item.reason ?? KIND_LABEL[item.kind];
  return `${STATUS_LABEL[item.status]}: ${title} (${detail})`;
}
