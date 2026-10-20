// The agent's goal (FR-181, docs/09 §2.1, docs/04 §2.3.1): the objective (at most 4,000 characters
// with a counter), its status with the blocker, the agent's last progress note, the goal's own
// budgets against what it used, and the responsibility that holds it. Actions follow the runtime:
// Pause, Resume, Mark complete, Budget, Edit and Clear; a completed goal can be reopened or
// replaced by a new one. Setting and clearing go through /agents/:id/goal; edits and status
// changes through /goals/:id, as a run's goal does. Edits apply at the start of the next turn.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentResponsibilityView, BudgetAmounts, GoalView } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatCost, formatSpan, formatTokens } from '../work/format.ts';
import { GoalBadge } from '../work/GoalPanel.tsx';
import { useAgentsApi } from './api.ts';
import { FIELDS_TEXT } from './fields.tsx';
import { AGENTS_TEXT } from './format.ts';
import { rich } from '../i18n/rich.tsx';

export const GOAL_TEXT = defineMessages('agents.goal', {
  /** One measure against its limit: "12 min of 60 min". */
  usedOf: '{used} of {limit}',
  /** Time, tokens and cost used, each against its limit when one is set. */
  usage: '{time} · {tokens} tokens · {cost}',
  loadFailed: 'Could not load the goal.',
  /** Why a goal action failed when the goal's budget is used up. */
  budgetUsedUp: 'its budget is used up; raise the goal budget first',
  changeFailed: 'Could not change the goal: {reason}',
  setFailed: 'Could not set the goal: {reason}',
  saveFailed: 'Could not save the goal: {reason}',
  holderFailed: 'Could not change it: {reason}',
  clearFailed: 'Could not clear the goal: {reason}',
  heading: 'Goal',
  loading: 'Loading the goal',
  setDone: 'Goal set. The agent starts on it when it is idle.',
  setGoal: 'Set goal',
  none:
    'No goal. A goal keeps the agent working toward an outcome, turn after turn, while it is ' +
    'idle, until it is complete or a budget is reached.',
  setAGoal: 'Set a goal',
  saveGoal: 'Save goal',
  blocked: 'Blocked: {what} (reported {n, plural, one {once} other {# times}})',
  budgetLimited: 'The goal budget is used up. Raise it to let the agent continue.',
  usageLimited: 'Continues when the provider usage limit resets.',
  lastProgress: 'Last progress:',
  completed: 'Completed:',
  used: 'Used:',
  heldBy: 'Held by',
  wholeAgent: 'The agent as a whole',
  heldByHint: 'The responsibility this goal belongs to.',
  actions: 'Goal actions',
  pause: 'Pause goal',
  resume: 'Resume goal',
  budget: 'Goal budget…',
  complete: 'Mark complete',
  clear: 'Clear goal',
  reopen: 'Reopen goal',
  setNew: 'Set a new goal',
  clearTitle: 'Clear the goal?',
  clearBody: 'The agent stops working toward this goal. Its responsibilities and other work go on.',
  keep: 'Keep the goal',
  cleared: 'Goal cleared.',
  budgetSaved: 'Goal budget saved.',
  objective: 'Goal objective',
  count: '{n} / {max} characters. Changes apply at the start of the next turn.',
  budgetTitle: 'Goal budget',
  budgetBody:
    'Used so far: {usage}. Raise a limit to let the agent continue; leave a field blank for no limit.',
  saveBudget: 'Save budget',
  budgetFailed: 'Could not save the goal budget.',
  minutesError: 'Enter whole minutes, at least {min}.',
  tokensError: '{min, plural, one {Enter at least # token.} other {Enter at least # tokens.}}',
  costError: 'Enter a cost in US dollars.',
});

const GOAL_MAX = 4000;

/** "12 min of 60 min · 30K tokens · $0.12 of $5.00": use against each limit that is set. */
export function goalUsageLine(goal: Pick<GoalView, 'budgets' | 'usage'>): string {
  const b = goal.budgets;
  const u = goal.usage;
  const part = (used: string, limit: string | null) =>
    limit ? GOAL_TEXT.usedOf({ used, limit }) : used;
  return GOAL_TEXT.usage({
    time: part(
      formatSpan(u.timeSeconds ?? 0),
      b.timeSeconds !== undefined ? formatSpan(b.timeSeconds) : null,
    ),
    tokens: part(
      formatTokens(u.tokens ?? 0),
      b.tokens !== undefined ? formatTokens(b.tokens) : null,
    ),
    cost: part(formatCost(u.costUsd ?? 0), b.costUsd !== undefined ? formatCost(b.costUsd) : null),
  });
}

