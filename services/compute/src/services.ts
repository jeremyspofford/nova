// The compute node's managed services (FR-126, FR-145; contracts/hub-api.md §2
// `/node/v1/services/:name/{start,stop,restart}`, plus `status` and a list, M7.5): `jobs`, the
// node's own job API (stopped, it takes no new jobs; restart cancels what runs), and `backend`,
// the model server, only when the node operator named the systemd unit that runs it
// (`--backend-unit`). Units are driven through `systemctl` without a shell, behind an interface
// with a fake for tests; nothing else on the machine can be started or stopped from the Hub.
import { NovaError, type NodeServiceView } from '@nova/shared';
import { execRunner, type CommandRunner } from './vram.ts';

export type ServiceAction = 'start' | 'stop' | 'restart' | 'status';

export interface UnitController {
  status(unit: string): Promise<'running' | 'stopped' | 'unknown'>;
  act(unit: string, action: 'start' | 'stop' | 'restart'): Promise<void>;
}

/** A systemd unit name the node may manage (never an option, never a path). */
export const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,199}$/;

export function systemctlController(run: CommandRunner = execRunner): UnitController {
  return {
    async status(unit) {
      const r = await run('systemctl', ['is-active', '--', unit], 10_000);
      const s = r.stdout.trim();
      return s === 'active'
        ? 'running'
        : s === 'inactive' || s === 'failed'
          ? 'stopped'
          : 'unknown';
    },
    async act(unit, action) {
      const r = await run('systemctl', [action, '--', unit], 60_000);
      if (r.code !== 0)
        throw new NovaError('server_error', `systemctl ${action} ${unit} failed`, {
          details: { reason: 'unit_failed', exitCode: r.code },
        });
    },
  };
}

/** Units in memory, for tests. */
export function fakeUnitController(
  initial: Record<string, 'running' | 'stopped'> = {},
): UnitController & { units: Map<string, 'running' | 'stopped'>; calls: string[] } {
  const units = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    units,
    calls,
    status: (unit) => Promise.resolve(units.get(unit) ?? 'unknown'),
    act(unit, action) {
      calls.push(`${action} ${unit}`);
      if (!units.has(unit)) return Promise.reject(new Error(`no unit ${unit}`));
      units.set(unit, action === 'stop' ? 'stopped' : 'running');
      return Promise.resolve();
    },
  };
}

/** What the job API exposes to the services. */
export interface JobsControl {
  stopped(): boolean;
  setStopped(stopped: boolean): void;
  /** Cancel what runs and waits. */
  cancelAll(): void;
}

export interface NodeServicesOptions {
  jobs: JobsControl;
  /** The systemd unit running the model server, when the operator named one. */
  backendUnit: string | null;
  units?: UnitController;
}

export class NodeServices {
  readonly #jobs: JobsControl;
  readonly #unit: string | null;
  readonly #units: UnitController;

  constructor(opts: NodeServicesOptions) {
    this.#jobs = opts.jobs;
    if (opts.backendUnit !== null && !UNIT_NAME.test(opts.backendUnit))
      throw new TypeError(`not a systemd unit name: ${opts.backendUnit}`);
    this.#unit = opts.backendUnit;
    this.#units = opts.units ?? systemctlController();
  }

  #jobsView(): NodeServiceView {
    return {
      name: 'jobs',
      kind: 'builtin',
      state: this.#jobs.stopped() ? 'stopped' : 'running',
      unit: null,
    };
  }

  async #backendView(): Promise<NodeServiceView> {
    let state: NodeServiceView['state'];
    try {
      state = await this.#units.status(this.#unit!);
    } catch {
      state = 'unknown';
    }
    return { name: 'backend', kind: 'systemd', state, unit: this.#unit };
  }

  async list(): Promise<NodeServiceView[]> {
    return [this.#jobsView(), ...(this.#unit ? [await this.#backendView()] : [])];
  }

  async act(name: string, action: ServiceAction): Promise<NodeServiceView> {
    if (name === 'jobs') {
      if (action === 'stop') this.#jobs.setStopped(true);
      else if (action === 'start') this.#jobs.setStopped(false);
      else if (action === 'restart') {
        this.#jobs.cancelAll();
        this.#jobs.setStopped(false);
      }
      return this.#jobsView();
    }
    if (name === 'backend') {
      if (!this.#unit)
        throw new NovaError('conflict', 'this node does not manage its model server', {
          details: { reason: 'not_managed' },
          action: 'Run nova-compute enroll with --backend-unit to let the Hub manage it',
        });
      if (action !== 'status') await this.#units.act(this.#unit, action);
      return this.#backendView();
    }
    throw new NovaError('not_found', `no managed service named ${name}`);
  }
}
