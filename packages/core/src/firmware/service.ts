// BIOS/firmware management on the Hub (FR-146; docs/23 §6.3; ADR-042, ADR-096 D2-D4). The device
// (novad) reads, plans, applies and rolls back; the Hub decides whether it may:
//
// 1. the global toggle `devices.firmware.allowChanges` is off by default; planning, approval and
//    applying are refused while it is off (`firmware_disabled`), and novad refuses too;
// 2. every change needs an approval card (risk high) showing the diff, decided by the owner;
// 3. a plan is a dry run that returns the diff and a snapshot of the current values;
// 4. the Hub keeps its own copy of each snapshot (values sealed with the data key) and can roll
//    back from it when the device lost its own;
// 5. only the allowlisted keys exist; security-degrading changes need the separate override
//    `devices.firmware.allowSecurityDegrading`, at approval and again at apply;
// 6. the support matrix and the device must both say the machine is supported, else every write
//    is refused with the reason (`conflict` `{reason: unsupported_hardware}`);
// 7. with a reboot, novad's watchdog restores the snapshot when the machine does not come back;
//    its heartbeat events close the change, and the Hub marks a change whose device never
//    reported by the deadline (plus a grace) as `missed` and tells the owner;
// 8. every step is audited (kind `device`) with the values before and after.
//
// Nothing here is proactive: there is no model-facing tool (D3); only the owner's requests call
// it, and the Hub area checks that the caller is the owner.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRMWARE_KEYS,
  NovaError,
  firmwareSupportFor,
  firmwareValueSchema,
  uuidv7,
  type FirmwareApprovalState,
  type FirmwareChangeInput,
  type FirmwareChangeStatus,
  type FirmwareChangeView,
  type FirmwareDiffEntry,
  type FirmwareHistoryView,
  type FirmwarePolicyView,
  type FirmwareReadView,
  type FirmwareRefusalView,
  type FirmwareSettingView,
  type FirmwareSnapshotView,
  type FirmwareSupportEntry,
  type FirmwareValue,
  type FirmwareWatchdogState,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { readSealedFile, writeSealedFile } from '../attachments.ts';
import {
  callDevice,
  httpDeviceTransport,
  type DeviceTransport,
  type DeviceTransportResponse,
} from '../devices/client.ts';
import { managementTokenRef } from '../devices/service.ts';
import { deviceTlsError } from '../devices/tls.ts';
import type { EventSink } from '../events.ts';
import { canonicalJson } from '../nodes/crypto.ts';
import { sha256Hex } from '../ops/canonical.ts';
import type { AuditSink, Notifier } from '../tools/types.ts';
import { authorizeDeviceBody, type DeviceAuthzSigner } from './authz.ts';
import {
  FIRMWARE_PATHS,
  firmwareApplyWireSchema,
  firmwarePlanWireSchema,
  firmwareReadWireSchema,
  firmwareRollbackWireSchema,
  firmwareSecurityDegrading,
  firmwareSnapshotSha256,
  isFirmwareKey,
  sameFirmwareValue,
  type FirmwareReadWire,
} from './protocol.ts';

/** The vault entry of a device's BIOS admin password (D4); never stored anywhere else. */
export function biosPasswordRef(deviceId: string): string {
  return `secret://devices/${deviceId}/bios-admin`;
}

/** What the firmware area needs of a device row (the devices area's `DeviceService.device`). */
export interface FirmwareDeviceRef {
  row: {
    id: string;
    accountId: string;
    name: string;
    status: string;
    /** The OS family from the capability document (`linux`, `windows`, `macos`), or null. */
    platform: string | null;
    /** The Ed25519 key pinned at registration (base64url), for the mutual TLS check. */
    publicKey: string;
  };
  endpoint: string | null;
}

export interface FirmwareDevices {
  /** A device of the account (any status), or `not_found`. */
  device(accountId: string, deviceId: string): Promise<FirmwareDeviceRef>;
  /** Called after a device is revoked or decommissioned (`DeviceService.onRevoked`). */
  onRevoked?(hook: (accountId: string, deviceId: string) => void | Promise<void>): () => void;
  /**
   * Bring the device's toggles up to date before a privileged send (`DeviceService.syncPolicy`,
   * D3): a toggle turned on a moment ago reaches the device now, not at its next heartbeat.
   */
  syncPolicy?(
    accountId: string,
    deviceId: string,
    opts?: { force?: boolean },
  ): Promise<{ confirmed: boolean }>;
}

/** novad refused because its copy of the firmware toggle is off (403 `firmware_disabled`). */
function deviceToggleOff(err: unknown): boolean {
  return err instanceof NovaError && err.code === 'firmware_disabled';
}

/**
 * The device still holds the old toggle after a push and a retry: the change stays approved and
 * can be applied again in a moment (the approval is not spent).
 */
function devicePolicyStale(): NovaError {
  return new NovaError(
    'conflict',
    'the device has not taken the "Allow BIOS/firmware changes" switch yet; the change stays approved',
    {
      details: { reason: 'device_policy_stale' },
      retryable: true,
      action: 'Apply again in a few seconds',
    },
  );
}

/** One management call (the devices area's client); its errors are NovaErrors. */
export type FirmwareDeviceCall = (
  device: FirmwareDeviceRef & { endpoint: string },
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

export interface FirmwareSettings {
  allowChanges(): Promise<boolean>;
  allowSecurityDegrading(): Promise<boolean>;
  /** `devices.firmware.watchdogSeconds`: the watchdog of a change applied with a restart. */
  watchdogSeconds?(): Promise<number>;
}

/** novad's accepted watchdog range (D4, R1): 2 minutes to an hour, 10 minutes by default. */
export const FIRMWARE_WATCHDOG_MIN_SECONDS = 120;
export const FIRMWARE_WATCHDOG_MAX_SECONDS = 3600;
export const FIRMWARE_WATCHDOG_DEFAULT_SECONDS = 600;

export interface FirmwareServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  /** Where the sealed snapshot copies live (`<dataDir>/firmware/snapshots/`). */
  dataDir: string;
  devices: FirmwareDevices;
  settings: FirmwareSettings;
  /** The Hub identity (signs D2 authorizations); null while it is not loaded. */
  identity?: () => DeviceAuthzSigner | null;
  log?: Logger;
  audit?: AuditSink;
  notifier?: Notifier;
  now?: () => Date;
  /** Plain HTTP endpoints (tests substitute it). */
  transport?: DeviceTransport;
  /** https endpoints: mutual TLS (ADR-096 D1). Without it an https device is refused. */
  tlsTransport?: DeviceTransport;
  /** Replaces the whole call path (the devices area's own client, when it offers one). */
  call?: FirmwareDeviceCall;
  /** How long a read is reused (default 60 s). */
  cacheMs?: number;
  /** How long an approval stays usable after it was asked for (default 24 h). */
  approvalTtlMs?: number;
  /** How long after the watchdog deadline the Hub waits for the device's report (default 120 s). */
  watchdogGraceMs?: number;
  /** Reads and plans (default 30 s); apply and rollback get four times as long. */
  callTimeoutMs?: number;
}

