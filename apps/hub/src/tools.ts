// The tool runtime in the Hub: registry, built-in tools, sandbox, artifacts, mentions and the
// tool routes (FR-022, FR-029, FR-038, FR-196; contracts/hub-api.md). The ChatService gets the
// runtime through `chatOptions`, so every model tool call passes the policy gate the policy
// area provides; POST /tools/:name/invoke passes the same gate with origin `ui`.
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idSchema, type ToolDescriptor } from '@nova/shared';
import {
  ArtifactService,
  ToolRegistry,
  ToolRuntime,
  builtinSource,
  builtinTools,
  detectSandbox,
  loadPermissionProfile,
  resolveToolRoots,
  type AuditSink,
  type ChatServiceOptions,
  type Notifier,
  type PathPolicy,
  type SandboxClient,
  type ToolGate,
  type ToolRoot,
  type ToolRuntimeOptions,
  type ToolScope,
  type ToolSourceProvider,
  type WebToolOptions,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ToolsArea extends HubArea {
  /** Options merged into the ChatService (the tool loop hooks in here). */
  chatOptions: Partial<ChatServiceOptions>;
  runtime: ToolRuntime;
  artifacts: ArtifactService;
  /** A registered tool's descriptor (for the policy area's POST /policy/evaluate). */
  catalog: (accountId: string, name: string) => Promise<ToolDescriptor | null>;
  /** The sandbox substrate in use, null without one (the `full` profile needs one). */
  substrate: () => SandboxClient['substrate'];
}

export interface ToolsDeps {
  gate: ToolGate;
  sources: ToolSourceProvider[];
  audit: AuditSink;
  notifier: Notifier;
  /** Roots and profile of a thread; defaults to the settings-based helper below. */
  scope?: ToolRuntimeOptions['scope'];
  /** Replace the sandbox (tests); defaults to docker or podman when installed. */
  sandbox?: SandboxClient;
  /** Web fetch options (tests replace fetch and DNS). */
  web?: Omit<WebToolOptions, 'searxngUrl'>;
  /** How long POST /tools/:name/invoke waits for a call (and its approval): 60 s. */
  invokeWaitMs?: number;
}

/** Content endpoint policy: nothing loads or runs, even when opened directly (FR-038). */
export const ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; sandbox";
/** HTML may run its own inline scripts, always in a unique origin (never allow-same-origin). */
export const HTML_ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";
/** PDFs: no `sandbox` directive, which blanks the browser's PDF viewer; nothing else loads. */
export const PDF_ARTIFACT_CSP = "default-src 'none'; object-src 'none'";

export function artifactCsp(kind: string): string {
  if (kind === 'html') return HTML_ARTIFACT_CSP;
  if (kind === 'pdf') return PDF_ARTIFACT_CSP;
  return ARTIFACT_CSP;
}

const params = z.object({ id: idSchema });
const toolParams = z.object({ name: z.string().min(1).max(200) });
const listQuery = z.object({ threadId: idSchema.optional() });
const artifactsQuery = z.object({ threadId: idSchema });
// Unknown query parameters (the UI's `v` cache-buster) are ignored.
const contentQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const mentionsQuery = z.object({
  q: z.string().max(200).default(''),
  threadId: idSchema.optional(),
});
const invokeBody = z.object({ args: z.unknown().optional(), threadId: idSchema.optional() });

export function setupTools(ctx: HubContext & ToolsDeps): Promise<ToolsArea> {
  const log = ctx.log.child('tools');
  const workspace = join(ctx.dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const sandbox =
    ctx.sandbox ??
    detectSandbox({
      mode: process.env.NOVA_SANDBOX ?? 'auto',
      ...(process.env.NOVA_SANDBOX_IMAGE ? { image: process.env.NOVA_SANDBOX_IMAGE } : {}),
      ...(process.env.NOVA_SANDBOX_NETWORK === 'open' ? { allowedNetwork: 'open' as const } : {}),
    });
  ctx.diagnostics.add('sandbox', async () => {
    const a = await sandbox.available();
    return { substrate: sandbox.substrate, available: a.ok, detail: a.detail };
  });

  const artifacts = new ArtifactService({ db: ctx.db, events: ctx.events, dataDir: ctx.dataDir });
  const searxngUrl = () => ctx.setting('search.searxngUrl');
  // The data folder holds the database, the vault and blobs: no tool touches it, except the
  // workspace inside it (docs/12 §7.2).
  const paths: PathPolicy = { denied: [ctx.dataDir], allowed: [workspace] };
  const builtins = builtinTools({
    artifacts,
    searxngUrl,
    paths,
    ...(ctx.web ? { web: ctx.web } : {}),
  });
  const registry = new ToolRegistry({
    sources: [builtinSource(builtins, searxngUrl), ...ctx.sources],
    log,
  });
  const runtime = new ToolRuntime({
    db: ctx.db,
    events: ctx.events,
    gate: ctx.gate,
    registry,
    sandbox,
    audit: ctx.audit,
    scope: ctx.scope ?? settingsScope(ctx, workspace),
    deferBudget: (projectId) => ctx.setting('tools.deferBudget', projectId),
    paths,
    log,
  });
  const waitMs = ctx.invokeWaitMs ?? 60_000;

  return Promise.resolve({
    chatOptions: { tools: runtime },
    runtime,
    artifacts,
    catalog: async (accountId, name) => (await registry.find(accountId, name))?.descriptor ?? null,
    substrate: () => sandbox.substrate,
    register(app: FastifyInstance) {
      app.get('/api/v1/tools', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = listQuery.parse(req.query);
        return { items: await runtime.views(accountId, q.threadId ?? null) };
      });

      // A tool run from the UI passes the gate like a model call; an approval that is not
      // answered within the wait leaves the call pending and answers 202 with its approval.
      app.post('/api/v1/tools/:name/invoke', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { name } = toolParams.parse(req.params);
        const body = invokeBody.parse(req.body ?? {});
        const { callId, done } = await runtime.invoke({
          accountId,
          name,
          args: body.args ?? {},
          threadId: body.threadId ?? null,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = await Promise.race([
          done,
          new Promise<null>((r) => {
            timer = setTimeout(() => r(null), waitMs);
          }),
        ]);
        clearTimeout(timer);
        if (waited) {
          const out: { ok: boolean; text: string; error?: { code: string; message: string } } = {
            ok: waited.ok,
            text: waited.text,
          };
          if (waited.error) out.error = waited.error;
          return out;
        }
        void reply.status(202);
        return { approvalId: runtime.pendingApproval(callId), callId };
      });

      app.get('/api/v1/artifacts', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = artifactsQuery.parse(req.query);
        await ctx.threads.row(accountId, q.threadId);
        return { items: await artifacts.list(accountId, q.threadId) };
      });

      app.get('/api/v1/artifacts/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        return artifacts.get(accountId, id);
      });

      app.get('/api/v1/artifacts/:id/content', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const q = contentQuery.parse(req.query);
        const { view, mime, bytes } = await artifacts.content(accountId, id, q.version);
        const download = view.kind === 'file';
        void reply
          .header('Content-Type', mime)
          .header('Content-Security-Policy', artifactCsp(view.kind))
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .header('Cache-Control', 'private, no-cache')
          .header(
            'Content-Disposition',
            `${download ? 'attachment' : 'inline'}; filename="${safeName(view.title ?? view.id, view.kind)}"`,
          );
        return reply.send(bytes);
      });

      app.get('/api/v1/mentions', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = mentionsQuery.parse(req.query);
        return { items: await runtime.mentionCandidates(accountId, q.q, q.threadId ?? null) };
      });
    },
    close: () => runtime.close(),
  });
}

