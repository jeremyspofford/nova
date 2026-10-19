// Lifecycle hooks: discovery, trust by content hash, running them (FR-197, ADR-068; docs/08 §4.1).
// Sources: managed policy (re-read whenever it changes, `managed.policy.changed`), the user hooks
// file `<dataDir>/hooks.json`, each project folder's `.nova/hooks.json`, and plugins (registered by
// the plugins area). A hook runs only while the
// user trusts its current content hash; the routes list, trust, revoke, switch and delete them.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { trustHookSchema, type HookView } from '@nova/shared';
import {
  HookService,
  hookStatus,
  type AuditSink,
  type HookDispatcher,
  type HookMcpClient,
  type PluginHookFeed,
  type PluginHooksInput,
  type SandboxClient,
  type ToolGate,
  type ToolRuntimeOptions,
} from '@nova/core';
import type { McpManager } from '@nova/mcp';
import type { HubArea, HubContext } from './hub-context.ts';
import { settingsScope } from './tools.ts';

export interface HooksArea extends HubArea {
  dispatcher: HookDispatcher;
  service: HookService;
  /** Hooks of type `command` run in the tools' sandbox (wired after the tools area exists). */
  useSandbox(sandbox: SandboxClient): void;
  /** Hooks of type `mcp_tool` call through the MCP manager. */
  useMcp(manager: McpManager): void;
  /** `mcp_tool` hooks pass the policy gate with origin `hook`; without it they cannot run. */
  useGate(gate: ToolGate): void;
  /** Share the tool runtime's exact session scope (roots and profile) with command hooks. */
  useScope(scope: ToolRuntimeOptions['scope']): void;
  /**
   * Take plugin hooks from the plugins area (its hook source: list + onChange with the hooks
   * trusted on the install screen). Once wired it is the authority for plugin hooks.
   */
  usePluginHooks(feed: PluginHookFeed): void;
  /** How many of a plugin's hooks wait for trust (the plugin's `needs_trust` status). */
  untrustedPluginHooks(accountId: string, pluginId: string): Promise<number | null>;
  /** Push-style alternative to the feed: install, update, enable and remove a plugin's hooks. */
  previewPluginHooks(input: PluginHooksInput): { items: HookView[]; errors: string[] };
  registerPluginHooks(
    accountId: string,
    input: PluginHooksInput,
  ): Promise<{ items: HookView[]; errors: string[] }>;
  setPluginHooksEnabled(accountId: string, pluginId: string, enabled: boolean): Promise<void>;
  removePluginHooks(accountId: string, pluginId: string): Promise<void>;
}

export interface HooksDeps {
  audit: AuditSink;
  /** The policy gate, when the lead passes it at setup (else `useGate`). */
  gate?: ToolGate;
  /** The managed settings layer's hooks (a hooks-file object or array); trusted by policy. */
  managedHooks?: () => unknown;
  /** Replace the sandbox until `useSandbox` (tests). */
  sandbox?: SandboxClient;
}

const params = z.object({ id: z.string().min(1).max(300) });
const patchBody = z.object({ enabled: z.boolean() }).strict();

/** The MCP manager as hooks reach it: exposed tools of connected servers, by canonical name. */
export function mcpForHooks(manager: McpManager): HookMcpClient {
  const entry = (accountId: string, name: string) =>
    manager.exposedTools(accountId).find((t) => t.descriptor.name === name) ?? null;
  return {
    find: (accountId, name) => entry(accountId, name)?.descriptor ?? null,
    call: (accountId, name, args, opts) => {
      const e = entry(accountId, name);
      if (!e)
        return Promise.resolve({
          ok: false,
          error: { code: 'mcp.tool_not_found', message: `no connected MCP tool ${name}` },
        });
      return manager.callTool(e.serverId, e.original, args, opts);
    },
  };
}

export function setupHooks(ctx: HubContext & HooksDeps): Promise<HooksArea> {
  const log = ctx.log.child('hooks');
  const workspace = join(ctx.dataDir, 'workspace');
  const service = new HookService({
    db: ctx.db,
    events: ctx.events,
    audit: ctx.audit,
    log,
    userFile: join(ctx.dataDir, 'hooks.json'),
    ...(ctx.managedHooks ? { managed: ctx.managedHooks } : {}),
    sandbox: ctx.sandbox ?? null,
    gate: ctx.gate ?? null,
    // The same roots and profile the tools resolve for the session (FR-190).
    scope: settingsScope(ctx, workspace),
    // Context over 2,500 tokens is written where the model can read it with fs.read.
    spillDir: join(workspace, 'hook-context'),
  });

  // A managed policy change (FR-106, ADR-097 D4) brings every account's managed hooks in step at
  // once: a hook the policy added is registered (trusted by policy) and one it dropped is gone,
  // with no restart and without waiting for the next dispatch or listing.
  const refreshAll = async () => {
    if (!service.store.available()) return;
    const accounts = ctx.db.raw
      .prepare('SELECT id FROM account WHERE deleted_at IS NULL')
      .all() as { id: string }[];
    for (const { id } of accounts) await service.refresh(id, { only: null });
  };
  const offManaged = ctx.events.bus.subscribe('managed.policy.changed', () => {
    refreshAll().catch((err: unknown) => log.warn('managed hooks not refreshed', { err }));
  });

  ctx.diagnostics.add('hooks', () => {
    const counts: Record<string, number> = {};
    if (service.store.available()) {
      for (const accountId of service.store.accounts()) {
        for (const row of service.store.list(accountId)) {
          const status = hookStatus(row);
          counts[status] = (counts[status] ?? 0) + 1;
        }
      }
    }
    return Promise.resolve({ ...service.diagnostics(), counts });
  });

  return Promise.resolve({
    dispatcher: service,
    service,
    useSandbox: (sandbox) => service.useSandbox(sandbox),
    useMcp: (manager) => service.useMcp(mcpForHooks(manager)),
    useGate: (gate) => service.useGate(gate),
    useScope: (scope) => service.useScope(scope),
    usePluginHooks: (feed) => service.usePluginHooks(feed),
    untrustedPluginHooks: (accountId, pluginId) =>
      service.untrustedPluginHooks(accountId, pluginId),
    previewPluginHooks: (input) => service.previewPluginHooks(input),
    registerPluginHooks: (accountId, input) => service.registerPluginHooks(accountId, input),
    setPluginHooksEnabled: (accountId, pluginId, enabled) =>
      service.setPluginHooksEnabled(accountId, pluginId, enabled),
    removePluginHooks: (accountId, pluginId) => service.removePluginHooks(accountId, pluginId),
    register(app: FastifyInstance) {
      app.get('/api/v1/hooks', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.list(accountId) };
      });

      // Only the user's own hooks can be switched or deleted here; others are revoked instead.
      app.patch('/api/v1/hooks/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = patchBody.parse(req.body);
        return service.setEnabled(accountId, id, body.enabled);
      });

      app.delete('/api/v1/hooks/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        await service.remove(accountId, id);
        return { ok: true };
      });

      // The hash must be the one the user reviewed: a hook that changed since is a conflict.
      app.post('/api/v1/hooks/:id/trust', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = trustHookSchema.parse(req.body);
        return service.trust(accountId, id, body.contentHash, 'user');
      });

      app.post('/api/v1/hooks/:id/untrust', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        return service.untrust(accountId, id, 'user');
      });
    },
    close: () => {
      offManaged();
      service.close();
      return Promise.resolve();
    },
  });
}
