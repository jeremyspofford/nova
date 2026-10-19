// A stand-in for novad's firmware routes (ADR-096 D4) for tests and offline journeys: an HTTP
// server on 127.0.0.1 holding a JSON firmware state, with the same refusals novad answers
// (services/novad/src/firmware.rs). It checks the management token, verifies every write's
// authorization with `authz.ts` (the verifier the shared vectors pin), refuses a BIOS admin
// password that arrives over plain HTTP (`tls_required`; `transport` says how the request came),
// refuses a security-degrading apply or rollback without `allowSecurityDegrading`, keeps
// snapshots, applies with a base check, restores on a failed write, arms a watchdog on reboot
// and reports `firmware.watchdog.*` events with novad's `detail` shapes for the next heartbeat:
// ok `{}`, reverted `{reason, restored: [{key, from, to}], rebooted, error?, errorCode?}`. Its
// watchdog cannot restore a machine with an admin password (novad never keeps it). It never
// touches a real machine.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { FirmwarePlatform, FirmwareSettingType, FirmwareValue } from '@nova/shared';
import {
  MemoryReplayStore,
  deviceAuthzError,
  verifyDeviceAuthorization,
  type DeviceAuthzKind,
} from './authz.ts';
import { firmwareSnapshotSha256, sameFirmwareValue } from './protocol.ts';

export interface FakeFirmwareSetting {
  key: string;
  vendorKey: string;
  value: FirmwareValue | null;
  type: FirmwareSettingType;
  allowed: string[] | null;
  readOnly?: boolean;
  securityDegrading?: string[];
}

export interface FakeFirmwareNovadOptions {
  /** The device id authorizations must name. */
  deviceId: string;
  /** The pinned Hub identity key (raw Ed25519, base64url). */
  hubPublicKey: string;
  /** The bearer token the Hub presents. */
  managementToken: string;
  platform?: Partial<FirmwarePlatform>;
  supported?: boolean;
  reason?: string;
  method?: 'firmware-attributes' | 'efibootmgr' | 'fake';
  /** The machine has a BIOS admin password; writes need it in `adminPassword`. */
  adminPassword?: string;
  settings?: FakeFirmwareSetting[];
  /** `policy.firmwareChanges` from the last heartbeat answer (D3); true by default here. */
  firmwareChanges?: boolean;
  /** Seconds the watchdog waits after a reboot (default 600). */
  watchdogSeconds?: number;
  now?: () => Date;
}

/** Dell-shaped defaults: every canonical key, Secure Boot and TPM flagged as degrading when off. */
export const FAKE_FIRMWARE_SETTINGS: readonly FakeFirmwareSetting[] = [
  {
    key: 'wol',
    vendorKey: 'WakeOnLan',
    value: 'Disabled',
    type: 'enum',
    allowed: ['Disabled', 'LanOnly', 'LanWlan'],
  },
  {
    key: 'powerOnAfterPowerLoss',
    vendorKey: 'AcPwrRcvry',
    value: 'Off',
    type: 'enum',
    allowed: ['Off', 'On', 'Last'],
  },
  {
    key: 'bootOrder',
    vendorKey: 'BootOrder',
    value: ['ubuntu', 'Windows Boot Manager'],
    type: 'order',
    allowed: null,
  },
  {
    key: 'virtualization',
    vendorKey: 'Virtualization',
    value: 'Enabled',
    type: 'enum',
    allowed: ['Disabled', 'Enabled'],
  },
  {
    key: 'secureBoot',
    vendorKey: 'SecureBoot',
    value: 'Enabled',
    type: 'enum',
    allowed: ['Disabled', 'Enabled'],
    securityDegrading: ['Disabled'],
  },
  {
    key: 'tpm',
    vendorKey: 'TpmSecurity',
    value: 'Enabled',
    type: 'enum',
    allowed: ['Disabled', 'Enabled'],
    securityDegrading: ['Disabled'],
  },
  {
    key: 'fanProfile',
    vendorKey: 'ThermalManagement',
    value: 'Optimized',
    type: 'enum',
    allowed: ['Optimized', 'Cool', 'Quiet', 'UltraPerformance'],
    readOnly: true,
  },
];

