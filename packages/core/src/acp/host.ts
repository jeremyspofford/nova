// What an external agent may ask of Nova, answered through Nova's policy engine (FR-203,
// docs/12 §6.2). Every operation the agent asks for (read a file, write a file, run a command,
// read or stop it) is a tool call through the tool runtime: the same validation, hooks, gate,
// approvals, sandbox, `tool_call` row and audit as Nova's own agent in that Code session, so its
// permission mode applies, and a write through `fs.write` is captured as one of the session's
// diffs. The calls carry the user's delegation as their instruction and the taint
// `external_agent`, so rules that act on a request alone never apply to them.
//
// Permission requests are answered by the engine too. For the kinds Nova then performs itself
// (read, search, edit, delete, move, execute) the engine's verdict for that operation is
// previewed: a deny rejects at once, anything else is allowed here because the operation itself
// still passes the gate, which asks the user when its rule says so. Kinds Nova does not perform
// (fetch, think, other) are decided by the gate itself, with an approval when it asks; the agent's
// own process cannot do them anyway beyond what its sandbox allows.
import { uuidv7, type ToolDescriptor } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { ToolRuntime } from '../tools/runtime.ts';
import { builtinDescriptor } from '../tools/builtin.ts';
import { previewOf } from '../tools/text.ts';
import type { GateRequest, Provenance, ToolGate } from '../tools/types.ts';
import { JsonRpcError, JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS } from './jsonrpc.ts';
import type { AcpHost, PermissionAnswer, TerminalOutput } from './client.ts';
import { toolKind, type PermissionRequest, type ToolKind } from './protocol.ts';
import { terminalEnv } from './env.ts';

/** An operation Nova refused or could not do, as the agent sees it. */
export const ACP_DENIED = -32001;
/** Terminals one delegation may hold at once (released ones do not count). */
export const MAX_AGENT_TERMINALS = 8;
/** Output kept per terminal, whatever limit the agent asks for (the newest is kept). */
export const MAX_TERMINAL_OUTPUT = 1024 * 1024;

/** One permission request and how the engine answered it (for the delegation's audit). */
export interface PermissionDecision {
  kind: ToolKind;
  title: string | null;
  answer: PermissionAnswer;
  via: 'preview' | 'gate';
  reason: string;
}

export interface PolicyAcpHostOptions {
  runtime: ToolRuntime;
  gate: ToolGate;
  accountId: string;
  threadId: string;
  projectId: string | null;
  /** The delegation: its id stands in for the user's message that authorized it. */
  delegationId: string;
  adapterName: string;
  /** The session folder; the agent's paths must be inside it. */
  folder: string;
  signal: AbortSignal;
  onDecision?: (d: PermissionDecision) => void;
  /**
   * Whether external agents are still allowed (`externalAgents.enabled`), asked before every
   * request the agent makes; when it says no, `onInactive` stops the delegation and the request
   * is refused.
   */
  active?: () => Promise<boolean>;
  onInactive?: () => void;
}

/** Descriptors for what an agent may ask that Nova does not perform itself. */
const EXTERNAL: Record<'fetch' | 'think' | 'other', ToolDescriptor> = {
  fetch: builtinDescriptor({
    name: 'acp.fetch',
    title: "An external agent's network request",
    description: 'An external coding agent asks to fetch something from the network.',
    inputSchema: { type: 'object' },
    annotations: { requiresNetwork: true, action: 'read' },
    effects: ['network'],
  }),
  think: builtinDescriptor({
    name: 'acp.think',
    title: "An external agent's reasoning step",
    description: 'An external coding agent asks to think; nothing happens outside it.',
    inputSchema: { type: 'object' },
    annotations: { readOnly: true, action: 'read' },
  }),
  other: builtinDescriptor({
    name: 'acp.action',
    title: "An external agent's action",
    description: 'An external coding agent asks to do something Nova cannot classify.',
    inputSchema: { type: 'object' },
    annotations: { destructive: true, action: 'execute' },
    effects: ['exec'],
  }),
};

/** The Nova tool that performs a permission request's kind, when Nova performs it. */
function routedTool(kind: ToolKind): string | null {
  switch (kind) {
    case 'read':
    case 'search':
      return 'fs.read';
    case 'edit':
    case 'move':
      return 'fs.write';
    case 'delete':
      return 'fs.delete';
    case 'execute':
      return 'exec.run';
    default:
      return null;
  }
}

interface Terminal {
  sessionId: string | null;
  output: string;
  truncated: boolean;
  exit: { exitCode: number | null; signal: string | null } | null;
  limit: number;
}

const EXIT_LINE = /^Exit code (-?\d+)\n/;
const RUNNING_LINE = /^Still running \(session ([^)\s]+)\)\.[^\n]*\n?/;

