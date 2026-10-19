// MCP client servers: configuration, connections, health and their tools (FR-042, FR-043;
// docs/08 §2.1, §2.3). Secret values go to the vault and the database keeps only their
// `secret://mcp/<id>/env/<NAME>` references (FR-101). `env` carries a stdio server's environment
// and, for sse/http servers, its headers (`X_Api_Key` is sent as `X-Api-Key`; @nova/mcp). Servers
// connect in the background; a status change is stored and announced as
// `mcp.server.status.changed`.
//
// M4: servers installed from MCP bundles (FR-199; docs/08 §2.5) and OAuth for sse/http servers
// (FR-047): PKCE with a client metadata document the Hub serves at `/.well-known/nova-client.json`
// or dynamic registration, tokens in the vault, refreshed before expiry, revocable.
//
// M7 (FR-042): the server fields `deviceId` (a stdio server that runs on a device and is reached
// through `novad` by the name the device lists; the Hub never spawns it or sends the device a
// command line), `auth` (an API key or bearer token for an sse/http server, kept in the vault and
// sent as its Authorization header) and `oauth` (a client metadata document URL or dynamic
// registration, and the scopes to request).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  idSchema,
  installBundleSchema,
  mcpServerM7Schema,
  mcpServerPatchM7Schema,
  uuidv7,
  type BundleConfigField,
  type BundlePreview,
  type McpAuthView,
  type McpOAuthSettings,
  type McpServerM7View,
  type McpServerView,
  type McpStatus,
} from '@nova/shared';
import {
  isHubOwner,
  managedDenied,
  managedRestrictions,
  privateAddressError,
  publicFetch,
  publicUrlProblem,
  type AuditSink,
  type MarketInstaller,
} from '@nova/core';
import {
  McpManager,
  McpOAuthService,
  McpToolSource,
  bundleLaunch,
  bundleServerName,
  bundleSignature,
  clientMetadataDocument,
  compatibilityProblems,
  extractBundle,
  manifestWarnings,
  readBundle,
  resolveUserConfig,
  whichOnPath,
  type BundleManifest,
  type DeviceMcpBridge,
  type DeviceMcpTool,
  type LaunchEnvironment,
  type McpServerConfig,
  type McpServerState,
  type OAuthRecord,
  type TrustedPublisher,
} from '@nova/mcp';
import { secretRef } from '@nova/secrets';
import { schema } from '@nova/storage';
import { isHubUrl } from './appauth.ts';
import type { HubContext, McpArea } from './hub-context.ts';
import { mcpMarketInstaller } from './mcp-market.ts';

const { mcpServer, mcpOauth } = schema;
type Row = typeof mcpServer.$inferSelect;
/** A row of `mcp_server` (the marketplace installer reads it). */
export type McpServerRow = Row;
type OAuthRow = typeof mcpOauth.$inferSelect;
type Approval = 'allow' | 'ask' | 'deny';

/** Defaults from contracts/schemas/mcp-config.json. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Bundle uploads (FR-199): the archive as base64, at most 50 MB decoded. */
const BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
const BUNDLE_PREVIEW_TTL_MS = 30 * 60_000;
/**
 * Publisher keys whose bundle signatures Nova accepts. Empty until a publisher program exists, so
 * every bundle installs as unverified, after an explicit sideload confirmation (docs/08 §2.5).
 */
export const TRUSTED_BUNDLE_PUBLISHERS: readonly TrustedPublisher[] = [];

export const OAUTH_CALLBACK_PATH = '/api/v1/mcp/oauth/callback';
export const CLIENT_METADATA_PATH = '/.well-known/nova-client.json';

export interface HubMcpArea extends McpArea {
  manager: McpManager;
  /** A server's default approval for its tools (FR-048), or null for the engine's default. */
  serverDefault(serverId: string): Approval | null;
  /** Called when a server's tool list, or what its lists expose, changes (FR-196 index). */
  onToolsChanged(listener: (serverId: string) => void): () => void;
  /**
   * Called before a server is removed, while it is still connected (its event subscriptions are
   * cancelled, FR-201). A hook that fails is logged; the removal goes on.
   */
  onServerRemoving(hook: (accountId: string, serverId: string) => Promise<unknown>): void;
  /** How device-hosted servers are reached (FR-042, FR-210); they connect once it is wired. */
  useDeviceBridge(bridge: DeviceMcpBridge): void;
  /**
   * MCP registry entries and `.mcpb` bundles for the marketplace (FR-049, kind `mcp`):
   * `market.useMcpInstaller(mcp.marketInstaller)` in app.ts.
   */
  marketInstaller: MarketInstaller;
}

/** What `config_json` holds (the mcp-config.json fields without their own column). */
interface StoredConfig {
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: string[] | null;
  disabledTools: string[];
  /**
   * Tools the owner declared read-only (FR-082, FR-189): their descriptors get `userReadOnly`.
   * Only the owner sets it, here; a plugin's server never has one (its manifest is not the owner).
   */
  readOnlyTools: string[];
  defaultApproval: Approval | null;
  /** Grants confirmed for a bundle (mcp-config.json `policy`). */
  policy?: { network: string[]; fs: 'none' | 'read' | 'project' };
  /** The vault reference of an sse/http server's Authorization header value (FR-042 `auth`). */
  auth?: string;
  /** OAuth settings (FR-047): metadata document or dynamic registration, and scopes. */
  oauth?: McpOAuthSettings;
}

const params = z.object({ id: idSchema });
const patchBody = mcpServerPatchM7Schema;
const bundleUpload = z.object({
  name: z.string().min(1).max(255),
  // Base64 of at most 50 MB (4/3 of it), whitespace allowed.
  data: z
    .string()
    .min(1)
    .max(Math.ceil((BUNDLE_MAX_BYTES * 4) / 3) + 1024),
});
const callbackQuery = z.object({
  state: z.string().min(1).max(200),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
  iss: z.string().max(2000).optional(),
});

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A tool list without repeats, in the order given. */
function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function storedConfig(row: Row): StoredConfig {
  const c = parseJson<Partial<StoredConfig>>(row.configJson, {});
  const readOnly = Array.isArray(c.readOnlyTools) ? c.readOnlyTools : [];
  const out: StoredConfig = {
    startupTimeoutMs: c.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    toolTimeoutMs: c.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    enabledTools: c.enabledTools ?? null,
    disabledTools: c.disabledTools ?? [],
    readOnlyTools:
      row.source === 'plugin' ? [] : readOnly.filter((t): t is string => typeof t === 'string'),
    defaultApproval: c.defaultApproval ?? null,
  };
  if (c.policy) out.policy = c.policy;
  if (typeof c.auth === 'string' && c.auth.startsWith('secret://')) out.auth = c.auth;
  if (c.oauth && typeof c.oauth === 'object') out.oauth = c.oauth;
  return out;
}

