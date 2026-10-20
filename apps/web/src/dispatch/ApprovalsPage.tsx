// Approvals (FR-111, FR-077; docs/04 §2.6, docs/13 §5): every approval waiting for you, across
// chats, Work runs, Code sessions and agents, on one page that works at phone width. Each is the
// same card as in its conversation (src/chat/ApprovalCard.tsx), with the same six decisions; the
// first answer from any device wins, and a card answered elsewhere says so. Each says where it
// comes from (its run, Code session or conversation title, as the Hub fills them) and links there.
// `?focus=<id>` puts one approval first and focuses it (an approval with no conversation opens
// here). New task starts a Work run or Code session from the phone.
// Updates arrive live on the shared event stream.
import { useCallback, useEffect, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
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

/** The Approvals page's words (FR-016). Approval actions and conversation titles are Hub data. */
export const APPROVALS_TEXT = defineMessages('dispatch', {
  title: 'Approvals',
  newTask: 'New task',
  intro:
    'Actions waiting for your decision, from every chat, run, Code session and agent. Answer here ' +
    'or in the conversation; the first answer from any device counts.',
  retry: 'Retry',
  loading: 'Loading approvals',
  emptyTitle: 'Nothing is waiting for you',
  emptyDescription:
    'When a run, a Code session, a chat or an agent needs your decision, it shows here, and on ' +
    'devices with notifications on.',
  startTask: 'Start a task',
  waiting:
    '{n, plural, =0 {All answered.} one {# approval is waiting.} other {# approvals are waiting.}}',
  asked: 'Asked {when}',
  arrived: 'New approval: {action}.',
  loadFailed: 'Could not load approvals.',
  loadOneFailed: 'Could not load that approval.',
  alreadyAnswered: 'That approval was already answered.',
  gone: 'That approval no longer exists.',
  where: {
    none: 'Not part of a conversation',
    untitled: 'Untitled',
    run: 'Work run: {title}',
    code: 'Code session: {title}',
    chat: 'Chat: {title}',
    conversation: 'In a conversation',
  },
});

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
  const W = APPROVALS_TEXT.where;
  if (!a.threadId) return { icon: 'shield', text: W.none, href: null };
  const inThread = `${chatPath(a.threadId)}?approval=${encodeURIComponent(a.id)}`;
  const title = a.threadTitle?.trim() || W.untitled;
  if (a.runId) return { icon: 'work', text: W.run({ title }), href: runPath(a.runId) };
  if (a.codeSessionId)
    return { icon: 'code', text: W.code({ title }), href: sessionPath(a.codeSessionId) };
  if (a.threadTitle?.trim()) return { icon: 'chat', text: W.chat({ title }), href: inThread };
  return { icon: 'chat', text: W.conversation, href: inThread };
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
        if (arrived) announce(APPROVALS_TEXT.arrived({ action: arrived.action }));
      },
      (err: unknown) => alive && setError(errorMessage(err, APPROVALS_TEXT.loadFailed)),
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
        else setFocusNote(APPROVALS_TEXT.alreadyAnswered);
      },
      (err: unknown) =>
        alive &&
        setFocusNote(
          err instanceof ApiError && err.status === 404
            ? APPROVALS_TEXT.gone
            : errorMessage(err, APPROVALS_TEXT.loadOneFailed),
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
        <h1>{APPROVALS_TEXT.title}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {APPROVALS_TEXT.newTask}
        </Button>
      </header>
      <p className="muted ws-flush">{APPROVALS_TEXT.intro}</p>
      {focusNote ? (
        <p className="ws-warning" role="status">
          <Icon name="alert" /> {focusNote}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{APPROVALS_TEXT.retry}</Button>
        </div>
      ) : null}
      {shown === null && !error ? <Spinner label={APPROVALS_TEXT.loading} /> : null}
      {shown?.length === 0 ? (
        <EmptyState
          title={APPROVALS_TEXT.emptyTitle}
          description={APPROVALS_TEXT.emptyDescription}
          icon="shield"
          level={2}
          action={<Button onClick={() => setCreating(true)}>{APPROVALS_TEXT.startTask}</Button>}
        />
      ) : null}
      {shown?.length ? (
        <>
          <p className="muted ws-flush" aria-live="polite">
            {APPROVALS_TEXT.waiting({ n: waiting })}
          </p>
          <ul className="dispatch-list" aria-label={APPROVALS_TEXT.title}>
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
                    <span className="muted">
                      {APPROVALS_TEXT.asked({ when: formatWhen(a.createdAt) })}
                    </span>
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
