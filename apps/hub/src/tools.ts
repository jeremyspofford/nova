// The tool runtime in the Hub: registry, built-in tools, sandbox, artifacts, mentions and the
// tool routes (FR-022, FR-029, FR-038, FR-196; contracts/hub-api.md). The ChatService gets the
// runtime through `chatOptions`, so every model tool call passes the policy gate the policy
// area provides; POST /tools/:name/invoke passes the same gate with origin `ui`.
//
// M4: the loop's lifecycle hooks (`tool.pre`/`tool.post` in the runtime; `session.start`,
// `prompt.submit`, `stop`, `interrupt` in the ChatService) and the skills catalog reach the
// ChatService through `chatOptions` (FR-046, FR-197); a project's folders are tool roots for its
// chats (FR-035); GET /threads/:id/suggestions serves follow-up prompts (FR-028).
//
// M5: the runtime's sandbox is wrapped in ExecSessions, which lists the running exec sessions for
// the terminal pane (GET/DELETE /exec/sessions) and gives exec tools the `exec.sessions` yield
// time and output cap (FR-184); `context.remaining` / `context.fresh` share a tracker with the
// chat loop, which also gets the compaction and instruction-file settings (FR-183, FR-185).
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NovaError, idSchema, type ToolDescriptor } from '@nova/shared';
import {
  type HookDispatcher,
  type PluginPermissionSource,
  type ProjectFolderSource,
  type SkillCatalogProvider,
  ArtifactService,
  ExecSessions,
  SuggestionService,
  ToolRegistry,
  ToolRuntime,
  TurnContextTracker,
  builtinSource,
  builtinTools,
  contextTools,
  detectSandbox,
  loadPermissionProfile,
  projectFolderSource,
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
  documentTools,
  imageToolSource,
  pluginScaffoldTool,
  providerImageGenerator,
  artifactDocumentPreview,
  type ThreadPolicy,
  type ThreadPolicySource,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ToolsArea extends HubArea {
  /** Options merged into the ChatService (the tool loop hooks in here). */
  chatOptions: Partial<ChatServiceOptions>;
  /**
   * M5 loop options, merged into the ChatService next to `chatOptions`: the audit of turns
   * started without the user typing (FR-189), and compaction and instruction files with the
   * tracker the context tools share (FR-183, FR-185).
   */
  loopOptions: Pick<ChatServiceOptions, 'audit' | 'context'>;
  runtime: ToolRuntime;
  artifacts: ArtifactService;
  /** A registered tool's descriptor (for the policy area's POST /policy/evaluate). */
  catalog: (accountId: string, name: string) => Promise<ToolDescriptor | null>;
  /** The sandbox substrate in use, null without one (the `full` profile needs one). */
  substrate: () => SandboxClient['substrate'];
  /** The sandbox itself, shared with hooks and terminals (M4). */
  sandbox: SandboxClient;
  /** Exec sessions of the agent tools (FR-184): list, kill; a run's end kills its thread's. */
  execSessions: ExecSessions;
  /** Follow-up prompts (FR-028). */
  suggestions: SuggestionService;
  /**
   * Replace where a project's folders come from (FR-035); the policy area must use the same
   * source (`policy.useProjectFolders`), so the roots tools get and the roots the gate checks
   * agree. Defaults to the `project_folder` table.
   */
  useProjectFolders(source: ProjectFolderSource): void;
  /** A mode's per-thread profile and roots (Code sessions, runs); the gate reads the same. */
  useThreadPolicy(source: ThreadPolicySource): void;
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
  /** M4: lifecycle hooks, the skill catalog and plugin permissions (wired by the loop). */
  hooks?: HookDispatcher;
  skills?: SkillCatalogProvider;
  /** Enforced by the gate (`policy.usePluginPermissions`); accepted here for symmetry. */
  pluginPermissions?: PluginPermissionSource;
  /** A project's folders (FR-035); defaults to the `project_folder` table. */
  projectFolders?: ProjectFolderSource;
  /** MCP Apps' model context for a thread (FR-198), from the apps area. */
  appContext?: ChatServiceOptions['appContext'];
}

/**
 * Content endpoint policy: nothing loads or runs, even when opened directly (FR-038). Every
 * variant may be framed by Nova's own pages only (the Inspector), never by another site.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";
/** HTML may run its own inline scripts, always in a unique origin (never allow-same-origin). */
export const HTML_ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'";
/** PDFs: no `sandbox` directive, which blanks the browser's PDF viewer; nothing else loads. */
export const PDF_ARTIFACT_CSP = "default-src 'none'; object-src 'none'; frame-ancestors 'self'";

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
// `initiator: 'user'` only when the user clicked in a Nova client; an MCP App's own call is the
// default and carries no user instruction (FR-189, FR-198).
const invokeBody = z.object({
  args: z.unknown().optional(),
  threadId: idSchema.optional(),
  initiator: z.enum(['user', 'app']).optional(),
});
const threadParams = z.object({ id: idSchema });
const execSessionsQuery = z.object({ threadId: idSchema.optional() });

export function setupTools(ctx: HubContext & ToolsDeps): Promise<ToolsArea> {
  const log = ctx.log.child('tools');
  const workspace = join(ctx.dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const sandbox =
    ctx.sandbox ??
    detectSandbox({
      mode: process.env.NOVA_SANDBOX ?? 'auto',
      // The data directory (vault, rule files) is hidden wherever a root contains it.
      deniedPaths: [ctx.dataDir],
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
  // The loop and the context tools share what each running turn's context holds (FR-183).
  const turnContext = new TurnContextTracker();
  const builtins = [
    ...builtinTools({
      artifacts,
      searxngUrl,
      paths,
      ...(ctx.web ? { web: ctx.web } : {}),
    }),
    ...contextTools(turnContext),
    // M5: document outputs (FR-219) and plugin drafts (FR-050).
    ...documentTools({ artifacts, paths }),
    pluginScaffoldTool({ dataDir: ctx.dataDir, novaVersion: ctx.config.version }),
  ];
  // Agent commands run through ExecSessions; hooks and terminals keep the bare sandbox.
  const execSessions = new ExecSessions(sandbox, {
    settings: () => ctx.setting('exec.sessions'),
    events: ctx.events,
    audit: ctx.audit,
  });
  const registry = new ToolRegistry({
    sources: [
      builtinSource(builtins, searxngUrl),
      // Image generation (FR-030) is listed only while a provider can make images.
      imageToolSource({
        artifacts,
        generator: providerImageGenerator({
          registry: ctx.registry,
          allowCloud: () => ctx.setting('routing.allowCloud'),
        }),
      }),
      ...ctx.sources,
    ],
    log,
  });
  let folders: ProjectFolderSource = ctx.projectFolders ?? projectFolderSource(ctx.db);
  const threadPolicies: ThreadPolicySource[] = [];
  const runtime = new ToolRuntime({
    db: ctx.db,
    events: ctx.events,
    gate: ctx.gate,
    registry,
    sandbox: execSessions,
    audit: ctx.audit,
    scope:
      ctx.scope ??
      settingsScope(
        ctx,
        workspace,
        (projectId) => folders(projectId),
        () => threadPolicies,
      ),
    deferBudget: (projectId) => ctx.setting('tools.deferBudget', projectId),
    paths,
    log,
    ...(ctx.hooks ? { hooks: ctx.hooks } : {}),
  });
  const suggestions = new SuggestionService({
    db: ctx.db,
    router: ctx.router,
    enabled: async (projectId) => (await ctx.setting('chat.suggestions', projectId)) === true,
    log: log.child('suggestions'),
  });
  const waitMs = ctx.invokeWaitMs ?? 60_000;
  const chatOptions: Partial<ChatServiceOptions> = { tools: runtime };
  const loopOptions: ToolsArea['loopOptions'] = {
    audit: ctx.audit,
    context: {
      tracker: turnContext,
      compactThreshold: (projectId) => ctx.setting('context.compactThreshold', projectId),
      // Security-relevant: user or managed settings only, never a project's (FR-185).
      instructionFiles: () => ctx.setting('instructions.files'),
      projectFolders: (projectId) => folderRoots(folders, projectId),
    },
  };
  if (ctx.hooks) chatOptions.hooks = ctx.hooks;
  if (ctx.skills) chatOptions.skills = ctx.skills;
  if (ctx.appContext) chatOptions.appContext = ctx.appContext;

  return Promise.resolve({
    chatOptions,
    loopOptions,
    runtime,
    artifacts,
    catalog: async (accountId, name) => (await registry.find(accountId, name))?.descriptor ?? null,
    substrate: () => sandbox.substrate,
    sandbox,
    execSessions,
    suggestions,
    useProjectFolders: (source) => {
      folders = source;
    },
    useThreadPolicy: (source) => {
      threadPolicies.push(source);
    },
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
          initiator: body.initiator ?? 'app',
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

      // A document artifact's text, headings, tables and slides, extracted on the Hub (FR-219).
      app.get('/api/v1/artifacts/:id/preview', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const q = contentQuery.parse(req.query);
        return artifactDocumentPreview(artifacts, accountId, id, q.version);
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
          // The Inspector frames it; the global DENY would blank the frame.
          .header('X-Frame-Options', 'SAMEORIGIN')
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

      // Follow-up prompts for an idle thread (FR-028): empty when off, temporary or waiting.
      app.get('/api/v1/threads/:id/suggestions', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = threadParams.parse(req.params);
        return { items: await suggestions.forThread(accountId, id) };
      });

      // Running exec sessions of the agent's commands, for the terminal pane (FR-184).
      app.get('/api/v1/exec/sessions', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = execSessionsQuery.parse(req.query);
        if (q.threadId) await ctx.threads.row(accountId, q.threadId);
        return { items: execSessions.list(accountId, q.threadId) };
      });

      // Kill one (the pane's stop button); another account's session is not found.
      app.delete('/api/v1/exec/sessions/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        if (!(await execSessions.kill(accountId, id)))
          throw new NovaError('not_found', 'no running command with this session id');
        return { ok: true };
      });
    },
    close: async () => {
      suggestions.close();
      await runtime.close();
    },
  });
}

/**
 * Roots and profile of a thread, resolved exactly as the policy gate resolves them
 * (`loadPermissionProfile` + `resolveToolRoots`, FR-190), so the roots a tool may touch, the
 * roots the engine checks and the profile hash in the audit agree. The host filesystem root is
 * never a tool root: the `full` profile's "whole filesystem" is the sandbox guest's (docs/12
 * §7.1); on the Hub it falls back to the project roots, writable.
 */
export function settingsScope(
  ctx: HubContext,
  workspace: string,
  folders: ProjectFolderSource = projectFolderSource(ctx.db),
  threadPolicies: () => readonly ThreadPolicySource[] = () => [],
): ToolRuntimeOptions['scope'] {
  return async ({ accountId, threadId, projectId }): Promise<ToolScope> => {
    // A Code session's (or run's) permission mode sets the profile and roots of its thread,
    // exactly as the gate reads them (FR-063, FR-190); a source that throws fails the turn.
    let policy: ThreadPolicy | null = null;
    if (threadId)
      for (const source of threadPolicies()) {
        policy = await source.forThread(accountId, threadId);
        if (policy) break;
      }
    const id = policy?.profileId ?? (await ctx.setting('tools.permissionProfile', projectId));
    const { profile } = await loadPermissionProfile(ctx.db, accountId, id);
    // A project's folders are roots for its chats (FR-035), exactly as the gate adds them.
    const extra = policy?.roots ?? [
      ...(await ctx.setting('tools.roots')),
      ...(await folderRoots(folders, projectId)),
    ];
    // A session's roots replace the workspace too: its folder is its only (and first) root, so
    // relative paths, exec's working folder and instruction files resolve there.
    const own = policy?.roots ? null : workspace;
    const resolved = resolveToolRoots({
      profile,
      roots: extra,
      workspaceDir: own,
    });
    let roots: ToolRoot[] = resolved.roots.filter((r) => dirname(r.path) !== r.path);
    if (!roots.length && resolved.roots.length) {
      roots = [
        ...(own ? [{ path: own, access: 'write' as const, label: 'Workspace' }] : []),
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

async function folderRoots(folders: ProjectFolderSource, projectId: string | null) {
  if (!projectId) return [];
  try {
    return await folders(projectId);
  } catch {
    // Without them the folders are not roots: less access, never more.
    return [];
  }
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
