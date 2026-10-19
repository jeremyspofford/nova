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
import { Button, Dialog, Icon, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useInterval } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { useCodeM7Api, type HandoffBody } from './api-m7.ts';
import { Badge } from './parts.tsx';
import { HEALTH_TEXT, KIND_LABEL, inRepo, isBindable } from './m6-format.ts';
import { HANDOFF_STATUS, codeM7ErrorMessage, handoffReasonText, shortHash } from './m7-format.ts';

type Where = 'environment' | 'new' | 'main' | 'existing';

/** How often a move in progress is checked, besides its events. */
export const HANDOFF_POLL_MS = 2000;

/** Where a folder path in an environment of this kind usually is. */
export function folderPlaceholder(kind: SavedEnvironmentView['kind']): string {
  if (kind === 'cloud') return '/workspace/app';
  if (kind === 'local' || kind === 'container') return '/home/me/projects/app';
  return '/home/me/src/app';
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
        setLoadError(codeM7ErrorMessage(err, 'Could not load the environments.'));
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
      announce(`Moved to ${v.toLabel}.`);
      onFinished(v);
    } else if (v.status === 'refused' || v.status === 'failed') {
      ended.current = true;
      announce(`The move was ${v.status === 'refused' ? 'refused' : 'not completed'}.`);
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
      label: 'Another environment',
      description: 'This Hub, an SSH host, a device or the cloud, in a folder there.',
    },
  ];
  if (hubLocal && repo) {
    options.push({
      value: 'new',
      label: 'A new worktree',
      description: 'On its own nova/… branch next to your checkout.',
    });
    if (session.worktreeId)
      options.push({
        value: 'main',
        label: 'The main checkout',
        description: 'Back to the repository’s own folder.',
      });
    if (bindable.length)
      options.push({
        value: 'existing',
        label: 'An existing worktree',
        description: 'A worktree of this repository that no session holds.',
      });
  }

  const problems: Record<string, string> = {};
  if (where === 'environment') {
    if (!env) problems.env = 'Choose an environment.';
    else if (env.status === 'down')
      problems.env = `${env.label} is unavailable${env.detail ? `: ${env.detail}` : ''}.`;
    if (!folder.trim()) problems.folder = 'Enter the repository’s folder there.';
    else if (!folder.trim().startsWith('/'))
      problems.folder = 'Enter a full path that starts with /.';
  }
  if (where === 'existing' && !worktreeId) problems.worktree = 'Choose a worktree.';
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
      announce(`Moving the session to ${v.toLabel}.`);
      settle(v);
    } catch (err) {
      setError(codeM7ErrorMessage(err, 'Could not start the move.'));
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
      title="Hand off this session"
      description="Its branch, commits and uncommitted changes travel with it. It continues there only once the target has exactly the same state."
      onClose={onClose}
      className="ws-wide-dialog"
    >
      {envs === null ? (
        <p className="muted">
          <Spinner label="Loading the environments" /> Loading environments…
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
              <span>
                This folder is not a Git repository, so its state cannot travel. The Hub will refuse
                the move.
              </span>
            </p>
          ) : null}
          {options.length > 1 ? (
            <RadioGroup
              legend="Move to"
              name={`${id}-where`}
              value={where}
              onChange={(v) => setWhere(v as Where)}
              options={options}
            />
          ) : null}
          {where === 'environment' ? (
            <>
              <SelectField
                label="Environment"
                value={envId}
                onChange={setEnvId}
                options={[
                  { value: '', label: 'Choose an environment' },
                  ...envs.map((e) => ({
                    value: e.id,
                    label: `${e.label} (${e.builtIn ? 'This Hub' : KIND_LABEL[e.kind]})${e.status === 'ok' ? '' : `, ${HEALTH_TEXT[e.status].toLowerCase()}`}`,
                    disabled: e.status === 'down',
                    ...(e.detail ? { title: e.detail } : {}),
                  })),
                ]}
                error={shown.env}
              />
              <TextField
                label={env ? `Repository folder on ${env.label}` : 'Repository folder there'}
                value={folder}
                autoComplete="off"
                spellCheck={false}
                placeholder={folderPlaceholder(env?.kind ?? 'local')}
                hint={
                  env?.kind === 'cloud'
                    ? 'Cloud environments keep their repositories under /workspace.'
                    : 'A clone of the same repository, with no uncommitted changes.'
                }
                error={shown.folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </>
          ) : null}
          {where === 'existing' ? (
            <SelectField
              label="Worktree"
              value={worktreeId}
              onChange={setWorktreeId}
              options={[
                { value: '', label: 'Choose a worktree' },
                ...bindable.map((w) => ({
                  value: w.id,
                  label: `${w.branch}${w.dirty ? ' (uncommitted changes)' : ''}`,
                  disabled: w.dirty === true,
                })),
              ]}
              hint="A worktree with uncommitted changes cannot take the session."
              error={shown.worktree}
            />
          ) : null}
          <RadioGroup
            legend="After the move, the changes here"
            name={`${id}-source`}
            value={source}
            onChange={(v) => setSource(v as 'keep' | 'clean')}
            options={[
              {
                value: 'keep',
                label: 'Keep them here too',
                description: 'This folder stays as it is.',
              },
              {
                value: 'clean',
                label: 'Clean them up here',
                description: 'Only after the target confirmed it has them.',
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
              Interrupt the running turn
            </label>
          ) : null}
          {running ? (
            <span id={`${id}-int`} className="nv-field-hint">
              Otherwise the move waits for the turn to end. The next turn waits for the move.
            </span>
          ) : null}
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="forward" />} Move session
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
      title={done ? 'Session moved' : over ? 'The session did not move' : 'Moving the session'}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          {over && !done ? <Button onClick={onRetry}>Choose another target</Button> : null}
          <Button variant={over ? 'primary' : 'default'} onClick={onClose}>
            {over ? 'Close' : 'Close and keep moving'}
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
            ? 'Waiting for the running turn to end.'
            : move.status === 'running'
              ? 'Sending the Git state and checking it there.'
              : done
                ? `It continues in ${move.folder ?? move.toLabel}.`
                : null}
        </p>
        {why ? (
          <p className="cl-notice" data-tone="danger">
            <Icon name="alert" />
            <span>{why}</span>
          </p>
        ) : null}
        {move.detail && !done ? <p className="muted cl-small">{move.detail}</p> : null}
        {move.git ? (
          <p className="muted cl-small">
            {move.git.branch ? `Branch ${move.git.branch}, ` : ''}commit{' '}
            {shortHash(move.git.head, 7)},{' '}
            {move.git.files === 1 ? '1 changed file' : `${move.git.files} changed files`}
            {move.git.bundleCommits ? `, ${move.git.bundleCommits} local commits` : ''}. State{' '}
            {shortHash(move.git.stateHash)}.
          </p>
        ) : null}
        {done && move.source === 'clean' ? (
          <p className="muted cl-small">The changes were cleaned up in the old folder.</p>
        ) : null}
        {over && !done ? <p className="muted cl-small">The session stayed where it was.</p> : null}
      </div>
    </Dialog>
  );
}
