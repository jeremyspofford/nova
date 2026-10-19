// Nova's own MCP server for external clients and their per-client tokens (FR-044, FR-192;
// docs/08 §2.2, docs/12 §15, ADR-075). Exposure is off until the user adds a client: each client
// is an app authorization with its own token (shown once, stored as a hash), scoped to tools,
// projects, a thread scope and read-only or run-allowed, with an expiry. `/mcp` speaks streamable
// HTTP and needs that token; Origin and Host are checked by the Hub's guard like every route.
// Every call passes the policy gate with origin `mcp_client` (never user-typed authorization,
// FR-189) and is audited with the client id. Revoking a client closes its sessions at once.
//
// M7 (FR-044): resources and prompts. Resources are the client's chats as transcripts
// (`nova://threads/<id>`, when its thread scope allows) and its projects' files, read-only
// (`nova://projects/<projectId>/files/<path>`, through the project's folders); prompts are the
// account's active skills, for clients whose tool scope includes `skill.load`. Every read and
// every prompt passes the gate like a tool call and is audited as `client.call`; anything out of
// scope reads exactly like something that does not exist. Stdio-only clients reach `/mcp` through
// the stdio launcher (`node packages/mcp/src/launcher-main.ts mcp stdio`, @nova/mcp), which adds
// the client's token.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  createAppAuthorizationSchema,
  idSchema,
  uuidv7,
  type AppAuthorizationCreated,
  type AppAuthorizationView,
  type ToolDescriptor,
} from '@nova/shared';
import {
  ProjectService,
  projectFolderSource,
  resolveInRoots,
  type AuditSink,
  type GateRequest,
  type ToolGate,
  type ToolRuntime,
} from '@nova/core';
import {
  NovaMcpServer,
  type McpClientRef,
  type ServedPrompts,
  type ServedResources,
  type ServedTool,
} from '@nova/mcp';
import { defaultRedactor, hashToken, newToken } from '@nova/security';
import { schema } from '@nova/storage';
import type { HubArea, HubContext } from './hub-context.ts';
import type { ToolsArea } from './tools.ts';

const { appAuthorization, setting, project } = schema;
type AuthRow = typeof appAuthorization.$inferSelect;
type Scopes = AppAuthorizationView['scopes'];

export const MCP_ENDPOINT = '/mcp';
const DEFAULT_EXPIRY_DAYS = 90;
/** `last_used_at` is written at most this often per client. */
const TOUCH_INTERVAL_MS = 60_000;
/** Text a client can read from one call (threads are long). */
const MAX_TEXT = 200_000;
/**
 * Tools that only make sense inside a Nova turn, and `script.run` (FR-202): it is read-only itself
 * but calls other tools, so serving it would let a read-only client reach write tools.
 */
const NEVER_SERVED = new Set(['tool.search', 'script.run']);
const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

export interface McpServerArea extends HubArea {
  /** The streamable HTTP host (tests count sessions). */
  server: NovaMcpServer;
}

/** The account's skills, served as prompts (the plugins area's skill index). */
export interface McpServerSkills {
  list(accountId: string): Promise<{ name: string; description: string; active: boolean }[]>;
  resolve(accountId: string, name: string): Promise<{ name: string; body: string } | null>;
}

/** Files a client may read as a resource (FR-044): text only, at most 1 MiB. */
const MAX_RESOURCE_BYTES = 1024 * 1024;
const THREAD_URI = /^nova:\/\/threads\/([A-Za-z0-9-]{1,100})$/;
const FILE_URI = /^nova:\/\/projects\/([A-Za-z0-9-]{1,100})\/files\/(.+)$/;
const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.csv': 'text/csv',
};

const params = z.object({ id: idSchema });
const threadsListArgs = z
  .object({
    projectId: idSchema.optional(),
    q: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().max(500).optional(),
  })
  .strict();
const threadsReadArgs = z.object({ threadId: idSchema }).strict();

function parseScopes(text: string): Scopes {
  try {
    const s = JSON.parse(text) as Scopes;
    return {
      tools: s.tools === '*' || Array.isArray(s.tools) ? s.tools : [],
      projects: s.projects === '*' || Array.isArray(s.projects) ? s.projects : [],
      threads: s.threads === 'read' || s.threads === 'read_write' ? s.threads : 'none',
      mode: s.mode === 'run_allowed' ? 'run_allowed' : 'read_only',
    };
  } catch {
    // Unreadable scopes grant nothing (fail closed).
    return { tools: [], projects: [], threads: 'none', mode: 'read_only' };
  }
}

