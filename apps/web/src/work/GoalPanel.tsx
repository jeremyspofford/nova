// The run's goal (FR-181, docs/09 §2.1, docs/04 §2.3.1): the objective (editable, at most 4,000
// characters with a counter), the status (icon and text, with the blocker), the last progress
// note, and the actions the runtime allows: Pause, Resume, Edit, Extend budget, Mark complete and
// Clear. Edits apply at the start of the next turn. Without a goal the panel offers to set one.
import { useId, useState } from 'react';
import type { GoalView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { GOAL_STATUS_ICON, GOAL_STATUS_TEXT } from './format.ts';

const GOAL_MAX = 4000;

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
        <span className="nv-vh">Goal status:</span> {GOAL_STATUS_TEXT[goal.status]}
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

  if (loading)
    return (
      <section className="panel-inset work-goal" aria-labelledby={headingId}>
        <h2 id={headingId}>Goal</h2>
        <Spinner label="Loading the goal" />
      </section>
    );

  if (!goal)
    return (
      <section className="panel-inset work-goal" aria-labelledby={headingId}>
        <h2 id={headingId}>Goal</h2>
        {editing ? (
          <GoalEditor
            initial=""
            saveLabel="Set goal"
            onCancel={() => setEditing(false)}
            onSave={async (text) => {
              if (await actions.set(text)) setEditing(false);
            }}
          />
        ) : (
          <>
            <p className="muted ws-flush">
              No goal. A goal keeps the run working toward an outcome, turn after turn, until it is
              complete or a budget is reached.
            </p>
            {finished ? null : (
              <div className="ws-toolbar">
                <Button onClick={() => setEditing(true)}>Set a goal</Button>
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
        <h2 id={headingId}>Goal</h2>
        <GoalBadge goal={goal} />
      </div>
      {editing ? (
        <GoalEditor
          initial={goal.objective}
          saveLabel="Save goal"
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            if (await actions.edit(text)) setEditing(false);
          }}
        />
      ) : (
        <p className="work-goal-objective">{goal.objective}</p>
      )}
      {s === 'blocked' && goal.blocker ? (
        <p className="ws-callout" role="note">
          <Icon name="stop" />
          <span>
            Blocked: {goal.blocker.description ?? goal.blocker.key} (reported{' '}
            {goal.blocker.count === 1 ? 'once' : `${goal.blocker.count} times`})
          </span>
        </p>
      ) : null}
      {s === 'usage_limited' ? (
        <p className="muted ws-flush">Continues when the provider usage limit resets.</p>
      ) : null}
      {goal.statusReason && s !== 'blocked' ? (
        <p className="muted ws-flush">{goal.statusReason}</p>
      ) : null}
      {goal.progressNote ? (
        <p className="ws-flush">
          <span className="muted">Last progress: </span>
          {goal.progressNote}
        </p>
      ) : null}
      {s === 'complete' && goal.completionSummary ? (
        <p className="ws-flush">
          <span className="muted">Completed: </span>
          {goal.completionSummary}
        </p>
      ) : null}
      {finished || editing ? null : (
        <div className="ws-toolbar" role="group" aria-label="Goal actions">
          {open ? <Button onClick={() => setEditing(true)}>Edit</Button> : null}
          {s === 'active' ? <Button onClick={() => actions.act('pause')}>Pause goal</Button> : null}
          {s === 'paused' || s === 'blocked' ? (
            <Button onClick={() => actions.act('resume')}>Resume goal</Button>
          ) : null}
          {s === 'complete' ? (
            <Button onClick={() => actions.act('resume')}>Reopen goal</Button>
          ) : null}
          {open ? <Button onClick={actions.extend}>Extend budget…</Button> : null}
          {open ? <Button onClick={() => actions.act('complete')}>Mark complete</Button> : null}
          <Button variant="ghost" onClick={() => setConfirmClear(true)}>
            Clear goal
          </Button>
        </div>
      )}
      <Dialog
        open={confirmClear}
        title="Clear the goal?"
        description="The run stops working toward this goal. The run itself keeps going."
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>Keep the goal</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                actions.clear();
              }}
            >
              Clear goal
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
          Goal objective
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
          {text.length.toLocaleString('en-US')} / {GOAL_MAX.toLocaleString('en-US')} characters.
          Changes apply at the start of the next turn.
        </span>
      </div>
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} {saveLabel}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
