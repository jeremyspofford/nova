// Starting an external agent's process (FR-203): always in the session's own sandbox, never on
// the Hub itself (docs/12 §7: unsandboxed execution is never a fallback). The sandbox is the one
// the session's commands are routed to, and it must be a real one: an SSH, WSL or device
// environment runs commands on that machine with no sandbox (no substrate), so an agent is refused
// there, and availability is checked on that same client. The session folder is mounted read-only,
// so the agent cannot change the project except through Nova's `fs/*` and `terminal/*` methods.
// Its network is off unless the adapter declares the hosts its model service needs; then its
// egress policy is built from those hosts only (the global deny list still applies, no session or
// global grants, no injected credentials), which only the Hub's egress proxy can enforce, so a
// substrate without it (a cloud runner) gets no network. The protocol runs over the process's
// stdin and stdout; its stderr is discarded so it cannot break the framing.
import { NovaError } from '@nova/shared';
import type { SandboxClient } from '../tools/types.ts';
import type { ExecRequestExtras } from '../tools/sandbox-process.ts';
import type { LineTransport } from './jsonrpc.ts';

export interface AgentLaunch {
  accountId: string;
  threadId: string;
  delegationId: string;
  command: string;
  args: string[];
  /** Resolved values of the adapter's own `secret://agent-adapter/<id>/` references. */
  env: Record<string, string>;
  /** The session folder: the working directory, mounted read-only. */
  folder: string;
  /** The adapter's declared hosts (its model service); empty: no network. */
  hosts: string[];
  signal: AbortSignal;
}

export type AgentLauncher = (launch: AgentLaunch) => Promise<LineTransport>;

/** The sandbox a session's commands run in (its own environment's, else the Hub's). */
export type AgentSandboxPick = (accountId: string, threadId: string) => SandboxClient | null;

/** How often the sandbox is asked for new output (its poll waits this long). */
export const AGENT_POLL_MS = 50;

/** Substrates whose network goes only through the Hub's egress proxy (docs/12 §8). */
const PROXIED: ReadonlySet<SandboxClient['substrate']> = new Set([
  'container',
  'os_sandbox',
  'micro_vm',
]);

function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The agent's command line for the sandbox shell, with stderr discarded. */
export function agentCommandLine(command: string, args: readonly string[]): string {
  return `exec ${[command, ...args].map(quote).join(' ')} 2>/dev/null`;
}

/**
 * The sandbox an agent may run in for this session: refused when there is none, when it is no
 * sandbox at all (another machine's helper), or when it is not available right now.
 */
export async function agentSandbox(
  pick: AgentSandboxPick,
  accountId: string,
  threadId: string,
): Promise<SandboxClient> {
  const sb = pick(accountId, threadId);
  if (!sb) throw new NovaError('sandbox_unavailable', 'no sandbox is available for the agent');
  if (!sb.substrate)
    throw new NovaError(
      'sandbox_unavailable',
      "this session's environment runs commands without a sandbox (SSH, WSL or a device), so an external agent cannot run there",
      { details: { reason: 'no_substrate' } },
    );
  const avail = await sb.available();
  if (!avail.ok) throw new NovaError('sandbox_unavailable', avail.detail);
  return sb;
}

/** Launch agents in the session's sandbox: one exec session per agent, polled for output. */
export function sandboxAgentLauncher(pick: AgentSandboxPick): AgentLauncher {
  return async (l) => {
    const sb = await agentSandbox(pick, l.accountId, l.threadId);
    const hosts = l.hosts.filter((h) => h && h !== '*');
    if (hosts.length && !PROXIED.has(sb.substrate))
      throw new NovaError(
        'sandbox_unavailable',
        "this session's sandbox cannot hold an agent to its declared hosts, so the agent cannot have network there",
        { details: { reason: 'no_egress_proxy' } },
      );
    const req: Parameters<SandboxClient['exec']>[0] & ExecRequestExtras = {
      cmd: agentCommandLine(l.command, l.args),
      cwd: l.folder,
      roots: [{ path: l.folder, access: 'read', label: 'Session folder' }],
      network: hosts.length ? 'allowlist' : 'off',
      env: l.env,
      yieldMs: 0,
      signal: l.signal,
      egress: {
        accountId: l.accountId,
        threadId: l.threadId,
        scope: { kind: 'sandbox', id: `agent-${l.delegationId}` },
        policy: { allow: hosts },
      },
    };
    const first = await sb.exec(req);
    // Lines and the close are held until someone listens: the first output may come before.
    const lines: ((line: string) => void)[] = [];
    const closers: ((reason: string) => void)[] = [];
    const held: string[] = [];
    let buffer = '';
    let closed: string | null = null;
    const emit = (line: string) => {
      if (!lines.length) held.push(line);
      else for (const cb of lines) cb(line);
    };
    const feed = (chunk: string) => {
      buffer += chunk;
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        emit(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        i = buffer.indexOf('\n');
      }
      // A line that never ends is not a message; it is dropped rather than held forever.
      if (buffer.length > 8 * 1024 * 1024) buffer = '';
    };
    const end = (reason: string) => {
      if (closed !== null) return;
      closed = reason;
      for (const cb of closers) cb(reason);
    };
    const stop = new AbortController();
    const sessionId = first.status === 'running' ? first.sessionId : null;
    feed(first.output);
    if (first.status === 'exited') end(`the agent exited with code ${first.exitCode}`);
    else
      void (async () => {
        while (closed === null && !stop.signal.aborted) {
          try {
            const r = await sb.poll(first.sessionId, AGENT_POLL_MS, stop.signal);
            if (r.output) feed(r.output);
            if (r.status === 'exited') {
              end(`the agent exited with code ${r.exitCode}`);
              return;
            }
          } catch {
            end('the agent is no longer running');
            return;
          }
        }
      })();
    return {
      send: (line) => {
        if (closed === null && sessionId)
          void sb.write(sessionId, { text: `${line}\n` }).catch(() => undefined);
      },
      onLine: (cb) => {
        lines.push(cb);
        const early = held.splice(0);
        if (early.length) queueMicrotask(() => early.forEach((l) => cb(l)));
      },
      onClose: (cb) => {
        closers.push(cb);
        const reason = closed;
        if (reason !== null) queueMicrotask(() => cb(reason));
      },
      close: async () => {
        stop.abort();
        if (closed === null && sessionId)
          await sb.write(sessionId, { signal: 'terminate' }).catch(() => undefined);
        end('closed');
      },
    };
  };
}
