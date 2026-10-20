// New run (FR-051, FR-181, FR-182, FR-187, FR-220; docs/04 §2.3): describe the outcome, pick the
// autonomy and budgets (defaults from Settings → General → Work runs), and optionally a project, a
// goal, a declared output and the Deep research template. Starting navigates to the run.
import { useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ProjectView, RunAutonomy, RunView } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { AUTONOMY_TEXT, OUTPUT_KIND_TEXT, WORK_TEXT } from './format.ts';

/** The New run dialog. */
export const NEW_RUN_TEXT = defineMessages('work.newRun', {
  minutes: 'Enter the time in whole minutes, from {min} to {max}.',
  tokens: 'Enter a token budget from {min} to {max}.',
  cost: 'Enter a cost limit from {min} to {max} US dollars, or leave it blank.',
  startFailed: 'Could not start the run.',
  title: 'New run',
  description:
    'Describe the outcome you want. The run plans the steps, works through them and reports a result.',
  objective: 'What should the run do?',
  template: 'Template',
  standard: 'Standard run',
  deepResearch: 'Deep research',
  deepResearchHint:
    'Plans sub-questions, gathers sources with read-only research sub-agents and writes a cited report.',
  autonomy: 'Autonomy',
  /** After the autonomous level's description when no reviewer model is chosen. */
  needsReviewer: 'Needs a reviewer model (Settings → Code).',
  chooseReviewer:
    'Choose a reviewer model in Settings → Code first, or pick another autonomy level.',
  budgets: 'Budgets',
  budgetsHint: 'The run pauses when it reaches a budget and asks before going further.',
  time: 'Time (minutes)',
  tokensLabel: 'Tokens',
  costLabel: 'Cost limit (US dollars)',
  costHint: 'Blank uses the provider spend cap.',
  more: 'Goal and expected output (optional)',
  goal: 'Goal',
  /** {n} characters typed of at most {max}. */
  goalHint:
    'The run keeps working toward the goal until it is complete or a budget is reached. {n} / {max, plural, one {# character} other {# characters}}',
  outputHint: 'The run succeeds only when this output is verified.',
  start: 'Start run',
});

const OBJECTIVE_MAX = 8000;
const GOAL_MAX = 4000;
const MAX_MINUTES = 7 * 24 * 60;

type CreateRunBody = Parameters<Api['createRun']>[0];

export interface BudgetDraft {
  minutes: string;
  tokens: string;
  /** Blank means the provider spend cap (FR-116). */
  cost: string;
}

/** Budgets from the form, or the first problem with them. */
export function parseBudgets(
  d: BudgetDraft,
): { budgets: NonNullable<CreateRunBody['budgets']> } | { error: string } {
  const min = Number(d.minutes);
  if (!/^\d+$/.test(d.minutes.trim()) || min < 1 || min > MAX_MINUTES)
    return { error: NEW_RUN_TEXT.minutes({ min: 1, max: MAX_MINUTES }) };
  const tokens = Number(d.tokens);
  if (!/^\d+$/.test(d.tokens.trim()) || tokens < 1_000 || tokens > 100_000_000)
    return { error: NEW_RUN_TEXT.tokens({ min: 1_000, max: 100_000_000 }) };
  const costText = d.cost.trim();
  const cost = costText ? Number(costText) : null;
  if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 100_000))
    return { error: NEW_RUN_TEXT.cost({ min: 0, max: 100_000 }) };
  return { budgets: { timeSeconds: min * 60, tokens, costUsd: cost } };
}

export interface NewRunInitial {
  objective?: string;
  title?: string;
  projectId?: string | null;
}

export function NewRunDialog({
  open,
  projects,
  initial,
  onClose,
  onCreated,
}: {
  open: boolean;
  projects: ProjectView[];
  initial?: NewRunInitial;
  onClose: () => void;
  onCreated: (run: RunView) => void;
}) {
  return open ? (
    <NewRunForm projects={projects} initial={initial} onClose={onClose} onCreated={onCreated} />
  ) : null;
}

