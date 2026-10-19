// `script.run` (FR-202, docs/08 §1.1; flagged, off by default): the model writes a short
// JavaScript program that calls other tools as functions. The program runs in an isolated engine
// (runner.ts, vm.ts) with no network, filesystem or Node globals; each tool it calls is a nested
// call that the tool runtime runs exactly like a direct model call (argument validation, hooks,
// the policy gate with its asks, denies, grants and reviewer, the handler's timeout, the
// `tool_call` row and the audit), one at a time, with the script's own call as its parent. An ask
// pauses the script until the user answers; a deny fails that call inside the script.
//
// Provenance: a nested call never carries more authority than the script's own call. The tool
// context does not tell the script the user's instruction behind its call, so nested calls carry
// none (and the taint `tool`), and the engine asks before any consequential nested action that no
// standing rule or grant allows. A context that does carry the call's provenance is inherited.
import { createHash } from 'node:crypto';
import { uuidv7, type ToolCallStatus } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  ok,
  str,
  type BuiltinTool,
  type CallExtras,
} from '../tools/builtin.ts';
import type { ToolRuntime } from '../tools/runtime.ts';
import { clip } from '../tools/text.ts';
import type {
  AuditSink,
  Origin,
  Provenance,
  ToolContext,
  ToolDefinition,
  ToolSourceProvider,
} from '../tools/types.ts';
import { runIsolatedScript } from './runner.ts';
import { MAX_SCRIPT_CHARS, type BridgeAnswer, type ScriptLimits } from './vm.ts';

/** Tools a script cannot call: itself, and tools whose effect belongs to the turn's own loop. */
export const SCRIPT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'script.run',
  'tool.search',
  'skill.load',
  'context.fresh',
  'context.remaining',
  'run.complete',
]);

/** One nested call as the script's result reports it. */
export interface NestedCallRecord {
  callId: string;
  tool: string;
  status: ToolCallStatus;
}

export interface NestedResult {
  callId: string;
  status: ToolCallStatus;
  ok: boolean;
  text: string;
  error: { code: string; message: string } | null;
  /** The untrusted origin the result adds to the script's taint. */
  origin: Origin | null;
}

/** The tools one script may call, and how it calls them. */
export interface NestedSession {
  names: string[];
  call(name: string, args: unknown, provenance: Provenance): Promise<NestedResult>;
}

export interface NestedToolCaller {
  open(parent: ToolContext): Promise<NestedSession>;
}

/**
 * Nested calls through the tool runtime itself (`ToolRuntime.execute`), so they pass exactly the
 * path a direct model call passes. The thread's mode and scope are the parent call's; the nested
 * call's row names the script's call as its parent.
 */
export function runtimeNestedCaller(opts: {
  runtime: () => ToolRuntime | null;
  db: NovaDatabase;
}): NestedToolCaller {
  const link = async (callId: string, parentId: string) => {
    try {
      await opts.db.transaction(() =>
        opts.db.raw
          .prepare(
            'UPDATE tool_call SET parent_call_id = ? WHERE id = ? AND parent_call_id IS NULL',
          )
          .run(parentId, callId),
      );
    } catch {
      // The link is for the activity view; the call itself is recorded and audited anyway.
    }
  };
  return {
    async open(parent) {
      const rt = opts.runtime();
      if (!rt) return { names: [], call: () => Promise.resolve(unavailable()) };
      const threadId = parent.threadId || null;
      const row = threadId
        ? (opts.db.raw
            .prepare('SELECT mode FROM thread WHERE id = ? AND account_id = ?')
            .get(threadId, parent.accountId) as
            { mode: 'chat' | 'work' | 'code' | 'agent' } | undefined)
        : undefined;
      const mode = row?.mode ?? 'chat';
      const defs = await rt.registry.list(parent.accountId, { threadId, mode });
      const byName = new Map<string, ToolDefinition>();
      for (const d of defs)
        if (!SCRIPT_EXCLUDED_TOOLS.has(d.descriptor.name)) byName.set(d.descriptor.name, d);
      const scope = await rt.scopeFor(parent.accountId, threadId, parent.projectId);
      const parentExtras = extrasOf(parent);
      const extras: CallExtras = {
        // Nested calls are not parts of the reply message; their approvals still reach the thread.
        messageId: null,
        network: scope.network,
        deny: scope.deny ?? [],
        cite: parentExtras?.cite ?? ((items) => items.map((_, i) => i + 1)),
        searchTools: () => [],
      };
      return {
        names: [...byName.keys()].sort(),
        async call(name, args, provenance) {
          if (SCRIPT_EXCLUDED_TOOLS.has(name))
            return refused(name, 'not_allowed', `${name} cannot be called from a script`);
          const callId = uuidv7();
          const out = await rt.execute({
            callId,
            accountId: parent.accountId,
            threadId,
            turnId: parent.turnId || null,
            projectId: parent.projectId,
            mode,
            origin: nestedOrigin(parent.origin),
            def: byName.get(name) ?? null,
            name,
            args,
            modelCallId: null,
            messageId: null,
            partIdx: 0,
            provenance,
            scope,
            signal: parent.signal,
            extras,
            onWaiting: async (waiting) => {
              if (waiting) await link(callId, parent.callId);
            },
          });
          await link(out.callId, parent.callId);
          return {
            callId: out.callId,
            status: out.status,
            ok: out.ok,
            text: out.text,
            error: out.error,
            origin: out.origin,
          };
        },
      };
    },
  };
}

