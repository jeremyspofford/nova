// Form parts shared by creating an agent and editing its profile (FR-079, FR-182): the autonomy
// choice (Autonomous needs a reviewer model, FR-085) and the budgets of each turn chain.
import { useId } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentView, RunAutonomy } from '@nova/shared';
import { RadioGroup, TextField } from '@nova/ui';
import { useSetting } from '../settings.tsx';
import { followLink } from '../work/nav.tsx';
import { AGENT_AUTONOMY_TEXT } from './format.ts';
import { rich } from '../i18n/rich.tsx';

export const FIELDS_TEXT = defineMessages('agents.fields', {
  minutesError:
    'Enter whole minutes, from {min} to {max} ({days, plural, one {# day} other {# days}}).',
  tokensError: 'Enter tokens from {min} to {max}.',
  costError: 'Enter US dollars from {min} to {max}, or leave it blank.',
  budgets: 'Budgets for each piece of work',
  budgetsHint:
    'A turn and what follows from it stop at the first limit reached; the agent then waits ' +
    'for you.',
  minutes: 'Time (minutes)',
  tokens: 'Tokens',
  cost: 'Cost (US dollars)',
  costHint: "Blank: your provider's spend cap.",
  autonomy: 'Autonomy',
  noReviewer:
    'No reviewer model is chosen yet. Choose one in {link} before saving an autonomous agent.',
  codeSettings: 'Settings, Code',
});

/** The longest a piece of work may run, in minutes (7 days, the Hub's limit). */
const MAX_MINUTES = 7 * 24 * 60;

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
  if (!/^\d+$/.test(d.minutes.trim()) || m < 1 || m > MAX_MINUTES)
    errors.minutes = FIELDS_TEXT.minutesError({ min: 1, max: MAX_MINUTES, days: 7 });
  const t = Number(d.tokens);
  if (!/^\d+$/.test(d.tokens.trim()) || t < 1_000 || t > 100_000_000)
    errors.tokens = FIELDS_TEXT.tokensError({ min: 1_000, max: 100_000_000 });
  const c = d.cost.trim() ? Number(d.cost) : null;
  if (c !== null && (!Number.isFinite(c) || c < 0 || c > 100_000))
    errors.cost = FIELDS_TEXT.costError({ min: 0, max: 100_000 });
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
      <legend>{FIELDS_TEXT.budgets}</legend>
      <p className="nv-field-hint ws-flush">{FIELDS_TEXT.budgetsHint}</p>
      <div className="agent-budget-fields">
        <TextField
          label={FIELDS_TEXT.minutes}
          inputMode="numeric"
          className="ws-number"
          value={value.minutes}
          error={errors.minutes}
          onChange={(e) => onChange({ ...value, minutes: e.target.value })}
        />
        <TextField
          label={FIELDS_TEXT.tokens}
          inputMode="numeric"
          className="ws-number"
          value={value.tokens}
          error={errors.tokens}
          onChange={(e) => onChange({ ...value, tokens: e.target.value })}
        />
        <TextField
          label={FIELDS_TEXT.cost}
          inputMode="decimal"
          className="ws-number"
          value={value.cost}
          hint={FIELDS_TEXT.costHint}
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
        legend={FIELDS_TEXT.autonomy}
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
          {rich(FIELDS_TEXT.noReviewer, {
            link: (
              <a href="/settings/code" onClick={(e) => followLink(e, '/settings/code')}>
                {FIELDS_TEXT.codeSettings}
              </a>
            ),
          })}
        </p>
      ) : null}
    </div>
  );
}
