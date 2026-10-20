// The run's goal (FR-181, docs/09 §2.1, docs/04 §2.3.1): the objective (editable, at most 4,000
// characters with a counter), the status (icon and text, with the blocker), the last progress
// note, and the actions the runtime allows: Pause, Resume, Edit, Extend budget, Mark complete and
// Clear. Edits apply at the start of the next turn. Without a goal the panel offers to set one.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { GoalView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { GOAL_STATUS_ICON, GOAL_STATUS_TEXT, WORK_TEXT } from './format.ts';

const GOAL_MAX = 4000;

/** A run's goal panel. */
export const GOAL_TEXT = defineMessages('work.goal', {
  heading: 'Goal',
  /** Read before the status by screen readers. */
  status: 'Goal status:',
  loading: 'Loading the goal',
  set: 'Set goal',
  none: 'No goal. A goal keeps the run working toward an outcome, turn after turn, until it is complete or a budget is reached.',
  setOne: 'Set a goal',
  save: 'Save goal',
  /** {what} is the blocker as the run reported it. */
  blocked:
    '{n, plural, one {Blocked: {what} (reported once)} other {Blocked: {what} (reported # times)}}',
  usageLimited: 'Continues when the provider usage limit resets.',
  lastProgress: 'Last progress:',
  completed: 'Completed:',
  actions: 'Goal actions',
  pause: 'Pause goal',
  resume: 'Resume goal',
  reopen: 'Reopen goal',
  extend: 'Extend budget…',
  complete: 'Mark complete',
  clear: 'Clear goal',
  clearTitle: 'Clear the goal?',
  clearBody: 'The run stops working toward this goal. The run itself keeps going.',
  keep: 'Keep the goal',
  objective: 'Goal objective',
  /** Under the objective: "29 / 4,000 characters. Changes apply…". */
  hint: '{n} / {max, plural, one {# character} other {# characters}}. Changes apply at the start of the next turn.',
});

export interface GoalActions {
  set: (objective: string) => Promise<boolean>;
  edit: (objective: string) => Promise<boolean>;
  act: (action: 'pause' | 'resume' | 'complete') => void;
  clear: () => void;
  extend: () => void;
}

export function GoalBadge({ goal }: { goal: Pick<GoalView, 'status'> }) {
  return (
    <span className="work-badge" data-goal={goal.status}>
      <Icon name={GOAL_STATUS_ICON[goal.status]} />
      <span>
        <span className="nv-vh">{GOAL_TEXT.status}</span> {GOAL_STATUS_TEXT[goal.status]}
      </span>
    </span>
  );
}

export function GoalPanel({
  goal,
  loading,
  finished,
  actions,
}: {
  /** Null when the run has no goal. */
  goal: GoalView | null;
  loading: boolean;
  /** The run ended: the goal can be read but no longer changed. */
  finished: boolean;
  actions: GoalActions;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const S = GOAL_TEXT;

  if (loading)
    return (
      <section className="panel-inset work-goal" aria-labelledby={headingId}>
        <h2 id={headingId}>{S.heading}</h2>
        <Spinner label={S.loading} />
      </section>
    );

  if (!goal)
    return (
      <section className="panel-inset work-goal" aria-labelledby={headingId}>
        <h2 id={headingId}>{S.heading}</h2>
        {editing ? (
          <GoalEditor
            initial=""
            saveLabel={S.set}
            onCancel={() => setEditing(false)}
            onSave={async (text) => {
              if (await actions.set(text)) setEditing(false);
            }}
          />
        ) : (
          <>
            <p className="muted ws-flush">{S.none}</p>
            {finished ? null : (
              <div className="ws-toolbar">
                <Button onClick={() => setEditing(true)}>{S.setOne}</Button>
              </div>
            )}
          </>
        )}
      </section>
    );

  const s = goal.status;
  const open = !finished && s !== 'complete';
  return (
    <section className="panel-inset work-goal" aria-labelledby={headingId} data-goal={s}>
      <div className="work-goal-head">
        <h2 id={headingId}>{S.heading}</h2>
        <GoalBadge goal={goal} />
      </div>
      {editing ? (
        <GoalEditor
          initial={goal.objective}
          saveLabel={S.save}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            if (await actions.edit(text)) setEditing(false);
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
            {S.blocked({
              n: goal.blocker.count,
              what: goal.blocker.description ?? goal.blocker.key,
            })}
          </span>
        </p>
      ) : null}
      {s === 'usage_limited' ? <p className="muted ws-flush">{S.usageLimited}</p> : null}
      {goal.statusReason && s !== 'blocked' ? (
        <p className="muted ws-flush">{goal.statusReason}</p>
      ) : null}
      {goal.progressNote ? (
        <p className="ws-flush">
          <span className="muted">{S.lastProgress} </span>
          <span dir="auto">{goal.progressNote}</span>
        </p>
      ) : null}
      {s === 'complete' && goal.completionSummary ? (
        <p className="ws-flush">
          <span className="muted">{S.completed} </span>
          <span dir="auto">{goal.completionSummary}</span>
        </p>
      ) : null}
      {finished || editing ? null : (
        <div className="ws-toolbar" role="group" aria-label={S.actions}>
          {open ? <Button onClick={() => setEditing(true)}>{WORK_TEXT.edit}</Button> : null}
          {s === 'active' ? <Button onClick={() => actions.act('pause')}>{S.pause}</Button> : null}
          {s === 'paused' || s === 'blocked' ? (
            <Button onClick={() => actions.act('resume')}>{S.resume}</Button>
          ) : null}
          {s === 'complete' ? (
            <Button onClick={() => actions.act('resume')}>{S.reopen}</Button>
          ) : null}
          {open ? <Button onClick={actions.extend}>{S.extend}</Button> : null}
          {open ? <Button onClick={() => actions.act('complete')}>{S.complete}</Button> : null}
          <Button variant="ghost" onClick={() => setConfirmClear(true)}>
            {S.clear}
          </Button>
        </div>
      )}
      <Dialog
        open={confirmClear}
        title={S.clearTitle}
        description={S.clearBody}
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>{S.keep}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                actions.clear();
              }}
            >
              {S.clear}
            </Button>
          </>
        }
      />
    </section>
  );
}

function GoalEditor({
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: string;
  saveLabel: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `goal${useId()}`;
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSave(text.trim());
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
          {GOAL_TEXT.hint({ n: text.length, max: GOAL_MAX })}
        </span>
      </div>
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} {saveLabel}
        </Button>
        <Button onClick={onCancel}>{WORK_TEXT.cancel}</Button>
      </div>
    </form>
  );
}
