// Settings → Tools & MCP (FR-042, FR-043, FR-048, FR-029; docs/08 §2.1, docs/14 §1.1): MCP
// servers with their health, logs and tools; every tool Nova can call with its per-tool default
// and the decision the policy engine would make now (a preview, no side effects); and the
// SearXNG instance behind web search. The server list refreshes every 5 s while the page is open.
// M4 adds installing a server from a bundle (FR-199) and OAuth sign-in for remote servers
// (FR-047).
import { useEffect, useId, useState } from 'react';
import type { McpLogLine, McpServerView, ToolDescriptor, ToolView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  SelectField,
  Spinner,
  Switch,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { VerifiedBadge } from './badges.tsx';
import { BundleInstallButton } from './BundleInstall.tsx';
import { MANAGED, formatWhen, plural, useInterval } from './common.ts';
import { McpAuthControls, useOAuthReturn } from './McpAuth.tsx';
import { McpServerForm, envToHeader } from './McpServerForm.tsx';
import { EFFECT_TEXT, EFFECT_TONE, MCP_STATUS, SOURCE_TEXT, TIER_TEXT } from './policy-text.ts';
import '../workspace.css';

export const MCP_POLL_MS = 5000;

/** What marking an MCP tool "Reads only" means (FR-082, FR-189: the owner's declaration). */
export const READS_ONLY_HELP =
  "Nova treats this tool as reading only: agents' research may use it, and it is allowed without asking. Only mark tools that never change anything.";

export function ToolsPage() {
  const { api } = useServices();
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Bumped after a server change so the tool list (which includes MCP tools) reloads.
  const [toolsVersion, setToolsVersion] = useState(0);
  useOAuthReturn();

  useEffect(() => {
    let alive = true;
    api.listMcpServers().then(
      ({ items }) => {
        if (!alive) return;
        setServers(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load MCP servers.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  useInterval(() => setVersion((v) => v + 1), MCP_POLL_MS);

  const replace = (s: McpServerView) => {
    setServers((list) => {
      const rest = list ?? [];
      return rest.some((x) => x.id === s.id)
        ? rest.map((x) => (x.id === s.id ? s : x))
        : [...rest, s];
    });
    setToolsVersion((v) => v + 1);
  };
  const removed = (sid: string) => {
    setServers((list) => list?.filter((x) => x.id !== sid) ?? null);
    setToolsVersion((v) => v + 1);
  };

  return (
    <div className="settings-page">
      <h2>Tools &amp; MCP</h2>
      <McpServersSection
        servers={servers}
        error={error}
        onRetry={() => setVersion((v) => v + 1)}
        onSaved={replace}
        onRemoved={removed}
      />
      <ToolsSection servers={servers ?? []} version={toolsVersion} />
      <WebSearchSection />
    </div>
  );
}

// ---- MCP servers (FR-042, FR-043) ------------------------------------------------------------------

function McpStatusChip({ server }: { server: McpServerView }) {
  const s = MCP_STATUS[server.status];
  return (
    <span className="nv-chip" data-status={s.tone ?? undefined}>
      {server.status === 'starting' ? <Spinner /> : <Icon name={s.icon} />}
      <span>{s.text}</span>
    </span>
  );
}

function McpServersSection({
  servers,
  error,
  onRetry,
  onSaved,
  onRemoved,
}: {
  servers: McpServerView[] | null;
  error: string | null;
  onRetry: () => void;
  onSaved: (s: McpServerView) => void;
  onRemoved: (id: string) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [removing, setRemoving] = useState<McpServerView | null>(null);

  const remove = async (s: McpServerView) => {
    setRemoving(null);
    try {
      await api.deleteMcpServer(s.id);
      onRemoved(s.id);
      toast.show(`${s.name} removed.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not remove ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="tools-mcp">
      <h3 id="tools-mcp">MCP servers</h3>
      <p className="muted">
        Servers that give Nova more tools. Each one runs on its own; one failing never stops the
        others.
      </p>
      <div className="row">
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add server
        </Button>
        <BundleInstallButton
          onInstalled={(s) => {
            onSaved(s);
            toast.show(`${s.name} installed. It connects in the background.`, { tone: 'success' });
          }}
        />
      </div>
      <p className="muted">
        Hooks and plugins are in{' '}
        <a
          href="/settings/plugins"
          onClick={(e) => {
            e.preventDefault();
            navigate('/settings/plugins');
          }}
        >
          Plugins &amp; skills
        </a>
        .
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      {servers === null && !error ? <Spinner label="Loading MCP servers" /> : null}
      {servers?.length === 0 ? (
        <EmptyState
          level={3}
          title="No MCP servers yet"
          description="Add a server to give Nova tools such as issue trackers, calendars or databases."
        />
      ) : null}
      {servers?.length ? (
        <ul className="ws-list" aria-label="MCP servers">
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onSaved={onSaved}
              onEdit={() => setEditing(s)}
              onRemove={() => setRemoving(s)}
            />
          ))}
        </ul>
      ) : null}
      <Dialog
        open={adding}
        title="Add an MCP server"
        description="It connects in the background once added."
        onClose={() => setAdding(false)}
      >
        <McpServerForm
          onCancel={() => setAdding(false)}
          onSaved={(s) => {
            setAdding(false);
            onSaved(s);
            toast.show(`${s.name} added. It connects in the background.`, { tone: 'success' });
          }}
        />
      </Dialog>
      <Dialog
        open={editing !== null}
        title={editing ? `Edit ${editing.name}` : 'Edit server'}
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <McpServerForm
            server={editing}
            onCancel={() => setEditing(null)}
            onSaved={(s) => {
              setEditing(null);
              onSaved(s);
              toast.show(`${s.name} saved.`, { tone: 'success' });
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : 'Remove this server?'}
        description="Its tools stop working at once and its saved secrets are deleted."
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              Remove
            </Button>
          </>
        }
      />
    </section>
  );
}

function ServerRow({
  server: s,
  onSaved,
  onEdit,
  onRemove,
}: {
  server: McpServerView;
  onSaved: (s: McpServerView) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [showLogs, setShowLogs] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<McpServerView>, done: string, failed: string) => {
    setBusy(true);
    try {
      onSaved(await fn());
      toast.show(done, { tone: 'success' });
    } catch (err) {
      toast.show(`${failed}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const target =
    s.transport === 'stdio' ? [s.command ?? '', ...s.args].join(' ').trim() : (s.url ?? '');
  const secretNames = s.transport === 'stdio' ? s.envKeys : s.envKeys.map(envToHeader);
  const logsId = `mcp-logs-${s.id}`;
  const toolsId = `mcp-tools-${s.id}`;

  return (
    <li className="ws-list-row ws-mcp" aria-label={s.name}>
      <div className="ws-source-main">
        <span className="ws-row-meta">
          <strong>{s.name}</strong>
          <McpStatusChip server={s} />
          <span className="ws-badge">
            {s.transport === 'stdio' ? 'Command' : s.transport.toUpperCase()}
          </span>
          {s.bundle ? (
            <>
              <VerifiedBadge verified={s.bundle.signature === 'verified'} />
              <span className="muted">
                bundle {s.bundle.name} {s.bundle.version}
              </span>
            </>
          ) : null}
        </span>
        {s.pluginId ? (
          <span className="muted ws-row-meta">
            From the plugin {s.pluginId}; change or remove it in{' '}
            <a
              href="/settings/plugins"
              onClick={(e) => {
                e.preventDefault();
                navigate('/settings/plugins');
              }}
            >
              Plugins
            </a>
            .
          </span>
        ) : null}
        {target ? <code className="ws-code-inline">{target}</code> : null}
        {secretNames.length ? (
          <span className="muted ws-row-meta">
            {s.transport === 'stdio' ? 'Environment:' : 'Headers:'}
            {secretNames.map((k) => (
              <code key={k} className="ws-code-inline">
                {k} <span aria-label="value hidden">••••••</span>
              </code>
            ))}
          </span>
        ) : null}
        <span className="muted ws-row-meta">
          {plural(s.counts.tools, 'tool')} · {plural(s.counts.resources, 'resource')} ·{' '}
          {plural(s.counts.prompts, 'prompt')}
          {s.serverInfo ? ` · ${s.serverInfo.name} ${s.serverInfo.version}` : ''}
          {s.status === 'connected' && s.connectedAt
            ? ` · connected ${formatWhen(s.connectedAt)}`
            : ''}
          {s.restarts ? ` · restarted ${plural(s.restarts, 'time')} in the last 10 minutes` : ''}
        </span>
        <McpAuthControls server={s} onSaved={onSaved} />
        {s.lastError ? (
          <p className="ws-warning ws-mcp-error">
            <Icon name="alert" /> <span>Last error: {s.lastError}</span>
          </p>
        ) : null}
      </div>
      <div className="row ws-row-actions">
        <Switch
          label={`Enable ${s.name}`}
          checked={s.enabled}
          disabled={busy || !!s.pluginId}
          onChange={(v) =>
            void act(
              () => api.updateMcpServer(s.id, { enabled: v }),
              v ? `${s.name} turned on.` : `${s.name} turned off.`,
              `Could not change ${s.name}`,
            )
          }
        />
        <Button
          variant="ghost"
          disabled={busy || !s.enabled}
          onClick={() =>
            void act(
              () => api.restartMcpServer(s.id),
              `Restarting ${s.name}.`,
              `Could not restart ${s.name}`,
            )
          }
        >
          Restart
        </Button>
        <Button
          variant="ghost"
          aria-expanded={showLogs}
          aria-controls={showLogs ? logsId : undefined}
          onClick={() => setShowLogs((v) => !v)}
        >
          Logs
        </Button>
        <Button
          variant="ghost"
          aria-expanded={showTools}
          aria-controls={showTools ? toolsId : undefined}
          onClick={() => setShowTools((v) => !v)}
        >
          Tools
        </Button>
        {s.pluginId ? null : (
          <>
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          </>
        )}
      </div>
      {showLogs ? <ServerLogs id={logsId} server={s} /> : null}
      {showTools ? <ServerTools id={toolsId} server={s} onSaved={onSaved} /> : null}
    </li>
  );
}

function ServerLogs({ id, server }: { id: string; server: McpServerView }) {
  const { api } = useServices();
  const [lines, setLines] = useState<McpLogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.mcpServerLogs(server.id).then(
      ({ items }) => {
        if (!alive) return;
        setLines(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the logs.')),
    );
    return () => {
      alive = false;
    };
  }, [api, server.id, version]);

  return (
    <section id={id} className="ws-subpanel" aria-label={`Logs for ${server.name}`}>
      <div className="row">
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {lines === null && !error ? <Spinner label="Loading logs" /> : null}
      {lines?.length === 0 ? <p className="muted">No log lines yet.</p> : null}
      {lines?.length ? (
        <pre className="ws-log" tabIndex={0}>
          {lines.map((l) => `${l.ts}  ${l.stream.padEnd(8)}  ${l.text}`).join('\n')}
        </pre>
      ) : null}
    </section>
  );
}

function ServerTools({
  id,
  server,
  onSaved,
}: {
  id: string;
  server: McpServerView;
  onSaved: (s: McpServerView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [tools, setTools] = useState<ToolDescriptor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();

  useEffect(() => {
    let alive = true;
    api.mcpServerTools(server.id).then(
      ({ items }) => alive && setTools(items),
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the tools.')),
    );
    return () => {
      alive = false;
    };
  }, [api, server.id]);

  // MCP tools are listed as mcp:<serverId>.<tool> (docs/08 §2.1); the server's lists hold the
  // bare tool name, which may itself contain dots.
  const bare = (name: string) =>
    name.startsWith('mcp:') ? name.slice(name.indexOf('.') + 1) : name;
  const toggle = async (name: string, on: boolean) => {
    const rest = server.disabledTools.filter((t) => t !== name);
    try {
      onSaved(await api.updateMcpServer(server.id, { disabledTools: on ? rest : [...rest, name] }));
    } catch (err) {
      toast.show(`Could not change ${name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };
  // The owner's "Reads only" list (FR-082). The Hub matches an entry by the server's name, the
  // bare name or the canonical name, so unmarking removes the tool under any of them.
  const readsOnly = (t: ToolDescriptor) =>
    server.readOnlyTools.some((x) => x === bare(t.name) || x === t.name);
  const markReadsOnly = async (t: ToolDescriptor, on: boolean) => {
    const name = bare(t.name);
    const rest = server.readOnlyTools.filter((x) => x !== name && x !== t.name);
    try {
      onSaved(await api.updateMcpServer(server.id, { readOnlyTools: on ? [...rest, name] : rest }));
    } catch (err) {
      toast.show(`Could not change ${name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section id={id} className="ws-subpanel" aria-label={`Tools from ${server.name}`}>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {tools === null && !error ? <Spinner label="Loading tools" /> : null}
      {tools?.length === 0 ? (
        <p className="muted">No tools listed. A server lists its tools once it is connected.</p>
      ) : null}
      {tools?.length ? (
        <p id={helpId} className="muted">
          {READS_ONLY_HELP}
        </p>
      ) : null}
      {tools?.length ? (
        <ul className="ws-list">
          {tools.map((t) => {
            const name = bare(t.name);
            const allowListed = server.enabledTools === null || server.enabledTools.includes(name);
            return (
              <li key={t.name} className="ws-list-row" aria-label={t.name}>
                <div className="ws-source-main">
                  <code className="ws-code-inline">{t.name}</code>
                  {t.description ? <span className="muted">{t.description}</span> : null}
                  <ToolBadges tool={t} />
                  {!allowListed ? (
                    <span className="muted ws-row-meta">Not in this server&apos;s allow list.</span>
                  ) : null}
                </div>
                <div className="row ws-row-actions">
                  <label className="ws-check">
                    <input
                      type="checkbox"
                      checked={readsOnly(t)}
                      disabled={!!server.pluginId}
                      aria-describedby={helpId}
                      onChange={(e) => void markReadsOnly(t, e.target.checked)}
                    />
                    <span>Reads only</span>
                  </label>
                  <Switch
                    label={`Use ${t.name}`}
                    checked={allowListed && !server.disabledTools.includes(name)}
                    disabled={!allowListed || !!server.pluginId}
                    onChange={(v) => void toggle(name, v)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function ToolBadges({ tool }: { tool: ToolDescriptor }) {
  const a = tool.annotations ?? {};
  const badges = [
    a.readOnly ? 'Read-only' : null,
    a.destructive ? 'Can delete or overwrite' : null,
    a.requiresNetwork ? 'Uses the network' : null,
    tool.deferred ? 'Loaded on demand' : null,
  ].filter((b): b is string => b !== null);
  if (!badges.length) return null;
  return (
    <span className="ws-row-meta">
      {badges.map((b) => (
        <span key={b} className="ws-badge">
          {b}
        </span>
      ))}
    </span>
  );
}

// ---- all tools and their defaults (FR-048) ----------------------------------------------------------

type ToolDefault = ToolView['userDefault'];

export function groupTools(
  tools: readonly ToolView[],
  servers: readonly McpServerView[],
): { key: string; label: string; tools: ToolView[] }[] {
  const names = new Map(servers.map((s) => [s.id, s.name]));
  const order = Object.keys(SOURCE_TEXT);
  const groups = new Map<string, { key: string; label: string; rank: number; tools: ToolView[] }>();
  for (const t of tools) {
    const key = t.source === 'mcp' ? `mcp:${t.serverId ?? ''}` : t.source;
    const label =
      t.source === 'mcp'
        ? `MCP: ${names.get(t.serverId ?? '') ?? t.serverId ?? 'unknown server'}`
        : SOURCE_TEXT[t.source];
    const g = groups.get(key) ?? { key, label, rank: order.indexOf(t.source), tools: [] };
    g.tools.push(t);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ key, label, tools: list }) => ({
      key,
      label,
      tools: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function ToolsSection({ servers, version }: { servers: McpServerView[]; version: number }) {
  const { api } = useServices();
  const toast = useToast();
  const [tools, setTools] = useState<ToolView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let alive = true;
    api.listTools().then(
      ({ items }) => {
        if (!alive) return;
        setTools(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the tools.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version, reload]);

  const setDefault = async (t: ToolView, value: ToolDefault) => {
    const patch = (d: ToolDefault) =>
      setTools(
        (list) => list?.map((x) => (x.name === t.name ? { ...x, userDefault: d } : x)) ?? null,
      );
    patch(value);
    try {
      await api.setToolDefault(t.name, value);
      // The effective decision depends on the default; ask the engine again.
      setReload((r) => r + 1);
    } catch (err) {
      patch(t.userDefault);
      toast.show(`Could not change the default for ${t.name}: ${errorMessage(err)}`, {
        tone: 'error',
      });
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (tools ?? []).filter(
    (t) => !q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q),
  );
  const groups = groupTools(shown, servers);

  return (
    <section className="settings-section" aria-labelledby="tools-all">
      <h3 id="tools-all">Tools</h3>
      <p className="muted">
        Choose whether each tool asks first. The decision shown is what Nova would do for a plain
        call in a chat now. Built-in safety still applies to every tool.
      </p>
      <TextField
        label="Filter tools"
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>Retry</Button>
        </div>
      ) : null}
      {tools === null && !error ? <Spinner label="Loading tools" /> : null}
      {tools?.length && !shown.length ? (
        <p className="muted">No tools match “{filter.trim()}”.</p>
      ) : null}
      {groups.map((g) => (
        <section key={g.key} className="ws-memory-group" aria-labelledby={`tools-g-${g.key}`}>
          <h4 id={`tools-g-${g.key}`}>{g.label}</h4>
          <ul className="ws-list">
            {g.tools.map((t) => (
              <ToolRow key={t.name} tool={t} onDefault={(v) => void setDefault(t, v)} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

export function EffectChip({ effect }: { effect: ToolView['effective']['effect'] }) {
  const tone = EFFECT_TONE[effect];
  return (
    <span className="nv-chip" data-status={tone.tone}>
      <Icon name={tone.icon} />
      <span>{EFFECT_TEXT[effect]}</span>
    </span>
  );
}

function ToolRow({ tool: t, onDefault }: { tool: ToolView; onDefault: (v: ToolDefault) => void }) {
  return (
    <li className="ws-list-row" aria-label={t.name}>
      <div className="ws-source-main">
        <span className="ws-row-meta">
          <strong>{t.title || t.name}</strong>
          {t.title && t.title !== t.name ? <code className="ws-code-inline">{t.name}</code> : null}
        </span>
        {t.description ? <span className="muted">{t.description}</span> : null}
        <span className="ws-row-meta">
          <EffectChip effect={t.effective.effect} />
          <span className="muted">{t.effective.reason}</span>
        </span>
        {t.effective.tier !== 'pre_approvable' ? (
          <span className="muted ws-row-meta">{TIER_TEXT[t.effective.tier]}</span>
        ) : null}
      </div>
      <SelectField
        label={`Default for ${t.name}`}
        hideLabel
        value={t.userDefault ?? ''}
        onChange={(v) => onDefault(v ? (v as 'allow' | 'ask' | 'deny') : null)}
        options={[
          { value: '', label: 'Default' },
          { value: 'ask', label: 'Ask' },
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny' },
        ]}
      />
    </li>
  );
}

// ---- web search (FR-029) -----------------------------------------------------------------------------

function WebSearchSection() {
  const settings = useSettings();
  const toast = useToast();
  const url = settings.get('search.searxngUrl');
  const saved = url.value ?? '';
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from the Hub discards it.
  const text = draft && draft.base === saved ? draft.text : saved;
  const trimmed = text.trim();
  let invalid = false;
  if (trimmed) {
    try {
      const u = new URL(trimmed);
      invalid = u.protocol !== 'http:' && u.protocol !== 'https:';
    } catch {
      invalid = true;
    }
  }

  const commit = () => {
    if (invalid || trimmed === saved) return;
    setDraft(null);
    settings.set('search.searxngUrl', trimmed || null).then(
      () =>
        toast.show(trimmed ? 'Web search address saved.' : 'Web search turned off.', {
          tone: 'success',
        }),
      (err: unknown) => toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  return (
    <section className="settings-section" aria-labelledby="tools-search">
      <h3 id="tools-search">Web search</h3>
      <TextField
        label="SearXNG address"
        type="url"
        value={text}
        placeholder="http://localhost:8080"
        disabled={url.locked}
        spellCheck={false}
        hint={`${url.locked ? `${MANAGED}. ` : ''}The web search tool sends queries to this SearXNG instance. Leave it empty to turn web search off. Saved when you leave the field.`}
        error={invalid ? 'Enter an http:// or https:// address.' : undefined}
        onChange={(e) => setDraft({ base: saved, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {saved ? (
        <p className="muted">Web search is on.</p>
      ) : (
        <p className="muted">Web search is off.</p>
      )}
    </section>
  );
}