class FwError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Snapshot {
  id: string;
  takenAt: string;
  values: Record<string, FirmwareValue | null>;
  sha256: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class FakeFirmwareNovad {
  readonly deviceId: string;
  readonly settings = new Map<string, FakeFirmwareSetting>();
  readonly snapshots = new Map<string, Snapshot>();
  readonly plans = new Map<string, { snapshotId: string }>();
  /** Every request: path and body (with the authorization). */
  readonly calls: { path: string; body: Record<string, unknown> }[] = [];
  /** Events for the next heartbeat (`firmware.watchdog.ok|reverted`). */
  readonly events: Record<string, unknown>[] = [];
  readonly replay: MemoryReplayStore;
  policy: { firmwareChanges: boolean; lowLevelBoot: boolean };
  supported: boolean;
  reason: string | null;
  /** The watchdog marker after a reboot (`firmware/pending.json`). */
  pending: { snapshotId: string; deadline: string; changeId: string } | null = null;
  /** Leave the change id out of watchdog events, as a novad from before the M7.5 review did. */
  omitChangeId = false;
  /** Fail the write of this key (after the earlier ones were written). */
  failWriteOf: string | null = null;
  /** Restoring after a failed write fails too. */
  failRestore = false;
  /** Reboots requested through the power module. */
  reboots = 0;
  /** The watchdog length of the last guarded apply. */
  lastWatchdogSeconds: number | null = null;
  /**
   * How requests reach it: `plain` HTTP (the default) or `mutual_tls` (a test that routes an https
   * endpoint here). novad refuses `adminPassword` on plain HTTP.
   */
  transport: 'plain' | 'mutual_tls' = 'plain';
  readonly #opts: FakeFirmwareNovadOptions;
  readonly #now: () => Date;
  #server: Server | null = null;
  endpoint: string | null = null;

  constructor(opts: FakeFirmwareNovadOptions) {
    this.#opts = opts;
    this.deviceId = opts.deviceId;
    this.#now = opts.now ?? (() => new Date());
    this.replay = new MemoryReplayStore({ now: () => this.#now().getTime() });
    this.policy = { firmwareChanges: opts.firmwareChanges ?? true, lowLevelBoot: false };
    this.supported = opts.supported ?? true;
    this.reason = opts.reason ?? null;
    for (const s of opts.settings ?? FAKE_FIRMWARE_SETTINGS) this.settings.set(s.key, { ...s });
  }

  async listen(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    const addr = this.#server.address() as { port: number };
    this.endpoint = `http://127.0.0.1:${addr.port}`;
    return this.endpoint;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server!.close(() => r()));
    this.#server = null;
  }

  /** The current value of a setting. */
  value(key: string): FirmwareValue | null {
    return this.settings.get(key)?.value ?? null;
  }

  /** Change a value behind the Hub's back (someone used the firmware setup screen). */
  set(key: string, value: FirmwareValue | null): void {
    const s = this.settings.get(key);
    if (s) s.value = value;
  }

  /** The device lost a snapshot (a reinstall, a wiped data folder). */
  loseSnapshot(id: string): void {
    this.snapshots.delete(id);
  }

  /** novad starts after the reboot and its first heartbeat is accepted: the change stays. */
  #head(kind: string): Record<string, unknown> {
    const p = this.pending!;
    return {
      kind,
      ...(this.omitChangeId ? {} : { changeId: p.changeId }),
      snapshotId: p.snapshotId,
      at: this.#now().toISOString(),
    };
  }

  bootOk(): void {
    if (!this.pending) return;
    this.events.push({ ...this.#head('firmware.watchdog.ok'), detail: {} });
    this.pending = null;
  }

  /**
   * The deadline passed before a heartbeat: novad restores the snapshot, and only a complete
   * restore reboots (once). Its detail is novad's: `{reason, complete, restored, failed: [{key,
   * from, to, error}], rebooted}`. It cannot restore with an admin password set (never kept):
   * every key fails with `admin_password_required`; `failRestore` fails every key as a write
   * failure, which leaves the machine on the change.
   */
  bootFailed(): void {
    if (!this.pending) return;
    const snap = this.snapshots.get(this.pending.snapshotId);
    const head = this.#head('firmware.watchdog.reverted');
    const error =
      this.#opts.adminPassword !== undefined
        ? 'admin_password_required'
        : this.failRestore || !snap
          ? 'write_failed'
          : null;
    if (error) {
      const failed = Object.entries(snap?.values ?? {})
        .filter(
          ([k, v]) => this.settings.has(k) && !sameFirmwareValue(this.settings.get(k)!.value, v),
        )
        .map(([key, to]) => ({ key, from: this.settings.get(key)!.value, to, error }));
      this.events.push({
        ...head,
        detail: { reason: 'deadline', complete: false, restored: [], failed, rebooted: false },
      });
    } else {
      const restored = this.#restore(snap!.values);
      this.events.push({
        ...head,
        detail: { reason: 'deadline', complete: true, restored, failed: [], rebooted: true },
      });
      this.reboots += 1;
    }
    this.pending = null;
  }

  #snapshot(): Snapshot {
    const values: Record<string, FirmwareValue | null> = {};
    for (const [k, s] of this.settings) values[k] = structuredClone(s.value);
    const snap: Snapshot = {
      id: `snap-${randomBytes(6).toString('hex')}`,
      takenAt: this.#now().toISOString(),
      values,
      sha256: firmwareSnapshotSha256(values),
    };
    this.snapshots.set(snap.id, snap);
    // novad keeps the last 20.
    while (this.snapshots.size > 20) {
      const first = this.snapshots.keys().next();
      if (first.done) break;
      this.snapshots.delete(first.value);
    }
    return snap;
  }

  #restore(
    values: Record<string, FirmwareValue | null>,
  ): { key: string; from: unknown; to: unknown }[] {
    const out: { key: string; from: unknown; to: unknown }[] = [];
    for (const [k, v] of Object.entries(values)) {
      const s = this.settings.get(k);
      if (!s || sameFirmwareValue(s.value, v)) continue;
      out.push({ key: k, from: s.value, to: v });
      s.value = structuredClone(v);
    }
    return out;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.headers.authorization !== `Bearer ${this.#opts.managementToken}`) {
        send(401, { error: { code: 'token_required', message: 'a valid management token' } });
        return;
      }
      const parsed: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : {};
      const body = isRecord(parsed) ? parsed : {};
      const path = (req.url ?? '').split('?')[0] ?? '';
      this.calls.push({ path, body });
      send(200, this.#route(path, body));
    } catch (err) {
      if (err instanceof FwError)
        send(err.status, {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });
      else
        send(500, {
          error: { code: 'server_error', message: err instanceof Error ? err.message : 'error' },
        });
    }
  }

