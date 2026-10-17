// The agent's memory (FR-089; docs/09 §5, §8): durable notes and what it learned in conversation,
// each visible, editable, pinnable and forgettable. Memory can be turned off; doing so purges what
// the agent derived (its own notes and its conversation memory), so the switch asks first. What
// the agent wrote is its words, not the user's: shown as text and marked so. Items from a shared
// channel thread say so, since they may reach other people only through a policy check (FR-088).
import { useEffect, useId, useState } from 'react';
import {
  AGENT_MEMORY_KINDS,
  type AgentMemoryItemView,
  type AgentMemoryKind,
  type AgentView,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { formatWhen } from '../settings/common.ts';
import { useAgentsApi } from './api.ts';
import { MEMORY_KIND_TEXT, MEMORY_SOURCE_TEXT } from './format.ts';

/** What turning memory off removes (FR-089). */
export const MEMORY_PURGE_NOTICE =
  'Turning memory off deletes the notes this agent wrote and everything it learned in ' +
  'conversation. Notes you wrote stay. This cannot be undone.';

export function AgentMemory({
  agent,
  version,
  onAgent,
}: {
  agent: AgentView;
  version: number;
  onAgent: (a: AgentView) => void;
}) {
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  const [items, setItems] = useState<AgentMemoryItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [confirmOff, setConfirmOff] = useState(false);
  const [forgetting, setForgetting] = useState<AgentMemoryItemView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listAgentMemory(agent.id).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the memory.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agent.id, version, manual]);

  const fail = (what: string) => (err: unknown) =>
    toast.show(`${what}: ${errorMessage(err)}`, { tone: 'error' });
  const replace = (m: AgentMemoryItemView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === m.id ? m : x)));

  const setMemory = async (on: boolean) => {
    setBusy(true);
    try {
      onAgent(await api.updateAgent(agent.id, { memoryEnabled: on }));
      toast.show(on ? 'Memory is on.' : 'Memory is off. What the agent derived was deleted.', {
        tone: 'success',
      });
      setManual((n) => n + 1);
    } catch (err) {
      fail('Could not change memory')(err);
    } finally {
      setBusy(false);
    }
  };

  const notes = items?.filter((m) => m.store === 'notes') ?? [];
  const learned = items?.filter((m) => m.store === 'conversation') ?? [];

  const row = (m: AgentMemoryItemView) =>
    editing === m.id ? (
      <li key={m.id} className="ws-list-row">
        <MemoryEditor
          initial={m.content}
          label={`Edit ${MEMORY_KIND_TEXT[m.kind].toLowerCase()}`}
          onCancel={() => setEditing(null)}
          onSave={async (content) => {
            replace(await api.updateAgentMemory(agent.id, m.id, { content }));
            setEditing(null);
          }}
        />
      </li>
    ) : (
      <li key={m.id} className="ws-list-row agent-memory-item" data-author={m.author}>
        <div className="work-row-main">
          <span className="agent-text" data-untrusted={m.author === 'agent' || undefined}>
            {m.content}
          </span>
          <span className="muted ws-row-meta">
            <span className="ws-badge">{MEMORY_KIND_TEXT[m.kind]}</span>
            <span>
              {m.author === 'agent' ? 'Written by the agent' : MEMORY_SOURCE_TEXT[m.source]}
            </span>
            {m.originAudience === 'shared' ? (
              <span className="ws-badge" data-tone="warn">
                <Icon name="at" /> From a shared channel
              </span>
            ) : null}
            {m.pinned ? (
              <span className="ws-badge">
                <Icon name="pin" /> Pinned
              </span>
            ) : null}
            <span>Updated {formatWhen(m.updatedAt)}</span>
          </span>
        </div>
        <div className="ws-row-actions ws-toolbar">
          <Button
            aria-pressed={m.pinned}
            aria-label={`${m.pinned ? 'Unpin' : 'Pin'}: ${m.content.slice(0, 60)}`}
            onClick={() => {
              api
                .updateAgentMemory(agent.id, m.id, { pinned: !m.pinned })
                .then(replace, fail('Could not change it'));
            }}
          >
            {m.pinned ? 'Unpin' : 'Pin'}
          </Button>
          <Button aria-label={`Edit: ${m.content.slice(0, 60)}`} onClick={() => setEditing(m.id)}>
            Edit
          </Button>
          <Button
            variant="danger"
            aria-label={`Forget: ${m.content.slice(0, 60)}`}
            onClick={() => setForgetting(m)}
          >
            Forget
          </Button>
        </div>
      </li>
    );

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Memory</h2>
      <SwitchField
        label="Memory"
        description={
          agent.memoryEnabled
            ? "The agent keeps notes and what it learns in conversation, shared across all its threads. Its threads stay out of your chats' memory."
            : 'Memory is off: the agent writes no notes and learns nothing from conversation. Notes you add still reach it.'
        }
        checked={agent.memoryEnabled}
        disabled={busy}
        onChange={(on) => (on ? void setMemory(true) : setConfirmOff(true))}
      />
      <AddNote
        onAdd={async (content, kind, pinned) => {
          const m = await api.addAgentNote(agent.id, { content, kind, pinned });
          setItems((list) => [m, ...(list ?? [])]);
          toast.show('Note added.', { tone: 'success' });
        }}
      />
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <Spinner label="Loading the memory" />
      ) : (
        <>
          <h3 className="ws-subhead">Notes</h3>
          {notes.length ? (
            <ul className="ws-list" aria-label="Notes">
              {notes.map(row)}
            </ul>
          ) : (
            <p className="muted ws-flush">
              No notes yet. The agent writes findings and progress here; you can add your own.
            </p>
          )}
          <h3 className="ws-subhead">Learned in conversation</h3>
          {learned.length ? (
            <ul className="ws-list" aria-label="Learned in conversation">
              {learned.map(row)}
            </ul>
          ) : (
            <p className="muted ws-flush">
              Nothing yet. Facts and preferences you state to the agent show here.
            </p>
          )}
        </>
      )}
      <Dialog
        open={confirmOff}
        title="Turn memory off?"
        description={MEMORY_PURGE_NOTICE}
        onClose={() => setConfirmOff(false)}
        footer={
          <>
            <Button onClick={() => setConfirmOff(false)}>Keep memory on</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmOff(false);
                void setMemory(false);
              }}
            >
              Turn off and delete
            </Button>
          </>
        }
      />
      <Dialog
        open={forgetting !== null}
        title="Forget this?"
        description="The agent will no longer know it. This cannot be undone."
        onClose={() => setForgetting(null)}
        footer={
          <>
            <Button onClick={() => setForgetting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const m = forgetting;
                setForgetting(null);
                if (!m) return;
                api.deleteAgentMemory(agent.id, m.id).then(() => {
                  setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
                  toast.show('Forgotten.', { tone: 'success' });
                }, fail('Could not forget it'));
              }}
            >
              Forget
            </Button>
          </>
        }
      >
        {forgetting ? <p className="agent-text ws-flush">{forgetting.content}</p> : null}
      </Dialog>
    </section>
  );
}

