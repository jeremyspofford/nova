// Text for Code sessions shared by the list and the session view (FR-061, FR-215).
import { defineMessages } from '@nova/i18n';
import type { CodeSessionView, DerivedStatus, EnvironmentView } from '@nova/shared';
import { baseName } from '../files/types.ts';

export const LABEL_TEXT = defineMessages('code.labels', {
  untitled: 'Code session',
  notRepo: 'Not a Git repository',
  detached: 'Detached HEAD',
  dirty: '{branch}, uncommitted changes',
  /** An environment that is not ready: "Build box (Degraded)". */
  envWithStatus: '{name} ({status})',
});

export function sessionTitle(s: Pick<CodeSessionView, 'title' | 'folder'>): string {
  return s.title || baseName(s.folder.path) || LABEL_TEXT.untitled;
}

/** "main", "main, uncommitted changes", or why there is no branch. */
export function branchText(repo: CodeSessionView['repo']): string {
  if (!repo) return LABEL_TEXT.notRepo;
  const branch = repo.branch ?? LABEL_TEXT.detached;
  return repo.dirty ? LABEL_TEXT.dirty({ branch }) : branch;
}

/** docs/04 §1.1: Needs input first, then Blocked, Running, Ready; newest first within each. */
const RANK: Record<DerivedStatus, number> = { needs_input: 0, blocked: 1, running: 2, ready: 3 };

export function sortSessions(list: readonly CodeSessionView[]): CodeSessionView[] {
  return [...list].sort(
    (a, b) =>
      RANK[a.derived.status] - RANK[b.derived.status] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export const ENV_STATUS_TEXT = defineMessages('code.envStatus', {
  ok: 'Ready',
  degraded: 'Degraded',
  down: 'Unavailable',
  unknown: 'Not checked',
}) satisfies Record<EnvironmentView['status'], string>;

export function environmentLabel(env: EnvironmentView): string {
  return env.status === 'ok'
    ? env.label
    : LABEL_TEXT.envWithStatus({ name: env.label, status: ENV_STATUS_TEXT[env.status] });
}

export function sessionPath(id: string | null): string {
  return id ? `/code/${encodeURIComponent(id)}` : '/code';
}