  #route(path: string, body: Record<string, unknown>): unknown {
    switch (path) {
      case '/agent/v1/firmware/read':
        return this.#read();
      case '/agent/v1/firmware/plan':
        this.#requireSupported();
        return this.#plan(body);
      case '/agent/v1/firmware/apply':
        this.#requireSupported();
        this.#authorize('firmware.apply', body);
        return this.#apply(body);
      case '/agent/v1/firmware/rollback':
        this.#requireSupported();
        this.#authorize('firmware.rollback', body);
        return this.#rollback(body);
      case '/agent/v1/config': {
        // The Hub's toggles pushed at once (D3, M7.5): only `true` turns one on, an absent one
        // keeps its value; the answer says what is in effect.
        const p = isRecord(body.policy) ? body.policy : {};
        if (typeof p.firmwareChanges === 'boolean') this.policy.firmwareChanges = p.firmwareChanges;
        if (typeof p.lowLevelBoot === 'boolean') this.policy.lowLevelBoot = p.lowLevelBoot;
        return { policy: { ...this.policy } };
      }
      default:
        throw new FwError(404, 'not_found', 'unknown management route');
    }
  }

  #read(): unknown {
    return {
      supported: this.supported,
      ...(this.reason ? { reason: this.reason } : {}),
      platform: {
        vendor: 'Dell Inc.',
        product: 'OptiPlex 7010',
        biosVendor: 'Dell Inc.',
        biosVersion: '1.20.0',
        biosDate: '2025-06-01',
        uefi: true,
        ...this.#opts.platform,
      },
      method: this.supported ? (this.#opts.method ?? 'fake') : null,
      adminPasswordSet: this.#opts.adminPassword !== undefined,
      settings: this.supported
        ? [...this.settings.values()].map((s) => ({
            ...s,
            readOnly: s.readOnly ?? false,
            securityDegrading: s.securityDegrading ?? [],
          }))
        : [],
      updates: [{ device: 'System Firmware', version: '1.21.0', summary: 'Security fixes' }],
    };
  }

  #requireSupported(): void {
    if (!this.supported)
      throw new FwError(409, 'unsupported_hardware', 'this machine is not supported', {
        reason: this.reason ?? 'unsupported',
      });
  }

  #authorize(kind: DeviceAuthzKind, body: Record<string, unknown>): void {
    const verdict = verifyDeviceAuthorization({
      authorization: body.authorization,
      publicKey: this.#opts.hubPublicKey,
      deviceId: this.deviceId,
      kind,
      body,
      now: this.#now(),
      replay: this.replay,
    });
    if (!verdict.ok) {
      const e = deviceAuthzError(verdict);
      throw new FwError(e.status, e.code, verdict.message, e.details);
    }
    // Both checks must pass (D3): a valid authorization does not override the device's toggle.
    if (!this.policy.firmwareChanges)
      throw new FwError(403, 'firmware_disabled', 'firmware changes are off on this device');
    // A long-lived firmware credential never rides plain HTTP (novad: Transport::Plain).
    if (body.adminPassword !== undefined && this.transport === 'plain')
      throw new FwError(403, 'policy_denied', 'the admin password needs mutual TLS', {
        reason: 'tls_required',
      });
    if (this.#opts.adminPassword !== undefined && typeof body.adminPassword !== 'string')
      throw new FwError(403, 'policy_denied', 'this BIOS needs its admin password', {
        reason: 'admin_password_required',
      });
  }

  /** A wrong password makes the firmware refuse the write (novad restores and says so). */
  #passwordWrong(body: Record<string, unknown>): boolean {
    return (
      this.#opts.adminPassword !== undefined && body.adminPassword !== this.#opts.adminPassword
    );
  }

  /** Keys whose new value is one the setting lists as weakening security. */
  #degrading(values: Record<string, unknown>): string[] {
    return Object.entries(values)
      .filter(([k, v]) => {
        const s = this.settings.get(k);
        return !!s && typeof v === 'string' && (s.securityDegrading ?? []).includes(v);
      })
      .map(([k]) => k);
  }

  #plan(body: Record<string, unknown>): unknown {
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const snap = this.#snapshot();
    const diff: Record<string, unknown>[] = [];
    const refused: { key: string; reason: string }[] = [];
    for (const raw of changes) {
      if (!isRecord(raw) || typeof raw.key !== 'string') continue;
      const s = this.settings.get(raw.key);
      const value = raw.value as FirmwareValue;
      if (!s) refused.push({ key: raw.key, reason: 'unknown_key' });
      else if (s.readOnly) refused.push({ key: raw.key, reason: 'read_only' });
      else if (s.allowed && (typeof value !== 'string' || !s.allowed.includes(value)))
        refused.push({ key: raw.key, reason: 'not_allowed_value' });
      else if (!sameFirmwareValue(s.value, value))
        diff.push({
          key: s.key,
          vendorKey: s.vendorKey,
          from: s.value,
          to: value,
          securityDegrading:
            typeof value === 'string' && (s.securityDegrading ?? []).includes(value),
        });
    }
    const planId = `plan-${randomBytes(6).toString('hex')}`;
    this.plans.set(planId, { snapshotId: snap.id });
    return { planId, snapshot: snap, diff, refused, requiresReboot: diff.length > 0 };
  }

  #apply(body: Record<string, unknown>): unknown {
    const snap =
      typeof body.snapshotId === 'string' ? this.snapshots.get(body.snapshotId) : undefined;
    if (!snap) throw new FwError(404, 'not_found', 'no such snapshot');
    for (const [k, v] of Object.entries(snap.values)) {
      if (!sameFirmwareValue(this.settings.get(k)?.value ?? null, v))
        throw new FwError(409, 'conflict', 'the settings changed since the plan', {
          reason: 'base_mismatch',
        });
    }
    const changes = (Array.isArray(body.changes) ? body.changes : []).filter(isRecord);
    for (const c of changes) {
      const s = this.settings.get(String(c.key));
      if (!s || s.readOnly) throw new FwError(400, 'validation', `cannot set ${String(c.key)}`);
      const degrading =
        typeof c.value === 'string' && (s.securityDegrading ?? []).includes(c.value);
      if (degrading && body.allowSecurityDegrading !== true)
        throw new FwError(403, 'policy_denied', 'a security-degrading change', {
          reason: 'security_degrading',
        });
    }
    // novad: `watchdogSeconds` 120-3600 when sent, else its default; checked before any write.
    const seconds =
      body.watchdogSeconds === undefined
        ? (this.#opts.watchdogSeconds ?? 600)
        : Number(body.watchdogSeconds);
    if (!Number.isInteger(seconds) || seconds < 120 || seconds > 3600)
      throw new FwError(400, 'validation', 'watchdogSeconds must be 120 to 3600');
    if (this.#passwordWrong(body))
      throw new FwError(500, 'server_error', 'the firmware refused the admin password', {
        reason: 'apply_failed',
        restored: true,
        key: typeof changes[0]?.key === 'string' ? changes[0].key : '',
      });
    const applied: { key: string; from: unknown; to: unknown }[] = [];
    for (const c of changes) {
      const s = this.settings.get(String(c.key))!;
      if (this.failWriteOf === s.key) {
        const restored = !this.failRestore;
        if (restored) this.#restore(snap.values);
        throw new FwError(500, 'server_error', `writing ${s.key} failed`, {
          reason: 'apply_failed',
          restored,
        });
      }
      applied.push({ key: s.key, from: s.value, to: c.value });
      s.value = structuredClone(c.value as FirmwareValue);
    }
    let watchdog: { deadline: string } | null = null;
    if (body.reboot === true) {
      this.lastWatchdogSeconds = seconds;
      const deadline = new Date(this.#now().getTime() + seconds * 1000).toISOString();
      const auth = isRecord(body.authorization) ? body.authorization : {};
      const payload = isRecord(auth.payload) ? auth.payload : {};
      this.pending = {
        snapshotId: snap.id,
        deadline,
        changeId: typeof payload.changeId === 'string' ? payload.changeId : '',
      };
      this.reboots += 1;
      watchdog = { deadline };
    }
    return { applied, pendingReboot: applied.length > 0, watchdog };
  }

  #rollback(body: Record<string, unknown>): unknown {
    const id = typeof body.snapshotId === 'string' ? body.snapshotId : '';
    let values = this.snapshots.get(id)?.values;
    if (!values) {
      // The Hub's copy, when the device lost its own: checked against its hash.
      const copy = isRecord(body.snapshot) ? body.snapshot : null;
      if (!copy || !isRecord(copy.values))
        throw new FwError(404, 'not_found', 'no such snapshot and no copy sent');
      const v = copy.values as Record<string, FirmwareValue | null>;
      if (firmwareSnapshotSha256(v) !== copy.sha256)
        throw new FwError(409, 'conflict', 'the snapshot copy does not match its hash', {
          reason: 'snapshot_mismatch',
        });
      values = v;
    }
    // Only keys that would change count; restoring Secure Boot or the TPM to off needs the flag.
    const changing = Object.fromEntries(
      Object.entries(values).filter(
        ([k, v]) => this.settings.has(k) && !sameFirmwareValue(this.settings.get(k)!.value, v),
      ),
    );
    if (this.#degrading(changing).length && body.allowSecurityDegrading !== true)
      throw new FwError(403, 'policy_denied', 'the restore weakens security', {
        reason: 'security_degrading',
      });
    if (this.#passwordWrong(body))
      throw new FwError(500, 'server_error', 'the firmware refused the admin password', {
        reason: 'rollback_failed',
        restored: true,
        key: Object.keys(changing)[0] ?? '',
      });
    return { restored: this.#restore(values) };
  }
}
