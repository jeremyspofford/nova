// Code mode (FR-061..FR-066, FR-069, FR-074; M6 FR-062, FR-073): /code lists the sessions,
// /code/environments the saved environments, /code/worktrees the worktree registry, and
// /code/:id is one session with its conversation, diff, review, terminal, files, pull request,
// checks, dev servers and other sessions. The workspace keeps this view mounted while another
// mode shows; it loads and follows events only while Code mode is on screen, and keeps the last
// session as it was (pending comments, terminals) until Code mode returns.
import { useState } from 'react';
import { useRoute } from '../router.ts';
import { EnvironmentsPage } from './EnvironmentsPage.tsx';
import { SessionList } from './SessionList.tsx';
import { SessionView } from './SessionView.tsx';
import { WorktreesPage } from './WorktreesPage.tsx';
import './code.css';

export function CodeView({ id }: { id: string | null }) {
  const route = useRoute();
  const visible = route.name === 'mode' && route.mode === 'code';
  // Nothing loads until Code mode is first opened.
  const [shown, setShown] = useState<{ id: string | null } | null>(visible ? { id } : null);
  if (visible && (!shown || shown.id !== id)) setShown({ id });
  if (!shown) return null;
  if (shown.id === 'environments') return <EnvironmentsPage visible={visible} />;
  if (shown.id === 'worktrees') return <WorktreesPage visible={visible} />;
  return shown.id ? (
    <SessionView key={shown.id} id={shown.id} visible={visible} />
  ) : (
    <SessionList visible={visible} />
  );
}
