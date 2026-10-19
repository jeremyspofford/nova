// BIOS settings through a BMC (FR-147 with the FR-146 rules, ADR-096 D6): the same allowlist of
// canonical keys as the device firmware area (BM2), mapped here to Redfish BIOS attribute names per
// BMC vendor. Only mapped keys are read, planned or written; a vendor not in the table is refused
// with the reason, never guessed. Changes go to the Redfish pending settings object and take
// effect at the next reboot. This is the out-of-band area's own table: BMC attribute names are not
// the OS-side names of the device firmware matrix (`packages/shared/src/m75/firmware.ts`).
import { createHash } from 'node:crypto';
import type { OobBiosDiffView, OobBiosKey, OobBiosRefusal, OobBiosSettingView } from '@nova/shared';
import { canonicalJson } from '../nodes/crypto.ts';

export interface OobBiosAttribute {
  attribute: string;
  values: readonly string[];
  /** Values that weaken security (Secure Boot or the TPM off): need the separate override. */
  securityDegrading?: readonly string[];
}

export interface OobBiosVendor {
  /** A short id. */
  vendor: string;
  label: string;
  /** Matched against the service root `Vendor` or the system `Manufacturer`. */
  match: RegExp;
  keys: Partial<Record<OobBiosKey, OobBiosAttribute>>;
  /** Why the vendor or the keys left out are not supported. */
  notes: string;
  supported: boolean;
}

/** The Redfish BIOS support matrix. */
export const OOB_REDFISH_BIOS_MATRIX: readonly OobBiosVendor[] = [
  {
    vendor: 'dell',
    label: 'Dell (iDRAC)',
    match: /^dell\b/i,
    supported: true,
    keys: {
      virtualization: { attribute: 'ProcVirtualization', values: ['Enabled', 'Disabled'] },
      secureBoot: {
        attribute: 'SecureBoot',
        values: ['Enabled', 'Disabled'],
        securityDegrading: ['Disabled'],
      },
      tpm: {
        attribute: 'TpmSecurity',
        values: ['On', 'OnPbm', 'OnNoPbm', 'Off'],
        securityDegrading: ['Off'],
      },
      powerOnAfterPowerLoss: { attribute: 'AcPwrRcvry', values: ['On', 'Off', 'Last'] },
    },
    notes:
      'PowerEdge BIOS attributes. Wake-on-LAN, the fan profile and the boot order are not BIOS attributes on iDRAC; use boot.next for a one-time boot.',
  },
  {
    vendor: 'hpe',
    label: 'HPE (iLO)',
    match: /^(hpe\b|hewlett)/i,
    supported: true,
    keys: {
      virtualization: { attribute: 'ProcVirtualization', values: ['Enabled', 'Disabled'] },
      powerOnAfterPowerLoss: {
        attribute: 'AutoPowerOn',
        values: ['AlwaysPowerOn', 'AlwaysPowerOff', 'RestoreLastState'],
      },
      fanProfile: {
        attribute: 'ThermalConfig',
        values: ['OptimalCooling', 'IncreasedCooling', 'MaxCooling'],
      },
    },
    notes:
      'ProLiant BIOS attributes. Secure Boot is a separate resource on iLO and the TPM is not mapped.',
  },
  {
    vendor: 'lenovo',
    label: 'Lenovo (XClarity Controller)',
    match: /^lenovo\b/i,
    supported: false,
    keys: {},
    notes: 'BIOS attribute names differ by platform generation; not mapped in M7.5.',
  },
  {
    vendor: 'supermicro',
    label: 'Supermicro',
    match: /^supermicro\b/i,
    supported: false,
    keys: {},
    notes: 'BIOS attribute names differ by board and firmware; not mapped in M7.5.',
  },
];

/** The matrix entry for a BMC, or why there is none. */
export function biosVendorFor(
  names: (string | null | undefined)[],
): { entry: OobBiosVendor } | { entry: null; reason: string } {
  for (const n of names) {
    if (!n) continue;
    const entry = OOB_REDFISH_BIOS_MATRIX.find((v) => v.match.test(n.trim()));
    if (entry?.supported) return { entry };
    if (entry) return { entry: null, reason: `${entry.label}: ${entry.notes}` };
  }
  const named = names.find((n) => n?.trim());
  return {
    entry: null,
    reason: named
      ? `${named.trim()} is not in the BIOS support matrix`
      : 'the BMC does not name its vendor',
  };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** The allowlisted settings the BMC has, with what is pending for the next boot. */
export function biosSettings(
  entry: OobBiosVendor,
  attributes: Record<string, unknown>,
  pending: Record<string, unknown>,
): OobBiosSettingView[] {
  const out: OobBiosSettingView[] = [];
  for (const [key, a] of Object.entries(entry.keys) as [OobBiosKey, OobBiosAttribute][]) {
    if (!(a.attribute in attributes)) continue;
    const p = str(pending[a.attribute]);
    out.push({
      key,
      vendorKey: a.attribute,
      value: str(attributes[a.attribute]),
      pending: p,
      allowed: [...a.values],
      securityDegrading: [...(a.securityDegrading ?? [])],
    });
  }
  return out;
}

export interface BiosSnapshot {
  values: Record<string, string | null>;
  sha256: string;
}

/** The current allowlisted values and their hash (canonical JSON), the plan's base. */
export function biosSnapshot(
  entry: OobBiosVendor,
  attributes: Record<string, unknown>,
): BiosSnapshot {
  const values: Record<string, string | null> = {};
  for (const [key, a] of Object.entries(entry.keys) as [OobBiosKey, OobBiosAttribute][])
    if (a.attribute in attributes) values[key] = str(attributes[a.attribute]);
  return {
    values,
    sha256: createHash('sha256').update(canonicalJson(values)).digest('hex'),
  };
}

export interface BiosPlanResult {
  snapshot: BiosSnapshot;
  diff: OobBiosDiffView[];
  refused: { key: OobBiosKey; reason: OobBiosRefusal }[];
}

/**
 * The dry run: each requested change against the allowlist, the BMC's current values and the
 * security override. Nothing is written. `allowSecurityDegrading` is true only when both the
 * setting and the request's explicit override say so.
 */
export function planBios(
  entry: OobBiosVendor,
  attributes: Record<string, unknown>,
  changes: { key: OobBiosKey; value: string }[],
  allowSecurityDegrading: boolean,
): BiosPlanResult {
  const snapshot = biosSnapshot(entry, attributes);
  const diff: OobBiosDiffView[] = [];
  const refused: BiosPlanResult['refused'] = [];
  for (const c of changes) {
    const a = entry.keys[c.key];
    if (!a || !(a.attribute in attributes)) {
      refused.push({ key: c.key, reason: 'unsupported' });
      continue;
    }
    if (!a.values.includes(c.value)) {
      refused.push({ key: c.key, reason: 'not_allowed_value' });
      continue;
    }
    const from = snapshot.values[c.key] ?? null;
    if (from === c.value) {
      refused.push({ key: c.key, reason: 'unchanged' });
      continue;
    }
    const degrading = (a.securityDegrading ?? []).includes(c.value);
    if (degrading && !allowSecurityDegrading) {
      refused.push({ key: c.key, reason: 'security_degrading' });
      continue;
    }
    diff.push({
      key: c.key,
      vendorKey: a.attribute,
      from,
      to: c.value,
      securityDegrading: degrading,
    });
  }
  return { snapshot, diff, refused };
}
