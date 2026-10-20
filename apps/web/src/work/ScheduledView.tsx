// Scheduled (FR-055, FR-187, FR-206, ADR-079; docs/09 §6): every schedule with its rule, next
// run, last run and last outcome (including No news and Output missing), and its actions: Run
// now, Edit, Pause or Resume, History (fires, catch-up windows and skips) and Delete. Schedules
// of an agent name it ("Set by Scout" for a self-set wake, with its reason, FR-206) and link to
// it. `?fromRun=<id>` opens New schedule filled in from a finished run ("Schedule it"); `?new=1`
// opens it blank.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ProjectView, ScheduleFireView, ScheduleView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { useAgentsApi } from '../agents/api.ts';
import { agentPath } from '../agents/format.ts';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced, useWorkEvents } from './events.ts';
import {
  formatDateTime,
  OUTCOME_ICON,
  OUTCOME_TEXT,
  runPath,
  SCHEDULED_PATH,
  WORK_TEXT,
} from './format.ts';
import { followLink, WorkNav } from './nav.tsx';
import { ScheduleDialog, type ScheduleSeed } from './ScheduleDialog.tsx';
import { whenText } from './schedule-when.ts';
import '../workspace.css';
import './work.css';

type DialogState = { editing: ScheduleView | null; seed?: ScheduleSeed } | null;

/** Scheduled. `{title}` is a schedule's title and `{name}` an agent's name (data). */
export const SCHEDULED_TEXT = defineMessages('work.scheduled', {
  origin: {
    setBy: 'Set by {name}',
    setByAgent: 'Set by agent',
    createdBy: 'Created by {name}',
    createdByAgent: 'Created by an agent',
    for: 'For {name}',
    forAgent: 'For an agent',
  },
  /** Toasts; {reason} is the Hub's own words (English, D9). */
  readRunFailed: 'Could not read the run: {reason}',
  loadFailed: 'Could not load schedules.',
  resumed: '“{title}” resumed.',
  paused: '“{title}” paused.',
  changeFailed: 'Could not change the schedule: {reason}',
  started: '“{title}” started a run.',
  openRun: 'Open run',
  startFailed: 'Could not start the run: {reason}',
  heading: 'Scheduled',
  newSchedule: 'New schedule',
  intro:
    'Each time a schedule fires it starts a Work run with its instructions. Wake-ups that agents set for themselves are listed here too.',
  loading: 'Loading schedules',
  empty: 'Nothing scheduled',
  emptyHint: 'Schedule a task to run every morning, on weekdays, every few hours or once.',
  scheduleTask: 'Schedule a task',
  list: 'Schedules',
  /** The rule and its timezone: "Every day at 09:00 (UTC)". */
  rule: '{when} ({timezone})',
  reason: 'Reason:',
  /** {when} is a date and time, or "Paused". */
  nextRun: 'Next run: {when}',
  lastRun: 'Last run: {when}',
  lastOutcome: 'Last outcome:',
  runNow: 'Run now',
  runNowOf: 'Run now: {title}',
  editOf: 'Edit {title}',
  pause: 'Pause',
  resume: 'Resume',
  pauseOf: 'Pause {title}',
  resumeOf: 'Resume {title}',
  history: 'History',
  historyOf: 'History of {title}',
  deleteOf: 'Delete {title}',
  created: 'Scheduled “{title}”.',
  saved: 'Schedule saved.',
  deleteTitle: 'Delete this schedule?',
  deleteBody: '“{title}” will not run again. Runs it already started are kept.',
  deleted: 'Schedule deleted.',
  deleteFailed: 'Could not delete it: {reason}',
  /** A history line: when the schedule fired. */
  ran: 'Ran {when}',
  /** {n} missed times between {first} and {last}. */
  catchUp:
    '{n, plural, one {Catch-up run: # missed time, {first} to {last}} other {Catch-up run: # missed times, {first} to {last}}}',
  skipped:
    '{n, plural, one {Skipped: # missed time, {first} to {last}} other {Skipped: # missed times, {first} to {last}}}',
  catchUpNone: 'Catch-up run',
  skippedNone: 'Skipped',
  historyFailed: 'Could not load the history.',
  historyLoading: 'Loading the history',
  notRun: 'It has not run yet.',
  inProgress: 'In progress',
  openRunTrace: 'Open run and its trace',
});

