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
import { defineMessages } from '@nova/i18n';
import type { McpServerRequest, McpServerView, McpTransport } from '@nova/shared';
import { Button, Icon, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import '../workspace.css';

const NAME_RE = /^[a-z0-9-]{1,40}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const MASK = '••••••••';
// Examples of what goes in a field: protocol names and numbers, the same in every language.
const ENV_EXAMPLE = 'API_KEY';
const HEADER_EXAMPLE = 'Authorization';
const URL_EXAMPLE = 'https://';

export const MCP_FORM_TEXT = defineMessages('settings.mcpForm', {
  secondsRange: 'Enter a whole number of seconds from 1 to {max}.',
  nameRule: 'Use 1 to 40 lowercase letters, digits or hyphens.',
  needCommand: 'Enter the command that starts the server.',
  needUrl: 'Enter an http:// or https:// address.',
  envRule: 'Use letters, digits and underscores, not starting with a digit.',
  headerRule: 'Use letters, digits and hyphens, starting with a letter.',
  twice: '{name} is listed twice.',
  needValue: 'Enter a value for {name}.',
  saveFailed: 'Could not save the server.',
  editName: 'Edit {name}',
  add: 'Add an MCP server',
  name: 'Name',
  nameHint: 'Lowercase letters, digits and hyphens. Tools from this server are named after it.',
  connection: 'Connection',
  stdio: 'Run a command on the Hub',
  stdioHint: 'Nova starts the server as a program and talks to it directly.',
  http: 'Streamable HTTP',
  httpHint: 'A server reachable at a web address.',
  sse: 'Server-sent events',
  sseHint: 'For older servers that use SSE.',
  command: 'Command',
  commandHint: 'The program to start, for example npx or a full path. It runs without a shell.',
  args: 'Arguments',
  argsHint: 'One per line.',
  url: 'Server URL',
  envVars: 'Environment variables',
  headers: 'Headers',
  secretsHint: "Values are kept in the Hub's secret store and are never shown again.",
  rowName: '{kind, select, env {Variable {n}} other {Header {n}}}',
  rowValue: 'Value {n}',
  savedHint: 'Saved. Type a new value to replace it.',
  removeName: 'Remove {name}',
  removeRow: '{kind, select, env {Remove variable {n}} other {Remove header {n}}}',
  remove: 'Remove',
  addVariable: 'Add variable',
  addHeader: 'Add header',
  advanced: 'Advanced',
  defaultApproval: "Default for this server's tools",
  defaultApprovalHint: 'Built-in safety still applies; a per-tool default overrides this.',
  approvalDefault: 'Default (ask)',
  ask: 'Ask',
  allow: 'Allow',
  deny: 'Deny',
  toolTimeout: 'Tool timeout (seconds)',
  startupTimeout: 'Startup timeout (seconds)',
  saveChanges: 'Save changes',
  addServer: 'Add server',
  cancel: 'Cancel',
});
const S = MCP_FORM_TEXT;

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
  if (!/^\d+$/.test(text.trim()) || n < 1 || n > max) return { error: S.secondsRange({ max }) };
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
  if (!NAME_RE.test(f.name)) errors.name = S.nameRule;
  if (stdio && !f.command.trim()) errors.command = S.needCommand;
  if (!stdio && !isHttpUrl(f.url.trim())) errors.url = S.needUrl;
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
    if (!valid) rowErrors[r.id] = { name: stdio ? S.envRule : S.headerRule };
    else if (seen.has(key)) rowErrors[r.id] = { name: S.twice({ name }) };
    else if (!r.saved && !r.value) rowErrors[r.id] = { value: S.needValue({ name }) };
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
  allowStdio = true,
  transportHint,
}: {
  /** The server to edit; omitted to add one. */
  server?: McpServerView;
  onSaved: (s: McpServerView) => void;
  onCancel?: () => void;
  submitLabel?: string;
  /** False for a member (M8): a command on the Hub is the owner's; only web servers are offered. */
  allowStdio?: boolean;
  /** Said under the connection choices (why a command is not offered). */
  transportHint?: string;
}) {
  const { api } = useServices();
  const id = `mcp${useId()}`;
  const [form, setForm] = useState<McpFormState>(() => {
    const f = formFromServer(server ?? null);
    return !allowStdio && f.transport === 'stdio' && !server ? { ...f, transport: 'http' } : f;
  });
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
      setFailure(errorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const kind = stdio ? 'env' : 'header';
  return (
    <form
      className="stack"
      aria-label={server ? S.editName({ name: server.name }) : S.add}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={S.name}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        hint={S.nameHint}
        error={errors.name}
        onChange={(e) => set({ name: e.target.value })}
      />
      <RadioGroup
        legend={S.connection}
        name={`${id}-transport`}
        value={form.transport}
        onChange={(v) => set({ transport: v as McpTransport })}
        hint={transportHint}
        options={[
          ...(allowStdio || form.transport === 'stdio'
            ? [
                {
                  value: 'stdio',
                  label: S.stdio,
                  description: S.stdioHint,
                },
              ]
            : []),
          {
            value: 'http',
            label: S.http,
            description: S.httpHint,
          },
          {
            value: 'sse',
            label: S.sse,
            description: S.sseHint,
          },
        ]}
      />
      {stdio ? (
        <>
          <TextField
            label={S.command}
            value={form.command}
            spellCheck={false}
            autoComplete="off"
            hint={S.commandHint}
            error={errors.command}
            onChange={(e) => set({ command: e.target.value })}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-args`}>
              {S.args}
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
              {S.argsHint}
            </span>
          </div>
        </>
      ) : (
        <TextField
          label={S.url}
          type="url"
          value={form.url}
          spellCheck={false}
          autoComplete="off"
          placeholder={URL_EXAMPLE}
          error={errors.url}
          onChange={(e) => set({ url: e.target.value })}
        />
      )}
      <fieldset className="ws-fieldset">
        <legend>{stdio ? S.envVars : S.headers}</legend>
        <p className="nv-field-hint ws-flush">{S.secretsHint}</p>
        {form.rows.map((r, i) => {
          const re = errors.rows?.[r.id];
          return (
            <div key={r.id} className="ws-target ws-secret-row">
              <TextField
                label={S.rowName({ kind, n: i + 1 })}
                value={r.name}
                readOnly={r.saved}
                spellCheck={false}
                autoComplete="off"
                placeholder={stdio ? ENV_EXAMPLE : HEADER_EXAMPLE}
                error={re?.name}
                onChange={(e) => setRow(r.id, { name: e.target.value })}
              />
              <TextField
                label={S.rowValue({ n: i + 1 })}
                type="password"
                autoComplete="new-password"
                value={r.value}
                placeholder={r.saved ? MASK : ''}
                hint={r.saved ? S.savedHint : undefined}
                error={re?.value}
                onChange={(e) => setRow(r.id, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                aria-label={
                  r.name.trim()
                    ? S.removeName({ name: r.name.trim() })
                    : S.removeRow({ kind, n: i + 1 })
                }
                onClick={() => set({ rows: form.rows.filter((x) => x.id !== r.id) })}
              >
                {S.remove}
              </Button>
            </div>
          );
        })}
        <div className="row">
          <Button onClick={() => set({ rows: [...form.rows, newRow()] })}>
            <Icon name="plus" /> {stdio ? S.addVariable : S.addHeader}
          </Button>
        </div>
      </fieldset>
      <details className="ws-advanced">
        <summary>{S.advanced}</summary>
        <div className="stack">
          <SelectField
            label={S.defaultApproval}
            value={form.defaultApproval}
            onChange={(v) => set({ defaultApproval: v as McpFormState['defaultApproval'] })}
            hint={S.defaultApprovalHint}
            options={[
              { value: '', label: S.approvalDefault },
              { value: 'ask', label: S.ask },
              { value: 'allow', label: S.allow },
              { value: 'deny', label: S.deny },
            ]}
          />
          <TextField
            label={S.toolTimeout}
            className="ws-number"
            inputMode="numeric"
            value={form.toolTimeout}
            placeholder="60"
            error={errors.toolTimeout}
            onChange={(e) => set({ toolTimeout: e.target.value })}
          />
          <TextField
            label={S.startupTimeout}
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
          {busy ? <Spinner /> : null} {submitLabel ?? (server ? S.saveChanges : S.addServer)}
        </Button>
        {onCancel ? <Button onClick={onCancel}>{S.cancel}</Button> : null}
      </div>
    </form>
  );
}
