// IPMI through `ipmitool` (lanplus) (FR-147, ADR-096 D6). The program runs with an argument list
// (never a shell), from the system folders only, with a 10 s budget. The password reaches it only
// through its environment (`-E` reads IPMI_PASSWORD): never argv, logs or the database. IPMI has
// no TLS, so there is nothing to pin; RMCP+ authenticates the session with the credentials.
import {
  NovaError,
  type OobBootTarget,
  type OobPowerState,
  type OobSensorView,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { MeshCommandRunner } from '../network/mesh/runner.ts';
import { bmcError, OOB_TIMEOUT_MS, withoutSecret, type RedfishCredentials } from './redfish.ts';

export const IPMI_DEFAULT_PORT = 623;

export interface IpmiTarget {
  host: string;
  port: number | null;
  credentials: RedfishCredentials;
}

export type IpmiPowerOp = 'on' | 'off' | 'cycle' | 'reset';

/** `chassis bootdev` devices for the one-time targets; USB has no portable IPMI selector. */
const BOOTDEV: Partial<Record<OobBootTarget, string>> = {
  pxe: 'pxe',
  disk: 'disk',
  cdrom: 'cdrom',
  bios: 'bios',
};

/** The first line of a message, redacted: the session's password never shows up in it. */
function firstLine(text: string, password: string): string {
  const line = withoutSecret(text.split('\n').find((l) => l.trim()) ?? '', password);
  return defaultRedactor.redactString(line.trim()).slice(0, 300);
}

/** `Key : value` lines (chassis status, bootparam) into a map; repeated keys keep the first. */
export function ipmiFields(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/^\s*-\s*/, '');
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (key && !(key in out)) out[key] = line.slice(i + 1).trim();
  }
  return out;
}

export function ipmiPowerState(v: string | undefined): OobPowerState {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'on' ? 'on' : s === 'off' ? 'off' : 'unknown';
}

function sensorKind(unit: string): OobSensorView['kind'] {
  const u = unit.toLowerCase();
  if (u.includes('degrees')) return 'temperature';
  if (u === 'rpm') return 'fan';
  if (u.startsWith('volt')) return 'voltage';
  if (u.startsWith('watt')) return 'power';
  return 'other';
}

function sensorHealth(status: string): OobSensorView['health'] {
  const s = status.trim().toLowerCase();
  if (s === 'ok') return 'ok';
  if (s === 'nc') return 'warning';
  if (s === 'cr' || s === 'nr') return 'critical';
  return 'unknown';
}

/** `sdr list` lines: `name | reading unit | status` (at most 200 sensors). */
export function parseSdrList(stdout: string): OobSensorView[] {
  const out: OobSensorView[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const reading = /^(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(parts[1] ?? '');
    const unit = reading?.[2]?.trim() || null;
    out.push({
      name: parts[0].slice(0, 100),
      kind: unit ? sensorKind(unit) : 'other',
      reading: reading ? Number(reading[1]) : null,
      unit,
      health: sensorHealth(parts[2] ?? ''),
    });
    if (out.length >= 200) break;
  }
  return out;
}

export interface IpmiAdapterOptions {
  runner: MeshCommandRunner;
  timeoutMs?: number;
}

export class IpmiAdapter {
  readonly #runner: MeshCommandRunner;
  readonly #timeoutMs: number;

  constructor(o: IpmiAdapterOptions) {
    this.#runner = o.runner;
    this.#timeoutMs = o.timeoutMs ?? OOB_TIMEOUT_MS;
  }

  /** Run `ipmitool -I lanplus … <args>` and return its output; failures are NovaErrors. */
  async run(t: IpmiTarget, args: string[]): Promise<string> {
    const argv = [
      'ipmitool',
      '-I',
      'lanplus',
      '-H',
      t.host,
      '-p',
      String(t.port ?? IPMI_DEFAULT_PORT),
      '-U',
      t.credentials.username,
      // The password from IPMI_PASSWORD, never argv.
      '-E',
      // 3 s per try, one retry: inside the 10 s budget.
      '-N',
      '3',
      '-R',
      '1',
      ...args,
    ];
    const res = await this.#runner.run({
      argv,
      env: { IPMI_PASSWORD: t.credentials.password },
      stdin: null,
      timeoutMs: this.#timeoutMs,
    });
    if (res.error === 'not_found')
      throw new NovaError('capability_missing', 'ipmitool is not installed on the Hub', {
        details: { reason: 'ipmitool_missing' },
      });
    if (res.timedOut) throw bmcError('bmc_timeout', 'the BMC did not answer in time');
    if (res.error)
      throw bmcError(
        'bmc_error',
        `ipmitool failed: ${firstLine(res.error, t.credentials.password)}`,
      );
    if (res.code !== 0) {
      const err = `${res.stderr}\n${res.stdout}`;
      if (/unable to establish|authentication|password|unauthorized/i.test(err))
        throw bmcError(
          'bmc_session_failed',
          'the BMC refused the IPMI session (unreachable, or wrong credentials)',
        );
      throw bmcError(
        'bmc_error',
        `ipmitool failed: ${firstLine(err, t.credentials.password) || `exit ${res.code}`}`,
      );
    }
    return res.stdout;
  }

  async chassisStatus(
    t: IpmiTarget,
  ): Promise<{ powerState: OobPowerState; fields: Record<string, string> }> {
    const fields = ipmiFields(await this.run(t, ['chassis', 'status']));
    return { powerState: ipmiPowerState(fields['System Power']), fields };
  }

  async powerStatus(t: IpmiTarget): Promise<OobPowerState> {
    const out = await this.run(t, ['chassis', 'power', 'status']);
    return ipmiPowerState(/Chassis Power is (\w+)/i.exec(out)?.[1]);
  }

  async power(t: IpmiTarget, op: IpmiPowerOp): Promise<void> {
    await this.run(t, ['chassis', 'power', op]);
  }

  async sensors(t: IpmiTarget): Promise<OobSensorView[]> {
    return parseSdrList(await this.run(t, ['sdr', 'list']));
  }

  /** The boot device selector of the boot flags (parameter 5), or null when not reported. */
  async bootFlags(t: IpmiTarget): Promise<string | null> {
    const fields = ipmiFields(await this.run(t, ['chassis', 'bootparam', 'get', '5']));
    return fields['Boot Device Selector'] ?? null;
  }

  /** A one-time boot device: `chassis bootdev` without `options=persistent` is the next boot only. */
  async bootNext(t: IpmiTarget, target: OobBootTarget, mode?: 'uefi' | 'legacy'): Promise<void> {
    const dev = BOOTDEV[target];
    if (!dev)
      throw new NovaError(
        'capability_missing',
        `IPMI has no portable boot selector for ${target}`,
        {
          details: { reason: 'not_supported_by_ipmi' },
        },
      );
    await this.run(t, ['chassis', 'bootdev', dev, ...(mode === 'uefi' ? ['options=efiboot'] : [])]);
  }
}
