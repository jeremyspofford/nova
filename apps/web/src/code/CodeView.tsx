// Code mode (FR-061..FR-066, FR-069, FR-074): /code lists the sessions, /code/:id is one session
// with its conversation, diff, review, terminal and files. The workspace keeps this view mounted
// while another mode shows; it loads and follows events only while Code mode is on screen, and
// keeps the last session as it was (pending comments, terminals) until Code mode returns.
import { useState } from 'react';
import { useRoute } from '../router.ts';
import { SessionList } from './SessionList.tsx';
import { SessionView } from './SessionView.tsx';
import './code.css';

export function CodeView({ id }: { id: string | null }) {
  const route = useRoute();
  const visible = route.name === 'mode' && route.mode === 'code';
  // Nothing loads until Code mode is first opened.
  const [shown, setShown] = useState<{ id: string | null } | null>(visible ? { id } : null);
  if (visible && (!shown || shown.id !== id)) setShown({ id });
  if (!shown) return null;
  return shown.id ? (
    <SessionView key={shown.id} id={shown.id} visible={visible} />
  ) : (
    <SessionList visible={visible} />
  );
}