interface ChangeRow {
  id: string;
  account_id: string;
  device_id: string;
  kind: 'apply' | 'rollback';
  setting: string;
  old_value: string | null;
  new_value: string | null;
  diff_json: string;
  refused_json: string;
  method: string;
  plan_id: string | null;
  snapshot_ref: string | null;
  rollback_of: string | null;
  security_degrading: number;
  requires_reboot: number;
  reboot: number | null;
  status: FirmwareChangeStatus;
  approval_id: string | null;
  change_id: string | null;
  watchdog_state: FirmwareWatchdogState | null;
  watchdog_deadline: string | null;
  watchdog_reason: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

interface SnapshotRow {
  id: string;
  account_id: string;
  device_id: string;
  device_snapshot_id: string;
  taken_at: string;
  keys_json: string;
  sha256: string;
  blob_path: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  status: 'pending' | 'decided' | 'expired' | 'cancelled';
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  args_hash: string | null;
}

interface SealedSnapshot {
  values: Record<string, FirmwareValue | null>;
  sha256: string;
  takenAt: string;
  deviceSnapshotId: string;
}

type SqlValue = string | number | null;
type ValueMap = Record<string, FirmwareValue | null>;

const READ_KEYS = new Set<string>(FIRMWARE_KEYS);
const DONE: readonly FirmwareChangeStatus[] = ['applied', 'rolled_back', 'reverted'];

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function short(v: FirmwareValue | null): string {
  if (v === null) return 'unset';
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** A refusal for a machine Nova cannot change (D4); `reason` says why in plain words. */
export function unsupportedHardware(reason: string | null): NovaError {
  return new NovaError(
    'conflict',
    `firmware settings cannot be changed on this machine: ${reason ?? 'unsupported'}`,
    { details: { reason: 'unsupported_hardware', detail: reason ?? 'unsupported' } },
  );
}

function firmwareDisabled(): NovaError {
  return new NovaError('firmware_disabled', 'BIOS/firmware changes are off', {
    details: { reason: 'firmware_disabled', setting: 'devices.firmware.allowChanges' },
    action: 'Turn on "Allow BIOS/firmware changes" first',
  });
}

function securityDegrading(keys: string[]): NovaError {
  return new NovaError(
    'policy_denied',
    'this change weakens security (Secure Boot, TPM) and the separate override is off',
    {
      details: {
        reason: 'security_degrading',
        keys,
        setting: 'devices.firmware.allowSecurityDegrading',
      },
    },
  );
}

/**
 * A transport that turns novad's `unsupported_hardware` answer (D4: 409 with `{reason}`), which
 * is not one of the Hub's error codes, into `conflict` `{reason: unsupported_hardware, detail}`
 * instead of letting the client report a `server_error`.
 */
function normalizing(inner: DeviceTransport): DeviceTransport {
  return {
    async post(url, token, body, timeoutMs, target) {
      const res: DeviceTransportResponse = await inner.post(url, token, body, timeoutMs, target);
      const err = isRecord(res.body) && isRecord(res.body.error) ? res.body.error : null;
      if (err?.code !== 'unsupported_hardware') return res;
      const details = isRecord(err.details) ? err.details : {};
      const detail = typeof details.reason === 'string' ? details.reason.slice(0, 300) : null;
      return {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message:
              typeof err.message === 'string' ? err.message.slice(0, 500) : 'unsupported hardware',
            details: { reason: 'unsupported_hardware', detail },
          },
        },
      };
    },
  };
}

export class FirmwareService {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #devices: FirmwareDevices;
  readonly #settings: FirmwareSettings;
  #identity: () => DeviceAuthzSigner | null;
  readonly #log: Logger;
  #audit: AuditSink | null;
  #notifier: Notifier | null;
  readonly #now: () => Date;
  readonly #transport: DeviceTransport;
  #tlsTransport: DeviceTransport | null;
  #callFn: FirmwareDeviceCall | null;
  readonly #cacheMs: number;
  readonly #approvalTtlMs: number;
  readonly #graceMs: number;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, { at: number; wire: FirmwareReadWire; readAt: string }>();
  readonly #offRevoked: (() => void) | null;
  /** One firmware operation per device at a time. */
  readonly #busy = new Set<string>();

  constructor(opts: FirmwareServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#devices = opts.devices;
    this.#settings = opts.settings;
    this.#identity = opts.identity ?? (() => null);
    this.#log = opts.log ?? new Logger({ module: 'core.firmware', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#transport = normalizing(opts.transport ?? httpDeviceTransport);
    this.#tlsTransport = opts.tlsTransport ? normalizing(opts.tlsTransport) : null;
    this.#callFn = opts.call ?? null;
    this.#cacheMs = opts.cacheMs ?? 60_000;
    this.#approvalTtlMs = opts.approvalTtlMs ?? 24 * 60 * 60 * 1000;
    this.#graceMs = opts.watchdogGraceMs ?? 120_000;
    this.#timeoutMs = opts.callTimeoutMs ?? 30_000;
    // A revoked or decommissioned device's BIOS admin password leaves the vault with it.
    this.#offRevoked =
      opts.devices.onRevoked?.((accountId, deviceId) => this.forgetDevice(accountId, deviceId)) ??
      null;
  }

  /** Stop following revocations (the Hub area's close). */
  close(): void {
    this.#offRevoked?.();
  }

