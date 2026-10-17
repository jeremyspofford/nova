// Scheduled (FR-055, FR-187, FR-206, ADR-079; docs/09 §6): every schedule with its rule, next
// run, last run and last outcome (including No news and Output missing), and its actions: Run
// now, Edit, Pause or Resume, History (fires, catch-up windows and skips) and Delete. Schedules
// of an agent name it ("Set by Scout" for a self-set wake, with its reason, FR-206) and link to
// it. `?fromRun=<id>` opens New schedule filled in from a finished run ("Schedule it"); `?new=1`
// opens it blank.
import { useEffect, useId, useState } from 'react';
import type { ProjectView, ScheduleFireView, ScheduleView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { useAgentsApi } from '../agents/api.ts';
import { agentPath } from '../agents/format.ts';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced, useWorkEvents } from './events.ts';
import { formatDateTime, OUTCOME_ICON, OUTCOME_TEXT, runPath, SCHEDULED_PATH } from './format.ts';
import { followLink, WorkNav } from './nav.tsx';
import { ScheduleDialog, type ScheduleSeed } from './ScheduleDialog.tsx';
import { whenText } from './schedule-when.ts';
import '../workspace.css';
import './work.css';

type DialogState = { editing: ScheduleView | null; seed?: ScheduleSeed } | null;

