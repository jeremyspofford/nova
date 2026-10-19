// Approvals (FR-111, FR-077; docs/04 §2.6, docs/13 §5): every approval waiting for you, across
// chats, Work runs, Code sessions and agents, on one page that works at phone width. Each is the
// same card as in its conversation (src/chat/ApprovalCard.tsx), with the same six decisions; the
// first answer from any device wins, and a card answered elsewhere says so. Each says where it
// comes from (its run, Code session or conversation title, as the Hub fills them) and links there.
// `?focus=<id>` puts one approval first and focuses it (an approval with no conversation opens
// here). New task starts a Work run or Code session from the phone.
// Updates arrive live on the shared event stream.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Icon, Spinner, type IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
import { awaitsUser, type ClientApproval } from '../chat/thread-state.ts';
import { sessionPath } from '../code/labels.ts';
import { useHubStream } from '../hub-events.ts';
import { chatPath, useLocation } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { runPath } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { NewTaskSheet } from './NewTaskSheet.tsx';
import '../workspace.css';
import './dispatch.css';

export const APPROVALS_PATH = '/approvals';

/** The events that change what waits (contracts/events.md, approvals). */
export const APPROVAL_EVENTS = [
  'approval.requested',
  'approval.decided',
  'approval.cancelled',
  'approval.handoff_done',
] as const;

export interface Where {
  icon: IconName;
  text: string;
  href: string | null;
}

/**
 * Where an approval comes from, and where to see it in context, from the fields the Hub fills on
 * every approval (`runId`, `codeSessionId`, `threadTitle`).
 */
export function whereOf(a: ClientApproval): Where {
  if (!a.threadId) return { icon: 'shield', text: 'Not part of a conversation', href: null };
  const inThread = `${chatPath(a.threadId)}?approval=${encodeURIComponent(a.id)}`;
  const title = a.threadTitle?.trim() || 'Untitled';
  if (a.runId) return { icon: 'work', text: `Work run: ${title}`, href: runPath(a.runId) };
  if (a.codeSessionId)
    return { icon: 'code', text: `Code session: ${title}`, href: sessionPath(a.codeSessionId) };
  if (a.threadTitle?.trim()) return { icon: 'chat', text: `Chat: ${title}`, href: inThread };
  return { icon: 'chat', text: 'In a conversation', href: inThread };
}

/** Oldest first, with the focused one on top. */
export function orderApprovals(items: ClientApproval[], focus: string | null): ClientApproval[] {
  return [...items].sort(
    (a, b) =>
      Number(b.id === focus) - Number(a.id === focus) || a.createdAt.localeCompare(b.createdAt),
  );
}

function focusOf(loc: string): string | null {
  const q = loc.indexOf('?');
  const id = q < 0 ? null : new URLSearchParams(loc.slice(q + 1)).get('focus');
  return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

export function ApprovalsPage() {
  const { api } = useServices();
  const announce = useAnnounce();
  const loc = useLocation();
  const focus = focusOf(loc);
  const [items, setItems] = useState<ClientApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusNote, setFocusNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);

  const latest = useRef<ClientApproval[] | null>(null);
  useEffect(() => {
    latest.current = items;
  });
  useEffect(() => {
    let alive = true;
    api.listApprovals({ status: 'pending' }).then(
      ({ items: pending }) => {
        if (!alive) return;
        const prev = latest.current;
        const fresh = new Set(pending.map((a) => a.id));
        const known = new Map((prev ?? []).map((a) => [a.id, a]));
        // Cards answered here stay (with their outcome) until the page is left.
        const kept = (prev ?? []).filter((a) => a.answeredHere && !fresh.has(a.id));
        const arrived = prev ? pending.find((a) => !known.has(a.id)) : undefined;
        const next = [...pending.map((a) => ({ ...known.get(a.id), ...a })), ...kept];
        latest.current = next;
        setItems(next);
        setError(null);
        if (arrived) announce(`New approval: ${arrived.action}.`);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load approvals.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version, announce]);

  // A focused approval that is not waiting any more: say what happened to it.
  const focusPending = !!focus && !!items?.some((a) => a.id === focus);
  const loaded = items !== null;
  const checked = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || !loaded || focusPending || checked.current === focus) return;
    checked.current = focus;
    let alive = true;
    api.getApproval(focus).then(
      (a) => {
        if (!alive) return;
        if (awaitsUser(a)) setItems((prev) => [...(prev ?? []), a]);
        else setFocusNote('That approval was already answered.');
      },
      (err: unknown) =>
        alive &&
        setFocusNote(
          err instanceof ApiError && err.status === 404
            ? 'That approval no longer exists.'
            : errorMessage(err, 'Could not load that approval.'),
        ),
    );
    return () => {
      alive = false;
    };
  }, [api, focus, focusPending, loaded]);

  const reload = useDebounced(() => setVersion((v) => v + 1), 150);
  useHubStream(APPROVAL_EVENTS, reload, reload);

  const update = useCallback((view: ClientApproval) => {
    setItems((prev) => prev?.map((a) => (a.id === view.id ? { ...a, ...view } : a)) ?? prev);
  }, []);

  const shown = items ? orderApprovals(items, focus) : null;
  const waiting = shown?.filter(awaitsUser).length ?? 0;

  return (
    <div className="ws-page dispatch-page">
      <header className="ws-page-header">
        <h1>Approvals</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New task
        </Button>
      </header>
      <p className="muted ws-flush">
        Actions waiting for your decision, from every chat, run, Code session and agent. Answer here
        or in the conversation; the first answer from any device counts.
      </p>
      {focusNote ? (
        <p className="ws-warning" role="status">
          <Icon name="alert" /> {focusNote}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {shown === null && !error ? <Spinner label="Loading approvals" /> : null}
      {shown?.length === 0 ? (
        <EmptyState
          title="Nothing is waiting for you"
          description="When a run, a Code session, a chat or an agent needs your decision, it shows here, and on devices with notifications on."
          icon="shield"
          level={2}
          action={<Button onClick={() => setCreating(true)}>Start a task</Button>}
        />
      ) : null}
      {shown?.length ? (
        <>
          <p className="muted ws-flush" aria-live="polite">
            {waiting === 0
              ? 'All answered.'
              : waiting === 1
                ? '1 approval is waiting.'
                : `${waiting} approvals are waiting.`}
          </p>
          <ul className="dispatch-list" aria-label="Approvals">
            {shown.map((a) => {
              const where = whereOf(a);
              return (
                <li key={a.id} className="dispatch-item" data-focused={a.id === focus || undefined}>
                  <p className="dispatch-where">
                    <Icon name={where.icon} />
                    {where.href ? (
                      <a href={where.href} onClick={(e) => followLink(e, where.href ?? '/')}>
                        {where.text}
                      </a>
                    ) : (
                      <span>{where.text}</span>
                    )}
                    <span className="muted">Asked {formatWhen(a.createdAt)}</span>
                  </p>
                  <ApprovalCard approval={a} onChange={update} focusKey={a.id === focus ? 1 : 0} />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <NewTaskSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