/**
 * Who a nested call is from: the script (docs/08 §1.5, M8), recorded as the `script` origin. A
 * script the user started from the UI is still code the model wrote, so its calls are never the
 * user's own; the gate and the runtime treat `script` like `model` (an agent's call that fires
 * hooks). Hooks and MCP clients are never given `script.run`, so no other caller occurs.
 */
export function nestedOrigin(_parent: ToolContext['origin']): ToolContext['origin'] {
  return 'script';
}

function unavailable(): NestedResult {
  return {
    callId: '',
    status: 'error',
    ok: false,
    text: '',
    error: { code: 'unavailable', message: 'tools are not available to scripts right now' },
    origin: null,
  };
}

function refused(_name: string, code: string, message: string): NestedResult {
  return {
    callId: '',
    status: 'denied',
    ok: false,
    text: '',
    error: { code, message },
    origin: null,
  };
}

export interface ScriptToolOptions {
  /** `scripts.enabled` (security setting, off by default). */
  enabled: () => Promise<boolean>;
  /** `scripts.limits`. */
  limits?: () => Promise<Partial<ScriptLimits>>;
  caller: NestedToolCaller;
  db?: NovaDatabase;
  audit?: AuditSink;
  now?: () => Date;
  /** Watchdog grace beyond the CPU budget (tests). */
  graceMs?: number;
}

export const SCRIPT_TOOL_DESCRIPTION =
  'Run a short JavaScript program (the body of an async function) that calls other tools as ' +
  'functions: `await tools.call("fs.read", {path: "a.txt"})` or `await tools["fs.read"]({path: ' +
  '"a.txt"})` returns the tool\'s text result and throws an Error with a `code` when the call ' +
  'fails or is denied. `tools.names` lists the tools, `input` holds the `input` argument, ' +
  '`console.log` output and the returned value (as JSON) come back. There is no network, file ' +
  'access, timer or module; every tool call passes the same approvals as a direct call.';

const DESCRIPTOR = builtinDescriptor({
  name: 'script.run',
  title: 'Run a script',
  description: SCRIPT_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', minLength: 1, maxLength: MAX_SCRIPT_CHARS },
      input: {},
    },
    required: ['code'],
    additionalProperties: false,
  },
  // The program itself touches nothing; each nested call is evaluated on its own (docs/08 §1.1).
  annotations: { readOnly: true, action: 'read' },
  // A nested call may wait for an approval; the runtime's maximum bounds the whole script.
  timeoutMs: 600_000,
});

/** The provenance nested calls start from (see the header). */
function startingProvenance(ctx: ToolContext): Provenance {
  const given = (ctx as ToolContext & { provenance?: Provenance }).provenance;
  if (given && Array.isArray(given.taint)) {
    const p: Provenance = { taint: [...given.taint] };
    if (given.userInstruction) p.userInstruction = { ...given.userInstruction };
    return p;
  }
  // An external client's script carries its taint (FR-189); any other is the model's code.
  return { taint: ctx.origin === 'mcp_client' ? ['external_agent', 'tool'] : ['tool'] };
}

