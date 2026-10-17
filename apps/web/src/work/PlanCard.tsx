// The plan card (FR-051, docs/09 §3, docs/04 §2.3): the run's steps with their status (icon and
// text). An `ask_first` run waits in planning until the user approves: Edit plan, then Approve and
// start; a run proposed in a chat (FR-186) can be started here too. Plans can also be amended
// while the run works.
import { useId, useState } from 'react';
import type { RunView } from '@nova/shared';
import { Button, Icon, IconButton, Spinner } from '@nova/ui';
import { STEP_ICON, STEP_TEXT, stepLine } from './format.ts';

export interface PlanDraftStep {
  key: number;
  title: string;
  detail: string;
}

let keySeq = 0;

export function PlanCard({
  run,
  onSave,
  onApprove,
}: {
  run: RunView;
  /** Resolves true when the Hub accepted the plan. */
  onSave: (steps: { title: string; detail?: string }[]) => Promise<boolean>;
  onApprove: () => void;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState<PlanDraftStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = run.plan;
  // An ask_first run waits for its plan to be approved; a run a chat proposed (FR-186) waits for
  // the user to accept it, with or without a plan.
  const proposed = run.origin === 'chat_escalation';
  const waiting =
    run.status === 'planning' && !run.planApproved && (run.autonomy === 'ask_first' || proposed);
  const awaitingApproval = waiting && (!!plan || proposed);
  const editable =
    run.status === 'planning' ||
    run.status === 'running' ||
    run.status === 'paused' ||
    run.status === 'waiting_approval';
  const progress = stepLine(plan);

  const startEdit = () =>
    setDraft((plan ?? []).map((s) => ({ key: ++keySeq, title: s.title, detail: s.detail ?? '' })));

  const save = async () => {
    if (!draft || busy) return;
    const steps = draft
      .map((s) => ({ title: s.title.trim(), detail: s.detail.trim() }))
      .filter((s) => s.title)
      .map((s) => (s.detail ? s : { title: s.title }));
    if (steps.length === 0) return;
    setBusy(true);
    const ok = await onSave(steps);
    setBusy(false);
    if (ok) setDraft(null);
  };

  return (
    <section className="panel-inset work-plan" aria-labelledby={headingId}>
      <div className="work-goal-head">
        <h2 id={headingId}>Plan</h2>
        {progress ? <span className="muted">{progress}</span> : null}
      </div>
      {draft ? (
        <PlanEditor
          steps={draft}
          busy={busy}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : plan === null ? (
        run.status === 'planning' && !awaitingApproval ? (
          <p className="muted ws-flush">
            <Spinner label="Writing the plan" /> Writing the plan…
          </p>
        ) : (
          <p className="muted ws-flush">
            {run.autonomy === 'autonomous'
              ? 'Autonomous runs skip the plan and work step by step.'
              : awaitingApproval
                ? 'The run writes its plan when it starts.'
                : 'No plan yet.'}
          </p>
        )
      ) : (
        <ol className="work-steps" aria-label="Plan steps">
          {plan.map((s) => {
            const icon = STEP_ICON[s.status];
            return (
              <li key={s.idx} className="work-step" data-status={s.status}>
                <span className="work-step-status">
                  {icon ? <Icon name={icon} /> : <Spinner />}
                  {STEP_TEXT[s.status]}
                </span>
                <span className="work-step-title">{s.title}</span>
                {s.detail ? <span className="muted work-step-detail">{s.detail}</span> : null}
              </li>
            );
          })}
        </ol>
      )}
      {awaitingApproval && !draft ? (
        <p className="ws-flush" role="note">
          <Icon name="hand" />{' '}
          {plan
            ? 'Review the plan, then start the run.'
            : 'This run was proposed in a chat. It starts when you accept it.'}
        </p>
      ) : null}
      {!draft && (editable || awaitingApproval) ? (
        <div className="ws-toolbar">
          {editable && plan ? <Button onClick={startEdit}>Edit plan</Button> : null}
          {awaitingApproval ? (
            <Button variant="primary" onClick={onApprove}>
              {plan ? 'Approve and start' : 'Start run'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PlanEditor({
  steps,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  steps: PlanDraftStep[];
  busy: boolean;
  onChange: (steps: PlanDraftStep[]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const base = useId();
  const set = (key: number, patch: Partial<PlanDraftStep>) =>
    onChange(steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const valid = steps.some((s) => s.title.trim());
  return (
    <form
      className="stack"
      aria-label="Edit plan"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <ol className="work-plan-edit">
        {steps.map((s, i) => (
          <li key={s.key} className="work-plan-edit-row">
            <label className="nv-vh" htmlFor={`${base}-${s.key}`}>
              Step {i + 1}
            </label>
            <input
              id={`${base}-${s.key}`}
              className="nv-input"
              value={s.title}
              maxLength={500}
              autoFocus={i === steps.length - 1 && !s.title}
              onChange={(e) => set(s.key, { title: e.target.value })}
            />
            <IconButton
              label={`Remove step ${i + 1}`}
              icon={<Icon name="trash" />}
              variant="ghost"
              disabled={steps.length === 1}
              onClick={() => onChange(steps.filter((x) => x.key !== s.key))}
            />
          </li>
        ))}
      </ol>
      <div className="ws-toolbar">
        <Button
          disabled={steps.length >= 50}
          onClick={() => onChange([...steps, { key: ++keySeq, title: '', detail: '' }])}
        >
          <Icon name="plus" /> Add step
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? <Spinner /> : null} Save plan
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
