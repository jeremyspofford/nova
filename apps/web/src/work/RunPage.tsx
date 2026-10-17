// One Work run (FR-051..FR-054, FR-057, FR-181, FR-182, FR-187; docs/04 §2.3, §2.3.1): the
// header (title, status chip, run status, where it came from), the controls (Pause, Resume,
// Redirect, Cancel), live budget meters, a decision banner when a budget pauses it, the goal, the
// plan, the sub-agents, the result, the conversation and the Activity trace. Everything follows
// the shared event stream; budget meters update from usage events without a refetch.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GoalView, ProjectView, RunView, SubagentView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { ApiError, errorMessage, type Api } from '../api.ts';
import { chatPath, navigate, projectPath } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { ActivityTrace } from './ActivityTrace.tsx';
import { eventCorrelation, eventRunId, useDebounced, useWorkEvents } from './events.ts';
import { ExtendBudgetDialog } from './ExtendBudgetDialog.tsx';
import {
  AUTONOMY_TEXT,
  budgetBound,
  formatCost,
  formatTokens,
  isFinal,
  minutes,
  progressLine,
  runStatusLine,
  SCHEDULED_PATH,
} from './format.ts';
import { GoalPanel } from './GoalPanel.tsx';
import { followLink } from './nav.tsx';
import { PlanCard } from './PlanCard.tsx';
import { ResultCard, SubagentList } from './ResultCard.tsx';
import { RunConversation } from './RunConversation.tsx';
import '../workspace.css';
import './work.css';

/** Events after which the trace has new lines. */
const TRACE_ON = /^(run\.(step|status|completed|budget\.reached|subagent)|approval\.|request\.)/;

const ORIGIN_TEXT: Record<RunView['origin'], string> = {
  user: 'Started by you',
  schedule: 'Started by a schedule',
  trigger: 'Started by a trigger',
  chat_escalation: 'Started from a chat',
  delegation: 'Delegated by another run',
  goal: 'Started to pursue a goal',
};

function loadError(err: unknown): { message: string; missing: boolean } {
  const missing = err instanceof ApiError && err.status === 404;
  return {
    message: missing
      ? 'This run was deleted or does not exist.'
      : errorMessage(err, 'Could not load this run.'),
    missing,
  };
}

