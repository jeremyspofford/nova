// The Checks pane of a Code session (FR-068, docs/10 §7, §14): auto-verify runs the project's
// build and test checks in the sandbox after a turn edits files, and Run checks runs them now.
// Each run shows every check with its command, result, exit code, time and log (redacted and
// capped by the Hub; drawn as text). Failed automatic runs go back to the agent as a turn, up to
// the feedback-turns count in Settings → Code. `code.verify.*` events keep it current.
import { useCallback, useEffect, useState } from 'react';
import type { VerifyRunView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, plural, useInterval } from '../settings/common.ts';
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
const TIMES: Record<number, string> = { 1: 'once', 2: 'twice', 3: 'three times' };
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
        (err: unknown) => setError(errorMessage(err, 'Could not load the checks.')),
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
          if (r.status !== 'running') announce(`${VERIFY_TEXT[r.status]}.`);
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
      announce(r.status === 'running' ? 'Checks started.' : `${VERIFY_TEXT[r.status]}.`);
    } catch (err) {
      toast.show(
        errorReason(err) === 'verify_running'
          ? 'The checks are already running.'
          : `Could not run the checks: ${errorMessage(err)}`,
        { tone: 'error' },
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="code-checks-pane" aria-label="Checks">
      <div className="code-subhead">
        <p className="ws-flush">
          {cfg.enabled ? (
            <>
              Auto-verify is on: the checks run after each turn that edits files.{' '}
              {cfg.feedbackTurns
                ? `Failed checks go back to the agent ${TIMES[cfg.feedbackTurns] ?? plural(cfg.feedbackTurns, 'time')} in a row at most.`
                : 'Failed checks are not sent back to the agent.'}
            </>
          ) : (
            'Auto-verify is off: the checks run only when you run them.'
          )}{' '}
          <AppLink to="/settings/code">Change in Settings → Code</AppLink>
        </p>
        <Button
          variant="primary"
          disabled={starting || latest?.status === 'running'}
          onClick={() => void run()}
        >
          {starting ? <Spinner /> : <Icon name="check" />} Run checks
        </Button>
      </div>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {runs === null && !error ? <Spinner label="Loading the checks" /> : null}
      {runs?.length === 0 ? (
        <EmptyState
          level={3}
          title="No checks yet"
          description={
            cfg.commands.length
              ? `Runs ${cfg.commands.join(', ')}.`
              : 'Nova finds the build and test commands of the project, or uses the ones set in Settings → Code.'
          }
        />
      ) : null}
      {latest ? <RunCard run={latest} heading="Latest" open /> : null}
      {runs && runs.length > 1 ? (
        <details className="code-history">
          <summary>Earlier runs ({runs.length - 1})</summary>
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
    <article className="code-run" aria-label={`Checks: ${heading}`}>
      <div className="code-run-head">
        <h3>{heading}</h3>
        <span aria-live={open ? 'polite' : undefined}>
          <Badge tone={VERIFY_TONE[run.status]} icon={VERIFY_ICON[run.status]}>
            {VERIFY_TEXT[run.status]}
          </Badge>
        </span>
        <span className="muted">
          {run.trigger === 'auto' ? 'After an edit' : 'Run by you'} · {formatWhen(run.createdAt)}
        </span>
      </div>
      {run.status === 'running' && !run.checks.length ? (
        <p className="muted">
          <Spinner /> Running the checks…
        </p>
      ) : null}
      <ul className="code-checks" aria-label="Check results">
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
                {c.exitCode !== null ? `exit ${c.exitCode} · ` : ''}
                {formatDuration(c.durationMs)}
              </span>
            </div>
            <code className="code-cmd">{c.command}</code>
            {c.log ? (
              <details open={open && c.status !== 'passed' && c.status !== 'skipped'}>
                <summary>Log of {c.name}</summary>
                <pre className="ws-log">{c.log}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
