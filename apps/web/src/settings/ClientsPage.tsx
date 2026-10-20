// Settings → Apps & clients (FR-044, FR-192; docs/08 §2.2): Nova's own MCP server for external
// MCP clients. It is off until a client is added; each client gets its own scoped token (tools,
// projects, chat access, read-only or run-allowed, expiry), shown once and stored only as a hash.
// Nova never writes into another app's configuration: it shows the endpoint and a snippet.
import { useEffect, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type {
  AppAuthorizationCreated,
  AppAuthorizationView,
  ProjectView,
  ToolView,
} from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage, type CreateAppAuthorizationRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from './common.ts';
import { SwitchField } from './controls.tsx';
import { copyText } from './copy.ts';
import { embed } from './embed.tsx';
import '../workspace.css';

type Scopes = AppAuthorizationView['scopes'];

export const CLIENTS_TEXT = defineMessages('settings.clients', {
  scopes: {
    allTools: 'all allowed tools',
    tools: '{n, plural, one {# tool} other {# tools}}',
    allProjects: 'all projects',
    projects: '{n, plural, one {# project} other {# projects}}',
    threads: { none: 'no chats', read: 'reads chats', read_write: 'reads and adds to chats' },
    readOnly: 'read-only',
    mayRun: 'may run tools',
  },
  neverExpires: 'never expires',
  expired: 'expired',
  expires: 'expires {date}',
  loadFailed: 'Could not load the clients.',
  serverOn: "Nova's MCP server is on.",
  serverOff: "Nova's MCP server is off. Clients cannot connect.",
  changeFailed: 'Could not change it: {error}',
  revoked: '{name} revoked. Its sessions were closed.',
  revokeFailed: 'Could not revoke {name}: {error}',
  title: 'Apps & clients',
  server: 'Nova as an MCP server',
  serverHint:
    'Other MCP clients can read your projects and chats and run tools you allow, each with its ' +
    'own token. Every call passes your permission rules and is recorded in the audit log.',
  serverSwitch: "Nova's MCP server",
  serverSwitchOn: 'On: clients with a valid token can connect.',
  serverSwitchOff: 'Off: no client can connect. Adding a client turns it on.',
  clients: 'Clients',
  add: 'Add a client',
  retry: 'Retry',
  loading: 'Loading clients',
  none: 'No clients yet',
  noneHint: 'Add a client to let another MCP app use Nova.',
  list: 'MCP clients',
  meta: 'last used {used} · {expiry} · added {added}',
  revokeName: 'Revoke {name}',
  revoke: 'Revoke',
  revokeTitle: 'Revoke {name}?',
  revokeThis: 'Revoke this client?',
  revokeBody: 'Its token stops working and its open sessions close at once.',
  cancel: 'Cancel',
  needName: 'Enter a name for the client.',
  needTool: 'Choose at least one tool.',
  needProject: 'Choose at least one project.',
  addFailed: 'Could not add the client.',
  added: '{name} added',
  addedBody: 'Copy the token now. It is not shown again; Nova keeps only a hash of it.',
  done: 'Done',
  addTitle: 'Add an MCP client',
  addBody: 'Choose what this client may reach. You can revoke it at any time.',
  name: 'Client name',
  nameHint: 'So you can tell clients apart, for example: Laptop editor.',
  tools: 'Tools',
  toolsAll: 'Every tool your rules allow',
  toolsSome: 'Only the tools I choose',
  toolsNone: 'No tools',
  toolsPick: 'Tools this client may call',
  loadingTools: 'Loading tools',
  projects: 'Projects',
  projectsAll: 'All projects',
  projectsSome: 'Only the projects I choose',
  projectsPick: 'Projects this client may see',
  loadingProjects: 'Loading projects',
  noProjects: 'You have no projects.',
  chats: 'Chats',
  chatsNone: 'No access to chats',
  chatsRead: 'Read chats',
  chatsReadWrite: 'Read and add to chats',
  mode: 'What it may do',
  readOnly: 'Read only',
  readOnlyHint: 'Only tools that change nothing.',
  mayRun: 'May run tools',
  mayRunHint: 'Tools that ask first still ask you.',
  expiry: 'Token expires',
  inDays: '{n, plural, one {In # day} other {In # days}}',
  inYear: 'In a year',
  never: 'Never',
  addClient: 'Add client',
  copied: '{what, select, token {Token copied.} other {Configuration copied.}}',
  copyFailed:
    '{what, select, token {Could not copy. The token is selected; copy it with your keyboard.} other {Could not copy. The configuration is selected; copy it with your keyboard.}}',
  token: 'Token',
  copyToken: 'Copy token',
  endpoint: 'Endpoint',
  config: 'Configuration for the client',
  copyConfig: 'Copy configuration',
  configHint:
    "Paste it into the client's MCP settings. Clients that only start local commands can run the launcher from Nova's folder instead: {command}, with the endpoint in {urlVar} and the token in {tokenVar} (set them in the client's environment settings, not in the command).",
});
const S = CLIENTS_TEXT;
// The stdio launcher and its environment variables: code, the same in every language.
const LAUNCHER = 'node packages/mcp/src/launcher-main.ts mcp stdio';
const URL_VAR = 'NOVA_MCP_URL';
const TOKEN_VAR = 'NOVA_MCP_TOKEN';

/** "All tools · 2 projects · reads chats · read-only". */
export function scopesText(s: Scopes): string {
  const tools = s.tools === '*' ? S.scopes.allTools : S.scopes.tools({ n: s.tools.length });
  const projects =
    s.projects === '*' ? S.scopes.allProjects : S.scopes.projects({ n: s.projects.length });
  const mode = s.mode === 'read_only' ? S.scopes.readOnly : S.scopes.mayRun;
  return `${tools} · ${projects} · ${S.scopes.threads[s.threads]} · ${mode}`;
}

/** A configuration snippet for an MCP client that speaks streamable HTTP. */
export function clientSnippet(endpoint: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        nova: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

function expiryText(a: AppAuthorizationView, now = Date.now()): string {
  if (!a.expiresAt) return S.neverExpires;
  const t = Date.parse(a.expiresAt);
  if (!Number.isNaN(t) && t <= now) return S.expired;
  return S.expires({ date: fmt.date(t, { year: 'numeric', month: 'short', day: 'numeric' }) });
}

export function ClientsPage() {
  const { api } = useServices();
  const toast = useToast();
  const settings = useSettings();
  const enabled = settings.get('mcpServer.enabled');
  const [clients, setClients] = useState<AppAuthorizationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<AppAuthorizationView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listAppAuthorizations().then(
      ({ items }) => {
        if (!alive) return;
        setClients(items.filter((a) => a.kind === 'mcp_client'));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const setServer = (on: boolean) => {
    settings.set('mcpServer.enabled', on).then(
      () => toast.show(on ? S.serverOn : S.serverOff, { tone: 'success' }),
      (err: unknown) => toast.show(S.changeFailed({ error: errorMessage(err) }), { tone: 'error' }),
    );
  };

  const revoke = async (a: AppAuthorizationView) => {
    setRevoking(null);
    try {
      await api.revokeAppAuthorization(a.id);
      setClients((list) => list?.filter((x) => x.id !== a.id) ?? null);
      toast.show(S.revoked({ name: a.clientName }), { tone: 'success' });
    } catch (err) {
      toast.show(S.revokeFailed({ name: a.clientName, error: errorMessage(err) }), {
        tone: 'error',
      });
    }
  };

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section" aria-labelledby="clients-server">
        <h3 id="clients-server">{S.server}</h3>
        <p className="muted">{S.serverHint}</p>
        <SwitchField
          label={S.serverSwitch}
          description={enabled.value ? S.serverSwitchOn : S.serverSwitchOff}
          checked={enabled.value}
          locked={enabled.locked}
          onChange={setServer}
        />
      </section>
      <section className="settings-section" aria-labelledby="clients-list">
        <h3 id="clients-list">{S.clients}</h3>
        <div className="row">
          <Button variant="primary" onClick={() => setAdding(true)}>
            {S.add}
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
          </div>
        ) : null}
        {clients === null && !error ? <Spinner label={S.loading} /> : null}
        {clients?.length === 0 ? (
          <EmptyState level={3} title={S.none} description={S.noneHint} />
        ) : null}
        {clients?.length ? (
          <ul className="ws-list" aria-label={S.list}>
            {clients.map((a) => (
              <li key={a.id} className="ws-list-row" aria-label={a.clientName}>
                <div className="ws-source-main">
                  <strong>{a.clientName}</strong>
                  <span className="muted">{scopesText(a.scopes)}</span>
                  <span className="muted ws-row-meta">
                    {S.meta({
                      used: formatWhen(a.lastUsedAt),
                      expiry: expiryText(a),
                      added: formatWhen(a.createdAt),
                    })}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label={S.revokeName({ name: a.clientName })}
                  onClick={() => setRevoking(a)}
                >
                  {S.revoke}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {adding ? (
        <AddClientDialog
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setClients((list) => [...(list ?? []), c.authorization]);
            // The Hub turns its server on with the first client; mirror that here.
            if (!enabled.value && !enabled.locked) setServer(true);
          }}
        />
      ) : null}
      <Dialog
        open={revoking !== null}
        title={revoking ? S.revokeTitle({ name: revoking.clientName }) : S.revokeThis}
        description={S.revokeBody}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              {S.revoke}
            </Button>
          </>
        }
      />
    </div>
  );
}

type Pick3 = 'all' | 'some' | 'none';

function AddClientDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: AppAuthorizationCreated) => void;
}) {
  const { api } = useServices();
  const [name, setName] = useState('');
  const [toolPick, setToolPick] = useState<Pick3>('all');
  const [tools, setTools] = useState<Set<string>>(() => new Set());
  const [projectPick, setProjectPick] = useState<'all' | 'some'>('all');
  const [projects, setProjects] = useState<Set<string>>(() => new Set());
  const [threads, setThreads] = useState<Scopes['threads']>('read');
  const [mode, setMode] = useState<Scopes['mode']>('read_only');
  const [expiry, setExpiry] = useState('90');
  const [toolList, setToolList] = useState<ToolView[] | null>(null);
  const [projectList, setProjectList] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AppAuthorizationCreated | null>(null);

  useEffect(() => {
    let alive = true;
    api.listTools().then(
      ({ items }) => alive && setToolList(items),
      () => alive && setToolList([]),
    );
    api.listProjects().then(
      ({ items }) => alive && setProjectList(items),
      () => alive && setProjectList([]),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const submit = async () => {
    const clientName = name.trim();
    if (!clientName) return setError(S.needName);
    if (toolPick === 'some' && tools.size === 0) return setError(S.needTool);
    if (projectPick === 'some' && projects.size === 0) return setError(S.needProject);
    setError(null);
    setBusy(true);
    const body: CreateAppAuthorizationRequest = {
      kind: 'mcp_client',
      clientName,
      scopes: {
        tools: toolPick === 'all' ? '*' : toolPick === 'none' ? [] : [...tools],
        projects: projectPick === 'all' ? '*' : [...projects],
        threads,
        mode,
      },
      expiresInDays: expiry === 'never' ? null : Number(expiry),
    };
    try {
      const c = await api.createAppAuthorization(body);
      setCreated(c);
      onCreated(c);
    } catch (err) {
      setError(errorMessage(err, S.addFailed));
    } finally {
      setBusy(false);
    }
  };

  const toggleIn = (set: (f: (s: Set<string>) => Set<string>) => void, id: string, on: boolean) =>
    set((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  if (created)
    return (
      <Dialog
        open
        title={S.added({ name: created.authorization.clientName })}
        description={S.addedBody}
        onClose={onClose}
        className="ws-wide-dialog"
        footer={
          <Button variant="primary" onClick={onClose}>
            {S.done}
          </Button>
        }
      >
        <TokenView created={created} />
      </Dialog>
    );

  return (
    <Dialog
      open
      title={S.addTitle}
      description={S.addBody}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={S.name}
          value={name}
          maxLength={100}
          hint={S.nameHint}
          onChange={(e) => setName(e.target.value)}
        />
        <RadioGroup
          legend={S.tools}
          name="client-tools"
          value={toolPick}
          onChange={(v) => setToolPick(v as Pick3)}
          options={[
            { value: 'all', label: S.toolsAll },
            { value: 'some', label: S.toolsSome },
            { value: 'none', label: S.toolsNone },
          ]}
        />
        {toolPick === 'some' ? (
          <fieldset className="ws-fieldset">
            <legend>{S.toolsPick}</legend>
            {toolList === null ? <Spinner label={S.loadingTools} /> : null}
            <div className="ws-checks">
              {(toolList ?? []).map((t) => (
                <label key={t.name} className="ws-check">
                  <input
                    type="checkbox"
                    checked={tools.has(t.name)}
                    onChange={(e) => toggleIn(setTools, t.name, e.target.checked)}
                  />
                  <span>{t.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <RadioGroup
          legend={S.projects}
          name="client-projects"
          value={projectPick}
          onChange={(v) => setProjectPick(v as 'all' | 'some')}
          options={[
            { value: 'all', label: S.projectsAll },
            { value: 'some', label: S.projectsSome },
          ]}
        />
        {projectPick === 'some' ? (
          <fieldset className="ws-fieldset">
            <legend>{S.projectsPick}</legend>
            {projectList === null ? <Spinner label={S.loadingProjects} /> : null}
            {projectList?.length === 0 ? <p className="muted">{S.noProjects}</p> : null}
            <div className="ws-checks">
              {(projectList ?? []).map((p) => (
                <label key={p.id} className="ws-check">
                  <input
                    type="checkbox"
                    checked={projects.has(p.id)}
                    onChange={(e) => toggleIn(setProjects, p.id, e.target.checked)}
                  />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <RadioGroup
          legend={S.chats}
          name="client-threads"
          value={threads}
          onChange={(v) => setThreads(v as Scopes['threads'])}
          options={[
            { value: 'none', label: S.chatsNone },
            { value: 'read', label: S.chatsRead },
            { value: 'read_write', label: S.chatsReadWrite },
          ]}
        />
        <RadioGroup
          legend={S.mode}
          name="client-mode"
          value={mode}
          onChange={(v) => setMode(v as Scopes['mode'])}
          options={[
            {
              value: 'read_only',
              label: S.readOnly,
              description: S.readOnlyHint,
            },
            {
              value: 'run_allowed',
              label: S.mayRun,
              description: S.mayRunHint,
            },
          ]}
        />
        <SelectField
          label={S.expiry}
          value={expiry}
          onChange={setExpiry}
          options={[
            ...[7, 30, 90].map((n) => ({ value: String(n), label: S.inDays({ n }) })),
            { value: '365', label: S.inYear },
            { value: 'never', label: S.never },
          ]}
        />
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.addClient}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The token, once. Closing the dialog forgets it; the Hub keeps only its hash. */
function TokenView({ created }: { created: AppAuthorizationCreated }) {
  const toast = useToast();
  const tokenRef = useRef<HTMLElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  // The form that had focus is gone; start on the token's Copy button.
  useEffect(() => {
    copyButton.current?.focus();
  }, []);
  const snippetRef = useRef<HTMLElement>(null);
  const snippet = clientSnippet(created.endpoint, created.token);
  const copy = async (text: string, el: HTMLElement | null, what: 'token' | 'config') => {
    const ok = await copyText(text, el);
    toast.show(ok ? S.copied({ what }) : S.copyFailed({ what }), {
      tone: ok ? 'success' : 'error',
    });
  };
  return (
    <div className="stack">
      <div className="nv-field">
        <span className="nv-field-label" id="client-token-label">
          {S.token}
        </span>
        <pre role="group" className="ws-command" aria-labelledby="client-token-label">
          <code ref={tokenRef}>{created.token}</code>
        </pre>
        <div className="row">
          <Button
            ref={copyButton}
            onClick={() => void copy(created.token, tokenRef.current, 'token')}
          >
            {S.copyToken}
          </Button>
        </div>
      </div>
      <div className="nv-field">
        <span className="nv-field-label" id="client-endpoint-label">
          {S.endpoint}
        </span>
        <code role="group" className="ws-code-inline" aria-labelledby="client-endpoint-label">
          {created.endpoint}
        </code>
      </div>
      <div className="nv-field">
        <span className="nv-field-label" id="client-snippet-label">
          {S.config}
        </span>
        <pre role="group" className="ws-command" aria-labelledby="client-snippet-label">
          <code ref={snippetRef}>{snippet}</code>
        </pre>
        <div className="row">
          <Button onClick={() => void copy(snippet, snippetRef.current, 'config')}>
            {S.copyConfig}
          </Button>
        </div>
        {/* The stdio launcher is packages/mcp/src/launcher-main.ts; no `nova` command is
            installed (docs/08 §2.2). The token goes in the environment, never in the command. */}
        <span className="nv-field-hint">
          {embed(S.configHint, {
            command: (
              <code className="ws-code-inline" dir="ltr">
                {LAUNCHER}
              </code>
            ),
            urlVar: (
              <code className="ws-code-inline" dir="ltr">
                {URL_VAR}
              </code>
            ),
            tokenVar: (
              <code className="ws-code-inline" dir="ltr">
                {TOKEN_VAR}
              </code>
            ),
          })}
        </span>
      </div>
    </div>
  );
}