/** The `script.run` tool. */
export function scriptTool(opts: ScriptToolOptions): BuiltinTool {
  const now = opts.now ?? (() => new Date());
  return {
    descriptor: DESCRIPTOR,
    origin: 'tool',
    handler: async (args, ctx) => {
      if (!(await opts.enabled()))
        return fail('disabled', 'scripted tool calls are turned off (setting scripts.enabled)');
      const a = argsOf(args);
      const code = str(a.code) ?? '';
      if (!code.trim()) return fail('validation', 'the script is empty');
      const limits = (await opts.limits?.().catch(() => ({}))) ?? {};
      const session = await opts.caller.open(ctx);
      const provenance = startingProvenance(ctx);
      const taint = new Set<Origin>(provenance.taint);
      const calls: NestedCallRecord[] = [];
      const threadId = ctx.threadId || null;
      const turnId = ctx.turnId || null;
      await record(opts, 'start', {
        id: ctx.callId,
        accountId: ctx.accountId,
        threadId,
        turnId,
        codeSha256: createHash('sha256').update(code).digest('hex'),
        at: now().toISOString(),
      });
      const outcome = await runIsolatedScript({
        code,
        input: a.input,
        names: session.names,
        limits,
        signal: ctx.signal,
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
        call: async (name, nested): Promise<BridgeAnswer> => {
          const p: Provenance = { taint: [...taint] };
          if (provenance.userInstruction) p.userInstruction = { ...provenance.userInstruction };
          const r = await session.call(name, nested, p);
          if (r.origin) taint.add(r.origin);
          if (r.callId) calls.push({ callId: r.callId, tool: name, status: r.status });
          // The audit names the script behind each nested call (the runtime audits the call too).
          try {
            await opts.audit?.append({
              accountId: ctx.accountId,
              actor: 'system',
              kind: 'tool_call',
              action: 'script.call',
              resource: name,
              decision: r.status,
              result: r.status,
              threadId,
              turnId,
              detail: {
                scriptCallId: ctx.callId,
                callId: r.callId || null,
                tool: name,
                index: calls.length,
              },
            });
          } catch {
            // the runtime's own audit of the call still names it
          }
          if (r.ok) return { ok: true, text: r.text };
          return {
            ok: false,
            code: r.error?.code ?? r.status,
            message: r.error?.message ?? `the call ended ${r.status}`,
          };
        },
      });
      const status = outcome.ok
        ? 'ok'
        : outcome.error?.code === 'cancelled'
          ? 'cancelled'
          : 'error';
      await record(opts, 'end', {
        id: ctx.callId,
        status,
        errorCode: outcome.error?.code ?? null,
        calls: outcome.calls,
        cpuMs: outcome.cpuMs,
        at: now().toISOString(),
      });
      const meta = {
        calls,
        cpuMs: outcome.cpuMs,
        logTruncated: outcome.logTruncated,
        resultTruncated: outcome.resultTruncated,
      };
      const parts: string[] = [];
      if (outcome.ok) parts.push(`Result: ${outcome.resultJson ?? 'null'}`);
      if (outcome.resultTruncated) parts.push('(the result was cut short)');
      if (outcome.log) parts.push(`Output:\n${outcome.log.trimEnd()}`);
      if (outcome.logTruncated) parts.push('(the output was cut short)');
      if (calls.length)
        parts.push(`Tool calls: ${calls.map((c) => `${c.tool} (${c.status})`).join(', ')}`);
      if (outcome.ok) return ok(parts.join('\n'), meta);
      const err = outcome.error ?? { code: 'script_error', message: 'the script failed' };
      return fail(err.code, clip([err.message, ...parts].join('\n'), 8000), {
        calls: calls.length,
        cpuMs: outcome.cpuMs,
      });
    },
  };
}

/** `script.run` as a tool source: listed only while `scripts.enabled` is on. */
export function scriptToolSource(opts: ScriptToolOptions): ToolSourceProvider {
  const tool = scriptTool(opts);
  return {
    source: 'builtin',
    list: async () => {
      try {
        return (await opts.enabled()) ? [tool] : [];
      } catch {
        return [];
      }
    },
  };
}

async function record(
  opts: ScriptToolOptions,
  phase: 'start' | 'end',
  r: Record<string, string | number | null>,
): Promise<void> {
  const db = opts.db;
  if (!db) return;
  try {
    await db.transaction(() => {
      if (phase === 'start')
        db.raw
          .prepare(
            `INSERT INTO script_run (id, account_id, thread_id, turn_id, code_sha256, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'running', ?) ON CONFLICT (id) DO NOTHING`,
          )
          .run(r.id!, r.accountId!, r.threadId ?? null, r.turnId ?? null, r.codeSha256!, r.at!);
      else
        db.raw
          .prepare(
            'UPDATE script_run SET status = ?, error_code = ?, calls = ?, cpu_ms = ?, ended_at = ? WHERE id = ?',
          )
          .run(r.status!, r.errorCode ?? null, r.calls!, r.cpuMs!, r.at!, r.id!);
    });
  } catch {
    // The run's record is for the activity view; the tool call row and the audit remain.
  }
}