function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function policyAcpHost(o: PolicyAcpHostOptions): AcpHost & {
  terminals: Map<string, Terminal>;
  /** Stop every command the agent started (the delegation ended). */
  closeAll(): Promise<void>;
} {
  const terminals = new Map<string, Terminal>();
  /** Turned off since the delegation started: refuse, and stop it (fail closed). */
  const guard = async (): Promise<boolean> => {
    if (!o.active) return true;
    const on = await o.active().catch(() => false);
    if (!on) o.onInactive?.();
    return on;
  };
  const refuseOff = async () => {
    if (!(await guard())) throw new JsonRpcError(ACP_DENIED, 'external agents were turned off');
  };
  /** A command is stopped directly in the sandbox: stopping never needs an approval. */
  const terminate = async (sessionId: string) => {
    await o.runtime.sandbox.write(sessionId, { signal: 'terminate' }).catch(() => undefined);
  };
  const provenance = (): Provenance => ({
    userInstruction: { messageId: `delegation:${o.delegationId}`, accountId: o.accountId },
    taint: ['external_agent'],
  });
  // The protocol's paths are absolute; the tools keep them inside the session's roots.
  const absolute = (path: string) => {
    if (!path.startsWith('/'))
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'paths must be absolute');
    return path;
  };

  /** One operation through the tool runtime, exactly like a model call in the session. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const def = await o.runtime.registry.find(o.accountId, name);
    const scope = await o.runtime.scopeFor(o.accountId, o.threadId, o.projectId);
    const out = await o.runtime.execute({
      callId: uuidv7(),
      accountId: o.accountId,
      threadId: o.threadId,
      turnId: null,
      projectId: o.projectId,
      mode: 'code',
      origin: 'model',
      def,
      name,
      args,
      modelCallId: null,
      messageId: null,
      partIdx: 0,
      provenance: provenance(),
      scope,
      signal: o.signal,
      extras: {
        messageId: null,
        network: scope.network,
        deny: scope.deny ?? [],
        cite: (items) => items.map((_, i) => i + 1),
        searchTools: () => [],
      },
    });
    if (!out.ok)
      throw new JsonRpcError(
        ACP_DENIED,
        out.error?.message ?? `the ${name} call ended ${out.status}`,
        {
          status: out.status,
          code: out.error?.code ?? null,
        },
      );
    return out.text;
  };

  const gateRequest = async (
    tool: ToolDescriptor,
    args: unknown,
    resource?: GateRequest['resource'],
  ): Promise<Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'>> => {
    const scope = await o.runtime.scopeFor(o.accountId, o.threadId, o.projectId);
    const req: Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'> = {
      accountId: o.accountId,
      threadId: o.threadId,
      projectId: o.projectId,
      mode: 'code',
      tool,
      args,
      provenance: provenance(),
      profile: scope.profile,
      roots: scope.roots,
      origin: 'model',
    };
    if (resource) req.resource = resource;
    return req;
  };

  const terminal = (id: string): Terminal => {
    const t = terminals.get(id);
    if (!t) throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'unknown terminal');
    return t;
  };
  const take = (t: Terminal, text: string) => {
    const exited = EXIT_LINE.exec(text);
    if (exited) {
      t.exit = { exitCode: Number(exited[1]), signal: null };
      t.sessionId = null;
      t.output += text.slice(exited[0].length);
    } else {
      const running = RUNNING_LINE.exec(text);
      if (running) {
        t.sessionId = running[1]!;
        t.output += text.slice(running[0].length);
      } else t.output += text;
    }
    if (Buffer.byteLength(t.output) > t.limit) {
      // Keep the newest output within the limit, as the protocol asks.
      const buf = Buffer.from(t.output);
      t.output = buf.subarray(buf.length - t.limit).toString('utf8');
      t.truncated = true;
    }
  };

  return {
    terminals,

    async requestPermission(req: PermissionRequest): Promise<PermissionAnswer> {
      if (!(await guard())) return 'reject';
      const kind = toolKind(req.toolCall.kind);
      const title = req.toolCall.title ?? null;
      const path = req.toolCall.locations?.[0]?.path;
      const routed = routedTool(kind);
      const decide = (answer: PermissionAnswer, via: 'preview' | 'gate', reason: string) => {
        o.onDecision?.({ kind, title, answer, via, reason });
        return answer;
      };
      try {
        if (routed) {
          const def = await o.runtime.registry.find(o.accountId, routed);
          if (!def) return decide('reject', 'preview', `${routed} is not available`);
          const raw = req.toolCall.rawInput;
          const command =
            raw &&
            typeof raw === 'object' &&
            typeof (raw as { command?: unknown }).command === 'string'
              ? (raw as { command: string }).command
              : undefined;
          const args: Record<string, unknown> =
            routed === 'exec.run' ? { cmd: command ?? title ?? '' } : { path: path ?? o.folder };
          const p = await o.gate.preview(
            await gateRequest(
              def.descriptor,
              args,
              routed === 'exec.run' ? undefined : { kind: 'path', value: path ?? o.folder },
            ),
          );
          if (p.effect === 'deny') return decide('reject', 'preview', p.reason);
          return decide('allow', 'preview', p.reason);
        }
        const tool = EXTERNAL[kind === 'fetch' ? 'fetch' : kind === 'think' ? 'think' : 'other'];
        const args = { title, rawInput: req.toolCall.rawInput ?? null };
        const base = await gateRequest(tool, args);
        const outcome = await o.gate.check(
          { ...base, callId: uuidv7(), turnId: '', argsPreview: previewOf(args, defaultRedactor) },
          o.signal,
        );
        return decide(outcome.effect === 'allow' ? 'allow' : 'reject', 'gate', outcome.reason);
      } catch (err) {
        // The engine could not answer: reject (fail closed).
        const reason = err instanceof Error ? err.message : String(err);
        return decide('reject', 'gate', `the policy engine failed: ${reason}`);
      }
    },

    async readTextFile(req) {
      await refuseOff();
      const args: Record<string, unknown> = { path: absolute(req.path) };
      if (req.line !== undefined) {
        args.startLine = req.line;
        if (req.limit !== undefined) args.endLine = req.line + req.limit - 1;
      } else if (req.limit !== undefined) {
        args.startLine = 1;
        args.endLine = req.limit;
      }
      const text = await call('fs.read', args);
      // A whole file that did not fit is refused rather than handed over cut: an agent that
      // wrote it back would lose the rest.
      if (
        /^\[[^\n]*truncated; read later parts with startLine\]\n/.test(text) ||
        /\n\[\.\.\. \d+ characters omitted \.\.\.\]\n/.test(text)
      )
        throw new JsonRpcError(
          ACP_DENIED,
          'the file is too large to read whole; read it by line and limit',
        );
      return text.replace(/^\[[^\n]*: lines \d+-\d+ of \d+\]\n/, '');
    },

    async writeTextFile(req) {
      await refuseOff();
      await call('fs.write', { path: absolute(req.path), content: req.content });
    },

    async createTerminal(req) {
      await refuseOff();
      if (terminals.size >= MAX_AGENT_TERMINALS)
        throw new JsonRpcError(
          ACP_DENIED,
          `at most ${MAX_AGENT_TERMINALS} terminals at once; release one first`,
        );
      // The variables the agent asks for pass the allowlist (env.ts) as leading assignments, so
      // the policy engine judges the command with them.
      const vars = terminalEnv(req.env).pass.map(([k, v]) => `${k}=${quote(v)}`);
      const cmd = [...vars, ...[req.command, ...(req.args ?? [])].map(quote)].join(' ');
      const args: Record<string, unknown> = { cmd, yieldMs: 120_000 };
      if (req.cwd) args.cwd = absolute(req.cwd);
      const id = `term-${uuidv7()}`;
      const t: Terminal = {
        sessionId: null,
        output: '',
        truncated: false,
        exit: null,
        limit: Math.min(req.outputByteLimit ?? MAX_TERMINAL_OUTPUT, MAX_TERMINAL_OUTPUT),
      };
      take(t, await call('exec.run', args));
      terminals.set(id, t);
      return id;
    },

    async terminalOutput(id): Promise<TerminalOutput> {
      await refuseOff();
      const t = terminal(id);
      if (t.sessionId && !t.exit)
        take(t, await call('exec.poll', { sessionId: t.sessionId, yieldMs: 0 }));
      return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
    },

    async waitForExit(id) {
      await refuseOff();
      const t = terminal(id);
      while (!t.exit && t.sessionId) {
        if (o.signal.aborted) throw new JsonRpcError(JSONRPC_INTERNAL_ERROR, 'cancelled');
        take(t, await call('exec.poll', { sessionId: t.sessionId, yieldMs: 120_000 }));
      }
      return t.exit ?? { exitCode: null, signal: null };
    },

    async killTerminal(id) {
      const t = terminal(id);
      if (t.sessionId && !t.exit) {
        await terminate(t.sessionId);
        t.exit = { exitCode: null, signal: 'SIGTERM' };
        t.sessionId = null;
      }
    },

    async releaseTerminal(id) {
      const t = terminals.get(id);
      if (!t) return;
      if (t.sessionId && !t.exit) await terminate(t.sessionId);
      terminals.delete(id);
    },

    async closeAll() {
      const running = [...terminals.values()].filter((t) => t.sessionId && !t.exit);
      terminals.clear();
      await Promise.all(running.map((t) => terminate(t.sessionId!)));
    },
  };
}
