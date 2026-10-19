// Settings → Apps & clients (FR-044, FR-192; docs/08 §2.2): Nova's own MCP server for external
// MCP clients. It is off until a client is added; each client gets its own scoped token (tools,
// projects, chat access, read-only or run-allowed, expiry), shown once and stored only as a hash.
// Nova never writes into another app's configuration: it shows the endpoint and a snippet.
import { useEffect, useRef, useState } from 'react';
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
import { formatWhen, plural } from './common.ts';
import { SwitchField } from './controls.tsx';
import { copyText } from './copy.ts';
import '../workspace.css';

type Scopes = AppAuthorizationView['scopes'];

const THREADS_TEXT: Record<Scopes['threads'], string> = {
  none: 'no chats',
  read: 'reads chats',
  read_write: 'reads and adds to chats',
};

/** "All tools · 2 projects · reads chats · read-only". */
export function scopesText(s: Scopes): string {
  const tools = s.tools === '*' ? 'all allowed tools' : plural(s.tools.length, 'tool');
  const projects = s.projects === '*' ? 'all projects' : plural(s.projects.length, 'project');
  const mode = s.mode === 'read_only' ? 'read-only' : 'may run tools';
  return `${tools} · ${projects} · ${THREADS_TEXT[s.threads]} · ${mode}`;
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
  if (!a.expiresAt) return 'never expires';
  const t = Date.parse(a.expiresAt);
  if (!Number.isNaN(t) && t <= now) return 'expired';
  return `expires ${new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the clients.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const setServer = (on: boolean) => {
    settings.set('mcpServer.enabled', on).then(
      () =>
        toast.show(
          on ? "Nova's MCP server is on." : "Nova's MCP server is off. Clients cannot connect.",
          { tone: 'success' },
        ),
      (err: unknown) => toast.show(`Could not change it: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const revoke = async (a: AppAuthorizationView) => {
    setRevoking(null);
    try {
      await api.revokeAppAuthorization(a.id);
      setClients((list) => list?.filter((x) => x.id !== a.id) ?? null);
      toast.show(`${a.clientName} revoked. Its sessions were closed.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not revoke ${a.clientName}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="settings-page">
      <h2>Apps &amp; clients</h2>
      <section className="settings-section" aria-labelledby="clients-server">
        <h3 id="clients-server">Nova as an MCP server</h3>
        <p className="muted">
          Other MCP clients can read your projects and chats and run tools you allow, each with its
          own token. Every call passes your permission rules and is recorded in the audit log.
        </p>
        <SwitchField
          label="Nova's MCP server"
          description={
            enabled.value
              ? 'On: clients with a valid token can connect.'
              : 'Off: no client can connect. Adding a client turns it on.'
          }
          checked={enabled.value}
          locked={enabled.locked}
          onChange={setServer}
        />
      </section>
      <section className="settings-section" aria-labelledby="clients-list">
        <h3 id="clients-list">Clients</h3>
        <div className="row">
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a client
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          </div>
        ) : null}
        {clients === null && !error ? <Spinner label="Loading clients" /> : null}
        {clients?.length === 0 ? (
          <EmptyState
            level={3}
            title="No clients yet"
            description="Add a client to let another MCP app use Nova."
          />
        ) : null}
        {clients?.length ? (
          <ul className="ws-list" aria-label="MCP clients">
            {clients.map((a) => (
              <li key={a.id} className="ws-list-row" aria-label={a.clientName}>
                <div className="ws-source-main">
                  <strong>{a.clientName}</strong>
                  <span className="muted">{scopesText(a.scopes)}</span>
                  <span className="muted ws-row-meta">
                    last used {formatWhen(a.lastUsedAt)} · {expiryText(a)} · added{' '}
                    {formatWhen(a.createdAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Revoke ${a.clientName}`}
                  onClick={() => setRevoking(a)}
                >
                  Revoke
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
        title={revoking ? `Revoke ${revoking.clientName}?` : 'Revoke this client?'}
        description="Its token stops working and its open sessions close at once."
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              Revoke
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
    if (!clientName) return setError('Enter a name for the client.');
    if (toolPick === 'some' && tools.size === 0) return setError('Choose at least one tool.');
    if (projectPick === 'some' && projects.size === 0)
      return setError('Choose at least one project.');
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
      setError(errorMessage(err, 'Could not add the client.'));
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
        title={`${created.authorization.clientName} added`}
        description="Copy the token now. It is not shown again; Nova keeps only a hash of it."
        onClose={onClose}
        className="ws-wide-dialog"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <TokenView created={created} />
      </Dialog>
    );

  return (
    <Dialog
      open
      title="Add an MCP client"
      description="Choose what this client may reach. You can revoke it at any time."
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
          label="Client name"
          value={name}
          maxLength={100}
          hint="So you can tell clients apart, for example: Laptop editor."
          onChange={(e) => setName(e.target.value)}
        />
        <RadioGroup
          legend="Tools"
          name="client-tools"
          value={toolPick}
          onChange={(v) => setToolPick(v as Pick3)}
          options={[
            { value: 'all', label: 'Every tool your rules allow' },
            { value: 'some', label: 'Only the tools I choose' },
            { value: 'none', label: 'No tools' },
          ]}
        />
        {toolPick === 'some' ? (
          <fieldset className="ws-fieldset">
            <legend>Tools this client may call</legend>
            {toolList === null ? <Spinner label="Loading tools" /> : null}
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
          legend="Projects"
          name="client-projects"
          value={projectPick}
          onChange={(v) => setProjectPick(v as 'all' | 'some')}
          options={[
            { value: 'all', label: 'All projects' },
            { value: 'some', label: 'Only the projects I choose' },
          ]}
        />
        {projectPick === 'some' ? (
          <fieldset className="ws-fieldset">
            <legend>Projects this client may see</legend>
            {projectList === null ? <Spinner label="Loading projects" /> : null}
            {projectList?.length === 0 ? <p className="muted">You have no projects.</p> : null}
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
          legend="Chats"
          name="client-threads"
          value={threads}
          onChange={(v) => setThreads(v as Scopes['threads'])}
          options={[
            { value: 'none', label: 'No access to chats' },
            { value: 'read', label: 'Read chats' },
            { value: 'read_write', label: 'Read and add to chats' },
          ]}
        />
        <RadioGroup
          legend="What it may do"
          name="client-mode"
          value={mode}
          onChange={(v) => setMode(v as Scopes['mode'])}
          options={[
            {
              value: 'read_only',
              label: 'Read only',
              description: 'Only tools that change nothing.',
            },
            {
              value: 'run_allowed',
              label: 'May run tools',
              description: 'Tools that ask first still ask you.',
            },
          ]}
        />
        <SelectField
          label="Token expires"
          value={expiry}
          onChange={setExpiry}
          options={[
            { value: '7', label: 'In 7 days' },
            { value: '30', label: 'In 30 days' },
            { value: '90', label: 'In 90 days' },
            { value: '365', label: 'In a year' },
            { value: 'never', label: 'Never' },
          ]}
        />
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Add client
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
  const copy = async (text: string, el: HTMLElement | null, what: string) => {
    const ok = await copyText(text, el);
    toast.show(
      ok
        ? `${what} copied.`
        : `Could not copy. The ${what.toLowerCase()} is selected; copy it with your keyboard.`,
      { tone: ok ? 'success' : 'error' },
    );
  };
  return (
    <div className="stack">
      <div className="nv-field">
        <span className="nv-field-label" id="client-token-label">
          Token
        </span>
        <pre className="ws-command" aria-labelledby="client-token-label">
          <code ref={tokenRef}>{created.token}</code>
        </pre>
        <div className="row">
          <Button
            ref={copyButton}
            onClick={() => void copy(created.token, tokenRef.current, 'Token')}
          >
            Copy token
          </Button>
        </div>
      </div>
      <div className="nv-field">
        <span className="nv-field-label" id="client-endpoint-label">
          Endpoint
        </span>
        <code className="ws-code-inline" aria-labelledby="client-endpoint-label">
          {created.endpoint}
        </code>
      </div>
      <div className="nv-field">
        <span className="nv-field-label" id="client-snippet-label">
          Configuration for the client
        </span>
        <pre className="ws-command" aria-labelledby="client-snippet-label">
          <code ref={snippetRef}>{snippet}</code>
        </pre>
        <div className="row">
          <Button onClick={() => void copy(snippet, snippetRef.current, 'Configuration')}>
            Copy configuration
          </Button>
        </div>
        {/* The stdio launcher is packages/mcp/src/launcher-main.ts; no `nova` command is
            installed (docs/08 §2.2). The token goes in the environment, never in the command. */}
        <span className="nv-field-hint">
          Paste it into the client&apos;s MCP settings. Clients that only start local commands can
          run the launcher from Nova&apos;s folder instead:{' '}
          <code className="ws-code-inline">node packages/mcp/src/launcher-main.ts mcp stdio</code>,
          with the endpoint in <code className="ws-code-inline">NOVA_MCP_URL</code> and the token in{' '}
          <code className="ws-code-inline">NOVA_MCP_TOKEN</code> (set them in the client&apos;s
          environment settings, not in the command).
        </span>
      </div>
    </div>
  );
}
