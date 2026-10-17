// The Sessions pane of a Code session (FR-072, docs/10 §10): a side question about this session
// (Ctrl/Cmd+Alt+S), answered from its conversation without adding a turn, and the account's
// other Code sessions with their status, to open, message (your words, as a message in that
// session), ask a side question about, or archive (its worktree lease is released). Answers are
// model output and shown as text.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionView, SideAnswerView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { useCoalesced } from './events.ts';
import { branchText, sessionPath, sessionTitle, sortSessions } from './labels.ts';
import { ConfirmDialog, ErrorBanner } from './parts.tsx';

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
        (err: unknown) => setError(errorMessage(err, 'Could not load the other sessions.')),
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
      toast.show(`Archived “${sessionTitle(s)}”.`, { tone: 'success' });
    } catch (err) {
      setArchiveError(errorMessage(err, 'Could not archive the session.'));
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <section className="code-sessions-pane" aria-label="Sessions">
      <div className="code-subhead">
        <p className="ws-flush">
          Ask a side question about this session. The answer uses its conversation and adds nothing
          to it.
        </p>
        <Button variant="primary" onClick={() => onAsk(session)}>
          <Icon name="chat" /> Ask a side question…
        </Button>
      </div>
      <h3>Other sessions</h3>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {others === null && !error ? <Spinner label="Loading the other sessions" /> : null}
      {others?.length === 0 ? (
        <EmptyState
          level={3}
          title="No other sessions"
          description="Sessions you start in other folders or worktrees show up here."
        />
      ) : null}
      {others?.length ? (
        <ul className="ws-list" aria-label="Other sessions">
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
                    <span className="code-path">{s.folder.path}</span>
                    <span>
                      <Icon name="branch" /> {branchText(s.repo)}
                    </span>
                    <span>Updated {formatWhen(s.updatedAt)}</span>
                  </span>
                </div>
                <div className="ws-row-actions code-actions">
                  <Button onClick={() => setMessaging(s)}>
                    <Icon name="send" /> Message…
                  </Button>
                  <Button onClick={() => onAsk(s)}>
                    <Icon name="chat" /> Ask…
                  </Button>
                  <Button
                    onClick={() => {
                      setArchiveError(null);
                      setArchiving(s);
                    }}
                  >
                    <Icon name="archive" /> Archive…
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
          announce(`Message sent to ${sessionTitle(s)}.`);
          toast.show(`Sent to “${sessionTitle(s)}”.`, { tone: 'success' });
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={`Archive “${archiving ? sessionTitle(archiving) : ''}”?`}
        description="It stops taking turns. Its worktree lease is released; a clean worktree is removed unless Settings → Code keeps it. You can find it later under archived chats."
        confirmLabel="Archive"
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
      setError(errorMessage(err, 'Could not send the message.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Message “${sessionTitle(target)}”`}
      description="Sent as you, in that session’s conversation. It starts a turn there, or follows the running one."
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
            Message
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : null} Send
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
      announce('Answer ready.');
    } catch (err) {
      setError(errorMessage(err, 'Could not answer the question.'));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  return (
    <Dialog
      open
      title={`Side question: ${sessionTitle(target)}`}
      description="Answered from the session’s conversation. Nothing is added to it and nothing runs."
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
            <p className="muted ws-flush">You asked: {answer.question}</p>
            <p className="code-answer-text">{answer.answer}</p>
            {answer.model ? <p className="muted ws-flush">Answered by {answer.model}</p> : null}
          </div>
        ) : null}
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={id}>
            {answer ? 'Another question' : 'Question'}
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
            <Spinner label="Answering" /> Reading the session…
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary" disabled={busy || !question.trim()}>
            Ask
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
