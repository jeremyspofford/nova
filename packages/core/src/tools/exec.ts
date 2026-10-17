// Exec tools (docs/08 §1.1, FR-184): exec.run waits up to its yield time and returns the exit
// status or a session id; exec.poll reads new output; exec.write sends input or a signal. Output
// returned to the model is redacted and capped, keeping head and tail. Without a sandbox every
// exec tool fails closed with `sandbox_unavailable`; nothing ever runs outside it (docs/12 §7).
//
// M5: in the Hub the sandbox is an ExecSessions, which supplies the `exec.sessions` yield time
// and output cap and lists sessions for the terminal pane. A session can be driven from the turn
// that started it, or from a later turn of the same thread once a run kept it; a session of
// another thread is refused. exec.write passes the policy gate on every call like any tool call,
// and the gate matches its text against the command rules (FR-191): writing to stdin never
// skips them.
import { isNovaError } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from './builtin.ts';
import { withDeny } from './fs.ts';
import { PathDenied, resolveInRoots, type PathPolicy } from './roots.ts';
import {
  DEFAULT_EXEC_SESSION_SETTINGS,
  ExecSessions,
  type ExecSessionSettings,
  type OwnedExecRequest,
} from './exec-sessions.ts';
import { CHARS_PER_TOKEN, capHeadTail } from './text.ts';
import type { ExecResult, ToolContext, ToolResult } from './types.ts';

export * from './exec-sessions.ts';

export const DEFAULT_YIELD_MS = DEFAULT_EXEC_SESSION_SETTINGS.yieldMs;
export const MAX_YIELD_MS = 120_000;
/** The highest output cap the `exec.sessions` setting allows (tokens). */
const MAX_OUTPUT_TOKENS = 50_000;

export interface ExecToolOptions {
  redactor?: Redactor;
  paths?: PathPolicy;
}

interface Owner {
  accountId: string;
  threadId: string;
  turnId: string;
}

