// Branch, push and pull request from a Code session's header (FR-070, docs/10 §8).
// - Branch: `nova/<name>` at the current commit; Nova switches to it without touching files.
// - Push: to a protected or the default branch only after you type the branch's exact name; a
//   force push is never made to one of those. When the commits look like they hold secrets the
//   Hub refuses the push and the dialog lists what it found (masked).
// - Pull request: pushes the branch through a connected Git host and opens the pull request
//   (or returns the open one); the same guards apply to its push.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CodeSessionView, GitHostView, PullRequestView, PushResultView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../chat/rich.tsx';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { onDefaultBranch, shortSha, slugify } from './git.ts';
import { sessionTitle } from './labels.ts';
import { errorDetails, errorReason } from './m6-format.ts';

export const GIT_TEXT = defineMessages('code.git', {
  branchFailed: 'Could not create the branch.',
  newBranch: 'New branch',
  startsAt: 'Starts at the current commit. Nova switches to it without changing any file.',
  startsAtOf:
    'Starts at the current commit of {branch}. Nova switches to it without changing any file.',
  branchName: 'Branch name',
  willBe: 'The branch will be nova/{slug} (with a short suffix if that is taken).',
  useLetters: 'Use letters and digits; Nova adds the nova/ prefix.',
  cancel: 'Cancel',
  createBranch: 'Create branch',
  pushRemote: 'Pushing works only for sessions whose folder is on the Hub.',
  detached: 'HEAD is detached. Commit on a branch first.',
  protectedBranch: '{branch} is a protected branch.',
  defaultBranch: '{branch} is the repository’s default branch.',
  confirmNote:
    'Pushing there changes what everyone works from. Type the branch name exactly to confirm.',
  typeToConfirm: 'Type {branch} to confirm',
  noMatch: 'The name does not match.',
  secrets:
    'Nothing was pushed: the commits look like they contain secrets. Remove them from the commits, then push again.',
  possibleSecrets: 'Possible secrets',
  atLine: '{path}, line {line}',
  secret: 'secret',
  forceProtected: 'Force-pushing {branch} is never allowed: it is protected.',
  forceDefault: 'Force-pushing {branch} is never allowed: it is the default branch.',
  pushFailed: 'Could not push.',
  pushed: 'Pushed',
  pushTitle: 'Push branch',
  pushBody:
    'Sends the commits of {branch} to the remote. Commits you have not made yet are not included.',
  done: 'Done',
  pushedTo: 'Pushed {branch} to {remote} at {commit}.',
  remote: 'Remote',
  remoteName: 'Use the remote’s name, for example origin.',
  force: 'Force push (only if the remote has not changed since you last fetched)',
  forceNever: 'Never allowed for a protected or the default branch.',
  forceHint: 'Replaces the remote branch with yours. Use it only on your own branches.',
  push: 'Push',
  hostsFailed: 'Could not load the Git hosts.',
  repoUnknown: 'The remote does not say which repository it is. Enter it as owner/name.',
  noHost: 'No connected Git host matches this repository’s remote.',
  sameBranch: 'The branch to merge into is the branch the session works on. Create a branch first.',
  prFailed: 'Could not open the pull request.',
  prTitle: 'Open a pull request',
  prBody: 'Pushes {branch} and opens a pull request for it on the connected Git host.',
  loadingHosts: 'Loading the Git hosts',
  loadingHostsDots: 'Loading Git hosts…',
  noHosts: 'No Git host is connected yet.',
  connectHost: 'Connect a Git host in Settings → Code',
  close: 'Close',
  onDefault: 'The session is on {branch}, the default branch. A pull request needs its own branch.',
  newBranchButton: 'New branch…',
  title: 'Title',
  description: 'Description (optional)',
  mergeInto: 'Merge into (optional)',
  defaultBase: 'The repository’s default branch',
  host: 'Git host',
  matchingHost: 'The one that matches the remote',
  hostOption: '{name} ({url})',
  repo: 'Repository (owner/name)',
  repoExample: 'team/app',
  repoFormat: 'Use owner/name, for example team/app.',
  draft: 'Open it as a draft',
  pushAndOpen: 'Push and open',
});

