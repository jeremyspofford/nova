// M6 coding tools (docs/10 §4, §7-§10): `git.branch` and `git.commit` (the agent's branch and a
// commit of what the user accepted), `pr.create` and `pr.status` (FR-070), `devserver.list`,
// `devserver.start` and `devserver.stop` (FR-097), `task.spawn` and `task.wait` for workers in
// their own worktrees (FR-073), and the cross-session tools `sessions.list`, `sessions.message`,
// `sessions.archive` and `sessions.ask` (FR-072). Every call passes the policy gate like any other
// action; none of them can confirm a push to a protected or default branch (only the user's typed
// confirmation can, FR-189). Results that carry other sessions', the host's or a worker's text are
// untrusted (origin `tool`).
import { NovaError, isNovaError } from '@nova/shared';
import {
  argsOf,
  builtinDescriptor,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from '../tools/builtin.ts';
import type { ToolContext, ToolListScope, ToolResult, ToolSourceProvider } from '../tools/types.ts';
import type { DevServerManager } from './devservers.ts';
import type { PullRequestService } from './pr.ts';
import type { CodeService } from './service.ts';
import type { CodeSessionOps } from './sessions.ts';

/** Names of the M6 tools offered in Code threads. */
export const CODE_M6_TOOL_NAMES = [
  'git.branch',
  'git.commit',
  'pr.create',
  'pr.status',
  'devserver.list',
  'devserver.start',
  'devserver.stop',
  'task.spawn',
  'task.wait',
] as const;

/** Cross-session tools, offered in Code and agent threads (FR-072). */
export const SESSION_TOOL_NAMES = [
  'sessions.list',
  'sessions.message',
  'sessions.archive',
  'sessions.ask',
] as const;

export interface CodeM6ToolDeps {
  code: CodeService;
  prs: PullRequestService;
  devServers: DevServerManager;
  ops: CodeSessionOps;
}

function failFrom(err: unknown): ToolResult {
  if (isNovaError(err)) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (reason === 'not_a_code_session') return fail('not_available', err.message);
    return fail(typeof reason === 'string' ? reason : err.code, err.message, err.details);
  }
  throw err;
}

const idArg = { type: 'string', minLength: 1, maxLength: 100 };