/** Who set a schedule, when an agent did or it wakes one; the agent's name when it is known. */
export function scheduleOriginText(
  s: Pick<ScheduleView, 'origin' | 'agentId'>,
  agentName: string | undefined,
): string | null {
  if (s.origin === 'agent_self') return agentName ? `Set by ${agentName}` : 'Set by agent';
  if (s.origin === 'agent') return agentName ? `Created by ${agentName}` : 'Created by an agent';
  if (s.agentId) return agentName ? `For ${agentName}` : 'For an agent';
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
        toast.show(`Could not read the run: ${errorMessage(err)}`, { tone: 'error' });
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load schedules.')),
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
        toast.show(next.enabled ? `“${next.title}” resumed.` : `“${next.title}” paused.`, {
          tone: 'success',
        });
      },
      (err: unknown) =>
        toast.show(`Could not change the schedule: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const runNow = (s: ScheduleView) => {
    api.runScheduleNow(s.id).then(
      ({ runId }) => {
        setHistoryVersion((v) => v + 1);
        toast.show(`“${s.title}” started a run.`, {
          tone: 'success',
          action: { label: 'Open run', onClick: () => navigate(runPath(runId)) },
        });
      },
      (err: unknown) =>
        toast.show(`Could not start the run: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null;

  return (
    <div className="ws-page work-page">
      <header className="ws-page-header">
        <h1>Scheduled</h1>
        <Button variant="primary" onClick={() => setDialog({ editing: null })}>
          <Icon name="plus" /> New schedule
        </Button>
      </header>
      <WorkNav current="scheduled" />
      <p className="muted ws-flush">
        Each time a schedule fires it starts a Work run with its instructions. Wake-ups that agents
        set for themselves are listed here too.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading schedules" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description="Schedule a task to run every morning, on weekdays, every few hours or once."
          icon="clock"
          level={2}
          action={<Button onClick={() => setDialog({ editing: null })}>Schedule a task</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Schedules">
          {items.map((s) => {
            const agentName = s.agentId ? agentNames.get(s.agentId) : undefined;
            const origin = scheduleOriginText(s, agentName);
            const project = projectName(s.projectId);
            const showHistory = history.has(s.id);
            return (
              <li key={s.id} className="ws-list-row work-schedule" aria-label={s.title}>
                <div className="work-row-main">
                  <span className="ws-card-link">{s.title}</span>
                  <span className="muted ws-row-meta">
                    <span>
                      {whenText(s.when)} ({s.timezone})
                    </span>
                    {s.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> Paused
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
                        <Icon name="folder" /> {project}
                      </span>
                    ) : null}
                  </span>
                  {s.wakeReason ? (
                    <span className="ws-row-meta">
                      <span>
                        <span className="muted">Reason: </span>
                        <span data-untrusted="true">{s.wakeReason}</span>
                      </span>
                    </span>
                  ) : null}
                  <span className="ws-row-meta">
                    <span>Next run: {s.enabled ? formatDateTime(s.nextRunAt) : 'Paused'}</span>
                    <span>Last run: {formatWhen(s.lastRunAt)}</span>
                    {s.lastOutcome ? (
                      <span className="work-badge" data-outcome={s.lastOutcome}>
                        <Icon name={OUTCOME_ICON[s.lastOutcome]} />
                        <span className="nv-vh">Last outcome:</span> {OUTCOME_TEXT[s.lastOutcome]}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="ws-row-actions">
                  <Button onClick={() => runNow(s)} aria-label={`Run now: ${s.title}`}>
                    Run now
                  </Button>
                  <Button onClick={() => setDialog({ editing: s })} aria-label={`Edit ${s.title}`}>
                    Edit
                  </Button>
                  <Button
                    onClick={() => toggle(s)}
                    aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.title}`}
                  >
                    {s.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    aria-expanded={showHistory}
                    aria-label={`History of ${s.title}`}
                    onClick={() =>
                      setHistory((h) => {
                        const next = new Set(h);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      })
                    }
                  >
                    History
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Delete ${s.title}`}
                    onClick={() => setConfirmDelete(s)}
                  >
                    Delete
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
          toast.show(created ? `Scheduled “${s.title}”.` : 'Schedule saved.', { tone: 'success' });
        }}
      />
      <Dialog
        open={confirmDelete !== null}
        title="Delete this schedule?"
        description={
          confirmDelete
            ? `“${confirmDelete.title}” will not run again. Runs it already started are kept.`
            : undefined
        }
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = confirmDelete;
                setConfirmDelete(null);
                if (!s) return;
                api.deleteSchedule(s.id).then(
                  () => {
                    setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
                    toast.show('Schedule deleted.', { tone: 'success' });
                  },
                  (err: unknown) =>
                    toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' }),
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

const KIND_TEXT: Record<ScheduleFireView['kind'], string> = {
  fire: 'Ran',
  catch_up: 'Catch-up run',
  skipped: 'Skipped',
};

function windowText(f: ScheduleFireView): string {
  if (!f.window) return '';
  const n = f.window.count;
  const times = n === 1 ? '1 missed time' : `${n} missed times`;
  return `${times}, ${formatDateTime(f.window.first)} to ${formatDateTime(f.window.last)}`;
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the history.')),
    );
    return () => {
      alive = false;
    };
  }, [api, scheduleId, version]);
  return (
    <section className="work-history" aria-labelledby={headingId}>
      <h3 id={headingId} className="ws-subhead">
        History
      </h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : fires === null ? (
        <Spinner label="Loading the history" />
      ) : fires.length === 0 ? (
        <p className="muted ws-flush">It has not run yet.</p>
      ) : (
        <ol className="work-fires">
          {fires.map((f) => (
            <li key={f.id} className="work-fire" data-kind={f.kind}>
              <span>
                {KIND_TEXT[f.kind]}
                {f.kind === 'fire' ? ` ${formatDateTime(f.firedAt)}` : `: ${windowText(f)}`}
              </span>
              {f.outcome ? (
                <span className="work-badge" data-outcome={f.outcome}>
                  <Icon name={OUTCOME_ICON[f.outcome]} /> {OUTCOME_TEXT[f.outcome]}
                </span>
              ) : f.runId ? (
                <span className="muted">In progress</span>
              ) : null}
              {f.runId ? (
                <a href={runPath(f.runId)} onClick={(e) => followLink(e, runPath(f.runId ?? ''))}>
                  Open run{f.outcome === 'output_missing' ? ' and its trace' : ''}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
