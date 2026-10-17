// Form parts shared by creating an agent and editing its profile (FR-079, FR-182): the autonomy
// choice (Autonomous needs a reviewer model, FR-085) and the budgets of each turn chain.
import { useId } from 'react';
import type { AgentView, RunAutonomy } from '@nova/shared';
import { RadioGroup, TextField } from '@nova/ui';
import { useSetting } from '../settings.tsx';
import { followLink } from '../work/nav.tsx';
import { AGENT_AUTONOMY_TEXT } from './format.ts';

export interface BudgetDraft {
  minutes: string;
  tokens: string;
  /** Blank: the provider spend cap. */
  cost: string;
}

export function budgetDraft(b: AgentView['budgets']): BudgetDraft {
  return {
    minutes: String(Math.round(b.timeSeconds / 60)),
    tokens: String(b.tokens),
    cost: b.costUsd === null ? '' : String(b.costUsd),
  };
}

/** The budgets to send, or what to fix in each field (the Hub's limits, docs/09 §2.2). */
export function parseBudgets(
  d: BudgetDraft,
): { budgets: AgentView['budgets'] } | { errors: Partial<Record<keyof BudgetDraft, string>> } {
  const errors: Partial<Record<keyof BudgetDraft, string>> = {};
  const m = Number(d.minutes);
  if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > 7 * 24 * 60)
    errors.minutes = 'Enter whole minutes, from 1 to 10,080 (7 days).';
  const t = Number(d.tokens);
  if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 100_000_000)
    errors.tokens = 'Enter tokens from 1,000 to 100,000,000.';
  const c = d.cost.trim() ? Number(d.cost) : null;
  if (c !== null && (!Number.isFinite(c) || c < 0 || c > 100_000))
    errors.cost = 'Enter US dollars from 0 to 100,000, or leave it blank.';
  if (Object.keys(errors).length) return { errors };
  return { budgets: { timeSeconds: m * 60, tokens: t, costUsd: c } };
}

export function BudgetFields({
  value,
  onChange,
  errors = {},
  disabled,
}: {
  value: BudgetDraft;
  onChange: (next: BudgetDraft) => void;
  errors?: Partial<Record<keyof BudgetDraft, string>>;
  disabled?: boolean;
}) {
  return (
    <fieldset className="ws-fieldset agent-budgets" disabled={disabled}>
      <legend>Budgets for each piece of work</legend>
      <p className="nv-field-hint ws-flush">
        A turn and what follows from it stop at the first limit reached; the agent then waits for
        you.
      </p>
      <div className="agent-budget-fields">
        <TextField
          label="Time (minutes)"
          inputMode="numeric"
          className="ws-number"
          value={value.minutes}
          error={errors.minutes}
          onChange={(e) => onChange({ ...value, minutes: e.target.value })}
        />
        <TextField
          label="Tokens"
          inputMode="numeric"
          className="ws-number"
          value={value.tokens}
          error={errors.tokens}
          onChange={(e) => onChange({ ...value, tokens: e.target.value })}
        />
        <TextField
          label="Cost (US dollars)"
          inputMode="decimal"
          className="ws-number"
          value={value.cost}
          hint="Blank: your provider's spend cap."
          error={errors.cost}
          onChange={(e) => onChange({ ...value, cost: e.target.value })}
        />
      </div>
    </fieldset>
  );
}

export function AutonomyField({
  value,
  onChange,
  disabled,
}: {
  value: RunAutonomy;
  onChange: (next: RunAutonomy) => void;
  disabled?: boolean;
}) {
  const reviewer = useSetting('review.model').value;
  const hintId = useId();
  return (
    <div className="stack">
      <RadioGroup
        legend="Autonomy"
        name={`autonomy${hintId}`}
        value={value}
        locked={disabled}
        onChange={(v) => onChange(v as RunAutonomy)}
        options={(Object.keys(AGENT_AUTONOMY_TEXT) as RunAutonomy[]).map((a) => ({
          value: a,
          label: AGENT_AUTONOMY_TEXT[a].label,
          description: AGENT_AUTONOMY_TEXT[a].description,
        }))}
      />
      {value === 'autonomous' && !reviewer ? (
        <p className="ws-warning" role="note">
          No reviewer model is chosen yet. Choose one in{' '}
          <a href="/settings/code" onClick={(e) => followLink(e, '/settings/code')}>
            Settings, Code
          </a>{' '}
          before saving an autonomous agent.
        </p>
      ) : null}
    </div>
  );
}
