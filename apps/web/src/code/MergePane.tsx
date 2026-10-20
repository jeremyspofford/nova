// Merges into a session (FR-073; docs/10 §9, §14): bring in another session's work (a worker, an
// attempt) or a patch onto this session's folder with a three-way merge. By default a conflict
// writes nothing and the merge is shown with each conflicting file's three sides (base, this
// session, the work); with conflict markers the files get them, commits wait, and the merge is
// resolved (once no markers are left) or aborted (the files go back as they were). A conflict is
// never resolved silently; Ask the agent sends the conflicting paths to the session's agent.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
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
import { formatWhen } from '../settings/common.ts';
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

export const MERGE_TEXT = defineMessages('code.merge', {
  intro:
    'Bring another session’s work or a patch into this session. Conflicts are shown with their three sides; nothing is resolved without you.',
  mergeIn: 'Merge in…',
  loadFailed: 'Could not load the merges.',
  retry: 'Retry',
  loading: 'Loading the merges',
  emptyTitle: 'No merges yet',
  emptyBody: 'Merge a worker’s or an attempt’s work, or apply a patch onto a branch that moved.',
  list: 'Merges',
  rowLabel: '{source}, {status}',
  rowTitle: '{source} · {when}',
  files: '{n, plural, one {# file} other {# files}}',
  conflicts: '{n, plural, one {# conflict} other {# conflicts}}',
  mergedConflicts:
    '{n, plural, one {Merged with # conflict to resolve.} other {Merged with # conflicts to resolve.}}',
  merged: 'Merged.',
  refused:
    '{n, plural, one {Nothing was written: # file conflicts with this session ({paths}). Open the merge to see the three sides.} other {Nothing was written: # files conflict with this session ({paths}). Open the merge to see the three sides.}}',
  refusedAnnounce: 'The merge was refused because of conflicts.',
  resolved: 'Merge resolved. Commits can go ahead.',
  markersLeft: 'Conflict markers are still in {paths}. Edit them out, then try again.',
  resolveFailed: 'Could not mark the merge resolved.',
  mergeFailed: 'Could not merge.',
  /** Sent to the agent by "Ask the agent to resolve". */
  askAgent:
    'Resolve the merge conflicts in {paths}: keep the intent of both sides, remove every conflict marker, and run the tests. Tell me what you chose where it was not obvious.',
  sent: 'Sent to the agent.',
  sendFailed: 'Could not send it: {reason}',
  filesList: 'Files in this merge',
  places: '{result} ({n} places)',
  markersNote:
    'The files have conflict markers. Edit them out (in the File tab, or ask the agent), then mark the merge resolved. Commits wait until then.',
  markResolved: 'Mark resolved',
  askResolve: 'Ask the agent to resolve',
  abort: 'Abort merge…',
  withMarkers: 'Merge with conflict markers',
  abortTitle: 'Abort this merge?',
  abortBody:
    'The files go back to how they were before the merge, including any edits made to resolve it.',
  abortConfirm: 'Abort merge',
  abortFailed: 'Could not abort the merge.',
  aborted: 'Merge aborted.',
  binary:
    'A binary file (or a link) changed on both sides. It is never merged; keep one side by hand.',
  notThere: 'Not there on this side.',
  sideOf: '{path}: {side}',
  base: 'Base',
  ours: 'This session',
  theirs: 'The work',
  withMarkersNow: 'With conflict markers, as in the file now',
  markersOf: '{path} with conflict markers',
  cutShort: 'Long sides are cut short here.',
  chooseSession: 'Choose the session whose work to merge.',
  pastePatch: 'Paste a unified patch (git diff output).',
  commitHash: 'Enter a commit hash: 7 to 64 characters, 0-9 and a-f.',
  dialogTitle: 'Merge into this session',
  dialogBody: 'A three-way merge onto this session’s files. Nothing is committed.',
  from: 'Merge from',
  fromSession: 'Another session',
  fromSessionRemote: 'Only when both sessions’ folders are on the Hub.',
  fromSessionHint: 'A worker or another session in the same repository.',
  fromPatch: 'A patch',
  fromPatchHint: 'Unified diff text, such as git diff output.',
  remote: 'Merging sessions needs both folders on the Hub. This session is on another machine.',
  loadingSessions: 'Loading the sessions',
  loadingSessionsDots: 'Loading sessions…',
  session: 'Session',
  choose: 'Choose a session',
  sessionBranch: '{title} ({branch})',
  noOthers: 'No other session works in this repository.',
  patch: 'Patch',
  madeAgainst: 'Made against commit (optional)',
  madeAgainstHint: 'Without it, the session’s current commit.',
  head: 'HEAD',
  ifConflict: 'If files conflict',
  refuse: 'Write nothing and show the conflicts',
  refuseHint: 'The safe choice: the session’s files stay as they are.',
  markers: 'Write conflict markers to resolve',
  markersHint: 'Commits wait until you resolve or abort the merge.',
  cancel: 'Cancel',
  merge: 'Merge',
});

