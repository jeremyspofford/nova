// The Checks pane of a Code session (FR-068, docs/10 §7, §14): auto-verify runs the project's
// build and test checks in the sandbox after a turn edits files, and Run checks runs them now.
// Each run shows every check with its command, result, exit code, time and log (redacted and
// capped by the Hub; drawn as text). Failed automatic runs go back to the agent as a turn, up to
// the feedback-turns count in Settings → Code. `code.verify.*` events keep it current.
import { useCallback, useEffect, useState } from 'react';
import type { VerifyRunView } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { useCoalesced } from './events.ts';
import {
  CHECK_ICON,
  CHECK_TEXT,
  VERIFY_ICON,
  VERIFY_TEXT,
  VERIFY_TONE,
  errorReason,
  formatDuration,
} from './m6-format.ts';
import { Badge, ErrorBanner } from './parts.tsx';

/** How often a running verify run is read, besides its completion event. */
export const VERIFY_POLL_MS = 1500;
export const CHECKS_TEXT = defineMessages('code.checks', {
  loadFailed: 'Could not load the checks.',
  status: '{status}.',
  started: 'Checks started.',
  alreadyRunning: 'The checks are already running.',
  runFailed: 'Could not run the checks: {reason}',
  title: 'Checks',
  autoOn: 'Auto-verify is on: the checks run after each turn that edits files.',
  feedback:
    '{n, plural, =1 {Failed checks go back to the agent once in a row at most.} =2 {Failed checks go back to the agent twice in a row at most.} =3 {Failed checks go back to the agent three times in a row at most.} other {Failed checks go back to the agent # times in a row at most.}}',
  noFeedback: 'Failed checks are not sent back to the agent.',
  autoOff: 'Auto-verify is off: the checks run only when you run them.',
  change: 'Change in Settings → Code',
  run: 'Run checks',
  loading: 'Loading the checks',
  emptyTitle: 'No checks yet',
  runs: 'Runs {commands}.',
  finds:
    'Nova finds the build and test commands of the project, or uses the ones set in Settings → Code.',
  latest: 'Latest',
  earlier: 'Earlier runs ({n})',
  runLabel: 'Checks: {heading}',
  afterEdit: 'After an edit',
  byYou: 'Run by you',
  trigger: '{trigger} · {when}',
  running: 'Running the checks…',
  results: 'Check results',
  exit: 'exit {code} · {duration}',
  logOf: 'Log of {name}',
});
/** Earlier runs listed under the latest one. */
const HISTORY = 10;

