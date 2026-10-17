// The user's own machine as a computer (`local_host`, docs/11 §2.3; FR-081, FR-210). Everything
// goes through novad under the grantee's grants: files through the staged-write operations (a
// write is staged with its diff, then committed atomically), commands sandboxed on the device.
// The computers area takes the provider late-bound; Code sessions use the same object with a
// session grantee (FR-062, environment.ts).
import { NovaError, type DeviceGrantee, type StagedWriteView } from '@nova/shared';
import type {
  Computer,
  ComputerDirent,
  ComputerExecResult,
  ComputerExecSpec,
  ComputerProvider,
  ComputerStat,
  ComputerStatus,
  SnapshotRef,
} from '../computers/types.ts';
import type { DeviceCallContext, DeviceService } from './service.ts';

export interface DeviceComputerOptions {
  accountId: string;
  deviceId: string;
  grantee: DeviceGrantee;
  /** Thread, run, agent or session the calls are made for (audit and events). */
  context?: DeviceCallContext;
  /** Refuse commands while the device is in its quiet hours (background work, FR-150). */
  respectQuietHours?: boolean;
  id?: string;
}

/** A device reached through novad, as one `Computer`. */
export class DeviceComputer implements Computer {
  readonly id: string;
  readonly kind = 'local_host' as const;
  readonly deviceId: string;
  readonly grantee: DeviceGrantee;
  readonly #svc: DeviceService;
  readonly #accountId: string;
  readonly #ctx: DeviceCallContext;
  readonly #quiet: boolean;

  constructor(svc: DeviceService, opts: DeviceComputerOptions) {
    this.#svc = svc;
    this.#accountId = opts.accountId;
    this.deviceId = opts.deviceId;
    this.grantee = opts.grantee;
    this.#ctx = opts.context ?? {};
    this.#quiet = opts.respectQuietHours ?? false;
    this.id = opts.id ?? `device:${opts.deviceId}`;
  }

