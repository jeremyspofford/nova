// The run's result (FR-051, FR-187, docs/04 §2.3): the summary, its artifacts with previews (the
// chat's artifact viewer), and the evidence. A run that could not verify its declared output ends
// as Output missing with the trace linked, never as done. Sub-agents (FR-053, FR-054) list their
// role, task, status and a link to their thread.
import { useEffect, useId, useState } from 'react';
import type { ArtifactView, RunView, SubagentView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ArtifactViewer } from '../chat/Artifacts.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { chatPath } from '../router.ts';
import { useServices } from '../services.tsx';
import { ACTIVITY_ID } from './ActivityTrace.tsx';
import { RUN_STATUS_TEXT, SUBAGENT_ICON, SUBAGENT_TEXT, webLink } from './format.ts';
import { followLink } from './nav.tsx';

/** Moves to the Activity section of the run page. */
export function showTrace(e: React.MouseEvent): void {
  e.preventDefault();
  const el = document.getElementById(ACTIVITY_ID);
  el?.scrollIntoView?.({ block: 'start' });
  el?.focus();
}

const OUTPUT_TEXT = { artifact: 'artifact', message: 'delivered message', file: 'file' } as const;

export function ResultCard({ run, onSchedule }: { run: RunView; onSchedule: () => void }) {
  const headingId = useId();
  const r = run.result;
  const missing = run.status === 'output_missing';
  return (
    <section
      className="panel-inset work-result"
      aria-labelledby={headingId}
      data-status={run.status}
    >
      <div className="work-goal-head">
        <h2 id={headingId}>Result</h2>
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
            Output missing: the run could not verify its{' '}
            {run.expectedOutput ? OUTPUT_TEXT[run.expectedOutput.kind] : 'declared output'}
            {run.expectedOutput?.ref ? ` (${run.expectedOutput.ref})` : ''}, so it did not count as
            done.{' '}
            <a href={`#${ACTIVITY_ID}`} onClick={showTrace}>
              See the trace
            </a>
          </p>
        </div>
      ) : null}
      {r?.summary ? (
        <Markdown text={r.summary} />
      ) : (
        <p className="muted ws-flush">
          {run.status === 'failed'
            ? 'The run failed before it wrote a result.'
            : run.status === 'cancelled'
              ? 'The run was cancelled. Partial work stays in the conversation.'
              : 'No summary.'}
        </p>
      )}
      {r?.artifactIds.length ? (
        <div className="work-artifacts">
          <h3>Artifacts</h3>
          {r.artifactIds.map((id) => (
            <ResultArtifact key={id} id={id} />
          ))}
        </div>
      ) : null}
      {r?.evidence.length ? (
        <div>
          <h3>Evidence</h3>
          <ul className="work-evidence">
            {r.evidence.map((e, i) => {
              const href = webLink(e);
              return (
                <li key={`${i}-${e}`}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {e} <Icon name="external" />{' '}
                      <span className="nv-vh">(opens in a new tab)</span>
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
          <Icon name="clock" /> Schedule it
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the artifact.')),
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
          Retry
        </Button>
      </div>
    );
  if (!view) return <Spinner label="Loading the artifact" />;
  return <ArtifactViewer artifact={view} />;
}

export function SubagentList({ items }: { items: SubagentView[] }) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section className="work-subagents" aria-labelledby={headingId}>
      <h2 id={headingId}>Sub-agents</h2>
      <ul className="ws-list" aria-label="Sub-agents">
        {items.map((s) => {
          const icon = SUBAGENT_ICON[s.status];
          return (
            <li
              key={s.id}
              className="ws-list-row work-row"
              aria-label={`${s.role}: ${s.objective}`}
            >
              <div className="work-row-main">
                <span className="work-subagent-role">{s.role}</span>
                <span className="ws-flush">{s.objective}</span>
                {s.result ? (
                  <details className="ws-advanced">
                    <summary>Result</summary>
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
                >
                  Open thread <span className="nv-vh">of {s.role}</span>
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
