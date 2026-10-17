// Cloud computers (FR-080, docs/11 §2.1). A cloud runner serves a computer away from the user's
// devices; M6 ships only the mock runner, an in-process stand-in that keeps the computer's files
// in a folder on the Hub and runs its commands in the local sandbox, so the agent journeys work
// offline. Its status says plainly that it is a mock on this Hub (substrate `cloud_stub`): it
// does not keep working while the Hub is off. A real runner (P2: the same interface served by a
// user-run runner) plugs in here.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxClient } from '../tools/types.ts';
import { DirComputer, type ComputerHost } from './computer.ts';
import type { Computer } from './types.ts';

export interface CloudRunner {
  /** Recorded as the computer's provider (`mock_cloud`). */
  readonly name: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  /** The computer, provisioned on first use. */
  open(input: {
    accountId: string;
    computerId: string;
    agentId: string | null;
    snapshotsDir: string;
    host: ComputerHost;
  }): Promise<Computer>;
  /** Remove the computer's files (the agent was deleted). */
  purge?(computerId: string): Promise<void>;
}

export interface MockCloudRunnerOptions {
  /** Where the mock keeps its computers' files (persistent across Hub restarts). */
  dir: string;
  /** The local sandbox its commands run in. */
  sandbox: () => SandboxClient;
}

export class MockCloudRunner implements CloudRunner {
  readonly name = 'mock_cloud';
  readonly #o: MockCloudRunnerOptions;

  constructor(opts: MockCloudRunnerOptions) {
    this.#o = opts;
  }

  /** Its own folder for one computer. */
  rootOf(computerId: string): string {
    return join(this.#o.dir, computerId);
  }

  available(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({
      ok: true,
      detail:
        'Mock cloud runner on this Hub: files are kept here and commands run in the local sandbox.',
    });
  }

  open(input: {
    accountId: string;
    computerId: string;
    agentId: string | null;
    snapshotsDir: string;
    host: ComputerHost;
  }): Promise<Computer> {
    return Promise.resolve(
      new DirComputer({
        id: input.computerId,
        accountId: input.accountId,
        kind: 'cloud',
        agentId: input.agentId,
        root: this.rootOf(input.computerId),
        snapshotsDir: input.snapshotsDir,
        sandbox: this.#o.sandbox,
        host: input.host,
        substrateLabel: 'cloud_stub',
        description:
          'Mock cloud computer on this Hub (M6): it stops when the Hub stops; commands run in the local sandbox.',
      }),
    );
  }

  async purge(computerId: string): Promise<void> {
    await rm(this.rootOf(computerId), { recursive: true, force: true });
  }
}