export function RunPage({ runId }: { runId: string }) {
  const { api } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  /** undefined while loading; null when the run has no goal. */
  const [goal, setGoal] = useState<GoalView | null | undefined>(undefined);
  const [subagents, setSubagents] = useState<SubagentView[]>([]);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [traceVersion, setTraceVersion] = useState(0);
  const [extending, setExtending] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastStatus = useRef<string | null>(null);

  const fail =
    (what: string) =>
    (err: unknown): void => {
      toast.show(`${what}: ${errorMessage(err)}`, { tone: 'error' });
    };

  // The page is keyed by run id, so these loads never race another run's.
  const loadRun = useCallback(
    () =>
      api.getRun(runId).then(
        (r) => {
          setRun(r);
          setError(null);
        },
        (err: unknown) => setError(loadError(err)),
      ),
    [api, runId],
  );
  const loadGoal = useCallback(
    () =>
      api.getRunGoal(runId).then(
        (g) => setGoal(g),
        () => setGoal((g) => g ?? null),
      ),
    [api, runId],
  );
  const loadSubagents = useCallback(
    () =>
      api.listSubagents(runId).then(
        ({ items }) => setSubagents(items),
        () => undefined,
      ),
    [api, runId],
  );

  useEffect(() => {
    void loadRun();
    void loadGoal();
    void loadSubagents();
  }, [loadRun, loadGoal, loadSubagents, attempt]);

  const projectId = run?.projectId ?? null;
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    api.getProject(projectId).then(
      (p) => alive && setProject(p),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, projectId]);

  // Say a status change out loud once (docs/04 §4.4); the progress line below is a live region.
  useEffect(() => {
    if (!run) return;
    const line = runStatusLine(run);
    if (lastStatus.current !== null && lastStatus.current !== line)
      announce(`Run ${run.title}: ${line}.`);
    lastStatus.current = line;
  }, [announce, run]);

  const refreshRun = useDebounced(() => void loadRun(), 100);
  const refreshGoal = useDebounced(() => void loadGoal(), 100);
  const refreshSubagents = useDebounced(() => void loadSubagents(), 100);
  const refreshTrace = useDebounced(() => setTraceVersion((v) => v + 1), 200);
  useWorkEvents(
    (env) => {
      const p = env.payload;
      if (env.name.startsWith('goal.')) {
        if (p.runId === runId || (goal && p.goalId === goal.id)) refreshGoal();
        return;
      }
      if (env.name === 'thread.status.changed') {
        const ref = p.ref as { kind?: unknown; id?: unknown } | undefined;
        if (
          (ref?.kind === 'run' && ref.id === runId) ||
          (ref?.kind === 'thread' && run && ref.id === run.threadId)
        )
          refreshRun();
        return;
      }
      // Request events carry their correlation in the payload (FR-188).
      const about =
        eventRunId(env) ?? eventCorrelation(env).runId ?? env.correlation?.threadId ?? null;
      if (about !== runId && (!run || about !== run.threadId)) return;
      if (env.name === 'run.budget.usage') {
        // Live meters (ephemeral events): patch the numbers, no refetch.
        const u = p.usage as Partial<RunView['used']> | undefined;
        if (u)
          setRun((r) =>
            r
              ? {
                  ...r,
                  used: {
                    timeSeconds: u.timeSeconds ?? r.used.timeSeconds,
                    tokens: u.tokens ?? r.used.tokens,
                    costUsd: u.costUsd ?? r.used.costUsd,
                  },
                }
              : r,
          );
        return;
      }
      refreshRun();
      if (env.name.startsWith('run.subagent.')) refreshSubagents();
      if (env.name === 'run.completed' || env.name === 'run.status.changed') refreshGoal();
      if (TRACE_ON.test(env.name)) refreshTrace();
    },
    () => {
      refreshRun();
      refreshGoal();
      refreshSubagents();
    },
  );

  const control = (action: 'pause' | 'resume' | 'cancel', label: string) => {
    api.controlRun(runId, action).then((r) => {
      setRun(r);
      toast.show(label, { tone: 'success' });
    }, fail('Could not change the run'));
  };

  if (error && !run)
    return (
      <div className="ws-page work-page">
        <Breadcrumb />
        <div role="alert" className="ws-error">
          <p>{error.message}</p>
          {error.missing ? null : <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
        </div>
      </div>
    );
  if (!run)
    return (
      <div className="ws-page work-page">
        <Breadcrumb />
        <Spinner label="Loading the run" />
      </div>
    );

  const final = isFinal(run.status);
  const bound = run.status === 'paused' ? budgetBound(run.pauseReason) : null;
  const canPause = run.status === 'running' || run.status === 'waiting_approval';
  const canResume = run.status === 'paused' && !bound;

  return (
    <div className="ws-page work-page">
      <Breadcrumb />
      <header className="work-run-header">
        <div className="ws-page-header">
          <h1>{run.title}</h1>
          <StatusChip status={run.derived.status} reason={run.derived.reason ?? undefined} />
        </div>
        <p className="muted ws-row-meta">
          <span className="work-badge" data-run={run.status}>
            {runStatusLine(run)}
          </span>
          <span>
            {run.origin === 'chat_escalation' && run.originRef ? (
              <a
                href={chatPath(run.originRef)}
                onClick={(e) => followLink(e, chatPath(run.originRef ?? ''))}
              >
                {ORIGIN_TEXT.chat_escalation}
              </a>
            ) : (
              ORIGIN_TEXT[run.origin]
            )}
          </span>
          {project ? (
            <a
              href={projectPath(project.id)}
              onClick={(e) => followLink(e, projectPath(project.id))}
            >
              <Icon name="folder" /> {project.name}
            </a>
          ) : null}
          <span>Autonomy: {AUTONOMY_TEXT[run.autonomy].label}</span>
          <span>Started {formatWhen(run.createdAt)}</span>
        </p>
        <p className="work-objective">{run.objective}</p>
        <p role="status" className="work-progress">
          {progressLine(run)}
        </p>
        {final ? null : (
          <div className="ws-toolbar" role="group" aria-label="Run controls">
            {canPause ? (
              <Button onClick={() => control('pause', 'Run paused.')}>
                <Icon name="stop" /> Pause
              </Button>
            ) : null}
            {canResume ? (
              <Button onClick={() => control('resume', 'Run resumed.')}>
                <Icon name="forward" /> Resume
              </Button>
            ) : null}
            <Button aria-expanded={redirecting} onClick={() => setRedirecting((r) => !r)}>
              Redirect…
            </Button>
            <Button variant="danger" onClick={() => setConfirmCancel(true)}>
              Cancel run
            </Button>
          </div>
        )}
        {redirecting && !final ? (
          <RedirectForm
            onCancel={() => setRedirecting(false)}
            onSend={async (text) => {
              try {
                setRun(await api.controlRun(runId, 'redirect', text));
                setRedirecting(false);
                toast.show('New instructions sent. The run applies them at its next step.', {
                  tone: 'success',
                });
              } catch (err) {
                fail('Could not redirect the run')(err);
              }
            }}
          />
        ) : null}
      </header>

      {bound ? (
        <BudgetBanner
          run={run}
          bound={bound}
          onQuick={(body, label) =>
            api.extendRunBudget(runId, body).then((r) => {
              setRun(r);
              toast.show(label, { tone: 'success' });
            }, fail('Could not extend the budget'))
          }
          onExtend={() => setExtending(true)}
        />
      ) : null}

      <BudgetMeters run={run} />

      <GoalPanel
        goal={goal ?? null}
        loading={goal === undefined}
        finished={final}
        actions={{
          set: async (objective) => {
            try {
              setGoal(await api.setRunGoal(runId, { objective }));
              toast.show('Goal set.', { tone: 'success' });
              return true;
            } catch (err) {
              fail('Could not set the goal')(err);
              return false;
            }
          },
          edit: async (objective) => {
            if (!goal) return false;
            try {
              setGoal(await api.updateGoal(goal.id, { objective }));
              toast.show('Goal saved. It applies at the start of the next turn.', {
                tone: 'success',
              });
              return true;
            } catch (err) {
              fail('Could not save the goal')(err);
              return false;
            }
          },
          act: (action) => {
            if (!goal) return;
            api
              .goalAction(goal.id, action)
              .then((g) => setGoal(g), fail('Could not change the goal'));
          },
          clear: () => {
            api.clearRunGoal(runId).then(() => {
              setGoal(null);
              toast.show('Goal cleared.', { tone: 'success' });
            }, fail('Could not clear the goal'));
          },
          extend: () => setExtending(true),
        }}
      />

      <PlanCard
        run={run}
        onSave={async (steps) => {
          try {
            setRun(await api.updateRunPlan(runId, { steps }));
            toast.show('Plan saved.', { tone: 'success' });
            return true;
          } catch (err) {
            fail('Could not save the plan')(err);
            return false;
          }
        }}
        onApprove={() => {
          api.startRun(runId).then((r) => {
            setRun(r);
            toast.show('The run is starting.', { tone: 'success' });
          }, fail('Could not start the run'));
        }}
      />

      <SubagentList items={subagents} />

      {final || run.result ? (
        <ResultCard
          run={run}
          onSchedule={() => navigate(`${SCHEDULED_PATH}?fromRun=${encodeURIComponent(run.id)}`)}
        />
      ) : null}

      <RunConversation threadId={run.threadId} />

      <ActivityTrace refId={run.threadId} version={traceVersion} />

      <ExtendBudgetDialog
        run={run}
        open={extending}
        onClose={() => setExtending(false)}
        onExtended={(r) => {
          setExtending(false);
          setRun(r);
          toast.show('Budget extended.', { tone: 'success' });
        }}
      />
      <Dialog
        open={confirmCancel}
        title="Cancel this run?"
        description="The run stops now. What it did so far stays in its conversation and Activity."
        onClose={() => setConfirmCancel(false)}
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmCancel(false);
                control('cancel', 'Run cancelled.');
              }}
            >
              Cancel run
            </Button>
          </>
        }
      />
    </div>
  );
}

