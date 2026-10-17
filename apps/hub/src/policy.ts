// Policy engine, approvals, rules, grants and permission profiles (FR-048, FR-099, FR-100,
// FR-189, FR-190, FR-191; contracts/hub-api.md "Tasks, goals, agents, approvals, requests").
// Every route needs a session and validates its input with zod. Managed rules are read-only; a
// second answer to an approval is `conflict`.
//
// M4: the gate runs the `permission.request` hooks (FR-197, docs/12 §2.3 step 7), enforces the
// confirmed permissions of plugins (FR-045) and adds a project's folders to its roots (FR-035);
// the lead wires each with `useHooks`, `usePluginPermissions` and `useProjectFolders`.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  decideApprovalSchema,
  evaluatePreviewSchema,
  handoffDoneSchema,
  idSchema,
  NovaError,
  toolDefaultSchema,
  type ToolDescriptor,
  type ToolSource,
} from '@nova/shared';
import {
  PolicyGate,
  PolicyStore,
  RULE_EFFECT_CLASSES,
  projectFolderSource,
  type AuditSink,
  type HookDispatcher,
  type Notifier,
  type PluginPermissionSource,
  type ProjectFolderSource,
  type ServerDefaults,
} from '@nova/core';
import type { Scope, Substrate } from '@nova/policy';
import { schema } from '@nova/storage';
import { and, eq, isNull } from 'drizzle-orm';
import type { HubContext, PolicyArea } from './hub-context.ts';

/** Looks up a registered tool for the policy preview (wired from the tools area). */
export type ToolCatalog = (accountId: string, name: string) => Promise<ToolDescriptor | null>;

export interface PolicyAreaFull extends PolicyArea {
  gate: PolicyGate;
  store: PolicyStore;
  /** Per-MCP-server and per-plugin defaults (FR-048), from the MCP area. */
  useServerDefaults(fn: ServerDefaults): void;
  /** Tool descriptors for POST /policy/evaluate, from the tools area. */
  useToolCatalog(fn: ToolCatalog): void;
  /** The sandbox substrate (the `full` profile needs a VM or container). */
  useSubstrate(fn: () => Substrate | null): void;
  /** `permission.request` hooks, from the hooks area (FR-197). */
  useHooks(dispatcher: HookDispatcher): void;
  /** Confirmed plugin permissions, from the plugins area (FR-045). */
  usePluginPermissions(source: PluginPermissionSource): void;
  /** A project's folders (FR-035); the tools area must use the same source. */
  useProjectFolders(source: ProjectFolderSource): void;
}

export interface PolicyOptions {
  /** Override `policy.approvalTimeoutMinutes` (tests). */
  approvalTimeoutMs?: () => number;
  home?: string;
}

const params = z.object({ id: idSchema });
const ref = z.string().trim().min(1).max(300);