export function codeM6Tools(d: CodeM6ToolDeps): { code: BuiltinTool[]; sessions: BuiltinTool[] } {
  const session = (ctx: ToolContext) => {
    const s = d.code.infoByThread(ctx.accountId, ctx.threadId);
    if (!s) throw notInCode();
    return s;
  };
  const folderResource = (_args: unknown, ctx: ToolContext) => {
    const s = d.code.infoByThread(ctx.accountId, ctx.threadId);
    return s ? { kind: 'path' as const, value: s.folder } : undefined;
  };
  const run =
    (fn: (ctx: ToolContext, a: Record<string, unknown>) => Promise<ToolResult>) =>
    async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      try {
        return await fn(ctx, argsOf(args));
      } catch (err) {
        return failFrom(err);
      }
    };

  const code: BuiltinTool[] = [
    {
      descriptor: builtinDescriptor({
        name: 'git.branch',
        title: 'Create a branch',
        description:
          'Create a new branch nova/<name> at the current commit and switch the Code session to it (no files change). Use it before committing when the session is on the default branch.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
          required: ['name'],
          additionalProperties: false,
        },
        annotations: { action: 'write' },
      }),
      origin: null,
      resource: folderResource,
      handler: run(async (ctx, a) => {
        const s = session(ctx);
        const r = await d.code.createBranch(ctx.accountId, s.id, str(a.name) ?? 'change', 'agent');
        return ok(`Switched to the new branch ${r.branch}${r.from ? ` (from ${r.from})` : ''}.`, r);
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'git.commit',
        title: 'Commit accepted changes',
        description:
          'Commit the changes the user accepted in the diff review, with a clear message. Changes still pending review are left out. Refused on the default branch (create a branch with git.branch first) and when the changes look like they contain secrets.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', minLength: 1, maxLength: 5000 } },
          required: ['message'],
          additionalProperties: false,
        },
        annotations: { action: 'write' },
      }),
      origin: null,
      resource: folderResource,
      handler: run(async (ctx, a) => {
        const s = session(ctx);
        const r = await d.code.commit(
          ctx.accountId,
          s.id,
          { message: str(a.message) ?? '' },
          'agent',
        );
        return ok(
          `Committed ${r.files} file(s) on ${r.branch} as ${r.sha.slice(0, 12)}.${r.hooksNote ? ` ${r.hooksNote}` : ''}`,
          { sha: r.sha, branch: r.branch, files: r.files },
        );
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'pr.create',
        title: 'Open a pull request',
        description:
          "Push the session's branch and open a pull request on the connected Git host (or return the one already open). Pushing a protected or default branch is refused: commit on a nova/ branch.",
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 256 },
            body: { type: 'string', maxLength: 60_000 },
            base: { type: 'string', minLength: 1, maxLength: 250 },
            draft: { type: 'boolean' },
          },
          required: ['title'],
          additionalProperties: false,
        },
        annotations: { action: 'send', requiresNetwork: true },
        effects: ['network'],
      }),
      origin: 'tool',
      resource: folderResource,
      handler: run(async (ctx, a) => {
        const s = session(ctx);
        const req: { title: string; body?: string; base?: string; draft?: boolean } = {
          title: str(a.title) ?? '',
        };
        const body = str(a.body);
        if (body !== undefined) req.body = body;
        const base = str(a.base);
        if (base) req.base = base;
        if (a.draft === true) req.draft = true;
        const pr = await d.prs.open(ctx.accountId, s.id, req, 'agent');
        return ok(
          `Pull request #${pr.number}: ${pr.url} (${pr.headBranch} into ${pr.baseBranch}); CI ${pr.ci.status}.`,
          { url: pr.url, number: pr.number, ci: pr.ci.status },
        );
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'pr.status',
        title: 'Pull request status',
        description:
          "Read the session's pull request and its CI checks from the Git host now (queued, running, passed or failed).",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, action: 'read', requiresNetwork: true },
        effects: ['network'],
      }),
      origin: 'tool',
      resource: folderResource,
      handler: run(async (ctx) => {
        const s = session(ctx);
        if (!d.prs.get(ctx.accountId, s.id)) return ok('This session has no pull request yet.');
        const pr = await d.prs.refresh(ctx.accountId, s.id);
        const checks = pr.ci.checks
          .map((c) => `- ${c.name}: ${c.status}${c.conclusion ? ` (${c.conclusion})` : ''}`)
          .join('\n');
        return ok(
          `Pull request #${pr.number} (${pr.state}): ${pr.url}\nCI: ${pr.ci.status}${checks ? `\n${checks}` : ''}`,
          { status: pr.ci.status, state: pr.state },
        );
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'devserver.list',
        title: 'List dev servers',
        description:
          'List the dev servers this Code session can start (detected from package.json, Django, Rails, Go or .nova/launch.json) and the ones running, with their URLs.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: run(async (ctx) => {
        const s = session(ctx);
        const [candidates, running] = await Promise.all([
          d.devServers.detect(ctx.accountId, s.id),
          d.devServers.list(ctx.accountId, s.id),
        ]);
        const lines = [
          'Can start:',
          ...(candidates.length
            ? candidates.map(
                (c) => `- ${c.id}: ${c.label} — ${c.command}${c.port ? ` (port ${c.port})` : ''}`,
              )
            : ['- (none detected)']),
          'Servers:',
          ...(running.length
            ? running.map((r) => `- ${r.id}: ${r.label} ${r.status}${r.url ? ` at ${r.url}` : ''}`)
            : ['- (none)']),
        ];
        return ok(lines.join('\n'));
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'devserver.start',
        title: 'Start a dev server',
        description:
          'Start a detected dev server of the Code session in its sandbox and return its URL for the browser pane. Without candidateId the first detected one starts.',
        inputSchema: {
          type: 'object',
          properties: {
            candidateId: { type: 'string', minLength: 1, maxLength: 200 },
            port: { type: 'integer', minimum: 1024, maximum: 65_535 },
          },
          additionalProperties: false,
        },
        annotations: { action: 'execute' },
        effects: ['exec'],
      }),
      origin: 'tool',
      resource: folderResource,
      handler: run(async (ctx, a) => {
        const s = session(ctx);
        const req: { candidateId?: string; port?: number } = {};
        const cid = str(a.candidateId);
        if (cid) req.candidateId = cid;
        const port = num(a.port);
        if (port !== undefined) req.port = port;
        const v = await d.devServers.start(ctx.accountId, s.id, req, 'agent');
        return ok(`${v.label} is running at ${v.url ?? 'an unknown address'} (${v.command}).`, {
          id: v.id,
          url: v.url,
        });
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'devserver.stop',
        title: 'Stop dev servers',
        description: 'Stop one dev server of the Code session by id, or all of them.',
        inputSchema: {
          type: 'object',
          properties: { id: idArg, all: { type: 'boolean' } },
          additionalProperties: false,
        },
        annotations: { action: 'write' },
      }),
      origin: null,
      resource: folderResource,
      handler: run(async (ctx, a) => {
        const s = session(ctx);
        const id = str(a.id);
        if (id) {
          const v = await d.devServers.stop(ctx.accountId, s.id, id, 'agent');
          return ok(`${v.label} stopped.`);
        }
        if (a.all !== true) return fail('validation', 'give the dev server id, or all: true');
        const all = await d.devServers.stopAll(ctx.accountId, s.id, 'agent');
        return ok(`Stopped ${all.filter((v) => v.status === 'stopped').length} dev server(s).`);
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'task.spawn',
        title: 'Start a worker',
        description:
          'Start a worker (for example role "coder") on an independent task: a Code session of its own in a new Git worktree on a nova/ branch from this session\'s last commit. It works in parallel; collect its result with task.wait. At most 4 run at once.',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', minLength: 1, maxLength: 40 },
            objective: { type: 'string', minLength: 1, maxLength: 8000 },
            worktree: { type: 'boolean', const: true },
          },
          required: ['role', 'objective'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: null,
      handler: run(async (ctx, a) => {
        const r = await d.ops.spawnWorker(ctx.accountId, ctx.threadId, {
          role: str(a.role) ?? 'coder',
          objective: str(a.objective) ?? '',
        });
        return ok(
          `Worker ${r.sessionId} started on ${r.branch ?? 'a new branch'}. Collect its result with task.wait.`,
          r,
        );
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'task.wait',
        title: 'Wait for workers',
        description:
          'Wait until the given workers (all of this session when ids is empty) finish, or the timeout passes (default 30 s, 10 to 3600 s); returns their status, branch and last reply.',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', maxItems: 20, items: idArg },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
          },
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
        timeoutMs: 3_660_000,
      }),
      origin: 'tool',
      handler: run(async (ctx, a) => {
        const ids = Array.isArray(a.ids)
          ? a.ids.filter((x): x is string => typeof x === 'string')
          : [];
        const seconds = Math.min(Math.max(num(a.timeoutSeconds) ?? 30, 10), 3600);
        const r = await d.ops.waitWorkers(
          ctx.accountId,
          ctx.threadId,
          ids,
          seconds * 1000,
          ctx.signal,
        );
        return ok(JSON.stringify(r));
      }),
    },
  ];

  const sessions: BuiltinTool[] = [
    {
      descriptor: builtinDescriptor({
        name: 'sessions.list',
        title: 'List Code sessions',
        description:
          "List the account's other active Code sessions: id, title, folder, branch, status and, for workers, their parent and role.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'tool',
      handler: run((ctx) => {
        const items = d.ops.list(ctx.accountId, ctx.threadId);
        return Promise.resolve(ok(JSON.stringify(items), { count: items.length }));
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'sessions.message',
        title: 'Message a Code session',
        description:
          "Send a message to another Code session of this account; its agent reads it as a new turn (a busy one when its current turn ends). The message never carries the user's authority.",
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: idArg,
            text: { type: 'string', minLength: 1, maxLength: 8000 },
          },
          required: ['sessionId', 'text'],
          additionalProperties: false,
        },
        annotations: { action: 'write' },
      }),
      origin: null,
      handler: run(async (ctx, a) => {
        const r = await d.ops.message(
          ctx.accountId,
          ctx.threadId,
          str(a.sessionId) ?? '',
          str(a.text) ?? '',
        );
        return ok(`Sent to session ${r.sessionId}.`, r);
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'sessions.archive',
        title: 'Archive a Code session',
        description:
          'Archive another Code session of this account (its worktree is released; a clean one is removed per the cleanup setting).',
        inputSchema: {
          type: 'object',
          properties: { sessionId: idArg },
          required: ['sessionId'],
          additionalProperties: false,
        },
        annotations: { action: 'write' },
      }),
      origin: null,
      handler: run(async (ctx, a) => {
        await d.ops.archive(ctx.accountId, ctx.threadId, str(a.sessionId) ?? '');
        return ok('Archived.');
      }),
    },
    {
      descriptor: builtinDescriptor({
        name: 'sessions.ask',
        title: 'Ask about a Code session',
        description:
          "Answer a question from another Code session's context (its facts and recent transcript), without adding anything to it.",
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: idArg,
            question: { type: 'string', minLength: 1, maxLength: 4000 },
          },
          required: ['sessionId', 'question'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
        timeoutMs: 150_000,
      }),
      origin: 'tool',
      handler: run(async (ctx, a) => {
        const r = await d.ops.ask(
          ctx.accountId,
          str(a.sessionId) ?? '',
          str(a.question) ?? '',
          AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]),
        );
        return ok(r.answer || '(no answer)', { sessionId: r.sessionId });
      }),
    },
  ];
  return { code, sessions };
}

