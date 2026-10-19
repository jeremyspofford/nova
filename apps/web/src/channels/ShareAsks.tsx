// The owner's decision before private content goes to a shared channel (FR-088, docs/13 §4,
// `channels.privateToShared` = ask). The Hub asks through the request broker: a `user_input`
// request on the shared binding's thread with the choices "Share" and "Do not share", no tool
// call behind it, so the chat's question card (which follows `ask_user` calls) does not show it.
// `QuestionCard` answers such a request; `ChannelShareAsks` lists the pending ones on the
// Channels page and `ThreadQuestions` shows a thread's pending ones in its conversation. The
// question is the Hub's text, shown as plain text. The first answer wins on any device; nobody
// answering before it expires counts as "Do not share". Focus never lands on an answer button.
// Hub gap: the request carries no marker that it is a share ask, so the Channels page finds them
// by thread (a binding's thread) and the card's title assumes it.
import { useCallback, useEffect, useId, useState } from 'react';
import type { ChannelBindingViewM7, ServerRequestView } from '@nova/shared';
import { Button, StatusChip, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useChannelEvents, useDebouncedCallback } from './events.ts';
import { formatStamp } from './format.ts';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

/** The channels area's share ask: its two fixed choices. */
export function isShareAsk(r: ServerRequestView): boolean {
  const c = strings(r.payload.choices);
  return c.length === 2 && c.includes('Share') && c.includes('Do not share');
}

/** A pending question nobody's tool call shows: no call id behind it, choices only. */
export function isStandaloneQuestion(r: ServerRequestView): boolean {
  return (
    r.kind === 'user_input' &&
    r.status === 'pending' &&
    !r.correlation.callId &&
    strings(r.payload.choices).length > 0
  );
}

export function QuestionCard({
  request,
  context,
  onAnswered,
  showThreadLink = true,
}: {
  request: ServerRequestView;
  /** Where it comes from, like the channel's name; shown under the question. */
  context?: string | null;
  /** Off inside the thread itself. */
  showThreadLink?: boolean;
  /** Called after an answer was sent, or when it turned out answered or expired elsewhere. */
  onAnswered: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question =
    typeof request.payload.question === 'string' && request.payload.question
      ? request.payload.question
      : 'Nova has a question for you.';
  const choices = strings(request.payload.choices);
  const threadId = request.correlation.threadId ?? null;
  const share = isShareAsk(request);

  const answer = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.respondRequest(request.id, { choice });
      toast.show(`Answered: ${choice}.`, { tone: 'success' });
      onAnswered();
    } catch (err) {
      // The card leaves the list on a refetch, so these outcomes are told by a toast.
      if (err instanceof ApiError && err.status === 409) {
        toast.show('This was already answered on another device.', { tone: 'info' });
        onAnswered();
      } else if (err instanceof ApiError && err.status === 410) {
        toast.show('This expired before your answer arrived.', {
          tone: 'info',
        });
        onAnswered();
      } else setError(errorMessage(err, 'Could not send the answer.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ch-ask" aria-labelledby={`${id}-title`}>
      <div className="ch-ask-head">
        <h4 id={`${id}-title`} className="ch-ask-title">
          {share ? 'Share a private detail?' : 'Nova has a question'}
        </h4>
        <StatusChip status="needs_input" />
      </div>
      <p className="ch-ask-question">{question}</p>
      <p className="muted ch-ask-meta">
        {context ? `${context} · ` : ''}Waiting until {formatStamp(request.expiresAt)}
        {share ? '; no answer by then means it is not shared.' : '.'}
      </p>
      <div className="row" role="group" aria-label="Answers">
        {choices.map((c) => (
          <Button key={c} disabled={busy} onClick={() => void answer(c)}>
            {c}
          </Button>
        ))}
        {threadId && showThreadLink ? (
          <Button
            variant="ghost"
            onClick={() => navigate(chatPath(threadId))}
            aria-label="Open the channel's thread"
          >
            Open thread
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Pending standalone questions, refetched on request events. */
function usePendingQuestions(filter: (r: ServerRequestView) => boolean): {
  items: ServerRequestView[];
  reload: () => void;
} {
  const { api } = useServices();
  const [items, setItems] = useState<ServerRequestView[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listRequests('pending').then(
      ({ items: list }) => alive && setItems(list.filter(isStandaloneQuestion)),
      // Questions are extra here: a failed read leaves the rest of the page working.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounced = useDebouncedCallback(reload, 100);
  useChannelEvents(
    ['request.created', 'request.resolved', 'request.expired'],
    () => debounced(),
    reload,
  );
  return { items: items.filter(filter), reload };
}

/** The Channels page's "Waiting for your decision": share asks of the account's bindings. */
export function ChannelShareAsks({ bindings }: { bindings: ChannelBindingViewM7[] }) {
  const byThread = new Map(
    bindings.filter((b) => b.threadId !== null).map((b) => [b.threadId as string, b]),
  );
  const { items, reload } = usePendingQuestions(
    (r) => !!r.correlation.threadId && byThread.has(r.correlation.threadId),
  );
  if (!items.length) return null;
  return (
    <section className="settings-section" aria-labelledby="ch-asks">
      <h3 id="ch-asks">Waiting for your decision</h3>
      <p className="muted">
        A reply in a shared channel would include something from your private conversations or
        memory. It is held until you decide.
      </p>
      <div className="stack" aria-live="polite">
        {items.map((r) => (
          <QuestionCard
            key={r.id}
            request={r}
            context={byThread.get(r.correlation.threadId ?? '')?.label ?? null}
            onAnswered={reload}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A thread's pending standalone questions (share asks), for the conversation view: the Hub's
 * notification for one links to `/chat/<threadId>?request=<id>`.
 */
export function ThreadQuestions({ threadId }: { threadId: string }) {
  const { items, reload } = usePendingQuestions((r) => r.correlation.threadId === threadId);
  if (!items.length) return null;
  return (
    <div className="ch-thread-asks stack" aria-live="polite">
      {items.map((r) => (
        <QuestionCard key={r.id} request={r} onAnswered={reload} showThreadLink={false} />
      ))}
    </div>
  );
}
