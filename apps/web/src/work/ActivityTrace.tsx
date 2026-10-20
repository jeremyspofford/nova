// The run's Activity trace (FR-057, docs/09 §9): turns, tool calls, approvals and policy decisions,
// oldest first, from GET /activity. Each step opens to its recorded details. Replay walks the
// recorded steps one at a time (by hand or playing), showing only what had happened up to that
// step; it reads the record and never runs anything again. Browser and screen actions (kind
// `computer`) show their before/after screenshots under the step (FR-098).
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { ActivityItemView } from '@nova/shared';
import { Button, Icon, Spinner, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { Shots } from '../computers/Shots.tsx';
import { useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { WORK_TEXT } from './format.ts';

/** The activity trace. Step titles and statuses are the Hub's record (English, D9). */
export const ACTIVITY_TEXT = defineMessages('work.activity', {
  kind: {
    turn: 'Turn',
    tool_call: 'Tool call',
    approval: 'Approval',
    policy: 'Policy',
    notice: 'Notice',
    computer: 'Computer',
  },
  loadFailed: 'Could not load the activity.',
  heading: 'Activity',
  refresh: 'Refresh',
  replay: 'Replay',
  replayHint: 'Replay shows the recorded steps one at a time. Nothing runs again.',
  previous: 'Previous step',
  next: 'Next step',
  pause: 'Pause replay',
  play: 'Play',
  exit: 'Exit replay',
  step: 'Step {n} of {total}',
  /** The replayed step with its kind and title: "Step 2 of 5: Tool call, Read the report". */
  stepOf: 'Step {n} of {total}: {kind}, {title}',
  loading: 'Loading the activity',
  empty: 'Nothing has happened in this run yet.',
  trace: 'Activity trace',
  /** Read before a step's title: "Tool call:". */
  kindLabel: '{kind}:',
  kindTerm: 'Kind',
  status: 'Status',
  time: 'Time',
  turn: 'Turn',
  call: 'Call',
  details: 'Details',
});

const KIND_ICON: Record<ActivityItemView['kind'], IconName> = {
  turn: 'chat',
  tool_call: 'tool',
  approval: 'shield',
  policy: 'shield',
  notice: 'alert',
  computer: 'eye',
};

export const REPLAY_STEP_MS = 1200;

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : fmt.time(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function dateTimeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : fmt.dateTime(d, { dateStyle: 'medium', timeStyle: 'medium' });
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
      (err: unknown) => setError(errorMessage(err, ACTIVITY_TEXT.loadFailed)),
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
  const S = ACTIVITY_TEXT;

  return (
    <section id={ACTIVITY_ID} className="work-activity" aria-labelledby={headingId} tabIndex={-1}>
      <div className="ws-section-header">
        <h2 id={headingId}>{S.heading}</h2>
        <div className="ws-toolbar">
          <Button variant="ghost" onClick={() => setManual((n) => n + 1)}>
            <Icon name="refresh" /> {S.refresh}
          </Button>
          {at === null ? (
            <Button
              disabled={count === 0}
              onClick={() => {
                setAt(0);
                setPlaying(false);
              }}
            >
              {S.replay}
            </Button>
          ) : null}
        </div>
      </div>
      {at !== null && items ? (
        <div className="work-replay" role="group" aria-label={S.replay}>
          <p className="muted ws-flush">{S.replayHint}</p>
          <div className="ws-toolbar">
            <Button
              disabled={at <= 0}
              onClick={() => {
                setPlaying(false);
                setAt(Math.max(0, at - 1));
              }}
            >
              <Icon name="back" /> {S.previous}
            </Button>
            <Button
              disabled={at >= count - 1}
              onClick={() => {
                setPlaying(false);
                setAt(Math.min(count - 1, at + 1));
              }}
            >
              {S.next} <Icon name="forward" />
            </Button>
            <Button
              aria-pressed={playing}
              disabled={!playing && at >= count - 1}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? S.pause : S.play}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPlaying(false);
                setAt(null);
              }}
            >
              {S.exit}
            </Button>
          </div>
          <p role="status" className="work-replay-status">
            {current
              ? S.stepOf({
                  n: at + 1,
                  total: count,
                  kind: S.kind[current.kind],
                  title: current.title,
                })
              : S.step({ n: at + 1, total: count })}
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{WORK_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label={S.loading} /> {WORK_TEXT.loading}
        </p>
      ) : items.length === 0 ? (
        <p className="muted">{S.empty}</p>
      ) : (
        <ol className="activity-list work-trace" aria-label={S.trace}>
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
                  <Icon name={KIND_ICON[it.kind]} />
                  <span className="nv-vh">{S.kindLabel({ kind: S.kind[it.kind] })}</span>{' '}
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
                    <dt>{S.kindTerm}</dt>
                    <dd>{S.kind[it.kind]}</dd>
                    {it.status ? (
                      <>
                        <dt>{S.status}</dt>
                        <dd>{it.status}</dd>
                      </>
                    ) : null}
                    <dt>{S.time}</dt>
                    <dd>{dateTimeOf(it.ts)}</dd>
                    {it.turnId ? (
                      <>
                        <dt>{S.turn}</dt>
                        <dd>
                          <code>{it.turnId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.callId ? (
                      <>
                        <dt>{S.call}</dt>
                        <dd>
                          <code>{it.callId}</code>
                        </dd>
                      </>
                    ) : null}
                    {it.detail ? (
                      <>
                        <dt>{S.details}</dt>
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
