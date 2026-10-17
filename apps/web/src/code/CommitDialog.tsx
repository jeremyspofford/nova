// Commit from a Code session (FR-070, FR-211; docs/10 §8): a message, and on the default branch a
// new branch first (suggested as `nova/<slug>` from the message, editable). Pending changes can
// be accepted into the commit; rejected ones are left out. The result shows the commit and its
// branch, and says so when the repository's hooks did not run.
import { useEffect, useId, useRef, useState } from 'react';
import type { CodeSessionView, CommitResult } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { plural } from '../settings/common.ts';
import { branchProblem, defaultBranch, onDefaultBranch, shortSha, suggestBranch } from './git.ts';
import { sessionTitle } from './labels.ts';

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
      setError(errorMessage(err, 'Could not commit.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={done ? 'Committed' : 'Commit changes'}
      description={
        done
          ? undefined
          : repo
            ? onDefault
              ? `You are on ${main ?? repo.branch ?? 'the default branch'}, the default branch. The commit goes on a new branch.`
              : `Commits to ${repo.branch ?? 'the current HEAD'}.`
            : 'This folder is not a Git repository.'
      }
      onClose={onClose}
      initialFocusRef={messageRef}
      footer={
        done ? (
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      {done ? (
        <>
          <p role="status">
            <Icon name="check" /> Committed {plural(done.files, 'file')} to {done.branch} as{' '}
            <code title={done.sha}>{shortSha(done.sha)}</code>.
          </p>
          {done.hooksRan === false ? (
            <p className="code-hooks-note" role="note">
              <Icon name="alert" /> The repository’s hooks did not run for this commit
              {done.hooksNote
                ? `: ${done.hooksNote}`
                : '. Hooks run only inside the session sandbox.'}
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
              Commit message
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
              label="New branch"
              value={branch}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              hint="Suggested from the message. Nova creates it and switches to it before committing."
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
                Accept the pending changes and include them
              </label>
              <span id={`${id}-pending`} className="nv-field-hint">
                {plural(pending, 'hunk')} still {pending === 1 ? 'waits' : 'wait'} for a decision.
                Rejected changes are always left out.
              </span>
            </>
          ) : null}
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canCommit}>
              {busy ? <Spinner /> : null} Commit
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
