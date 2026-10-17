// A Code session's budgets (docs/09 §2, docs/04 §2.3.1): time, tokens and cost used against
// their limits, live as turns end. At a bound the session's turns stop and the bar turns into a
// decision: Extend 30 min / 1M tokens, or Extend budget… for any amount. A session without
// limits shows what it used and can be given limits the same way (each amount is added to what
// it used so far). Nothing continues silently.
import { useId, useRef, useState } from 'react';
import type { CodeBudgetView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, StatusChip, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useCodeM6Api } from './api-m6.ts';
import {
  BOUND_TEXT,
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

/** The amounts to add (within the Hub's bounds), or the first problem. */
export function parseCodeExtension(d: ExtendDraft): { body: Extension } | { error: string } {
  const body: Extension = {};
  if (d.minutes.trim()) {
    const m = Number(d.minutes);
    if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
      return { error: 'Add time in whole minutes, from 1 to 10,080.' };
    body.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 1_000_000_000)
      return { error: 'Add tokens from 1,000 to 1,000,000,000.' };
    body.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c < 0.01 || c > 100_000)
      return { error: 'Add a cost from 0.01 to 100,000 US dollars.' };
    body.costUsd = c;
  }
  if (!Object.keys(body).length) return { error: 'Add time, tokens or cost.' };
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
      toast.show(`Could not extend the budget: ${errorMessage(err)}`, { tone: 'error' });
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
            Budget reached: {BOUND_TEXT[reached]} (
            {reached === 'time'
              ? timeText(budget)
              : reached === 'tokens'
                ? tokensText(budget)
                : costText(budget)}
            )
          </h2>
          <StatusChip status="blocked" reason="Budget reached" />
          <p className="ws-flush">
            The session stopped with its work saved. Its next turn starts only after you extend the
            budget.
          </p>
        </div>
      ) : (
        <h2 id={headingId} className="nv-vh">
          Budget
        </h2>
      )}
      <div className="code-meters">
        {limited || reached ? (
          <>
            <Meter
              label="Time"
              value={budget.used.timeSeconds}
              max={budget.limits.timeSeconds}
              text={timeText(budget)}
              hint="Time waiting for an approval or your input is not counted."
            />
            <Meter
              label="Tokens"
              value={budget.used.tokens}
              max={budget.limits.tokens}
              text={tokensText(budget)}
            />
            <Meter
              label="Cost"
              value={budget.used.costUsd}
              max={budget.limits.costUsd}
              text={costText(budget)}
            />
          </>
        ) : (
          // Without limits one line says what the session used.
          <p className="muted code-budget-note">
            No limits: this session runs until you stop it. Used so far:{' '}
            {formatSpan(budget.used.timeSeconds)}, {formatTokens(budget.used.tokens)} tokens,{' '}
            {formatCost(budget.used.costUsd)}.
          </p>
        )}
        <div className="code-budget-actions">
          {reached === 'time' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void quick({ timeSeconds: 1800 }, 'Added 30 minutes.')}
            >
              Extend 30 min
            </Button>
          ) : null}
          {reached === 'tokens' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void quick({ tokens: 1_000_000 }, 'Added 1M tokens.')}
            >
              Extend 1M tokens
            </Button>
          ) : null}
          <Button onClick={() => setExtending(true)}>
            {limited ? 'Extend budget…' : 'Set a budget…'}
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
          announce('Budget extended.');
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
        {hint ? <span className="nv-vh">. {hint}</span> : null}
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
  const current = [
    limits.timeSeconds === null ? 'no time limit' : `${formatSpan(limits.timeSeconds)} of time`,
    limits.tokens === null ? 'no token limit' : `${formatTokens(limits.tokens)} tokens`,
    limits.costUsd === null ? 'no cost limit' : `${formatCost(limits.costUsd)}`,
  ].join(', ');

  const submit = async () => {
    if (busy || 'error' in parsed) return;
    setBusy(true);
    setError(null);
    try {
      onExtended(await m6.extendCodeBudget(sessionId, parsed.body));
    } catch (err) {
      setError(errorMessage(err, 'Could not extend the budget.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={hasLimits(budget) ? 'Extend budget' : 'Set a budget'}
      description={`Now: ${current}. Each amount below is added to its limit; where there is none, the limit becomes what the session used plus the amount.`}
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
          label="Add time (minutes)"
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1}
          step={1}
          value={draft.minutes}
          onChange={(e) => setDraft((d) => ({ ...d, minutes: e.target.value }))}
        />
        <TextField
          label="Add tokens"
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1000}
          step={1000}
          value={draft.tokens}
          onChange={(e) => setDraft((d) => ({ ...d, tokens: e.target.value }))}
        />
        <TextField
          label="Add cost (US dollars)"
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || 'error' in parsed}>
            {busy ? <Spinner /> : null} <Icon name="clock" /> Extend
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
