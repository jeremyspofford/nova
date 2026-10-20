// One Work run (FR-051..FR-054, FR-057, FR-181, FR-182, FR-187; docs/04 §2.3, §2.3.1): the
// header (title, status chip, run status, where it came from), the controls (Pause, Resume,
// Redirect, Cancel), live budget meters, a decision banner when a budget pauses it, the goal, the
// plan, the sub-agents, the result, the conversation and the Activity trace. Everything follows
// the shared event stream; budget meters update from usage events without a refetch.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
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
  AMOUNT_TEXT,
  AUTONOMY_TEXT,
  WORK_TEXT,
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
import { OpenInWindowButton } from '../shellbridge/OpenInWindow.tsx';
import { ThreadCloudRun } from '../cloud/ThreadCloudRun.tsx';

/** Events after which the trace has new lines. */
const TRACE_ON = /^(run\.(step|status|completed|budget\.reached|subagent)|approval\.|request\.)/;

/** One run's page. {reason} is the Hub's own words (English, D9). */
export const RUN_TEXT = defineMessages('work.run', {
  origin: {
    user: 'Started by you',
    schedule: 'Started by a schedule',
    trigger: 'Started by a trigger',
    chat_escalation: 'Started from a chat',
    delegation: 'Delegated by another run',
    goal: 'Started to pursue a goal',
  },
  deleted: 'This run was deleted or does not exist.',
  loadFailed: 'Could not load this run.',
  loading: 'Loading the run',
  /** Toasts when a change fails. */
  failed: {
    change: 'Could not change the run: {reason}',
    redirect: 'Could not redirect the run: {reason}',
    extend: 'Could not extend the budget: {reason}',
    setGoal: 'Could not set the goal: {reason}',
    saveGoal: 'Could not save the goal: {reason}',
    changeGoal: 'Could not change the goal: {reason}',
    clearGoal: 'Could not clear the goal: {reason}',
    savePlan: 'Could not save the plan: {reason}',
    start: 'Could not start the run: {reason}',
  },
  /** Said when the status changes: "Run Tidy the notes: Paused by you." */
  statusChanged: 'Run {title}: {status}.',
  /** {level} is the autonomy level, such as "Standard". */
  autonomy: 'Autonomy: {level}',
  /** {when} is a time, such as "5 minutes ago". */
  started: 'Started {when}',
  controls: 'Run controls',
  pause: 'Pause',
  paused: 'Run paused.',
  resume: 'Resume',
  resumed: 'Run resumed.',
  redirect: 'Redirect…',
  cancel: 'Cancel run',
  redirected: 'New instructions sent. The run applies them at its next step.',
  goalSet: 'Goal set.',
  goalSaved: 'Goal saved. It applies at the start of the next turn.',
  goalCleared: 'Goal cleared.',
  planSaved: 'Plan saved.',
  starting: 'The run is starting.',
  extended: 'Budget extended.',
  cancelTitle: 'Cancel this run?',
  cancelBody: 'The run stops now. What it did so far stays in its conversation and Activity.',
  keep: 'Keep running',
  cancelled: 'Run cancelled.',
  instructions: 'New instructions',
  instructionsHint: 'The run applies them at the start of its next step.',
  send: 'Send instructions',
  close: 'Close',
  stepLimit: 'Step limit reached',
  /** {amounts} is what the run used against the budget, such as "10 / 10 min". */
  budgetReached:
    '{bound, select, time {Budget reached: time ({amounts})} tokens {Budget reached: tokens ({amounts})} other {Budget reached: cost ({amounts})}}',
  /** The status chip's reason while a budget pauses the run. */
  budgetReason: 'Budget reached',
  backstopBody: 'The last turn used its 200 steps. The run waits until you let it continue.',
  pausedBody: 'The run paused with its progress saved. Nothing runs until you extend the budget.',
  continue: 'Continue',
  continuing: 'Continuing.',
  extendMinutes: 'Extend {n} min',
  addedMinutes: '{n, plural, one {Added # minute.} other {Added # minutes.}}',
  /** {amount} is a token count, such as "1M". */
  extendTokens: 'Extend {amount} tokens',
  addedTokens: 'Added {amount} tokens.',
  extendBudget: 'Extend budget…',
  budgetUse: 'Budget use',
  time: 'Time',
  tokens: 'Tokens',
  cost: 'Cost',
  timeHint: 'Time waiting for an approval or your input is not counted.',
  /** The cost used when no cost budget is set. */
  costNoLimit: '{cost} (limit: provider spend cap)',
});