function toView(row: AuthRow): AppAuthorizationView {
  return {
    id: row.id,
    kind: row.kind,
    clientName: row.clientName,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** A Nova tool name as an MCP tool name (`mcp:files.search` → `mcp_files.search`). */
export function servedName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated]` : text;
const out = (value: unknown) => clip(defaultRedactor.redactString(JSON.stringify(value, null, 2)));

export function setupMcpServer(
  ctx: HubContext & {
    audit: AuditSink;
    gate: ToolGate;
    tools: ToolsArea;
    /** Skills served as prompts (FR-044); none without it. */
    skills?: McpServerSkills;
  },
): Promise<McpServerArea> {
  const { db, events, audit, gate, accountOf } = ctx;
  const runtime: ToolRuntime = ctx.tools.runtime;
  const log = ctx.log.child('mcp-server');
  const projects = new ProjectService({ db });
  const touched = new Map<string, number>();

  // ---- authorizations ---------------------------------------------------------------------

  async function active(id: string): Promise<AuthRow | null> {
    const [row] = await db.orm
      .select()
      .from(appAuthorization)
      .where(and(eq(appAuthorization.id, id), eq(appAuthorization.status, 'active')));
    if (!row) return null;
    if (row.expiresAt && row.expiresAt <= new Date().toISOString()) return null;
    return row;
  }

  /** The client a bearer token belongs to: active, not expired, an MCP client. */
  async function verify(token: string): Promise<AuthRow | null> {
    if (!token.startsWith('nvm_') || token.length > 200) return null;
    const [row] = await db.orm
      .select()
      .from(appAuthorization)
      .where(eq(appAuthorization.tokenHash, hashToken(token)));
    if (!row || row.kind !== 'mcp_client' || row.status !== 'active') return null;
    const now = new Date();
    if (row.expiresAt && row.expiresAt <= now.toISOString()) return null;
    const last = touched.get(row.id) ?? 0;
    if (now.getTime() - last >= TOUCH_INTERVAL_MS) {
      touched.set(row.id, now.getTime());
      await db.transaction(() =>
        db.orm
          .update(appAuthorization)
          .set({ lastUsedAt: now.toISOString() })
          .where(eq(appAuthorization.id, row.id)),
      );
    }
    return row;
  }

  async function enableServer(accountId: string): Promise<void> {
    const key = 'mcpServer.enabled';
    if (await ctx.setting(key)) return;
    const now = new Date().toISOString();
    await db.transaction(async () => {
      await db.orm
        .delete(setting)
        .where(
          and(eq(setting.key, key), eq(setting.scopeKind, 'global'), eq(setting.scopeRef, '')),
        );
      await db.orm
        .insert(setting)
        .values({ key, scopeKind: 'global', scopeRef: '', valueJson: 'true', updatedAt: now });
    });
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId,
      payload: { key, scope: 'global' },
    });
  }

  async function changed(row: AuthRow, status: 'active' | 'revoked'): Promise<void> {
    await events.emit({
      name: 'app.authorization.changed',
      actor: 'user',
      accountId: row.accountId,
      payload: { authorizationId: row.id, kind: row.kind, clientName: row.clientName, status },
    });
    await audit.append({
      accountId: row.accountId,
      actor: 'user',
      kind: 'auth',
      action: status === 'active' ? 'app_authorization.create' : 'app_authorization.revoke',
      resource: `app_authorization:${row.id}`,
      detail: { kind: row.kind, clientName: row.clientName, scopes: parseScopes(row.scopes) },
    });
  }

  // ---- what a client sees -------------------------------------------------------------------

  const inProjects = (scopes: Scopes, projectId: string | null) =>
    scopes.projects === '*' || (projectId !== null && scopes.projects.includes(projectId));

  interface CallSpec {
    row: AuthRow;
    tool: string;
    descriptor: ToolDescriptor;
    args: Record<string, unknown>;
    signal: AbortSignal;
    /** What the call touches, for the engine (a file's path). */
    resource?: GateRequest['resource'];
  }

  async function auditCall(
    spec: Pick<CallSpec, 'row' | 'tool'>,
    detail: { callId: string; decision: string | null; result: string },
  ): Promise<void> {
    await audit.append({
      accountId: spec.row.accountId,
      actor: `mcp_client:${spec.row.id}`,
      kind: 'mcp',
      action: 'client.call',
      resource: `app_authorization:${spec.row.id}`,
      decision: detail.decision,
      result: detail.result,
      detail: {
        clientId: spec.row.id,
        clientName: spec.row.clientName,
        tool: spec.tool,
        callId: detail.callId,
      },
    });
  }

  /**
   * Nova's own read tools pass the gate like any tool, as an external agent's request (no user
   * instruction behind it); a deny is answered as an error, an ask waits for the user.
   */
  async function gated(
    spec: CallSpec,
    run: () => Promise<string>,
  ): Promise<{ text: string; isError: boolean }> {
    const callId = uuidv7();
    const scope = await runtime.scopeFor(spec.row.accountId, null, null);
    let decision: string | null = null;
    try {
      const outcome = await gate.check(
        {
          accountId: spec.row.accountId,
          threadId: '',
          turnId: '',
          callId,
          projectId: null,
          mode: 'agent',
          tool: spec.descriptor,
          args: spec.args,
          argsPreview: clip(defaultRedactor.redactString(JSON.stringify(spec.args))).slice(0, 500),
          provenance: { taint: ['external_agent'] },
          profile: scope.profile,
          origin: 'mcp_client',
          roots: scope.roots,
          ...(spec.resource ? { resource: spec.resource } : {}),
        },
        spec.signal,
      );
      decision = outcome.effect;
      if (outcome.effect !== 'allow') {
        await auditCall(spec, { callId, decision, result: 'denied' });
        return { text: `Not allowed: ${outcome.reason}`, isError: true };
      }
      const text = await run();
      await auditCall(spec, { callId, decision, result: 'ok' });
      return { text, isError: false };
    } catch (err) {
      const message = err instanceof NovaError ? err.message : 'the request failed';
      await auditCall(spec, { callId, decision, result: 'error' });
      return { text: `Error: ${message}`, isError: true };
    }
  }

  const readDescriptor = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
  ): ToolDescriptor => ({
    name,
    title,
    description,
    source: 'builtin',
    inputSchema,
    annotations: { readOnly: true, idempotent: true, action: 'read' },
  });

  const PROJECTS_LIST = readDescriptor(
    'projects.list',
    'List projects',
    'List the Nova projects this client may see: id, name and when each changed.',
    { type: 'object', properties: {}, additionalProperties: false },
  );
  const THREADS_LIST = readDescriptor(
    'threads.list',
    'List chats',
    'List Nova chats this client may see, newest first. Optional: projectId, q (search text), limit (1-50), cursor (from the previous page).',
    {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
  );
  const THREADS_READ = readDescriptor(
    'threads.read',
    'Read a chat',
    'Read the messages of one Nova chat (its current path), oldest first.',
    {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId'],
      additionalProperties: false,
    },
  );

  async function listProjects(row: AuthRow, scopes: Scopes): Promise<string> {
    const items = (await projects.list(row.accountId)).filter((p) => inProjects(scopes, p.id));
    return out(
      items.map((p) => ({
        id: p.id,
        name: p.name,
        threadCount: p.threadCount,
        updatedAt: p.updatedAt,
      })),
    );
  }

  async function listThreads(
    row: AuthRow,
    scopes: Scopes,
    raw: Record<string, unknown>,
  ): Promise<string> {
    const a = threadsListArgs.parse(raw);
    if (a.projectId && !inProjects(scopes, a.projectId))
      throw new NovaError('not_found', 'project not found');
    const limit = a.limit ?? 20;
    const shape = (t: {
      id: string;
      title: string | null;
      projectId: string | null;
      mode: string;
      updatedAt: string;
    }) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      mode: t.mode,
      updatedAt: t.updatedAt,
    });
    // Temporary chats are never shared with clients.
    if (a.projectId || scopes.projects === '*') {
      const page = await ctx.threads.list(row.accountId, {
        projectId: a.projectId,
        q: a.q,
        cursor: a.cursor,
        limit,
      });
      const items = page.items.filter((t) => !t.temporary && inProjects(scopes, t.projectId));
      return out({ items: items.map(shape), nextCursor: page.nextCursor });
    }
    // A client limited to some projects sees the newest chats across them (no paging).
    const all = [];
    for (const projectId of scopes.projects) {
      const page = await ctx.threads.list(row.accountId, { projectId, q: a.q, limit });
      all.push(...page.items.filter((t) => !t.temporary));
    }
    all.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
    return out({ items: all.slice(0, limit).map(shape), nextCursor: null });
  }

  async function readThread(
    row: AuthRow,
    scopes: Scopes,
    raw: Record<string, unknown>,
  ): Promise<string> {
    const { threadId } = threadsReadArgs.parse(raw);
    const detail = await ctx.threads.detail(row.accountId, threadId);
    // Out of scope reads exactly like a chat that does not exist.
    if (detail.thread.temporary || !inProjects(scopes, detail.thread.projectId))
      throw new NovaError('not_found', 'thread not found');
    return out({
      id: detail.thread.id,
      title: detail.thread.title,
      projectId: detail.thread.projectId,
      messages: detail.messages.map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        text: m.parts
          .map((p) =>
            p.type === 'text' ? p.text : p.type === 'tool_call' ? `[tool ${p.tool}]` : '',
          )
          .filter(Boolean)
          .join('\n'),
      })),
    });
  }

  async function toolsFor(client: McpClientRef): Promise<ServedTool[]> {
    const row = await active(client.id);
    if (!row) return [];
    const scopes = parseScopes(row.scopes);
    const served: ServedTool[] = [];
    const data = (
      d: ToolDescriptor,
      run: (args: Record<string, unknown>) => Promise<string>,
    ): ServedTool => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: d.inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      call: (args, signal) =>
        gated({ row, tool: d.name, descriptor: d, args, signal }, () => run(args)),
    });
    if (scopes.projects === '*' || scopes.projects.length)
      served.push(data(PROJECTS_LIST, () => listProjects(row, scopes)));
    if (scopes.threads !== 'none') {
      served.push(data(THREADS_LIST, (args) => listThreads(row, scopes, args)));
      served.push(data(THREADS_READ, (args) => readThread(row, scopes, args)));
    }
    if (scopes.tools !== '*' && !scopes.tools.length) return served;
    const taken = new Set(served.map((t) => t.name));
    for (const def of await runtime.registry.list(row.accountId)) {
      const d = def.descriptor;
      if (NEVER_SERVED.has(d.name)) continue;
      if (scopes.tools !== '*' && !scopes.tools.includes(d.name)) continue;
      // Read-only clients get only tools whose action is a read (FR-044).
      if (scopes.mode === 'read_only' && d.annotations?.action !== 'read') continue;
      const name = servedName(d.name);
      if (taken.has(name)) continue;
      taken.add(name);
      served.push({
        name,
        title: d.title,
        description: d.description,
        inputSchema: d.inputSchema,
        annotations: {
          readOnlyHint: d.annotations?.action === 'read',
          ...(d.annotations?.destructive ? { destructiveHint: true } : {}),
          ...(d.annotations?.idempotent ? { idempotentHint: true } : {}),
          openWorldHint: d.annotations?.requiresNetwork === true,
        },
        call: (args, signal) => runTool(row, d.name, args, signal),
      });
    }
    return served;
  }

  // ---- resources and prompts (FR-044) ----------------------------------------------------------

  const folders = projectFolderSource(db);
  const FILES_READ = readDescriptor(
    'fs.read',
    'Read a file',
    "Read a file of one of the client's projects.",
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  );
  const SKILLS_LIST = readDescriptor(
    'skills.list',
    'List skills',
    "List the user's skills a client may use as prompts.",
    { type: 'object', properties: {}, additionalProperties: false },
  );
  const SKILL_LOAD = readDescriptor(
    'skill.load',
    'Load a skill',
    "Load one of the user's skills as a prompt.",
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  );

  /** The client's newest chats (temporary chats never), as `listThreads` scopes them. */
  async function scopedThreads(row: AuthRow, scopes: Scopes, limit: number) {
    if (scopes.threads === 'none') return [];
    if (scopes.projects === '*')
      return (await ctx.threads.list(row.accountId, { limit })).items.filter((t) => !t.temporary);
    const all = [];
    for (const projectId of scopes.projects)
      all.push(
        ...(await ctx.threads.list(row.accountId, { projectId, limit })).items.filter(
          (t) => !t.temporary,
        ),
      );
    all.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
    return all.slice(0, limit);
  }

  async function threadMarkdown(row: AuthRow, scopes: Scopes, threadId: string): Promise<string> {
    const detail = await ctx.threads.detail(row.accountId, threadId);
    if (detail.thread.temporary || !inProjects(scopes, detail.thread.projectId))
      throw new NovaError('not_found', 'thread not found');
    const lines = [`# ${detail.thread.title ?? 'Untitled chat'}`, ''];
    for (const m of detail.messages) {
      const text = m.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_call' ? `[tool ${p.tool}]` : ''))
        .filter(Boolean)
        .join('\n');
      if (text) lines.push(`## ${m.role} (${m.createdAt})`, '', text, '');
    }
    return clip(defaultRedactor.redactString(lines.join('\n')));
  }

  /**
   * The real path of a file in one of the account's projects' folders (never outside them, never
   * the data folder), resolved once: the gate is asked about this path and this path is read.
   */
  async function projectFilePath(
    accountId: string,
    projectId: string,
    path: string,
  ): Promise<string> {
    const owned = db.raw
      .prepare('SELECT 1 FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(projectId, accountId);
    if (!owned) throw new NovaError('not_found', 'project not found');
    const roots = (await folders(projectId)).map((f) => ({
      path: f.path,
      access: 'read' as const,
      label: f.label ?? f.path,
    }));
    return resolveInRoots(roots, decodeURIComponent(path), 'read', { denied: [ctx.dataDir] }).path;
  }

  /** A text file's content, opened without following a link swapped in since it was resolved. */
  function readTextFile(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_RESOURCE_BYTES)
        throw new NovaError('not_found', 'not a readable file');
      const buf = readFileSync(fd);
      if (buf.includes(0)) throw new NovaError('not_found', 'not a text file');
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  /** Listing passes the gate like a tool call too; a denied listing is empty. */
  const listGated = async (
    row: AuthRow,
    descriptor: ToolDescriptor,
    signal: AbortSignal,
  ): Promise<boolean> =>
    !(
      await gated({ row, tool: descriptor.name, descriptor, args: {}, signal }, () =>
        Promise.resolve('listed'),
      )
    ).isError;

  const resources: ServedResources = {
    async list(client, signal) {
      const row = await active(client.id);
      if (!row) return [];
      const scopes = parseScopes(row.scopes);
      if (scopes.threads === 'none' || !(await listGated(row, THREADS_LIST, signal))) return [];
      return (await scopedThreads(row, scopes, 50)).map((t) => ({
        uri: `nova://threads/${t.id}`,
        name: t.title ?? 'Untitled chat',
        description: `Chat transcript, updated ${t.updatedAt}`,
        mimeType: 'text/markdown',
      }));
    },
    async templates(client) {
      const row = await active(client.id);
      if (!row) return [];
      const scopes = parseScopes(row.scopes);
      if (scopes.projects !== '*' && !scopes.projects.length) return [];
      if (!(await listGated(row, PROJECTS_LIST, new AbortController().signal))) return [];
      return [
        {
          uriTemplate: 'nova://projects/{projectId}/files/{+path}',
          name: 'Project files',
          description: "A file in one of a project's folders, read-only.",
        },
      ];
    },
    async read(client, uri, signal) {
      const row = await active(client.id);
      if (!row) return null;
      const scopes = parseScopes(row.scopes);
      const thread = THREAD_URI.exec(uri);
      if (thread) {
        if (scopes.threads === 'none') return null;
        const threadId = thread[1]!;
        let text = '';
        const r = await gated(
          { row, tool: 'threads.read', descriptor: THREADS_READ, args: { threadId }, signal },
          async () => (text = await threadMarkdown(row, scopes, threadId)),
        );
        return r.isError ? null : { uri, mimeType: 'text/markdown', text };
      }
      const file = FILE_URI.exec(uri);
      if (file) {
        const projectId = file[1]!;
        if (!inProjects(scopes, projectId)) return null;
        let text = '';
        let path: string;
        try {
          path = await projectFilePath(row.accountId, projectId, file[2]!);
        } catch {
          return null;
        }
        const r = await gated(
          {
            row,
            tool: 'fs.read',
            descriptor: FILES_READ,
            args: { path },
            signal,
            resource: { kind: 'path', value: path },
          },
          () => Promise.resolve((text = readTextFile(path))),
        );
        if (r.isError) return null;
        return { uri, mimeType: MIME[extname(path).toLowerCase()] ?? 'text/plain', text };
      }
      return null;
    },
  };

  /** Skills are prompts for clients whose tools include `skill.load` (or every tool). */
  const promptsOf = async (client: McpClientRef) => {
    const row = await active(client.id);
    if (!row || !ctx.skills) return null;
    const scopes = parseScopes(row.scopes);
    if (scopes.tools !== '*' && !scopes.tools.includes('skill.load')) return null;
    return row;
  };
  const prompts: ServedPrompts = {
    async list(client) {
      const row = await promptsOf(client);
      if (!row || !ctx.skills) return [];
      if (!(await listGated(row, SKILLS_LIST, new AbortController().signal))) return [];
      return (await ctx.skills.list(row.accountId))
        .filter((s) => s.active)
        .map((s) => ({
          name: s.name,
          description: s.description,
          arguments: [
            { name: 'input', description: 'What to apply the skill to', required: false },
          ],
        }));
    },
    async get(client, name, args, signal) {
      const row = await promptsOf(client);
      if (!row || !ctx.skills) return null;
      const skills = ctx.skills;
      const listed = (await skills.list(row.accountId)).find((s) => s.active && s.name === name);
      if (!listed) return null;
      let text = '';
      const r = await gated(
        { row, tool: 'skill.load', descriptor: SKILL_LOAD, args: { name }, signal },
        async () => {
          const skill = await skills.resolve(row.accountId, name);
          if (!skill) throw new NovaError('not_found', 'skill not found');
          text = skill.body;
          return 'loaded';
        },
      );
      if (r.isError) return null;
      const input = typeof args.input === 'string' && args.input.trim() ? args.input.trim() : null;
      return {
        description: listed.description,
        text: clip(input ? `${text}\n\n---\n\n${input}` : text),
      };
    },
  };

  type ExecInput = Parameters<ToolRuntime['execute']>[0];

  /** A Hub tool through the runtime: validation, the gate (origin `mcp_client`), audit. */
  async function runTool(
    row: AuthRow,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const def = await runtime.registry.find(row.accountId, name);
    if (!def) return { text: `There is no tool named ${name}.`, isError: true };
    const scope = await runtime.scopeFor(row.accountId, null, null);
    const callId = uuidv7();
    const input: ExecInput = {
      callId,
      accountId: row.accountId,
      threadId: null,
      turnId: null,
      projectId: null,
      mode: 'agent',
      origin: 'mcp_client',
      def,
      name,
      args,
      modelCallId: null,
      messageId: null,
      partIdx: 0,
      // A client's request is an external agent's, never the user's own instruction (FR-189).
      provenance: { taint: ['external_agent'] },
      scope,
      signal,
      extras: {
        messageId: null,
        network: scope.network,
        deny: scope.deny ?? [],
        cite: (items) => items.map((_, i) => i + 1),
        searchTools: () => [],
      },
    };
    const r = await runtime.execute(input);
    await auditCall({ row, tool: name }, { callId: r.callId, decision: null, result: r.status });
    return { text: r.text, isError: !r.ok };
  }

  const server = new NovaMcpServer({
    name: 'nova',
    version: ctx.config.version,
    instructions:
      "Nova's MCP server. Tools and data are limited to what the user granted this client; every call passes Nova's policy and may wait for the user's approval.",
    tools: toolsFor,
    resources,
    prompts,
    log,
  });

  // ---- HTTP ---------------------------------------------------------------------------------

  async function serve(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    if (!(await ctx.setting('mcpServer.enabled')))
      throw new NovaError('not_found', "Nova's MCP server is turned off");
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const row = token ? await verify(token) : null;
    if (!row) {
      void reply.header('WWW-Authenticate', 'Bearer realm="nova"');
      throw new NovaError('token_required', "a client token for Nova's MCP server is required", {
        action: 'Add this client in Settings, then use its token',
      });
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const url = `${req.protocol}://${req.headers.host ?? '127.0.0.1'}${MCP_ENDPOINT}`;
    const res = await server.handle(
      new Request(url, { method: req.method, headers }),
      { id: row.id, name: row.clientName },
      req.method === 'POST' ? req.body : undefined,
    );
    void reply.status(res.status);
    res.headers.forEach((value, key) => {
      void reply.header(key, value);
    });
    if (!res.body) return reply.send();
    return reply.send(Readable.fromWeb(res.body));
  }

  function register(app: FastifyInstance): void {
    app.get('/api/v1/app-authorizations', async (req) => {
      const accountId = await accountOf(req);
      const rows = await db.orm
        .select()
        .from(appAuthorization)
        .where(
          and(eq(appAuthorization.accountId, accountId), ne(appAuthorization.status, 'revoked')),
        )
        .orderBy(asc(appAuthorization.createdAt));
      return { items: rows.map(toView) };
    });

    app.post('/api/v1/app-authorizations', async (req, reply) => {
      const accountId = await accountOf(req);
      const body = createAppAuthorizationSchema.parse(req.body);
      if (body.scopes.projects !== '*') {
        for (const projectId of new Set(body.scopes.projects)) {
          const [p] = await db.orm
            .select({ id: project.id })
            .from(project)
            .where(
              and(
                eq(project.id, projectId),
                eq(project.accountId, accountId),
                isNull(project.deletedAt),
              ),
            );
          if (!p)
            throw new NovaError('validation', `project ${projectId} not found`, {
              details: { field: 'scopes.projects' },
            });
        }
      }
      const others = await db.orm
        .select({ id: appAuthorization.id })
        .from(appAuthorization)
        .where(
          and(
            eq(appAuthorization.accountId, accountId),
            eq(appAuthorization.kind, 'mcp_client'),
            eq(appAuthorization.status, 'active'),
          ),
        );
      const token = newToken('mcp_client');
      const now = new Date();
      // null: never expires (docs/08 §5); omitted: the default.
      const days = body.expiresInDays === null ? null : (body.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
      const row: AuthRow = {
        id: uuidv7(),
        accountId,
        kind: 'mcp_client',
        clientName: body.clientName,
        scopes: JSON.stringify(body.scopes),
        tokenHash: hashToken(token),
        status: 'active',
        createdAt: now.toISOString(),
        lastUsedAt: null,
        expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString(),
        revokedAt: null,
      };
      await db.transaction(() => db.orm.insert(appAuthorization).values(row));
      // The first client turns the server on (it is off until then, FR-044).
      if (!others.length) await enableServer(accountId);
      await changed(row, 'active');
      // The token is shown once: no cache and no idempotent replay may keep it.
      void reply.header('cache-control', 'no-store').status(201);
      const created: AppAuthorizationCreated = {
        authorization: toView(row),
        token,
        endpoint: `${req.protocol}://${req.headers.host ?? '127.0.0.1'}${MCP_ENDPOINT}`,
      };
      return created;
    });

    app.delete('/api/v1/app-authorizations/:id', async (req) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      const [row] = await db.orm
        .select()
        .from(appAuthorization)
        .where(and(eq(appAuthorization.id, id), eq(appAuthorization.accountId, accountId)));
      if (!row || row.status === 'revoked') throw new NovaError('not_found', 'client not found');
      await db.transaction(() =>
        db.orm
          .update(appAuthorization)
          .set({ status: 'revoked', revokedAt: new Date().toISOString() })
          .where(eq(appAuthorization.id, id)),
      );
      const closed = await server.closeClient(id);
      log.info('mcp client revoked', { clientId: id, sessionsClosed: closed });
      await changed(row, 'revoked');
      return { ok: true };
    });

    // Streamable HTTP: POST carries JSON-RPC, GET opens the server stream, DELETE ends a session.
    app.post(MCP_ENDPOINT, serve);
    app.get(MCP_ENDPOINT, serve);
    app.delete(MCP_ENDPOINT, serve);
    // Open server streams would keep the listener from closing.
    app.addHook('preClose', async () => {
      await server.close();
    });
  }

  // Turning the server off ends the sessions that are open, not only new ones.
  const offSetting = events.bus.subscribe('settings.changed', (e) => {
    if (e.payload.key !== 'mcpServer.enabled') return;
    void ctx
      .setting('mcpServer.enabled')
      .then(async (on) => {
        if (!on) await server.closeAll();
      })
      .catch((err: unknown) => log.warn('mcp server sessions not closed', { err }));
  });

  ctx.diagnostics.add('mcpServer', async () => ({
    enabled: await ctx.setting('mcpServer.enabled'),
    sessions: server.sessions(),
  }));

  return Promise.resolve({
    server,
    register,
    close: () => {
      offSetting();
      return server.close();
    },
  });
}
