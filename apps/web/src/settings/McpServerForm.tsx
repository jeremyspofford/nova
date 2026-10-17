// Add or edit an MCP server (FR-042, docs/08 §2.1, §2.3). Used by Settings → Tools & MCP and the
// onboarding tool step. Secret values (stdio environment variables, HTTP header values) go to the
// Hub's vault and are never shown again: after a save the form knows only their names.
//
// Headers ride in `env` because the request schema has no headers field: a header name is stored
// with its hyphens as underscores (`X-Api-Key` → `X_Api_Key`) and the Hub sends env key K of an
// sse/http server as header K with underscores turned back into hyphens.
//
// On edit, `env` is sent only when the set changed, and then it is the complete set of names: an
// empty value keeps the saved secret, a value replaces it, and a name left out is deleted.
import { useId, useState } from 'react';
import type { McpServerRequest, McpServerView, McpTransport } from '@nova/shared';
import { Button, Icon, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import '../workspace.css';

const NAME_RE = /^[a-z0-9-]{1,40}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const MASK = '••••••••';

export const headerToEnv = (name: string): string => name.replaceAll('-', '_');
export const envToHeader = (key: string): string => key.replaceAll('_', '-');

export interface SecretRow {
  id: number;
  name: string;
  value: string;
  /** A name whose value is already in the vault. */
  saved: boolean;
}

export interface McpFormState {
  name: string;
  transport: McpTransport;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  rows: SecretRow[];
  defaultApproval: '' | 'allow' | 'ask' | 'deny';
  /** Seconds, as typed; empty keeps the Hub default. */
  toolTimeout: string;
  startupTimeout: string;
}

export type McpFormErrors = Partial<
  Record<'name' | 'command' | 'url' | 'toolTimeout' | 'startupTimeout', string>
> & { rows?: Record<number, { name?: string; value?: string }> };

let rowSeq = 0;
const newRow = (over: Partial<SecretRow> = {}): SecretRow => ({
  id: ++rowSeq,
  name: '',
  value: '',
  saved: false,
  ...over,
});

export function formFromServer(s: McpServerView | null): McpFormState {
  const stdio = !s || s.transport === 'stdio';
  return {
    name: s?.name ?? '',
    transport: s?.transport ?? 'stdio',
    command: s?.command ?? '',
    args: (s?.args ?? []).join('\n'),
    url: s?.url ?? '',
    rows: (s?.envKeys ?? []).map((k) => newRow({ name: stdio ? k : envToHeader(k), saved: true })),
    defaultApproval: s?.defaultApproval ?? '',
    toolTimeout: s ? String(Math.round(s.toolTimeoutMs / 1000)) : '',
    startupTimeout: s ? String(Math.round(s.startupTimeoutMs / 1000)) : '',
  };
}

function seconds(text: string, max: number): { ms?: number; error?: string } {
  if (!text.trim()) return {};
  const n = Number(text);
  if (!/^\d+$/.test(text.trim()) || n < 1 || n > max)
    return { error: `Enter a whole number of seconds from 1 to ${max}.` };
  return { ms: n * 1000 };
}

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Turn the form into a create body (no `existing`) or a PATCH with only what changed. Returns
 * field errors instead when something is invalid; nothing is sent then.
 */
export function mcpRequestFromForm(
  f: McpFormState,
  existing: McpServerView | null,
): { body: Partial<McpServerRequest> } | { errors: McpFormErrors } {
  const errors: McpFormErrors = {};
  const stdio = f.transport === 'stdio';
  if (!NAME_RE.test(f.name)) errors.name = 'Use 1 to 40 lowercase letters, digits or hyphens.';
  if (stdio && !f.command.trim()) errors.command = 'Enter the command that starts the server.';
  if (!stdio && !isHttpUrl(f.url.trim())) errors.url = 'Enter an http:// or https:// address.';
  const tool = seconds(f.toolTimeout, 600);
  const startup = seconds(f.startupTimeout, 120);
  if (tool.error) errors.toolTimeout = tool.error;
  if (startup.error) errors.startupTimeout = startup.error;

  const rowErrors: NonNullable<McpFormErrors['rows']> = {};
  const seen = new Set<string>();
  const env: Record<string, string> = {};
  for (const r of f.rows) {
    const name = r.name.trim();
    if (!name && !r.value) continue; // an untouched blank row
    const key = stdio ? name : headerToEnv(name);
    const valid = stdio ? ENV_RE.test(name) : HEADER_RE.test(name);
    if (!valid)
      rowErrors[r.id] = {
        name: stdio
          ? 'Use letters, digits and underscores, not starting with a digit.'
          : 'Use letters, digits and hyphens, starting with a letter.',
      };
    else if (seen.has(key)) rowErrors[r.id] = { name: `${name} is listed twice.` };
    else if (!r.saved && !r.value) rowErrors[r.id] = { value: `Enter a value for ${name}.` };
    seen.add(key);
    env[key] = r.value;
  }
  if (Object.keys(rowErrors).length) errors.rows = rowErrors;
  if (Object.keys(errors).length) return { errors };

  const args = f.args
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean);
  const approval = f.defaultApproval || null;

  if (!existing) {
    const body: Partial<McpServerRequest> = { name: f.name, transport: f.transport };
    if (stdio) {
      body.command = f.command.trim();
      if (args.length) body.args = args;
    } else body.url = f.url.trim();
    if (Object.keys(env).length) body.env = env;
    if (approval) body.defaultApproval = approval;
    if (tool.ms) body.toolTimeoutMs = tool.ms;
    if (startup.ms) body.startupTimeoutMs = startup.ms;
    return { body };
  }

  const body: Partial<McpServerRequest> = {};
  if (f.name !== existing.name) body.name = f.name;
  if (f.transport !== existing.transport) body.transport = f.transport;
  if (stdio) {
    if (f.command.trim() !== (existing.command ?? '') || body.transport)
      body.command = f.command.trim();
    if (args.join('\n') !== existing.args.join('\n')) body.args = args;
  } else if (f.url.trim() !== (existing.url ?? '') || body.transport) body.url = f.url.trim();
  const keys = Object.keys(env);
  const envChanged =
    keys.length !== existing.envKeys.length ||
    keys.some((k) => !existing.envKeys.includes(k)) ||
    Object.values(env).some((v) => v !== '');
  if (envChanged) body.env = env;
  if (approval !== existing.defaultApproval) body.defaultApproval = approval;
  if (tool.ms && tool.ms !== existing.toolTimeoutMs) body.toolTimeoutMs = tool.ms;
  if (startup.ms && startup.ms !== existing.startupTimeoutMs) body.startupTimeoutMs = startup.ms;
  return { body };
}

