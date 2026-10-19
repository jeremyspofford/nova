// M7.5 firmware (FR-146; docs/23 §6; ADR-042, ADR-096 D3-D4): BIOS/firmware settings on novad
// devices. Off by default (`devices.firmware.allowChanges`); every change is planned (a dry run
// with a snapshot), approved by the owner, applied with a Hub-signed authorization and can be
// rolled back. Security-degrading changes need the separate `devices.firmware.allowSecurityDegrading`
// override. No model-facing tool plans, approves or applies them (D3).
import { z } from 'zod';

// ---- the allowlist (BM2) ---------------------------------------------------------------------

/** The canonical setting keys (docs/23 §6.2): the only ones the Hub plans or applies. */
export const FIRMWARE_KEYS = [
  'wol',
  'powerOnAfterPowerLoss',
  'bootOrder',
  'virtualization',
  'secureBoot',
  'tpm',
  'fanProfile',
] as const;
export type FirmwareKey = (typeof FIRMWARE_KEYS)[number];

/** How novad reaches the settings: the Linux firmware-attributes class, efibootmgr or a fake. */
export const FIRMWARE_METHODS = ['firmware-attributes', 'efibootmgr', 'fake'] as const;
export type FirmwareMethod = (typeof FIRMWARE_METHODS)[number];

export function isKnownFirmwareMethod(v: string): v is FirmwareMethod {
  return (FIRMWARE_METHODS as readonly string[]).includes(v);
}

export const FIRMWARE_SETTING_TYPES = ['enum', 'order', 'string', 'int'] as const;
export type FirmwareSettingType = (typeof FIRMWARE_SETTING_TYPES)[number];

/** Why a device's plan left a requested change out. */
export const FIRMWARE_REFUSAL_REASONS = [
  'unknown_key',
  'read_only',
  'not_allowed_value',
  'unsupported',
] as const;
export type FirmwareRefusalReason = (typeof FIRMWARE_REFUSAL_REASONS)[number];

/** A setting's value: an enum or string, an integer, or an order (boot order) as a list. */
export const firmwareValueSchema = z.union([
  z.string().max(500),
  z.number().int().min(-1_000_000_000).max(1_000_000_000),
  z.array(z.string().max(200)).max(64),
]);
export type FirmwareValue = z.infer<typeof firmwareValueSchema>;

/** The two global toggles (D3); both security-relevant, off by default, owner-only. */
export const FIRMWARE_TOGGLE_KEYS = [
  'devices.firmware.allowChanges',
  'devices.firmware.allowSecurityDegrading',
] as const;
export type FirmwareToggleKey = (typeof FIRMWARE_TOGGLE_KEYS)[number];

// ---- the hardware support matrix (D4; mirrors novad's vendor table) --------------------------

export interface FirmwareSupportEntry {
  /** A short id: `dell`, `lenovo`, `hp`, `asus`, `supermicro`, `generic-uefi`. */
  vendor: string;
  label: string;
  /**
   * Lower-case leading words of the DMI system vendor (`/sys/class/dmi/id/sys_vendor`) it covers;
   * a match must end at a word boundary (`hp` is not `hpe`).
   */
  match: readonly string[];
  method: FirmwareMethod | null;
  /**
   * The folder the vendor's Linux driver registers under /sys/class/firmware-attributes (the
   * think-lmi driver's is `thinklmi`), when there is one.
   */
  driver: string | null;
  supported: boolean;
  /** Why not, when unsupported. */
  reason: string | null;
  /** Canonical key -> the vendor's attribute name. */
  keys: Partial<Record<FirmwareKey, string>>;
  notes: string;
}

/**
 * Which machines Nova can change firmware settings on (docs/23 §6, support ladder BM1). Vendors
 * with a Linux firmware-attributes driver get the allowlisted keys they expose; any other UEFI
 * machine gets the boot order only (efibootmgr); ASUS and Supermicro are refused with the reason.
 * Windows and macOS are refused (`os_not_supported`): the vendor tools there are Windows-only
 * and not built (D10). novad's table (services/novad/src/firmware.rs) is authoritative, since it
 * reads the hardware: the vendor, method, driver folder, support and key names here match it,
 * and services/novad/tests/fixtures/firmware-support-matrix.json pins both (a Rust test and
 * packages/shared/test/firmware-matrix.test.ts).
 */
