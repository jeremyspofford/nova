// Commands by the thread that owns them (M6, FR-062, FR-078): a Code session on another machine
// (SSH, WSL, a device, a container environment) runs its commands there, not in the Hub's
// sandbox. A request names its thread in `owner` (exec tools) or `egress` (other callers); one
// without, or whose thread has no sandbox of its own, goes to the base. Each running session
// remembers the sandbox it started in, so polls, writes and kills reach the same machine.
import type { ExecOwner } from './exec-sessions.ts';
import type { RemoteFiles } from './fs-remote.ts';
import type { ExecRequestExtras } from './sandbox-process.ts';
import type { ExecRequest, ExecResult, SandboxClient } from './types.ts';

type RoutedRequest = ExecRequest & ExecRequestExtras & { owner?: ExecOwner };

/** The sandbox a thread's commands use; null for the base. */
export type ThreadSandboxPick = (accountId: string, threadId: string) => SandboxClient | null;

/**
 * The router, which also says where a thread's commands go (M7): `substrate` is the base's, so
 * the gate's isolation checks for a thread read `substrateFor` (a cloud environment's sandbox is
 * `cloud`, another machine's helper none), and availability checks read `availableFor`.
 */
export interface ThreadSandboxRouter extends SandboxClient {
  substrateFor(accountId: string | null, threadId: string | null): SandboxClient['substrate'];
  availableFor(
    accountId: string | null,
    threadId: string | null,
  ): Promise<{ ok: boolean; detail: string }>;
  /**
   * Where a thread's files are (M7, fs-remote.ts): undefined for the Hub's own disk, the remote
   * folder of a session on another machine, null when that machine cannot be reached now.
   */
  filesFor(accountId: string, threadId: string): RemoteFiles | null | undefined;
  killAll?: () => Promise<void>;
}

export function threadSandboxRouter(
  base: SandboxClient,
  pick: ThreadSandboxPick,
): ThreadSandboxRouter {
  const bySession = new Map<string, SandboxClient>();
  const byTurn = new Map<string, Set<SandboxClient>>();
  const target = (req: RoutedRequest): SandboxClient => {
    const accountId = req.owner?.accountId ?? req.egress?.accountId ?? null;
    const threadId = req.owner?.threadId ?? req.egress?.threadId ?? null;
    if (!accountId || !threadId) return base;
    return pick(accountId, threadId) ?? base;
  };
  const forget = (sessionId: string, r: ExecResult) => {
    if (r.status === 'exited') bySession.delete(sessionId);
  };
  const routed = (accountId: string | null, threadId: string | null): SandboxClient =>
    accountId && threadId ? (pick(accountId, threadId) ?? base) : base;
  const router: ThreadSandboxRouter = {
    get substrate() {
      return base.substrate;
    },
    substrateFor: (accountId, threadId) => routed(accountId, threadId).substrate,
    availableFor: (accountId, threadId) => routed(accountId, threadId).available(),
    filesFor: (accountId, threadId) => {
      const picked = accountId && threadId ? pick(accountId, threadId) : null;
      return picked ? (picked as { files?: RemoteFiles | null }).files : undefined;
    },
    available: () => base.available(),
    exec: async (req: RoutedRequest) => {
      const client = target(req);
      if (client === base) return base.exec(req);
      if (req.turnId) {
        const set = byTurn.get(req.turnId) ?? new Set<SandboxClient>();
        set.add(client);
        byTurn.set(req.turnId, set);
      }
      const r = await client.exec(req);
      if (r.status === 'running') bySession.set(r.sessionId, client);
      return r;
    },
    poll: async (sessionId, yieldMs, signal) => {
      const r = await (bySession.get(sessionId) ?? base).poll(sessionId, yieldMs, signal);
      forget(sessionId, r);
      return r;
    },
    write: async (sessionId, input) => {
      await (bySession.get(sessionId) ?? base).write(sessionId, input);
      if (input.signal === 'terminate') bySession.delete(sessionId);
    },
    killTurn: async (turnId) => {
      const others = byTurn.get(turnId);
      byTurn.delete(turnId);
      await Promise.all([
        base.killTurn(turnId),
        ...[...(others ?? [])].map((c) => c.killTurn(turnId).catch(() => undefined)),
      ]);
    },
  };
  const killAll = (base as { killAll?: () => Promise<void> }).killAll;
  if (killAll) router.killAll = () => killAll.call(base);
  return router;
}
