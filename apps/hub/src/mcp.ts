// MCP client servers: configuration, connections, health and their tools (FR-042, FR-043;
// docs/08 §2.1, §2.3). Secret values go to the vault and the database keeps only their
// `secret://mcp/<id>/env/<NAME>` references (FR-101). `env` carries a stdio server's environment
// and, for sse/http servers, its headers (`X_Api_Key` is sent as `X-Api-Key`; @nova/mcp). Servers
// connect in the background; a status change is stored and announced as
// `mcp.server.status.changed`.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  idSchema,
  mcpServerSchema,
  uuidv7,
  type McpServerView,
  type McpStatus,
} from '@nova/shared';
import type { AuditSink } from '@nova/core';
import { McpManager, McpToolSource, type McpServerConfig, type McpServerState } from '@nova/mcp';
import { secretRef } from '@nova/secrets';
import { schema } from '@nova/storage';
import type { HubContext, McpArea } from './hub-context.ts';

const { mcpServer } = schema;
type Row = typeof mcpServer.$inferSelect;
type Approval = 'allow' | 'ask' | 'deny';

/** Defaults from contracts/schemas/mcp-config.json. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface HubMcpArea extends McpArea {
  manager: McpManager;
  /** A server's default approval for its tools (FR-048), or null for the engine's default. */
  serverDefault(serverId: string): Approval | null;
  /** Called when a server's tool list, or what its lists expose, changes (FR-196 index). */
  onToolsChanged(listener: (serverId: string) => void): () => void;
}

/** What `config_json` holds (the mcp-config.json fields without their own column). */
interface StoredConfig {
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: string[] | null;
  disabledTools: string[];
  defaultApproval: Approval | null;
}

const params = z.object({ id: idSchema });
const patchBody = z.object(mcpServerSchema.shape).partial();

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function storedConfig(row: Row): StoredConfig {
  const c = parseJson<Partial<StoredConfig>>(row.configJson, {});
  return {
    startupTimeoutMs: c.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    toolTimeoutMs: c.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    enabledTools: c.enabledTools ?? null,
    disabledTools: c.disabledTools ?? [],
    defaultApproval: c.defaultApproval ?? null,
  };
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
    headers: {},
    enabled: row.enabled,
    startupTimeoutMs: c.startupTimeoutMs,
    toolTimeoutMs: c.toolTimeoutMs,
    enabledTools: c.enabledTools,
    disabledTools: c.disabledTools,
  };
}

const STATUSES: readonly McpStatus[] = ['disabled', 'starting', 'connected', 'error', 'stopped'];

