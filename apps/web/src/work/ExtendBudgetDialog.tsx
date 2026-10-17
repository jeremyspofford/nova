// Extend budget… (FR-182, docs/04 §2.3.1): add time, tokens or cost to a run's budgets. A run
// paused at a bound continues once the Hub accepts the extension; nothing continues silently.
import { useId, useRef, useState } from 'react';
import type { RunView } from '@nova/shared';
import { Button, Dialog, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import { budgetLine } from './format.ts';

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
      return { error: 'Add time in whole minutes, from 1 to 10,080.' };
    body.timeSeconds = m * 60;
  }
  if (d.tokens.trim()) {
    const t = Number(d.tokens);
    if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 100_000_000)
      return { error: 'Add tokens from 1,000 to 100,000,000.' };
    body.tokens = t;
  }
  if (d.cost.trim()) {
    const c = Number(d.cost);
    if (!Number.isFinite(c) || c <= 0 || c > 100_000)
      return { error: 'Add a cost from 0.01 to 100,000 US dollars.' };
    body.costUsd = c;
  }
  if (Object.keys(body).length === 0) return { error: 'Add time, tokens or cost.' };
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

  const submit = async () => {
    if (busy || 'error' in parsed) return;
    setBusy(true);
    setError(null);
    try {
      onExtended(await api.extendRunBudget(run.id, parsed.body));
    } catch (err) {
      setError(errorMessage(err, 'Could not extend the budget.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Extend budget"
      description={`Current budgets: ${budgetLine(run.budgets)}. The amounts below are added to them.`}
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
          min={0}
          step={0.01}
          hint="A cost above the provider spend cap needs the cap raised first."
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
            {busy ? <Spinner /> : null} Extend
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
