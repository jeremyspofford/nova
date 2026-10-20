// A Code session's budgets (docs/09 §2, docs/04 §2.3.1): time, tokens and cost used against
// their limits, live as turns end. At a bound the session's turns stop and the bar turns into a
// decision: Extend 30 min / 1M tokens, or Extend budget… for any amount. A session without
// limits shows what it used and can be given limits the same way (each amount is added to what
// it used so far). Nothing continues silently.
import { useId, useRef, useState } from 'react';
import type { CodeBudgetView } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner, StatusChip, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useCodeM6Api } from './api-m6.ts';
import {
  costText,
  formatCost,
  formatSpan,
  formatTokens,
  hasLimits,
  timeText,
  tokensText,
} from './m6-format.ts';

type Extension = { timeSeconds?: number; tokens?: number; costUsd?: number };

export interface ExtendDraft {
  minutes: string;
  tokens: string;
  cost: string;
}

export const BUDGET_TEXT = defineMessages('code.budget', {
  minutesRange: 'Add time in whole minutes, from {min} to {max}.',
  tokensRange: 'Add tokens from {min} to {max}.',
  costRange: 'Add a cost from {min} to {max} US dollars.',
  nothing: 'Add time, tokens or cost.',
  extendFailed: 'Could not extend the budget: {reason}',
  reached:
    '{bound, select, time {Budget reached: time ({amount})} tokens {Budget reached: tokens ({amount})} other {Budget reached: cost ({amount})}}',
  reachedChip: 'Budget reached',
  stopped:
    'The session stopped with its work saved. Its next turn starts only after you extend the budget.',
  title: 'Budget',
  time: 'Time',
  timeHint: 'Time waiting for an approval or your input is not counted.',
  tokens: 'Tokens',
  cost: 'Cost',
  /** Read after a meter's amount by screen readers. */
  hintSuffix: '. {hint}',
  noLimits:
    'No limits: this session runs until you stop it. Used so far: {time}, {tokens} tokens, {cost}.',
  added30: 'Added 30 minutes.',
  extend30: 'Extend 30 min',
  added1M: 'Added 1M tokens.',
  extend1M: 'Extend 1M tokens',
  extend: 'Extend budget…',
  set: 'Set a budget…',
  extended: 'Budget extended.',
  noTimeLimit: 'no time limit',
  timeLimit: '{time} of time',
  noTokenLimit: 'no token limit',
  tokenLimit: '{tokens} tokens',
  noCostLimit: 'no cost limit',
  extendDialogFailed: 'Could not extend the budget.',
  extendTitle: 'Extend budget',
  setTitle: 'Set a budget',
  now: 'Now: {limits}. Each amount below is added to its limit; where there is none, the limit becomes what the session used plus the amount.',
  addTime: 'Add time (minutes)',
  addTokens: 'Add tokens',
  addCost: 'Add cost (US dollars)',
  cancel: 'Cancel',
  extendButton: 'Extend',
});

/** The amounts to add (within the Hub's bounds), or the first problem. */
export function parseCodeExtension(d: ExtendDraft): { body: Extension } | { error: string } {
  const body: Extension = {};
  if (d.minutes.trim()) {
    const m = Number(d.minutes);
    if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
      return { error: BUDGET_TEXT.minutesRange({ min: 1, max: 7 * 24 * 60 }) };
    body.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 1_000_000_000)
      return { error: BUDGET_TEXT.tokensRange({ min: 1_000, max: 1_000_000_000 }) };
    body.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c < 0.01 || c > 100_000)
      return { error: BUDGET_TEXT.costRange({ min: 0.01, max: 100_000 }) };
    body.costUsd = c;
  }
  if (!Object.keys(body).length) return { error: BUDGET_TEXT.nothing };
  return { body };
}