function toConfig(row: Row): McpServerConfig {
  const c = storedConfig(row);
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: parseJson<string[]>(row.argsJson, []),
    url: row.url,
    env: parseJson<Record<string, string>>(row.envRefJson, {}),
    headers: c.auth && row.transport !== 'stdio' ? { Authorization: c.auth } : {},
    deviceId: row.transport === 'stdio' ? row.deviceId : null,
    enabled: row.enabled,
    startupTimeoutMs: c.startupTimeoutMs,
    toolTimeoutMs: c.toolTimeoutMs,
    enabledTools: c.enabledTools,
    disabledTools: c.disabledTools,
    readOnlyTools: c.readOnlyTools,
  };
}

const STATUSES: readonly McpStatus[] = ['disabled', 'starting', 'connected', 'error', 'stopped'];

function bundleOf(row: Row): McpServerView['bundle'] {
  if (row.source !== 'bundle' || !row.bundleManifestJson) return null;
  const m = parseJson<{ name?: unknown; version?: unknown }>(row.bundleManifestJson, {});
  return {
    name: typeof m.name === 'string' ? m.name : row.name,
    version: typeof m.version === 'string' ? m.version : '',
    signature: row.signatureStatus ?? 'unverified',
  };
}

/** A plugin's server follows its manifest; it changes only through the plugin (FR-045). */
function refusePluginOwned(row: Row): void {
  if (row.source === 'plugin')
    throw new NovaError(
      'conflict',
      `this server belongs to the plugin ${row.pluginId ?? ''}; change or remove it in Settings → Plugins`,
      { details: { reason: 'plugin_owned', pluginId: row.pluginId } },
    );
}

function toView(
  row: Row,
  state: McpServerState | null,
  auth?: McpAuthView,
): McpServerView & McpServerM7View {
  const c = storedConfig(row);
  const stored = STATUSES.find((s) => s === row.lastStatus) ?? 'stopped';
  const view: McpServerView & McpServerM7View = {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    // Arguments that are vault references (a bundle's sensitive setting) are never shown.
    args: parseJson<string[]>(row.argsJson, []).map((a) =>
      a.startsWith('secret://') ? '[secret]' : a,
    ),
    url: row.url,
    envKeys: Object.keys(parseJson<Record<string, string>>(row.envRefJson, {})).sort(),
    enabled: row.enabled,
    status: row.enabled ? (state?.status ?? stored) : 'disabled',
    lastError: row.enabled ? (state ? state.lastError : row.lastError) : null,
    protocolVersion: state?.protocolVersion ?? null,
    serverInfo: state?.serverInfo ?? null,
    counts: state?.counts ?? { tools: 0, resources: 0, prompts: 0 },
    toolTimeoutMs: c.toolTimeoutMs,
    startupTimeoutMs: c.startupTimeoutMs,
    defaultApproval: c.defaultApproval,
    enabledTools: c.enabledTools,
    disabledTools: c.disabledTools,
    readOnlyTools: c.readOnlyTools,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    connectedAt: row.enabled ? (state?.connectedAt ?? null) : null,
    restarts: state?.restarts ?? 0,
    bundle: bundleOf(row),
    pluginId: row.source === 'plugin' ? row.pluginId : null,
    deviceId: row.deviceId,
    hasAuth: !!c.auth,
    oauthSettings: c.oauth ?? null,
  };
  if (auth) view.auth = auth;
  return view;
}

/**
 * How a remote server authenticates, for settings (FR-047): its OAuth state when it has one, an
 * API key when it has header values, and `needs_auth` when the server refused an unauthenticated
 * connection.
 */
function authOf(
  row: Row,
  state: McpServerState | null,
  oauth: McpAuthView | null,
): McpAuthView | undefined {
  if (row.transport === 'stdio') return undefined;
  if (oauth) return oauth;
  const status = row.enabled ? (state?.status ?? row.lastStatus) : 'disabled';
  const error = (row.enabled ? (state ? state.lastError : row.lastError) : null) ?? '';
  const failed = status === 'error';
  const keys = Object.keys(parseJson<Record<string, string>>(row.envRefJson, {}));
  if (keys.length || storedConfig(row).auth)
    return { kind: 'api_key', status: failed ? 'error' : 'connected', expiresAt: null, scopes: [] };
  if (failed && /\b401\b|unauthori[sz]ed/i.test(error))
    return { kind: 'oauth', status: 'needs_auth', expiresAt: null, scopes: [] };
  return { kind: 'none', status: failed ? 'error' : 'connected', expiresAt: null, scopes: [] };
}

