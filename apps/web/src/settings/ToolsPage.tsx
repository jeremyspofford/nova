// Settings → Tools & MCP (FR-042, FR-043, FR-048, FR-029; docs/08 §2.1, docs/14 §1.1): MCP
// servers with their health, logs and tools; every tool Nova can call with its per-tool default
// and the decision the policy engine would make now (a preview, no side effects); and the
// SearXNG instance behind web search. The server list refreshes every 5 s while the page is open.
// M4 adds installing a server from a bundle (FR-199) and OAuth sign-in for remote servers
// (FR-047). M8: a member sees their own servers and tool defaults; commands on the Hub, bundles and
// web search are the owner's and are hidden or explained (src/team/access.tsx).
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
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
import { formatWhen, useInterval } from './common.ts';
import { embed } from './embed.tsx';
import { McpAuthControls, useOAuthReturn } from './McpAuth.tsx';
import { McpServerForm, envToHeader } from './McpServerForm.tsx';
import { EFFECT_TEXT, EFFECT_TONE, MCP_STATUS, SOURCE_TEXT, TIER_TEXT } from './policy-text.ts';
import { MemberNote, OwnerSets, useMemberAccess, type MemberAccess } from '../team/access.tsx';
import { MEMBER_MODE_TEXT } from '../team/format.ts';
import '../workspace.css';

export const MCP_POLL_MS = 5000;
/** An example SearXNG address: a URL, the same in every language. */
const SEARXNG_EXAMPLE = 'http://localhost:8080';

export const TOOLS_TEXT = defineMessages('settings.tools', {
  /** What marking an MCP tool "Reads only" means (FR-082, FR-189: the owner's declaration). */
  readsOnlyHelp:
    "Nova treats this tool as reading only: agents' research may use it, and it is allowed " +
    'without asking. Only mark tools that never change anything.',
  loadServersFailed: 'Could not load MCP servers.',
  title: 'Tools & MCP',
  removed: '{name} removed.',
  removeFailed: 'Could not remove {name}: {error}',
  servers: 'MCP servers',
  serversHint:
    'Servers that give Nova more tools. Each one runs on its own; one failing never stops the ' +
    'others.',
  addServer: 'Add server',
  bundleInstalled: '{name} installed. It connects in the background.',
  hooksIn: 'Hooks and plugins are in {link}.',
  pluginsLink: 'Plugins & skills',
  retry: 'Retry',
  loadingServers: 'Loading MCP servers',
  noServers: 'No MCP servers yet',
  noServersHint: 'Add a server to give Nova tools such as issue trackers, calendars or databases.',
  addTitle: 'Add an MCP server',
  addBody: 'It connects in the background once added.',
  added: '{name} added. It connects in the background.',
  editName: 'Edit {name}',
  editServer: 'Edit server',
  saved: '{name} saved.',
  removeTitle: 'Remove {name}?',
  removeThis: 'Remove this server?',
  removeBody: 'Its tools stop working at once and its saved secrets are deleted.',
  cancel: 'Cancel',
  remove: 'Remove',
  command: 'Command',
  bundle: 'bundle {name} {version}',
  fromPlugin: 'From the plugin {id}; change or remove it in {link}.',
  plugins: 'Plugins',
  environment: 'Environment:',
  headers: 'Headers:',
  valueHidden: 'value hidden',
  counts:
    '{tools, plural, one {# tool} other {# tools}} · {resources, plural, one {# resource} other {# resources}} · {prompts, plural, one {# prompt} other {# prompts}}',
  connectedAt: 'connected {when}',
  restarts:
    '{n, plural, one {restarted # time in the last 10 minutes} other {restarted # times in the last 10 minutes}}',
  lastError: 'Last error: {error}',
  enable: 'Enable {name}',
  turnedOn: '{name} turned on.',
  turnedOff: '{name} turned off.',
  changeFailed: 'Could not change {name}: {error}',
  restarting: 'Restarting {name}.',
  restartFailed: 'Could not restart {name}: {error}',
  restart: 'Restart',
  logs: 'Logs',
  tools: 'Tools',
  edit: 'Edit',
  logsFailed: 'Could not load the logs.',
  logsFor: 'Logs for {name}',
  refresh: 'Refresh',
  loadingLogs: 'Loading logs',
  noLogs: 'No log lines yet.',
  toolsFailed: 'Could not load the tools.',
  toolsFrom: 'Tools from {name}',
  loadingTools: 'Loading tools',
  noTools: 'No tools listed. A server lists its tools once it is connected.',
  notAllowListed: "Not in this server's allow list.",
  readsOnly: 'Reads only',
  toggle: 'Use {name}',
  badge: {
    readOnly: 'Read-only',
    destructive: 'Can delete or overwrite',
    network: 'Uses the network',
    deferred: 'Loaded on demand',
  },
  mcpGroup: 'MCP: {server}',
  unknownServer: 'unknown server',
  defaultFailed: 'Could not change the default for {name}: {error}',
  toolsHint:
    'Choose whether each tool asks first. The decision shown is what Nova would do for a plain ' +
    'call in a chat now. Built-in safety still applies to every tool.',
  filter: 'Filter tools',
  noMatch: 'No tools match “{filter}”.',
  defaultFor: 'Default for {name}',
  default: 'Default',
  ask: 'Ask',
  allow: 'Allow',
  deny: 'Deny',
  searchSaved: 'Web search address saved.',
  searchOff: 'Web search turned off.',
  saveFailed: 'Could not save: {error}',
  webSearch: 'Web search',
  searxng: 'SearXNG address',
  searxngHint:
    'The web search tool sends queries to this SearXNG instance. Leave it empty to turn web ' +
    'search off. Saved when you leave the field.',
  needUrl: 'Enter an http:// or https:// address.',
  isOn: 'Web search is on.',
  isOff: 'Web search is off.',
});
const S = TOOLS_TEXT;