function notInCode(): NovaError {
  return new NovaError('not_found', 'this tool works only in Code sessions', {
    details: { reason: 'not_a_code_session' },
  });
}

/**
 * The Code area's tools as one source (source `builtin`): in a Code thread's turn the M5 and M6
 * coding tools and the cross-session tools; in an agent thread's turn the cross-session tools and
 * (M7) `code.delegate`; nothing elsewhere. An unscoped listing (catalogs, direct invocation) has them all except the
 * worker tools, whose names the runs area also uses for its sub-agents.
 */
export function codeAreaToolSource(
  m5: readonly BuiltinTool[],
  m6: {
    code: readonly BuiltinTool[];
    sessions: readonly BuiltinTool[];
    /** M7: tools only agent threads get (`code.delegate`). */
    agent?: readonly BuiltinTool[];
  },
): ToolSourceProvider {
  const inCode = [...m5, ...m6.code, ...m6.sessions];
  const forAgents = [...m6.sessions, ...(m6.agent ?? [])];
  const unscoped = [...inCode, ...(m6.agent ?? [])].filter(
    (t) => !t.descriptor.name.startsWith('task.'),
  );
  return {
    source: 'builtin',
    list: (_accountId: string, scope?: ToolListScope) =>
      Promise.resolve(
        !scope
          ? unscoped
          : scope.mode === 'code'
            ? inCode
            : scope.mode === 'agent'
              ? forAgents
              : [],
      ),
  };
}
