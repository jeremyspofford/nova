// The run's Activity trace (FR-057, docs/09 §9): turns, tool calls, approvals and policy decisions,
// oldest first, from GET /activity. Each step opens to its recorded details. Replay walks the
// recorded steps one at a time (by hand or playing), showing only what had happened up to that
// step; it reads the record and never runs anything again. Browser and screen actions (kind
// `computer`) show their before/after screenshots under the step (FR-098).
import { useCallback, useEffect, useId, useState } from 'react';
import type { ActivityItemView } from '@nova/shared';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { Shots } from '../computers/Shots.tsx';
import { useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';

const KIND: Record<ActivityItemView['kind'], { icon: IconName; text: string }> = {
  turn: { icon: 'chat', text: 'Turn' },
  tool_call: { icon: 'tool', text: 'Tool call' },
  approval: { icon: 'shield', text: 'Approval' },
  policy: { icon: 'shield', text: 'Policy' },
  notice: { icon: 'alert', text: 'Notice' },
  computer: { icon: 'eye', text: 'Computer' },
};

export const REPLAY_STEP_MS = 1200;

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The id of the trace's section, the target of "See the trace" links. */
export const ACTIVITY_ID = 'run-activity';

export function ActivityTrace({
  refId,
  version,
}: {
  /** The thread (or run) whose trace to read. */
  refId: string;
  /** Bumped when events say the trace has new lines. */
  version: number;
}) {
  const { api } = useServices();
  const headingId = useId();
  const [items, setItems] = useState<ActivityItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** The replayed step, or null when the whole trace shows. */
  const [at, setAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [manual, setManual] = useState(0);

  const load = useCallback(() => {
    api.activity(refId).then(
      ({ items: list }) => {
        setItems(list);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err, 'Could not load the activity.')),
    );
  }, [api, refId]);

  useEffect(() => {
    load();
  }, [load, version, manual]);

  const count = items?.length ?? 0;
  useInterval(
    () => {
      const next = (at ?? -1) + 1;
      if (next >= count - 1) setPlaying(false);
      if (next <= count - 1) setAt(next);
    },
    REPLAY_STEP_MS,
    playing,
  );

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shown = items && at !== null ? items.slice(0, at + 1) : (items ?? []);
  const current = at !== null ? items?.[at] : undefined;

  return (
    <section id={ACTIVITY_ID} className="work-activity" aria-labelledby={headingId} tabIndex={-1}>
      <div className="ws-section-header">
        <h2 id={headingId}>Activity</h2>
        <div className="ws-toolbar">
          <Button variant="ghost" onClick={() => setManual((n) => n + 1)}>
            <Icon name="refresh" /> Refresh
          </Button>
          {at === null ? (
            <Button
              disabled={count === 0}
              onClick={() => {
                setAt(0);
                setPlaying(false);
              }}
            >
              Replay
            </Button>
          ) : null}
        </div>
      </div>
      {at !== null && items ? (
        <div className="work-replay" role="group" aria-label="Replay">
          <p className="muted ws-flush">
            Replay shows the recorded steps one at a time. Nothing runs again.
          </p>
          <div className="ws-toolbar">
            <Button
              disabled={at <= 0}
              onClick={() => {
                setPlaying(false);
                setAt(Math.max(0, at - 1));
              }}
            >
              <Icon name="back" /> Previous step
            </Button>
            <Button
              disabled={at >= count - 1}
              onClick={() => {
                setPlaying(false);
                setAt(Math.min(count - 1, at + 1));
              }}
            >
              Next step <Icon name="forward" />
            </Button>
            <Button
              aria-pressed={playing}
              disabled={!playing && at >= count - 1}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? 'Pause replay' : 'Play'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPlaying(false);
                setAt(null);
              }}
            >
              Exit replay
            </Button>
          </div>
          <p role="status" className="work-replay-status">
            Step {at + 1} of {count}
            {current ? `: ${KIND[current.kind].text}, ${current.title}` : ''}
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label="Loading the activity" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing has happened in this run yet.</p>
      ) : (
        <ol className="activity-list work-trace" aria-label="Activity trace">
          {shown.map((it, i) => {
            const expanded = open.has(it.id) || i === at;
            return (
              <li
                key={it.id}
                className="activity-item"
                data-kind={it.kind}
                aria-current={i === at ? 'step' : undefined}
              >
                <button
                  type="button"
                  className="work-trace-step"
                  aria-expanded={expanded}
                  onClick={() => toggle(it.id)}
                >
                  <Icon name={KIND[it.kind].icon} />
                  <span className="nv-vh">{KIND[it.kind].text}:</span>{' '}
                  <span className="activity-title">{it.title}</span>
                  {it.status ? <span className="activity-status">{it.status}</span> : null}
                  <time className="muted activity-time" dateTime={it.ts}>
                    {timeOf(it.ts)}
                  </time>
                </button>
                {it.kind === 'computer' && it.shots ? (
                  <Shots shots={it.shots} title={it.title} />
                ) : null}
                {expanded ? (
                  <dl className="ws-dl work-trace-detail">
                    <dt>Kind</dt>
                    <dd>{KIND[it.kind].text}</dd>
                    {it.status ? (
                      <>
                        <dt>Status</dt>
                        <dd>{it.status}</dd>
                      </>
                    ) : null}
                    <dt>Time</dt>
                    <dd>{new Date(it.ts).toLocaleString()}</dd>
                    {it.turnId ? (
                      <>
                        <dt>Turn</dt>
                        <dd>
                          <code>{it.turnId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.callId ? (
                      <>
                        <dt>Call</dt>
                        <dd>
                          <code>{it.callId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.detail ? (
                      <>
                        <dt>Details</dt>
                        <dd>
                          <pre className="tool-card-pre" data-untrusted="true">
                            {it.detail}
                          </pre>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