function NewRunForm({
  projects,
  initial,
  onClose,
  onCreated,
}: {
  projects: ProjectView[];
  initial?: NewRunInitial;
  onClose: () => void;
  onCreated: (run: RunView) => void;
}) {
  const { api } = useServices();
  const settings = useSettings();
  const defaults = settings.get('runs.defaultBudgets').value;
  const formId = `nr${useId()}`;
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const [objective, setObjective] = useState(initial?.objective ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [template, setTemplate] = useState<'' | 'deep_research'>('');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [autonomy, setAutonomy] = useState<RunAutonomy>(settings.get('runs.autonomy').value);
  const [budget, setBudget] = useState<BudgetDraft>({
    minutes: String(Math.round(defaults.timeSeconds / 60)),
    tokens: String(defaults.tokens),
    cost: defaults.costUsd === null ? '' : String(defaults.costUsd),
  });
  const [goal, setGoal] = useState('');
  const [output, setOutput] = useState<'' | 'artifact' | 'message' | 'file'>('');
  const [outputRef, setOutputRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseBudgets(budget);
  const budgetError = 'error' in parsed ? parsed.error : null;

  // Autonomous runs send consequential actions to the reviewer model (FR-085).
  const reviewer = settings.get('review.model').value;
  const needsReviewer = autonomy === 'autonomous' && !reviewer;
  const S = NEW_RUN_TEXT;
  const submit = async () => {
    if (!objective.trim() || busy || 'error' in parsed || needsReviewer) return;
    setBusy(true);
    setError(null);
    const body: CreateRunBody = {
      objective: objective.trim(),
      autonomy,
      budgets: parsed.budgets,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(projectId ? { projectId } : {}),
      ...(template ? { template } : {}),
      ...(goal.trim() ? { goal: { objective: goal.trim() } } : {}),
      ...(output
        ? {
            expectedOutput: {
              kind: output,
              ...(outputRef.trim() ? { ref: outputRef.trim() } : {}),
            },
          }
        : {}),
    };
    try {
      onCreated(await api.createRun(body));
    } catch (err) {
      setError(errorMessage(err, S.startFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title}
      description={S.description}
      onClose={onClose}
      initialFocusRef={objectiveRef}
      className="ws-wide-dialog"
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-objective`}>
            {S.objective}
          </label>
          <textarea
            ref={objectiveRef}
            id={`${formId}-objective`}
            className="nv-input ws-textarea"
            rows={4}
            required
            maxLength={OBJECTIVE_MAX}
            value={objective}
            aria-describedby={`${formId}-objective-count`}
            onChange={(e) => setObjective(e.target.value)}
          />
          <span id={`${formId}-objective-count`} className="nv-field-hint">
            {WORK_TEXT.characters({ n: objective.length, max: OBJECTIVE_MAX })}
          </span>
        </div>
        <TextField
          label={WORK_TEXT.titleOptional}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <RadioGroup
          legend={S.template}
          name={`${formId}-template`}
          value={template || 'none'}
          onChange={(v) => setTemplate(v === 'deep_research' ? 'deep_research' : '')}
          options={[
            { value: 'none', label: S.standard },
            { value: 'deep_research', label: S.deepResearch, description: S.deepResearchHint },
          ]}
        />
        <SelectField
          label={WORK_TEXT.project}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: WORK_TEXT.noProject },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <RadioGroup
          legend={S.autonomy}
          name={`${formId}-autonomy`}
          value={autonomy}
          onChange={(v) => setAutonomy(v as RunAutonomy)}
          options={(['ask_first', 'standard', 'autonomous'] as const).map((a) => ({
            value: a,
            label: AUTONOMY_TEXT[a].label,
            description:
              a === 'autonomous' && !reviewer
                ? `${AUTONOMY_TEXT[a].description} ${S.needsReviewer}`
                : AUTONOMY_TEXT[a].description,
          }))}
        />
        {needsReviewer ? (
          <p className="nv-field-error" role="alert">
            {S.chooseReviewer}
          </p>
        ) : null}
        <fieldset className="ws-fieldset">
          <legend>{S.budgets}</legend>
          <p className="muted ws-flush">{S.budgetsHint}</p>
          <div className="work-budget-fields">
            <TextField
              label={S.time}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1}
              max={MAX_MINUTES}
              step={1}
              value={budget.minutes}
              onChange={(e) => setBudget((b) => ({ ...b, minutes: e.target.value }))}
            />
            <TextField
              label={S.tokensLabel}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1000}
              step={1000}
              value={budget.tokens}
              onChange={(e) => setBudget((b) => ({ ...b, tokens: e.target.value }))}
            />
            <TextField
              label={S.costLabel}
              type="number"
              inputMode="decimal"
              className="ws-number"
              min={0}
              step={0.01}
              hint={S.costHint}
              value={budget.cost}
              onChange={(e) => setBudget((b) => ({ ...b, cost: e.target.value }))}
            />
          </div>
          {budgetError ? (
            <p className="nv-field-error" role="alert">
              {budgetError}
            </p>
          ) : null}
        </fieldset>
        <details className="ws-advanced">
          <summary>{S.more}</summary>
          <div className="stack">
            <div className="nv-field">
              <label className="nv-field-label" htmlFor={`${formId}-goal`}>
                {S.goal}
              </label>
              <textarea
                id={`${formId}-goal`}
                className="nv-input ws-textarea"
                rows={3}
                maxLength={GOAL_MAX}
                value={goal}
                aria-describedby={`${formId}-goal-hint`}
                onChange={(e) => setGoal(e.target.value)}
              />
              <span id={`${formId}-goal-hint`} className="nv-field-hint">
                {S.goalHint({ n: goal.length, max: GOAL_MAX })}
              </span>
            </div>
            <SelectField
              label={WORK_TEXT.expectedOutput}
              value={output}
              onChange={(v) => setOutput(v as typeof output)}
              hint={S.outputHint}
              options={[
                { value: '', label: OUTPUT_KIND_TEXT.none },
                { value: 'artifact', label: OUTPUT_KIND_TEXT.artifact },
                { value: 'message', label: OUTPUT_KIND_TEXT.message },
                { value: 'file', label: OUTPUT_KIND_TEXT.file },
              ]}
            />
            {output ? (
              <TextField
                label={WORK_TEXT.outputRef}
                value={outputRef}
                maxLength={1000}
                onChange={(e) => setOutputRef(e.target.value)}
              />
            ) : null}
          </div>
        </details>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{WORK_TEXT.cancel}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !objective.trim() || budgetError !== null || needsReviewer}
          >
            {busy ? <Spinner /> : null} {S.start}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