function Breadcrumb() {
  return (
    <p className="ws-breadcrumb">
      <a href="/work" onClick={(e) => followLink(e, '/work')}>
        <Icon name="back" /> Work
      </a>
    </p>
  );
}

function RedirectForm({
  onSend,
  onCancel,
}: {
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `rd${useId()}`;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack work-redirect"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        void onSend(text.trim()).finally(() => setBusy(false));
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={id}>
          New instructions
        </label>
        <textarea
          id={id}
          autoFocus
          className="nv-input ws-textarea"
          rows={3}
          maxLength={8000}
          value={text}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <span id={`${id}-hint`} className="nv-field-hint">
          The run applies them at the start of its next step.
        </span>
      </div>
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} Send instructions
        </Button>
        <Button onClick={onCancel}>Close</Button>
      </div>
    </form>
  );
}

type QuickExtend = Parameters<Api['extendRunBudget']>[1];

const BOUND_TEXT = { time: 'time', tokens: 'tokens', cost: 'cost' } as const;

/** At a bound the header turns into a decision (docs/04 §2.3.1); nothing continues silently. */
function BudgetBanner({
  run,
  bound,
  onQuick,
  onExtend,
}: {
  run: RunView;
  bound: 'time' | 'tokens' | 'cost' | 'backstop';
  onQuick: (body: QuickExtend, label: string) => Promise<void>;
  onExtend: () => void;
}) {
  const headingId = useId();
  const amounts =
    bound === 'time'
      ? `${minutes(run.used.timeSeconds)} / ${minutes(run.budgets.timeSeconds)} min`
      : bound === 'tokens'
        ? `${formatTokens(run.used.tokens)} / ${formatTokens(run.budgets.tokens)} tokens`
        : bound === 'cost'
          ? `${formatCost(run.used.costUsd)}${run.budgets.costUsd === null ? '' : ` / ${formatCost(run.budgets.costUsd)}`}`
          : null;
  return (
    <section className="work-banner" aria-labelledby={headingId}>
      <div className="work-goal-head">
        <h2 id={headingId}>
          {bound === 'backstop'
            ? 'Step limit reached'
            : `Budget reached: ${BOUND_TEXT[bound]} (${amounts ?? ''})`}
        </h2>
        <StatusChip status="blocked" reason="Budget reached" />
      </div>
      <p className="ws-flush">
        {bound === 'backstop'
          ? 'The last turn used its 200 steps. The run waits until you let it continue.'
          : 'The run paused with its progress saved. Nothing runs until you extend the budget.'}
      </p>
      {run.result?.summary ? <p className="ws-summary">{run.result.summary}</p> : null}
      <div className="ws-toolbar">
        {bound === 'backstop' ? (
          <Button variant="primary" onClick={() => void onQuick({ steps: true }, 'Continuing.')}>
            Continue
          </Button>
        ) : null}
        {bound === 'time' ? (
          <Button
            variant="primary"
            onClick={() => void onQuick({ timeSeconds: 1800 }, 'Added 30 minutes.')}
          >
            Extend 30 min
          </Button>
        ) : null}
        {bound === 'tokens' ? (
          <Button
            variant="primary"
            onClick={() => void onQuick({ tokens: 1_000_000 }, 'Added 1M tokens.')}
          >
            Extend 1M tokens
          </Button>
        ) : null}
        {bound === 'backstop' ? null : <Button onClick={onExtend}>Extend budget…</Button>}
      </div>
    </section>
  );
}

