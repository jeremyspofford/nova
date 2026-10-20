// The agent's responsibilities (FR-079; docs/09 §8): each tracked on its own with a status (active,
// paused, done), the user's instructions and the agent's last progress note (the agent's words:
// shown as text). Add, edit, reorder, change status and delete. The one that holds the agent's goal
// says so and links to it.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentResponsibilityView } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { focusMoved } from '../settings/common.ts';
import { useAgentsApi } from './api.ts';
import { AGENTS_TEXT } from './format.ts';

export const RESP_TEXT = defineMessages('agents.responsibilities', {
  status: {
    active: 'Active',
    paused: 'Paused',
    done: 'Done',
  },
  loadFailed: 'Could not load the responsibilities.',
  changeFailed: 'Could not change it: {reason}',
  reorderFailed: 'Could not reorder: {reason}',
  heading: 'Responsibilities',
  add: 'Add a responsibility',
  added: 'Responsibility added.',
  loading: 'Loading the responsibilities',
  empty:
    'No responsibilities. Add one so the agent knows what to keep working on, for example ' +
    '“Answer support questions in #help”.',
  list: 'Responsibilities',
  /** The label before the agent's last progress note, as shown. */
  progress: 'Last progress:',
  /** The same label as screen readers hear it: the note is the agent's words. */
  progressSpoken: "The agent's last progress:",
  holdsGoal: "Holds the agent's goal",
  statusOf: 'Status of {title}',
  moveUp: 'Move {title} up',
  moveDown: 'Move {title} down',
  up: 'Up',
  down: 'Down',
  editOf: 'Edit {title}',
  deleteOf: 'Delete {title}',
  deleteTitle: 'Delete this responsibility?',
  deleteBody: 'The agent stops working on “{title}”. Its notes and past work stay.',
  deleted: 'Responsibility deleted.',
  deleteFailed: 'Could not delete it: {reason}',
  saveFailed: 'Could not save the responsibility.',
  newForm: 'New responsibility',
  field: 'Responsibility',
  details: 'Details (optional)',
});

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
      (err: unknown) => alive && setError(errorMessage(err, RESP_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  const replace = (r: AgentResponsibilityView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === r.id ? r : x)));
  const fail = (failed: (p: { reason: string }) => string) => (err: unknown) =>
    toast.show(failed({ reason: errorMessage(err) }), { tone: 'error' });

  const setStatus = (r: AgentResponsibilityView, status: AgentResponsibilityView['status']) => {
    api.updateResponsibility(agentId, r.id, { status }).then(replace, fail(RESP_TEXT.changeFailed));
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
      fail(RESP_TEXT.reorderFailed)(err);
      setManual((v) => v + 1);
    }
  };

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{RESP_TEXT.heading}</h2>
        {editing === 'new' ? null : (
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" /> {RESP_TEXT.add}
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
            toast.show(RESP_TEXT.added, { tone: 'success' });
          }}
        />
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <Spinner label={RESP_TEXT.loading} />
      ) : items.length === 0 ? (
        <p className="muted">{RESP_TEXT.empty}</p>
      ) : (
        <ol ref={listRef} className="ws-list" aria-label={RESP_TEXT.list}>
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
                  <span className="ws-card-link" dir="auto">
                    {r.title}
                  </span>
                  {r.instructions ? (
                    <span className="agent-text" dir="auto">
                      {r.instructions}
                    </span>
                  ) : null}
                  {r.progressNote ? (
                    <span className="muted agent-text">
                      <span className="nv-vh">{RESP_TEXT.progressSpoken}</span>
                      <span aria-hidden="true">{RESP_TEXT.progress}</span>{' '}
                      <span data-untrusted="true" dir="auto">
                        {r.progressNote}
                      </span>
                    </span>
                  ) : null}
                  {r.goalId && r.goalId === goalId ? (
                    <Button variant="ghost" className="agent-inline-link" onClick={onOpenGoal}>
                      <Icon name="forward" /> {RESP_TEXT.holdsGoal}
                    </Button>
                  ) : null}
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <SelectField
                    label={RESP_TEXT.statusOf({ title: r.title })}
                    hideLabel
                    value={r.status}
                    onChange={(v) => setStatus(r, v as AgentResponsibilityView['status'])}
                    options={(['active', 'paused', 'done'] as const).map((s) => ({
                      value: s,
                      label: RESP_TEXT.status[s],
                    }))}
                  />
                  <Button
                    data-move="up"
                    aria-label={RESP_TEXT.moveUp({ title: r.title })}
                    disabled={i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    {RESP_TEXT.up}
                  </Button>
                  <Button
                    data-move="down"
                    aria-label={RESP_TEXT.moveDown({ title: r.title })}
                    disabled={i === items.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    {RESP_TEXT.down}
                  </Button>
                  <Button
                    aria-label={RESP_TEXT.editOf({ title: r.title })}
                    onClick={() => setEditing(r.id)}
                  >
                    {AGENTS_TEXT.edit}
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={RESP_TEXT.deleteOf({ title: r.title })}
                    onClick={() => setDeleting(r)}
                  >
                    {AGENTS_TEXT.delete}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      <Dialog
        open={deleting !== null}
        title={RESP_TEXT.deleteTitle}
        description={deleting ? RESP_TEXT.deleteBody({ title: deleting.title }) : undefined}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{AGENTS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const r = deleting;
                setDeleting(null);
                if (!r) return;
                api.deleteResponsibility(agentId, r.id).then(() => {
                  setItems((list) => (list ?? []).filter((x) => x.id !== r.id));
                  toast.show(RESP_TEXT.deleted, { tone: 'success' });
                }, fail(RESP_TEXT.deleteFailed));
              }}
            >
              {AGENTS_TEXT.delete}
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
      setFailure(errorMessage(err, RESP_TEXT.saveFailed));
      setBusy(false);
    }
  };
  return (
    <form
      className="stack agent-inline-form"
      aria-label={initial ? RESP_TEXT.editOf({ title: initial.title }) : RESP_TEXT.newForm}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={RESP_TEXT.field}
        value={title}
        maxLength={200}
        autoComplete="off"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextField
        label={RESP_TEXT.details}
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
          {busy ? <Spinner /> : null} {initial ? AGENTS_TEXT.save : AGENTS_TEXT.add}
        </Button>
        <Button onClick={onCancel}>{AGENTS_TEXT.cancel}</Button>
      </div>
    </form>
  );
}
