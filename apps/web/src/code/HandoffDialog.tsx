// Hand off a Code session (FR-213; docs/10 §15, §9): move it with its Git state (branch, HEAD,
// local commits, every uncommitted change as a patch) to another environment (this Hub, an SSH
// host, a device, the cloud) and folder there, or on the Hub to a new or existing worktree or back
// to the main checkout. The target must be clean and confirm the same commit and files before the
// session continues there; until then the source stays untouched, and afterwards it is kept or
// cleaned as chosen. A running turn ends first, or is interrupted on request. The dialog follows
// the move to its end and says why a refusal happened in plain words.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  CodeSessionView,
  SavedEnvironmentView,
  SessionHandoffView,
  WorktreeView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useInterval } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { useCodeM7Api, type HandoffBody } from './api-m7.ts';
import { NEW_SESSION_TEXT } from './NewSessionDialog.tsx';
import { Badge } from './parts.tsx';
import { KIND_LABEL, inRepo, isBindable } from './m6-format.ts';
import { HANDOFF_STATUS, codeM7ErrorMessage, handoffReasonText, shortHash } from './m7-format.ts';

export const HANDOFF_TEXT = defineMessages('code.handoff', {
  envsFailed: 'Could not load the environments.',
  moved: 'Moved to {target}.',
  refused: 'The move was refused.',
  notCompleted: 'The move was not completed.',
  where: {
    environment: 'Another environment',
    environmentHint: 'This Hub, an SSH host, a device or the cloud, in a folder there.',
    new: 'A new worktree',
    newHint: 'On its own nova/… branch next to your checkout.',
    main: 'The main checkout',
    mainHint: 'Back to the repository’s own folder.',
    existing: 'An existing worktree',
    existingHint: 'A worktree of this repository that no session holds.',
  },
  chooseEnv: 'Choose an environment.',
  envUnavailable: '{name} is unavailable.',
  envUnavailableBecause: '{name} is unavailable: {detail}.',
  enterFolder: 'Enter the repository’s folder there.',
  fullPath: 'Enter a full path that starts with /.',
  chooseWorktree: 'Choose a worktree.',
  moving: 'Moving the session to {target}.',
  startFailed: 'Could not start the move.',
  title: 'Hand off this session',
  body: 'Its branch, commits and uncommitted changes travel with it. It continues there only once the target has exactly the same state.',
  loading: 'Loading the environments',
  loadingDots: 'Loading environments…',
  noRepo:
    'This folder is not a Git repository, so its state cannot travel. The Hub will refuse the move.',
  moveTo: 'Move to',
  environment: 'Environment',
  chooseEnvOption: 'Choose an environment',
  thisHub: 'This Hub',
  envOption:
    '{status, select, ok {{name} ({kind})} degraded {{name} ({kind}), degraded} down {{name} ({kind}), unavailable} other {{name} ({kind}), not checked}}',
  folderOn: 'Repository folder on {name}',
  folderThere: 'Repository folder there',
  cloudHint: 'Cloud environments keep their repositories under /workspace.',
  cloneHint: 'A clone of the same repository, with no uncommitted changes.',
  worktree: 'Worktree',
  chooseWorktreeOption: 'Choose a worktree',
  dirtyBranch: '{branch} (uncommitted changes)',
  worktreeHint: 'A worktree with uncommitted changes cannot take the session.',
  sourceLegend: 'After the move, the changes here',
  keep: 'Keep them here too',
  keepHint: 'This folder stays as it is.',
  clean: 'Clean them up here',
  cleanHint: 'Only after the target confirmed it has them.',
  interrupt: 'Interrupt the running turn',
  interruptHint: 'Otherwise the move waits for the turn to end. The next turn waits for the move.',
  cancel: 'Cancel',
  move: 'Move session',
  doneTitle: 'Session moved',
  failedTitle: 'The session did not move',
  movingTitle: 'Moving the session',
  another: 'Choose another target',
  close: 'Close',
  closeKeep: 'Close and keep moving',
  waiting: 'Waiting for the running turn to end.',
  sending: 'Sending the Git state and checking it there.',
  continues: 'It continues in {folder}.',
  git: 'Commit {commit}, {files, plural, one {# changed file} other {# changed files}}{local, plural, =0 {} one {, # local commit} other {, # local commits}}. State {state}.',
  gitBranch:
    'Branch {branch}, commit {commit}, {files, plural, one {# changed file} other {# changed files}}{local, plural, =0 {} one {, # local commit} other {, # local commits}}. State {state}.',
  cleaned: 'The changes were cleaned up in the old folder.',
  stayed: 'The session stayed where it was.',
});

