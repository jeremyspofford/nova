// Minimum `novad` version per capability (FR-148, docs/23 §8): a device below it is refused that
// capability, keeps its others and shows "Update required"; agent connections check the same
// table (FR-081). The `devices.minNovadVersions` setting can raise an entry.
import {
  NovaError,
  type DeviceCapabilityName,
  type DeviceCapabilityStatus,
  type DeviceModuleName,
} from '@nova/shared';

/** The module each capability runs in (docs/23 §4). */
export const DEVICE_CAPABILITY_MODULE: Record<DeviceCapabilityName, DeviceModuleName> = {
  files: 'storage',
  staged_writes: 'storage',
  exec: 'storage',
  mcp: 'storage',
  power: 'management',
  services: 'management',
  updates: 'management',
  computer_use: 'screen',
  browser: 'browser',
  capture: 'capture',
};

/** The first `novad` version with each capability. */
export const MIN_NOVAD_VERSIONS: Record<DeviceCapabilityName, string> = {
  files: '0.6.0',
  staged_writes: '0.6.0',
  exec: '0.6.0',
  mcp: '0.6.0',
  power: '0.6.0',
  services: '0.6.0',
  updates: '0.6.0',
  computer_use: '0.7.0',
  browser: '0.7.0',
  capture: '0.8.0',
};

/**
 * Compare dotted versions numerically (`0.10.0` > `0.9.3`); missing parts count as 0 and a
 * pre-release (`-beta.1`) sorts before its release. novad compares the same way.
 */
export function compareNovadVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | null] => {
    const i = v.indexOf('-');
    const core = i < 0 ? v : v.slice(0, i);
    const pre = i < 0 ? null : v.slice(i + 1);
    return [core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa === pb) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa < pb ? -1 : 1;
}

/** The effective table: the built-in minimums, raised (never lowered) by the setting. */
export function minimumNovadVersions(
  overrides: Partial<Record<string, string>> = {},
): Record<DeviceCapabilityName, string> {
  const out = { ...MIN_NOVAD_VERSIONS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!v || !(k in out)) continue;
    const name = k as DeviceCapabilityName;
    if (compareNovadVersions(v, out[name]) > 0) out[name] = v;
  }
  return out;
}

export interface CapabilityInputs {
  novadVersion: string | null;
  /** Modules the device declares installed (its capability document). */
  modules: readonly string[];
  /** The Hub's per-device policy (FR-150); null allows every installed module. */
  allowedModules: readonly string[] | null | undefined;
  minimums: Record<DeviceCapabilityName, string>;
}

/** Each capability with whether the device can serve it, and why not. */
export function deviceCapabilityStatuses(input: CapabilityInputs): DeviceCapabilityStatus[] {
  return (Object.keys(DEVICE_CAPABILITY_MODULE) as DeviceCapabilityName[]).map((name) => {
    const module = DEVICE_CAPABILITY_MODULE[name];
    const minVersion = input.minimums[name];
    let reason: DeviceCapabilityStatus['reason'] = null;
    if (!input.modules.includes(module)) reason = 'module_missing';
    else if (input.allowedModules && !input.allowedModules.includes(module))
      reason = 'module_not_allowed';
    else if (!input.novadVersion || compareNovadVersions(input.novadVersion, minVersion) < 0)
      reason = 'update_required';
    return { name, module, minVersion, available: reason === null, reason };
  });
}

/** Throw `capability_missing` naming the first capability the device cannot serve. */
export function requireDeviceCapabilities(
  statuses: readonly DeviceCapabilityStatus[],
  wanted: readonly DeviceCapabilityName[],
  novadVersion: string | null,
): void {
  for (const name of wanted) {
    const s = statuses.find((x) => x.name === name);
    if (!s || s.available) continue;
    const message =
      s.reason === 'update_required'
        ? `this device needs novad ${s.minVersion} or newer for ${name} (it has ${novadVersion ?? 'an unknown version'})`
        : s.reason === 'module_not_allowed'
          ? `the ${s.module} module is not allowed on this device`
          : `this device has no ${s.module} module for ${name}`;
    throw new NovaError('capability_missing', message, {
      details: {
        reason: s.reason,
        capability: name,
        module: s.module,
        minVersion: s.minVersion,
        novadVersion,
      },
      action: s.reason === 'update_required' ? 'Update novad on the device' : undefined,
    });
  }
}
