// The agent's responsibilities (FR-079; docs/09 §8): each tracked on its own with a status (active,
// paused, done), the user's instructions and the agent's last progress note (the agent's words:
// shown as text). Add, edit, reorder, change status and delete. The one that holds the agent's goal
// says so and links to it.
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentResponsibilityView } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { focusMoved } from '../settings/common.ts';
import { useAgentsApi } from './api.ts';

const STATUS_TEXT: Record<AgentResponsibilityView['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
};

export function AgentResponsibilities({
  agentId,
  goalId,
  version,
  onOpenGoal,
}: {
  agentId: string;
  /** The agent's open goal, to mark the responsibility that holds it. */
  goalId: string | null;
  version: number;
  onOpenGoal: () => void;
}) {
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const [items, setItems] = useState<AgentResponsibilityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentResponsibilityView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listResponsibilities(agentId).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) =>
        alive && setError(errorMessage(err, 'Could not load the responsibilities.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  const replace = (r: AgentResponsibilityView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === r.id ? r : x)));
  const fail = (what: string) => (err: unknown) =>
    toast.show(`${what}: ${errorMessage(err)}`, { tone: 'error' });

  const setStatus = (r: AgentResponsibilityView, status: AgentResponsibilityView['status']) => {
    api.updateResponsibility(agentId, r.id, { status }).then(replace, fail('Could not change it'));
  };

  const move = async (i: number, delta: -1 | 1) => {
    const list = items ?? [];
    const a = list[i];
    const b = list[i + delta];
    if (!a || !b) return;
    // Swap the two positions; the list is ordered by position.
    const next = [...list];
    next[i] = { ...b, position: a.position };
    next[i + delta] = { ...a, position: b.position };
    setItems(next);
    focusMoved(listRef.current, a.id, delta < 0 ? 'up' : 'down');
    try {
      await api.updateResponsibility(agentId, a.id, { position: b.position });
      await api.updateResponsibility(agentId, b.id, { position: a.position });
    } catch (err) {
      fail('Could not reorder')(err);
      setManual((v) => v + 1);
    }
  };

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>Responsibilities</h2>
        {editing === 'new' ? null : (
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" /> Add a responsibility
          </Button>
        )}
      </div>
      {editing === 'new' ? (
        <ResponsibilityForm
          initial={null}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const r = await api.addResponsibility(agentId, body);
            setItems((list) => [...(list ?? []), r]);
            setEditing(null);
            toast.show('Responsibility added.', { tone: 'success' });
          }}
        />
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <Spinner label="Loading the responsibilities" />
      ) : items.length === 0 ? (
        <p className="muted">
          No responsibilities. Add one so the agent knows what to keep working on, for example
          “Answer support questions in #help”.
        </p>
      ) : (
        <ol ref={listRef} className="ws-list" aria-label="Responsibilities">
          {items.map((r, i) =>
            editing === r.id ? (
              <li key={r.id} className="ws-list-row" data-move-key={r.id}>
                <ResponsibilityForm
                  initial={r}
                  onCancel={() => setEditing(null)}
                  onSave={async (body) => {
                    replace(
                      await api.updateResponsibility(agentId, r.id, {
                        title: body.title,
                        instructions: body.instructions ?? null,
                      }),
                    );
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li
                key={r.id}
                className="ws-list-row agent-resp"
                data-move-key={r.id}
                aria-label={r.title}
              >
                <div className="work-row-main">
                  <span className="ws-card-link">{r.title}</span>
                  {r.instructions ? <span className="agent-text">{r.instructions}</span> : null}
                  {r.progressNote ? (
                    <span className="muted agent-text">
                      <span className="nv-vh">The agent&apos;s </span>Last progress:{' '}
                      <span data-untrusted="true">{r.progressNote}</span>
                    </span>
                  ) : null}
                  {r.goalId && r.goalId === goalId ? (
                    <Button variant="ghost" className="agent-inline-link" onClick={onOpenGoal}>
                      <Icon name="forward" /> Holds the agent&apos;s goal
                    </Button>
                  ) : null}
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <SelectField
                    label={`Status of ${r.title}`}
                    hideLabel
                    value={r.status}
                    onChange={(v) => setStatus(r, v as AgentResponsibilityView['status'])}
                    options={(['active', 'paused', 'done'] as const).map((s) => ({
                      value: s,
                      label: STATUS_TEXT[s],
                    }))}
                  />
                  <Button
                    data-move="up"
                    aria-label={`Move ${r.title} up`}
                    disabled={i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    data-move="down"
                    aria-label={`Move ${r.title} down`}
                    disabled={i === items.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    Down
                  </Button>
                  <Button aria-label={`Edit ${r.title}`} onClick={() => setEditing(r.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Delete ${r.title}`}
                    onClick={() => setDeleting(r)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      <Dialog
        open={deleting !== null}
        title="Delete this responsibility?"
        description={
          deleting
            ? `The agent stops working on “${deleting.title}”. Its notes and past work stay.`
            : undefined
        }
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const r = deleting;
                setDeleting(null);
                if (!r) return;
                api.deleteResponsibility(agentId, r.id).then(() => {
                  setItems((list) => (list ?? []).filter((x) => x.id !== r.id));
                  toast.show('Responsibility deleted.', { tone: 'success' });
                }, fail('Could not delete it'));
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}

function ResponsibilityForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: AgentResponsibilityView | null;
  onSave: (body: { title: string; instructions?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave({
        title: title.trim(),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
    } catch (err) {
      setFailure(errorMessage(err, 'Could not save the responsibility.'));
      setBusy(false);
    }
  };
  return (
    <form
      className="stack agent-inline-form"
      aria-label={initial ? `Edit ${initial.title}` : 'New responsibility'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Responsibility"
        value={title}
        maxLength={200}
        autoComplete="off"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextField
        label="Details (optional)"
        value={instructions}
        maxLength={4000}
        autoComplete="off"
        onChange={(e) => setInstructions(e.target.value)}
      />
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          {busy ? <Spinner /> : null} {initial ? 'Save' : 'Add'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
