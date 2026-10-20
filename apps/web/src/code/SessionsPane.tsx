// The Sessions pane of a Code session (FR-072, docs/10 §10): a side question about this session
// (Ctrl/Cmd+Alt+S), answered from its conversation without adding a turn, and the account's
// other Code sessions with their status, to open, message (your words, as a message in that
// session), ask a side question about, or archive (its worktree lease is released). Answers are
// model output and shown as text.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionView, SideAnswerView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, EmptyState, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { useCoalesced } from './events.ts';
import { branchText, sessionPath, sessionTitle, sortSessions } from './labels.ts';
import { ConfirmDialog, ErrorBanner } from './parts.tsx';

export const SESSIONS_PANE_TEXT = defineMessages('code.sessionsPane', {
  loadFailed: 'Could not load the other sessions.',
  archived: 'Archived “{title}”.',
  archiveFailed: 'Could not archive the session.',
  title: 'Sessions',
  askIntro:
    'Ask a side question about this session. The answer uses its conversation and adds nothing to it.',
  askSide: 'Ask a side question…',
  others: 'Other sessions',
  loading: 'Loading the other sessions',
  noneTitle: 'No other sessions',
  noneBody: 'Sessions you start in other folders or worktrees show up here.',
  updated: 'Updated {when}',
  message: 'Message…',
  ask: 'Ask…',
  archive: 'Archive…',
  sentAnnounce: 'Message sent to {title}.',
  sent: 'Sent to “{title}”.',
  archiveTitle: 'Archive “{title}”?',
  archiveBody:
    'It stops taking turns. Its worktree lease is released; a clean worktree is removed unless Settings → Code keeps it. You can find it later under archived chats.',
  archiveConfirm: 'Archive',
  sendFailed: 'Could not send the message.',
  messageTitle: 'Message “{title}”',
  messageBody:
    'Sent as you, in that session’s conversation. It starts a turn there, or follows the running one.',
  messageLabel: 'Message',
  cancel: 'Cancel',
  send: 'Send',
  answerReady: 'Answer ready.',
  answerFailed: 'Could not answer the question.',
  sideTitle: 'Side question: {title}',
  sideBody: 'Answered from the session’s conversation. Nothing is added to it and nothing runs.',
  youAsked: 'You asked: {question}',
  answeredBy: 'Answered by {model}',
  another: 'Another question',
  question: 'Question',
  answering: 'Answering',
  reading: 'Reading the session…',
  close: 'Close',
  askButton: 'Ask',
});

