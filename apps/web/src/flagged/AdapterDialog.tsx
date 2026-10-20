// Add or edit an external agent adapter (FR-203): the program that speaks the Agent Client Protocol
// (a name or full path, never a shell line, with its arguments one per line), its environment
// variables (values are secrets: they go to the vault and are never shown again; editing keeps a
// saved value unless a new one is typed), and the hosts its process may reach (its model service,
// through the egress allowlist). An adapter must send every permission request to Nova; one that
// decides on its own is refused, and the form says so instead of offering it.
import { useId, useRef, useState } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import {
  createAgentAdapterSchema,
  type AgentAdapterView,
  type CreateAgentAdapterRequest,
  type UpdateAgentAdapterRequest,
} from '@nova/shared';
import { Button, Dialog, Icon, IconButton, Spinner, TextField } from '@nova/ui';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useFlaggedApi } from './api.ts';
import { FLAGGED_TEXT, flaggedErrorMessage } from './format.ts';

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

/** The adapter dialog's words. `{name}` is a variable's or an adapter's name (data). */
export const ADAPTER_TEXT = defineMessages('flagged.adapter', {
  /** What a field needs, by the field the Hub would name. */
  field: {
    name: 'Enter a name, up to 64 characters.',
    command: 'Enter a program name or a full path, without spaces or shell syntax.',
    args: 'Up to 50 arguments, each up to 1,000 characters.',
    env: 'Name variables with letters, digits and _, not starting with a digit.',
    network: 'Enter host names such as api.example.com or *.example.com (up to 20).',
  },
  unnamedVariable: 'Name every variable that has a value.',
  listedTwice: '{name} is listed twice.',
  needsValue: 'Enter a value for {name}.',
  saveFailed: 'Could not save the adapter.',
  editTitle: 'Edit {name}',
  addTitle: 'Add an agent adapter',
  description:
    'An external coding agent that speaks the Agent Client Protocol. It runs in the session’s ' +
    'sandbox, never on the Hub itself.',
  name: 'Name',
  program: 'Program',
  programHintEdit: 'To run another program, add a new adapter.',
  programHint: 'A program name or a full path. Arguments go below.',
  args: 'Arguments (optional)',
  argsHint: 'One per line. They are passed as they are, never through a shell.',
  env: 'Environment variables (optional)',
  envHint: 'For example the agent’s API key. Values are kept in the vault and never shown again.',
  /** A variable's fields, numbered from 1: "Variable 2 name". */
  variableName: 'Variable {n} name',
  variableValue: 'Variable {n} value',
  replaceValue: 'Replace the value of {name}',
  keepValue: 'Set. Leave empty to keep it.',
  /** `{name}` is the variable's name, or its number while it has none. */
  removeVariable: 'Remove variable {name}',
  addVariable: 'Add a variable',
  hosts: 'Hosts it may reach (optional)',
  hostsHint: 'One per line, such as its model service. Without any, the agent has no network.',
  routing:
    'Nova decides every permission request the agent makes, under your rules. An adapter ' +
    'whose agent decides on its own cannot be added.',
  save: 'Save',
  add: 'Add adapter',
});

/** The create body, or the field errors the Hub would answer with. */
export function buildAdapter(
  d: Draft,
): { body: CreateAgentAdapterRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const r of d.env) {
    const name = r.name.trim();
    if (!name && !r.value) continue;
    if (!name) errors.env = ADAPTER_TEXT.unnamedVariable;
    else if (name in env) errors.env = ADAPTER_TEXT.listedTwice({ name });
    else if (!r.value) errors.env = ADAPTER_TEXT.needsValue({ name });
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
      errors[key] ??= messageFor(ADAPTER_TEXT.field, key) ?? issue.message;
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
    if (!name) errors.env = ADAPTER_TEXT.unnamedVariable;
    else if (name in env) errors.env = ADAPTER_TEXT.listedTwice({ name });
    else if (!r.value && !r.saved) errors.env = ADAPTER_TEXT.needsValue({ name });
    else env[name] = r.value;
  }
  if (!d.name.trim()) errors.name = ADAPTER_TEXT.field.name;
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
      setError(flaggedErrorMessage(err, 'agents', ADAPTER_TEXT.saveFailed));
      setBusy(false);
    }
  };

  const S = ADAPTER_TEXT;
  return (
    <Dialog
      open
      title={editing ? S.editTitle({ name: editing.name }) : S.addTitle}
      description={S.description}
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
          label={S.name}
          value={d.name}
          maxLength={64}
          autoComplete="off"
          error={errors.name}
          onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))}
        />
        <TextField
          label={S.program}
          value={d.command}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- an example program name, not text
          placeholder="my-agent-acp"
          disabled={!!editing}
          hint={editing ? S.programHintEdit : S.programHint}
          error={errors.command}
          onChange={(e) => setD((x) => ({ ...x, command: e.target.value }))}
        />
        <TextArea
          id={`${id}-args`}
          label={S.args}
          value={d.args}
          rows={2}
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- an example argument, not text
          placeholder="--acp"
          hint={S.argsHint}
          error={errors.args}
          onChange={(v) => setD((x) => ({ ...x, args: v }))}
        />
        <fieldset className="ws-fieldset">
          <legend>{S.env}</legend>
          <p className="nv-field-hint">{S.envHint}</p>
          {d.env.map((r, i) => (
            <div key={r.key} className="fl-env-row">
              <TextField
                label={S.variableName({ n: i + 1 })}
                value={r.name}
                autoComplete="off"
                spellCheck={false}
                disabled={r.saved}
                onChange={(e) => setRow(r.key, { name: e.target.value })}
              />
              <TextField
                label={r.saved ? S.replaceValue({ name: r.name }) : S.variableValue({ n: i + 1 })}
                type="password"
                autoComplete="off"
                value={r.value}
                hint={r.saved ? S.keepValue : undefined}
                onChange={(e) => setRow(r.key, { value: e.target.value })}
              />
              <IconButton
                label={S.removeVariable({ name: r.name || i + 1 })}
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
              <Icon name="plus" /> {S.addVariable}
            </Button>
          </div>
        </fieldset>
        <TextArea
          id={`${id}-net`}
          label={S.hosts}
          value={d.network}
          rows={2}
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- an example host name, not text
          placeholder="api.example.com"
          hint={S.hostsHint}
          error={errors.network}
          onChange={(v) => setD((x) => ({ ...x, network: v }))}
        />
        <p className="ws-callout" role="note">
          <Icon name="shield" />
          <span>{S.routing}</span>
        </p>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{FLAGGED_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? S.save : S.add}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
