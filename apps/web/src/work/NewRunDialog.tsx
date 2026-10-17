// New run (FR-051, FR-181, FR-182, FR-187, FR-220; docs/04 §2.3): describe the outcome, pick the
// autonomy and budgets (defaults from Settings → General → Work runs), and optionally a project, a
// goal, a declared output and the Deep research template. Starting navigates to the run.
import { useId, useRef, useState } from 'react';
import type { ProjectView, RunAutonomy, RunView } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { AUTONOMY_TEXT } from './format.ts';

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
    return { error: `Enter the time in whole minutes, from 1 to ${MAX_MINUTES}.` };
  const tokens = Number(d.tokens);
  if (!/^\d+$/.test(d.tokens.trim()) || tokens < 1_000 || tokens > 100_000_000)
    return { error: 'Enter a token budget from 1,000 to 100,000,000.' };
  const costText = d.cost.trim();
  const cost = costText ? Number(costText) : null;
  if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 100_000))
    return { error: 'Enter a cost limit from 0 to 100,000 US dollars, or leave it blank.' };
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

  const submit = async () => {
    if (!objective.trim() || busy || 'error' in parsed) return;
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
      setError(errorMessage(err, 'Could not start the run.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New run"
      description="Describe the outcome you want. The run plans the steps, works through them and reports a result."
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
            What should the run do?
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
            {objective.length.toLocaleString('en-US')} / {OBJECTIVE_MAX.toLocaleString('en-US')}{' '}
            characters
          </span>
        </div>
        <TextField
          label="Title (optional)"
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <RadioGroup
          legend="Template"
          name={`${formId}-template`}
          value={template || 'none'}
          onChange={(v) => setTemplate(v === 'deep_research' ? 'deep_research' : '')}
          options={[
            { value: 'none', label: 'Standard run' },
            {
              value: 'deep_research',
              label: 'Deep research',
              description:
                'Plans sub-questions, gathers sources with read-only research sub-agents and writes a cited report.',
            },
          ]}
        />
        <SelectField
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: 'No project' },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <RadioGroup
          legend="Autonomy"
          name={`${formId}-autonomy`}
          value={autonomy}
          onChange={(v) => setAutonomy(v as RunAutonomy)}
          options={(['ask_first', 'standard', 'autonomous'] as const).map((a) => ({
            value: a,
            label: AUTONOMY_TEXT[a].label,
            description: AUTONOMY_TEXT[a].description,
          }))}
        />
        <fieldset className="ws-fieldset">
          <legend>Budgets</legend>
          <p className="muted ws-flush">
            The run pauses when it reaches a budget and asks before going further.
          </p>
          <div className="work-budget-fields">
            <TextField
              label="Time (minutes)"
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
              label="Tokens"
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1000}
              step={1000}
              value={budget.tokens}
              onChange={(e) => setBudget((b) => ({ ...b, tokens: e.target.value }))}
            />
            <TextField
              label="Cost limit (US dollars)"
              type="number"
              inputMode="decimal"
              className="ws-number"
              min={0}
              step={0.01}
              hint="Blank uses the provider spend cap."
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
          <summary>Goal and expected output (optional)</summary>
          <div className="stack">
            <div className="nv-field">
              <label className="nv-field-label" htmlFor={`${formId}-goal`}>
                Goal
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
                The run keeps working toward the goal until it is complete or a budget is reached.{' '}
                {goal.length.toLocaleString('en-US')} / {GOAL_MAX.toLocaleString('en-US')}{' '}
                characters
              </span>
            </div>
            <SelectField
              label="Expected output"
              value={output}
              onChange={(v) => setOutput(v as typeof output)}
              hint="The run succeeds only when this output is verified."
              options={[
                { value: '', label: 'None' },
                { value: 'artifact', label: 'An artifact' },
                { value: 'message', label: 'A delivered message' },
                { value: 'file', label: 'A file' },
              ]}
            />
            {output ? (
              <TextField
                label="Output name or path (optional)"
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
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !objective.trim() || budgetError !== null}
          >
            {busy ? <Spinner /> : null} Start run
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