const joinPaths = (paths: readonly string[]) => fmt.list(paths, { type: 'unit', style: 'short' });

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
        <p className="muted ws-flush">{MERGE_TEXT.intro}</p>
        <Button onClick={() => setMerging(true)}>
          <Icon name="branch" /> {MERGE_TEXT.mergeIn}
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
          <p>{codeM7ErrorMessage(list.error, MERGE_TEXT.loadFailed)}</p>
          <Button onClick={list.reload}>{MERGE_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={MERGE_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={MERGE_TEXT.emptyTitle}
          description={MERGE_TEXT.emptyBody}
          icon="branch"
        />
      ) : null}
      {items?.length ? (
        <ul className="cm7-list" aria-label={MERGE_TEXT.list}>
          {items.map((m) => (
            <li
              key={m.id}
              className="cm7-row"
              aria-label={MERGE_TEXT.rowLabel({
                source: MERGE_SOURCE[m.source.kind],
                status: MERGE_STATUS[m.status].text,
              })}
            >
              <span className="cm7-row-title">
                <button
                  type="button"
                  className="cl-link"
                  aria-expanded={shown === m.id}
                  onClick={() => setOpen(shown === m.id ? '' : m.id)}
                >
                  {MERGE_TEXT.rowTitle({
                    source: MERGE_SOURCE[m.source.kind],
                    when: formatWhen(m.createdAt),
                  })}
                </button>
                <Badge tone={MERGE_STATUS[m.status].tone} icon={MERGE_STATUS[m.status].icon}>
                  {MERGE_STATUS[m.status].text}
                </Badge>
              </span>
              <span className="muted ws-row-meta">
                <span>{MERGE_TEXT.files({ n: m.files.length })}</span>
                {m.conflicts.length ? (
                  <span>{MERGE_TEXT.conflicts({ n: m.conflicts.length })}</span>
                ) : null}
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
              ? MERGE_TEXT.mergedConflicts({ n: m.conflicts.length })
              : MERGE_TEXT.merged,
          );
          onChanged();
        }}
        onRefused={(mergeId, paths) => {
          setMerging(false);
          setNotice(MERGE_TEXT.refused({ n: paths.length, paths: joinPaths(paths) }));
          list.reload();
          if (mergeId) setOpen(mergeId);
          announce(MERGE_TEXT.refusedAnnounce);
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
      announce(MERGE_TEXT.resolved);
    } catch (err) {
      const paths = conflictPaths(err);
      setError(
        paths.length
          ? MERGE_TEXT.markersLeft({ paths: joinPaths(paths) })
          : codeM7ErrorMessage(err, MERGE_TEXT.resolveFailed),
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
      setError(codeM7ErrorMessage(err, MERGE_TEXT.mergeFailed));
    } finally {
      setBusy(false);
    }
  };

  const askAgent = async () => {
    const paths = conflictFiles.map((f) => f.path);
    try {
      await api.sendMessage(session.threadId, {
        text: MERGE_TEXT.askAgent({ paths: joinPaths(paths) }),
      });
      toast.show(MERGE_TEXT.sent, { tone: 'success' });
    } catch (err) {
      toast.show(MERGE_TEXT.sendFailed({ reason: codeM7ErrorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <div className="cm7-detail">
      <ul className="cm7-files" aria-label={MERGE_TEXT.filesList}>
        {merge.files.map((f) => (
          <li key={f.path} data-conflict={isConflict(f.result) || undefined}>
            <Icon name={isConflict(f.result) ? 'alert' : 'file'} />
            <code className="cl-break">{f.path}</code>
            <span className="muted cl-small">
              {f.conflicts > 1
                ? MERGE_TEXT.places({ result: FILE_RESULT[f.result], n: f.conflicts })
                : FILE_RESULT[f.result]}
            </span>
          </li>
        ))}
      </ul>
      {merge.conflicts.map((c) => (
        <ThreeWay key={c.path} c={c} status={merge.status} />
      ))}
      {merge.status === 'conflicted' ? (
        <p className="muted cl-small">{MERGE_TEXT.markersNote}</p>
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
              {busy ? <Spinner /> : <Icon name="check" />} {MERGE_TEXT.markResolved}
            </Button>
            <Button onClick={() => void askAgent()}>
              <Icon name="send" /> {MERGE_TEXT.askResolve}
            </Button>
            <Button variant="danger" onClick={() => setAborting(true)}>
              <Icon name="undo" /> {MERGE_TEXT.abort}
            </Button>
          </>
        ) : null}
        {merge.status === 'refused' && merge.source.ref && merge.source.kind !== 'patch' ? (
          <Button disabled={busy} onClick={() => void remergeWithMarkers()}>
            {busy ? <Spinner /> : null} {MERGE_TEXT.withMarkers}
          </Button>
        ) : null}
      </div>
      <ConfirmAction
        open={aborting}
        title={MERGE_TEXT.abortTitle}
        description={MERGE_TEXT.abortBody}
        confirmLabel={MERGE_TEXT.abortConfirm}
        danger
        errorText={(err) => codeM7ErrorMessage(err, MERGE_TEXT.abortFailed)}
        onClose={() => setAborting(false)}
        onConfirm={async () => {
          const next = await m7.abortMerge(session.id, merge.id);
          setAborting(false);
          onChanged(next);
          announce(MERGE_TEXT.aborted);
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
        <p className="muted cl-small">{MERGE_TEXT.binary}</p>
      </section>
    );
  const side = (label: string, text: string | null) => (
    <div className="cm7-side">
      <span className="cm7-side-label">{label}</span>
      {text === null ? (
        <p className="muted cl-small">{MERGE_TEXT.notThere}</p>
      ) : (
        <TextBlock text={text} label={MERGE_TEXT.sideOf({ path: c.path, side: label })} />
      )}
    </div>
  );
  return (
    <section className="cm7-threeway" aria-labelledby={id}>
      <h4 id={id} className="cm7-file-title">
        <code className="cl-break">{c.path}</code>
      </h4>
      <div className="cm7-sides">
        {side(MERGE_TEXT.base, c.base)}
        {side(MERGE_TEXT.ours, c.ours)}
        {side(MERGE_TEXT.theirs, c.theirs)}
      </div>
      {c.merged !== null && status === 'conflicted' ? (
        <details className="ws-advanced">
          <summary>{MERGE_TEXT.withMarkersNow}</summary>
          <TextBlock text={c.merged} label={MERGE_TEXT.markersOf({ path: c.path })} />
        </details>
      ) : null}
      {c.truncated ? <p className="muted cl-small">{MERGE_TEXT.cutShort}</p> : null}
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
  if (source === 'session' && !from) problems.from = MERGE_TEXT.chooseSession;
  if (source === 'patch' && !patch.trim()) problems.patch = MERGE_TEXT.pastePatch;
  if (source === 'patch' && base.trim() && !/^[0-9a-f]{7,64}$/.test(base.trim()))
    problems.base = MERGE_TEXT.commitHash;
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
      setError(codeM7ErrorMessage(err, MERGE_TEXT.mergeFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={MERGE_TEXT.dialogTitle}
      description={MERGE_TEXT.dialogBody}
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
          legend={MERGE_TEXT.from}
          name={`${id}-src`}
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={[
            {
              value: 'session',
              label: MERGE_TEXT.fromSession,
              description: remote ? MERGE_TEXT.fromSessionRemote : MERGE_TEXT.fromSessionHint,
            },
            {
              value: 'patch',
              label: MERGE_TEXT.fromPatch,
              description: MERGE_TEXT.fromPatchHint,
            },
          ]}
        />
        {source === 'session' ? (
          remote ? (
            <p className="ws-callout" role="note">
              <Icon name="alert" />
              <span>{MERGE_TEXT.remote}</span>
            </p>
          ) : others === null ? (
            <p className="muted">
              <Spinner label={MERGE_TEXT.loadingSessions} /> {MERGE_TEXT.loadingSessionsDots}
            </p>
          ) : others.length ? (
            <SelectField
              label={MERGE_TEXT.session}
              value={from}
              onChange={setFrom}
              options={[
                { value: '', label: MERGE_TEXT.choose },
                ...others.map((s) => ({
                  value: s.id,
                  label: s.repo?.branch
                    ? MERGE_TEXT.sessionBranch({ title: sessionTitle(s), branch: s.repo.branch })
                    : sessionTitle(s),
                })),
              ]}
              error={shown.from}
            />
          ) : (
            <p className="muted">{MERGE_TEXT.noOthers}</p>
          )
        ) : (
          <>
            <TextArea
              id={`${id}-patch`}
              label={MERGE_TEXT.patch}
              value={patch}
              rows={6}
              error={shown.patch}
              onChange={setPatch}
            />
            <TextField
              label={MERGE_TEXT.madeAgainst}
              value={base}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={session.repo?.head ?? MERGE_TEXT.head}
              hint={MERGE_TEXT.madeAgainstHint}
              error={shown.base}
              onChange={(e) => setBase(e.target.value)}
            />
          </>
        )}
        <RadioGroup
          legend={MERGE_TEXT.ifConflict}
          name={`${id}-mode`}
          value={mode}
          onChange={(v) => setMode(v as MergeConflictMode)}
          options={[
            {
              value: 'refuse',
              label: MERGE_TEXT.refuse,
              description: MERGE_TEXT.refuseHint,
            },
            {
              value: 'markers',
              label: MERGE_TEXT.markers,
              description: MERGE_TEXT.markersHint,
            },
          ]}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{MERGE_TEXT.cancel}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (source === 'session' && remote)}
          >
            {busy ? <Spinner /> : null} {MERGE_TEXT.merge}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function sameRepo(a: CodeSessionView, b: CodeSessionView): boolean {
  return !!a.repo && !!b.repo && a.repo.root === b.repo.root;
}
