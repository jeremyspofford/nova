// Add or edit an external agent adapter (FR-203): the program that speaks the Agent Client Protocol
// (a name or full path, never a shell line, with its arguments one per line), its environment
// variables (values are secrets: they go to the vault and are never shown again; editing keeps a
// saved value unless a new one is typed), and the hosts its process may reach (its model service,
// through the egress allowlist). An adapter must send every permission request to Nova; one that
// decides on its own is refused, and the form says so instead of offering it.
import { useId, useRef, useState } from 'react';
import {
  createAgentAdapterSchema,
  type AgentAdapterView,
  type CreateAgentAdapterRequest,
  type UpdateAgentAdapterRequest,
} from '@nova/shared';
import { Button, Dialog, Icon, IconButton, Spinner, TextField } from '@nova/ui';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useFlaggedApi } from './api.ts';
import { flaggedErrorMessage } from './format.ts';

interface EnvRow {
  key: number;
  name: string;
  value: string;
  /** A saved variable: its value stays in the vault unless replaced. */
  saved: boolean;
}

interface Draft {
  name: string;
  command: string;
  args: string;
  env: EnvRow[];
  network: string;
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

const FIELD_TEXT: Record<string, string> = {
  name: 'Enter a name, up to 64 characters.',
  command: 'Enter a program name or a full path, without spaces or shell syntax.',
  args: 'Up to 50 arguments, each up to 1,000 characters.',
  env: 'Name variables with letters, digits and _, not starting with a digit.',
  network: 'Enter host names such as api.example.com or *.example.com (up to 20).',
};

/** The create body, or the field errors the Hub would answer with. */
export function buildAdapter(
  d: Draft,
): { body: CreateAgentAdapterRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const r of d.env) {
    const name = r.name.trim();
    if (!name && !r.value) continue;
    if (!name) errors.env = 'Name every variable that has a value.';
    else if (name in env) errors.env = `${name} is listed twice.`;
    else if (!r.value) errors.env = `Enter a value for ${name}.`;
    else env[name] = r.value;
  }
  const body: CreateAgentAdapterRequest = {
    name: d.name.trim(),
    command: d.command.trim(),
    args: lines(d.args),
    env,
    network: lines(d.network),
    permissionRouting: 'client',
  };
  const parsed = createAgentAdapterSchema.safeParse(body);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'name');
      errors[key] ??= FIELD_TEXT[key] ?? issue.message;
    }
  return Object.keys(errors).length ? { errors } : { body };
}

/** The changes to send for an edit: `env` names keep their saved value when left empty. */
export function buildAdapterUpdate(
  before: AgentAdapterView,
  d: Draft,
): { body: UpdateAgentAdapterRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const r of d.env) {
    const name = r.name.trim();
    if (!name && !r.value) continue;
    if (!name) errors.env = 'Name every variable that has a value.';
    else if (name in env) errors.env = `${name} is listed twice.`;
    else if (!r.value && !r.saved) errors.env = `Enter a value for ${name}.`;
    else env[name] = r.value;
  }
  if (!d.name.trim()) errors.name = FIELD_TEXT.name!;
  if (Object.keys(errors).length) return { errors };
  const args = lines(d.args);
  const network = lines(d.network);
  const envChanged =
    JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(Object.keys(before.env).sort()) ||
    Object.values(env).some(Boolean);
  return {
    body: {
      ...(d.name.trim() !== before.name ? { name: d.name.trim() } : {}),
      ...(JSON.stringify(args) !== JSON.stringify(before.args) ? { args } : {}),
      ...(envChanged ? { env } : {}),
      ...(JSON.stringify(network) !== JSON.stringify(before.network) ? { network } : {}),
    },
  };
}

let rowKey = 0;
const row = (name = '', saved = false): EnvRow => ({ key: ++rowKey, name, value: '', saved });

export function AdapterDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: AgentAdapterView | null;
  onClose: () => void;
  onSaved: (a: AgentAdapterView, created: boolean) => void;
}) {
  if (!open) return null;
  return <AdapterForm editing={editing} onClose={onClose} onSaved={onSaved} />;
}

function AdapterForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: AgentAdapterView | null;
  onClose: () => void;
  onSaved: (a: AgentAdapterView, created: boolean) => void;
}) {
  const api = useFlaggedApi();
  const id = `ad${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const [d, setD] = useState<Draft>(() =>
    editing
      ? {
          name: editing.name,
          command: editing.command,
          args: editing.args.join('\n'),
          env: Object.keys(editing.env).map((n) => row(n, true)),
          network: editing.network.join('\n'),
        }
      : { name: '', command: '', args: '', env: [], network: '' },
  );
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const built = editing ? buildAdapterUpdate(editing, d) : buildAdapter(d);
  const errors = tried && 'errors' in built ? built.errors : {};
  const setRow = (key: number, patch: Partial<EnvRow>) =>
    setD((x) => ({ ...x, env: x.env.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  const submit = async () => {
    setTried(true);
    if ('errors' in built || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) onSaved(await api.updateAgentAdapter(editing.id, built.body), false);
      else onSaved(await api.createAgentAdapter(built.body as CreateAgentAdapterRequest), true);
    } catch (err) {
      setError(flaggedErrorMessage(err, 'agents', 'Could not save the adapter.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? `Edit ${editing.name}` : 'Add an agent adapter'}
      description="An external coding agent that speaks the Agent Client Protocol. It runs in the session’s sandbox, never on the Hub itself."
      onClose={onClose}
      initialFocusRef={first}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={first}
          label="Name"
          value={d.name}
          maxLength={64}
          autoComplete="off"
          error={errors.name}
          onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))}
        />
        <TextField
          label="Program"
          value={d.command}
          autoComplete="off"
          spellCheck={false}
          placeholder="my-agent-acp"
          disabled={!!editing}
          hint={
            editing
              ? 'To run another program, add a new adapter.'
              : 'A program name or a full path. Arguments go below.'
          }
          error={errors.command}
          onChange={(e) => setD((x) => ({ ...x, command: e.target.value }))}
        />
        <TextArea
          id={`${id}-args`}
          label="Arguments (optional)"
          value={d.args}
          rows={2}
          placeholder="--acp"
          hint="One per line. They are passed as they are, never through a shell."
          error={errors.args}
          onChange={(v) => setD((x) => ({ ...x, args: v }))}
        />
        <fieldset className="ws-fieldset">
          <legend>Environment variables (optional)</legend>
          <p className="nv-field-hint">
            For example the agent’s API key. Values are kept in the vault and never shown again.
          </p>
          {d.env.map((r, i) => (
            <div key={r.key} className="fl-env-row">
              <TextField
                label={`Variable ${i + 1} name`}
                value={r.name}
                autoComplete="off"
                spellCheck={false}
                disabled={r.saved}
                onChange={(e) => setRow(r.key, { name: e.target.value })}
              />
              <TextField
                label={r.saved ? `Replace the value of ${r.name}` : `Variable ${i + 1} value`}
                type="password"
                autoComplete="off"
                value={r.value}
                hint={r.saved ? 'Set. Leave empty to keep it.' : undefined}
                onChange={(e) => setRow(r.key, { value: e.target.value })}
              />
              <IconButton
                label={`Remove variable ${r.name || i + 1}`}
                icon={<Icon name="trash" />}
                variant="ghost"
                onClick={() => setD((x) => ({ ...x, env: x.env.filter((y) => y.key !== r.key) }))}
              />
            </div>
          ))}
          {errors.env ? (
            <p className="nv-field-error" role="alert">
              {errors.env}
            </p>
          ) : null}
          <div>
            <Button variant="ghost" onClick={() => setD((x) => ({ ...x, env: [...x.env, row()] }))}>
              <Icon name="plus" /> Add a variable
            </Button>
          </div>
        </fieldset>
        <TextArea
          id={`${id}-net`}
          label="Hosts it may reach (optional)"
          value={d.network}
          rows={2}
          placeholder="api.example.com"
          hint="One per line, such as its model service. Without any, the agent has no network."
          error={errors.network}
          onChange={(v) => setD((x) => ({ ...x, network: v }))}
        />
        <p className="ws-callout" role="note">
          <Icon name="shield" />
          <span>
            Nova decides every permission request the agent makes, under your rules. An adapter
            whose agent decides on its own cannot be added.
          </span>
        </p>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Add adapter'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
