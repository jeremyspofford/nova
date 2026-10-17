// The micro-VM substrate (FR-195, docs/11 §2.2), flagged and off by default. M6 ships the
// adapter only: it serves commands through a KVM runner when one is configured and refuses
// otherwise, with a clear "not available on this host". Nova never falls back to the host or to
// another substrate when the VM is unavailable: shell tools report unavailable and file tools
// keep working read-only (docs/11 §10).
import { accessSync, constants } from 'node:fs';
import { NovaError } from '@nova/shared';
import type { ExecResult, SandboxClient } from './types.ts';

/** A runner that boots and drives micro-VMs (a KVM VMM with a guest agent). None ships in M6. */
export type MicroVmRunner = Omit<SandboxClient, 'substrate'>;

export interface MicroVmSandboxOptions {
  /** `computers.microVm.enabled`: the flag. */
  enabled: boolean;
  runner?: MicroVmRunner | null;
  /** The hypervisor device (tests point it elsewhere). */
  kvmPath?: string;
}

export class MicroVmSandbox implements SandboxClient {
  readonly substrate = 'micro_vm' as const;
  readonly #o: MicroVmSandboxOptions;

  constructor(opts: MicroVmSandboxOptions) {
    this.#o = opts;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    const degraded = 'Shell commands are unavailable; files can still be read.';
    if (!this.#o.enabled)
      return {
        ok: false,
        detail: `Micro-VM sandboxes are turned off (an experimental feature, FR-195). ${degraded}`,
      };
    try {
      accessSync(this.#o.kvmPath ?? '/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      return {
        ok: false,
        detail: `Micro-VM sandboxes are not available on this host: there is no usable hypervisor (/dev/kvm). ${degraded}`,
      };
    }
    if (!this.#o.runner)
      return {
        ok: false,
        detail: `Micro-VM sandboxes are not available on this host: no KVM runner is configured. ${degraded}`,
      };
    return this.#o.runner.available();
  }

  async #runner(): Promise<MicroVmRunner> {
    const a = await this.available();
    if (!a.ok || !this.#o.runner) throw new NovaError('sandbox_unavailable', a.detail);
    return this.#o.runner;
  }

  async exec(req: Parameters<SandboxClient['exec']>[0]): Promise<ExecResult> {
    return (await this.#runner()).exec(req);
  }

  async poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    return (await this.#runner()).poll(sessionId, yieldMs, signal);
  }

  async write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    return (await this.#runner()).write(sessionId, input);
  }

  async killTurn(turnId: string): Promise<void> {
    if (this.#o.runner) await this.#o.runner.killTurn(turnId);
  }
}