export function execTools(opts: ExecToolOptions = {}): BuiltinTool[] {
  const redactor = opts.redactor ?? defaultRedactor;
  // Sessions belong to the turn that started them; a later turn of the same thread may drive
  // one a run kept (ExecSessions.retainTurn); another thread never can.
  const owners = new Map<string, Owner>();

  const unavailable = async (ctx: ToolContext): Promise<ToolResult | null> => {
    const a = await ctx.sandbox.available();
    return a.ok ? null : fail('sandbox_unavailable', a.detail);
  };
  /** `exec.sessions` from the Hub's ExecSessions; the defaults elsewhere (tests, headless). */
  const settings = (ctx: ToolContext): Promise<ExecSessionSettings> =>
    ctx.sandbox instanceof ExecSessions
      ? ctx.sandbox.config()
      : Promise.resolve(DEFAULT_EXEC_SESSION_SETTINGS);
  /** The model may lower the output cap per call, never raise it above the setting (FR-184). */
  const cap = (requested: number | undefined, conf: ExecSessionSettings): number =>
    Math.min(requested ?? conf.outputTokens, conf.outputTokens);
  const format = (r: ExecResult, maxTokens: number, ctx: ToolContext): ToolResult => {
    const max = Math.max(100, Math.min(maxTokens, MAX_OUTPUT_TOKENS)) * CHARS_PER_TOKEN;
    const out = capHeadTail(redactor.redactString(r.output), max);
    if (r.status === 'exited') {
      return ok(`Exit code ${r.exitCode}\n${out.text}`, {
        status: 'exited',
        exitCode: r.exitCode,
        truncated: out.truncated,
      });
    }
    owners.set(r.sessionId, {
      accountId: ctx.accountId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
    });
    // Sessions of ended turns were killed; forget the oldest owners past a bound.
    for (const id of owners.keys()) {
      if (owners.size <= 1_000) break;
      owners.delete(id);
    }
    return ok(
      `Still running (session ${r.sessionId}). Call exec.poll with this session id for more output, or exec.write to send input or stop it.\n${out.text}`,
      { status: 'running', sessionId: r.sessionId, truncated: out.truncated },
    );
  };
  /** Null when the call may drive the session, else the refusal. */
  const refused = (ctx: ToolContext, sessionId: string): ToolResult | null => {
    const o = owners.get(sessionId);
    const missing = fail('not_found', `no running command with session id ${sessionId}`);
    if (o?.accountId !== ctx.accountId) return missing;
    // Fail closed: a thread never reads or drives another thread's command.
    if (o.threadId !== ctx.threadId)
      return fail('session_denied', `session ${sessionId} belongs to another conversation`);
    if (o.turnId === ctx.turnId) return null;
    // A later turn of the same thread: only while the run kept the session.
    const kept = ctx.sandbox instanceof ExecSessions ? ctx.sandbox.owner(sessionId) : null;
    return kept?.retained && kept.threadId === ctx.threadId ? null : missing;
  };
  const onError = (err: unknown): ToolResult => {
    if (err instanceof PathDenied) return fail('path_denied', err.message);
    if (isNovaError(err)) {
      const reason = (err.details as { reason?: unknown } | undefined)?.reason;
      return fail(typeof reason === 'string' ? reason : err.code, err.message);
    }
    throw err;
  };
  const progress = (ctx: ToolContext) => (chunk: string) =>
    ctx.progress?.(redactor.redactString(chunk));

  return [
    {
      descriptor: builtinDescriptor({
        name: 'exec.run',
        title: 'Run a command',
        description:
          'Run a shell command in the sandbox, in the workspace folder unless cwd is given. Waits up to yieldMs (default 10 s, max 120 s); a command still running then returns a session id for exec.poll and exec.write.',
        inputSchema: {
          type: 'object',
          properties: {
            cmd: { type: 'string', minLength: 1, maxLength: 20_000 },
            cwd: { type: 'string', maxLength: 4096 },
            yieldMs: { type: 'integer', minimum: 0, maximum: MAX_YIELD_MS },
            maxOutputTokens: { type: 'integer', minimum: 100, maximum: MAX_OUTPUT_TOKENS },
            tty: { type: 'boolean' },
          },
          required: ['cmd'],
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'execute' },
        effects: ['exec'],
        timeoutMs: MAX_YIELD_MS + 15_000,
      }),
      origin: 'tool',
      resource: (args, ctx) => {
        const cwd = str(argsOf(args).cwd) ?? '.';
        try {
          return {
            kind: 'path',
            value: resolveInRoots(ctx.roots, cwd, 'read', withDeny(opts.paths ?? {}, ctx)).path,
          };
        } catch {
          return { kind: 'path', value: cwd };
        }
      },
      handler: async (args, ctx) => {
        const down = await unavailable(ctx);
        if (down) return down;
        const a = argsOf(args);
        try {
          const cwd = resolveInRoots(
            ctx.roots,
            str(a.cwd) ?? '.',
            'read',
            withDeny(opts.paths ?? {}, ctx),
          ).path;
          const conf = await settings(ctx);
          const req: OwnedExecRequest = {
            cmd: str(a.cmd) ?? '',
            cwd,
            roots: ctx.roots,
            network: extrasOf(ctx)?.network ?? 'off',
            yieldMs: Math.min(num(a.yieldMs) ?? conf.yieldMs, MAX_YIELD_MS),
            signal: ctx.signal,
            turnId: ctx.turnId,
            onOutput: progress(ctx),
            owner: {
              accountId: ctx.accountId,
              threadId: ctx.threadId,
              turnId: ctx.turnId,
              callId: ctx.callId,
            },
          };
          const r = await ctx.sandbox.exec(req);
          return format(r, cap(num(a.maxOutputTokens), conf), ctx);
        } catch (err) {
          return onError(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'exec.poll',
        title: 'Read command output',
        description:
          'Read output a running command produced since the last read, waiting up to yieldMs (default 10 s) for more or for it to exit.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 100 },
            yieldMs: { type: 'integer', minimum: 0, maximum: MAX_YIELD_MS },
            maxOutputTokens: { type: 'integer', minimum: 100, maximum: MAX_OUTPUT_TOKENS },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
        timeoutMs: MAX_YIELD_MS + 15_000,
      }),
      origin: 'tool',
      handler: async (args, ctx) => {
        const down = await unavailable(ctx);
        if (down) return down;
        const a = argsOf(args);
        const id = str(a.sessionId) ?? '';
        const no = refused(ctx, id);
        if (no) return no;
        try {
          const conf = await settings(ctx);
          const r = await ctx.sandbox.poll(
            id,
            Math.min(num(a.yieldMs) ?? conf.yieldMs, MAX_YIELD_MS),
            ctx.signal,
          );
          if (r.status === 'exited') owners.delete(id);
          return format(r, cap(num(a.maxOutputTokens), conf), ctx);
        } catch (err) {
          owners.delete(id);
          return onError(err);
        }
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'exec.write',
        title: 'Send input to a command',
        description:
          'Send text to the standard input of a running command, close its input, or interrupt or terminate it. Returns the output that follows.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 100 },
            text: { type: 'string', maxLength: 100_000 },
            closeStdin: { type: 'boolean' },
            signal: { enum: ['interrupt', 'terminate'] },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'execute' },
        effects: ['exec'],
        timeoutMs: 30_000,
      }),
      origin: 'tool',
      handler: async (args, ctx) => {
        const down = await unavailable(ctx);
        if (down) return down;
        const a = argsOf(args);
        const id = str(a.sessionId) ?? '';
        const no = refused(ctx, id);
        if (no) return no;
        try {
          const input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' } =
            {};
          const text = str(a.text);
          if (text !== undefined) input.text = text;
          if (a.closeStdin === true) input.closeStdin = true;
          if (a.signal === 'interrupt' || a.signal === 'terminate') input.signal = a.signal;
          await ctx.sandbox.write(id, input);
          if (input.signal === 'terminate') {
            owners.delete(id);
            return ok(`Terminated session ${id}.`, { status: 'terminated' });
          }
          const r = await ctx.sandbox.poll(id, 500, ctx.signal);
          if (r.status === 'exited') owners.delete(id);
          return format(r, (await settings(ctx)).outputTokens, ctx);
        } catch (err) {
          owners.delete(id);
          return onError(err);
        }
      },
    },
  ];
}