export function ChecksPane({
  sessionId,
  visible,
  version,
}: {
  sessionId: string;
  visible: boolean;
  /** Bumped by the session view on each `code.verify.*` event for this session. */
  version: number;
}) {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const cfg = useSettings().get('code.autoVerify').value;
  const [runs, setRuns] = useState<VerifyRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(
    () =>
      m6.listVerifyRuns(sessionId).then(
        ({ items }) => {
          setRuns(
            [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, HISTORY + 1),
          );
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, CHECKS_TEXT.loadFailed)),
      ),
    [m6, sessionId],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible, version]);

  const latest = runs?.[0] ?? null;
  useInterval(
    () => {
      if (!latest) return;
      m6.getVerifyRun(sessionId, latest.id).then(
        (r) => {
          setRuns((list) => list?.map((x) => (x.id === r.id ? r : x)) ?? [r]);
          if (r.status !== 'running')
            announce(CHECKS_TEXT.status({ status: VERIFY_TEXT[r.status] }));
        },
        () => undefined,
      );
    },
    VERIFY_POLL_MS,
    visible && latest?.status === 'running',
  );

  const run = async () => {
    setStarting(true);
    try {
      const r = await m6.runVerify(sessionId);
      setRuns((list) => [r, ...(list ?? []).filter((x) => x.id !== r.id)]);
      announce(
        r.status === 'running'
          ? CHECKS_TEXT.started
          : CHECKS_TEXT.status({ status: VERIFY_TEXT[r.status] }),
      );
    } catch (err) {
      toast.show(
        errorReason(err) === 'verify_running'
          ? CHECKS_TEXT.alreadyRunning
          : CHECKS_TEXT.runFailed({ reason: errorMessage(err) }),
        { tone: 'error' },
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="code-checks-pane" aria-label={CHECKS_TEXT.title}>
      <div className="code-subhead">
        <p className="ws-flush">
          {cfg.enabled ? (
            <>
              {CHECKS_TEXT.autoOn}{' '}
              {cfg.feedbackTurns
                ? CHECKS_TEXT.feedback({ n: cfg.feedbackTurns })
                : CHECKS_TEXT.noFeedback}
            </>
          ) : (
            CHECKS_TEXT.autoOff
          )}{' '}
          <AppLink to="/settings/code">{CHECKS_TEXT.change}</AppLink>
        </p>
        <Button
          variant="primary"
          disabled={starting || latest?.status === 'running'}
          onClick={() => void run()}
        >
          {starting ? <Spinner /> : <Icon name="check" />} {CHECKS_TEXT.run}
        </Button>
      </div>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {runs === null && !error ? <Spinner label={CHECKS_TEXT.loading} /> : null}
      {runs?.length === 0 ? (
        <EmptyState
          level={3}
          title={CHECKS_TEXT.emptyTitle}
          description={
            cfg.commands.length
              ? CHECKS_TEXT.runs({
                  commands: fmt.list(cfg.commands, { type: 'unit', style: 'short' }),
                })
              : CHECKS_TEXT.finds
          }
        />
      ) : null}
      {latest ? <RunCard run={latest} heading={CHECKS_TEXT.latest} open /> : null}
      {runs && runs.length > 1 ? (
        <details className="code-history">
          <summary>{CHECKS_TEXT.earlier({ n: runs.length - 1 })}</summary>
          {runs.slice(1).map((r) => (
            <RunCard key={r.id} run={r} heading={formatWhen(r.createdAt)} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

function RunCard({ run, heading, open }: { run: VerifyRunView; heading: string; open?: boolean }) {
  return (
    <article className="code-run" aria-label={CHECKS_TEXT.runLabel({ heading })}>
      <div className="code-run-head">
        <h3>{heading}</h3>
        <span aria-live={open ? 'polite' : undefined}>
          <Badge tone={VERIFY_TONE[run.status]} icon={VERIFY_ICON[run.status]}>
            {VERIFY_TEXT[run.status]}
          </Badge>
        </span>
        <span className="muted">
          {CHECKS_TEXT.trigger({
            trigger: run.trigger === 'auto' ? CHECKS_TEXT.afterEdit : CHECKS_TEXT.byYou,
            when: formatWhen(run.createdAt),
          })}
        </span>
      </div>
      {run.status === 'running' && !run.checks.length ? (
        <p className="muted">
          <Spinner /> {CHECKS_TEXT.running}
        </p>
      ) : null}
      <ul className="code-checks" aria-label={CHECKS_TEXT.results}>
        {run.checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="code-verify-check">
            <div className="code-run-head">
              <span className="code-check-name">{c.name}</span>
              <Badge
                tone={c.status === 'passed' ? 'ok' : c.status === 'skipped' ? 'muted' : 'danger'}
                icon={CHECK_ICON[c.status]}
              >
                {CHECK_TEXT[c.status]}
              </Badge>
              <span className="muted">
                {c.exitCode !== null
                  ? CHECKS_TEXT.exit({
                      code: String(c.exitCode),
                      duration: formatDuration(c.durationMs),
                    })
                  : formatDuration(c.durationMs)}
              </span>
            </div>
            <code className="code-cmd">{c.command}</code>
            {c.log ? (
              <details open={open && c.status !== 'passed' && c.status !== 'skipped'}>
                <summary>{CHECKS_TEXT.logOf({ name: c.name })}</summary>
                <pre className="ws-log">{c.log}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