export const FIRMWARE_SUPPORT_MATRIX: readonly FirmwareSupportEntry[] = [
  {
    vendor: 'dell',
    label: 'Dell',
    match: ['dell'],
    method: 'firmware-attributes',
    driver: 'dell-wmi-sysman',
    supported: true,
    reason: null,
    keys: {
      wol: 'WakeOnLan',
      powerOnAfterPowerLoss: 'AcPwrRcvry',
      virtualization: 'Virtualization',
      secureBoot: 'SecureBoot',
      tpm: 'TpmSecurity',
      fanProfile: 'ThermalManagement',
    },
    notes:
      'Business models with the dell-wmi-sysman driver, which does not expose the boot order; an admin BIOS password may be needed.',
  },
  {
    vendor: 'lenovo',
    label: 'Lenovo',
    match: ['lenovo'],
    method: 'firmware-attributes',
    driver: 'thinklmi',
    supported: true,
    reason: null,
    keys: {
      wol: 'WakeOnLAN',
      powerOnAfterPowerLoss: 'AfterPowerLoss',
      bootOrder: 'BootOrder',
      virtualization: 'VirtualizationTechnology',
      secureBoot: 'SecureBoot',
      tpm: 'SecurityChip',
      fanProfile: 'AdaptiveThermalManagementAC',
    },
    notes: 'ThinkPad, ThinkCentre and ThinkStation models with the think-lmi driver (thinklmi).',
  },
  {
    vendor: 'hp',
    label: 'HP',
    match: ['hp', 'hewlett-packard'],
    method: 'firmware-attributes',
    driver: 'hp-bioscfg',
    supported: true,
    reason: null,
    keys: {
      wol: 'Wake On LAN',
      powerOnAfterPowerLoss: 'After Power Loss',
      bootOrder: 'UEFI Boot Order',
      virtualization: 'Virtualization Technology (VTx)',
      secureBoot: 'Secure Boot',
      tpm: 'TPM State',
    },
    notes: 'Business models with the hp-bioscfg driver, which has no fan profile setting.',
  },
  {
    vendor: 'asus',
    label: 'ASUS',
    match: ['asus', 'asustek'],
    method: null,
    driver: null,
    supported: false,
    reason: 'ASUS boards offer no interface to change firmware settings from Linux',
    keys: {},
    notes: 'Change these settings in the firmware setup screen.',
  },
  {
    vendor: 'supermicro',
    label: 'Supermicro',
    match: ['supermicro', 'super micro'],
    method: null,
    driver: null,
    supported: false,
    reason: 'Supermicro boards are managed through their BMC: use out-of-band management',
    keys: {},
    notes: 'Redfish or IPMI through the out-of-band area (FR-147).',
  },
  {
    vendor: 'generic-uefi',
    label: 'Other UEFI machines',
    match: [],
    method: 'efibootmgr',
    driver: null,
    supported: true,
    reason: null,
    keys: { bootOrder: 'BootOrder' },
    notes: 'Boot order only, through efibootmgr.',
  },
];

export interface FirmwarePlatform {
  vendor: string;
  product: string;
  biosVendor: string;
  biosVersion: string;
  biosDate: string;
  uefi: boolean;
}

export interface FirmwareSupport {
  supported: boolean;
  /** `os_not_supported`, `legacy_bios` or the vendor's reason, when unsupported. */
  reason: string | null;
  entry: FirmwareSupportEntry | null;
}

/**
 * The matrix entry for a platform: the vendor's (by DMI vendor prefix), else generic UEFI, else
 * unsupported. `os` is the device's OS family (`linux`, `windows`, `macos`); null when unknown.
 */
export function firmwareSupportFor(
  platform: Pick<FirmwarePlatform, 'vendor' | 'uefi'> | null,
  os: string | null = 'linux',
): FirmwareSupport {
  if (os !== null && os.toLowerCase() !== 'linux')
    return { supported: false, reason: 'os_not_supported', entry: null };
  if (!platform) return { supported: false, reason: 'unknown_platform', entry: null };
  const vendor = platform.vendor.trim().toLowerCase();
  const matches = (m: string) => vendor.startsWith(m) && !/[a-z0-9]/.test(vendor.charAt(m.length));
  const entry = FIRMWARE_SUPPORT_MATRIX.find((e) => e.match.some(matches));
  if (entry && !entry.supported) return { supported: false, reason: entry.reason, entry };
  if (entry) return { supported: true, reason: null, entry };
  if (!platform.uefi) return { supported: false, reason: 'legacy_bios', entry: null };
  const generic = FIRMWARE_SUPPORT_MATRIX.find((e) => e.vendor === 'generic-uefi') ?? null;
  return { supported: true, reason: null, entry: generic };
}

// ---- views -----------------------------------------------------------------------------------

export interface FirmwareSettingView {
  key: string;
  vendorKey: string;
  value: FirmwareValue | null;
  type: FirmwareSettingType;
  allowed: string[] | null;
  readOnly: boolean;
  /** The values of this setting that degrade security (Secure Boot off, TPM off, ...). */
  securityDegrading: string[];
}

export interface FirmwareUpdateView {
  device: string;
  version: string;
  summary: string;
}

export interface FirmwarePolicyView {
  allowChanges: boolean;
  allowSecurityDegrading: boolean;
}

/** `GET /api/v1/devices/:id/firmware`: what the device reports, read through it (60 s cache). */
export interface FirmwareReadView {
  deviceId: string;
  supported: boolean;
  /** Why not, when unsupported (the device's reason or the matrix's). */
  reason: string | null;
  platform: FirmwarePlatform | null;
  /**
   * One of `FIRMWARE_METHODS`, or the name a newer novad sent (shown as "unknown (<name>)"), or
   * `unreadable`; null when the machine has none.
   */
  method: string | null;
  adminPasswordSet: boolean;
  settings: FirmwareSettingView[];
  /** Firmware updates fwupd lists (read only; Nova does not install them). */
  updates: FirmwareUpdateView[];
  /** The matrix entry for this machine. */
  support: FirmwareSupportEntry | null;
  policy: FirmwarePolicyView;
  readAt: string;
  cached: boolean;
}

