// Running one hook's handler (docs/08 §4.1 "Handlers"; FR-197). `command` runs a fixed argv in the
// sandbox with the event JSON on stdin and reads a result JSON from stdout; `mcp_tool` calls a tool
// on a configured MCP server after the policy gate allowed it with origin `hook`. Both answer a
// hook-config.json result, or throw.
import { NovaError, uuidv7, type ToolDescriptor } from '@nova/shared';
import { hostMatch } from '@nova/policy';
import { isWithin } from '@nova/security';
import type { Origin, SandboxClient, ToolGate, ToolResult, ToolRoot } from '../tools/types.ts';
import type { ToolScope } from '../tools/runtime.ts';
import { expandArgv, parseHookResult, type HookResult, type HookVars } from './config.ts';
import type { HookRow } from './store.ts';

/** Output a hook may print; more fails the run (a result is a few lines of JSON). */
export const MAX_HOOK_OUTPUT = 1024 * 1024;

/** MCP tools as hooks reach them (the Hub adapts its MCP manager to this). */
export interface HookMcpClient {
  /** The descriptor of an exposed tool by canonical name (`mcp:<server>.<tool>`), or null. */
  find(accountId: string, name: string): ToolDescriptor | null;
  call(
    accountId: string,
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<ToolResult>;
}

/** A hook that ran past its deadline (its own clock, which may beat the run's timer). */
export class HookTimeoutError extends Error {
  constructor() {
    super('the hook did not finish in time');
    this.name = 'HookTimeoutError';
  }
}

/** A hook that could not start: no sandbox, no MCP tool, no policy gate. */
export class HookUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookUnavailableError';
  }
}

export interface HookHandlerRun {
  row: HookRow;
  accountId: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  /** The redacted event JSON (stdin, or the tool's arguments). */
  payload: Record<string, unknown>;
  /** Untrusted origins in the payload (tool arguments or results). */
  taint: Origin[];
  scope: ToolScope | null;
  /** Aborts at the hook's timeout or when the turn ends. */
  signal: AbortSignal;
  deadline: number;
  now: () => number;
}

/**
 * The sandbox command for a fixed argv: every element single-quoted, so the shell only `exec`s
 * it and never interprets it; stderr is dropped so a warning cannot corrupt the result on stdout.
 */