// ---- branch ---------------------------------------------------------------------------------

export function BranchDialog({
  open,
  session,
  onClose,
  onCreated,
}: {
  open: boolean;
  session: CodeSessionView;
  onClose: () => void;
  onCreated: (r: { branch: string; from: string | null }) => void;
}) {
  return open ? <BranchForm session={session} onClose={onClose} onCreated={onCreated} /> : null;
}

function BranchForm({
  session,
  onClose,
  onCreated,
}: {
  session: CodeSessionView;
  onClose: () => void;
  onCreated: (r: { branch: string; from: string | null }) => void;
}) {
  const m6 = useCodeM6Api();
  const first = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => slugify(sessionTitle(session)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugify(name.replace(/^nova\//, ''), 60);

  const submit = async () => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await m6.createCodeBranch(session.id, name.trim()));
    } catch (err) {
      setError(errorMessage(err, GIT_TEXT.branchFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={GIT_TEXT.newBranch}
      description={
        session.repo?.branch
          ? GIT_TEXT.startsAtOf({ branch: session.repo.branch })
          : GIT_TEXT.startsAt
      }
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        className="stack code-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={first}
          label={GIT_TEXT.branchName}
          value={name}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          hint={slug ? GIT_TEXT.willBe({ slug }) : GIT_TEXT.useLetters}
          onChange={(e) => setName(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{GIT_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !slug}>
            {busy ? <Spinner /> : null} {GIT_TEXT.createBranch}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- push guards ----------------------------------------------------------------------------

/** A protected or default branch that needs its name typed before a push (docs/10 §8). */
export interface GuardedBranch {
  branch: string;
  protected: boolean;
  default: boolean;
}

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  preview: string;
}

/** What a refused push said, read from the Hub's error. */
export type PushRefusal =
  | { kind: 'confirm'; guard: GuardedBranch }
  | { kind: 'force'; guard: GuardedBranch }
  | { kind: 'secrets'; findings: SecretFinding[] }
  | { kind: 'failed'; message: string; output: string | null }
  | { kind: 'other'; message: string };

export function readRefusal(err: unknown, fallback: string): PushRefusal {
  const d = errorDetails(err);
  const reason = errorReason(err);
  const guard = (): GuardedBranch => ({
    branch: typeof d.branch === 'string' ? d.branch : '',
    protected: d.protected === true,
    default: d.default === true,
  });
  if (reason === 'confirmation_required') return { kind: 'confirm', guard: guard() };
  if (reason === 'force_protected') return { kind: 'force', guard: guard() };
  if (reason === 'secrets_found') {
    const list = Array.isArray(d.findings) ? (d.findings as unknown[]) : [];
    return {
      kind: 'secrets',
      findings: list.map((f) => {
        const x = (f ?? {}) as Record<string, unknown>;
        return {
          path: typeof x.path === 'string' ? x.path : '',
          line: typeof x.line === 'number' ? x.line : 0,
          rule: typeof x.rule === 'string' ? x.rule : '',
          preview: typeof x.preview === 'string' ? x.preview : '',
        };
      }),
    };
  }
  if (reason === 'push_failed')
    return {
      kind: 'failed',
      message: errorMessage(err, fallback),
      output: typeof d.output === 'string' ? d.output : null,
    };
  if (reason === 'remote_environment')
    return {
      kind: 'other',
      message: GIT_TEXT.pushRemote,
    };
  if (reason === 'detached_head') return { kind: 'other', message: GIT_TEXT.detached };
  return { kind: 'other', message: errorMessage(err, fallback) };
}

function guardText(g: GuardedBranch): string {
  return g.protected
    ? GIT_TEXT.protectedBranch({ branch: g.branch })
    : GIT_TEXT.defaultBranch({ branch: g.branch });
}

/** Type-to-confirm for a protected or default branch. */
function ConfirmBranch({
  guard,
  value,
  onChange,
}: {
  guard: GuardedBranch;
  value: string;
  onChange: (v: string) => void;
}) {
  const ok = value === guard.branch;
  return (
    <div className="code-callout" data-tone="warn">
      <p>
        <Icon name="alert" /> {guardText(guard)} {GIT_TEXT.confirmNote}
      </p>
      <TextField
        label={GIT_TEXT.typeToConfirm({ branch: guard.branch })}
        value={value}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        error={value && !ok ? GIT_TEXT.noMatch : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** The secret-scan findings that blocked a push (masked by the Hub). */
function SecretFindings({ findings }: { findings: SecretFinding[] }) {
  return (
    <div className="code-callout" data-tone="danger" role="alert">
      <p>
        <Icon name="shield" /> {GIT_TEXT.secrets}
      </p>
      {findings.length ? (
        <ul className="code-findings-list" aria-label={GIT_TEXT.possibleSecrets}>
          {findings.map((f, i) => (
            <li key={`${f.path}:${f.line}:${i}`}>
              <span className="code-path">
                {f.line ? GIT_TEXT.atLine({ path: f.path, line: String(f.line) }) : f.path}
              </span>{' '}
              <span className="muted">({f.rule || GIT_TEXT.secret})</span>
              {f.preview ? <code className="code-preview">{f.preview}</code> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RefusalView({ refusal }: { refusal: PushRefusal | null }): ReactNode {
  if (!refusal) return null;
  switch (refusal.kind) {
    case 'confirm':
      return null;
    case 'force':
      return (
        <p className="nv-field-error" role="alert">
          {refusal.guard.protected
            ? GIT_TEXT.forceProtected({ branch: refusal.guard.branch })
            : GIT_TEXT.forceDefault({ branch: refusal.guard.branch })}
        </p>
      );
    case 'secrets':
      return <SecretFindings findings={refusal.findings} />;
    case 'failed':
      return (
        <div role="alert" className="code-callout" data-tone="danger">
          <p>{refusal.message}</p>
          {refusal.output ? <pre className="ws-log">{refusal.output}</pre> : null}
        </div>
      );
    case 'other':
      return (
        <p className="nv-field-error" role="alert">
          {refusal.message}
        </p>
      );
  }
}

/** The guard the UI knows before asking: the default branch from the session's repository. */
function knownGuard(session: CodeSessionView): GuardedBranch | null {
  const repo = session.repo;
  if (!repo?.branch || !onDefaultBranch(repo)) return null;
  return { branch: repo.branch, protected: false, default: true };
}

// ---- push -----------------------------------------------------------------------------------

export function PushDialog({
  open,
  session,
  onClose,
  onPushed,
}: {
  open: boolean;
  session: CodeSessionView;
  onClose: () => void;
  onPushed: (r: PushResultView) => void;
}) {
  return open ? <PushForm session={session} onClose={onClose} onPushed={onPushed} /> : null;
}

function PushForm({
  session,
  onClose,
  onPushed,
}: {
  session: CodeSessionView;
  onClose: () => void;
  onPushed: (r: PushResultView) => void;
}) {
  const m6 = useCodeM6Api();
  const hintId = `force${useId()}`;
  const doneRef = useRef<HTMLButtonElement>(null);
  const [remote, setRemote] = useState('origin');
  const [force, setForce] = useState(false);
  const [guard, setGuard] = useState<GuardedBranch | null>(() => knownGuard(session));
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<PushRefusal | null>(null);
  const [done, setDone] = useState<PushResultView | null>(null);
  const branch = session.repo?.branch ?? null;
  const confirmed = !guard || typed === guard.branch;
  const remoteOk = /^[A-Za-z0-9._-]+$/.test(remote.trim());

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const submit = async () => {
    if (busy || !confirmed || !remoteOk) return;
    setBusy(true);
    setRefusal(null);
    try {
      const r = await m6.pushCodeSession(session.id, {
        ...(remote.trim() !== 'origin' ? { remote: remote.trim() } : {}),
        ...(guard ? { confirmBranch: typed } : {}),
        ...(force ? { force: true } : {}),
      });
      setDone(r);
      onPushed(r);
    } catch (err) {
      const r = readRefusal(err, GIT_TEXT.pushFailed);
      if (r.kind === 'confirm' || r.kind === 'force') {
        setGuard(r.guard);
        if (r.kind === 'force') setForce(false);
      }
      setRefusal(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={done ? GIT_TEXT.pushed : GIT_TEXT.pushTitle}
      description={done ? undefined : branch ? GIT_TEXT.pushBody({ branch }) : GIT_TEXT.detached}
      onClose={onClose}
      footer={
        done ? (
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            {GIT_TEXT.done}
          </Button>
        ) : undefined
      }
    >
      {done ? (
        <>
          <p role="status">
            <Icon name="check" />{' '}
            {rich(GIT_TEXT.pushedTo, {
              branch: done.branch,
              remote: done.remote,
              commit: <code title={done.sha}>{shortSha(done.sha)}</code>,
            })}
          </p>
          {!done.hooksRan && done.hooksNote ? (
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
          <TextField
            label={GIT_TEXT.remote}
            value={remote}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            error={remoteOk ? undefined : GIT_TEXT.remoteName}
            onChange={(e) => setRemote(e.target.value)}
          />
          {guard ? <ConfirmBranch guard={guard} value={typed} onChange={setTyped} /> : null}
          <label className="code-check">
            <input
              type="checkbox"
              checked={force}
              disabled={!!guard}
              onChange={(e) => setForce(e.target.checked)}
              aria-describedby={hintId}
            />
            {GIT_TEXT.force}
          </label>
          <span id={hintId} className="nv-field-hint">
            {guard ? GIT_TEXT.forceNever : GIT_TEXT.forceHint}
          </span>
          <RefusalView refusal={refusal} />
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{GIT_TEXT.cancel}</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !branch || !confirmed || !remoteOk}
            >
              {busy ? <Spinner /> : null} {GIT_TEXT.push}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---- pull request ---------------------------------------------------------------------------

export function PullRequestDialog({
  open,
  session,
  onClose,
  onOpened,
  onNewBranch,
}: {
  open: boolean;
  session: CodeSessionView;
  onClose: () => void;
  onOpened: (pr: PullRequestView) => void;
  /** Opens the New branch dialog (a pull request cannot come from the default branch). */
  onNewBranch: () => void;
}) {
  return open ? (
    <PullRequestForm
      session={session}
      onClose={onClose}
      onOpened={onOpened}
      onNewBranch={onNewBranch}
    />
  ) : null;
}

function PullRequestForm({
  session,
  onClose,
  onOpened,
  onNewBranch,
}: {
  session: CodeSessionView;
  onClose: () => void;
  onOpened: (pr: PullRequestView) => void;
  onNewBranch: () => void;
}) {
  const m6 = useCodeM6Api();
  const id = `pr${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const [hosts, setHosts] = useState<GitHostView[] | null>(null);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [hostId, setHostId] = useState('');
  const [title, setTitle] = useState(() => sessionTitle(session));
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [repo, setRepo] = useState('');
  const [needsRepo, setNeedsRepo] = useState(false);
  const [guard, setGuard] = useState<GuardedBranch | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<PushRefusal | null>(null);
  const branch = session.repo?.branch ?? null;
  const onDefault = onDefaultBranch(session.repo);

  useEffect(() => {
    let alive = true;
    m6.listGitHosts().then(
      ({ items }) => alive && setHosts(items),
      (err: unknown) => {
        if (!alive) return;
        setHosts([]);
        setHostsError(errorMessage(err, GIT_TEXT.hostsFailed));
      },
    );
    return () => {
      alive = false;
    };
  }, [m6]);

  const confirmed = !guard || typed === guard.branch;
  const repoOk = !needsRepo || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
  const canOpen = !!hosts?.length && !!title.trim() && !onDefault && confirmed && repoOk && !busy;

  const submit = async () => {
    if (!canOpen) return;
    setBusy(true);
    setRefusal(null);
    try {
      onOpened(
        await m6.openPullRequest(session.id, {
          title: title.trim(),
          ...(body.trim() ? { body } : {}),
          ...(base.trim() ? { base: base.trim() } : {}),
          ...(draft ? { draft: true } : {}),
          ...(hostId ? { hostId } : {}),
          ...(needsRepo && repo.trim() ? { repo: repo.trim() } : {}),
          ...(guard ? { confirmBranch: typed } : {}),
        }),
      );
    } catch (err) {
      const reason = errorReason(err);
      if (reason === 'repo_unknown') {
        setNeedsRepo(true);
        setRefusal({
          kind: 'other',
          message: GIT_TEXT.repoUnknown,
        });
      } else if (reason === 'no_git_host') {
        setRefusal({
          kind: 'other',
          message: GIT_TEXT.noHost,
        });
      } else if (reason === 'same_branch') {
        setRefusal({
          kind: 'other',
          message: GIT_TEXT.sameBranch,
        });
      } else {
        const r = readRefusal(err, GIT_TEXT.prFailed);
        if (r.kind === 'confirm') setGuard(r.guard);
        setRefusal(r);
      }
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={GIT_TEXT.prTitle}
      description={branch ? GIT_TEXT.prBody({ branch }) : GIT_TEXT.detached}
      onClose={onClose}
      initialFocusRef={first}
    >
      {hosts === null ? (
        <p className="muted">
          <Spinner label={GIT_TEXT.loadingHosts} /> {GIT_TEXT.loadingHostsDots}
        </p>
      ) : !hosts.length ? (
        <div className="stack">
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {hostsError ?? GIT_TEXT.noHosts}
          </p>
          <p>
            <AppLink to="/settings/code">{GIT_TEXT.connectHost}</AppLink>
          </p>
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{GIT_TEXT.close}</Button>
          </div>
        </div>
      ) : (
        <form
          id={id}
          className="stack code-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {onDefault ? (
            <div className="code-callout" data-tone="warn" role="note">
              <p>
                <Icon name="alert" /> {GIT_TEXT.onDefault({ branch: branch ?? '' })}
              </p>
              <Button onClick={onNewBranch}>
                <Icon name="branch" /> {GIT_TEXT.newBranchButton}
              </Button>
            </div>
          ) : null}
          <TextField
            ref={first}
            label={GIT_TEXT.title}
            value={title}
            maxLength={256}
            required
            autoComplete="off"
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-body`}>
              {GIT_TEXT.description}
            </label>
            <textarea
              id={`${id}-body`}
              className="nv-input ws-textarea"
              rows={5}
              maxLength={60_000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <TextField
            label={GIT_TEXT.mergeInto}
            value={base}
            maxLength={250}
            autoComplete="off"
            spellCheck={false}
            placeholder={GIT_TEXT.defaultBase}
            onChange={(e) => setBase(e.target.value)}
          />
          {hosts.length > 1 ? (
            <SelectField
              label={GIT_TEXT.host}
              value={hostId}
              onChange={setHostId}
              options={[
                { value: '', label: GIT_TEXT.matchingHost },
                ...hosts.map((h) => ({
                  value: h.id,
                  label: GIT_TEXT.hostOption({ name: h.label, url: h.webUrl }),
                })),
              ]}
            />
          ) : null}
          {needsRepo ? (
            <TextField
              label={GIT_TEXT.repo}
              value={repo}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={GIT_TEXT.repoExample}
              error={repo && !repoOk ? GIT_TEXT.repoFormat : undefined}
              onChange={(e) => setRepo(e.target.value)}
            />
          ) : null}
          <label className="code-check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            {GIT_TEXT.draft}
          </label>
          {guard ? <ConfirmBranch guard={guard} value={typed} onChange={setTyped} /> : null}
          <RefusalView refusal={refusal} />
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{GIT_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!canOpen}>
              {busy ? <Spinner /> : null} {GIT_TEXT.pushAndOpen}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
