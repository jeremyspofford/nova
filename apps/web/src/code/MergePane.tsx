// Merges into a session (FR-073; docs/10 §9, §14): bring in another session's work (a worker, an
// attempt) or a patch onto this session's folder with a three-way merge. By default a conflict
// writes nothing and the merge is shown with each conflicting file's three sides (base, this
// session, the work); with conflict markers the files get them, commits wait, and the merge is
// resolved (once no markers are left) or aborted (the files go back as they were). A conflict is
// never resolved silently; Ask the agent sends the conflicting paths to the session's agent.
import { useEffect, useId, useState } from 'react';
import type { CodeMergeView, CodeSessionView, MergeConflictView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { ConfirmAction, TextBlock, useLoad } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useCodeM7Api, type MergeConflictMode } from './api-m7.ts';
import { sessionTitle } from './labels.ts';
import { inRepo } from './m6-format.ts';
import {
  FILE_RESULT,
  MERGE_SOURCE,
  MERGE_STATUS,
  codeM7ErrorMessage,
  conflictMergeId,
  conflictPaths,
  isConflict,
} from './m7-format.ts';
import { Badge } from './parts.tsx';

export function MergePane({
  session,
  remote,
  onChanged,
}: {
  session: CodeSessionView;
  /** Why merging another session is not possible here (a session on another machine). */
  remote: boolean;
  onChanged: () => void;
}) {
  const m7 = useCodeM7Api();
  const announce = useAnnounce();
  const list = useLoad(
    () => m7.listMerges(session.id).then((r) => r.items),
    `merges:${session.id}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useHubStream(
    ['code.merge.completed'],
    (env) => {
      if (env.payload.sessionId === session.id) list.reload();
    },
    list.reload,
  );
  const items = list.data;
  // The newest unresolved merge opens by itself: it blocks commits until it is settled.
  const conflicted = items?.find((m) => m.status === 'conflicted') ?? null;
  const shown = open ?? conflicted?.id ?? null;

  return (
    <div className="cm7-pane">
      <div className="cm7-pane-head">
        <p className="muted ws-flush">
          Bring another session’s work or a patch into this session. Conflicts are shown with their
          three sides; nothing is resolved without you.
        </p>
        <Button onClick={() => setMerging(true)}>
          <Icon name="branch" /> Merge in…
        </Button>
      </div>
      {notice ? (
        <p className="cl-notice" data-tone="warn" role="status">
          <Icon name="alert" />
          <span>{notice}</span>
        </p>
      ) : null}
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{codeM7ErrorMessage(list.error, 'Could not load the merges.')}</p>
          <Button onClick={list.reload}>Retry</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label="Loading the merges" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No merges yet"
          description="Merge a worker’s or an attempt’s work, or apply a patch onto a branch that moved."
          icon="branch"
        />
      ) : null}
      {items?.length ? (
        <ul className="cm7-list" aria-label="Merges">
          {items.map((m) => (
            <li
              key={m.id}
              className="cm7-row"
              aria-label={`${MERGE_SOURCE[m.source.kind]}, ${MERGE_STATUS[m.status].text}`}
            >
              <span className="cm7-row-title">
                <button
                  type="button"
                  className="cl-link"
                  aria-expanded={shown === m.id}
                  onClick={() => setOpen(shown === m.id ? '' : m.id)}
                >
                  {MERGE_SOURCE[m.source.kind]} · {formatWhen(m.createdAt)}
                </button>
                <Badge tone={MERGE_STATUS[m.status].tone} icon={MERGE_STATUS[m.status].icon}>
                  {MERGE_STATUS[m.status].text}
                </Badge>
              </span>
              <span className="muted ws-row-meta">
                <span>{plural(m.files.length, 'file')}</span>
                {m.conflicts.length ? <span>{plural(m.conflicts.length, 'conflict')}</span> : null}
              </span>
              {shown === m.id ? (
                <MergeDetail
                  merge={m}
                  session={session}
                  onChanged={(next) => {
                    list.setData((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? null);
                    onChanged();
                  }}
                  onRemerged={(next) => {
                    list.setData((prev) => [next, ...(prev ?? [])]);
                    setOpen(next.id);
                    onChanged();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <MergeDialog
        open={merging}
        session={session}
        remote={remote}
        onClose={() => setMerging(false)}
        onMerged={(m) => {
          setMerging(false);
          setNotice(null);
          list.setData((prev) => [m, ...(prev ?? []).filter((x) => x.id !== m.id)]);
          setOpen(m.id);
          announce(
            m.status === 'conflicted'
              ? `Merged with ${plural(m.conflicts.length, 'conflict')} to resolve.`
              : 'Merged.',
          );
          onChanged();
        }}
        onRefused={(mergeId, paths) => {
          setMerging(false);
          setNotice(
            `Nothing was written: ${plural(paths.length, 'file')} conflict${paths.length === 1 ? 's' : ''} with this session (${paths.join(', ')}). Open the merge to see the three sides.`,
          );
          list.reload();
          if (mergeId) setOpen(mergeId);
          announce('The merge was refused because of conflicts.');
        }}
      />
    </div>
  );
}

function MergeDetail({
  merge,
  session,
  onChanged,
  onRemerged,
}: {
  merge: CodeMergeView;
  session: CodeSessionView;
  onChanged: (m: CodeMergeView) => void;
  onRemerged: (m: CodeMergeView) => void;
}) {
  const m7 = useCodeM7Api();
  const { api } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const conflictFiles = merge.files.filter((f) => isConflict(f.result));

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await m7.resolveMerge(session.id, merge.id);
      onChanged(next);
      announce('Merge resolved. Commits can go ahead.');
    } catch (err) {
      const paths = conflictPaths(err);
      setError(
        paths.length
          ? `Conflict markers are still in ${paths.join(', ')}. Edit them out, then try again.`
          : codeM7ErrorMessage(err, 'Could not mark the merge resolved.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const remergeWithMarkers = async () => {
    if (!merge.source.ref) return;
    setBusy(true);
    setError(null);
    try {
      onRemerged(await m7.mergeIntoSession(session.id, { sessionId: merge.source.ref }, 'markers'));
    } catch (err) {
      setError(codeM7ErrorMessage(err, 'Could not merge.'));
    } finally {
      setBusy(false);
    }
  };

  const askAgent = async () => {
    const paths = conflictFiles.map((f) => f.path);
    try {
      await api.sendMessage(session.threadId, {
        text: `Resolve the merge conflicts in ${paths.join(', ')}: keep the intent of both sides, remove every conflict marker, and run the tests. Tell me what you chose where it was not obvious.`,
      });
      toast.show('Sent to the agent.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not send it: ${codeM7ErrorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="cm7-detail">
      <ul className="cm7-files" aria-label="Files in this merge">
        {merge.files.map((f) => (
          <li key={f.path} data-conflict={isConflict(f.result) || undefined}>
            <Icon name={isConflict(f.result) ? 'alert' : 'file'} />
            <code className="cl-break">{f.path}</code>
            <span className="muted cl-small">
              {FILE_RESULT[f.result]}
              {f.conflicts > 1 ? ` (${f.conflicts} places)` : ''}
            </span>
          </li>
        ))}
      </ul>
      {merge.conflicts.map((c) => (
        <ThreeWay key={c.path} c={c} status={merge.status} />
      ))}
      {merge.status === 'conflicted' ? (
        <p className="muted cl-small">
          The files have conflict markers. Edit them out (in the File tab, or ask the agent), then
          mark the merge resolved. Commits wait until then.
        </p>
      ) : null}
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cl-actions">
        {merge.status === 'conflicted' ? (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void resolve()}>
              {busy ? <Spinner /> : <Icon name="check" />} Mark resolved
            </Button>
            <Button onClick={() => void askAgent()}>
              <Icon name="send" /> Ask the agent to resolve
            </Button>
            <Button variant="danger" onClick={() => setAborting(true)}>
              <Icon name="undo" /> Abort merge…
            </Button>
          </>
        ) : null}
        {merge.status === 'refused' && merge.source.ref && merge.source.kind !== 'patch' ? (
          <Button disabled={busy} onClick={() => void remergeWithMarkers()}>
            {busy ? <Spinner /> : null} Merge with conflict markers
          </Button>
        ) : null}
      </div>
      <ConfirmAction
        open={aborting}
        title="Abort this merge?"
        description="The files go back to how they were before the merge, including any edits made to resolve it."
        confirmLabel="Abort merge"
        danger
        errorText={(err) => codeM7ErrorMessage(err, 'Could not abort the merge.')}
        onClose={() => setAborting(false)}
        onConfirm={async () => {
          const next = await m7.abortMerge(session.id, merge.id);
          setAborting(false);
          onChanged(next);
          announce('Merge aborted.');
        }}
      />
    </div>
  );
}

/** One conflicting file's sides: the common base, this session's, and the work's. */
function ThreeWay({ c, status }: { c: MergeConflictView; status: CodeMergeView['status'] }) {
  const id = useId();
  if (c.binary)
    return (
      <section className="cm7-threeway" aria-labelledby={id}>
        <h4 id={id} className="cm7-file-title">
          <code className="cl-break">{c.path}</code>
        </h4>
        <p className="muted cl-small">
          A binary file (or a link) changed on both sides. It is never merged; keep one side by
          hand.
        </p>
      </section>
    );
  const side = (label: string, text: string | null) => (
    <div className="cm7-side">
      <span className="cm7-side-label">{label}</span>
      {text === null ? (
        <p className="muted cl-small">Not there on this side.</p>
      ) : (
        <TextBlock text={text} label={`${c.path}: ${label}`} />
      )}
    </div>
  );
  return (
    <section className="cm7-threeway" aria-labelledby={id}>
      <h4 id={id} className="cm7-file-title">
        <code className="cl-break">{c.path}</code>
      </h4>
      <div className="cm7-sides">
        {side('Base', c.base)}
        {side('This session', c.ours)}
        {side('The work', c.theirs)}
      </div>
      {c.merged !== null && status === 'conflicted' ? (
        <details className="ws-advanced">
          <summary>With conflict markers, as in the file now</summary>
          <TextBlock text={c.merged} label={`${c.path} with conflict markers`} />
        </details>
      ) : null}
      {c.truncated ? <p className="muted cl-small">Long sides are cut short here.</p> : null}
    </section>
  );
}

type Source = 'session' | 'patch';

function MergeDialog({
  open,
  session,
  remote,
  onClose,
  onMerged,
  onRefused,
}: {
  open: boolean;
  session: CodeSessionView;
  remote: boolean;
  onClose: () => void;
  onMerged: (m: CodeMergeView) => void;
  onRefused: (mergeId: string | null, paths: string[]) => void;
}) {
  if (!open) return null;
  return (
    <MergeForm
      session={session}
      remote={remote}
      onClose={onClose}
      onMerged={onMerged}
      onRefused={onRefused}
    />
  );
}

function MergeForm({
  session,
  remote,
  onClose,
  onMerged,
  onRefused,
}: {
  session: CodeSessionView;
  remote: boolean;
  onClose: () => void;
  onMerged: (m: CodeMergeView) => void;
  onRefused: (mergeId: string | null, paths: string[]) => void;
}) {
  const { api } = useServices();
  const m7 = useCodeM7Api();
  const id = `mg${useId()}`;
  const [others, setOthers] = useState<CodeSessionView[] | null>(null);
  const [source, setSource] = useState<Source>(remote ? 'patch' : 'session');
  const [from, setFrom] = useState('');
  const [patch, setPatch] = useState('');
  const [base, setBase] = useState('');
  const [mode, setMode] = useState<MergeConflictMode>('refuse');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remote) return;
    let alive = true;
    const root = session.repo?.root ?? session.folder.path;
    api.listCodeSessions().then(
      ({ items }) =>
        alive &&
        setOthers(
          items.filter(
            (s) =>
              s.id !== session.id &&
              !!s.repo &&
              (inRepo(s.repo.root, root) || inRepo(root, s.repo.root) || sameRepo(s, session)),
          ),
        ),
      () => alive && setOthers([]),
    );
    return () => {
      alive = false;
    };
  }, [api, remote, session]);

  const problems: Record<string, string> = {};
  if (source === 'session' && !from) problems.from = 'Choose the session whose work to merge.';
  if (source === 'patch' && !patch.trim())
    problems.patch = 'Paste a unified patch (git diff output).';
  if (source === 'patch' && base.trim() && !/^[0-9a-f]{7,64}$/.test(base.trim()))
    problems.base = 'Enter a commit hash: 7 to 64 characters, 0-9 and a-f.';
  const shown = tried ? problems : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const m = await m7.mergeIntoSession(
        session.id,
        source === 'session'
          ? { sessionId: from }
          : { patch, ...(base.trim() ? { base: base.trim() } : {}) },
        mode,
      );
      onMerged(m);
    } catch (err) {
      const reason = (err as { body?: { details?: { reason?: unknown } } }).body?.details?.reason;
      if (reason === 'merge_conflict') {
        onRefused(conflictMergeId(err), conflictPaths(err));
        return;
      }
      setError(codeM7ErrorMessage(err, 'Could not merge.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Merge into this session"
      description="A three-way merge onto this session’s files. Nothing is committed."
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        className="stack cm7-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <RadioGroup
          legend="Merge from"
          name={`${id}-src`}
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={[
            {
              value: 'session',
              label: 'Another session',
              description: remote
                ? 'Only when both sessions’ folders are on the Hub.'
                : 'A worker or another session in the same repository.',
            },
            {
              value: 'patch',
              label: 'A patch',
              description: 'Unified diff text, such as git diff output.',
            },
          ]}
        />
        {source === 'session' ? (
          remote ? (
            <p className="ws-callout" role="note">
              <Icon name="alert" />
              <span>
                Merging sessions needs both folders on the Hub. This session is on another machine.
              </span>
            </p>
          ) : others === null ? (
            <p className="muted">
              <Spinner label="Loading the sessions" /> Loading sessions…
            </p>
          ) : others.length ? (
            <SelectField
              label="Session"
              value={from}
              onChange={setFrom}
              options={[
                { value: '', label: 'Choose a session' },
                ...others.map((s) => ({
                  value: s.id,
                  label: `${sessionTitle(s)}${s.repo?.branch ? ` (${s.repo.branch})` : ''}`,
                })),
              ]}
              error={shown.from}
            />
          ) : (
            <p className="muted">No other session works in this repository.</p>
          )
        ) : (
          <>
            <TextArea
              id={`${id}-patch`}
              label="Patch"
              value={patch}
              rows={6}
              error={shown.patch}
              onChange={setPatch}
            />
            <TextField
              label="Made against commit (optional)"
              value={base}
              autoComplete="off"
              spellCheck={false}
              placeholder={session.repo?.head ?? 'HEAD'}
              hint="Without it, the session’s current commit."
              error={shown.base}
              onChange={(e) => setBase(e.target.value)}
            />
          </>
        )}
        <RadioGroup
          legend="If files conflict"
          name={`${id}-mode`}
          value={mode}
          onChange={(v) => setMode(v as MergeConflictMode)}
          options={[
            {
              value: 'refuse',
              label: 'Write nothing and show the conflicts',
              description: 'The safe choice: the session’s files stay as they are.',
            },
            {
              value: 'markers',
              label: 'Write conflict markers to resolve',
              description: 'Commits wait until you resolve or abort the merge.',
            },
          ]}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (source === 'session' && remote)}
          >
            {busy ? <Spinner /> : null} Merge
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function sameRepo(a: CodeSessionView, b: CodeSessionView): boolean {
  return !!a.repo && !!b.repo && a.repo.root === b.repo.root;
}