  readonly fs: Computer['fs'] = {
    read: async (path: string, opts?: { maxBytes?: number }): Promise<Uint8Array> => {
      const r = await this.#svc.readFile(
        this.#accountId,
        this.deviceId,
        this.grantee,
        path,
        opts?.maxBytes,
      );
      return new Uint8Array(Buffer.from(r.contentBase64, 'base64'));
    },
    write: async (
      path: string,
      data: Uint8Array,
      opts?: { createDirs?: boolean },
    ): Promise<void> => {
      const staged = await this.stageWrite(path, data, opts);
      await this.commitWrite(staged.id);
    },
    list: async (path: string): Promise<ComputerDirent[]> => {
      const r = await this.#svc.listFiles(this.#accountId, this.deviceId, this.grantee, path);
      return r.entries;
    },
    stat: async (path: string): Promise<ComputerStat> =>
      this.#svc.statFile(this.#accountId, this.deviceId, this.grantee, path),
    delete: async (path: string): Promise<void> => {
      await this.#svc.deletePath(this.#accountId, this.deviceId, this.grantee, path, this.#ctx);
    },
    move: async (from: string, to: string): Promise<void> => {
      await this.#svc.movePath(this.#accountId, this.deviceId, this.grantee, from, to, this.#ctx);
    },
  };

  /** Stage a write and return it with its diff; nothing changes on the device until commit. */
  async stageWrite(
    path: string,
    data: Uint8Array,
    opts?: { createDirs?: boolean; baseSha256?: string },
  ): Promise<StagedWriteView> {
    return this.#svc.stage(
      this.#accountId,
      this.deviceId,
      this.grantee,
      {
        path,
        contentBase64: Buffer.from(data).toString('base64'),
        ...(opts?.baseSha256 ? { baseSha256: opts.baseSha256 } : {}),
        createDirs: opts?.createDirs ?? false,
        sessionRef: `${this.grantee.kind}:${this.grantee.id}`,
      },
      this.#ctx,
    );
  }

  async commitWrite(stagedId: string): Promise<StagedWriteView> {
    return this.#svc.commit(this.#accountId, stagedId, this.#ctx);
  }

  async discardWrite(stagedId: string): Promise<StagedWriteView> {
    return this.#svc.discard(this.#accountId, stagedId, this.#ctx);
  }

  /** Ask for a folder outside the grants; it waits for the user on the Hub or the device. */
  async requestAccess(path: string, access: 'read' | 'write', reason?: string) {
    return this.#svc.requestAccess(
      this.#accountId,
      this.deviceId,
      this.grantee,
      { path, access, ...(reason ? { reason } : {}) },
      this.#ctx,
    );
  }

  async exec(spec: ComputerExecSpec, signal: AbortSignal): Promise<ComputerExecResult> {
    signal.throwIfAborted();
    if (this.#quiet && (await this.#svc.quiet(this.#accountId, this.deviceId))) {
      throw new NovaError('policy_denied', 'the device is in its quiet hours', {
        details: { reason: 'quiet_hours' },
      });
    }
    // novad enforces the timeout on the device; an abort here stops waiting for the answer.
    const run = this.#svc.exec(this.#accountId, this.deviceId, this.grantee, spec, this.#ctx);
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
        { once: true },
      );
    });
    run.catch(() => undefined);
    return Promise.race([run, aborted]);
  }

  /** The device browser is the browser area's (local browser fallback, FR-209). */
  browser(): Promise<null> {
    return Promise.resolve(null);
  }

  /** Computer use on the device is the screen area's (FR-207). */
  screen(): Promise<null> {
    return Promise.resolve(null);
  }

  snapshot(): Promise<SnapshotRef> {
    return Promise.reject(
      new NovaError('capability_missing', 'snapshots are not available on a connected computer'),
    );
  }

  restore(): Promise<void> {
    return Promise.reject(
      new NovaError('capability_missing', 'snapshots are not available on a connected computer'),
    );
  }

  async status(): Promise<ComputerStatus> {
    try {
      const view = await this.#svc.get(this.#accountId, this.deviceId);
      if (view.status !== 'active') {
        return { state: 'stopped', substrate: 'host', detail: `the device is ${view.status}` };
      }
      const exec = view.capabilities.find((c) => c.name === 'exec');
      const files = view.capabilities.find((c) => c.name === 'files');
      if (!files?.available) {
        return { state: 'error', substrate: 'host', detail: files?.reason ?? 'no file access' };
      }
      if (!exec?.available) {
        return {
          state: 'degraded',
          substrate: 'host',
          detail: `commands unavailable: ${exec?.reason ?? 'unknown'}`,
        };
      }
      return { state: 'running', substrate: 'bwrap', detail: null };
    } catch (err) {
      return {
        state: 'error',
        substrate: null,
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  /** The user's machine is never stopped by Nova; this only ends the session's use of it. */
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `local_host` computers for the computers area: an agent's connected device (FR-081), or a
 * connection by id (`device-connection:<id>`).
 */
export class DeviceComputerProvider implements ComputerProvider {
  readonly #svc: DeviceService;

  constructor(svc: DeviceService) {
    this.#svc = svc;
  }

  async get(accountId: string, computerId: string): Promise<Computer | null> {
    const id = computerId.startsWith('device-connection:')
      ? computerId.slice('device-connection:'.length)
      : computerId;
    try {
      const c = await this.#svc.connection(accountId, id);
      if (c.status !== 'active') return null;
      return this.#computer(accountId, c.agentId, c.deviceId, `device-connection:${c.id}`);
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /** The agent's connected computer; `not_found` when it has none. */
  async forAgent(accountId: string, agentId: string): Promise<Computer> {
    const c = await this.connected(accountId, agentId);
    if (!c) throw new NovaError('not_found', 'this agent has no connected computer');
    return c;
  }

  /**
   * The computers area's `LocalHostComputers`: a `local_host` computer row's device, while an
   * agent is connected to it (the row's agent when it names one).
   */
  async open(input: {
    accountId: string;
    computerId: string;
    deviceId: string;
  }): Promise<DeviceComputer | null> {
    const active = (
      await this.#svc.connections(input.accountId, { deviceId: input.deviceId })
    ).filter((c) => c.status === 'active');
    const named = this.#svc.computerAgent(input.computerId);
    const c = named ? active.find((x) => x.agentId === named) : active[0];
    return c ? this.#computer(input.accountId, c.agentId, c.deviceId, input.computerId) : null;
  }

  async connected(accountId: string, agentId: string): Promise<DeviceComputer | null> {
    const c = await this.#svc.activeConnection(accountId, agentId);
    return c ? this.#computer(accountId, agentId, c.deviceId, `device-connection:${c.id}`) : null;
  }

  #computer(accountId: string, agentId: string, deviceId: string, id: string): DeviceComputer {
    return new DeviceComputer(this.#svc, {
      accountId,
      deviceId,
      grantee: { kind: 'agent', id: agentId },
      context: { actor: `agent:${agentId}`, agentId },
      respectQuietHours: true,
      id,
    });
  }
}