type Where = 'environment' | 'new' | 'main' | 'existing';

/** How often a move in progress is checked, besides its events. */
export const HANDOFF_POLL_MS = 2000;

/** Where a folder path in an environment of this kind usually is. */
export function folderPlaceholder(kind: SavedEnvironmentView['kind']): string {
  if (kind === 'cloud') return NEW_SESSION_TEXT.cloudPath;
  if (kind === 'local' || kind === 'container') return NEW_SESSION_TEXT.hubPath;
  return NEW_SESSION_TEXT.remotePath;
}

export function HandoffDialog({
  open,
  session,
  hubLocal,
  onClose,
  onFinished,
}: {
  open: boolean;
  session: CodeSessionView;
  /** The session's folder is on the Hub (worktree moves are possible). */
  hubLocal: boolean;
  onClose: () => void;
  onFinished: (v: SessionHandoffView) => void;
}) {
  if (!open) return null;
  return (
    <HandoffForm session={session} hubLocal={hubLocal} onClose={onClose} onFinished={onFinished} />
  );
}

function HandoffForm({
  session,
  hubLocal,
  onClose,
  onFinished,
}: {
  session: CodeSessionView;
  hubLocal: boolean;
  onClose: () => void;
  onFinished: (v: SessionHandoffView) => void;
}) {
  const m6 = useCodeM6Api();
  const m7 = useCodeM7Api();
  const settings = useSettings();
  const announce = useAnnounce();
  const id = `ho${useId()}`;
  const [envs, setEnvs] = useState<SavedEnvironmentView[] | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [where, setWhere] = useState<Where>('environment');
  const [envId, setEnvId] = useState('');
  const [folder, setFolder] = useState('');
  const [worktreeId, setWorktreeId] = useState('');
  const [source, setSource] = useState<'keep' | 'clean'>(settings.get('code.handoffSource').value);
  const [interrupt, setInterrupt] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [move, setMove] = useState<SessionHandoffView | null>(null);

  useEffect(() => {
    let alive = true;
    m6.listSavedEnvironments().then(
      ({ items }) => alive && setEnvs(items),
      (err: unknown) => {
        if (!alive) return;
        setEnvs([]);
        setLoadError(codeM7ErrorMessage(err, HANDOFF_TEXT.envsFailed));
      },
    );
    if (hubLocal)
      m6.listWorktrees({ status: 'active' }).then(
        ({ items }) => alive && setWorktrees(items),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [hubLocal, m6]);

  // Follow the move to its end (announced and reported once).
  const ended = useRef(false);
  const settle = (v: SessionHandoffView) => {
    setMove(v);
    if (ended.current) return;
    if (v.status === 'completed') {
      ended.current = true;
      announce(HANDOFF_TEXT.moved({ target: v.toLabel }));
      onFinished(v);
    } else if (v.status === 'refused' || v.status === 'failed') {
      ended.current = true;
      announce(v.status === 'refused' ? HANDOFF_TEXT.refused : HANDOFF_TEXT.notCompleted);
      onFinished(v);
    }
  };
  const live = move && (move.status === 'pending' || move.status === 'running');
  const refresh = () => {
    if (!move) return;
    m7.getHandoff(move.id).then(settle, () => undefined);
  };
  useHubStream(['session.handedOff'], (env) => {
    if (move && env.payload.handoffId === move.id) refresh();
  });
  useInterval(refresh, HANDOFF_POLL_MS, !!live);

  const env = envs?.find((e) => e.id === envId) ?? null;
  const repo = session.repo?.root ?? null;
  const bindable =
    hubLocal && repo
      ? worktrees.filter(
          (w) => isBindable(w) && inRepo(repo, w.repoPath) && w.id !== session.worktreeId,
        )
      : [];
  const options: { value: Where; label: string; description: string }[] = [
    {
      value: 'environment',
      label: HANDOFF_TEXT.where.environment,
      description: HANDOFF_TEXT.where.environmentHint,
    },
  ];
  if (hubLocal && repo) {
    options.push({
      value: 'new',
      label: HANDOFF_TEXT.where.new,
      description: HANDOFF_TEXT.where.newHint,
    });
    if (session.worktreeId)
      options.push({
        value: 'main',
        label: HANDOFF_TEXT.where.main,
        description: HANDOFF_TEXT.where.mainHint,
      });
    if (bindable.length)
      options.push({
        value: 'existing',
        label: HANDOFF_TEXT.where.existing,
        description: HANDOFF_TEXT.where.existingHint,
      });
  }

  const problems: Record<string, string> = {};
  if (where === 'environment') {
    if (!env) problems.env = HANDOFF_TEXT.chooseEnv;
    else if (env.status === 'down')
      problems.env = env.detail
        ? HANDOFF_TEXT.envUnavailableBecause({ name: env.label, detail: env.detail })
        : HANDOFF_TEXT.envUnavailable({ name: env.label });
    if (!folder.trim()) problems.folder = HANDOFF_TEXT.enterFolder;
    else if (!folder.trim().startsWith('/')) problems.folder = HANDOFF_TEXT.fullPath;
  }
  if (where === 'existing' && !worktreeId) problems.worktree = HANDOFF_TEXT.chooseWorktree;
  const shown = tried ? problems : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy) return;
    setBusy(true);
    setError(null);
    const to: HandoffBody['to'] =
      where === 'environment'
        ? { environmentId: envId, folder: folder.trim() }
        : where === 'existing'
          ? { worktree: worktreeId }
          : { worktree: where };
    try {
      const v = await m7.handoffCodeSession(session.id, {
        to,
        source,
        ...(interrupt ? { interrupt: true } : {}),
      });
      announce(HANDOFF_TEXT.moving({ target: v.toLabel }));
      settle(v);
    } catch (err) {
      setError(codeM7ErrorMessage(err, HANDOFF_TEXT.startFailed));
    } finally {
      setBusy(false);
    }
  };

  if (move)
    return (
      <HandoffProgress
        move={move}
        onClose={onClose}
        onRetry={() => {
          ended.current = false;
          setMove(null);
        }}
      />
    );

  const running = session.derived.status === 'running';
  return (
    <Dialog
      open
      title={HANDOFF_TEXT.title}
      description={HANDOFF_TEXT.body}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      {envs === null ? (
        <p className="muted">
          <Spinner label={HANDOFF_TEXT.loading} /> {HANDOFF_TEXT.loadingDots}
        </p>
      ) : (
        <form
          id={id}
          className="stack cm7-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {loadError ? (
            <p className="nv-field-error" role="alert">
              {loadError}
            </p>
          ) : null}
          {!repo ? (
            <p className="ws-callout" role="note">
              <Icon name="alert" />
              <span>{HANDOFF_TEXT.noRepo}</span>
            </p>
          ) : null}
          {options.length > 1 ? (
            <RadioGroup
              legend={HANDOFF_TEXT.moveTo}
              name={`${id}-where`}
              value={where}
              onChange={(v) => setWhere(v as Where)}
              options={options}
            />
          ) : null}
          {where === 'environment' ? (
            <>
              <SelectField
                label={HANDOFF_TEXT.environment}
                value={envId}
                onChange={setEnvId}
                options={[
                  { value: '', label: HANDOFF_TEXT.chooseEnvOption },
                  ...envs.map((e) => ({
                    value: e.id,
                    label: HANDOFF_TEXT.envOption({
                      name: e.label,
                      kind: e.builtIn ? HANDOFF_TEXT.thisHub : KIND_LABEL[e.kind],
                      status: e.status,
                    }),
                    disabled: e.status === 'down',
                    ...(e.detail ? { title: e.detail } : {}),
                  })),
                ]}
                error={shown.env}
              />
              <TextField
                label={env ? HANDOFF_TEXT.folderOn({ name: env.label }) : HANDOFF_TEXT.folderThere}
                value={folder}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                placeholder={folderPlaceholder(env?.kind ?? 'local')}
                hint={env?.kind === 'cloud' ? HANDOFF_TEXT.cloudHint : HANDOFF_TEXT.cloneHint}
                error={shown.folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </>
          ) : null}
          {where === 'existing' ? (
            <SelectField
              label={HANDOFF_TEXT.worktree}
              value={worktreeId}
              onChange={setWorktreeId}
              options={[
                { value: '', label: HANDOFF_TEXT.chooseWorktreeOption },
                ...bindable.map((w) => ({
                  value: w.id,
                  label: w.dirty ? HANDOFF_TEXT.dirtyBranch({ branch: w.branch }) : w.branch,
                  disabled: w.dirty === true,
                })),
              ]}
              hint={HANDOFF_TEXT.worktreeHint}
              error={shown.worktree}
            />
          ) : null}
          <RadioGroup
            legend={HANDOFF_TEXT.sourceLegend}
            name={`${id}-source`}
            value={source}
            onChange={(v) => setSource(v as 'keep' | 'clean')}
            options={[
              {
                value: 'keep',
                label: HANDOFF_TEXT.keep,
                description: HANDOFF_TEXT.keepHint,
              },
              {
                value: 'clean',
                label: HANDOFF_TEXT.clean,
                description: HANDOFF_TEXT.cleanHint,
              },
            ]}
          />
          {running ? (
            <label className="cl-check">
              <input
                type="checkbox"
                checked={interrupt}
                aria-describedby={`${id}-int`}
                onChange={(e) => setInterrupt(e.target.checked)}
              />
              {HANDOFF_TEXT.interrupt}
            </label>
          ) : null}
          {running ? (
            <span id={`${id}-int`} className="nv-field-hint">
              {HANDOFF_TEXT.interruptHint}
            </span>
          ) : null}
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{HANDOFF_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="forward" />} {HANDOFF_TEXT.move}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function HandoffProgress({
  move,
  onClose,
  onRetry,
}: {
  move: SessionHandoffView;
  onClose: () => void;
  onRetry: () => void;
}) {
  const s = HANDOFF_STATUS[move.status];
  const why = handoffReasonText(move);
  const done = move.status === 'completed';
  const over = done || move.status === 'refused' || move.status === 'failed';
  return (
    <Dialog
      open
      title={
        done ? HANDOFF_TEXT.doneTitle : over ? HANDOFF_TEXT.failedTitle : HANDOFF_TEXT.movingTitle
      }
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          {over && !done ? <Button onClick={onRetry}>{HANDOFF_TEXT.another}</Button> : null}
          <Button variant={over ? 'primary' : 'default'} onClick={onClose}>
            {over ? HANDOFF_TEXT.close : HANDOFF_TEXT.closeKeep}
          </Button>
        </>
      }
    >
      <div className="stack" role="status" aria-live="polite">
        <p className="cm7-move">
          <span>{move.fromLabel}</span> <Icon name="forward" /> <span>{move.toLabel}</span>
        </p>
        <p>
          <Badge tone={s.tone} icon={s.icon}>
            {s.text}
          </Badge>{' '}
          {move.status === 'pending'
            ? HANDOFF_TEXT.waiting
            : move.status === 'running'
              ? HANDOFF_TEXT.sending
              : done
                ? HANDOFF_TEXT.continues({ folder: move.folder ?? move.toLabel })
                : null}
        </p>
        {why ? (
          <p className="cl-notice" data-tone="danger">
            <Icon name="alert" />
            <span>{why}</span>
          </p>
        ) : null}
        {move.detail && !done ? (
          <p className="muted cl-small" dir="auto">
            {move.detail}
          </p>
        ) : null}
        {move.git ? (
          <p className="muted cl-small">
            {(() => {
              const g = {
                commit: shortHash(move.git.head, 7),
                files: move.git.files,
                local: move.git.bundleCommits ?? 0,
                state: shortHash(move.git.stateHash),
              };
              return move.git.branch
                ? HANDOFF_TEXT.gitBranch({ ...g, branch: move.git.branch })
                : HANDOFF_TEXT.git(g);
            })()}
          </p>
        ) : null}
        {done && move.source === 'clean' ? (
          <p className="muted cl-small">{HANDOFF_TEXT.cleaned}</p>
        ) : null}
        {over && !done ? <p className="muted cl-small">{HANDOFF_TEXT.stayed}</p> : null}
      </div>
    </Dialog>
  );
}