export interface FirmwareDiffEntry {
  key: string;
  vendorKey: string;
  from: FirmwareValue | null;
  to: FirmwareValue | null;
  securityDegrading: boolean;
}

export interface FirmwareRefusalView {
  key: string;
  reason: FirmwareRefusalReason;
}

export const FIRMWARE_CHANGE_STATUSES = [
  'planned',
  'awaiting_approval',
  'approved',
  'applied',
  'rolled_back',
  'failed',
  'reverted',
  /** The device's watchdog could not restore the snapshot (fully): the change is still there. */
  'revert_failed',
] as const;
export type FirmwareChangeStatus = (typeof FIRMWARE_CHANGE_STATUSES)[number];

export const FIRMWARE_WATCHDOG_STATES = [
  'pending',
  'ok',
  'reverted',
  'revert_failed',
  'missed',
] as const;
export type FirmwareWatchdogState = (typeof FIRMWARE_WATCHDOG_STATES)[number];

export interface FirmwareApprovalState {
  id: string;
  status: 'pending' | 'decided' | 'expired' | 'cancelled';
  decision: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

export interface FirmwareChangeView {
  id: string;
  deviceId: string;
  kind: 'apply' | 'rollback';
  status: FirmwareChangeStatus;
  method: string;
  planId: string | null;
  /** The Hub copy of the snapshot this change was planned on (apply) or restores (rollback). */
  snapshotId: string | null;
  /** A rollback: the change whose snapshot it restores. */
  rollbackOf: string | null;
  diff: FirmwareDiffEntry[];
  refused: FirmwareRefusalView[];
  from: Record<string, FirmwareValue | null>;
  to: Record<string, FirmwareValue | null>;
  securityDegrading: boolean;
  requiresReboot: boolean;
  reboot: boolean | null;
  approval: FirmwareApprovalState | null;
  /**
   * The device's watchdog; `reason` is novad's for a revert: `deadline` (it restarted into the
   * change and was not back in time) or `not_restarted` (it never restarted before the deadline).
   */
  watchdog: {
    state: FirmwareWatchdogState;
    deadline: string | null;
    reason?: string | null;
  } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface FirmwareSnapshotView {
  id: string;
  deviceId: string;
  deviceSnapshotId: string;
  takenAt: string;
  keys: string[];
  sha256: string;
  createdAt: string;
}

/** `GET /api/v1/devices/:id/firmware/history`: changes and snapshots, newest first. */
export interface FirmwareHistoryView {
  changes: FirmwareChangeView[];
  snapshots: FirmwareSnapshotView[];
}

// ---- requests --------------------------------------------------------------------------------

export const firmwareChangeInputSchema = z
  .object({ key: z.enum(FIRMWARE_KEYS), value: firmwareValueSchema })
  .strict();
export type FirmwareChangeInput = z.infer<typeof firmwareChangeInputSchema>;

/** `POST /api/v1/devices/:id/firmware/plan`: a dry run; one change per key. */
export const planFirmwareSchema = z
  .object({
    changes: z
      .array(firmwareChangeInputSchema)
      .min(1)
      .max(FIRMWARE_KEYS.length)
      .refine(
        (cs) => new Set(cs.map((c) => c.key)).size === cs.length,
        'each setting at most once',
      ),
  })
  .strict();
export type PlanFirmwareRequest = z.infer<typeof planFirmwareSchema>;

/** `POST /api/v1/devices/:id/firmware/changes/:changeId/request-approval`. */
export const requestFirmwareApprovalSchema = z
  .object({
    /** The owner's note, shown on the card. */
    note: z.string().trim().max(300).optional(),
  })
  .strict();

/** `POST /api/v1/devices/:id/firmware/changes/:changeId/apply`. */
export const applyFirmwareSchema = z
  .object({
    /** Reboot through novad's power module with the watchdog armed (FR-146 safety 7). */
    reboot: z.boolean().default(false),
  })
  .strict();

/** `POST /api/v1/devices/:id/firmware/snapshots/:snapshotId/rollback`. */
export const rollbackFirmwareSchema = z
  .object({ note: z.string().trim().max(300).optional() })
  .strict();

/**
 * `PUT /api/v1/devices/firmware/policy`: the two toggles. Turning either on needs
 * `confirm: true` (the owner read what it allows); turning off never does.
 */
export const firmwarePolicySchema = z
  .object({
    allowChanges: z.boolean().optional(),
    allowSecurityDegrading: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.allowChanges !== undefined || b.allowSecurityDegrading !== undefined,
    'set allowChanges or allowSecurityDegrading',
  );
export type FirmwarePolicyRequest = z.infer<typeof firmwarePolicySchema>;

export const firmwareReadQuerySchema = z
  .object({ fresh: z.enum(['0', '1', 'true', 'false']).optional() })
  .strict();

export const firmwareHistoryQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
