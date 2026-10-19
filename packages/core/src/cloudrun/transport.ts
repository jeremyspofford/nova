// A cloud environment as an EnvironmentTransport (FR-213, FR-071; packages/core/src/code/
// transport.ts): the Code area's Git and file operations for a session in a cloud environment run
// on the runner, in its sandbox, bytes in and out (no shell between the arguments). They count
// against the environment's own lease (`system`), not a session's. Nova's state folder there is
// /nova, outside /workspace and its snapshots.
import type {
  EnvironmentTransport,
  TransportRunRequest,
  TransportRunResult,
} from '../code/transport.ts';
import type { RunnerClient } from './client.ts';
import type { CloudLease } from './sandbox.ts';

/** Where Nova keeps its own state in a cloud environment (the runner's STATE_DIR). */
export const CLOUD_STATE_DIR = '/nova';

export class CloudTransport implements EnvironmentTransport {
  readonly label: string;
  readonly #client: () => Promise<RunnerClient>;
  readonly #lease: () => Promise<CloudLease>;

  constructor(opts: {
    label?: string;
    client: () => Promise<RunnerClient>;
    lease: () => Promise<CloudLease>;
  }) {
    this.label = opts.label ?? 'the cloud runner';
    this.#client = opts.client;
    this.#lease = opts.lease;
  }

  async run(req: TransportRunRequest): Promise<TransportRunResult> {
    const lease = await this.#lease();
    const client = await this.#client();
    // The sandbox starts from a cleared environment, so `unset` needs nothing more than leaving
    // those names out.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env ?? {})) if (!req.unset?.includes(k)) env[k] = v;
    return client.runProgram(
      lease.runnerRunId,
      {
        argv: req.argv,
        cwd: req.cwd,
        env,
        ...(req.input !== undefined ? { stdin: Buffer.from(req.input) } : {}),
        timeoutMs: req.timeoutMs ?? 120_000,
        ...(req.maxBytes ? { maxBytes: req.maxBytes } : {}),
      },
      req.signal,
    );
  }

  stateDir(): Promise<string> {
    return Promise.resolve(CLOUD_STATE_DIR);
  }
}
