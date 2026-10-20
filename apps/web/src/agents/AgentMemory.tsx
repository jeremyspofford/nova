// The agent's memory (FR-089; docs/09 §5, §8): durable notes and what it learned in conversation,
// each visible, editable, pinnable and forgettable. Memory can be turned off; doing so purges what
// the agent derived (its own notes and its conversation memory), so the switch asks first. What
// the agent wrote is its words, not the user's: shown as text and marked so. Items from a shared
// channel thread say so, since they may reach other people only through a policy check (FR-088).
import { useEffect, useId, useState } from 'react';
import { declaredMessages, defineMessages } from '@nova/i18n';
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
import { AGENTS_TEXT, MEMORY_KIND_TEXT, MEMORY_SOURCE_TEXT } from './format.ts';

export const MEMORY_TEXT = defineMessages('agents.memory', {
  /** What turning memory off removes (FR-089). */
  purgeNotice:
    'Turning memory off deletes the notes this agent wrote and everything it learned in ' +
    'conversation. Notes you wrote stay. This cannot be undone.',
  loadFailed: 'Could not load the memory.',
  on: 'Memory is on.',
  off: 'Memory is off. What the agent derived was deleted.',
  changeFailed: 'Could not change memory: {reason}',
  editKind:
    '{kind, select, note {Edit note} fact {Edit fact} preference {Edit preference} observation {Edit observation} other {Edit}}',
  byAgent: 'Written by the agent',
  fromShared: 'From a shared channel',
  pinned: 'Pinned',
  updated: 'Updated {when}',
  pin: 'Pin',
  unpin: 'Unpin',
  pinOf: 'Pin: {text}',
  unpinOf: 'Unpin: {text}',
  pinFailed: 'Could not change it: {reason}',
  editOf: 'Edit: {text}',
  forget: 'Forget',
  forgetOf: 'Forget: {text}',
  heading: 'Memory',
  onHint:
    "The agent keeps notes and what it learns in conversation, shared across all its threads. Its threads stay out of your chats' memory.",
  offHint:
    'Memory is off: the agent writes no notes and learns nothing from conversation. Notes you ' +
    'add still reach it.',
  noteAdded: 'Note added.',
  loading: 'Loading the memory',
  notes: 'Notes',
  notesEmpty: 'No notes yet. The agent writes findings and progress here; you can add your own.',
  learned: 'Learned in conversation',
  learnedEmpty: 'Nothing yet. Facts and preferences you state to the agent show here.',
  offTitle: 'Turn memory off?',
  keepOn: 'Keep memory on',
  turnOff: 'Turn off and delete',
  forgetTitle: 'Forget this?',
  forgetBody: 'The agent will no longer know it. This cannot be undone.',
  forgotten: 'Forgotten.',
  forgetFailed: 'Could not forget it: {reason}',
  addNote: 'Add a note',
  addFailed: 'Could not add the note.',
  newNote: 'New note',
  note: 'Note',
  noteHint: 'Your words: the agent treats them as yours.',
  kind: 'Kind',
  pinIt: 'Pin it, so the agent reads it first',
  add: 'Add note',
  saveFailed: 'Could not save it.',
  editHint: 'Once you edit it, it counts as your words.',
});

/**
 * The purge notice in English, its source text (for tests and docs; the UI reads
 * MEMORY_TEXT.purgeNotice in the active locale).
 */