function oauthRow(r: OAuthRecord): OAuthRow {
  return {
    serverId: r.serverId,
    accountId: r.accountId,
    issuer: r.issuer,
    metadataJson: JSON.stringify(r.metadata),
    resource: r.resource,
    clientId: r.clientId,
    clientSecretRef: r.clientSecretRef,
    registration: r.registration,
    scopesJson: JSON.stringify(r.scopes),
    accessTokenRef: r.accessTokenRef,
    refreshTokenRef: r.refreshTokenRef,
    status: r.status,
    expiresAt: r.expiresAt,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function oauthRecord(r: OAuthRow): OAuthRecord {
  return {
    serverId: r.serverId,
    accountId: r.accountId,
    issuer: r.issuer,
    metadata: parseJson<OAuthRecord['metadata']>(r.metadataJson, {} as OAuthRecord['metadata']),
    resource: r.resource,
    clientId: r.clientId,
    clientSecretRef: r.clientSecretRef,
    registration: r.registration,
    scopes: parseJson<string[]>(r.scopesJson, []),
    accessTokenRef: r.accessTokenRef,
    refreshTokenRef: r.refreshTokenRef,
    status: r.status,
    expiresAt: r.expiresAt,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The devices area's MCP pass-through (`DeviceService.mcpList` and `mcpCall`). */
export interface DeviceMcpService {
  mcpList(
    accountId: string,
    deviceId: string,
    grantee: { kind: 'user'; id: string },
  ): Promise<{ servers: unknown[] }>;
  mcpCall(
    accountId: string,
    deviceId: string,
    grantee: { kind: 'user'; id: string },
    call: { server: string; tool: string; arguments: Record<string, unknown> },
  ): Promise<{ content: unknown[]; isError: boolean }>;
  /** Resources and prompts of the same servers (M8; `/agent/v1/mcp/request`). */
  mcpRequest?(
    accountId: string,
    deviceId: string,
    grantee: { kind: 'user'; id: string },
    req: { server: string; method: string; params: Record<string, unknown> },
  ): Promise<unknown>;
}

/**
 * How Hub MCP servers with a `deviceId` reach the device (FR-042, FR-210): through novad's local
 * MCP pass-through (`/agent/v1/mcp/list` answers `{servers: [{name, tools: [{name, description,
 * inputSchema}], error?}]}`, `/agent/v1/mcp/call` answers `{content, isError, untrusted}`), as
 * the account's user, which the device owner grants `mcp` for the server. The device service
 * refuses a device that is not active (pending, unreachable, revoked); a server the device lists
 * with an error, or does not list (not declared, not granted), fails the listing.
 */
export function deviceBridgeFrom(svc: DeviceMcpService): DeviceMcpBridge {
  const grantee = (accountId: string) => ({ kind: 'user' as const, id: accountId });
  return {
    list: async ({ accountId, deviceId, server }) => {
      const { servers } = await svc.mcpList(accountId, deviceId, grantee(accountId));
      const entry = servers.find(
        (s): s is { name: string; tools?: unknown; error?: unknown } =>
          !!s && typeof s === 'object' && (s as { name?: unknown }).name === server,
      );
      if (!entry)
        throw new NovaError('not_found', `the device lists no MCP server named ${server} for you`);
      if (entry.error) {
        const e = entry.error as { message?: unknown };
        throw new NovaError(
          'node_unavailable',
          `the device's MCP server ${server} failed: ${typeof e.message === 'string' ? e.message : 'unknown error'}`,
        );
      }
      return Array.isArray(entry.tools) ? (entry.tools as DeviceMcpTool[]) : [];
    },
    call: async ({ accountId, deviceId, server }, call) => {
      const r = await svc.mcpCall(accountId, deviceId, grantee(accountId), {
        server,
        tool: call.tool,
        arguments: call.arguments,
      });
      return { content: Array.isArray(r.content) ? r.content : [], isError: r.isError === true };
    },
    // Resources and prompts (M8): the same grant; the device's answer is untrusted content.
    ...(svc.mcpRequest
      ? {
          request: (({ accountId, deviceId, server }, req) =>
            svc.mcpRequest!(accountId, deviceId, grantee(accountId), {
              server,
              method: req.method,
              params: req.params,
            })) satisfies DeviceMcpBridge['request'],
        }
      : {}),
  };
}

/** The Hub's own URL as this request reached it (Host is checked by the Hub's guard, FR-192). */
export function hubBaseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host ?? '127.0.0.1'}`;
}

/** Refuse arguments that look like vault references: a session may not point a process at one. */
function assertPlainArgs(args: readonly string[] | undefined): void {
  for (const [i, a] of (args ?? []).entries()) {
    if (a.startsWith('secret://'))
      throw new NovaError(
        'validation',
        `argument ${i + 1}: enter the value, not a secret reference`,
        {
          details: { field: `args.${i}` },
        },
      );
  }
}

interface BundlePreviewEntry {
  accountId: string;
  file: string;
  expiresAt: number;
}

export async function setupMcp(ctx: HubContext & { audit: AuditSink }): Promise<HubMcpArea> {
  const { db, secrets, events, audit, accountOf } = ctx;
  const log = ctx.log.child('mcp');
  // A non-owner's remote servers and their OAuth reach checked public addresses only, pinned:
  // never the Hub's loopback services or the owner's network (decision 5).
  const pinnedFetch = publicFetch();
  const fetchForAccount = (accountId: string) =>
    isHubOwner(db, accountId) ? undefined : pinnedFetch;
  const assertPublicUrl = async (accountId: string, transport: string, url?: string | null) => {
    if (transport === 'stdio' || !url || isHubOwner(db, accountId)) return;
    const problem = await publicUrlProblem(url);
    if (problem) throw privateAddressError('the server URL', problem);
  };
  const listeners = new Set<(serverId: string) => void>();
  const removing: ((accountId: string, serverId: string) => Promise<unknown>)[] = [];
  const defaults = new Map<string, Approval | null>();
  // Status writes and events go out in order, one at a time.
  let statusChain: Promise<void> = Promise.resolve();
  const bundleRoot = join(ctx.dataDir, 'mcp', 'bundles');
  const previewDir = join(ctx.dataDir, 'mcp', 'previews');
  const previews = new Map<string, BundlePreviewEntry>();
  const launchEnv: LaunchEnvironment = {
    platform: process.platform,
    home: homedir(),
    nodePath: process.execPath,
    which: (p) => whichOnPath(p),
  };

  const oauth = new McpOAuthService({
    vault: secrets,
    store: {
      save: (r) =>
        db.transaction(async () => {
          const { serverId: _key, ...set } = oauthRow(r);
          await db.orm
            .insert(mcpOauth)
            .values(oauthRow(r))
            .onConflictDoUpdate({ target: mcpOauth.serverId, set });
        }),
      remove: (serverId) =>
        db.transaction(async () => {
          await db.orm.delete(mcpOauth).where(eq(mcpOauth.serverId, serverId));
        }),
    },
    records: (await db.orm.select().from(mcpOauth)).map(oauthRecord),
    fetchFor: fetchForAccount,
    log: log.child('oauth'),
    // New or revoked tokens take effect on a fresh connection.
    onChange: (serverId) => {
      const cfg = manager.config(serverId);
      if (cfg?.enabled) update(cfg, { restart: true });
    },
  });

  const manager = new McpManager({
    resolveSecret: (ref) => secrets.get(ref),
    log,
    workDir: join(ctx.dataDir, 'mcp'),
    clientVersion: ctx.config.version,
    authFor: (cfg) => oauth.provider(cfg.id),
    fetchFor: (cfg) => fetchForAccount(cfg.accountId) ?? null,
    onStatus: (s) => {
      statusChain = statusChain
        .then(() => persistStatus(s))
        .catch((err: unknown) => {
          log.warn('mcp status not recorded', { serverId: s.id, err });
        });
    },
    onToolsChanged: (id) => {
      for (const l of listeners) {
        try {
          l(id);
        } catch (err) {
          log.warn('tool change listener failed', { err });
        }
      }
    },
  });

  const view = (row: Row): McpServerView & McpServerM7View => {
    const state = manager.state(row.id);
    return toView(row, state, authOf(row, state, oauth.view(row.id)));
  };

  async function persistStatus(s: McpServerState): Promise<void> {
    await db.transaction(() =>
      db.orm
        .update(mcpServer)
        .set({ lastStatus: s.status, lastError: s.lastError })
        .where(eq(mcpServer.id, s.id)),
    );
    await events.emit({
      name: 'mcp.server.status.changed',
      actor: 'system',
      accountId: s.accountId,
      payload: {
        serverId: s.id,
        name: s.name,
        status: s.status,
        ...(s.status === 'error' && s.lastError ? { error: s.lastError } : {}),
      },
    });
  }

  async function load(accountId: string, id: string): Promise<Row> {
    const [row] = await db.orm
      .select()
      .from(mcpServer)
      .where(and(eq(mcpServer.id, id), eq(mcpServer.accountId, accountId)));
    if (!row) throw new NovaError('not_found', 'MCP server not found');
    return row;
  }

  async function byName(accountId: string, name: string): Promise<Row | null> {
    const [row] = await db.orm
      .select()
      .from(mcpServer)
      .where(and(eq(mcpServer.accountId, accountId), eq(mcpServer.name, name)));
    return row ?? null;
  }

  async function assertNameFree(accountId: string, name: string, except?: string): Promise<void> {
    const row = await byName(accountId, name);
    if (row && row.id !== except)
      throw new NovaError('conflict', `an MCP server named ${name} already exists`);
  }

  /**
   * Store a server's environment. `incoming` is the complete set of names: a non-empty value goes
   * to the vault under `secret://mcp/<id>/env/<NAME>`, an empty string keeps the saved value (or
   * saves an empty one for a new name), and a saved name left out is deleted with its secret. A
   * reference to any other secret is refused: it would let a session hand an arbitrary vault
   * secret to a process.
   */
  async function storeEnv(
    id: string,
    current: Record<string, string>,
    incoming: Record<string, string>,
  ): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(incoming)) {
      if (value.startsWith('secret://')) {
        throw new NovaError('validation', `env ${key}: enter the value, not a secret reference`, {
          details: { field: `env.${key}` },
        });
      }
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      // An empty value keeps a saved one, including a bundle's plain (non-sensitive) value.
      const saved = current[key];
      if (value === '' && saved !== undefined && !saved.startsWith('secret://')) {
        next[key] = saved;
        continue;
      }
      const own = secretRef('mcp', id, 'env', key);
      if (value !== '' || current[key] !== own) await secrets.put(own, value);
      next[key] = own;
    }
    for (const [key, ref] of Object.entries(current)) {
      if (!(key in incoming) && ref === secretRef('mcp', id, 'env', key)) await secrets.delete(ref);
    }
    return next;
  }

  async function deleteSecrets(id: string, kinds?: string[]): Promise<void> {
    for (const ref of await secrets.list(`secret://mcp/${id}/`)) {
      const kind = ref.slice(`secret://mcp/${id}/`.length).split('/')[0] ?? '';
      if (!kinds || kinds.includes(kind)) await secrets.delete(ref);
    }
  }

  /** A device the server would run on must be one of the account's devices (FR-042). */
  function assertDevice(accountId: string, deviceId: string | null | undefined): void {
    if (!deviceId) return;
    // An approved device only: one still waiting for the Hub's approval (pending) is refused.
    const found = db.raw
      .prepare(
        "SELECT 1 FROM device WHERE id = ? AND account_id = ? AND status IN ('active', 'unreachable')",
      )
      .get(deviceId, accountId);
    if (!found)
      throw new NovaError('validation', 'device not found or not approved', {
        details: { field: 'deviceId' },
      });
  }

  /**
   * Store an sse/http server's API key or bearer token (FR-042 `auth`) in the vault and return its
   * reference: a value without a scheme is sent as `Bearer <value>`; '' keeps the saved one; null
   * removes it. A reference to another secret is refused, like env values.
   */
  async function storeAuth(
    id: string,
    current: string | undefined,
    incoming: string | null | undefined,
  ): Promise<string | undefined> {
    const own = secretRef('mcp', id, 'auth', 'header');
    if (incoming === undefined || (incoming === '' && current)) return current;
    if (incoming === null || incoming === '') {
      if (current) await secrets.delete(current);
      return undefined;
    }
    if (incoming.startsWith('secret://'))
      throw new NovaError('validation', 'auth: enter the value, not a secret reference', {
        details: { field: 'auth' },
      });
    const value = /^(Bearer|Basic|Token)\s/i.test(incoming) ? incoming : `Bearer ${incoming}`;
    await secrets.put(own, value);
    return own;
  }

  async function record(
    accountId: string,
    action: string,
    row: Row,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await audit.append({
      accountId,
      actor: 'user',
      kind: 'mcp',
      action,
      resource: `mcp_server:${row.id}`,
      detail: { name: row.name, transport: row.transport, ...detail },
    });
  }

  /** The checks of managed policy (FR-106); an area set up without settings has none. */
  const managed = async () =>
    managedRestrictions(
      typeof ctx.setting === 'function' ? await ctx.setting('managed.restrict') : undefined,
    );

  /** Why managed policy refuses this server (by name, origin, transport or plugin), or null. */
  async function managedRefusal(
    row: Pick<Row, 'name' | 'source' | 'transport' | 'deviceId' | 'pluginId'>,
  ): Promise<string | null> {
    const m = await managed();
    return (
      (row.pluginId ? m.plugin(row.pluginId) : null) ??
      m.mcpServer({
        name: row.name,
        source: row.source,
        transport: row.transport,
        deviceId: row.deviceId,
      })
    );
  }

  /** Apply a configuration the manager already runs (a reconnect). */
  function update(config: McpServerConfig, opts: { restart?: boolean } = {}): void {
    manager.update(config, opts).catch((err: unknown) => {
      log.warn('mcp server update failed', { serverId: config.id, err });
    });
  }

  /** (Re)connect a server; one managed policy refuses is never started and stops if it runs. */
  function start(row: Row, opts: { restart?: boolean } = {}): void {
    void (async () => {
      const config = toConfig(row);
      const refused = await managedRefusal(row);
      await manager.update(refused ? { ...config, enabled: false } : config, opts);
    })().catch((err: unknown) => {
      log.warn('mcp server update failed', { serverId: row.id, err });
    });
  }

  /** Every server again: a policy change may stop some and allow others. */
  async function reapplyAll(): Promise<void> {
    for (const row of await db.orm.select().from(mcpServer)) start(row);
  }
  const offManaged = ctx.events.bus.subscribe('managed.policy.changed', () => {
    reapplyAll().catch((err: unknown) => log.warn('mcp servers not re-checked', { err }));
  });

  // ---- bundles (FR-199) ---------------------------------------------------------------------

  function sweepPreviews(): void {
    const now = Date.now();
    for (const [id, p] of previews) {
      if (p.expiresAt > now) continue;
      previews.delete(id);
      rmSync(p.file, { force: true });
    }
  }

  function previewOf(
    previewId: string,
    manifest: BundleManifest,
    signature: 'verified' | 'unverified',
    signed: boolean,
    existing: Row | null,
  ): BundlePreview {
    const fields: BundleConfigField[] = Object.entries(manifest.userConfig).map(([key, e]) => ({
      key,
      type: e.type,
      title: e.title,
      description: e.description ?? null,
      required: e.required,
      sensitive: e.sensitive,
      multiple: e.multiple,
      default: e.default ?? null,
    }));
    const warnings = [...compatibilityProblems(manifest, launchEnv), ...manifestWarnings(manifest)];
    if (signature === 'unverified')
      warnings.push(
        signed
          ? 'the bundle is signed, but not by a publisher Nova trusts; installing it needs your confirmation'
          : 'the bundle is not signed; installing it needs your confirmation',
      );
    const name = bundleServerName(manifest.name);
    if (existing) {
      const b = bundleOf(existing);
      warnings.push(
        b && b.name === manifest.name
          ? `installing replaces version ${b.version} of ${name}; the previous version is kept`
          : `an MCP server named ${name} already exists; remove or rename it first`,
      );
    }
    return {
      previewId,
      name: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      serverType: manifest.server.type,
      signature,
      // Nothing beyond what the user enters: no network, and only the paths in folder and file
      // fields, read-only unless the user widens it (docs/08 §2.5).
      permissions: {
        network: [],
        fs: fields.some((f) => f.type === 'directory' || f.type === 'file') ? 'read' : 'none',
      },
      userConfig: fields,
      tools: manifest.tools,
      warnings,
    };
  }

  // Connect every enabled server in the background; Hub startup never waits on them.
  for (const row of await db.orm.select().from(mcpServer).orderBy(asc(mcpServer.createdAt))) {
    // A plugin server's `defaultApproval` is the plugin's, not the user's: the gate reads it
    // through the plugin's permissions, below its per-tool and per-action defaults.
    if (row.source !== 'plugin') defaults.set(row.id, storedConfig(row).defaultApproval);
    start(row);
  }
  // Previews do not survive a restart.
  rmSync(previewDir, { recursive: true, force: true });

  ctx.diagnostics.add('mcp', () =>
    Promise.resolve(
      manager
        .states()
        .map((s) => ({ id: s.id, name: s.name, status: s.status, lastError: s.lastError })),
    ),
  );

  /** Add a server for the account: the add-server route, and registry entries (marketplace). */
  async function createServer(
    accountId: string,
    body: z.infer<typeof mcpServerM7Schema>,
  ): Promise<Row> {
    assertPlainArgs(body.args);
    const refused = await managedRefusal({
      name: body.name,
      source: 'user',
      transport: body.transport,
      deviceId: body.deviceId ?? null,
      pluginId: null,
    });
    if (refused) throw managedDenied(refused, { server: body.name });
    assertDevice(accountId, body.deviceId);
    await assertPublicUrl(accountId, body.transport, body.url);
    await assertNameFree(accountId, body.name);
    const id = uuidv7();
    const now = new Date().toISOString();
    let row: Row;
    try {
      const env = await storeEnv(id, {}, body.env ?? {});
      const authRef = await storeAuth(id, undefined, body.auth);
      const config: StoredConfig = {
        startupTimeoutMs: body.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        toolTimeoutMs: body.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        enabledTools: body.enabledTools ?? null,
        disabledTools: body.disabledTools ?? [],
        readOnlyTools: unique(body.readOnlyTools ?? []),
        defaultApproval: body.defaultApproval ?? null,
        ...(authRef ? { auth: authRef } : {}),
        ...(body.oauth ? { oauth: body.oauth } : {}),
      };
      const values: Row = {
        id,
        accountId,
        name: body.name,
        transport: body.transport,
        command: body.transport === 'stdio' ? (body.command ?? null) : null,
        argsJson: JSON.stringify(body.args ?? []),
        url: body.transport === 'stdio' ? null : (body.url ?? null),
        envRefJson: JSON.stringify(env),
        configJson: JSON.stringify(config),
        source: 'user',
        pluginId: null,
        deviceId: body.transport === 'stdio' ? (body.deviceId ?? null) : null,
        bundleManifestJson: null,
        signatureStatus: null,
        bundleSha256: null,
        installRecordJson: null,
        enabled: body.enabled ?? true,
        lastStatus: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      await db.transaction(() => db.orm.insert(mcpServer).values(values));
      row = values;
    } catch (err) {
      await deleteSecrets(id);
      if (err instanceof Error && /UNIQUE/i.test(err.message))
        throw new NovaError('conflict', `an MCP server named ${body.name} already exists`);
      throw err;
    }
    const added = storedConfig(row);
    defaults.set(id, added.defaultApproval);
    await record(accountId, 'add', row, {
      envKeys: Object.keys(body.env ?? {}).sort(),
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(added.auth ? { auth: true } : {}),
      ...(added.oauth ? { oauth: added.oauth } : {}),
      // Declaring tools read-only loosens what agents may do without asking: on the record.
      ...(added.readOnlyTools.length ? { readOnlyTools: added.readOnlyTools } : {}),
    });
    start(row);
    return row;
  }

  /** Remove a server with its secrets, work folder and bundle files (route and marketplace). */
  async function removeServer(accountId: string, row: Row): Promise<void> {
    for (const hook of removing)
      await hook(accountId, row.id).catch((err: unknown) =>
        log.warn('server removal hook failed', { err, serverId: row.id }),
      );
    await manager.remove(row.id);
    await oauth.forget(row.id);
    await db.transaction(() => db.orm.delete(mcpServer).where(eq(mcpServer.id, row.id)));
    await deleteSecrets(row.id);
    rmSync(join(ctx.dataDir, 'mcp', row.id), { recursive: true, force: true });
    // A bundle's files go with it, every kept version included.
    if (row.source === 'bundle')
      rmSync(join(bundleRoot, row.name), { recursive: true, force: true });
    defaults.delete(row.id);
    await record(accountId, 'remove', row);
  }

  /**
   * Install or update a bundle from its bytes (FR-199): the bundle route after its preview, and
   * `.mcpb` items of the marketplace with the verdict it reached (`signature`, `source`).
   */
  async function installBundle(
    accountId: string,
    input: {
      bytes: Uint8Array;
      userConfig: Record<string, unknown> | undefined;
      permissions: { network: string[]; fs: 'none' | 'read' | 'project' };
      confirmSideload: boolean;
      signature?: 'verified' | 'unverified';
      source?: 'file' | 'catalog';
      origin?: string;
      enabled?: boolean;
    },
  ): Promise<Row> {
    const read = readBundle(Buffer.from(input.bytes));
    const { manifest } = read;
    // The marketplace decided the verdict itself (its catalog and checksum, ADR-097 D2).
    const signature = input.signature ?? bundleSignature(read, TRUSTED_BUNDLE_PUBLISHERS);
    if (signature === 'unverified' && input.confirmSideload !== true)
      throw new NovaError(
        'validation',
        'this bundle is not signed by a trusted publisher; confirm the sideload to install it',
        { details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' } },
      );
    const name = bundleServerName(manifest.name);
    // Managed policy (FR-106): unsigned bundles, and servers it does not allow.
    const m = await managed();
    const refused =
      (signature === 'unverified' ? m.unverifiedInstall('an unverified MCP bundle') : null) ??
      m.mcpServer({ name, source: 'bundle', transport: 'stdio', deviceId: null });
    if (refused) throw managedDenied(refused, { server: name });
    const values = resolveUserConfig(manifest, input.userConfig ?? {});
    const existing = await byName(accountId, name);
    if (existing && bundleOf(existing)?.name !== manifest.name)
      throw new NovaError(
        'conflict',
        `an MCP server named ${name} already exists; remove or rename it first`,
      );
    const id = existing?.id ?? uuidv7();
    const dir = join(bundleRoot, name, manifest.version);
    rmSync(dir, { recursive: true, force: true });
    let launch: ReturnType<typeof bundleLaunch>;
    try {
      extractBundle(read, dir);
      launch = bundleLaunch(manifest, dir, values, launchEnv);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    // Values that hold a sensitive setting go to the vault and are passed as references
    // resolved at launch (FR-101); other values are kept as written (vault values are redacted
    // everywhere, which a greeting or a folder must not be). An update replaces them all.
    if (existing) await deleteSecrets(id, ['env', 'arg', 'config']);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(launch.env)) {
      if (!launch.secretEnv.includes(k)) {
        env[k] = v;
        continue;
      }
      const ref = secretRef('mcp', id, 'env', k);
      await secrets.put(ref, v);
      env[k] = ref;
    }
    const args = [...launch.args];
    for (const i of launch.secretArgs) {
      const ref = secretRef('mcp', id, 'arg', String(i));
      await secrets.put(ref, args[i]!);
      args[i] = ref;
    }
    const userConfig: Record<string, unknown> = {};
    const secretRefs: string[] = [];
    const paths: { path: string; access: 'read' | 'write' }[] = [];
    for (const [k, v] of Object.entries(values)) {
      const entry = manifest.userConfig[k]!;
      if (entry.sensitive) {
        const ref = secretRef('mcp', id, 'config', k);
        await secrets.put(ref, Array.isArray(v) ? JSON.stringify(v) : String(v));
        userConfig[k] = ref;
        secretRefs.push(ref);
        continue;
      }
      userConfig[k] = v;
      if (
        (entry.type === 'directory' || entry.type === 'file') &&
        input.permissions.fs !== 'none'
      ) {
        for (const path of Array.isArray(v) ? v : [String(v)])
          paths.push({ path, access: input.permissions.fs === 'project' ? 'write' : 'read' });
      }
    }
    const now = new Date().toISOString();
    const installRecord = {
      serverId: id,
      sha256: read.sha256,
      source: input.source ?? ('file' as const),
      signature,
      permissions: { network: input.permissions.network, fs: paths, secrets: secretRefs },
      userConfig,
      installedAt: now,
      enabled: input.enabled ?? true,
    };
    const prev = existing ? storedConfig(existing) : null;
    const config: StoredConfig = {
      startupTimeoutMs: prev?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      toolTimeoutMs: prev?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      enabledTools: prev?.enabledTools ?? null,
      disabledTools: prev?.disabledTools ?? [],
      readOnlyTools: prev?.readOnlyTools ?? [],
      // A bundle's tools ask by default (docs/08 §2.5).
      defaultApproval: prev?.defaultApproval ?? 'ask',
      policy: { network: input.permissions.network, fs: input.permissions.fs },
    };
    const row: Row = {
      id,
      accountId,
      name,
      transport: 'stdio',
      command: launch.command,
      argsJson: JSON.stringify(args),
      url: null,
      envRefJson: JSON.stringify(env),
      configJson: JSON.stringify(config),
      source: 'bundle',
      pluginId: null,
      deviceId: null,
      bundleManifestJson: JSON.stringify(manifest.raw),
      signatureStatus: signature,
      bundleSha256: read.sha256,
      installRecordJson: JSON.stringify(installRecord),
      enabled: input.enabled ?? true,
      lastStatus: null,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.transaction(async () => {
      if (existing) {
        const { id: _id, createdAt: _c, ...set } = row;
        await db.orm.update(mcpServer).set(set).where(eq(mcpServer.id, id));
      } else await db.orm.insert(mcpServer).values(row);
    });
    defaults.set(id, config.defaultApproval);
    await record(accountId, existing ? 'bundle.update' : 'bundle.install', row, {
      bundle: manifest.name,
      version: manifest.version,
      sha256: read.sha256,
      signature,
      sideloaded: signature === 'unverified',
      permissions: installRecord.permissions,
      previousVersion: existing ? (bundleOf(existing)?.version ?? null) : null,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    await events.emit({
      name: 'mcp.bundle.installed',
      actor: 'user',
      accountId,
      payload: { serverId: id, name: manifest.name, signature },
    });
    start(row, { restart: true });
    return row;
  }

  /** Point a remote server at another URL or transport (a registry entry's update). */
  async function updateRemote(
    accountId: string,
    row: Row,
    change: { transport: 'http' | 'sse'; url: string; enabled: boolean; origin?: string },
  ): Promise<Row> {
    refusePluginOwned(row);
    if (change.enabled) {
      const refused = await managedRefusal({ ...row, transport: change.transport });
      if (refused) throw managedDenied(refused, { server: row.name });
    }
    await assertPublicUrl(accountId, change.transport, change.url);
    const next: Row = {
      ...row,
      transport: change.transport,
      url: change.url,
      command: null,
      argsJson: '[]',
      deviceId: null,
      enabled: change.enabled,
      updatedAt: new Date().toISOString(),
    };
    await db.transaction(() =>
      db.orm
        .update(mcpServer)
        .set({
          transport: next.transport,
          url: next.url,
          command: null,
          argsJson: next.argsJson,
          deviceId: null,
          enabled: next.enabled,
          updatedAt: next.updatedAt,
        })
        .where(eq(mcpServer.id, row.id)),
    );
    await record(accountId, 'update', next, {
      fields: ['transport', 'url'],
      ...(change.origin ? { origin: change.origin } : {}),
    });
    start(next, { restart: true });
    return next;
  }

  /** Put a server row back as it was (the marketplace's rollback); secrets are the caller's. */
  async function restoreServer(row: Row): Promise<void> {
    await db.transaction(async () => {
      const { id: _id, ...set } = row;
      const [there] = await db.orm
        .select({ id: mcpServer.id })
        .from(mcpServer)
        .where(eq(mcpServer.id, row.id));
      if (there) await db.orm.update(mcpServer).set(set).where(eq(mcpServer.id, row.id));
      else await db.orm.insert(mcpServer).values(row);
    });
    if (row.source !== 'plugin') defaults.set(row.id, storedConfig(row).defaultApproval);
    start(row, { restart: true });
  }

  // The marketplace's installer of MCP registry entries and bundles (FR-049, kind `mcp`).
  const marketInstaller = mcpMarketInstaller({
    db,
    secrets,
    launchEnv,
    byName,
    isOwner: (accountId) => isHubOwner(db, accountId),
    assertPublicUrl,
    createServer: (accountId, body) => createServer(accountId, mcpServerM7Schema.parse(body)),
    updateRemote,
    installBundle,
    removeServer: async (accountId, row) => {
      refusePluginOwned(row);
      await removeServer(accountId, row);
    },
    restoreServer,
  });

  function register(app: FastifyInstance): void {
    app.get('/api/v1/mcp/servers', async (req) => {
      const accountId = await accountOf(req);
      const rows = await db.orm
        .select()
        .from(mcpServer)
        .where(eq(mcpServer.accountId, accountId))
        .orderBy(asc(mcpServer.createdAt));
      return { items: rows.map(view) };
    });

    app.post('/api/v1/mcp/servers', async (req, reply) => {
      const accountId = await accountOf(req);
      const row = await createServer(accountId, mcpServerM7Schema.parse(req.body));
      void reply.status(201);
      return view(row);
    });

    app.get('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      return view(await load(accountId, params.parse(req.params).id));
    });

    app.patch('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      refusePluginOwned(row);
      const patch = patchBody.parse(req.body ?? {});
      assertPlainArgs(patch.args);
      const cur = storedConfig(row);
      // The merged server must still be valid as a whole (stdio needs a command, …).
      const merged = mcpServerM7Schema.parse({
        deviceId: patch.deviceId === undefined ? row.deviceId : patch.deviceId,
        auth: patch.auth === undefined ? (cur.auth ? '' : undefined) : patch.auth,
        oauth: patch.oauth === undefined ? cur.oauth : patch.oauth,
        name: patch.name ?? row.name,
        transport: patch.transport ?? row.transport,
        command: patch.command ?? row.command ?? undefined,
        args: patch.args ?? parseJson<string[]>(row.argsJson, []),
        url: patch.url ?? row.url ?? undefined,
        enabled: patch.enabled ?? row.enabled,
        toolTimeoutMs: patch.toolTimeoutMs ?? cur.toolTimeoutMs,
        startupTimeoutMs: patch.startupTimeoutMs ?? cur.startupTimeoutMs,
        defaultApproval:
          patch.defaultApproval === undefined ? cur.defaultApproval : patch.defaultApproval,
        enabledTools: patch.enabledTools === undefined ? cur.enabledTools : patch.enabledTools,
        disabledTools: patch.disabledTools ?? cur.disabledTools,
        readOnlyTools: patch.readOnlyTools ?? cur.readOnlyTools,
      });
      // A bundle's server starts the way its bundle says (FR-199): editing its command, arguments
      // or transport would make it a server the user added by hand, outside what the bundle (and
      // managed policy's rules for bundles) allowed. Install another version instead.
      if (
        row.source === 'bundle' &&
        (merged.transport !== row.transport ||
          (merged.command ?? null) !== row.command ||
          JSON.stringify(merged.args ?? []) !==
            JSON.stringify(parseJson<string[]>(row.argsJson, [])))
      )
        throw new NovaError(
          'validation',
          "a bundle's server starts as its bundle says; install another version to change it",
          { details: { reason: 'bundle_launch', server: row.name } },
        );
      if (merged.name !== row.name) await assertNameFree(accountId, merged.name, row.id);
      // A server managed policy refuses may be turned off or removed, never (re)enabled (FR-106).
      if (merged.enabled !== false) {
        const refused = await managedRefusal({
          name: merged.name,
          source: row.source,
          transport: merged.transport,
          deviceId: merged.deviceId ?? null,
          pluginId: row.pluginId,
        });
        if (refused) throw managedDenied(refused, { server: merged.name });
      }
      assertDevice(accountId, merged.deviceId);
      await assertPublicUrl(accountId, merged.transport, merged.url);
      // A server that left sse/http keeps no key; `null` removes it, '' keeps it.
      const authRef = await storeAuth(
        row.id,
        cur.auth,
        merged.transport === 'stdio' ? null : patch.auth,
      );
      // `env`, when sent, is the complete set of names (the settings UI sends it on any change).
      const savedEnv = parseJson<Record<string, string>>(row.envRefJson, {});
      const env = patch.env ? await storeEnv(row.id, savedEnv, patch.env) : savedEnv;
      const config: StoredConfig = {
        startupTimeoutMs: merged.startupTimeoutMs ?? cur.startupTimeoutMs,
        toolTimeoutMs: merged.toolTimeoutMs ?? cur.toolTimeoutMs,
        enabledTools: merged.enabledTools ?? null,
        disabledTools: merged.disabledTools ?? [],
        readOnlyTools: unique(merged.readOnlyTools ?? []),
        defaultApproval: merged.defaultApproval ?? null,
        ...(cur.policy ? { policy: cur.policy } : {}),
        ...(authRef ? { auth: authRef } : {}),
        ...(merged.oauth && merged.transport !== 'stdio' ? { oauth: merged.oauth } : {}),
      };
      const next: Row = {
        ...row,
        name: merged.name,
        transport: merged.transport,
        command: merged.transport === 'stdio' ? (merged.command ?? null) : null,
        argsJson: JSON.stringify(merged.args ?? []),
        url: merged.transport === 'stdio' ? null : (merged.url ?? null),
        envRefJson: JSON.stringify(env),
        configJson: JSON.stringify(config),
        deviceId: merged.transport === 'stdio' ? (merged.deviceId ?? null) : null,
        enabled: merged.enabled ?? row.enabled,
        updatedAt: new Date().toISOString(),
      };
      try {
        await db.transaction(() =>
          db.orm
            .update(mcpServer)
            .set({
              name: next.name,
              transport: next.transport,
              command: next.command,
              argsJson: next.argsJson,
              url: next.url,
              envRefJson: next.envRefJson,
              configJson: next.configJson,
              deviceId: next.deviceId,
              enabled: next.enabled,
              updatedAt: next.updatedAt,
            })
            .where(eq(mcpServer.id, row.id)),
        );
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message))
          throw new NovaError('conflict', `an MCP server named ${merged.name} already exists`);
        throw err;
      }
      defaults.set(row.id, config.defaultApproval);
      const action = next.enabled === row.enabled ? 'update' : next.enabled ? 'enable' : 'disable';
      // Declaring tools read-only loosens what agents may do without asking: a change to the
      // list is recorded with what was added and removed (mcp read-only tools changed).
      const before = new Set(cur.readOnlyTools);
      const after = new Set(config.readOnlyTools);
      const added = config.readOnlyTools.filter((t) => !before.has(t));
      const removed = cur.readOnlyTools.filter((t) => !after.has(t));
      await record(accountId, action, next, {
        fields: Object.keys(patch).sort(),
        ...(added.length || removed.length
          ? { readOnlyTools: { added, removed, now: config.readOnlyTools } }
          : {}),
      });
      // New secret values keep their references, so a changed value needs an explicit relaunch.
      start(next, { restart: patch.env !== undefined || patch.auth !== undefined });
      return view(next);
    });

    app.delete('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      refusePluginOwned(row);
      await removeServer(accountId, row);
      return { ok: true };
    });

    app.post('/api/v1/mcp/servers/:id/restart', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      if (!row.enabled)
        throw new NovaError('conflict', 'enable the MCP server before restarting it');
      manager.restart(row.id).catch((err: unknown) => {
        log.warn('mcp restart failed', { serverId: row.id, err });
      });
      return view(row);
    });

    app.get('/api/v1/mcp/servers/:id/logs', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      return { items: manager.logs(row.id) };
    });

    app.get('/api/v1/mcp/servers/:id/tools', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      return { items: manager.tools(row.id).map((t) => t.descriptor) };
    });

    // ---- bundles (FR-199) -------------------------------------------------------------------

    app.post(
      '/api/v1/mcp/bundles/preview',
      { bodyLimit: Math.ceil((BUNDLE_MAX_BYTES * 4) / 3) + 64 * 1024 },
      async (req) => {
        const accountId = await accountOf(req);
        const body = bundleUpload.parse(req.body);
        if (!/^[A-Za-z0-9+/=\s]*$/.test(body.data))
          throw new NovaError('validation', 'the bundle must be sent as base64', {
            details: { field: 'data' },
          });
        const bytes = Buffer.from(body.data, 'base64');
        if (!bytes.length) throw new NovaError('validation', 'the bundle is empty');
        if (bytes.length > BUNDLE_MAX_BYTES)
          throw new NovaError('validation', 'the bundle is larger than 50 MB');
        const read = readBundle(bytes);
        const signature = bundleSignature(read, TRUSTED_BUNDLE_PUBLISHERS);
        sweepPreviews();
        const previewId = uuidv7();
        mkdirSync(previewDir, { recursive: true, mode: 0o700 });
        const file = join(previewDir, `${previewId}.mcpb`);
        writeFileSync(file, bytes, { mode: 0o600 });
        previews.set(previewId, { accountId, file, expiresAt: Date.now() + BUNDLE_PREVIEW_TTL_MS });
        const existing = await byName(accountId, bundleServerName(read.manifest.name));
        return previewOf(previewId, read.manifest, signature, read.signed, existing);
      },
    );

    app.post('/api/v1/mcp/bundles/install', async (req, reply) => {
      const accountId = await accountOf(req);
      const body = installBundleSchema.parse(req.body);
      sweepPreviews();
      const p = previews.get(body.previewId);
      if (!p || p.accountId !== accountId || !existsSync(p.file))
        throw new NovaError('not_found', 'the bundle preview expired; upload the bundle again');
      const row = await installBundle(accountId, {
        bytes: readFileSync(p.file),
        userConfig: body.userConfig,
        permissions: body.permissions,
        confirmSideload: body.confirmSideload === true,
      });
      previews.delete(body.previewId);
      rmSync(p.file, { force: true });
      void reply.status(201);
      return view(row);
    });

    // ---- OAuth (FR-047) ----------------------------------------------------------------------

    app.get(CLIENT_METADATA_PATH, async (req, reply) => {
      const base = hubBaseUrl(req);
      void reply.header('Cache-Control', 'no-cache');
      return clientMetadataDocument(
        `${base}${CLIENT_METADATA_PATH}`,
        `${base}${OAUTH_CALLBACK_PATH}`,
        base,
      );
    });

    app.post('/api/v1/mcp/servers/:id/oauth/start', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      if (row.transport === 'stdio' || !row.url)
        throw new NovaError('validation', 'OAuth is for sse and http servers');
      const base = hubBaseUrl(req);
      // The server's OAuth settings (FR-047): dynamic registration, or another metadata document,
      // and the scopes to ask for; without them, the Hub's own document and the advertised scopes.
      const settings = storedConfig(row).oauth;
      const out = await oauth.start({
        serverId: row.id,
        accountId,
        serverUrl: row.url,
        redirectUrl: `${base}${OAUTH_CALLBACK_PATH}`,
        clientMetadataUrl: settings?.dynamicRegistration
          ? null
          : (settings?.clientMetadataUrl ?? `${base}${CLIENT_METADATA_PATH}`),
        ...(settings?.scopes?.length ? { scopes: settings.scopes } : {}),
      });
      await record(accountId, 'oauth.start', row, {
        registration: oauth.record(row.id)?.registration ?? null,
      });
      return out;
    });

    // The authorization server sends the browser back here; there is no session on a cross-site
    // redirect, so the single-use state is what ties it to the account.
    app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
      // A malformed callback is refused outright; a well-formed one always lands back in settings.
      const q = callbackQuery.parse(req.query);
      // A code this Hub issued (a Nova app code delivered here) is never sent on: the server's
      // metadata, which its author controls, may omit or fake the issuer the exchange would
      // check. The state is spent as a refusal (M8 review).
      const fromHub =
        q.iss !== undefined &&
        isHubUrl(q.iss, { config: ctx.config, app: req.server, requestHost: req.headers.host });
      let ok = false;
      try {
        const r = await oauth.finish(
          fromHub
            ? { state: q.state, error: 'issuer_mismatch' }
            : { state: q.state, code: q.code, error: q.error, iss: q.iss },
        );
        const [row] = await db.orm
          .select()
          .from(mcpServer)
          .where(and(eq(mcpServer.id, r.serverId), eq(mcpServer.accountId, r.accountId)));
        if (row)
          await record(r.accountId, r.ok ? 'oauth.connect' : 'oauth.failed', row, {
            ...(r.error ? { error: r.error } : {}),
          });
        ok = r.ok && !!row;
      } catch (err) {
        log.warn('oauth callback refused', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.redirect(`/settings/tools?oauth=${ok ? 'ok' : 'error'}`, 302);
    });

    app.delete('/api/v1/mcp/servers/:id/oauth', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      await oauth.revoke(row.id);
      await record(accountId, 'oauth.revoke', row);
      return view(row);
    });
  }

  return {
    source: new McpToolSource(manager),
    manager,
    marketInstaller,
    onServerRemoving: (hook) => {
      removing.push(hook);
    },
    useDeviceBridge: (bridge) => {
      manager.useDeviceBridge(bridge);
      // Device servers that were waiting for it connect now.
      for (const s of manager.states()) {
        const cfg = manager.config(s.id);
        if (cfg?.deviceId && cfg.enabled) update(cfg, { restart: true });
      }
    },
    serverDefault: (serverId) => defaults.get(serverId) ?? null,
    onToolsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    close: async () => {
      offManaged();
      await manager.close();
      await statusChain;
      for (const p of previews.values()) rmSync(p.file, { force: true });
      previews.clear();
    },
  };
}