/** Who set a schedule, when an agent did or it wakes one; the agent's name when it is known. */
export function scheduleOriginText(
  s: Pick<ScheduleView, 'origin' | 'agentId'>,
  agentName: string | undefined,
): string | null {
  const S = SCHEDULED_TEXT.origin;
  if (s.origin === 'agent_self') return agentName ? S.setBy({ name: agentName }) : S.setByAgent;
  if (s.origin === 'agent') return agentName ? S.createdBy({ name: agentName }) : S.createdByAgent;
  if (s.agentId) return agentName ? S.for({ name: agentName }) : S.forAgent;
  return null;
}

export function ScheduledView() {
  const { api } = useServices();
  const toast = useToast();
  const loc = useLocation();
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduleView | null>(null);
  const [history, setHistory] = useState<Set<string>>(new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const agentsApi = useAgentsApi();
  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(new Map());
  // Names only matter when an agent's schedule is listed; a failure keeps the generic words.
  const needsNames = items?.some((s) => s.agentId && !agentNames.has(s.agentId)) ?? false;
  useEffect(() => {
    if (!needsNames) return;
    let alive = true;
    Promise.resolve()
      .then(() => agentsApi.listAgents())
      .then(
        ({ items: agents }) => alive && setAgentNames(new Map(agents.map((a) => [a.id, a.name]))),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [agentsApi, needsNames]);

  const params = new URLSearchParams(loc.includes('?') ? loc.slice(loc.indexOf('?') + 1) : '');
  const fromRun = params.get('fromRun');
  const wantsNew = params.get('new') === '1';
  if (wantsNew && dialog === null) setDialog({ editing: null });

  useEffect(() => {
    if (wantsNew) navigate(SCHEDULED_PATH, { replace: true });
  }, [wantsNew]);

  // "Schedule it": fill the form from the run, then drop the query so a reload does not repeat it.
  useEffect(() => {
    if (!fromRun) return;
    let alive = true;
    api.getRun(fromRun).then(
      (r) => {
        if (!alive) return;
        setDialog({
          editing: null,
          seed: {
            title: r.title,
            instructions: r.objective,
            projectId: r.projectId,
            output: r.expectedOutput,
          },
        });
        navigate(SCHEDULED_PATH, { replace: true });
      },
      (err: unknown) => {
        if (!alive) return;
        toast.show(SCHEDULED_TEXT.readRunFailed({ reason: errorMessage(err) }), {
          tone: 'error',
        });
        navigate(SCHEDULED_PATH, { replace: true });
      },
    );
    return () => {
      alive = false;
    };
  }, [api, fromRun, toast]);

  useEffect(() => {
    let alive = true;
    api.listSchedules().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, SCHEDULED_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  useEffect(() => {
    let alive = true;
    api.listProjects().then(
      ({ items: list }) => alive && setProjects(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const reload = useDebounced(() => {
    setVersion((v) => v + 1);
    setHistoryVersion((v) => v + 1);
  }, 150);
  useWorkEvents((env) => {
    if (env.name.startsWith('schedule.') || env.name === 'run.completed') reload();
  }, reload);

  const replace = (s: ScheduleView) =>
    setItems((list) => (list ? list.map((x) => (x.id === s.id ? s : x)) : list));

  const toggle = (s: ScheduleView) => {
    api.updateSchedule(s.id, { enabled: !s.enabled }).then(
      (next) => {
        replace(next);
        toast.show(
          next.enabled
            ? SCHEDULED_TEXT.resumed({ title: next.title })
            : SCHEDULED_TEXT.paused({ title: next.title }),
          { tone: 'success' },
        );
      },
      (err: unknown) =>
        toast.show(SCHEDULED_TEXT.changeFailed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const runNow = (s: ScheduleView) => {
    api.runScheduleNow(s.id).then(
      ({ runId }) => {
        setHistoryVersion((v) => v + 1);
        toast.show(SCHEDULED_TEXT.started({ title: s.title }), {
          tone: 'success',
          action: { label: SCHEDULED_TEXT.openRun, onClick: () => navigate(runPath(runId)) },
        });
      },
      (err: unknown) =>
        toast.show(SCHEDULED_TEXT.startFailed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null;
  const S = SCHEDULED_TEXT;

  return (
    <div className="ws-page work-page">
      <header className="ws-page-header">
        <h1>{S.heading}</h1>
        <Button variant="primary" onClick={() => setDialog({ editing: null })}>
          <Icon name="plus" /> {S.newSchedule}
        </Button>
      </header>
      <WorkNav current="scheduled" />
      <p className="muted ws-flush">{S.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{WORK_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={S.empty}
          description={S.emptyHint}
          icon="clock"
          level={2}
          action={<Button onClick={() => setDialog({ editing: null })}>{S.scheduleTask}</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {items.map((s) => {
            const agentName = s.agentId ? agentNames.get(s.agentId) : undefined;
            const origin = scheduleOriginText(s, agentName);
            const project = projectName(s.projectId);
            const showHistory = history.has(s.id);
            return (
              <li key={s.id} className="ws-list-row work-schedule" aria-label={s.title}>
                <div className="work-row-main">
                  <span className="ws-card-link" dir="auto">
                    {s.title}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>{S.rule({ when: whenText(s.when), timezone: s.timezone })}</span>
                    {s.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> {WORK_TEXT.paused}
                      </span>
                    )}
                    {origin ? (
                      <span className="ws-badge" data-origin={s.origin}>
                        <Icon name="agents" />{' '}
                        {s.agentId && agentName ? (
                          <a
                            href={agentPath(s.agentId)}
                            onClick={(e) => followLink(e, agentPath(s.agentId ?? ''))}
                          >
                            {origin}
                          </a>
                        ) : (
                          origin
                        )}
                      </span>
                    ) : null}
                    {project ? (
                      <span>
                        <Icon name="folder" /> <span dir="auto">{project}</span>
                      </span>
                    ) : null}
                  </span>
                  {s.wakeReason ? (
                    <span className="ws-row-meta">
                      <span>
                        <span className="muted">{S.reason} </span>
                        <span data-untrusted="true" dir="auto">
                          {s.wakeReason}
                        </span>
                      </span>
                    </span>
                  ) : null}
                  <span className="ws-row-meta">
                    <span>
                      {S.nextRun({
                        when: s.enabled ? formatDateTime(s.nextRunAt) : WORK_TEXT.paused,
                      })}
                    </span>
                    <span>{S.lastRun({ when: formatWhen(s.lastRunAt) })}</span>
                    {s.lastOutcome ? (
                      <span className="work-badge" data-outcome={s.lastOutcome}>
                        <Icon name={OUTCOME_ICON[s.lastOutcome]} />
                        <span className="nv-vh">{S.lastOutcome}</span> {OUTCOME_TEXT[s.lastOutcome]}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="ws-row-actions">
                  <Button onClick={() => runNow(s)} aria-label={S.runNowOf({ title: s.title })}>
                    {S.runNow}
                  </Button>
                  <Button
                    onClick={() => setDialog({ editing: s })}
                    aria-label={S.editOf({ title: s.title })}
                  >
                    {WORK_TEXT.edit}
                  </Button>
                  <Button
                    onClick={() => toggle(s)}
                    aria-label={
                      s.enabled ? S.pauseOf({ title: s.title }) : S.resumeOf({ title: s.title })
                    }
                  >
                    {s.enabled ? S.pause : S.resume}
                  </Button>
                  <Button
                    aria-expanded={showHistory}
                    aria-label={S.historyOf({ title: s.title })}
                    onClick={() =>
                      setHistory((h) => {
                        const next = new Set(h);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      })
                    }
                  >
                    {S.history}
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={S.deleteOf({ title: s.title })}
                    onClick={() => setConfirmDelete(s)}
                  >
                    {WORK_TEXT.delete}
                  </Button>
                </div>
                {showHistory ? (
                  <ScheduleHistory scheduleId={s.id} version={historyVersion} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <ScheduleDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        seed={dialog?.seed}
        projects={projects}
        onClose={() => setDialog(null)}
        onSaved={(s, created) => {
          setDialog(null);
          setItems((list) =>
            created ? [...(list ?? []), s] : (list ?? []).map((x) => (x.id === s.id ? s : x)),
          );
          toast.show(created ? S.created({ title: s.title }) : S.saved, { tone: 'success' });
        }}
      />
      <Dialog
        open={confirmDelete !== null}
        title={S.deleteTitle}
        description={confirmDelete ? S.deleteBody({ title: confirmDelete.title }) : undefined}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>{WORK_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = confirmDelete;
                setConfirmDelete(null);
                if (!s) return;
                api.deleteSchedule(s.id).then(
                  () => {
                    setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
                    toast.show(S.deleted, { tone: 'success' });
                  },
                  (err: unknown) =>
                    toast.show(S.deleteFailed({ reason: errorMessage(err) }), { tone: 'error' }),
                );
              }}
            >
              {WORK_TEXT.delete}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** A history line: when it ran, or the window of missed times it caught up on or skipped. */
function fireText(f: ScheduleFireView): string {
  const S = SCHEDULED_TEXT;
  if (f.kind === 'fire') return S.ran({ when: formatDateTime(f.firedAt) });
  if (!f.window) return f.kind === 'catch_up' ? S.catchUpNone : S.skippedNone;
  const p = {
    n: f.window.count,
    first: formatDateTime(f.window.first),
    last: formatDateTime(f.window.last),
  };
  return f.kind === 'catch_up' ? S.catchUp(p) : S.skipped(p);
}

function ScheduleHistory({ scheduleId, version }: { scheduleId: string; version: number }) {
  const { api } = useServices();
  const headingId = useId();
  const [fires, setFires] = useState<ScheduleFireView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.scheduleHistory(scheduleId).then(
      ({ items }) => {
        if (!alive) return;
        setFires([...items].sort((a, b) => b.firedAt.localeCompare(a.firedAt)));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, SCHEDULED_TEXT.historyFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, scheduleId, version]);
  const S = SCHEDULED_TEXT;
  return (
    <section className="work-history" aria-labelledby={headingId}>
      <h3 id={headingId} className="ws-subhead">
        {S.history}
      </h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : fires === null ? (
        <Spinner label={S.historyLoading} />
      ) : fires.length === 0 ? (
        <p className="muted ws-flush">{S.notRun}</p>
      ) : (
        <ol className="work-fires">
          {fires.map((f) => (
            <li key={f.id} className="work-fire" data-kind={f.kind}>
              <span>{fireText(f)}</span>
              {f.outcome ? (
                <span className="work-badge" data-outcome={f.outcome}>
                  <Icon name={OUTCOME_ICON[f.outcome]} /> {OUTCOME_TEXT[f.outcome]}
                </span>
              ) : f.runId ? (
                <span className="muted">{S.inProgress}</span>
              ) : null}
              {f.runId ? (
                <a href={runPath(f.runId)} onClick={(e) => followLink(e, runPath(f.runId ?? ''))}>
                  {f.outcome === 'output_missing' ? S.openRunTrace : S.openRun}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
