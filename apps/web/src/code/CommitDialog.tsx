// Commit from a Code session (FR-070, FR-211; docs/10 §8): a message, and on the default branch a
// new branch first (suggested as `nova/<slug>` from the message, editable). Pending changes can
// be accepted into the commit; rejected ones are left out. The result shows the commit and its
// branch, and says so when the repository's hooks did not run.
import { useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionView, CommitResult } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../chat/rich.tsx';
import { useServices } from '../services.tsx';
import { branchProblem, defaultBranch, onDefaultBranch, shortSha, suggestBranch } from './git.ts';
import { sessionTitle } from './labels.ts';

export const COMMIT_TEXT = defineMessages('code.commit', {
  failed: 'Could not commit.',
  committed: 'Committed',
  title: 'Commit changes',
  onDefault: 'You are on {branch}, the default branch. The commit goes on a new branch.',
  theDefault: 'the default branch',
  commitsTo: 'Commits to {branch}.',
  theHead: 'the current HEAD',
  noRepo: 'This folder is not a Git repository.',
  done: 'Done',
  result:
    '{n, plural, one {Committed # file to {branch} as {commit}.} other {Committed # files to {branch} as {commit}.}}',
  message: 'Commit message',
  newBranch: 'New branch',
  branchHint: 'Suggested from the message. Nova creates it and switches to it before committing.',
  acceptPending: 'Accept the pending changes and include them',
  pending:
    '{n, plural, one {# hunk still waits for a decision. Rejected changes are always left out.} other {# hunks still wait for a decision. Rejected changes are always left out.}}',
  cancel: 'Cancel',
  commit: 'Commit',
});

/**
 * Whether the repository's hooks ran. Not in CommitResult yet: a Hub that commits outside a
 * sandbox (where hooks do not run, docs/10 §8) can send `hooksRan: false` and a note.
 */
type CommitOutcome = CommitResult & { hooksRan?: boolean; hooksNote?: string | null };

export function CommitDialog({
  open,
  session,
  pending,
  onClose,
  onCommitted,
}: {
  open: boolean;
  session: CodeSessionView;
  /** Hunks still waiting for a decision. */
  pending: number;
  onClose: () => void;
  onCommitted: (r: CommitResult) => void;
}) {
  return open ? (
    <CommitForm session={session} pending={pending} onClose={onClose} onCommitted={onCommitted} />
  ) : null;
}

function CommitForm({
  session,
  pending,
  onClose,
  onCommitted,
}: {
  session: CodeSessionView;
  pending: number;
  onClose: () => void;
  onCommitted: (r: CommitResult) => void;
}) {
  const { api } = useServices();
  const id = `commit${useId()}`;
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState('');
  const [branchDraft, setBranchDraft] = useState<string | null>(null);
  const [acceptPending, setAcceptPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CommitOutcome | null>(null);

  // The form leaves with the result; focus goes to Done instead of the page behind.
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const repo = session.repo;
  const onDefault = onDefaultBranch(repo);
  const main = repo ? defaultBranch(repo) : null;
  const branch = branchDraft ?? suggestBranch(message, sessionTitle(session));
  const branchError = onDefault ? branchProblem(branch, main) : null;
  const canCommit = !!repo && !!message.trim() && !branchError && !busy;

  const submit = async () => {
    if (!canCommit) return;
    setBusy(true);
    setError(null);
    try {
      const r: CommitOutcome = await api.commit(session.id, {
        message: message.trim(),
        ...(onDefault ? { branch: branch.trim() } : {}),
        ...(pending ? { acceptPending } : {}),
      });
      setDone(r);
      onCommitted(r);
    } catch (err) {
      setError(errorMessage(err, COMMIT_TEXT.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={done ? COMMIT_TEXT.committed : COMMIT_TEXT.title}
      description={
        done
          ? undefined
          : repo
            ? onDefault
              ? COMMIT_TEXT.onDefault({ branch: main ?? repo.branch ?? COMMIT_TEXT.theDefault })
              : COMMIT_TEXT.commitsTo({ branch: repo.branch ?? COMMIT_TEXT.theHead })
            : COMMIT_TEXT.noRepo
      }
      onClose={onClose}
      initialFocusRef={messageRef}
      footer={
        done ? (
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            {COMMIT_TEXT.done}
          </Button>
        ) : undefined
      }
    >
      {done ? (
        <>
          <p role="status">
            <Icon name="check" />{' '}
            {rich((p) => COMMIT_TEXT.result({ ...p, n: done.files }), {
              branch: done.branch,
              commit: <code title={done.sha}>{shortSha(done.sha)}</code>,
            })}
          </p>
          {/* Only when the repository has hooks that did not run (FR-211): the Hub says why. */}
          {done.hooksRan === false && done.hooksNote ? (
            <p className="code-hooks-note" role="note">
              <Icon name="alert" /> {done.hooksNote}
            </p>
          ) : null}
        </>
      ) : (
        <form
          className="stack code-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-msg`}>
              {COMMIT_TEXT.message}
            </label>
            <textarea
              ref={messageRef}
              id={`${id}-msg`}
              className="nv-input ws-textarea"
              rows={4}
              maxLength={5000}
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {onDefault ? (
            <TextField
              label={COMMIT_TEXT.newBranch}
              value={branch}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              maxLength={200}
              hint={COMMIT_TEXT.branchHint}
              error={branchError ?? undefined}
              onChange={(e) => setBranchDraft(e.target.value)}
            />
          ) : null}
          {pending ? (
            <>
              <label className="code-check">
                <input
                  type="checkbox"
                  checked={acceptPending}
                  aria-describedby={`${id}-pending`}
                  onChange={(e) => setAcceptPending(e.target.checked)}
                />
                {COMMIT_TEXT.acceptPending}
              </label>
              <span id={`${id}-pending`} className="nv-field-hint">
                {COMMIT_TEXT.pending({ n: pending })}
              </span>
            </>
          ) : null}
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{COMMIT_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!canCommit}>
              {busy ? <Spinner /> : null} {COMMIT_TEXT.commit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