export function SessionsPane({
  session,
  visible,
  version,
  onAsk,
}: {
  session: CodeSessionView;
  visible: boolean;
  /** Bumped by the session view on each `code.session.*` event. */
  version: number;
  /** Opens the side question dialog for a session. */
  onAsk: (s: CodeSessionView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
  const [others, setOthers] = useState<CodeSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<CodeSessionView | null>(null);
  const [archiving, setArchiving] = useState<CodeSessionView | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.listCodeSessions().then(
        ({ items }) => {
          setOthers(sortSessions(items.filter((s) => s.id !== session.id)));
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, SESSIONS_PANE_TEXT.loadFailed)),
      ),
    [api, session.id],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible, version]);

  const archive = async () => {
    const s = archiving;
    if (!s) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await api.updateThread(s.threadId, { archived: true });
      setOthers((list) => list?.filter((x) => x.id !== s.id) ?? null);
      setArchiving(null);
      toast.show(SESSIONS_PANE_TEXT.archived({ title: sessionTitle(s) }), { tone: 'success' });
    } catch (err) {
      setArchiveError(errorMessage(err, SESSIONS_PANE_TEXT.archiveFailed));
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <section className="code-sessions-pane" aria-label={SESSIONS_PANE_TEXT.title}>
      <div className="code-subhead">
        <p className="ws-flush">{SESSIONS_PANE_TEXT.askIntro}</p>
        <Button variant="primary" onClick={() => onAsk(session)}>
          <Icon name="chat" /> {SESSIONS_PANE_TEXT.askSide}
        </Button>
      </div>
      <h3>{SESSIONS_PANE_TEXT.others}</h3>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {others === null && !error ? <Spinner label={SESSIONS_PANE_TEXT.loading} /> : null}
      {others?.length === 0 ? (
        <EmptyState
          level={3}
          title={SESSIONS_PANE_TEXT.noneTitle}
          description={SESSIONS_PANE_TEXT.noneBody}
        />
      ) : null}
      {others?.length ? (
        <ul className="ws-list" aria-label={SESSIONS_PANE_TEXT.others}>
          {others.map((s) => {
            const title = sessionTitle(s);
            return (
              <li key={s.id} className="ws-list-row" aria-label={title}>
                <div className="code-env-main">
                  <div className="code-row-title">
                    <AppLink to={sessionPath(s.id)} className="code-session-link">
                      {title}
                    </AppLink>
                    <StatusChip status={s.derived.status} reason={s.derived.reason ?? undefined} />
                  </div>
                  <span className="muted code-row-meta">
                    <span className="code-path" dir="ltr">
                      {s.folder.path}
                    </span>
                    <span>
                      <Icon name="branch" /> {branchText(s.repo)}
                    </span>
                    <span>{SESSIONS_PANE_TEXT.updated({ when: formatWhen(s.updatedAt) })}</span>
                  </span>
                </div>
                <div className="ws-row-actions code-actions">
                  <Button onClick={() => setMessaging(s)}>
                    <Icon name="send" /> {SESSIONS_PANE_TEXT.message}
                  </Button>
                  <Button onClick={() => onAsk(s)}>
                    <Icon name="chat" /> {SESSIONS_PANE_TEXT.ask}
                  </Button>
                  <Button
                    onClick={() => {
                      setArchiveError(null);
                      setArchiving(s);
                    }}
                  >
                    <Icon name="archive" /> {SESSIONS_PANE_TEXT.archive}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <MessageDialog
        target={messaging}
        onClose={() => setMessaging(null)}
        onSent={(s) => {
          setMessaging(null);
          announce(SESSIONS_PANE_TEXT.sentAnnounce({ title: sessionTitle(s) }));
          toast.show(SESSIONS_PANE_TEXT.sent({ title: sessionTitle(s) }), { tone: 'success' });
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={SESSIONS_PANE_TEXT.archiveTitle({
          title: archiving ? sessionTitle(archiving) : '',
        })}
        description={SESSIONS_PANE_TEXT.archiveBody}
        confirmLabel={SESSIONS_PANE_TEXT.archiveConfirm}
        busy={archiveBusy}
        error={archiveError}
        onConfirm={() => void archive()}
        onClose={() => setArchiving(null)}
      />
    </section>
  );
}

function MessageDialog({
  target,
  onClose,
  onSent,
}: {
  target: CodeSessionView | null;
  onClose: () => void;
  onSent: (s: CodeSessionView) => void;
}) {
  return target ? <MessageForm target={target} onClose={onClose} onSent={onSent} /> : null;
}

function MessageForm({
  target,
  onClose,
  onSent,
}: {
  target: CodeSessionView;
  onClose: () => void;
  onSent: (s: CodeSessionView) => void;
}) {
  const { api } = useServices();
  const id = `msg${useId()}`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendMessage(target.threadId, { text: text.trim() });
      onSent(target);
    } catch (err) {
      setError(errorMessage(err, SESSIONS_PANE_TEXT.sendFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={SESSIONS_PANE_TEXT.messageTitle({ title: sessionTitle(target) })}
      description={SESSIONS_PANE_TEXT.messageBody}
      onClose={onClose}
      initialFocusRef={ref}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={id}>
            {SESSIONS_PANE_TEXT.messageLabel}
          </label>
          <textarea
            ref={ref}
            id={id}
            className="nv-input ws-textarea"
            rows={4}
            maxLength={200_000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{SESSIONS_PANE_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : null} {SESSIONS_PANE_TEXT.send}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A side question about a session (FR-072): one read-only answer, nothing added to it. */
export function SideQuestionDialog({
  target,
  onClose,
}: {
  target: CodeSessionView | null;
  onClose: () => void;
}) {
  return target ? <SideQuestionForm target={target} onClose={onClose} /> : null;
}

function SideQuestionForm({ target, onClose }: { target: CodeSessionView; onClose: () => void }) {
  const m6 = useCodeM6Api();
  const announce = useAnnounce();
  const id = `ask${useId()}`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<(SideAnswerView & { question: string }) | null>(null);

  const submit = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const a = await m6.askCodeSession(target.id, q);
      setAnswer({ ...a, question: q });
      setQuestion('');
      announce(SESSIONS_PANE_TEXT.answerReady);
    } catch (err) {
      setError(errorMessage(err, SESSIONS_PANE_TEXT.answerFailed));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  return (
    <Dialog
      open
      title={SESSIONS_PANE_TEXT.sideTitle({ title: sessionTitle(target) })}
      description={SESSIONS_PANE_TEXT.sideBody}
      onClose={onClose}
      initialFocusRef={ref}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {answer ? (
          <div className="code-answer" aria-live="polite">
            <p className="muted ws-flush">
              {SESSIONS_PANE_TEXT.youAsked({ question: answer.question })}
            </p>
            <p className="code-answer-text" dir="auto">
              {answer.answer}
            </p>
            {answer.model ? (
              <p className="muted ws-flush">
                {SESSIONS_PANE_TEXT.answeredBy({ model: answer.model })}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={id}>
            {answer ? SESSIONS_PANE_TEXT.another : SESSIONS_PANE_TEXT.question}
          </label>
          <textarea
            ref={ref}
            id={id}
            className="nv-input ws-textarea"
            rows={3}
            maxLength={4000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        {busy ? (
          <p className="muted">
            <Spinner label={SESSIONS_PANE_TEXT.answering} /> {SESSIONS_PANE_TEXT.reading}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{SESSIONS_PANE_TEXT.close}</Button>
          <Button type="submit" variant="primary" disabled={busy || !question.trim()}>
            {SESSIONS_PANE_TEXT.askButton}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
