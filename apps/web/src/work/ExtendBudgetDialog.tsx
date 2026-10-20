// Extend budget… (FR-182, docs/04 §2.3.1): add time, tokens or cost to a run's budgets. A run
// paused at a bound continues once the Hub accepts the extension; nothing continues silently.
import { useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { RunView } from '@nova/shared';
import { Button, Dialog, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import { WORK_TEXT, budgetLine } from './format.ts';

/** Extend budget… */
export const EXTEND_TEXT = defineMessages('work.extend', {
  minutes: 'Add time in whole minutes, from {min} to {max}.',
  tokens: 'Add tokens from {min} to {max}.',
  cost: 'Add a cost from {min} to {max} US dollars.',
  nothing: 'Add time, tokens or cost.',
  failed: 'Could not extend the budget.',
  title: 'Extend budget',
  /** {budgets} lists the run's budgets, such as "60 min · 2M tokens · $5.00 limit". */
  description: 'Current budgets: {budgets}. The amounts below are added to them.',
  addTime: 'Add time (minutes)',
  addTokens: 'Add tokens',
  addCost: 'Add cost (US dollars)',
  costHint: 'A cost above the provider spend cap needs the cap raised first.',
  submit: 'Extend',
});

type ExtendBody = Parameters<Api['extendRunBudget']>[1];

export interface ExtendDraft {
  minutes: string;
  tokens: string;
  cost: string;
}

/** The amounts to add, or the first problem; blank fields add nothing. */
export function parseExtension(d: ExtendDraft): { body: ExtendBody } | { error: string } {
  const body: Record<string, number> = {};
  if (d.minutes.trim()) {
    const m = Number(d.minutes);
    if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
      return { error: EXTEND_TEXT.minutes({ min: 1, max: 7 * 24 * 60 }) };
    body.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 100_000_000)
      return { error: EXTEND_TEXT.tokens({ min: 1_000, max: 100_000_000 }) };
    body.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c <= 0 || c > 100_000)
      return { error: EXTEND_TEXT.cost({ min: 0.01, max: 100_000 }) };
    body.costUsd = c;
  }
  if (Object.keys(body).length === 0) return { error: EXTEND_TEXT.nothing };
  return { body };
}

export function ExtendBudgetDialog({
  run,
  open,
  onClose,
  onExtended,
}: {
  run: RunView;
  open: boolean;
  onClose: () => void;
  onExtended: (run: RunView) => void;
}) {
  return open ? <ExtendForm run={run} onClose={onClose} onExtended={onExtended} /> : null;
}

function ExtendForm({
  run,
  onClose,
  onExtended,
}: {
  run: RunView;
  onClose: () => void;
  onExtended: (run: RunView) => void;
}) {
  const { api } = useServices();
  const formId = `xb${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ExtendDraft>({ minutes: '', tokens: '', cost: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseExtension(draft);
  const touched = !!(draft.minutes || draft.tokens || draft.cost);
  const S = EXTEND_TEXT;

  const submit = async () => {
    if (busy || 'error' in parsed) return;
    setBusy(true);
    setError(null);
    try {
      onExtended(await api.extendRunBudget(run.id, parsed.body));
    } catch (err) {
      setError(errorMessage(err, S.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title}
      description={S.description({ budgets: budgetLine(run.budgets) })}
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={first}
          label={S.addTime}
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1}
          step={1}
          value={draft.minutes}
          onChange={(e) => setDraft((d) => ({ ...d, minutes: e.target.value }))}
        />
        <TextField
          label={S.addTokens}
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={1000}
          step={1000}
          value={draft.tokens}
          onChange={(e) => setDraft((d) => ({ ...d, tokens: e.target.value }))}
        />
        <TextField
          label={S.addCost}
          type="number"
          inputMode="decimal"
          className="ws-number"
          min={0}
          step={0.01}
          hint={S.costHint}
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
          <Button onClick={onClose}>{WORK_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || 'error' in parsed}>
            {busy ? <Spinner /> : null} {S.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