/**
 * Roots and profile of a thread, resolved exactly as the policy gate resolves them
 * (`loadPermissionProfile` + `resolveToolRoots`, FR-190), so the roots a tool may touch, the
 * roots the engine checks and the profile hash in the audit agree. The host filesystem root is
 * never a tool root: the `full` profile's "whole filesystem" is the sandbox guest's (docs/12
 * §7.1); on the Hub it falls back to the project roots, writable.
 */
export function settingsScope(ctx: HubContext, workspace: string): ToolRuntimeOptions['scope'] {
  return async ({ accountId, projectId }): Promise<ToolScope> => {
    const id = await ctx.setting('tools.permissionProfile', projectId);
    const { profile } = await loadPermissionProfile(ctx.db, accountId, id);
    const resolved = resolveToolRoots({
      profile,
      roots: await ctx.setting('tools.roots'),
      workspaceDir: workspace,
    });
    let roots: ToolRoot[] = resolved.roots.filter((r) => dirname(r.path) !== r.path);
    if (!roots.length && resolved.roots.length) {
      const extra = await ctx.setting('tools.roots');
      roots = [
        { path: workspace, access: 'write', label: 'Workspace' },
        ...extra.map((r) => ({
          path: resolve(r.path),
          access: r.access,
          label: r.label ?? (basename(r.path) || r.path),
        })),
      ];
    }
    return {
      roots,
      profile: resolved.profile,
      network: resolved.network.mode,
      deny: resolved.deny,
    };
  };
}

function safeName(title: string, kind: string): string {
  const ext: Record<string, string> = {
    markdown: '.md',
    html: '.html',
    svg: '.svg',
    chart: '.json',
    pdf: '.pdf',
  };
  const base = title.replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 100) || 'artifact';
  const suffix = ext[kind] ?? '';
  return base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
}