const ruleBody = z
  .object({
    scopeKind: z.enum(['global', 'project', 'thread', 'tool', 'site']),
    scopeRef: ref.nullable().optional(),
    match: z
      .object({
        tool: z.string().trim().min(1).max(200).optional(),
        resource: z.string().trim().min(1).max(500).optional(),
        effects: z.array(z.enum(RULE_EFFECT_CLASSES)).max(RULE_EFFECT_CLASSES.length).optional(),
      })
      .strict(),
    effect: z.enum(['allow', 'ask', 'handoff', 'deny']),
    label: z.string().trim().max(200).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
const rulePatch = ruleBody
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

const word = z.string().min(1).max(200);
const commandBody = z
  .object({
    scopeKind: z.enum(['global', 'project', 'thread', 'session', 'agent']).optional(),
    scopeRef: ref.nullable().optional(),
    pattern: z
      .array(z.union([word, z.array(word).min(2).max(50)]))
      .min(1)
      .max(20),
    decision: z.enum(['allow', 'ask', 'deny']),
    justification: z.string().trim().max(500).nullable().optional(),
    matchExamples: z.array(z.string().min(1).max(1000)).min(1).max(50),
    notMatchExamples: z.array(z.string().min(1).max(1000)).min(1).max(50),
    priority: z.number().int().min(0).max(1000).optional(),
    tools: z.array(word).min(1).max(20).optional(),
  })
  .strict();
const commandPatch = commandBody
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
const commandTest = z
  .object({
    command: z.string().min(1).max(10_000),
    threadId: idSchema.optional(),
    projectId: idSchema.optional(),
  })
  .strict();

const profileBody = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    extends: z.string().min(1).max(100).nullable().optional(),
    filesystem: z
      .array(
        z
          .object({ path: z.string().min(1).max(1000), access: z.enum(['read', 'write', 'deny']) })
          .strict(),
      )
      .max(100),
    network: z
      .object({
        mode: z.enum(['off', 'allowlist', 'limited']),
        allow: z.array(z.string().min(1).max(253)).max(200).optional(),
        deny: z.array(z.string().min(1).max(253)).max(200).optional(),
        socks5: z.boolean().optional(),
        allowLocalBinding: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const approvalsQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  threadId: idSchema.optional(),
});

function sourceOf(name: string): ToolSource {
  if (name.startsWith('mcp:')) return 'mcp';
  if (name.startsWith('plugin:')) return 'plugin';
  if (name.startsWith('page:')) return 'page';
  return 'builtin';
}

/** The resource a preview's arguments name: a path, or the host of a URL. */
function resourceOf(args: unknown): { kind: 'path' | 'host'; value: string } | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string') return { kind: 'path', value: a.path };
  if (typeof a.url === 'string') {
    try {
      return { kind: 'host', value: new URL(a.url).hostname };
    } catch {
      return undefined;
    }
  }
  if (typeof a.host === 'string') return { kind: 'host', value: a.host };
  return undefined;
}

export async function setupPolicy(
  ctx: HubContext & { audit: AuditSink; notifier: Notifier },
  opts: PolicyOptions = {},
): Promise<PolicyAreaFull> {
  const log = ctx.log.child('policy');
  const store = new PolicyStore({ db: ctx.db });
  const gate = new PolicyGate({
    store,
    events: ctx.events,
    audit: ctx.audit,
    notifier: ctx.notifier,
    setting: ctx.setting,
    dataDir: ctx.dataDir,
    log,
    projectFolders: projectFolderSource(ctx.db),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.approvalTimeoutMs ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
  });
  let catalog: ToolCatalog | null = null;

  // Nobody waits for an approval left pending by a crash (docs/06 invariant 10).
  const cancelled = await store.recoverPending();
  if (cancelled) log.info('cancelled approvals left pending by a restart', { count: cancelled });
  ctx.diagnostics.add('policy', async () => ({
    pendingApprovals: await store.pendingCount(),
    waiting: gate.pending,
    commandRuleErrors: [...store.commandRuleErrors.values()],
  }));

  async function threadOf(accountId: string, threadId: string) {
    const t = schema.thread;
    const rows = await ctx.db.orm
      .select({ id: t.id, projectId: t.projectId, mode: t.mode })
      .from(t)
      .where(and(eq(t.id, threadId), eq(t.accountId, accountId), isNull(t.deletedAt)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'thread not found');
    return rows[0];
  }

  function register(app: FastifyInstance): void {
    const accountOf = ctx.accountOf;

    // ---- approvals (FR-100) ---------------------------------------------------------------
    app.get('/api/v1/approvals', async (req) => {
      const accountId = await accountOf(req);
      const q = approvalsQuery.parse(req.query);
      return { items: await store.listApprovals(accountId, q) };
    });

    app.get('/api/v1/approvals/:id', async (req) => {
      const accountId = await accountOf(req);
      return store.getApproval(accountId, params.parse(req.params).id);
    });

    app.post('/api/v1/approvals', async (req) => {
      const accountId = await accountOf(req);
      return gate.decide(accountId, decideApprovalSchema.parse(req.body), 'user');
    });

    app.post('/api/v1/approvals/:id/handoff-done', async (req) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      const body = handoffDoneSchema.parse(req.body ?? {});
      return gate.handoffDone(accountId, id, body.note);
    });

    // ---- policy rules (FR-084 partial, FR-099) ---------------------------------------------
    app.get('/api/v1/policy/rules', async (req) => ({
      items: await store.listRules(await accountOf(req)),
    }));

    app.post('/api/v1/policy/rules', async (req, reply) => {
      const accountId = await accountOf(req);
      const view = await store.createRule(accountId, ruleBody.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.patch('/api/v1/policy/rules/:id', async (req) => {
      const accountId = await accountOf(req);
      return store.updateRule(accountId, params.parse(req.params).id, rulePatch.parse(req.body));
    });

    app.delete('/api/v1/policy/rules/:id', async (req) => {
      const accountId = await accountOf(req);
      await store.deleteRule(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // Preview (FR-048, FR-084): what the engine would decide, with no side effects.
    app.post('/api/v1/policy/evaluate', async (req) => {
      const accountId = await accountOf(req);
      const body = evaluatePreviewSchema.parse(req.body);
      let tool: ToolDescriptor | null;
      if (catalog) {
        tool = await catalog(accountId, body.tool);
        if (!tool) throw new NovaError('not_found', `unknown tool ${body.tool}`);
      } else {
        tool = {
          name: body.tool,
          title: body.tool,
          description: '',
          source: sourceOf(body.tool),
          inputSchema: {},
        };
      }
      const thread = body.threadId ? await threadOf(accountId, body.threadId) : null;
      const resource = resourceOf(body.args);
      return gate.preview({
        accountId,
        threadId: thread?.id ?? '',
        projectId: thread?.projectId ?? null,
        mode: thread?.mode ?? 'chat',
        tool,
        args: body.args ?? {},
        provenance: body.userAsked
          ? { userInstruction: { messageId: 'preview', accountId }, taint: [] }
          : { taint: ['tool'] },
        ...(resource ? { resource } : {}),
        profile: { id: await ctx.setting('tools.permissionProfile', thread?.projectId), hash: '' },
      });
    });

    // ---- command prefix rules (FR-191) ------------------------------------------------------
    app.get('/api/v1/command-rules', async (req) => ({
      items: await store.listCommandRules(await accountOf(req)),
    }));

    app.post('/api/v1/command-rules', async (req, reply) => {
      const accountId = await accountOf(req);
      const view = await store.createCommandRule(accountId, commandBody.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.post('/api/v1/command-rules/test', async (req) => {
      const accountId = await accountOf(req);
      const body = commandTest.parse(req.body);
      let scopes: Scope[] | undefined;
      if (body.threadId || body.projectId) {
        scopes = [{ kind: 'global' }];
        if (body.threadId) {
          const t = await threadOf(accountId, body.threadId);
          scopes.push({ kind: 'session', ref: t.id }, { kind: 'thread', ref: t.id });
          if (t.projectId) scopes.push({ kind: 'project', ref: t.projectId });
        }
        if (body.projectId) scopes.push({ kind: 'project', ref: body.projectId });
      }
      return store.testCommand(accountId, body.command, scopes);
    });

    app.patch('/api/v1/command-rules/:id', async (req) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      return store.updateCommandRule(accountId, id, commandPatch.parse(req.body));
    });

    app.delete('/api/v1/command-rules/:id', async (req) => {
      const accountId = await accountOf(req);
      await store.deleteCommandRule(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // ---- grants (docs/12 §4.2) --------------------------------------------------------------
    app.get('/api/v1/permission-grants', async (req) => ({
      items: await store.listGrants(await accountOf(req)),
    }));

    app.delete('/api/v1/permission-grants/:id', async (req) => {
      const accountId = await accountOf(req);
      await store.revokeGrant(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // ---- permission profiles (FR-190) -------------------------------------------------------
    app.get('/api/v1/permission-profiles', async (req) => ({
      items: await store.listProfiles(await accountOf(req)),
    }));

    app.post('/api/v1/permission-profiles', async (req, reply) => {
      const accountId = await accountOf(req);
      const view = await store.createProfile(accountId, profileBody.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.delete('/api/v1/permission-profiles/:id', async (req) => {
      const accountId = await accountOf(req);
      await store.deleteProfile(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // ---- per-tool defaults (FR-048) ---------------------------------------------------------
    app.get('/api/v1/tool-defaults', async (req) => ({
      items: await store.listToolDefaults(await accountOf(req)),
    }));

    app.put('/api/v1/tool-defaults', async (req) => {
      const accountId = await accountOf(req);
      const body = toolDefaultSchema.parse(req.body);
      return store.setToolDefault(accountId, body.tool, body.default);
    });
  }

  return {
    gate,
    store,
    useServerDefaults: (fn) => gate.useServerDefaults(fn),
    useToolCatalog: (fn) => {
      catalog = fn;
    },
    useSubstrate: (fn) => gate.useSubstrate(fn),
    useHooks: (dispatcher) => gate.useHooks(dispatcher),
    usePluginPermissions: (source) => gate.usePluginPermissions(source),
    useProjectFolders: (source) => gate.useProjectFolders(source),
    register,
    close: () => gate.close(),
  };
}