export function McpServerForm({
  server,
  onSaved,
  onCancel,
  submitLabel,
}: {
  /** The server to edit; omitted to add one. */
  server?: McpServerView;
  onSaved: (s: McpServerView) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const { api } = useServices();
  const id = `mcp${useId()}`;
  const [form, setForm] = useState<McpFormState>(() => formFromServer(server ?? null));
  const [errors, setErrors] = useState<McpFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stdio = form.transport === 'stdio';
  const set = (patch: Partial<McpFormState>) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (rid: number, patch: Partial<SecretRow>) =>
    set({ rows: form.rows.map((r) => (r.id === rid ? { ...r, ...patch } : r)) });

  const submit = async () => {
    if (busy) return;
    const out = mcpRequestFromForm(form, server ?? null);
    if ('errors' in out) {
      setErrors(out.errors);
      setFailure(null);
      return;
    }
    setErrors({});
    setFailure(null);
    if (server && Object.keys(out.body).length === 0) {
      onSaved(server);
      return;
    }
    setBusy(true);
    try {
      const saved = server
        ? await api.updateMcpServer(server.id, out.body)
        : await api.createMcpServer(out.body as McpServerRequest);
      // The typed values are in the vault now; drop them from memory.
      setForm(formFromServer(saved));
      onSaved(saved);
    } catch (err) {
      setFailure(errorMessage(err, 'Could not save the server.'));
    } finally {
      setBusy(false);
    }
  };

  const kind = stdio ? 'Variable' : 'Header';
  return (
    <form
      className="stack"
      aria-label={server ? `Edit ${server.name}` : 'Add an MCP server'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Name"
        value={form.name}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        hint="Lowercase letters, digits and hyphens. Tools from this server are named after it."
        error={errors.name}
        onChange={(e) => set({ name: e.target.value })}
      />
      <RadioGroup
        legend="Connection"
        name={`${id}-transport`}
        value={form.transport}
        onChange={(v) => set({ transport: v as McpTransport })}
        options={[
          {
            value: 'stdio',
            label: 'Run a command on the Hub',
            description: 'Nova starts the server as a program and talks to it directly.',
          },
          {
            value: 'http',
            label: 'Streamable HTTP',
            description: 'A server reachable at a web address.',
          },
          {
            value: 'sse',
            label: 'Server-sent events',
            description: 'For older servers that use SSE.',
          },
        ]}
      />
      {stdio ? (
        <>
          <TextField
            label="Command"
            value={form.command}
            spellCheck={false}
            autoComplete="off"
            hint="The program to start, for example npx or a full path. It runs without a shell."
            error={errors.command}
            onChange={(e) => set({ command: e.target.value })}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-args`}>
              Arguments
            </label>
            <textarea
              id={`${id}-args`}
              className="nv-input ws-textarea"
              rows={3}
              spellCheck={false}
              aria-describedby={`${id}-args-hint`}
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
            />
            <span id={`${id}-args-hint`} className="nv-field-hint">
              One per line.
            </span>
          </div>
        </>
      ) : (
        <TextField
          label="Server URL"
          type="url"
          value={form.url}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://"
          error={errors.url}
          onChange={(e) => set({ url: e.target.value })}
        />
      )}
      <fieldset className="ws-fieldset">
        <legend>{stdio ? 'Environment variables' : 'Headers'}</legend>
        <p className="nv-field-hint ws-flush">
          Values are kept in the Hub&apos;s secret store and are never shown again.
        </p>
        {form.rows.map((r, i) => {
          const re = errors.rows?.[r.id];
          return (
            <div key={r.id} className="ws-target ws-secret-row">
              <TextField
                label={`${kind} ${i + 1}`}
                value={r.name}
                readOnly={r.saved}
                spellCheck={false}
                autoComplete="off"
                placeholder={stdio ? 'API_KEY' : 'Authorization'}
                error={re?.name}
                onChange={(e) => setRow(r.id, { name: e.target.value })}
              />
              <TextField
                label={`Value ${i + 1}`}
                type="password"
                autoComplete="new-password"
                value={r.value}
                placeholder={r.saved ? MASK : ''}
                hint={r.saved ? 'Saved. Type a new value to replace it.' : undefined}
                error={re?.value}
                onChange={(e) => setRow(r.id, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                aria-label={`Remove ${r.name.trim() || `${kind.toLowerCase()} ${i + 1}`}`}
                onClick={() => set({ rows: form.rows.filter((x) => x.id !== r.id) })}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <div className="row">
          <Button onClick={() => set({ rows: [...form.rows, newRow()] })}>
            <Icon name="plus" /> {stdio ? 'Add variable' : 'Add header'}
          </Button>
        </div>
      </fieldset>
      <details className="ws-advanced">
        <summary>Advanced</summary>
        <div className="stack">
          <SelectField
            label="Default for this server's tools"
            value={form.defaultApproval}
            onChange={(v) => set({ defaultApproval: v as McpFormState['defaultApproval'] })}
            hint="Built-in safety still applies; a per-tool default overrides this."
            options={[
              { value: '', label: 'Default (ask)' },
              { value: 'ask', label: 'Ask' },
              { value: 'allow', label: 'Allow' },
              { value: 'deny', label: 'Deny' },
            ]}
          />
          <TextField
            label="Tool timeout (seconds)"
            className="ws-number"
            inputMode="numeric"
            value={form.toolTimeout}
            placeholder="60"
            error={errors.toolTimeout}
            onChange={(e) => set({ toolTimeout: e.target.value })}
          />
          <TextField
            label="Startup timeout (seconds)"
            className="ws-number"
            inputMode="numeric"
            value={form.startupTimeout}
            placeholder="30"
            error={errors.startupTimeout}
            onChange={(e) => set({ startupTimeout: e.target.value })}
          />
        </div>
      </details>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {submitLabel ?? (server ? 'Save changes' : 'Add server')}
        </Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