function loadError(err: unknown): { message: string; missing: boolean } {
  const missing = err instanceof ApiError && err.status === 404;
  return {
    message: missing ? RUN_TEXT.deleted : errorMessage(err, RUN_TEXT.loadFailed),
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

  const S = RUN_TEXT;
  const fail =
    (what: (p: { reason: string }) => string) =>
    (err: unknown): void => {
      toast.show(what({ reason: errorMessage(err) }), { tone: 'error' });
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
      announce(RUN_TEXT.statusChanged({ title: run.title, status: line }));
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
    }, fail(S.failed.change));
  };

  if (error && !run)
    return (
      <div className="ws-page work-page">
        <Breadcrumb />
        <div role="alert" className="ws-error">
          <p>{error.message}</p>
          {error.missing ? null : (
            <Button onClick={() => setAttempt((n) => n + 1)}>{WORK_TEXT.retry}</Button>
          )}
        </div>
      </div>
    );
  if (!run)
    return (
      <div className="ws-page work-page">
        <Breadcrumb />
        <Spinner label={S.loading} />
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
          <h1 dir="auto">{run.title}</h1>
          <OpenInWindowButton
            path={`/work/${encodeURIComponent(run.id)}`}
            what={run.title}
            compact
          />
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
                {S.origin.chat_escalation}
              </a>
            ) : (
              S.origin[run.origin]
            )}
          </span>
          {project ? (
            <a
              href={projectPath(project.id)}
              onClick={(e) => followLink(e, projectPath(project.id))}
            >
              <Icon name="folder" /> <span dir="auto">{project.name}</span>
            </a>
          ) : null}
          <span>{S.autonomy({ level: AUTONOMY_TEXT[run.autonomy].label })}</span>
          <span>{S.started({ when: formatWhen(run.createdAt) })}</span>
        </p>
        <p className="work-objective" dir="auto">
          {run.objective}
        </p>
        <p role="status" className="work-progress">
          {progressLine(run)}
        </p>
        {final ? null : (
          <div className="ws-toolbar" role="group" aria-label={S.controls}>
            {canPause ? (
              <Button onClick={() => control('pause', S.paused)}>
                <Icon name="stop" /> {S.pause}
              </Button>
            ) : null}
            {canResume ? (
              <Button onClick={() => control('resume', S.resumed)}>
                <Icon name="forward" /> {S.resume}
              </Button>
            ) : null}
            <Button aria-expanded={redirecting} onClick={() => setRedirecting((r) => !r)}>
              {S.redirect}
            </Button>
            <Button variant="danger" onClick={() => setConfirmCancel(true)}>
              {S.cancel}
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
                toast.show(S.redirected, { tone: 'success' });
              } catch (err) {
                fail(S.failed.redirect)(err);
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
            }, fail(S.failed.extend))
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
              toast.show(S.goalSet, { tone: 'success' });
              return true;
            } catch (err) {
              fail(S.failed.setGoal)(err);
              return false;
            }
          },
          edit: async (objective) => {
            if (!goal) return false;
            try {
              setGoal(await api.updateGoal(goal.id, { objective }));
              toast.show(S.goalSaved, { tone: 'success' });
              return true;
            } catch (err) {
              fail(S.failed.saveGoal)(err);
              return false;
            }
          },
          act: (action) => {
            if (!goal) return;
            api.goalAction(goal.id, action).then((g) => setGoal(g), fail(S.failed.changeGoal));
          },
          clear: () => {
            api.clearRunGoal(runId).then(() => {
              setGoal(null);
              toast.show(S.goalCleared, { tone: 'success' });
            }, fail(S.failed.clearGoal));
          },
          extend: () => setExtending(true),
        }}
      />

      <PlanCard
        run={run}
        onSave={async (steps) => {
          try {
            setRun(await api.updateRunPlan(runId, { steps }));
            toast.show(S.planSaved, { tone: 'success' });
            return true;
          } catch (err) {
            fail(S.failed.savePlan)(err);
            return false;
          }
        }}
        onApprove={() => {
          api.startRun(runId).then((r) => {
            setRun(r);
            toast.show(S.starting, { tone: 'success' });
          }, fail(S.failed.start));
        }}
      />

      <SubagentList items={subagents} />

      {final || run.result ? (
        <ResultCard
          run={run}
          onSchedule={() => navigate(`${SCHEDULED_PATH}?fromRun=${encodeURIComponent(run.id)}`)}
        />
      ) : null}

      {/* A run on a cloud environment shows its runner usage and caps (FR-108, M7). */}
      <ThreadCloudRun threadId={run.threadId} environmentId={run.environmentId ?? null} />
      <RunConversation threadId={run.threadId} />

      <ActivityTrace refId={run.threadId} version={traceVersion} />

      <ExtendBudgetDialog
        run={run}
        open={extending}
        onClose={() => setExtending(false)}
        onExtended={(r) => {
          setExtending(false);
          setRun(r);
          toast.show(S.extended, { tone: 'success' });
        }}
      />
      <Dialog
        open={confirmCancel}
        title={S.cancelTitle}
        description={S.cancelBody}
        onClose={() => setConfirmCancel(false)}
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>{S.keep}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmCancel(false);
                control('cancel', S.cancelled);
              }}
            >
              {S.cancel}
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
        <Icon name="back" /> {WORK_TEXT.work}
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
  const S = RUN_TEXT;
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
          {S.instructions}
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
          {S.instructionsHint}
        </span>
      </div>
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} {S.send}
        </Button>
        <Button onClick={onCancel}>{S.close}</Button>
      </div>
    </form>
  );
}