export const MEMORY_PURGE_NOTICE = declaredMessages().get('agents.memory.purgeNotice') ?? '';

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
      (err: unknown) => alive && setError(errorMessage(err, MEMORY_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agent.id, version, manual]);

  const fail = (failed: (p: { reason: string }) => string) => (err: unknown) =>
    toast.show(failed({ reason: errorMessage(err) }), { tone: 'error' });
  const replace = (m: AgentMemoryItemView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === m.id ? m : x)));

  const setMemory = async (on: boolean) => {
    setBusy(true);
    try {
      onAgent(await api.updateAgent(agent.id, { memoryEnabled: on }));
      toast.show(on ? MEMORY_TEXT.on : MEMORY_TEXT.off, { tone: 'success' });
      setManual((n) => n + 1);
    } catch (err) {
      fail(MEMORY_TEXT.changeFailed)(err);
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
          label={MEMORY_TEXT.editKind({ kind: m.kind })}
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
          <span
            className="agent-text"
            data-untrusted={m.author === 'agent' || undefined}
            dir="auto"
          >
            {m.content}
          </span>
          <span className="muted ws-row-meta">
            <span className="ws-badge">{MEMORY_KIND_TEXT[m.kind]}</span>
            <span>{m.author === 'agent' ? MEMORY_TEXT.byAgent : MEMORY_SOURCE_TEXT[m.source]}</span>
            {m.originAudience === 'shared' ? (
              <span className="ws-badge" data-tone="warn">
                <Icon name="at" /> {MEMORY_TEXT.fromShared}
              </span>
            ) : null}
            {m.pinned ? (
              <span className="ws-badge">
                <Icon name="pin" /> {MEMORY_TEXT.pinned}
              </span>
            ) : null}
            <span>{MEMORY_TEXT.updated({ when: formatWhen(m.updatedAt) })}</span>
          </span>
        </div>
        <div className="ws-row-actions ws-toolbar">
          <Button
            aria-pressed={m.pinned}
            aria-label={(m.pinned ? MEMORY_TEXT.unpinOf : MEMORY_TEXT.pinOf)({
              text: m.content.slice(0, 60),
            })}
            onClick={() => {
              api
                .updateAgentMemory(agent.id, m.id, { pinned: !m.pinned })
                .then(replace, fail(MEMORY_TEXT.pinFailed));
            }}
          >
            {m.pinned ? MEMORY_TEXT.unpin : MEMORY_TEXT.pin}
          </Button>
          <Button
            aria-label={MEMORY_TEXT.editOf({ text: m.content.slice(0, 60) })}
            onClick={() => setEditing(m.id)}
          >
            {AGENTS_TEXT.edit}
          </Button>
          <Button
            variant="danger"
            aria-label={MEMORY_TEXT.forgetOf({ text: m.content.slice(0, 60) })}
            onClick={() => setForgetting(m)}
          >
            {MEMORY_TEXT.forget}
          </Button>
        </div>
      </li>
    );

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{MEMORY_TEXT.heading}</h2>
      <SwitchField
        label={AGENTS_TEXT.memory}
        description={agent.memoryEnabled ? MEMORY_TEXT.onHint : MEMORY_TEXT.offHint}
        checked={agent.memoryEnabled}
        disabled={busy}
        onChange={(on) => (on ? void setMemory(true) : setConfirmOff(true))}
      />
      <AddNote
        onAdd={async (content, kind, pinned) => {
          const m = await api.addAgentNote(agent.id, { content, kind, pinned });
          setItems((list) => [m, ...(list ?? [])]);
          toast.show(MEMORY_TEXT.noteAdded, { tone: 'success' });
        }}
      />
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <Spinner label={MEMORY_TEXT.loading} />
      ) : (
        <>
          <h3 className="ws-subhead">{MEMORY_TEXT.notes}</h3>
          {notes.length ? (
            <ul className="ws-list" aria-label={MEMORY_TEXT.notes}>
              {notes.map(row)}
            </ul>
          ) : (
            <p className="muted ws-flush">{MEMORY_TEXT.notesEmpty}</p>
          )}
          <h3 className="ws-subhead">{MEMORY_TEXT.learned}</h3>
          {learned.length ? (
            <ul className="ws-list" aria-label={MEMORY_TEXT.learned}>
              {learned.map(row)}
            </ul>
          ) : (
            <p className="muted ws-flush">{MEMORY_TEXT.learnedEmpty}</p>
          )}
        </>
      )}
      <Dialog
        open={confirmOff}
        title={MEMORY_TEXT.offTitle}
        description={MEMORY_TEXT.purgeNotice}
        onClose={() => setConfirmOff(false)}
        footer={
          <>
            <Button onClick={() => setConfirmOff(false)}>{MEMORY_TEXT.keepOn}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmOff(false);
                void setMemory(false);
              }}
            >
              {MEMORY_TEXT.turnOff}
            </Button>
          </>
        }
      />
      <Dialog
        open={forgetting !== null}
        title={MEMORY_TEXT.forgetTitle}
        description={MEMORY_TEXT.forgetBody}
        onClose={() => setForgetting(null)}
        footer={
          <>
            <Button onClick={() => setForgetting(null)}>{AGENTS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const m = forgetting;
                setForgetting(null);
                if (!m) return;
                api.deleteAgentMemory(agent.id, m.id).then(() => {
                  setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
                  toast.show(MEMORY_TEXT.forgotten, { tone: 'success' });
                }, fail(MEMORY_TEXT.forgetFailed));
              }}
            >
              {MEMORY_TEXT.forget}
            </Button>
          </>
        }
      >
        {forgetting ? (
          <p className="agent-text ws-flush" dir="auto">
            {forgetting.content}
          </p>
        ) : null}
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
          <Icon name="plus" /> {MEMORY_TEXT.addNote}
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
      setFailure(errorMessage(err, MEMORY_TEXT.addFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="stack agent-inline-form"
      aria-label={MEMORY_TEXT.newNote}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`${id}-text`}>
          {MEMORY_TEXT.note}
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
          {MEMORY_TEXT.noteHint}
        </span>
      </div>
      <SelectField
        label={MEMORY_TEXT.kind}
        value={kind}
        onChange={(v) => setKind(v as AgentMemoryKind)}
        options={AGENT_MEMORY_KINDS.map((k) => ({ value: k, label: MEMORY_KIND_TEXT[k] }))}
      />
      <label className="ws-check">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        {MEMORY_TEXT.pinIt}
      </label>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !content.trim()}>
          {busy ? <Spinner /> : null} {MEMORY_TEXT.add}
        </Button>
        <Button onClick={() => setOpen(false)}>{AGENTS_TEXT.cancel}</Button>
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
      setFailure(errorMessage(err, MEMORY_TEXT.saveFailed));
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
          {MEMORY_TEXT.editHint}
        </span>
      </div>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : null} {AGENTS_TEXT.save}
        </Button>
        <Button onClick={onCancel}>{AGENTS_TEXT.cancel}</Button>
      </div>
    </form>
  );
}