export function AgentGoal({
  agentId,
  version,
  onChanged,
}: {
  agentId: string;
  version: number;
  /** The goal changed here: the agent's header and chip follow. */
  onChanged: () => void;
}) {
  const { api: core } = useServices();
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  /** undefined while loading; null when the agent has no goal. */
  const [goal, setGoal] = useState<GoalView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [resps, setResps] = useState<AgentResponsibilityView[]>([]);
  const [manual, setManual] = useState(0);
  const [editing, setEditing] = useState(false);
  /** A completed goal stays readable until the user starts a new one. */
  const [replacing, setReplacing] = useState(false);
  const [budgeting, setBudgeting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getAgentGoal(agentId).then(
      (g) => {
        if (!alive) return;
        setGoal(g);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, GOAL_TEXT.loadFailed)),
    );
    api.listResponsibilities(agentId).then(
      ({ items }) => alive && setResps(items),
      () => undefined, // naming the holder is a nicety; the goal works without it
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  const fail = (failed: (p: { reason: string }) => string) => (err: unknown) => {
    const reason =
      err instanceof ApiError && err.body.code === 'budget_exhausted'
        ? GOAL_TEXT.budgetUsedUp
        : errorMessage(err);
    toast.show(failed({ reason }), { tone: 'error' });
  };
  const changed = (g: GoalView | null) => {
    setGoal(g);
    onChanged();
  };
  const act = (action: 'pause' | 'resume' | 'complete') => {
    if (!goal) return;
    core.goalAction(goal.id, action).then(changed, fail(GOAL_TEXT.changeFailed));
  };

  const heading = (
    <div className="work-goal-head">
      <h2 id={headingId}>{GOAL_TEXT.heading}</h2>
      {goal && !replacing ? <GoalBadge goal={goal} /> : null}
    </div>
  );

  if (error)
    return (
      <section className="panel-inset agent-section" aria-labelledby={headingId}>
        {heading}
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      </section>
    );
  if (goal === undefined)
    return (
      <section className="panel-inset agent-section" aria-labelledby={headingId}>
        {heading}
        <Spinner label={GOAL_TEXT.loading} />
      </section>
    );

  const setNew = async (objective: string, rid: string) => {
    try {
      changed(
        await api.setAgentGoal(agentId, { objective, ...(rid ? { responsibilityId: rid } : {}) }),
      );
      setReplacing(false);
      setManual((n) => n + 1);
      toast.show(GOAL_TEXT.setDone, { tone: 'success' });
      return true;
    } catch (err) {
      fail(GOAL_TEXT.setFailed)(err);
      return false;
    }
  };

  if (!goal || replacing)
    return (
      <section className="panel-inset agent-section" aria-labelledby={headingId}>
        {heading}
        {editing || replacing ? (
          <GoalEditor
            initial=""
            saveLabel={GOAL_TEXT.setGoal}
            responsibilities={resps}
            onCancel={() => {
              setEditing(false);
              setReplacing(false);
            }}
            onSave={async (text, rid) => {
              if (await setNew(text, rid)) setEditing(false);
            }}
          />
        ) : (
          <>
            <p className="muted ws-flush">{GOAL_TEXT.none}</p>
            <div className="ws-toolbar">
              <Button onClick={() => setEditing(true)}>{GOAL_TEXT.setAGoal}</Button>
            </div>
          </>
        )}
      </section>
    );

  const s = goal.status;
  const open = s !== 'complete';
  const holder = resps.find((r) => r.goalId === goal.id);
  return (
    <section
      className="panel-inset agent-section work-goal"
      aria-labelledby={headingId}
      data-goal={s}
    >
      {heading}
      {editing ? (
        <GoalEditor
          initial={goal.objective}
          saveLabel={GOAL_TEXT.saveGoal}
          responsibilities={null}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            try {
              changed(await core.updateGoal(goal.id, { objective: text }));
              setEditing(false);
            } catch (err) {
              fail(GOAL_TEXT.saveFailed)(err);
            }
          }}
        />
      ) : (
        <p className="work-goal-objective" dir="auto">
          {goal.objective}
        </p>
      )}
      {s === 'blocked' && goal.blocker ? (
        <p className="ws-callout" role="note">
          <Icon name="stop" />
          <span>
            {rich((p) => GOAL_TEXT.blocked({ ...p, n: goal.blocker?.count ?? 1 }), {
              what: (
                <span data-untrusted="true" dir="auto">
                  {goal.blocker.description ?? goal.blocker.key}
                </span>
              ),
            })}
          </span>
        </p>
      ) : null}
      {s === 'budget_limited' ? (
        <p className="ws-callout" role="note">
          <Icon name="stop" />
          <span>{GOAL_TEXT.budgetLimited}</span>
        </p>
      ) : null}
      {s === 'usage_limited' ? <p className="muted ws-flush">{GOAL_TEXT.usageLimited}</p> : null}
      {goal.statusReason && s !== 'blocked' ? (
        <p className="muted ws-flush">{goal.statusReason}</p>
      ) : null}
      {goal.progressNote ? (
        <p className="ws-flush">
          <span className="muted">{GOAL_TEXT.lastProgress}</span>{' '}
          <span data-untrusted="true" dir="auto">
            {goal.progressNote}
          </span>
        </p>
      ) : null}
      {s === 'complete' && goal.completionSummary ? (
        <p className="ws-flush">
          <span className="muted">{GOAL_TEXT.completed}</span>{' '}
          <span data-untrusted="true" dir="auto">
            {goal.completionSummary}
          </span>
        </p>
      ) : null}
      <p className="ws-flush" role="status">
        <span className="muted">{GOAL_TEXT.used}</span> {goalUsageLine(goal)}
      </p>
      {open && resps.length ? (
        <SelectField
          label={GOAL_TEXT.heldBy}
          value={holder?.id ?? ''}
          onChange={(rid) => {
            api
              .setAgentGoal(agentId, {
                objective: goal.objective,
                budgets: goal.budgets,
                ...(rid ? { responsibilityId: rid } : {}),
              })
              .then((g) => {
                changed(g);
                setManual((n) => n + 1);
              }, fail(GOAL_TEXT.holderFailed));
          }}
          options={[
            { value: '', label: GOAL_TEXT.wholeAgent, disabled: !!holder },
            ...resps.map((r) => ({ value: r.id, label: r.title })),
          ]}
          hint={GOAL_TEXT.heldByHint}
        />
      ) : null}
      {editing ? null : (
        <div className="ws-toolbar" role="group" aria-label={GOAL_TEXT.actions}>
          {open ? <Button onClick={() => setEditing(true)}>{AGENTS_TEXT.edit}</Button> : null}
          {s === 'active' ? <Button onClick={() => act('pause')}>{GOAL_TEXT.pause}</Button> : null}
          {s === 'paused' || s === 'blocked' ? (
            <Button onClick={() => act('resume')}>{GOAL_TEXT.resume}</Button>
          ) : null}
          {open ? <Button onClick={() => setBudgeting(true)}>{GOAL_TEXT.budget}</Button> : null}
          {open ? <Button onClick={() => act('complete')}>{GOAL_TEXT.complete}</Button> : null}
          {open ? (
            <Button variant="ghost" onClick={() => setConfirmClear(true)}>
              {GOAL_TEXT.clear}
            </Button>
          ) : (
            <>
              <Button onClick={() => act('resume')}>{GOAL_TEXT.reopen}</Button>
              <Button onClick={() => setReplacing(true)}>{GOAL_TEXT.setNew}</Button>
            </>
          )}
        </div>
      )}
      <Dialog
        open={confirmClear}
        title={GOAL_TEXT.clearTitle}
        description={GOAL_TEXT.clearBody}
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>{GOAL_TEXT.keep}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                api.clearAgentGoal(agentId).then(() => {
                  setManual((n) => n + 1);
                  onChanged();
                  toast.show(GOAL_TEXT.cleared, { tone: 'success' });
                }, fail(GOAL_TEXT.clearFailed));
              }}
            >
              {GOAL_TEXT.clear}
            </Button>
          </>
        }
      />
      {budgeting ? (
        <GoalBudgetDialog
          goal={goal}
          onClose={() => setBudgeting(false)}
          onSave={async (budgets) => {
            changed(await core.updateGoal(goal.id, { budgets }));
            setBudgeting(false);
            toast.show(GOAL_TEXT.budgetSaved, { tone: 'success' });
          }}
        />
      ) : null}
    </section>
  );
}