type QuickExtend = Parameters<Api['extendRunBudget']>[1];

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
  const S = RUN_TEXT;
  const A = AMOUNT_TEXT;
  const amounts =
    bound === 'time'
      ? A.minutesOf({
          used: minutes(run.used.timeSeconds),
          total: minutes(run.budgets.timeSeconds),
        })
      : bound === 'tokens'
        ? A.tokensOf({
            used: formatTokens(run.used.tokens),
            total: formatTokens(run.budgets.tokens),
          })
        : run.budgets.costUsd === null
          ? formatCost(run.used.costUsd)
          : A.of({ used: formatCost(run.used.costUsd), total: formatCost(run.budgets.costUsd) });
  const million = formatTokens(1_000_000);
  return (
    <section className="work-banner" aria-labelledby={headingId}>
      <div className="work-goal-head">
        <h2 id={headingId}>
          {bound === 'backstop' ? S.stepLimit : S.budgetReached({ bound, amounts })}
        </h2>
        <StatusChip status="blocked" reason={S.budgetReason} />
      </div>
      <p className="ws-flush">{bound === 'backstop' ? S.backstopBody : S.pausedBody}</p>
      {run.result?.summary ? (
        <p className="ws-summary" dir="auto">
          {run.result.summary}
        </p>
      ) : null}
      <div className="ws-toolbar">
        {bound === 'backstop' ? (
          <Button variant="primary" onClick={() => void onQuick({ steps: true }, S.continuing)}>
            {S.continue}
          </Button>
        ) : null}
        {bound === 'time' ? (
          <Button
            variant="primary"
            onClick={() => void onQuick({ timeSeconds: 1800 }, S.addedMinutes({ n: 30 }))}
          >
            {S.extendMinutes({ n: 30 })}
          </Button>
        ) : null}
        {bound === 'tokens' ? (
          <Button
            variant="primary"
            onClick={() => void onQuick({ tokens: 1_000_000 }, S.addedTokens({ amount: million }))}
          >
            {S.extendTokens({ amount: million })}
          </Button>
        ) : null}
        {bound === 'backstop' ? null : <Button onClick={onExtend}>{S.extendBudget}</Button>}
      </div>
    </section>
  );
}

/** Live consumption against each budget (FR-182); waiting time is not counted. */
function BudgetMeters({ run }: { run: RunView }) {
  const headingId = useId();
  const { used, budgets } = run;
  const S = RUN_TEXT;
  const A = AMOUNT_TEXT;
  return (
    <section className="work-meters" aria-labelledby={headingId}>
      <h2 id={headingId} className="nv-vh">
        {S.budgetUse}
      </h2>
      <Meter
        label={S.time}
        value={used.timeSeconds}
        max={budgets.timeSeconds}
        text={A.minutesOf({ used: minutes(used.timeSeconds), total: minutes(budgets.timeSeconds) })}
        hint={S.timeHint}
      />
      <Meter
        label={S.tokens}
        value={used.tokens}
        max={budgets.tokens}
        text={A.of({ used: formatTokens(used.tokens), total: formatTokens(budgets.tokens) })}
      />
      <Meter
        label={S.cost}
        value={used.costUsd}
        max={budgets.costUsd}
        text={
          budgets.costUsd === null
            ? S.costNoLimit({ cost: formatCost(used.costUsd) })
            : A.of({ used: formatCost(used.costUsd), total: formatCost(budgets.costUsd) })
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