/** Live consumption against each budget (FR-182); waiting time is not counted. */
function BudgetMeters({ run }: { run: RunView }) {
  const headingId = useId();
  const { used, budgets } = run;
  return (
    <section className="work-meters" aria-labelledby={headingId}>
      <h2 id={headingId} className="nv-vh">
        Budget use
      </h2>
      <Meter
        label="Time"
        value={used.timeSeconds}
        max={budgets.timeSeconds}
        text={`${minutes(used.timeSeconds)} / ${minutes(budgets.timeSeconds)} min`}
        hint="Time waiting for an approval or your input is not counted."
      />
      <Meter
        label="Tokens"
        value={used.tokens}
        max={budgets.tokens}
        text={`${formatTokens(used.tokens)} / ${formatTokens(budgets.tokens)}`}
      />
      <Meter
        label="Cost"
        value={used.costUsd}
        max={budgets.costUsd}
        text={
          budgets.costUsd === null
            ? `${formatCost(used.costUsd)} (limit: provider spend cap)`
            : `${formatCost(used.costUsd)} / ${formatCost(budgets.costUsd)}`
        }
      />
    </section>
  );
}

function Meter({
  label,
  value,
  max,
  text,
  hint,
}: {
  label: string;
  value: number;
  max: number | null;
  text: string;
  hint?: string;
}) {
  const id = `mt${useId()}`;
  return (
    <div className="work-meter" title={hint}>
      <span id={`${id}-l`} className="work-meter-label">
        {label}
      </span>
      {max !== null && max > 0 ? (
        <meter
          className="ws-meter"
          min={0}
          max={max}
          value={Math.min(value, max)}
          high={max * 0.8}
          aria-labelledby={`${id}-l`}
          aria-describedby={`${id}-t`}
        />
      ) : null}
      <span id={`${id}-t`} className="work-meter-text">
        {text}
        {hint ? <span className="nv-vh">. {hint}</span> : null}
      </span>
    </div>
  );
}
