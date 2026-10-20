// Code mode navigation (docs/04 §2.4): Sessions, Environments (FR-062) and Worktrees (FR-073),
// the three lists of Code mode, as links that keep the browser's own behaviour for modified
// clicks. /code/environments and /code/worktrees use the id slot of the Code route, as
// /work/scheduled does for Work.
import type { MouseEvent, ReactNode } from 'react';
import { defineMessages } from '@nova/i18n';
import { navigate } from '../router.ts';

export const NAV_TEXT = defineMessages('code.nav', {
  sections: 'Code sections',
  sessions: 'Sessions',
  environments: 'Environments',
  worktrees: 'Worktrees',
});

export const ENVIRONMENTS_PATH = '/code/environments';
export const WORKTREES_PATH = '/code/worktrees';
/** Ids of the Code route that are pages, not sessions. */
export const CODE_PAGES = ['environments', 'worktrees'] as const;

export function CodeNav({ current }: { current: 'sessions' | 'environments' | 'worktrees' }) {
  const link = (path: string, label: string, here: boolean) => (
    <a
      href={path}
      className="code-tab"
      aria-current={here ? 'page' : undefined}
      onClick={(e) => followLink(e, path)}
    >
      {label}
    </a>
  );
  return (
    <nav className="code-tabs" aria-label={NAV_TEXT.sections}>
      {link('/code', NAV_TEXT.sessions, current === 'sessions')}
      {link(ENVIRONMENTS_PATH, NAV_TEXT.environments, current === 'environments')}
      {link(WORKTREES_PATH, NAV_TEXT.worktrees, current === 'worktrees')}
    </nav>
  );
}

/** Opens an in-app link (modified clicks keep the browser's behaviour). */
export function followLink(e: MouseEvent, path: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(path);
}

/** An in-app link. */
export function AppLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={to} className={className} onClick={(e) => followLink(e, to)}>
      {children}
    </a>
  );
}
