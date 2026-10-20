// The run's result (FR-051, FR-187, docs/04 §2.3): the summary, its artifacts with previews (the
// chat's artifact viewer), and the evidence. A run that could not verify its declared output ends
// as Output missing with the trace linked, never as done. Sub-agents (FR-053, FR-054) list their
// role, task, status and a link to their thread.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ArtifactView, RunView, SubagentView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ArtifactViewer } from '../chat/Artifacts.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { chatPath } from '../router.ts';
import { useServices } from '../services.tsx';
import { ACTIVITY_ID } from './ActivityTrace.tsx';
import { RUN_STATUS_TEXT, SUBAGENT_ICON, SUBAGENT_TEXT, WORK_TEXT, webLink } from './format.ts';
import { followLink } from './nav.tsx';

/** Moves to the Activity section of the run page. */
export function showTrace(e: React.MouseEvent): void {
  e.preventDefault();
  const el = document.getElementById(ACTIVITY_ID);
  el?.scrollIntoView?.({ block: 'start' });
  el?.focus();
}

/** A run's result and its sub-agents. */
export const RESULT_TEXT = defineMessages('work.result', {
  heading: 'Result',
  /** {kind} is what the run declared it delivers. A "See the trace" link follows. */
  missing:
    '{kind, select, artifact {Output missing: the run could not verify its artifact, so it did not count as done.} message {Output missing: the run could not verify its delivered message, so it did not count as done.} file {Output missing: the run could not verify its file, so it did not count as done.} other {Output missing: the run could not verify its declared output, so it did not count as done.}}',
  /** As `missing`, with the output's declared name or path ({ref}). */
  missingRef:
    '{kind, select, artifact {Output missing: the run could not verify its artifact ({ref}), so it did not count as done.} message {Output missing: the run could not verify its delivered message ({ref}), so it did not count as done.} file {Output missing: the run could not verify its file ({ref}), so it did not count as done.} other {Output missing: the run could not verify its declared output ({ref}), so it did not count as done.}}',
  seeTrace: 'See the trace',
  failed: 'The run failed before it wrote a result.',
  cancelled: 'The run was cancelled. Partial work stays in the conversation.',
  noSummary: 'No summary.',
  artifacts: 'Artifacts',
  evidence: 'Evidence',
  newTab: '(opens in a new tab)',
  schedule: 'Schedule it',
  artifactFailed: 'Could not load the artifact.',
  artifactLoading: 'Loading the artifact',
  subagents: 'Sub-agents',
  /** A sub-agent's name for screen readers: its role and its task. */
  subagent: '{role}: {objective}',
  subagentResult: 'Result',
  openThread: 'Open thread',
  /** {role} is the sub-agent's role, such as "researcher". */
  openThreadOf: 'Open thread of {role}',
});

export function ResultCard({ run, onSchedule }: { run: RunView; onSchedule: () => void }) {
  const headingId = useId();
  const r = run.result;
  const missing = run.status === 'output_missing';
  const S = RESULT_TEXT;
  const kind = run.expectedOutput?.kind ?? 'other';
  return (
    <section
      className="panel-inset work-result"
      aria-labelledby={headingId}
      data-status={run.status}
    >
      <div className="work-goal-head">
        <h2 id={headingId}>{S.heading}</h2>
        <span className="work-badge" data-run={run.status}>
          <Icon
            name={run.status === 'done' ? 'check' : run.status === 'cancelled' ? 'stop' : 'alert'}
          />
          {RUN_STATUS_TEXT[run.status]}
        </span>
      </div>
      {missing ? (
        <div className="ws-callout" role="note">
          <Icon name="alert" />
          <p>
            {run.expectedOutput?.ref
              ? S.missingRef({ kind, ref: run.expectedOutput.ref })
              : S.missing({ kind })}{' '}
            <a href={`#${ACTIVITY_ID}`} onClick={showTrace}>
              {S.seeTrace}
            </a>
          </p>
        </div>
      ) : null}
      {r?.summary ? (
        <Markdown text={r.summary} />
      ) : (
        <p className="muted ws-flush">
          {run.status === 'failed'
            ? S.failed
            : run.status === 'cancelled'
              ? S.cancelled
              : S.noSummary}
        </p>
      )}
      {r?.artifactIds.length ? (
        <div className="work-artifacts">
          <h3>{S.artifacts}</h3>
          {r.artifactIds.map((id) => (
            <ResultArtifact key={id} id={id} />
          ))}
        </div>
      ) : null}
      {r?.evidence.length ? (
        <div>
          <h3>{S.evidence}</h3>
          <ul className="work-evidence">
            {r.evidence.map((e, i) => {
              const href = webLink(e);
              return (
                <li key={`${i}-${e}`} dir="auto">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {e} <Icon name="external" /> <span className="nv-vh">{S.newTab}</span>
                    </a>
                  ) : (
                    e
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="ws-toolbar">
        <Button onClick={onSchedule}>
          <Icon name="clock" /> {S.schedule}
        </Button>
      </div>
    </section>
  );
}

function ResultArtifact({ id }: { id: string }) {
  const { api } = useServices();
  const [view, setView] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getArtifact(id).then(
      (a) => alive && setView(a),
      (err: unknown) => alive && setError(errorMessage(err, RESULT_TEXT.artifactFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, id, attempt]);
  if (error)
    return (
      <div className="ws-error" role="alert">
        <p>{error}</p>
        <Button
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          {WORK_TEXT.retry}
        </Button>
      </div>
    );
  if (!view) return <Spinner label={RESULT_TEXT.artifactLoading} />;
  return <ArtifactViewer artifact={view} />;
}

export function SubagentList({ items }: { items: SubagentView[] }) {
  const headingId = useId();
  if (items.length === 0) return null;
  const S = RESULT_TEXT;
  return (
    <section className="work-subagents" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.subagents}</h2>
      <ul className="ws-list" aria-label={S.subagents}>
        {items.map((s) => {
          const icon = SUBAGENT_ICON[s.status];
          return (
            <li
              key={s.id}
              className="ws-list-row work-row"
              aria-label={S.subagent({ role: s.role, objective: s.objective })}
            >
              <div className="work-row-main">
                <span className="work-subagent-role" dir="auto">
                  {s.role}
                </span>
                <span className="ws-flush" dir="auto">
                  {s.objective}
                </span>
                {s.result ? (
                  <details className="ws-advanced">
                    <summary>{S.subagentResult}</summary>
                    <pre className="tool-card-pre" data-untrusted="true">
                      {s.result}
                    </pre>
                  </details>
                ) : null}
              </div>
              <span className="work-badge" data-sub={s.status}>
                {icon ? <Icon name={icon} /> : <Spinner />}
                {SUBAGENT_TEXT[s.status]}
              </span>
              {s.threadId ? (
                <a
                  href={chatPath(s.threadId)}
                  className="link"
                  onClick={(e) => followLink(e, chatPath(s.threadId ?? ''))}
                  aria-label={S.openThreadOf({ role: s.role })}
                >
                  {S.openThread}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
