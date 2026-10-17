// The coding tools of Code sessions (docs/10 §4, FR-074, FR-211): `git.status`, `git.diff` and
// `git.log` (read-only, hook-free), `test.run` (detects the project's test command and runs it in
// the sandbox like exec.run, asking per the policy like a command), `code.symbols` and
// `code.refs`. They are built-ins offered by a ToolSourceProvider; outside a Code session they
// fail with `not_available`. Their results are repository content: untrusted (FR-189).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isNovaError } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from '../tools/builtin.ts';
import type { ExecRequestExtras } from '../tools/sandbox.ts';
import { CHARS_PER_TOKEN, DEFAULT_OUTPUT_TOKENS, capHeadTail } from '../tools/text.ts';
import type {
  ExecRequest,
  ToolContext,
  ToolListScope,
  ToolResult,
  ToolSourceProvider,
} from '../tools/types.ts';
import type { CodeService } from './service.ts';

/** Names of the tools only Code sessions get (the runtime may hide them elsewhere). */
export const CODE_TOOL_NAMES = [
  'git.status',
  'git.diff',
  'git.log',
  'test.run',
  'code.symbols',
  'code.refs',
] as const;

/** How long test.run waits for the suite before stopping it. */
export const TEST_TIMEOUT_MS = 10 * 60_000;
const MAX_CHARS = DEFAULT_OUTPUT_TOKENS * CHARS_PER_TOKEN;

export interface TestCommand {
  cmd: string;
  runner: 'npm' | 'pnpm' | 'yarn' | 'pytest' | 'go' | 'cargo';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The project's test command: npm/pnpm/yarn test, pytest, go test ./... or cargo test. */
export async function detectTestCommand(folder: string): Promise<TestCommand | null> {
  try {
    const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.scripts?.test === 'string') {
      if (await exists(join(folder, 'pnpm-lock.yaml'))) return { cmd: 'pnpm test', runner: 'pnpm' };
      if (await exists(join(folder, 'yarn.lock'))) return { cmd: 'yarn test', runner: 'yarn' };
      return { cmd: 'npm test', runner: 'npm' };
    }
  } catch {
    // No package.json, or not JSON.
  }
  if (await exists(join(folder, 'Cargo.toml'))) return { cmd: 'cargo test', runner: 'cargo' };
  if (await exists(join(folder, 'go.mod'))) return { cmd: 'go test ./...', runner: 'go' };
  for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py']) {
    if (await exists(join(folder, f))) return { cmd: 'python3 -m pytest', runner: 'pytest' };
  }
  if (await exists(join(folder, 'tests'))) return { cmd: 'python3 -m pytest', runner: 'pytest' };
  return null;
}

/** A test selector appended to the command: a path or name, never shell syntax. */
const PATTERN = /^[A-Za-z0-9_./:@=+-][A-Za-z0-9_./:@=+\-[\]]{0,199}$/;

/** The full command for a selector (`npm test -- x`, `pytest x`, `go test x`, `cargo test x`). */
export function testCommandWith(t: TestCommand, pattern: string | undefined): string {
  if (!pattern) return t.cmd;
  if (t.runner === 'go') return `go test ${pattern}`;
  if (t.runner === 'npm' || t.runner === 'pnpm' || t.runner === 'yarn')
    return `${t.cmd} -- ${pattern}`;
  return `${t.cmd} ${pattern}`;
}

function cap(text: string, maxTokens?: number): { text: string; truncated: boolean } {
  const max = Math.max(100, Math.min(maxTokens ?? DEFAULT_OUTPUT_TOKENS, 20_000)) * CHARS_PER_TOKEN;
  return capHeadTail(defaultRedactor.redactString(text), Math.min(max, MAX_CHARS * 2));
}

function failFrom(err: unknown): ToolResult {
  if (isNovaError(err)) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (reason === 'not_a_code_session') return fail('not_available', err.message);
    return fail(typeof reason === 'string' ? reason : err.code, err.message);
  }
  throw err;
}

const path = { type: 'string', minLength: 1, maxLength: 1000 };