function GoalEditor({
  initial,
  saveLabel,
  responsibilities,
  onSave,
  onCancel,
}: {
  initial: string;
  saveLabel: string;
  /** Offer to choose the holding responsibility (a new goal only). */
  responsibilities: AgentResponsibilityView[] | null;
  onSave: (text: string, responsibilityId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `ag-goal${useId()}`;
  const [text, setText] = useState(initial);
  const [rid, setRid] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSave(text.trim(), rid);
    setBusy(false);
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={id}>
          {GOAL_TEXT.objective}
        </label>
        <textarea
          id={id}
          // Editing starts here: the button that opened the editor is gone.
          autoFocus
          className="nv-input ws-textarea"
          rows={3}
          maxLength={GOAL_MAX}
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
          {GOAL_TEXT.count({ n: text.length, max: GOAL_MAX })}
        </span>
      </div>
      {responsibilities?.length ? (
        <SelectField
          label={GOAL_TEXT.heldBy}
          value={rid}
          onChange={setRid}
          options={[
            { value: '', label: GOAL_TEXT.wholeAgent },
            ...responsibilities.map((r) => ({ value: r.id, label: r.title })),
          ]}
        />
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} {saveLabel}
        </Button>
        <Button onClick={onCancel}>{AGENTS_TEXT.cancel}</Button>
      </div>
    </form>
  );
}

/** Set the goal's limits; blank means no limit of that kind. The use so far is shown. */
function GoalBudgetDialog({
  goal,
  onClose,
  onSave,
}: {
  goal: GoalView;
  onClose: () => void;
  onSave: (b: BudgetAmounts) => Promise<void>;
}) {
  const b = goal.budgets;
  const [minutes, setMinutes] = useState(
    b.timeSeconds !== undefined ? String(Math.round(b.timeSeconds / 60)) : '',
  );
  const [tokens, setTokens] = useState(b.tokens !== undefined ? String(b.tokens) : '');
  const [cost, setCost] = useState(b.costUsd !== undefined ? String(b.costUsd) : '');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = parseGoalBudget(minutes, tokens, cost);
  const submit = async () => {
    if ('error' in parsed || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(parsed.budgets);
    } catch (err) {
      setFailure(errorMessage(err, GOAL_TEXT.budgetFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={GOAL_TEXT.budgetTitle}
      description={GOAL_TEXT.budgetBody({ usage: goalUsageLine(goal) })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{AGENTS_TEXT.cancel}</Button>
          <Button
            variant="primary"
            disabled={'error' in parsed || busy}
            onClick={() => void submit()}
          >
            {busy ? <Spinner /> : null} {GOAL_TEXT.saveBudget}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label={FIELDS_TEXT.minutes}
          inputMode="numeric"
          className="ws-number"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <TextField
          label={FIELDS_TEXT.tokens}
          inputMode="numeric"
          className="ws-number"
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
        />
        <TextField
          label={FIELDS_TEXT.cost}
          inputMode="decimal"
          className="ws-number"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />
        {'error' in parsed ? (
          <p className="nv-field-error" role="alert">
            {parsed.error}
          </p>
        ) : null}
        {failure ? (
          <p className="nv-field-error" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The goal's limits from the dialog's fields (the Hub's minimums), or what to fix. */
export function parseGoalBudget(
  minutes: string,
  tokens: string,
  cost: string,
): { budgets: BudgetAmounts } | { error: string } {
  const out: BudgetAmounts = {};
  if (minutes.trim()) {
    const m = Number(minutes);
    if (!/^\d+$/.test(minutes.trim()) || m < 1)
      return { error: GOAL_TEXT.minutesError({ min: 1 }) };
    out.timeSeconds = m * 60;
  }
  if (tokens.trim()) {
    const t = Number(tokens);
    if (!/^\d+$/.test(tokens.trim()) || t < 1_000)
      return { error: GOAL_TEXT.tokensError({ min: 1_000 }) };
    out.tokens = t;
  }
  if (cost.trim()) {
    const c = Number(cost);
    if (!Number.isFinite(c) || c < 0) return { error: GOAL_TEXT.costError };
    out.costUsd = c;
  }
  return { budgets: out };
}