function toView(row: Row, state: McpServerState | null): McpServerView {
  const c = storedConfig(row);
  const stored = STATUSES.find((s) => s === row.lastStatus) ?? 'stopped';
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: parseJson<string[]>(row.argsJson, []),
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function setupMcp(ctx: HubContext & { audit: AuditSink }): Promise<HubMcpArea> {
  const { db, secrets, events, audit, accountOf } = ctx;
  const log = ctx.log.child('mcp');
  const listeners = new Set<(serverId: string) => void>();
  const defaults = new Map<string, Approval | null>();
  // Status writes and events go out in order, one at a time.
  let statusChain: Promise<void> = Promise.resolve();

  const manager = new McpManager({
    resolveSecret: (ref) => secrets.get(ref),
    log,
    workDir: join(ctx.dataDir, 'mcp'),
    clientVersion: ctx.config.version,
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

  async function assertNameFree(accountId: string, name: string, except?: string): Promise<void> {
    const [row] = await db.orm
      .select({ id: mcpServer.id })
      .from(mcpServer)
      .where(and(eq(mcpServer.accountId, accountId), eq(mcpServer.name, name)));
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
      const own = secretRef('mcp', id, 'env', key);
      if (value !== '' || current[key] !== own) await secrets.put(own, value);
      next[key] = own;
    }
    for (const [key, ref] of Object.entries(current)) {
      if (!(key in incoming) && ref === secretRef('mcp', id, 'env', key)) await secrets.delete(ref);
    }
    return next;
  }

  async function deleteSecrets(id: string): Promise<void> {
    for (const ref of await secrets.list(`secret://mcp/${id}/`)) await secrets.delete(ref);
  }

  async function record(
    accountId: string,
    action: 'add' | 'remove' | 'enable' | 'disable' | 'update',
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

  function start(config: McpServerConfig, opts: { restart?: boolean } = {}): void {
    manager.update(config, opts).catch((err: unknown) => {
      log.warn('mcp server update failed', { serverId: config.id, err });
    });
  }

  // Connect every enabled server in the background; Hub startup never waits on them.
  for (const row of await db.orm.select().from(mcpServer).orderBy(asc(mcpServer.createdAt))) {
    defaults.set(row.id, storedConfig(row).defaultApproval);
    start(toConfig(row));
  }

  ctx.diagnostics.add('mcp', () =>
    Promise.resolve(
      manager
        .states()
        .map((s) => ({ id: s.id, name: s.name, status: s.status, lastError: s.lastError })),
    ),
  );

  function register(app: FastifyInstance): void {
    app.get('/api/v1/mcp/servers', async (req) => {
      const accountId = await accountOf(req);
      const rows = await db.orm
        .select()
        .from(mcpServer)
        .where(eq(mcpServer.accountId, accountId))
        .orderBy(asc(mcpServer.createdAt));
      return { items: rows.map((r) => toView(r, manager.state(r.id))) };
    });

    app.post('/api/v1/mcp/servers', async (req, reply) => {
      const accountId = await accountOf(req);
      const body = mcpServerSchema.parse(req.body);
      await assertNameFree(accountId, body.name);
      const id = uuidv7();
      const now = new Date().toISOString();
      let row: Row;
      try {
        const env = await storeEnv(id, {}, body.env ?? {});
        const config: StoredConfig = {
          startupTimeoutMs: body.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
          toolTimeoutMs: body.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          enabledTools: body.enabledTools ?? null,
          disabledTools: body.disabledTools ?? [],
          defaultApproval: body.defaultApproval ?? null,
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
          deviceId: null,
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
      defaults.set(id, storedConfig(row).defaultApproval);
      await record(accountId, 'add', row, { envKeys: Object.keys(body.env ?? {}).sort() });
      start(toConfig(row));
      void reply.status(201);
      return toView(row, manager.state(id));
    });

    app.get('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      return toView(row, manager.state(row.id));
    });

    app.patch('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      const patch = patchBody.parse(req.body ?? {});
      const cur = storedConfig(row);
      // The merged server must still be valid as a whole (stdio needs a command, …).
      const merged = mcpServerSchema.parse({
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
      });
      if (merged.name !== row.name) await assertNameFree(accountId, merged.name, row.id);
      // `env`, when sent, is the complete set of names (the settings UI sends it on any change).
      const savedEnv = parseJson<Record<string, string>>(row.envRefJson, {});
      const env = patch.env ? await storeEnv(row.id, savedEnv, patch.env) : savedEnv;
      const config: StoredConfig = {
        startupTimeoutMs: merged.startupTimeoutMs ?? cur.startupTimeoutMs,
        toolTimeoutMs: merged.toolTimeoutMs ?? cur.toolTimeoutMs,
        enabledTools: merged.enabledTools ?? null,
        disabledTools: merged.disabledTools ?? [],
        defaultApproval: merged.defaultApproval ?? null,
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
      await record(accountId, action, next, {
        fields: Object.keys(patch).sort(),
      });
      // New secret values keep their references, so a changed value needs an explicit relaunch.
      start(toConfig(next), { restart: patch.env !== undefined });
      return toView(next, manager.state(row.id));
    });

    app.delete('/api/v1/mcp/servers/:id', async (req) => {
      const accountId = await accountOf(req);
      const row = await load(accountId, params.parse(req.params).id);
      await manager.remove(row.id);
      await db.transaction(() => db.orm.delete(mcpServer).where(eq(mcpServer.id, row.id)));
      await deleteSecrets(row.id);
      rmSync(join(ctx.dataDir, 'mcp', row.id), { recursive: true, force: true });
      defaults.delete(row.id);
      await record(accountId, 'remove', row);
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
      return toView(row, manager.state(row.id));
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
  }

  return {
    source: new McpToolSource(manager),
    manager,
    serverDefault: (serverId) => defaults.get(serverId) ?? null,
    onToolsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    close: async () => {
      await manager.close();
      await statusChain;
    },
  };
}