export function ToolsPage() {
  const { api } = useServices();
  const access = useMemberAccess();
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
      (err: unknown) => alive && setError(errorMessage(err, S.loadServersFailed)),
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
      <h2>{S.title}</h2>
      <MemberNote access={access}>{MEMBER_MODE_TEXT.tools}</MemberNote>
      <McpServersSection
        access={access}
        servers={servers}
        error={error}
        onRetry={() => setVersion((v) => v + 1)}
        onSaved={replace}
        onRemoved={removed}
      />
      <ToolsSection servers={servers ?? []} version={toolsVersion} />
      {access.hubSettings ? (
        <WebSearchSection />
      ) : (
        <OwnerSets heading={MEMBER_MODE_TEXT.webSearchHeading}>
          {MEMBER_MODE_TEXT.webSearch}
        </OwnerSets>
      )}
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
  access,
  servers,
  error,
  onRetry,
  onSaved,
  onRemoved,
}: {
  access: MemberAccess;
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
      toast.show(S.removed({ name: s.name }), { tone: 'success' });
    } catch (err) {
      toast.show(S.removeFailed({ name: s.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="tools-mcp">
      <h3 id="tools-mcp">{S.servers}</h3>
      <p className="muted">{S.serversHint}</p>
      <div className="row">
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {S.addServer}
        </Button>
        {access.may('POST', '/api/v1/mcp/bundles/install') ? (
          <BundleInstallButton
            onInstalled={(s) => {
              onSaved(s);
              toast.show(S.bundleInstalled({ name: s.name }), { tone: 'success' });
            }}
          />
        ) : null}
      </div>
      {access.privateAddresses ? null : (
        <p className="muted ws-flush">{MEMBER_MODE_TEXT.toolsAddresses}</p>
      )}
      <p className="muted">
        {embed(S.hooksIn, {
          link: (
            <a
              href="/settings/plugins"
              onClick={(e) => {
                e.preventDefault();
                navigate('/settings/plugins');
              }}
            >
              {S.pluginsLink}
            </a>
          ),
        })}
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>{S.retry}</Button>
        </div>
      ) : null}
      {servers === null && !error ? <Spinner label={S.loadingServers} /> : null}
      {servers?.length === 0 ? (
        <EmptyState level={3} title={S.noServers} description={S.noServersHint} />
      ) : null}
      {servers?.length ? (
        <ul className="ws-list" aria-label={S.servers}>
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
        title={S.addTitle}
        description={S.addBody}
        onClose={() => setAdding(false)}
      >
        <McpServerForm
          allowStdio={access.stdioMcpServers}
          transportHint={access.stdioMcpServers ? undefined : MEMBER_MODE_TEXT.stdioOwner}
          onCancel={() => setAdding(false)}
          onSaved={(s) => {
            setAdding(false);
            onSaved(s);
            toast.show(S.added({ name: s.name }), { tone: 'success' });
          }}
        />
      </Dialog>
      <Dialog
        open={editing !== null}
        title={editing ? S.editName({ name: editing.name }) : S.editServer}
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <McpServerForm
            server={editing}
            allowStdio={access.stdioMcpServers}
            transportHint={access.stdioMcpServers ? undefined : MEMBER_MODE_TEXT.stdioOwner}
            onCancel={() => setEditing(null)}
            onSaved={(s) => {
              setEditing(null);
              onSaved(s);
              toast.show(S.saved({ name: s.name }), { tone: 'success' });
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={removing !== null}
        title={removing ? S.removeTitle({ name: removing.name }) : S.removeThis}
        description={S.removeBody}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {S.remove}
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

  const act = async (
    fn: () => Promise<McpServerView>,
    done: string,
    failed: (error: string) => string,
  ) => {
    setBusy(true);
    try {
      onSaved(await fn());
      toast.show(done, { tone: 'success' });
    } catch (err) {
      toast.show(failed(errorMessage(err)), { tone: 'error' });
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
            {s.transport === 'stdio' ? S.command : s.transport.toUpperCase()}
          </span>
          {s.bundle ? (
            <>
              <VerifiedBadge verified={s.bundle.signature === 'verified'} />
              <span className="muted">
                {S.bundle({ name: s.bundle.name, version: s.bundle.version })}
              </span>
            </>
          ) : null}
        </span>
        {s.pluginId ? (
          <span className="muted ws-row-meta">
            <span>
              {embed(S.fromPlugin, {
                id: s.pluginId,
                link: (
                  <a
                    href="/settings/plugins"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('/settings/plugins');
                    }}
                  >
                    {S.plugins}
                  </a>
                ),
              })}
            </span>
          </span>
        ) : null}
        {target ? (
          <code className="ws-code-inline" dir="ltr">
            {target}
          </code>
        ) : null}
        {secretNames.length ? (
          <span className="muted ws-row-meta">
            {s.transport === 'stdio' ? S.environment : S.headers}
            {secretNames.map((k) => (
              <code key={k} className="ws-code-inline" dir="ltr">
                {k}{' '}
                <span role="img" aria-label={S.valueHidden}>
                  ••••••
                </span>
              </code>
            ))}
          </span>
        ) : null}
        <span className="muted ws-row-meta">
          {S.counts({
            tools: s.counts.tools,
            resources: s.counts.resources,
            prompts: s.counts.prompts,
          })}
          {s.serverInfo ? ` · ${s.serverInfo.name} ${s.serverInfo.version}` : ''}
          {s.status === 'connected' && s.connectedAt
            ? ` · ${S.connectedAt({ when: formatWhen(s.connectedAt) })}`
            : ''}
          {s.restarts ? ` · ${S.restarts({ n: s.restarts })}` : ''}
        </span>
        <McpAuthControls server={s} onSaved={onSaved} />
        {s.lastError ? (
          <p className="ws-warning ws-mcp-error">
            <Icon name="alert" /> <span>{S.lastError({ error: s.lastError })}</span>
          </p>
        ) : null}
      </div>
      <div className="row ws-row-actions">
        <Switch
          label={S.enable({ name: s.name })}
          checked={s.enabled}
          disabled={busy || !!s.pluginId}
          onChange={(v) =>
            void act(
              () => api.updateMcpServer(s.id, { enabled: v }),
              v ? S.turnedOn({ name: s.name }) : S.turnedOff({ name: s.name }),
              (error) => S.changeFailed({ name: s.name, error }),
            )
          }
        />
        <Button
          variant="ghost"
          disabled={busy || !s.enabled}
          onClick={() =>
            void act(
              () => api.restartMcpServer(s.id),
              S.restarting({ name: s.name }),
              (error) => S.restartFailed({ name: s.name, error }),
            )
          }
        >
          {S.restart}
        </Button>
        <Button
          variant="ghost"
          aria-expanded={showLogs}
          aria-controls={showLogs ? logsId : undefined}
          onClick={() => setShowLogs((v) => !v)}
        >
          {S.logs}
        </Button>
        <Button
          variant="ghost"
          aria-expanded={showTools}
          aria-controls={showTools ? toolsId : undefined}
          onClick={() => setShowTools((v) => !v)}
        >
          {S.tools}
        </Button>
        {s.pluginId ? null : (
          <>
            <Button variant="ghost" onClick={onEdit}>
              {S.edit}
            </Button>
            <Button variant="ghost" onClick={onRemove}>
              {S.remove}
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
      (err: unknown) => alive && setError(errorMessage(err, S.logsFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, server.id, version]);

  return (
    <section id={id} className="ws-subpanel" aria-label={S.logsFor({ name: server.name })}>
      <div className="row">
        <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
          <Icon name="refresh" /> {S.refresh}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {lines === null && !error ? <Spinner label={S.loadingLogs} /> : null}
      {lines?.length === 0 ? <p className="muted">{S.noLogs}</p> : null}
      {lines?.length ? (
        <pre className="ws-log" tabIndex={0} dir="ltr">
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
      (err: unknown) => alive && setError(errorMessage(err, S.toolsFailed)),
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
      toast.show(S.changeFailed({ name, error: errorMessage(err) }), { tone: 'error' });
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
      toast.show(S.changeFailed({ name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section id={id} className="ws-subpanel" aria-label={S.toolsFrom({ name: server.name })}>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {tools === null && !error ? <Spinner label={S.loadingTools} /> : null}
      {tools?.length === 0 ? <p className="muted">{S.noTools}</p> : null}
      {tools?.length ? (
        <p id={helpId} className="muted">
          {S.readsOnlyHelp}
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
                  <code className="ws-code-inline" dir="ltr">
                    {t.name}
                  </code>
                  {t.description ? (
                    <span className="muted" dir="auto">
                      {t.description}
                    </span>
                  ) : null}
                  <ToolBadges tool={t} />
                  {!allowListed ? (
                    <span className="muted ws-row-meta">{S.notAllowListed}</span>
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
                    <span>{S.readsOnly}</span>
                  </label>
                  <Switch
                    label={S.toggle({ name: t.name })}
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
    a.readOnly ? S.badge.readOnly : null,
    a.destructive ? S.badge.destructive : null,
    a.requiresNetwork ? S.badge.network : null,
    tool.deferred ? S.badge.deferred : null,
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
        ? S.mcpGroup({ server: names.get(t.serverId ?? '') ?? t.serverId ?? S.unknownServer })
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
      (err: unknown) => alive && setError(errorMessage(err, S.toolsFailed)),
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
      toast.show(S.defaultFailed({ name: t.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (tools ?? []).filter(
    (t) => !q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q),
  );
  const groups = groupTools(shown, servers);

  return (
    <section className="settings-section" aria-labelledby="tools-all">
      <h3 id="tools-all">{S.tools}</h3>
      <p className="muted">{S.toolsHint}</p>
      <TextField
        label={S.filter}
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {tools === null && !error ? <Spinner label={S.loadingTools} /> : null}
      {tools?.length && !shown.length ? (
        <p className="muted">{S.noMatch({ filter: filter.trim() })}</p>
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
          {t.title && t.title !== t.name ? (
            <code className="ws-code-inline" dir="ltr">
              {t.name}
            </code>
          ) : null}
        </span>
        {t.description ? (
          <span className="muted" dir="auto">
            {t.description}
          </span>
        ) : null}
        <span className="ws-row-meta">
          <EffectChip effect={t.effective.effect} />
          <span className="muted">{t.effective.reason}</span>
        </span>
        {t.effective.tier !== 'pre_approvable' ? (
          <span className="muted ws-row-meta">{TIER_TEXT[t.effective.tier]}</span>
        ) : null}
      </div>
      <SelectField
        label={S.defaultFor({ name: t.name })}
        hideLabel
        value={t.userDefault ?? ''}
        onChange={(v) => onDefault(v ? (v as 'allow' | 'ask' | 'deny') : null)}
        options={[
          { value: '', label: S.default },
          { value: 'ask', label: S.ask },
          { value: 'allow', label: S.allow },
          { value: 'deny', label: S.deny },
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
      () => toast.show(trimmed ? S.searchSaved : S.searchOff, { tone: 'success' }),
      (err: unknown) => toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
    );
  };

  return (
    <section className="settings-section" aria-labelledby="tools-search">
      <h3 id="tools-search">{S.webSearch}</h3>
      <TextField
        label={S.searxng}
        type="url"
        value={text}
        placeholder={SEARXNG_EXAMPLE}
        locked={url.locked}
        setting="search.searxngUrl"
        spellCheck={false}
        hint={S.searxngHint}
        error={invalid ? S.needUrl : undefined}
        onChange={(e) => setDraft({ base: saved, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {saved ? <p className="muted">{S.isOn}</p> : <p className="muted">{S.isOff}</p>}
    </section>
  );
}