export function codeTools(svc: CodeService): BuiltinTool[] {
  const folderResource = (_args: unknown, ctx: ToolContext) => {
    try {
      return { kind: 'path' as const, value: svc.folderOfThread(ctx.accountId, ctx.threadId) };
    } catch {
      return undefined;
    }
  };
  return [
    {
      descriptor: builtinDescriptor({
        name: 'git.status',
        title: 'Git status',
        description:
          "Show the Code session folder's Git branch and changed, staged and untracked files.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: async (_args, ctx) => {
        try {
          const out = await svc.gitStatus(ctx.accountId, ctx.threadId);
          return ok(cap(out || '(clean)').text);
        } catch (err) {
          return failFrom(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'git.diff',
        title: 'Git diff',
        description:
          'Show uncommitted changes in the Code session folder as a unified diff: the work tree against the index, or the staged changes. Optionally for one path.',
        inputSchema: {
          type: 'object',
          properties: {
            path,
            staged: { type: 'boolean' },
            maxOutputTokens: { type: 'integer', minimum: 100, maximum: 20_000 },
          },
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        try {
          const opts: { path?: string; staged?: boolean } = {};
          const p = str(a.path);
          if (p) opts.path = p;
          if (a.staged === true) opts.staged = true;
          const out = await svc.gitDiff(ctx.accountId, ctx.threadId, opts);
          const c = cap(out || '(no changes)', num(a.maxOutputTokens));
          return ok(c.text, { truncated: c.truncated });
        } catch (err) {
          return failFrom(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'git.log',
        title: 'Git log',
        description:
          'List recent commits of the Code session folder (short hash, date, author, subject), optionally for one path.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, path },
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        try {
          const opts: { limit?: number; path?: string } = {};
          const limit = num(a.limit);
          if (limit !== undefined) opts.limit = limit;
          const p = str(a.path);
          if (p) opts.path = p;
          const out = await svc.gitLog(ctx.accountId, ctx.threadId, opts);
          return ok(cap(out || '(no commits yet)').text);
        } catch (err) {
          return failFrom(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'test.run',
        title: 'Run the tests',
        description:
          "Detect the project's test command (npm, pnpm or yarn test, pytest, go test ./..., cargo test) and run it in the sandbox in the Code session folder. Optionally pass a test path or name to run only those tests.",
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', minLength: 1, maxLength: 200 },
            maxOutputTokens: { type: 'integer', minimum: 100, maximum: 20_000 },
          },
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'execute' },
        effects: ['exec'],
        timeoutMs: TEST_TIMEOUT_MS + 30_000,
      }),
      origin: 'tool',
      resource: folderResource,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        let folder: string;
        try {
          folder = svc.folderOfThread(ctx.accountId, ctx.threadId);
        } catch (err) {
          return failFrom(err);
        }
        const available = await ctx.sandbox.available();
        if (!available.ok) return fail('sandbox_unavailable', available.detail);
        const pattern = str(a.pattern);
        if (pattern && !PATTERN.test(pattern))
          return fail(
            'validation',
            'pattern must be a test path or name (letters, digits, ./:_-@=+[])',
          );
        const detected = await detectTestCommand(folder);
        if (!detected)
          return fail(
            'not_found',
            'no test command found (package.json "test" script, pytest, go.mod or Cargo.toml); use exec.run instead',
          );
        const cmd = testCommandWith(detected, pattern);
        const req: ExecRequest & ExecRequestExtras = {
          cmd,
          cwd: folder,
          roots: ctx.roots,
          network: extrasOf(ctx)?.network ?? 'off',
          yieldMs: TEST_TIMEOUT_MS,
          signal: ctx.signal,
          turnId: ctx.turnId,
          // The session's machine runs it (a remote environment's sandbox, FR-062).
          egress: { accountId: ctx.accountId, threadId: ctx.threadId },
          ...(ctx.progress
            ? { onOutput: (chunk: string) => ctx.progress?.(defaultRedactor.redactString(chunk)) }
            : {}),
        };
        try {
          const r = await ctx.sandbox.exec(req);
          if (r.status === 'running') {
            await ctx.sandbox.write(r.sessionId, { signal: 'terminate' }).catch(() => undefined);
            await svc.testCompleted(ctx.accountId, ctx.threadId, 'timeout', `${cmd} timed out`);
            const c = cap(r.output, num(a.maxOutputTokens));
            return ok(`${cmd}: stopped after ${TEST_TIMEOUT_MS / 60_000} minutes\n${c.text}`, {
              status: 'timeout',
              command: cmd,
            });
          }
          const passed = r.exitCode === 0;
          const c = cap(r.output, num(a.maxOutputTokens));
          const last = c.text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
          await svc.testCompleted(
            ctx.accountId,
            ctx.threadId,
            passed ? 'passed' : 'failed',
            `${cmd}: exit ${r.exitCode}${last ? ` — ${last}` : ''}`,
          );
          return ok(
            `${cmd}: ${passed ? 'passed' : 'failed'} (exit code ${r.exitCode})\n${c.text}`,
            {
              status: passed ? 'passed' : 'failed',
              exitCode: r.exitCode,
              command: cmd,
              truncated: c.truncated,
            },
          );
        } catch (err) {
          return failFrom(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'code.symbols',
        title: 'Find symbols',
        description:
          'Find definitions (functions, classes, methods, types) in the Code session folder by name: exact matches first, then prefixes and substrings.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        try {
          const s = svc.sessionForThread(ctx.accountId, ctx.threadId);
          if (!s) return fail('not_available', 'this tool works only in Code sessions');
          const hits = await svc.symbols(
            ctx.accountId,
            s.id,
            str(a.query) ?? '',
            num(a.limit) ?? 50,
          );
          if (!hits.length) return ok('No matching definitions.');
          return ok(
            hits
              .map(
                (h) =>
                  `${h.path}:${h.line} ${h.kind} ${h.container ? `${h.container}.` : ''}${h.name}`,
              )
              .join('\n'),
            { count: hits.length },
          );
        } catch (err) {
          return failFrom(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'code.refs',
        title: 'Find references',
        description:
          'Find lines in the Code session folder that mention an identifier as a whole word (definitions and uses).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          required: ['name'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      origin: 'file',
      resource: folderResource,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        try {
          const s = svc.sessionForThread(ctx.accountId, ctx.threadId);
          if (!s) return fail('not_available', 'this tool works only in Code sessions');
          const refs = await svc.refs(ctx.accountId, s.id, str(a.name) ?? '', num(a.limit) ?? 100);
          if (!refs.length) return ok('No references found.');
          return ok(cap(refs.map((r) => `${r.path}:${r.line}: ${r.text}`).join('\n')).text, {
            count: refs.length,
          });
        } catch (err) {
          return failFrom(err);
        }
      },
    },
  ];
}

/**
 * The coding tools as a tool source (source `builtin`): offered to code threads only when the
 * listing is for a turn; an unscoped listing (catalogs, direct invocation) has them all.
 */
export function codeToolSource(svc: CodeService): ToolSourceProvider {
  const tools = codeTools(svc);
  return {
    source: 'builtin',
    list: (_accountId: string, scope?: ToolListScope) =>
      Promise.resolve(scope && scope.mode !== 'code' ? [] : tools),
  };
}
