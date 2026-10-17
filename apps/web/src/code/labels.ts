// Text for Code sessions shared by the list and the session view (FR-061, FR-215).
import type { CodeSessionView, DerivedStatus, EnvironmentView } from '@nova/shared';
import { baseName } from '../files/types.ts';

export function sessionTitle(s: Pick<CodeSessionView, 'title' | 'folder'>): string {
  return s.title || baseName(s.folder.path) || 'Code session';
}

/** "main", "main, uncommitted changes", or why there is no branch. */
export function branchText(repo: CodeSessionView['repo']): string {
  if (!repo) return 'Not a Git repository';
  const branch = repo.branch ?? 'Detached HEAD';
  return repo.dirty ? `${branch}, uncommitted changes` : branch;
}

/** docs/04 §1.1: Needs input first, then Blocked, Running, Ready; newest first within each. */
const RANK: Record<DerivedStatus, number> = { needs_input: 0, blocked: 1, running: 2, ready: 3 };

export function sortSessions(list: readonly CodeSessionView[]): CodeSessionView[] {
  return [...list].sort(
    (a, b) =>
      RANK[a.derived.status] - RANK[b.derived.status] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export const ENV_STATUS_TEXT: Record<EnvironmentView['status'], string> = {
  ok: 'Ready',
  degraded: 'Degraded',
  down: 'Unavailable',
  unknown: 'Not checked',
};

export function environmentLabel(env: EnvironmentView): string {
  return env.status === 'ok' ? env.label : `${env.label} (${ENV_STATUS_TEXT[env.status]})`;
}

export function sessionPath(id: string | null): string {
  return id ? `/code/${encodeURIComponent(id)}` : '/code';
}