function AddNote({
  onAdd,
}: {
  onAdd: (content: string, kind: AgentMemoryKind, pinned: boolean) => Promise<void>;
}) {
  const id = `an${useId()}`;
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<AgentMemoryKind>('note');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!open)
    return (
      <div className="ws-toolbar">
        <Button onClick={() => setOpen(true)}>
          <Icon name="plus" /> Add a note
        </Button>
      </div>
    );
  const submit = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onAdd(content.trim(), kind, pinned);
      setContent('');
      setPinned(false);
      setOpen(false);
    } catch (err) {
      setFailure(errorMessage(err, 'Could not add the note.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="stack agent-inline-form"
      aria-label="New note"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`${id}-text`}>
          Note
        </label>
        <textarea
          id={`${id}-text`}
          className="nv-input ws-textarea"
          rows={3}
          maxLength={8000}
          autoFocus
          value={content}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setContent(e.target.value)}
        />
        <span id={`${id}-hint`} className="nv-field-hint">
          Your words: the agent treats them as yours.
        </span>
      </div>
      <SelectField
        label="Kind"
        value={kind}
        onChange={(v) => setKind(v as AgentMemoryKind)}
        options={AGENT_MEMORY_KINDS.map((k) => ({ value: k, label: MEMORY_KIND_TEXT[k] }))}
      />
      <label className="ws-check">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        Pin it, so the agent reads it first
      </label>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !content.trim()}>
          {busy ? <Spinner /> : null} Add note
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function MemoryEditor({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `me${useId()}`;
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(text.trim());
    } catch (err) {
      setFailure(errorMessage(err, 'Could not save it.'));
      setBusy(false);
    }
  };
  return (
    <form
      className="stack agent-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          className="nv-input ws-textarea"
          rows={3}
          maxLength={8000}
          autoFocus
          value={text}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
        />
        <span id={`${id}-hint`} className="nv-field-hint">
          Once you edit it, it counts as your words.
        </span>
      </div>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