  /** A device was revoked or decommissioned: its BIOS admin password and cached read go. */
  async forgetDevice(accountId: string, deviceId: string): Promise<void> {
    this.#cache.delete(deviceId);
    const ref = biosPasswordRef(deviceId);
    if (!(await this.#secrets.has(ref))) return;
    await this.#secrets.delete(ref);
    await this.#auditAppend(
      accountId,
      'device.firmware.password.clear',
      deviceId,
      { ref, reason: 'device_revoked' },
      { kind: 'secret', actor: 'system' },
    );
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  useNotifier(notifier: Notifier): void {
    this.#notifier = notifier;
  }

  /** The Hub identity that signs D2 authorizations. */
  useIdentity(identity: () => DeviceAuthzSigner | null): void {
    this.#identity = identity;
  }

  /** The mutual TLS transport for https devices (ADR-096 D1). */
  useTlsTransport(transport: DeviceTransport | null): void {
    this.#tlsTransport = transport ? normalizing(transport) : null;
  }

  /** Route every management call through the devices area's own client. */
  useDeviceCall(call: FirmwareDeviceCall | null): void {
    this.#callFn = call;
  }

  // ---- small helpers -------------------------------------------------------------------------

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.raw.prepare(sql).all(...params) as unknown as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.raw.prepare(sql).get(...params) as unknown as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): number {
    return Number(this.#db.raw.prepare(sql).run(...params).changes);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  async #auditAppend(
    accountId: string,
    action: string,
    deviceId: string,
    detail: Record<string, unknown>,
    extra: { actor?: string; result?: string; kind?: 'device' | 'secret' } = {},
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: extra.actor ?? 'user',
        kind: extra.kind ?? 'device',
        action,
        resource: deviceId,
        threadId: null,
        detail,
        ...(extra.result ? { result: extra.result } : {}),
      });
    } catch (err) {
      this.#log.warn('firmware audit failed', { err, action });
    }
  }

  async #changed(row: ChangeRow, actor = 'user'): Promise<void> {
    try {
      await this.#events.emit({
        name: 'device.firmware.changed',
        accountId: row.account_id,
        actor,
        payload: {
          deviceId: row.device_id,
          changeId: row.id,
          kind: row.kind,
          status: row.status,
          watchdog: row.watchdog_state,
          approvalId: row.approval_id,
        },
      });
    } catch (err) {
      this.#log.warn('firmware event failed', { err });
    }
  }

  async #notify(
    accountId: string,
    kind: 'approval' | 'completion' | 'error' | 'attention' | 'system',
    title: string,
    body: string,
    href: string,
    dedupeKey: string,
  ): Promise<void> {
    if (!this.#notifier) return;
    await this.#notifier
      .notify({ accountId, kind, title, body: body.slice(0, 200), href, dedupeKey })
      .catch((err: unknown) => this.#log.warn('firmware notification failed', { err }));
  }

  /** The setting, kept inside novad's accepted range whatever is stored. */
  async #watchdogSeconds(): Promise<number> {
    const v = (await this.#settings.watchdogSeconds?.()) ?? FIRMWARE_WATCHDOG_DEFAULT_SECONDS;
    if (!Number.isFinite(v)) return FIRMWARE_WATCHDOG_DEFAULT_SECONDS;
    return Math.min(
      FIRMWARE_WATCHDOG_MAX_SECONDS,
      Math.max(FIRMWARE_WATCHDOG_MIN_SECONDS, Math.round(v)),
    );
  }

  async #requireAllowed(): Promise<void> {
    if (!(await this.#settings.allowChanges())) throw firmwareDisabled();
  }

  /** The two toggles (D3). */
  async policy(): Promise<FirmwarePolicyView> {
    return {
      allowChanges: await this.#settings.allowChanges(),
      allowSecurityDegrading: await this.#settings.allowSecurityDegrading(),
    };
  }

  /**
   * `policy.firmwareChanges` of the heartbeat answer (D3): the global toggle. The devices area
   * calls it for every heartbeat (`DeviceService.useFirmwarePolicy`); false when it fails.
   */
  async firmwareChangesAllowed(): Promise<boolean> {
    try {
      return await this.#settings.allowChanges();
    } catch {
      return false;
    }
  }

  async #device(accountId: string, deviceId: string): Promise<FirmwareDeviceRef> {
    const d = await this.#devices.device(accountId, deviceId);
    if (d.row.status === 'revoked' || d.row.accountId !== accountId)
      throw new NovaError('not_found', 'device not found');
    return d;
  }

  async #usable(
    accountId: string,
    deviceId: string,
  ): Promise<FirmwareDeviceRef & { endpoint: string }> {
    const d = await this.#device(accountId, deviceId);
    if (d.row.status !== 'active' || !d.endpoint) {
      throw new NovaError('node_unavailable', 'the device is not reachable', {
        details: { reason: 'unreachable', status: d.row.status },
      });
    }
    return { ...d, endpoint: d.endpoint };
  }

  async #call(
    d: FirmwareDeviceRef & { endpoint: string },
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.#callFn) return this.#callFn(d, path, body, timeoutMs);
    const https = d.endpoint.startsWith('https:');
    // An https device is never called over plain HTTP, and never without the client certificate.
    if (https && !this.#tlsTransport) throw deviceTlsError('no_client_certificate');
    const token = await this.#secrets.get(managementTokenRef(d.row.id));
    if (!token)
      throw new NovaError('auth_missing', 'the Hub has no management token for this device');
    return callDevice(
      https ? this.#tlsTransport! : this.#transport,
      d.endpoint,
      token,
      path,
      body,
      timeoutMs,
      { deviceId: d.row.id, publicKey: d.row.publicKey },
    );
  }

  #lock(deviceId: string): () => void {
    if (this.#busy.has(deviceId))
      throw new NovaError('conflict', 'another firmware operation is running on this device', {
        details: { reason: 'firmware_busy' },
        retryable: true,
      });
    this.#busy.add(deviceId);
    return () => this.#busy.delete(deviceId);
  }

  // ---- read ----------------------------------------------------------------------------------

  #supportOf(
    d: FirmwareDeviceRef,
    wire: FirmwareReadWire,
  ): { supported: boolean; reason: string | null; entry: FirmwareSupportEntry | null } {
    const matrix = firmwareSupportFor(wire.platform ?? null, d.row.platform);
    // Both must agree: the device knows its drivers, the matrix knows what Nova supports.
    if (!wire.supported)
      return { supported: false, reason: wire.reason ?? matrix.reason, entry: matrix.entry };
    if (!matrix.supported) return { supported: false, reason: matrix.reason, entry: matrix.entry };
    return { supported: true, reason: null, entry: matrix.entry };
  }

  async #view(
    d: FirmwareDeviceRef,
    wire: FirmwareReadWire,
    readAt: string,
    cached: boolean,
  ): Promise<FirmwareReadView> {
    const support = this.#supportOf(d, wire);
    const settings: FirmwareSettingView[] = wire.settings
      .filter((s) => READ_KEYS.has(s.key))
      .map((s) => ({ ...s }));
    return {
      deviceId: d.row.id,
      supported: support.supported,
      reason: support.reason,
      platform: wire.platform ?? null,
      method: wire.method ?? null,
      adminPasswordSet: wire.adminPasswordSet,
      settings,
      updates: wire.updates,
      support: support.entry,
      policy: await this.policy(),
      readAt,
      cached,
    };
  }

  async #readWire(
    accountId: string,
    d: FirmwareDeviceRef & { endpoint: string },
  ): Promise<{ wire: FirmwareReadWire; readAt: string }> {
    const raw = await this.#call(d, FIRMWARE_PATHS.read, {}, this.#timeoutMs);
    const wire = firmwareReadWireSchema.parse(raw);
    const readAt = this.#iso();
    this.#cache.set(d.row.id, { at: this.#now().getTime(), wire, readAt });
    await this.#auditAppend(accountId, 'device.firmware.read', d.row.id, {
      supported: wire.supported,
      method: wire.method ?? null,
      vendor: wire.platform?.vendor ?? null,
      settings: wire.settings.length,
    });
    return { wire, readAt };
  }

  /**
   * `GET /api/v1/devices/:id/firmware`: the settings the device reports, read through it and
   * reused for 60 s (`fresh` reads again). Reading changes nothing, so the toggle does not apply;
   * novad still needs the `firmware` module allowed for the device.
   */
  async read(
    accountId: string,
    deviceId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<FirmwareReadView> {
    const d = await this.#device(accountId, deviceId);
    const hit = this.#cache.get(deviceId);
    if (!opts.fresh && hit && this.#now().getTime() - hit.at < this.#cacheMs)
      return this.#view(d, hit.wire, hit.readAt, true);
    const usable = await this.#usable(accountId, deviceId);
    const { wire, readAt } = await this.#readWire(accountId, usable);
    return this.#view(d, wire, readAt, false);
  }

  /** The facts of the last read (no device call), for the device's capability view; or null. */
  facts(
    deviceId: string,
  ): { supported: boolean; method: string | null; vendor: string | null; readAt: string } | null {
    const hit = this.#cache.get(deviceId);
    if (!hit) return null;
    return {
      supported: hit.wire.supported,
      method: hit.wire.method ?? null,
      vendor: hit.wire.platform?.vendor ?? null,
      readAt: hit.readAt,
    };
  }

  async #supportedRead(
    accountId: string,
    d: FirmwareDeviceRef & { endpoint: string },
  ): Promise<FirmwareReadWire> {
    const { wire } = await this.#readWire(accountId, d);
    const support = this.#supportOf(d, wire);
    if (!support.supported) throw unsupportedHardware(support.reason);
    return wire;
  }

  // ---- plan ----------------------------------------------------------------------------------

  /**
   * `POST …/firmware/plan`: a dry run on the device. It returns the diff and a snapshot of the
   * current values; the Hub keeps the snapshot (sealed) and records the change as `planned`.
   */
  async plan(
    accountId: string,
    deviceId: string,
    changes: FirmwareChangeInput[],
  ): Promise<FirmwareChangeView> {
    await this.#requireAllowed();
    const d = await this.#usable(accountId, deviceId);
    const unlock = this.#lock(deviceId);
    try {
      const facts = await this.#supportedRead(accountId, d);
      const raw = await this.#call(d, FIRMWARE_PATHS.plan, { changes }, this.#timeoutMs);
      const plan = firmwarePlanWireSchema.parse(raw);
      if (Object.keys(plan.snapshot.values).length > 64)
        throw new NovaError('server_error', 'the device answered an oversized snapshot');
      if (firmwareSnapshotSha256(plan.snapshot.values) !== plan.snapshot.sha256) {
        throw new NovaError('server_error', 'the device snapshot does not match its hash', {
          details: { reason: 'snapshot_mismatch' },
        });
      }
      const asked = new Map(changes.map((c) => [c.key as string, c.value]));
      const settingOf = new Map(facts.settings.map((s) => [s.key, s]));
      const diff: FirmwareDiffEntry[] = [];
      for (const e of plan.diff) {
        // The device may only plan what was asked, with the value asked (fail closed).
        const want = asked.get(e.key);
        if (!isFirmwareKey(e.key) || want === undefined || !sameFirmwareValue(want, e.to)) {
          throw new NovaError('server_error', 'the device planned a change nobody asked for', {
            details: { reason: 'unexpected_diff', key: e.key.slice(0, 100) },
          });
        }
        diff.push({
          key: e.key,
          vendorKey: e.vendorKey || settingOf.get(e.key)?.vendorKey || e.key,
          from: e.from,
          to: e.to,
          securityDegrading:
            e.securityDegrading ||
            firmwareSecurityDegrading(e.key, e.to, settingOf.get(e.key)?.securityDegrading),
        });
      }
      const refused: FirmwareRefusalView[] = plan.refused
        .filter((r) => asked.has(r.key))
        .map((r) => ({ key: r.key, reason: r.reason }));
      const row = await this.#record(accountId, d, {
        kind: 'apply',
        diff,
        refused,
        method: facts.method ?? 'unknown',
        planId: plan.planId,
        snapshot: {
          values: plan.snapshot.values,
          sha256: plan.snapshot.sha256,
          takenAt: plan.snapshot.takenAt,
          deviceSnapshotId: plan.snapshot.id,
        },
        rollbackOf: null,
        snapshotRef: null,
        requiresReboot: plan.requiresReboot,
      });
      await this.#auditAppend(accountId, 'device.firmware.plan', deviceId, {
        changeId: row.id,
        before: fromMap(diff),
        after: toMap(diff),
        refused,
        securityDegrading: row.security_degrading === 1,
        snapshotSha256: plan.snapshot.sha256,
      });
      await this.#changed(row);
      return this.#changeView(row);
    } finally {
      unlock();
    }
  }

  /** Store a change (and the snapshot copy of a plan) in one transaction. */
  async #record(
    accountId: string,
    d: FirmwareDeviceRef,
    input: {
      kind: 'apply' | 'rollback';
      diff: FirmwareDiffEntry[];
      refused: FirmwareRefusalView[];
      method: string;
      planId: string | null;
      snapshot: SealedSnapshot | null;
      snapshotRef: string | null;
      rollbackOf: string | null;
      requiresReboot: boolean;
    },
  ): Promise<ChangeRow> {
    const id = uuidv7();
    const now = this.#iso();
    let snapshotRef = input.snapshotRef;
    let blob: string | null = null;
    if (input.snapshot) {
      snapshotRef = uuidv7();
      blob = join('firmware', 'snapshots', `${snapshotRef}.json`);
      writeSealedFile(
        this.#dataDir,
        join(this.#dataDir, blob),
        `firmware-snapshot:${snapshotRef}`,
        Buffer.from(JSON.stringify(input.snapshot), 'utf8'),
      );
    }
    try {
      await this.#db.transaction(() => {
        if (input.snapshot && snapshotRef && blob) {
          this.#run(
            `INSERT INTO firmware_snapshot (id, account_id, device_id, device_snapshot_id, taken_at,
               keys_json, sha256, blob_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            snapshotRef,
            accountId,
            d.row.id,
            input.snapshot.deviceSnapshotId,
            input.snapshot.takenAt || now,
            JSON.stringify(Object.keys(input.snapshot.values).sort()),
            input.snapshot.sha256,
            blob,
            now,
          );
        }
        this.#run(
          `INSERT INTO firmware_change (id, account_id, device_id, kind, setting, old_value, new_value,
             diff_json, refused_json, method, plan_id, snapshot_ref, rollback_of, security_degrading,
             requires_reboot, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
          id,
          accountId,
          d.row.id,
          input.kind,
          input.diff.map((e) => e.key).join(',') || '-',
          JSON.stringify(fromMap(input.diff)),
          JSON.stringify(toMap(input.diff)),
          JSON.stringify(input.diff),
          JSON.stringify(input.refused),
          input.method,
          input.planId,
          snapshotRef,
          input.rollbackOf,
          input.diff.some((e) => e.securityDegrading) ? 1 : 0,
          input.requiresReboot ? 1 : 0,
          now,
          now,
        );
      });
    } catch (err) {
      if (blob) rmSync(join(this.#dataDir, blob), { force: true });
      throw err;
    }
    return this.#row(id)!;
  }

  // ---- approval ------------------------------------------------------------------------------

  #row(id: string): ChangeRow | undefined {
    return this.#get<ChangeRow>('SELECT * FROM firmware_change WHERE id = ?', id);
  }

  #changeRow(accountId: string, deviceId: string, changeId: string): ChangeRow {
    const row = this.#get<ChangeRow>(
      'SELECT * FROM firmware_change WHERE id = ? AND account_id = ? AND device_id = ?',
      changeId,
      accountId,
      deviceId,
    );
    if (!row) throw new NovaError('not_found', 'firmware change not found');
    return row;
  }

  #approval(accountId: string, approvalId: string | null): ApprovalRow | undefined {
    if (!approvalId) return undefined;
    return this.#get<ApprovalRow>(
      `SELECT id, status, decision, decided_by, decided_at, expires_at, args_hash FROM approval
       WHERE id = ? AND account_id = ?`,
      approvalId,
      accountId,
    );
  }

  #snapshotRow(id: string | null): SnapshotRow | undefined {
    if (!id) return undefined;
    return this.#get<SnapshotRow>('SELECT * FROM firmware_snapshot WHERE id = ?', id);
  }

  /** What an approval binds: the change, its diff and its snapshot; any edit voids it. */
  #approvalHash(row: ChangeRow): string {
    return sha256Hex(
      canonicalJson({
        v: 1,
        changeId: row.id,
        deviceId: row.device_id,
        kind: row.kind,
        planId: row.plan_id,
        diff: parseJson<unknown[]>(row.diff_json, []),
        snapshot: this.#snapshotRow(row.snapshot_ref)?.sha256 ?? null,
        rollbackOf: row.rollback_of,
      }),
    );
  }

  #approvalOpen(a: ApprovalRow | undefined): boolean {
    if (!a || a.status !== 'pending') return false;
    return !a.expires_at || a.expires_at > this.#iso();
  }

  /**
   * `POST …/firmware/changes/:changeId/request-approval`: an approval card (risk high) with the
   * diff, for the owner to decide. Refused while the toggle is off, and for a security-degrading
   * change while its override is off.
   */
  async requestApproval(
    accountId: string,
    deviceId: string,
    changeId: string,
    note?: string,
  ): Promise<FirmwareChangeView> {
    await this.#requireAllowed();
    const row = this.#changeRow(accountId, deviceId, changeId);
    if (DONE.includes(row.status))
      throw new NovaError('conflict', 'this change was already applied', {
        details: { reason: 'already_applied', status: row.status },
      });
    if (row.status === 'failed')
      throw new NovaError('conflict', 'this change failed; plan it again', {
        details: { reason: 'failed' },
      });
    const current = this.#approval(accountId, row.approval_id);
    // A usable "Allow once" stands; a denied, expired or hook-answered one gets a new card.
    if (
      row.status === 'approved' &&
      current?.decision === 'allow_once' &&
      current.decided_by === 'user' &&
      (!current.expires_at || current.expires_at > this.#iso())
    )
      return this.#changeView(row);
    if (row.status === 'awaiting_approval' && this.#approvalOpen(current))
      return this.#changeView(row);
    const diff = parseJson<FirmwareDiffEntry[]>(row.diff_json, []);
    if (diff.length === 0)
      throw new NovaError('conflict', 'this plan changes nothing', {
        details: { reason: 'nothing_to_apply' },
      });
    if (row.security_degrading === 1 && !(await this.#settings.allowSecurityDegrading()))
      throw securityDegrading(diff.filter((e) => e.securityDegrading).map((e) => e.key));
    const d = await this.#device(accountId, deviceId);
    return this.#openApproval(accountId, d, row, diff, note);
  }

  async #openApproval(
    accountId: string,
    d: FirmwareDeviceRef,
    row: ChangeRow,
    diff: FirmwareDiffEntry[],
    note?: string,
  ): Promise<FirmwareChangeView> {
    const approvalId = uuidv7();
    const now = this.#now();
    const nowIso = now.toISOString();
    const verb = row.kind === 'rollback' ? 'Restore' : 'Change';
    const list = diff
      .map(
        (e) =>
          `${e.key} ${short(e.from)} -> ${short(e.to)}${e.securityDegrading ? ' (weakens security)' : ''}`,
      )
      .join('; ');
    const action =
      `${verb} BIOS/firmware settings on ${d.row.name}: ${list}`.slice(0, 500) +
      (row.requires_reboot ? ' (takes effect after a reboot)' : '');
    const preview = JSON.stringify({
      device: d.row.name,
      deviceId: d.row.id,
      change: row.id,
      kind: row.kind,
      diff,
      refused: parseJson<unknown[]>(row.refused_json, []),
      securityDegrading: row.security_degrading === 1,
      requiresReboot: row.requires_reboot === 1,
    });
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(schema.approval).values({
        id: approvalId,
        accountId,
        toolCallId: null,
        threadId: null,
        turnId: null,
        runId: null,
        agentId: null,
        toolName: row.kind === 'rollback' ? 'device.firmware.rollback' : 'device.firmware.apply',
        requestedAction: action,
        argsPreview: preview,
        argsHash: this.#approvalHash(row),
        reason: note ? `Requested by the owner: ${note.slice(0, 300)}` : 'Requested by the owner',
        scope: `device:${d.row.id}`,
        risk: 'high',
        tier: 'confirm_at_action',
        userAsked: true,
        optionsJson: JSON.stringify(['allow_once', 'deny_continue']),
        alwaysScopesJson: '[]',
        // "Explicit approval on the Hub" (docs/23 §6.3): never answered from a channel.
        answerIn: 'hub',
        status: 'pending',
        createdAt: nowIso,
        expiresAt: new Date(now.getTime() + this.#approvalTtlMs).toISOString(),
      });
      this.#run(
        `UPDATE firmware_change SET status = 'awaiting_approval', approval_id = ?, error = NULL,
           updated_at = ? WHERE id = ?`,
        approvalId,
        nowIso,
        row.id,
      );
    });
    await this.#events.emit({
      name: 'approval.requested',
      accountId,
      actor: 'user',
      payload: {
        approvalId,
        callId: null,
        action,
        reason: note ?? '',
        scope: `device:${d.row.id}`,
        risk: 'high',
        tier: 'confirm_at_action',
      },
    });
    await this.#notify(
      accountId,
      'approval',
      row.kind === 'rollback' ? 'Firmware rollback to approve' : 'Firmware change to approve',
      action,
      `/approvals/${approvalId}`,
      `approval:${approvalId}`,
    );
    const updated = this.#row(row.id)!;
    await this.#auditAppend(accountId, 'device.firmware.approval', d.row.id, {
      changeId: row.id,
      kind: row.kind,
      approvalId,
      before: parseJson<ValueMap>(row.old_value, {}),
      after: parseJson<ValueMap>(row.new_value, {}),
      securityDegrading: row.security_degrading === 1,
    });
    await this.#changed(updated);
    return this.#changeView(updated);
  }

  /**
   * An approval card was answered: the change becomes `approved` (the signed-in user's "Allow
   * once", read from the card itself), or `planned` again.
   */
  async onApprovalDecided(accountId: string, approvalId: string, decision: string): Promise<void> {
    const row = this.#get<ChangeRow>(
      `SELECT * FROM firmware_change WHERE approval_id = ? AND account_id = ?
         AND status = 'awaiting_approval'`,
      approvalId,
      accountId,
    );
    if (!row) return;
    const card = this.#approval(accountId, approvalId);
    const byUser = card?.decided_by === 'user' && card.decision === 'allow_once';
    const status: FirmwareChangeStatus =
      decision === 'allow_once' && byUser ? 'approved' : 'planned';
    this.#run(
      'UPDATE firmware_change SET status = ?, updated_at = ? WHERE id = ?',
      status,
      this.#iso(),
      row.id,
    );
    await this.#changed(this.#row(row.id)!);
  }

  /** The approval this change runs under, or why it may not run (D2 (c)). */
  #checkApproval(accountId: string, row: ChangeRow): string {
    if (!row.approval_id)
      throw new NovaError('approval_required', 'this change needs the owner’s approval first', {
        details: { reason: 'approval_required', approvalId: null },
      });
    const a = this.#approval(accountId, row.approval_id);
    if (!a)
      throw new NovaError('approval_required', 'the approval for this change is gone', {
        details: { reason: 'approval_required', approvalId: null },
      });
    if (a.status === 'pending' && this.#approvalOpen(a))
      throw new NovaError('approval_required', 'the approval for this change is still pending', {
        details: { reason: 'approval_required', approvalId: a.id },
      });
    if (a.status === 'expired' || a.status === 'cancelled' || a.status === 'pending')
      throw new NovaError('conflict', 'the approval for this change expired; ask again', {
        details: { reason: 'approval_expired', approvalId: a.id },
      });
    // Only the owner's own "Allow once" counts: no hook, rule or channel answer authorizes it.
    if (a.decision !== 'allow_once' || a.decided_by !== 'user')
      throw new NovaError('policy_denied', 'the approval for this change was denied', {
        details: { reason: 'approval_denied', approvalId: a.id },
      });
    if (a.expires_at && a.expires_at < this.#iso())
      throw new NovaError('conflict', 'the approval for this change expired; ask again', {
        details: { reason: 'approval_expired', approvalId: a.id },
      });
    if (a.args_hash !== this.#approvalHash(row))
      throw new NovaError('policy_denied', 'the change is not the one that was approved', {
        details: { reason: 'approval_mismatch', approvalId: a.id },
      });
    return a.id;
  }

  // ---- apply ---------------------------------------------------------------------------------

  #snapshotCopy(snap: SnapshotRow): SealedSnapshot {
    let copy: SealedSnapshot;
    try {
      copy = JSON.parse(
        readSealedFile(
          this.#dataDir,
          join(this.#dataDir, snap.blob_path),
          `firmware-snapshot:${snap.id}`,
        ).toString('utf8'),
      ) as SealedSnapshot;
    } catch (err) {
      throw new NovaError('server_error', 'the Hub copy of this snapshot cannot be read', {
        details: { reason: 'snapshot_unreadable' },
        cause: err,
      });
    }
    if (
      !isRecord(copy.values) ||
      firmwareSnapshotSha256(copy.values) !== snap.sha256 ||
      copy.sha256 !== snap.sha256
    )
      throw new NovaError('server_error', 'the Hub copy of this snapshot failed its check', {
        details: { reason: 'snapshot_corrupt' },
      });
    return copy;
  }

  /**
   * `POST …/firmware/changes/:changeId/apply`: run an approved change (a plan, or a rollback) on
   * the device with a Hub-signed authorization. `reboot` reboots through novad's power module
   * with the watchdog armed (apply only).
   */
  async apply(
    accountId: string,
    deviceId: string,
    changeId: string,
    opts: { reboot?: boolean } = {},
  ): Promise<FirmwareChangeView> {
    await this.#requireAllowed();
    const row = this.#changeRow(accountId, deviceId, changeId);
    if (DONE.includes(row.status))
      throw new NovaError('conflict', 'this change was already applied', {
        details: { reason: 'already_applied', status: row.status },
      });
    if (row.status === 'failed')
      throw new NovaError('conflict', 'this change failed; plan it again', {
        details: { reason: 'failed' },
      });
    if (row.kind === 'rollback' && opts.reboot === true)
      throw new NovaError('validation', 'a rollback does not reboot; reboot the device yourself', {
        details: { reason: 'reboot_not_offered' },
      });
    const approvalId = this.#checkApproval(accountId, row);
    const diff = parseJson<FirmwareDiffEntry[]>(row.diff_json, []);
    if (row.security_degrading === 1 && !(await this.#settings.allowSecurityDegrading()))
      throw securityDegrading(diff.filter((e) => e.securityDegrading).map((e) => e.key));
    const d = await this.#usable(accountId, deviceId);
    const unlock = this.#lock(deviceId);
    try {
      const facts = await this.#supportedRead(accountId, d);
      const snap = this.#snapshotRow(row.snapshot_ref);
      if (!snap)
        throw new NovaError('conflict', 'this change has no snapshot', {
          details: { reason: 'snapshot_missing' },
        });
      const reboot = row.kind === 'apply' && opts.reboot === true;
      let password: string | null = null;
      if (facts.adminPasswordSet) {
        // novad never keeps the password, so its watchdog cannot restore this machine: a guarded
        // reboot would promise a safety net that is not there. Apply, then restart by hand.
        if (reboot)
          throw new NovaError(
            'policy_denied',
            'the watchdog cannot restore a machine with a BIOS admin password, so no reboot',
            {
              details: { reason: 'watchdog_unavailable', detail: 'admin_password_set' },
              action:
                'Apply without a reboot, restart the machine yourself, roll back from Nova if needed',
            },
          );
        // A long-lived firmware credential: read and sent only over mutual TLS (ADR-096 D1).
        if (!d.endpoint.startsWith('https:'))
          throw new NovaError(
            'policy_denied',
            'the BIOS admin password is only sent to a device over mutual TLS',
            {
              details: { reason: 'tls_required' },
              action: 'Use the Hub local CA and add the device again so it holds a certificate',
            },
          );
        password = await this.#secrets.get(biosPasswordRef(deviceId));
        if (!password)
          throw new NovaError('conflict', 'this machine needs its BIOS admin password', {
            details: { reason: 'bios_password_required' },
            action: 'Store the BIOS admin password for this device first',
          });
      }
      // The owner's watchdog length goes with a guarded restart (novad's own default otherwise).
      const watchdogSeconds = reboot ? await this.#watchdogSeconds() : null;
      const body: Record<string, unknown> =
        row.kind === 'apply'
          ? {
              planId: row.plan_id,
              snapshotId: snap.device_snapshot_id,
              changes: diff.map((e) => ({ key: e.key, value: e.to })),
              reboot,
              ...(watchdogSeconds !== null ? { watchdogSeconds } : {}),
              ...(row.security_degrading === 1 ? { allowSecurityDegrading: true } : {}),
            }
          : (() => {
              const copy = this.#snapshotCopy(snap);
              return {
                snapshotId: snap.device_snapshot_id,
                snapshot: { values: copy.values, sha256: copy.sha256 },
                // A restore that turns Secure Boot or the TPM off needs the override too (novad
                // refuses it otherwise); the flag was checked above and is covered by the hash.
                ...(row.security_degrading === 1 ? { allowSecurityDegrading: true } : {}),
              };
            })();
      const signer = this.#identity();
      if (!signer)
        throw new NovaError('conflict', 'the Hub identity key is not available to sign with', {
          details: { reason: 'identity_unavailable' },
        });
      const path = row.kind === 'apply' ? FIRMWARE_PATHS.apply : FIRMWARE_PATHS.rollback;
      // The device must hold the current toggle before the send (D3): pushed now when what it
      // last confirmed differs. Best effort: the send itself says when the device is away.
      await this.#devices.syncPolicy?.(accountId, deviceId).catch((err: unknown) => {
        this.#log.info('syncing the device policy before a firmware send failed', { err });
      });
      let authzId = '';
      const sendOnce = async (): Promise<unknown> => {
        // The password is never part of the signed hash (authz.ts) and never stored or logged.
        // Every attempt is signed afresh: a change id is never used twice (D2).
        const signed = authorizeDeviceBody(signer, {
          kind: row.kind === 'apply' ? 'firmware.apply' : 'firmware.rollback',
          deviceId,
          approvalId,
          body,
          now: this.#now(),
        });
        authzId = signed.authorization.payload.changeId;
        this.#run(
          `UPDATE firmware_change SET change_id = ?, reboot = ?, updated_at = ? WHERE id = ?`,
          authzId,
          row.kind === 'apply' ? (reboot ? 1 : 0) : null,
          this.#iso(),
          row.id,
        );
        const wireBody: Record<string, unknown> = password
          ? { ...signed, adminPassword: password }
          : signed;
        return this.#call(d, path, wireBody, this.#timeoutMs * 4);
      };
      let raw: unknown;
      try {
        raw = await sendOnce();
      } catch (err) {
        let failure: unknown = err;
        // The device still had the toggle off while the Hub's is on: push it, retry once. Still
        // off: a clear refusal that leaves the change approved (never a spent approval).
        if (
          deviceToggleOff(err) &&
          this.#devices.syncPolicy &&
          (await this.#settings.allowChanges())
        ) {
          try {
            await this.#devices.syncPolicy(accountId, deviceId, { force: true });
            raw = await sendOnce();
            failure = null;
          } catch (err2) {
            failure = deviceToggleOff(err2) ? devicePolicyStale() : err2;
          }
        }
        if (failure !== null)
          return await this.#failed(accountId, d, row, failure, approvalId, authzId);
      }
      this.#cache.delete(deviceId);
      return row.kind === 'apply'
        ? await this.#applied(accountId, row, raw, approvalId, authzId, reboot)
        : await this.#restored(accountId, row, raw, approvalId, authzId);
    } finally {
      unlock();
    }
  }

  async #applied(
    accountId: string,
    row: ChangeRow,
    raw: unknown,
    approvalId: string,
    authzId: string,
    reboot: boolean,
  ): Promise<FirmwareChangeView> {
    const out = firmwareApplyWireSchema.parse(raw);
    const now = this.#iso();
    const before = out.applied.length
      ? Object.fromEntries(out.applied.map((a) => [a.key, a.from]))
      : parseJson<ValueMap>(row.old_value, {});
    const after = out.applied.length
      ? Object.fromEntries(out.applied.map((a) => [a.key, a.to]))
      : parseJson<ValueMap>(row.new_value, {});
    this.#run(
      `UPDATE firmware_change SET status = 'applied', applied_at = ?, updated_at = ?, error = NULL,
         watchdog_state = ?, watchdog_deadline = ? WHERE id = ?`,
      now,
      now,
      out.watchdog ? 'pending' : null,
      out.watchdog?.deadline ?? null,
      row.id,
    );
    await this.#auditAppend(
      accountId,
      'device.firmware.apply',
      row.device_id,
      {
        changeId: row.id,
        approvalId,
        authorization: authzId,
        before,
        after,
        reboot,
        pendingReboot: out.pendingReboot,
        watchdogDeadline: out.watchdog?.deadline ?? null,
        securityDegrading: row.security_degrading === 1,
      },
      { result: 'ok' },
    );
    const updated = this.#row(row.id)!;
    await this.#changed(updated);
    return this.#changeView(updated);
  }

  async #restored(
    accountId: string,
    row: ChangeRow,
    raw: unknown,
    approvalId: string,
    authzId: string,
  ): Promise<FirmwareChangeView> {
    const out = firmwareRollbackWireSchema.parse(raw);
    const now = this.#iso();
    this.#run(
      `UPDATE firmware_change SET status = 'applied', applied_at = ?, updated_at = ?, error = NULL
       WHERE id = ?`,
      now,
      now,
      row.id,
    );
    if (row.rollback_of) {
      this.#run(
        `UPDATE firmware_change SET status = 'rolled_back', updated_at = ?,
           watchdog_state = CASE WHEN watchdog_state = 'pending' THEN NULL ELSE watchdog_state END
         WHERE id = ? AND status IN ('applied', 'revert_failed')`,
        now,
        row.rollback_of,
      );
    }
    await this.#auditAppend(
      accountId,
      'device.firmware.rollback',
      row.device_id,
      {
        changeId: row.id,
        rollbackOf: row.rollback_of,
        approvalId,
        authorization: authzId,
        snapshotId: row.snapshot_ref,
        before: out.restored.length
          ? Object.fromEntries(out.restored.map((a) => [a.key, a.from]))
          : parseJson<ValueMap>(row.old_value, {}),
        after: out.restored.length
          ? Object.fromEntries(out.restored.map((a) => [a.key, a.to]))
          : parseJson<ValueMap>(row.new_value, {}),
      },
      { result: 'ok' },
    );
    const updated = this.#row(row.id)!;
    await this.#changed(updated);
    if (row.rollback_of) {
      const original = this.#row(row.rollback_of);
      if (original) await this.#changed(original);
    }
    return this.#changeView(updated);
  }

  /** A device refused or failed: record why; a change that cannot run again becomes `failed`. */
  async #failed(
    accountId: string,
    d: FirmwareDeviceRef & { endpoint: string },
    row: ChangeRow,
    err: unknown,
    approvalId: string,
    authzId: string,
  ): Promise<FirmwareChangeView> {
    const e =
      err instanceof NovaError
        ? err
        : new NovaError('server_error', 'the device call failed', { cause: err });
    const reason = typeof e.details?.reason === 'string' ? e.details.reason : null;
    const action = row.kind === 'apply' ? 'device.firmware.apply' : 'device.firmware.rollback';
    const diff = parseJson<FirmwareDiffEntry[]>(row.diff_json, []);
    if (e.code === 'conflict' && reason === 'base_mismatch' && row.kind === 'apply') {
      // A lost answer to an earlier attempt can leave the change applied: look before failing.
      const now = await this.#readWire(accountId, d).catch(() => null);
      const current = new Map(now?.wire.settings.map((s) => [s.key, s.value]) ?? []);
      if (now && diff.every((x) => sameFirmwareValue(current.get(x.key) ?? null, x.to))) {
        const at = this.#iso();
        this.#run(
          `UPDATE firmware_change SET status = 'applied', applied_at = ?, updated_at = ?,
             error = NULL WHERE id = ?`,
          at,
          at,
          row.id,
        );
        await this.#auditAppend(
          accountId,
          action,
          row.device_id,
          {
            changeId: row.id,
            approvalId,
            authorization: authzId,
            before: parseJson<ValueMap>(row.old_value, {}),
            after: parseJson<ValueMap>(row.new_value, {}),
            confirmedByRead: true,
          },
          { result: 'ok' },
        );
        const updated = this.#row(row.id)!;
        await this.#changed(updated);
        return this.#changeView(updated);
      }
    }
    // Final outcomes: the base moved, or the write failed on the device (it restored).
    const final =
      (e.code === 'conflict' && reason === 'base_mismatch') ||
      (e.code === 'server_error' && reason === 'apply_failed');
    const restored = e.details?.restored;
    const error = `${e.code}${reason ? `:${reason}` : ''}`.slice(0, 200);
    this.#run(
      `UPDATE firmware_change SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
      final ? 'failed' : row.status,
      error,
      this.#iso(),
      row.id,
    );
    await this.#auditAppend(
      accountId,
      action,
      row.device_id,
      {
        changeId: row.id,
        approvalId,
        authorization: authzId,
        before: parseJson<ValueMap>(row.old_value, {}),
        after: parseJson<ValueMap>(row.old_value, {}),
        attempted: parseJson<ValueMap>(row.new_value, {}),
        error,
        ...(typeof restored === 'boolean' ? { restored } : {}),
      },
      { result: final ? 'failed' : 'error' },
    );
    if (final) await this.#changed(this.#row(row.id)!);
    if (reason === 'apply_failed' && restored !== true) {
      await this.#notify(
        accountId,
        'attention',
        'A firmware change failed and was not restored',
        `${d.row.name}: check its firmware settings before the next reboot`,
        `/devices/${row.device_id}`,
        `firmware:${row.id}:failed`,
      );
    }
    throw e;
  }

  // ---- rollback ------------------------------------------------------------------------------

  /**
   * `POST …/firmware/snapshots/:snapshotId/rollback`: plan restoring a snapshot (the diff from the
   * values now) and ask for its approval. It runs with `apply` once approved; the Hub sends its
   * own copy of the snapshot, which the device uses when it lost its own.
   */
  async rollback(
    accountId: string,
    deviceId: string,
    snapshotId: string,
    note?: string,
  ): Promise<FirmwareChangeView> {
    await this.#requireAllowed();
    const snap = this.#get<SnapshotRow>(
      'SELECT * FROM firmware_snapshot WHERE id = ? AND account_id = ? AND device_id = ?',
      snapshotId,
      accountId,
      deviceId,
    );
    if (!snap) throw new NovaError('not_found', 'snapshot not found');
    const original = this.#get<ChangeRow>(
      `SELECT * FROM firmware_change WHERE snapshot_ref = ? AND kind = 'apply'
       ORDER BY created_at DESC LIMIT 1`,
      snap.id,
    );
    if (!original || (original.status !== 'applied' && original.status !== 'revert_failed'))
      throw new NovaError('conflict', 'nothing to roll back to this snapshot', {
        details: {
          reason: original?.status === 'rolled_back' ? 'rolled_back' : 'nothing_to_roll_back',
        },
      });
    const open = this.#get<ChangeRow>(
      `SELECT * FROM firmware_change WHERE rollback_of = ? AND kind = 'rollback'
         AND status IN ('awaiting_approval', 'approved') ORDER BY created_at DESC LIMIT 1`,
      original.id,
    );
    if (
      open &&
      (open.status === 'approved' ||
        this.#approvalOpen(this.#approval(accountId, open.approval_id)))
    )
      return this.#changeView(open);
    const copy = this.#snapshotCopy(snap);
    const d = await this.#usable(accountId, deviceId);
    const unlock = this.#lock(deviceId);
    let row: ChangeRow;
    let diff: FirmwareDiffEntry[];
    try {
      const facts = await this.#supportedRead(accountId, d);
      const settingOf = new Map(facts.settings.map((s) => [s.key, s]));
      diff = [];
      for (const [key, to] of Object.entries(copy.values)) {
        if (!isFirmwareKey(key)) continue;
        const s = settingOf.get(key);
        const from = s?.value ?? null;
        if (sameFirmwareValue(from, to)) continue;
        diff.push({
          key,
          vendorKey: s?.vendorKey || key,
          from,
          to,
          securityDegrading: firmwareSecurityDegrading(key, to, s?.securityDegrading),
        });
      }
      if (diff.length === 0)
        throw new NovaError('conflict', 'the device already holds the snapshot values', {
          details: { reason: 'nothing_to_roll_back' },
        });
      if (diff.some((e) => e.securityDegrading) && !(await this.#settings.allowSecurityDegrading()))
        throw securityDegrading(diff.filter((e) => e.securityDegrading).map((e) => e.key));
      row = await this.#record(accountId, d, {
        kind: 'rollback',
        diff,
        refused: [],
        method: facts.method ?? original.method,
        planId: null,
        snapshot: null,
        snapshotRef: snap.id,
        rollbackOf: original.id,
        requiresReboot: original.requires_reboot === 1,
      });
    } finally {
      unlock();
    }
    await this.#auditAppend(
      accountId,
      'device.firmware.rollback',
      deviceId,
      {
        changeId: row.id,
        rollbackOf: original.id,
        snapshotId: snap.id,
        before: fromMap(diff),
        after: toMap(diff),
      },
      { result: 'requested' },
    );
    return this.#openApproval(accountId, d, row, diff, note);
  }

  // ---- the watchdog ---------------------------------------------------------------------------

  /**
   * Heartbeat events of a device (D4): `firmware.watchdog.ok` (the machine came back after the
   * reboot) and `firmware.watchdog.reverted` (it did not, and novad restored the snapshot). The
   * devices area hands each heartbeat's `events` here; other kinds are ignored.
   */
  async onHeartbeatEvents(
    accountId: string,
    deviceId: string,
    events: readonly unknown[],
  ): Promise<void> {
    for (const e of events) {
      if (!isRecord(e)) continue;
      const kind = e.kind;
      if (kind !== 'firmware.watchdog.ok' && kind !== 'firmware.watchdog.reverted') continue;
      const changeId =
        typeof e.changeId === 'string' && e.changeId ? e.changeId.slice(0, 100) : null;
      const snapshotId =
        typeof e.snapshotId === 'string' && e.snapshotId ? e.snapshotId.slice(0, 100) : null;
      if (!changeId && !snapshotId) continue;
      try {
        await this.#watchdogEvent(accountId, deviceId, kind, { changeId, snapshotId }, e);
      } catch (err) {
        this.#log.warn('firmware watchdog event failed', { err, deviceId });
      }
    }
  }

  async #watchdogEvent(
    accountId: string,
    deviceId: string,
    kind: 'firmware.watchdog.ok' | 'firmware.watchdog.reverted',
    ids: { changeId: string | null; snapshotId: string | null },
    e: Record<string, unknown>,
  ): Promise<void> {
    // The authorization's change id names exactly the apply that armed the watchdog; only an
    // event without one (an older novad) is matched by its snapshot.
    const row = ids.changeId
      ? this.#get<ChangeRow>(
          `SELECT * FROM firmware_change WHERE account_id = ? AND device_id = ? AND kind = 'apply'
             AND change_id = ?`,
          accountId,
          deviceId,
          ids.changeId,
        )
      : this.#get<ChangeRow>(
          `SELECT c.* FROM firmware_change c JOIN firmware_snapshot s ON s.id = c.snapshot_ref
           WHERE c.account_id = ? AND c.device_id = ? AND c.kind = 'apply'
             AND s.device_snapshot_id = ?
           ORDER BY c.created_at DESC LIMIT 1`,
          accountId,
          deviceId,
          ids.snapshotId,
        );
    if (!row) {
      this.#log.warn('a firmware watchdog event names no known change', { deviceId, ...ids });
      return;
    }
    const name =
      this.#get<{ name: string }>('SELECT name FROM device WHERE id = ?', deviceId)?.name ??
      'a device';
    const at = typeof e.at === 'string' ? e.at.slice(0, 40) : null;
    const now = this.#iso();
    const before = parseJson<ValueMap>(row.old_value, {});
    const after = parseJson<ValueMap>(row.new_value, {});
    if (kind === 'firmware.watchdog.ok') {
      if (row.watchdog_state !== 'pending' && row.watchdog_state !== 'missed') return;
      this.#run(
        "UPDATE firmware_change SET watchdog_state = 'ok', updated_at = ? WHERE id = ?",
        now,
        row.id,
      );
      await this.#auditAppend(
        row.account_id,
        'device.firmware.watchdog',
        deviceId,
        { changeId: row.id, result: 'ok', at, before, after },
        { actor: 'system', result: 'ok' },
      );
      await this.#notify(
        row.account_id,
        'completion',
        'Firmware change confirmed',
        `${name} came back after the reboot with its new firmware settings`,
        `/devices/${deviceId}`,
        `firmware:${row.id}:watchdog`,
      );
    } else {
      if (row.status === 'reverted' || row.status === 'revert_failed') return;
      this.#cache.delete(deviceId);
      const r = revertReport(e.detail);
      // Only a report that names every changed key as restored, with no error, is a revert; a
      // failed, partial or unreadable one leaves the change in place and says so (FR-146 safety 7).
      const keys = Object.keys(after);
      const restoredKeys = new Set(r.restored.map((x) => x.key));
      const complete =
        r.readable &&
        r.complete !== false &&
        r.failed.length === 0 &&
        !r.error &&
        keys.every((k) => restoredKeys.has(k));
      // What the device holds now: the change, except the keys it reports restored.
      const held: ValueMap = { ...after };
      for (const x of r.restored) if (x.key in held) held[x.key] = x.to;
      const status: FirmwareChangeStatus = complete ? 'reverted' : 'revert_failed';
      this.#run(
        `UPDATE firmware_change SET status = ?, watchdog_state = ?, watchdog_reason = ?, error = ?,
           updated_at = ? WHERE id = ?`,
        status,
        status,
        r.reason,
        complete
          ? `watchdog:${r.reason ?? 'reverted'}`.slice(0, 200)
          : `watchdog:${r.errorCode ?? (r.error ? 'error' : 'incomplete')}`.slice(0, 200),
        now,
        row.id,
      );
      await this.#auditAppend(
        row.account_id,
        'device.firmware.watchdog',
        deviceId,
        {
          changeId: row.id,
          result: status,
          at,
          reason: r.reason,
          rebooted: r.rebooted,
          restored: r.restored,
          ...(r.failed.length ? { failed: r.failed } : {}),
          ...(complete ? {} : { notRestored: keys.filter((k) => !restoredKeys.has(k)) }),
          ...(r.error ? { error: r.error } : {}),
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
          before: after,
          after: complete ? before : held,
        },
        { actor: 'system', result: status },
      );
      const notice = watchdogNotice(name, r.reason, complete, r.errorCode, r.rebooted);
      await this.#notify(
        row.account_id,
        'attention',
        notice.title,
        notice.body,
        `/devices/${deviceId}`,
        `firmware:${row.id}:watchdog`,
      );
    }
    await this.#changed(this.#row(row.id)!, 'system');
  }

  /**
   * Changes whose device never reported by the watchdog deadline plus the grace become `missed`
   * and the owner is told: the Hub cannot revert a machine that does not come up (novad does,
   * when it starts). Returns the ids marked.
   */
  async sweep(): Promise<string[]> {
    const cutoff = new Date(this.#now().getTime() - this.#graceMs).toISOString();
    const rows = this.#all<ChangeRow>(
      `SELECT * FROM firmware_change WHERE watchdog_state = 'pending'
         AND watchdog_deadline IS NOT NULL AND watchdog_deadline < ?`,
      cutoff,
    );
    for (const row of rows) {
      this.#run(
        "UPDATE firmware_change SET watchdog_state = 'missed', updated_at = ? WHERE id = ?",
        this.#iso(),
        row.id,
      );
      const name =
        this.#get<{ name: string }>('SELECT name FROM device WHERE id = ?', row.device_id)?.name ??
        'a device';
      await this.#auditAppend(
        row.account_id,
        'device.firmware.watchdog',
        row.device_id,
        {
          changeId: row.id,
          result: 'missed',
          deadline: row.watchdog_deadline,
          before: parseJson<ValueMap>(row.old_value, {}),
          after: parseJson<ValueMap>(row.new_value, {}),
        },
        { actor: 'system', result: 'missed' },
      );
      await this.#notify(
        row.account_id,
        'attention',
        'A device has not come back after a firmware change',
        `${name} has not reported since its reboot; its watchdog restores the previous settings when it starts`,
        `/devices/${row.device_id}`,
        `firmware:${row.id}:watchdog`,
      );
      await this.#changed(this.#row(row.id)!, 'system');
    }
    return rows.map((r) => r.id);
  }

  // ---- the BIOS admin password --------------------------------------------------------------

  /** Store (or with null, remove) the BIOS admin password in the vault; never returned. */
  async setAdminPassword(
    accountId: string,
    deviceId: string,
    password: string | null,
  ): Promise<{ stored: boolean }> {
    await this.#device(accountId, deviceId);
    const ref = biosPasswordRef(deviceId);
    if (password === null) await this.#secrets.delete(ref);
    else await this.#secrets.put(ref, password);
    await this.#auditAppend(
      accountId,
      password === null ? 'device.firmware.password.clear' : 'device.firmware.password.set',
      deviceId,
      { ref },
      { kind: 'secret' },
    );
    return { stored: password !== null };
  }

  async adminPasswordStored(deviceId: string): Promise<boolean> {
    return this.#secrets.has(biosPasswordRef(deviceId));
  }

  // ---- history -------------------------------------------------------------------------------

  #changeView(row: ChangeRow): FirmwareChangeView {
    const a = this.#approval(row.account_id, row.approval_id);
    const approval: FirmwareApprovalState | null = a
      ? {
          id: a.id,
          status: a.status,
          decision: a.decision,
          decidedAt: a.decided_at,
          expiresAt: a.expires_at,
        }
      : null;
    return {
      id: row.id,
      deviceId: row.device_id,
      kind: row.kind,
      status: row.status,
      method: row.method,
      planId: row.plan_id,
      snapshotId: row.snapshot_ref,
      rollbackOf: row.rollback_of,
      diff: parseJson<FirmwareDiffEntry[]>(row.diff_json, []),
      refused: parseJson<FirmwareRefusalView[]>(row.refused_json, []),
      from: parseJson<ValueMap>(row.old_value, {}),
      to: parseJson<ValueMap>(row.new_value, {}),
      securityDegrading: row.security_degrading === 1,
      requiresReboot: row.requires_reboot === 1,
      reboot: row.reboot === null ? null : row.reboot === 1,
      approval,
      watchdog: row.watchdog_state
        ? {
            state: row.watchdog_state,
            deadline: row.watchdog_deadline,
            reason: row.watchdog_reason,
          }
        : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at,
    };
  }

  async change(accountId: string, deviceId: string, changeId: string): Promise<FirmwareChangeView> {
    await this.#device(accountId, deviceId);
    return this.#changeView(this.#changeRow(accountId, deviceId, changeId));
  }

  /** `GET …/firmware/history`: changes and snapshots, newest first. */
  async history(accountId: string, deviceId: string, limit = 50): Promise<FirmwareHistoryView> {
    await this.#device(accountId, deviceId);
    const changes = this.#all<ChangeRow>(
      `SELECT * FROM firmware_change WHERE account_id = ? AND device_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      accountId,
      deviceId,
      limit,
    );
    const snapshots = this.#all<SnapshotRow>(
      `SELECT * FROM firmware_snapshot WHERE account_id = ? AND device_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      accountId,
      deviceId,
      limit,
    );
    return {
      changes: changes.map((r) => this.#changeView(r)),
      snapshots: snapshots.map((s): FirmwareSnapshotView => ({
        id: s.id,
        deviceId: s.device_id,
        deviceSnapshotId: s.device_snapshot_id,
        takenAt: s.taken_at,
        keys: parseJson<string[]>(s.keys_json, []),
        sha256: s.sha256,
        createdAt: s.created_at,
      })),
    };
  }

  /** Whether a snapshot's sealed copy is still on disk (diagnostics). */
  snapshotCopyExists(snapshotId: string): boolean {
    const s = this.#snapshotRow(snapshotId);
    return !!s && existsSync(join(this.#dataDir, s.blob_path));
  }
}

/**
 * novad's `firmware.watchdog.reverted` detail (R1): `{reason, complete, restored: [{key, from,
 * to}], failed: [{key, from, to, error}], rebooted}`, read with bounds. `complete: false`, a failed
 * key, an `error` or a missing `restored` list is not a revert.
 */
function revertReport(detail: unknown): {
  readable: boolean;
  complete: boolean | null;
  reason: string | null;
  restored: { key: string; from: FirmwareValue | null; to: FirmwareValue | null }[];
  failed: { key: string; error: string | null }[];
  rebooted: boolean;
  error: string | null;
  errorCode: string | null;
} {
  const d = isRecord(detail) ? detail : null;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const value = (v: unknown): FirmwareValue | null => {
    const p = firmwareValueSchema.nullable().safeParse(v ?? null);
    return p.success ? p.data : null;
  };
  const entries = (v: unknown) =>
    (Array.isArray(v) ? v.slice(0, 64) : [])
      .filter(isRecord)
      .filter((x): x is Record<string, unknown> & { key: string } => typeof x.key === 'string');
  const failed = entries(d?.failed).map((x) => ({
    key: x.key.slice(0, 100),
    error: str(x.error, 100),
  }));
  return {
    readable: d !== null && Array.isArray(d.restored),
    complete: typeof d?.complete === 'boolean' ? d.complete : null,
    reason: str(d?.reason, 50),
    restored: entries(d?.restored).map((x) => ({
      key: x.key.slice(0, 100),
      from: value(x.from),
      to: value(x.to),
    })),
    failed,
    rebooted: d?.rebooted === true,
    error: str(d?.error, 300),
    errorCode: str(d?.errorCode, 100) ?? failed.find((f) => f.error)?.error ?? null,
  };
}

/**
 * What the owner is told when the device's watchdog reverted a change, or tried to, worded by
 * novad's reason: `deadline` (it restarted into the change and was not back in time) or
 * `not_restarted` (it never restarted before the deadline, so nothing was tried at boot).
 */
export function watchdogNotice(
  name: string,
  reason: string | null,
  complete: boolean,
  errorCode: string | null,
  rebooted: boolean,
): { title: string; body: string } {
  const what =
    reason === 'deadline'
      ? `${name} restarted into the firmware change but was not back in time`
      : reason === 'not_restarted'
        ? `${name} did not restart before the watchdog deadline`
        : null;
  if (complete) {
    const restored = `the watchdog restored the previous settings${
      reason === 'not_restarted' ? ' without a restart' : rebooted ? ' and restarted it' : ''
    }`;
    return {
      title: 'Firmware change reverted',
      body: what ? `${what}, so ${restored}.` : `On ${name}, ${restored}.`,
    };
  }
  const code = errorCode ? ` (${errorCode})` : '';
  const failed = `the watchdog could not restore the previous settings${code}. Roll it back from Nova or check its firmware.`;
  return {
    title: 'A firmware change could not be reverted',
    body: what ? `${what}, and ${failed}` : `On ${name}, ${failed}`,
  };
}

function fromMap(diff: readonly FirmwareDiffEntry[]): ValueMap {
  return Object.fromEntries(diff.map((e) => [e.key, e.from]));
}

function toMap(diff: readonly FirmwareDiffEntry[]): ValueMap {
  return Object.fromEntries(diff.map((e) => [e.key, e.to]));
}