export function BudgetBar({
  sessionId,
  budget,
  onChanged,
}: {
  sessionId: string;
  budget: CodeBudgetView;
  onChanged: (b: CodeBudgetView) => void;
}) {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [extending, setExtending] = useState(false);
  const [busy, setBusy] = useState(false);
  const limited = hasLimits(budget);
  const reached = budget.reached;

  const quick = async (body: Extension, said: string) => {
    setBusy(true);
    try {
      onChanged(await m6.extendCodeBudget(sessionId, body));
      announce(said);
    } catch (err) {
      toast.show(BUDGET_TEXT.extendFailed({ reason: errorMessage(err) }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="code-budget"
      aria-labelledby={headingId}
      data-reached={reached ? true : undefined}
    >
      {reached ? (
        <div className="code-budget-banner">
          <h2 id={headingId}>
            {BUDGET_TEXT.reached({
              bound: reached,
              amount:
                reached === 'time'
                  ? timeText(budget)
                  : reached === 'tokens'
                    ? tokensText(budget)
                    : costText(budget),
            })}
          </h2>
          <StatusChip status="blocked" reason={BUDGET_TEXT.reachedChip} />
          <p className="ws-flush">{BUDGET_TEXT.stopped}</p>
        </div>
      ) : (
        <h2 id={headingId} className="nv-vh">
          {BUDGET_TEXT.title}
        </h2>
      )}
      <div className="code-meters">
        {limited || reached ? (
          <>
            <Meter
              label={BUDGET_TEXT.time}
              value={budget.used.timeSeconds}
              max={budget.limits.timeSeconds}
              text={timeText(budget)}
              hint={BUDGET_TEXT.timeHint}
            />
            <Meter
              label={BUDGET_TEXT.tokens}
              value={budget.used.tokens}
              max={budget.limits.tokens}
              text={tokensText(budget)}
            />
            <Meter
              label={BUDGET_TEXT.cost}
              value={budget.used.costUsd}
              max={budget.limits.costUsd}
              text={costText(budget)}
            />
          </>
        ) : (
          // Without limits one line says what the session used.
          <p className="muted code-budget-note">
            {BUDGET_TEXT.noLimits({
              time: formatSpan(budget.used.timeSeconds),
              tokens: formatTokens(budget.used.tokens),
              cost: formatCost(budget.used.costUsd),
            })}
          </p>
        )}
        <div className="code-budget-actions">
          {reached === 'time' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void quick({ timeSeconds: 1800 }, BUDGET_TEXT.added30)}
            >
              {BUDGET_TEXT.extend30}
            </Button>
          ) : null}
          {reached === 'tokens' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void quick({ tokens: 1_000_000 }, BUDGET_TEXT.added1M)}
            >
              {BUDGET_TEXT.extend1M}
            </Button>
          ) : null}
          <Button onClick={() => setExtending(true)}>
            {limited ? BUDGET_TEXT.extend : BUDGET_TEXT.set}
          </Button>
        </div>
      </div>
      <ExtendCodeBudgetDialog
        open={extending}
        sessionId={sessionId}
        budget={budget}
        onClose={() => setExtending(false)}
        onExtended={(b) => {
          setExtending(false);
          onChanged(b);
          announce(BUDGET_TEXT.extended);
        }}
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
  const id = `cm${useId()}`;
  return (
    <div className="code-meter" title={hint} data-unlimited={max === null || undefined}>
      <span id={`${id}-l`} className="code-meter-label">
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
      <span id={`${id}-t`} className="code-meter-text">
        {text}
        {hint ? <span className="nv-vh">{BUDGET_TEXT.hintSuffix({ hint })}</span> : null}
      </span>
    </div>
  );
}

function ExtendCodeBudgetDialog({
  open,
  sessionId,
  budget,
  onClose,
  onExtended,
}: {
  open: boolean;
  sessionId: string;
  budget: CodeBudgetView;
  onClose: () => void;
  onExtended: (b: CodeBudgetView) => void;
}) {
  return open ? (
    <ExtendForm sessionId={sessionId} budget={budget} onClose={onClose} onExtended={onExtended} />
  ) : null;
}

function ExtendForm({
  sessionId,
  budget,
  onClose,
  onExtended,
}: {
  sessionId: string;
  budget: CodeBudgetView;
  onClose: () => void;
  onExtended: (b: CodeBudgetView) => void;
}) {
  const m6 = useCodeM6Api();
  const first = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ExtendDraft>({ minutes: '', tokens: '', cost: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseCodeExtension(draft);
  const touched = !!(draft.minutes || draft.tokens || draft.cost);
  const { limits } = budget;
  const current = fmt.list(
    [
      limits.timeSeconds === null
        ? BUDGET_TEXT.noTimeLimit
        : BUDGET_TEXT.timeLimit({ time: formatSpan(limits.timeSeconds) }),
      limits.tokens === null
        ? BUDGET_TEXT.noTokenLimit
        : BUDGET_TEXT.tokenLimit({ tokens: formatTokens(limits.tokens) }),
      limits.costUsd === null ? BUDGET_TEXT.noCostLimit : formatCost(limits.costUsd),
    ],
    { type: 'unit', style: 'short' },
  );

  const submit = async () => {
    if (busy || 'error' in parsed) return;
    setBusy(true);
    setError(null);
    try {
      onExtended(await m6.extendCodeBudget(sessionId, parsed.body));
    } catch (err) {
      setError(errorMessage(err, BUDGET_TEXT.extendDialogFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={hasLimits(budget) ? BUDGET_TEXT.extendTitle : BUDGET_TEXT.setTitle}
      description={BUDGET_TEXT.now({ limits: current })}
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={first}
          label={BUDGET_TEXT.addTime}
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1}
          step={1}
          value={draft.minutes}
          onChange={(e) => setDraft((d) => ({ ...d, minutes: e.target.value }))}
        />
        <TextField
          label={BUDGET_TEXT.addTokens}
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1000}
          step={1000}
          value={draft.tokens}
          onChange={(e) => setDraft((d) => ({ ...d, tokens: e.target.value }))}
        />
        <TextField
          label={BUDGET_TEXT.addCost}
          type="number"
          inputMode="decimal"
          className="ws-number"
          min={0.01}
          step={0.01}
          value={draft.cost}
          onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))}
        />
        {touched && 'error' in parsed ? (
          <p className="nv-field-error" role="alert">
            {parsed.error}
          </p>
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{BUDGET_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || 'error' in parsed}>
            {busy ? <Spinner /> : null} <Icon name="clock" /> {BUDGET_TEXT.extendButton}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