export function hookArgvCommand(argv: readonly string[]): string {
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`);
  return `exec ${quoted.join(' ')} 2>/dev/null`;
}

/** Where a command hook runs: its folder, the session's roots it may see, and its network. */
export function commandPlacement(
  row: HookRow,
  scope: ToolScope | null,
): { cwd: string; roots: ToolRoot[]; network: 'off' | 'allowlist'; hosts: string[] } {
  const roots: ToolRoot[] = [];
  // Plugin hooks see the session's roots only when the plugin declared `${project}` access.
  if (row.source !== 'plugin' || row.limits?.fsProject) roots.push(...(scope?.roots ?? []));
  const base = row.baseDir;
  if (base && !roots.some((r) => isWithin(r.path, base)))
    roots.unshift({ path: base, access: 'read', label: 'Hook folder' });
  const declared =
    row.definition.handler.type === 'command' ? (row.definition.handler.network ?? []) : [];
  const hosts =
    row.source === 'plugin'
      ? declared.filter((h) => (row.limits?.network ?? []).some((p) => hostMatch(p, h)))
      : declared;
  // Network stays off unless the hook declares hosts and the session's profile has a network.
  const network = hosts.length && scope && scope.network !== 'off' ? 'allowlist' : 'off';
  return { cwd: base ?? roots[0]?.path ?? '/tmp', roots, network, hosts };
}

function readResult(text: string): HookResult {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Tolerate a line of chatter before the answer: the last line must then be the result.
    const last = trimmed.split('\n').at(-1)?.trim() ?? '';
    try {
      data = JSON.parse(last);
    } catch {
      throw new Error('the hook did not answer with JSON');
    }
  }
  const r = parseHookResult(data);
  if ('error' in r) throw new Error(r.error);
  return r;
}

/**
 * What a hook needs before it can start: a working sandbox for `command`, the MCP tool and the
 * policy gate for `mcp_tool`. Throws `HookUnavailableError` (the run is skipped, not started).
 */
export async function hookPrecondition(
  row: HookRow,
  deps: { sandbox: SandboxClient | null; mcp: HookMcpClient | null; gate: ToolGate | null },
  accountId: string,
): Promise<void> {
  const h = row.definition.handler;
  if (h.type === 'command') {
    if (!deps.sandbox)
      throw new HookUnavailableError('no sandbox is available to run command hooks');
    const avail = await deps.sandbox.available().catch((err: unknown) => ({
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }));
    if (!avail.ok) throw new HookUnavailableError(`command hooks need a sandbox: ${avail.detail}`);
    return;
  }
  if (!deps.mcp) throw new HookUnavailableError('MCP servers are not available to hooks');
  if (!deps.gate) throw new HookUnavailableError('the policy gate is not available to hooks');
  if (!deps.mcp.find(accountId, h.tool))
    throw new HookUnavailableError(`no connected MCP tool ${h.tool}`);
}

export async function runCommandHook(
  sandbox: SandboxClient | null,
  run: HookHandlerRun,
): Promise<HookResult> {
  const h = run.row.definition.handler;
  if (h.type !== 'command') throw new Error('not a command hook');
  if (!sandbox) throw new HookUnavailableError('no sandbox is available to run command hooks');
  const vars: HookVars =
    run.row.source === 'plugin' && run.row.baseDir ? { pluginRoot: run.row.baseDir } : {};
  const argv = expandArgv(h.command, vars);
  const place = commandPlacement(run.row, run.scope);
  const cmd = hookArgvCommand(argv);
  let res = await sandbox.exec({
    cmd,
    cwd: place.cwd,
    roots: place.roots,
    network: place.network,
    yieldMs: 0,
    signal: run.signal,
  });
  let output = res.output;
  if (res.status === 'running') {
    const sessionId = res.sessionId;
    try {
      await sandbox.write(sessionId, {
        text: `${JSON.stringify(run.payload)}\n`,
        closeStdin: true,
      });
      while (res.status === 'running') {
        const left = run.deadline - run.now();
        if (left <= 0) throw new HookTimeoutError();
        if (run.signal.aborted) throw new Error('the hook was stopped');
        res = await sandbox.poll(sessionId, left, run.signal);
        output += res.output;
        if (output.length > MAX_HOOK_OUTPUT) throw new Error('the hook printed too much output');
      }
    } catch (err) {
      await sandbox.write(sessionId, { signal: 'terminate' }).catch(() => undefined);
      throw err;
    }
  }
  if (res.exitCode !== 0) throw new Error(`the hook exited with code ${res.exitCode}`);
  if (output.length > MAX_HOOK_OUTPUT) throw new Error('the hook printed too much output');
  return readResult(output);
}

export async function runMcpHook(
  mcp: HookMcpClient | null,
  gate: ToolGate | null,
  run: HookHandlerRun,
): Promise<HookResult> {
  const h = run.row.definition.handler;
  if (h.type !== 'mcp_tool') throw new Error('not an MCP tool hook');
  if (!mcp) throw new HookUnavailableError('MCP servers are not available to hooks');
  if (!gate) throw new HookUnavailableError('the policy gate is not available to hooks');
  const tool = mcp.find(run.accountId, h.tool);
  if (!tool) throw new HookUnavailableError(`no connected MCP tool ${h.tool}`);
  // The event wins over the handler's fixed arguments, so a configuration cannot mask it.
  const args: Record<string, unknown> = { ...(h.arguments ?? {}), ...run.payload };
  const preview = JSON.stringify(args);
  const outcome = await gate.check(
    {
      accountId: run.accountId,
      threadId: run.threadId,
      turnId: run.turnId ?? '',
      callId: uuidv7(),
      projectId: run.projectId,
      mode: 'chat',
      tool,
      args,
      argsPreview: preview.length > 500 ? `${preview.slice(0, 499)}…` : preview,
      provenance: { taint: run.taint },
      profile: run.scope?.profile ?? { id: 'read-only', hash: '' },
      origin: 'hook',
      ...(run.scope ? { roots: run.scope.roots } : {}),
    },
    run.signal,
  );
  if (outcome.effect !== 'allow')
    throw new NovaError('policy_denied', `the policy did not allow ${h.tool}: ${outcome.reason}`);
  const left = Math.max(1, run.deadline - run.now());
  const res = await mcp.call(run.accountId, h.tool, args, { signal: run.signal, timeoutMs: left });
  if (!res.ok) throw new Error(`${h.tool} failed: ${res.error.message}`);
  const structured = res.meta?.structuredContent;
  if (structured !== undefined && typeof structured === 'object' && structured !== null) {
    const r = parseHookResult(structured);
    if ('error' in r) throw new Error(r.error);
    return r;
  }
  const text = res.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  return readResult(text);
}
