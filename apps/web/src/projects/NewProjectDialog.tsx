// New project (FR-034, FR-205, docs/04 §2.7): a name, optional instructions, and the memory
// choice. The memory choice is fixed once the project exists, so the dialog says so up front.
import { useId, useRef, useState } from 'react';
import type { ProjectView } from '@nova/shared';
import { Button, Dialog, RadioGroup, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { projectsChanged } from './events.ts';

export const MEMORY_SCOPE_TEXT: Record<
  ProjectView['memoryScope'],
  { label: string; description: string }
> = {
  shared: {
    label: 'Shared with my memory',
    description: 'Chats here use your saved memories, and what they learn is saved there too.',
  },
  project_only: {
    label: 'Project only',
    description: 'Chats here only use memories from this project, and what they learn stays in it.',
  },
};

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: ProjectView) => void;
}) {
  return open ? <NewProjectForm onClose={onClose} onCreated={onCreated} /> : null;
}

function NewProjectForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: ProjectView) => void;
}) {
  const { api } = useServices();
  const formId = `np${useId()}`;
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [memoryScope, setMemoryScope] = useState<ProjectView['memoryScope']>('shared');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({
        name: name.trim(),
        memoryScope,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      projectsChanged();
      onCreated(p);
    } catch (err) {
      setError(errorMessage(err, 'Could not create the project.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New project"
      description="A project groups chats, sources and instructions."
      onClose={onClose}
      initialFocusRef={nameRef}
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={nameRef}
          label="Name"
          value={name}
          maxLength={200}
          required
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-instr`}>
            Instructions (optional)
          </label>
          <textarea
            id={`${formId}-instr`}
            className="nv-input ws-textarea"
            rows={4}
            maxLength={20_000}
            value={instructions}
            aria-describedby={`${formId}-instr-hint`}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <span id={`${formId}-instr-hint`} className="nv-field-hint">
            Applied to every chat in the project, for example its goal, audience or style.
          </span>
        </div>
        <RadioGroup
          legend="Memory"
          name={`${formId}-memory`}
          value={memoryScope}
          onChange={(v) => setMemoryScope(v as ProjectView['memoryScope'])}
          hint="You cannot change this after the project is created."
          options={(['shared', 'project_only'] as const).map((s) => ({
            value: s,
            label: MEMORY_SCOPE_TEXT[s].label,
            description: MEMORY_SCOPE_TEXT[s].description,
          }))}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        {/* In the form, so Enter in a field submits it. */}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null} Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
