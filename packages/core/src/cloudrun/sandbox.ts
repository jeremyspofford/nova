// A cloud environment as the sandbox of a Code session's or Work run's commands (FR-108, FR-071;
// ADR-095 decision 4). The agent loop and the policy gate stay on the Hub: a command reaches this
// client only after the gate allowed it, and runs on the runner inside the runner's own sandbox.
// Each thread gets its own lease (a runner run with caps, FR-116); the command's output is read
// from the runner by offset, so a dropped connection loses nothing: the next read reattaches and
// shows what was buffered meanwhile, and the command keeps running there while the Hub (or the
// user's client) is away. Live output feeds the tool call's progress in the session view.
import { NovaError, isNovaError } from '@nova/shared';
import type { ExecRequestExtras } from '../tools/sandbox-process.ts';
import type { ExecRequest, ExecResult, SandboxClient } from '../tools/types.ts';
import type { RunnerClient } from './client.ts';

/** A thread's lease on the environment. */
export interface CloudLease {
  /** The Hub's cloud_run id. */
  id: string;
  runnerRunId: string;
}

export interface CloudSandboxDeps {
  environmentId: string;
  runnerEnvironmentId: string;
  client: () => Promise<RunnerClient>;
  /** The lease of a thread (null: the environment's own, for checks and setup). */
  lease: (threadId: string | null) => Promise<CloudLease>;
  /** A command was refused or stopped at a cap: the lease is capped (FR-116). */
  onCap?: (lease: CloudLease, err: NovaError) => Promise<void>;
  /** A command started: its process belongs to this lease (process listings, FR-078). */
  onProcess?: (lease: CloudLease, processId: string) => void;
  /**
   * Whether commands may have network on the runner (`cloud.runner.unrestrictedNetwork`). The
   * runner's network bypasses the Hub's egress proxy and its allowlists, so without this every
   * command gets none, whatever the Hub's own network mode for the turn (fail closed).
   */
  network?: () => Promise<boolean>;
}

interface Proc {
  id: string;
  lease: CloudLease;
  offset: number;
  turnId: string | null;
}

type RoutedRequest = ExecRequest &
  ExecRequestExtras & { owner?: { accountId?: string; threadId?: string | null } };

/** How long one long poll waits on the runner. */
const POLL_MS = 10_000;

export class CloudSandbox implements SandboxClient {
  readonly substrate = 'cloud' as const;
  readonly #d: CloudSandboxDeps;
  readonly #procs = new Map<string, Proc>();
  /** Leases a turn used, so cancelling the turn reaches its commands there. */
  readonly #turnLeases = new Map<string, Set<CloudLease>>();

  constructor(deps: CloudSandboxDeps) {
    this.#d = deps;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.#d.client();
      const env = await client.environment(this.#d.runnerEnvironmentId);
      if (env.status !== 'ready')
        return {
          ok: false,
          detail: `the cloud environment is ${env.status}${env.detail ? `: ${env.detail}` : ''}`,
        };
      return { ok: true, detail: `cloud runner (${env.substrate ?? 'sandbox'})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const r = req as RoutedRequest;
    const threadId = r.owner?.threadId ?? r.egress?.threadId ?? null;
    const lease = await this.#d.lease(threadId);
    const client = await this.#d.client();
    const turnId = req.turnId ?? null;
    const network =
      req.network !== 'off' && (await this.#d.network?.().catch(() => false)) === true;
    let started;
    try {
      started = await client.exec(lease.runnerRunId, {
        cmd: req.cmd,
        cwd: req.cwd,
        ...(req.env && Object.keys(req.env).length ? { env: req.env } : {}),
        tag: turnId ?? 'exec',
        // The environment's own network setting still applies on the runner.
        network: network ? 'on' : 'off',
        readOnly: req.roots.length > 0 && req.roots.every((x) => x.access === 'read'),
        ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}),
        stdin: true,
      });
    } catch (err) {
      if (isNovaError(err) && err.code === 'budget_exhausted') await this.#d.onCap?.(lease, err);
      throw err;
    }
    this.#d.onProcess?.(lease, started.id);
    const proc: Proc = { id: started.id, lease, offset: 0, turnId };
    this.#procs.set(proc.id, proc);
    if (turnId) {
      const set = this.#turnLeases.get(turnId) ?? new Set<CloudLease>();
      set.add(lease);
      this.#turnLeases.set(turnId, set);
    }
    return this.#collect(proc, req.yieldMs, req.signal, r.onOutput);
  }

  async poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const proc = this.#procs.get(sessionId);
    if (!proc) throw new NovaError('not_found', 'no such exec session');
    return this.#collect(proc, yieldMs, signal);
  }

  async write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    const proc = this.#procs.get(sessionId);
    if (!proc) throw new NovaError('not_found', 'no such exec session');
    await (await this.#d.client()).input(proc.lease.runnerRunId, proc.id, input);
    if (input.signal === 'terminate') this.#procs.delete(sessionId);
  }

  async killTurn(turnId: string): Promise<void> {
    const leases = this.#turnLeases.get(turnId);
    this.#turnLeases.delete(turnId);
    for (const p of [...this.#procs.values()]) if (p.turnId === turnId) this.#procs.delete(p.id);
    if (!leases?.size) return;
    const client = await this.#d.client().catch(() => null);
    if (!client) return;
    await Promise.all([...leases].map((l) => client.kill(l.runnerRunId, turnId).catch(() => 0)));
  }

  /** Read until the command ends or `yieldMs` passes; a dropped runner is retried meanwhile. */
  async #collect(
    proc: Proc,
    yieldMs: number,
    signal: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<ExecResult> {
    const end = Date.now() + Math.max(0, yieldMs);
    let out = '';
    let failures = 0;
    for (;;) {
      if (signal.aborted) {
        await this.#terminate(proc);
        throw new NovaError('cancelled', 'the command was cancelled');
      }
      const wait = Math.max(0, Math.min(POLL_MS, end - Date.now()));
      let r;
      try {
        const client = await this.#d.client();
        r = await client.read(proc.lease.runnerRunId, proc.id, proc.offset, wait, signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) {
          await this.#terminate(proc);
          throw new NovaError('cancelled', 'the command was cancelled');
        }
        const unreachable = isNovaError(err) && err.code === 'node_unavailable';
        if (!unreachable) throw err;
        if (Date.now() >= end)
          return {
            status: 'running',
            sessionId: proc.id,
            output: `${out}\n[the cloud runner cannot be reached right now; the command keeps running there]\n`,
          };
        failures++;
        await new Promise((res) => setTimeout(res, Math.min(2_000, 100 * 2 ** failures)));
        continue;
      }
      if (r.dropped) out += `\n[${r.dropped} bytes of output were dropped]\n`;
      out += r.data;
      if (r.data) onOutput?.(r.data);
      proc.offset = r.offset;
      if (!r.running) {
        this.#procs.delete(proc.id);
        return { status: 'exited', exitCode: r.exitCode ?? -1, output: out };
      }
      if (Date.now() >= end) return { status: 'running', sessionId: proc.id, output: out };
    }
  }

  async #terminate(proc: Proc): Promise<void> {
    this.#procs.delete(proc.id);
    try {
      await (
        await this.#d.client()
      ).input(proc.lease.runnerRunId, proc.id, { signal: 'terminate' });
    } catch {
      // Gone already, or the runner is away: the run's caps still stop it.
    }
  }
}
