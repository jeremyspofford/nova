// Devices running `novad` (docs/23, docs/21 §7; contracts/hub-api.md §1 "Auth & devices", §3).
// The registry (enrollment with a one-use token, a pinned Ed25519 key, signed capability documents,
// heartbeats), the Hub's per-device overrides and policy (FR-142, FR-150), the minimum novad
// version per capability (FR-148), modules, services, power and Wake-on-LAN (FR-141, FR-144,
// FR-145), signed updates (FR-148), device file operations with folder-access requests and staged
// writes (FR-210), and an agent's one connected computer (FR-081). Every privileged action is
// audited (kind `device`); tool and file output from a device is untrusted (FR-189).
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEVICE_UPDATE_CHANNELS,
  NovaError,
  uuidv7,
  type AgentDeviceConnectionView,
  type DeviceAccessRequestView,
  type DeviceCapabilityName,
  type DeviceCapabilityOverrides,
  type DeviceCapabilityStatus,
  type DeviceDirent,
  type DeviceEnrollToken,
  type DeviceGrantee,
  type DeviceModuleView,
  type DevicePolicy,
  type DeviceUpdateBundle,
  type DeviceUpdateChannel,
  type DeviceUpdateView,
  type DeviceView,
  type DeviceWakeView,
  type StagedWriteView,
} from '@nova/shared';
import { contracts } from '@nova/contracts';
import { canonicalPath, pathAccess } from '@nova/policy';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink, Notifier } from '../tools/types.ts';
import type { ComputerExecResult, ComputerExecSpec } from '../computers/types.ts';
import { keyFingerprint, verifyDocument } from '../nodes/crypto.ts';
import { enrollBindingOf, type EnrollKeyBinding } from '../pairing/binding.ts';
import { callDevice, httpDeviceTransport, type DeviceTransport } from './client.ts';
import {
  DEVICE_CREDENTIAL_PREFIX,
  DEVICE_ENROLL_PREFIX,
  DEVICE_ENROLL_TTL_MS,
  DEVICE_HEARTBEAT_INTERVAL_MS,
  DEVICE_MISSED_BEATS,
  STAGE_TTL_MS,
  deviceCapabilitiesUpdateSchema,
  deviceHeartbeatSchema,
  moduleReportSchema,
  negotiateDeviceProtocol,
  registerDeviceSchema,
  wireRequestSchema,
  wireStagedSchema,
  type AccessDecision,
  type ModuleReport,
  type RegisterDeviceResponse,
  type WireRequest,
} from './protocol.ts';
import {
  deviceCapabilityStatuses,
  minimumNovadVersions,
  requireDeviceCapabilities,
} from './versions.ts';
import { parseMac, sendMagicPacket, type WolTarget } from './wol.ts';

const { addDeviceRequest, approval, authToken, device, deviceCapability, transportEndpoint } =
  schema;

type DeviceRow = typeof device.$inferSelect;
type SqlValue = string | number | null;

export type CapabilityValidator = (doc: unknown) => { ok: boolean; errors: string[] };

export interface DeviceSettings {
  /** `devices.minNovadVersions`: raises entries of the built-in table (FR-148). */
  minVersions?: () => Promise<Partial<Record<string, string>>>;
  /** `devices.wakesPerHour` (FR-144). */
  wakesPerHour?: () => Promise<number>;
}

export interface DeviceServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  log?: Logger;
  audit?: AuditSink;
  notifier?: Notifier;
  now?: () => Date;
  transport?: DeviceTransport;
  heartbeatIntervalMs?: number;
  missedBeats?: number;
  enrollTtlMs?: number;
  /** Defaults to contracts/schemas/device-capability.json. */
  validateCapability?: CapabilityValidator;
  settings?: DeviceSettings;
  /** Where magic packets go, and the sender (tests substitute both). */
  wol?: WolTarget & { send?: (mac: string, target: WolTarget) => Promise<void> };
  /** The update signing key devices pin at enrollment (FR-148); none configured by default. */
  updateKey?: () => Promise<string | null>;
  /** Management calls time out after this (default 30 s; exec adds its own timeout). */
  callTimeoutMs?: number;
  /** Whether an agent exists for the account (the agents area); any id passes without it. */
  agentExists?: (accountId: string, agentId: string) => Promise<boolean>;
}

/** Why the Hub reached into a device, for audit and events (thread, run, agent or session). */
export interface DeviceCallContext {
  actor?: string;
  threadId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  /** The turn and tool call an agent's device tool ran in (devices/tools.ts). */
  turnId?: string | null;
  callId?: string | null;
}

/**
 * Where a wake goes (FR-138; the network area's WakeHelperRouter): a Wake Helper that already
 * sent it, or the Hub's own broadcast (to `address` when given). It throws `conflict` with reason
 * `no_wake_helper` when neither reaches the target's LAN. Without a router the Hub broadcasts (M6).
 */
export interface DeviceWakeRouter {
  route(input: {
    accountId: string;
    deviceId: string;
    mac: string;
  }): Promise<{ via: 'helper'; helperDeviceId: string } | { via: 'hub'; address: string | null }>;
}

/** The vault reference of the token the Hub presents to a device (docs/12 §5). */
export function managementTokenRef(deviceId: string): string {
  return secretRef('devices', deviceId, 'management-token');
}

/** Hash of a device credential or enrollment token; its own domain, so it never matches a session. */
export function deviceSecretHash(token: string): string {
  return createHash('sha256').update('nova-novad\0').update(token, 'utf8').digest('hex');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function defaultValidator(): CapabilityValidator {
  const validate = contracts().validator('device-capability.json');
  return (doc) => {
    const r = validate(doc);
    return { ok: r.ok, errors: r.errors.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`) };
  };
}

/** The `device.kind` for a novad device: never `compute` (that stays the M2 node registration). */
function kindFor(roles: readonly string[]): DeviceRow['kind'] {
  if (roles.includes('hub')) return 'hub';
  if (roles.length > 0 && roles.every((r) => r === 'wake-helper')) return 'wake-helper';
  return 'client';
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => Number.parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether `now` (in `timeZone`) falls in one of the `HH:MM-HH:MM` ranges (may wrap midnight). */
export function inDeviceQuietHours(
  ranges: readonly string[],
  now: Date,
  timeZone?: string,
): boolean {
  if (ranges.length === 0) return false;
  let minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    minutes = h * 60 + m;
  } catch {
    // An unknown time zone: UTC.
  }
  return ranges.some((r) => {
    const [a, b] = r.split('-');
    if (!a || !b) return false;
    const start = minutesOf(a);
    const end = minutesOf(b);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  });
}

interface MgmtRow {
  device_id: string;
  protocol_version: number;
  update_channel: DeviceUpdateChannel;
  capability_overrides: string;
  policy: string;
  config_revision: number;
  pushed_revision: number;
  modules: string;
  power: string | null;
  updated_at: string;
}

interface GrantRow {
  id: string;
  account_id: string;
  device_id: string;
  grantee_kind: DeviceGrantee['kind'];
  grantee_ref: string;
  kind: 'folder' | 'mcp';
  target: string;
  access: 'read' | 'write' | 'call';
  status: DeviceAccessRequestView['status'];
  device_request_id: string | null;
  device_grant_id: string | null;
  approval_id: string | null;
  reason: string | null;
  decided_by: 'device' | 'hub' | null;
  created_at: string;
  decided_at: string | null;
}

interface StagedRow {
  id: string;
  account_id: string;
  device_id: string;
  device_stage_id: string;
  grantee_kind: DeviceGrantee['kind'];
  grantee_ref: string;
  session_ref: string;
  path: string;
  base_sha256: string | null;
  new_sha256: string;
  size: number;
  blob_path: string;
  diff: string;
  additions: number;
  deletions: number;
  binary: number;
  status: StagedWriteView['status'];
  approval_id: string | null;
  error: string | null;
  created_at: string;
  committed_at: string | null;
}

interface ConnectionRow {
  id: string;
  account_id: string;
  agent_id: string;
  device_id: string;
  capabilities: string;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

interface UpdateRow {
  id: string;
  device_id: string;
  target: string;
  from_version: string | null;
  to_version: string;
  channel: DeviceUpdateChannel;
  status: DeviceUpdateView['status'];
  detail: string | null;
  created_at: string;
}

/** A device the Hub can call. */
export interface ManagedDevice {
  row: DeviceRow;
  mgmt: MgmtRow;
  endpoint: string | null;
  document: Record<string, unknown>;
}

export type ConnectionHook = (
  accountId: string,
  c: { deviceId: string; agentId: string; status: 'active' | 'revoked' },
) => Promise<void>;

const CONNECTION_CAPABILITY: Record<string, DeviceCapabilityName> = {
  files: 'files',
  staged_writes: 'staged_writes',
  exec: 'exec',
  mcp: 'mcp',
  computer_use: 'computer_use',
  browser: 'browser',
};

export class DeviceService {
  readonly heartbeatIntervalMs: number;
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #log: Logger;
  #audit: AuditSink | null;
  #notifier: Notifier | null;
  readonly #now: () => Date;
  readonly #transport: DeviceTransport;
  readonly #missedBeats: number;
  readonly #enrollTtlMs: number;
  readonly #validate: CapabilityValidator;
  readonly #settings: DeviceSettings;
  readonly #wol: WolTarget & { send?: (mac: string, target: WolTarget) => Promise<void> };
  readonly #updateKey: () => Promise<string | null>;
  readonly #callTimeoutMs: number;
  #agentExists: ((accountId: string, agentId: string) => Promise<boolean>) | null;
  #wakeRouter: DeviceWakeRouter | null = null;
  readonly #connectionHooks = new Set<ConnectionHook>();
  readonly #revokeHooks = new Set<(accountId: string, deviceId: string) => void | Promise<void>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #pushing = new Set<string>();

  constructor(opts: DeviceServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#log = opts.log ?? new Logger({ module: 'core.devices', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#transport = opts.transport ?? httpDeviceTransport;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEVICE_HEARTBEAT_INTERVAL_MS;
    this.#missedBeats = opts.missedBeats ?? DEVICE_MISSED_BEATS;
    this.#enrollTtlMs = opts.enrollTtlMs ?? DEVICE_ENROLL_TTL_MS;
    this.#validate = opts.validateCapability ?? defaultValidator();
    this.#settings = opts.settings ?? {};
    this.#wol = opts.wol ?? {};
    this.#updateKey = opts.updateKey ?? (() => Promise.resolve(null));
    this.#callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.#agentExists = opts.agentExists ?? null;
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  useNotifier(notifier: Notifier): void {
    this.#notifier = notifier;
  }

  useAgents(exists: (accountId: string, agentId: string) => Promise<boolean>): void {
    this.#agentExists = exists;
  }

  /** Route wakes through Wake Helpers (FR-138; the network area). */
  useWakeRouter(router: DeviceWakeRouter | null): void {
    this.#wakeRouter = router;
  }

  /**
   * Called after a device is revoked (Add Device deletes its sessions and blocks its key,
   * docs/22 §4.5). A failing hook is logged and does not undo the revocation.
   */
  onRevoked(hook: (accountId: string, deviceId: string) => void | Promise<void>): () => void {
    this.#revokeHooks.add(hook);
    return () => this.#revokeHooks.delete(hook);
  }

  /** Called when an agent's connection starts or ends (the computers area registers its row). */
  onConnectionChanged(hook: ConnectionHook): () => void {
    this.#connectionHooks.add(hook);
    return () => this.#connectionHooks.delete(hook);
  }

  async #connectionChanged(
    accountId: string,
    c: { deviceId: string; agentId: string; status: 'active' | 'revoked' },
  ): Promise<void> {
    for (const hook of this.#connectionHooks) {
      try {
        await hook(accountId, c);
      } catch (err) {
        this.#log.warn('connection hook failed', { err });
      }
    }
  }

  /** The agent a computer row of the computers area names, when it does (read only). */
  computerAgent(computerId: string): string | null {
    try {
      const row = this.#get<{ agent_id: string | null }>(
        'SELECT agent_id FROM computer WHERE id = ?',
        computerId,
      );
      return row?.agent_id ?? null;
    } catch {
      return null;
    }
  }

  // ---- small SQL helpers (0024 tables) -----------------------------------------------------

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
    resource: string | null,
    detail: Record<string, unknown>,
    ctx: DeviceCallContext = {},
    extra: { decision?: string; result?: string; inputHash?: string } = {},
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: ctx.actor ?? 'user',
        kind: 'device',
        action,
        resource,
        threadId: ctx.threadId ?? null,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        detail: ctx.callId ? { ...detail, callId: ctx.callId } : detail,
        ...(extra.decision ? { decision: extra.decision } : {}),
        ...(extra.result ? { result: extra.result } : {}),
        ...(extra.inputHash ? { inputHash: extra.inputHash } : {}),
      });
    } catch (err) {
      this.#log.warn('device audit failed', { err, action });
    }
  }

  async #emit(
    name: string,
    accountId: string,
    payload: Record<string, unknown>,
    ctx: DeviceCallContext = {},
  ): Promise<void> {
    const correlation: Record<string, string> = {};
    if (ctx.threadId) correlation.threadId = ctx.threadId;
    if (ctx.runId) correlation.runId = ctx.runId;
    if (ctx.agentId) correlation.agentId = ctx.agentId;
    if (ctx.sessionId) correlation.sessionId = ctx.sessionId;
    if (ctx.turnId) correlation.turnId = ctx.turnId;
    if (ctx.callId) correlation.callId = ctx.callId;
    const actor = ctx.actor && /^(user|system|agent:.+)$/.test(ctx.actor) ? ctx.actor : 'system';
    await this.#events.emit({
      name,
      accountId,
      actor,
      payload,
      ...(Object.keys(correlation).length ? { correlation } : {}),
    });
  }

  // ---- enrollment and the novad → Hub routes -------------------------------------------------

  /**
   * A one-use enrollment token (`nvd_…`, 15 min). Creating it is the owner's approval. Add Device
   * binds it to the device key and the pending record its approval created (FR-132): register
   * must then present that key and activates that record.
   */
  async createEnrollToken(
    accountId: string,
    roles: readonly string[],
    hubUrl: string,
    bind?: EnrollKeyBinding,
  ): Promise<DeviceEnrollToken> {
    const token = DEVICE_ENROLL_PREFIX + randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#enrollTtlMs).toISOString();
    const primary = (roles.find((r) => r !== 'compute') ?? 'client') as 'client' | 'wake-helper';
    await this.#db.transaction(() =>
      this.#db.orm.insert(addDeviceRequest).values({
        id: uuidv7(),
        accountId,
        role: primary,
        codeHash: deviceSecretHash(token),
        scopes: JSON.stringify({ novad: true, roles, ...(bind ? { bind } : {}) }),
        status: 'pending',
        expiresAt,
        createdAt: now.toISOString(),
      }),
    );
    const roleArgs = roles.map((r) => ` --role ${r}`).join('');
    return {
      token,
      expiresAt,
      command: `novad enroll --hub ${hubUrl} --token ${token}${roleArgs} --endpoint http://<this-device>:7420`,
    };
  }

  /** novad registers (`POST /agent/v1/register`). The token is burned even when this fails. */
  async register(input: unknown): Promise<RegisterDeviceResponse> {
    const body = registerDeviceSchema.parse(input);
    const protocolVersion = negotiateDeviceProtocol(body.protocolVersions);
    const request = await this.#consumeEnrollToken(body.enrollToken);
    const requested = parseJson<{ roles?: string[] }>(request.scopes, {}).roles ?? [request.role];
    const bind = enrollBindingOf(request.scopes);
    const nowIso = this.#iso();
    const deviceId = bind?.deviceId ?? uuidv7();
    const credential = DEVICE_CREDENTIAL_PREFIX + randomBytes(32).toString('base64url');
    const ref = managementTokenRef(deviceId);
    const fingerprint = keyFingerprint(body.publicKey);
    const docRoles = Array.isArray(body.capability.roles)
      ? body.capability.roles.filter((r): r is string => typeof r === 'string')
      : [];
    // Only roles the owner approved: a device's own document may narrow them, never widen them
    // (a client claiming `wake-helper` or `hub` would otherwise get it; review finding 3).
    const declared = [...new Set(docRoles.filter((r) => requested.includes(r)))];
    const roles = declared.length ? declared : [...new Set(requested)];
    let name = body.name;
    try {
      // A token from Add Device works only with the key the owner approved (FR-132).
      if (bind && bind.publicKey !== body.publicKey) {
        throw new NovaError(
          'policy_denied',
          'this enrollment token belongs to another device key',
          {
            details: { reason: 'key_mismatch' },
            action: 'Register with the key you added the device with',
          },
        );
      }
      this.#checkDocument(body.capability, body.signature, body.publicKey);
      await this.#secrets.put(ref, body.managementToken);
      await this.#db.transaction(async () => {
        const taken = await this.#db.orm
          .select()
          .from(device)
          .where(eq(device.certFingerprint, fingerprint))
          .limit(1);
        const pending = taken[0];
        if (bind) {
          // The record approval created waits for exactly this key; a revoked one stays dead.
          if (
            !pending ||
            pending.id !== bind.deviceId ||
            pending.accountId !== request.accountId ||
            pending.status !== 'pending'
          ) {
            throw new NovaError('conflict', 'the device this token was made for is not waiting', {
              details: { reason: 'device_not_pending' },
              action: 'Add the device again',
            });
          }
        } else if (pending) {
          throw new NovaError('conflict', 'this device key is already registered', {
            details: { reason: 'key_in_use' },
            action: 'Enroll with a new key',
          });
        }
        const tokenId = uuidv7();
        await this.#db.orm.insert(authToken).values({
          id: tokenId,
          kind: 'device',
          tokenHash: deviceSecretHash(credential),
          accountId: request.accountId,
          label: body.name,
          scopes: JSON.stringify(['novad']),
          createdAt: nowIso,
        });
        if (bind && pending) {
          // The name and scopes the owner approved stay.
          name = pending.name;
          await this.#db.orm
            .update(device)
            .set({
              kind: kindFor(roles),
              platform: platformOf(body.capability),
              roles: JSON.stringify(roles),
              status: 'active',
              novadVersion: body.novadVersion,
              credentialTokenId: tokenId,
              lastSeenAt: nowIso,
              updatedAt: nowIso,
            })
            .where(eq(device.id, deviceId));
        } else {
          await this.#db.orm.insert(device).values({
            id: deviceId,
            accountId: request.accountId,
            name: body.name,
            kind: kindFor(roles),
            platform: platformOf(body.capability),
            certFingerprint: fingerprint,
            publicKey: body.publicKey,
            roles: JSON.stringify(roles),
            scopes: JSON.stringify([]),
            status: 'active',
            novadVersion: body.novadVersion,
            credentialTokenId: tokenId,
            lastSeenAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
        await this.#db.orm.insert(deviceCapability).values({
          deviceId,
          document: JSON.stringify(body.capability),
          updatedAt: nowIso,
        });
        await this.#db.orm.insert(transportEndpoint).values({
          id: uuidv7(),
          deviceId,
          net: 'lan',
          url: body.endpoint.replace(/\/+$/, ''),
          healthy: true,
          lastCheckedAt: nowIso,
          createdAt: nowIso,
        });
        this.#run(
          `INSERT INTO device_management (device_id, protocol_version, update_channel, updated_at)
           VALUES (?, ?, ?, ?)`,
          deviceId,
          protocolVersion,
          channelOf(body.capability),
          nowIso,
        );
      });
    } catch (err) {
      await this.#secrets.delete(ref).catch(() => false);
      await this.#db
        .transaction(() =>
          this.#db.orm
            .update(addDeviceRequest)
            .set({ status: 'denied' })
            .where(eq(addDeviceRequest.id, request.id)),
        )
        .catch(() => undefined);
      throw err;
    }
    await this.#emit('device.registered', request.accountId, {
      deviceId,
      name,
      roles,
      novadVersion: body.novadVersion,
    });
    await this.#auditAppend(
      request.accountId,
      'device.register',
      deviceId,
      {
        name,
        roles,
        novadVersion: body.novadVersion,
        fingerprint,
        ...(bind ? { addDevice: true } : {}),
      },
      { actor: 'system' },
    );
    this.#log.info('device registered', { deviceId, name });
    return {
      deviceId,
      credential,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      protocolVersion,
      updateChannel: channelOf(body.capability),
      updateKey: await this.#updateKey(),
    };
  }

  async #consumeEnrollToken(token: string) {
    return this.#db.transaction(async () => {
      const rows = await this.#db.orm
        .select()
        .from(addDeviceRequest)
        .where(eq(addDeviceRequest.codeHash, deviceSecretHash(token)))
        .limit(1);
      const row = rows[0];
      const nowIso = this.#iso();
      if (!row || row.status !== 'pending' || row.expiresAt <= nowIso) {
        throw new NovaError('auth_missing', 'the enrollment token is invalid, used or expired', {
          action: 'Create a new device token on the Hub',
        });
      }
      await this.#db.orm
        .update(addDeviceRequest)
        .set({ status: 'approved' })
        .where(eq(addDeviceRequest.id, row.id));
      return row;
    });
  }

  /** Schema and signature checks shared by register and capability updates. */
  #checkDocument(doc: Record<string, unknown>, signature: string, publicKey: string): void {
    const v = this.#validate(doc);
    if (!v.ok) {
      throw new NovaError('validation', 'the capability document is not valid', {
        details: { reason: 'invalid_capability', errors: v.errors.slice(0, 20) },
      });
    }
    if (!verifyDocument(doc, signature, publicKey)) {
      throw new NovaError('policy_denied', 'the capability document signature does not verify', {
        details: { reason: 'bad_signature' },
      });
    }
  }

  /** The novad device a credential belongs to, or null. */
  async authenticate(credential: string): Promise<DeviceRow | null> {
    if (!credential.startsWith(DEVICE_CREDENTIAL_PREFIX) || credential.length > 200) return null;
    const rows = await this.#db.orm
      .select({ device })
      .from(authToken)
      .innerJoin(device, eq(device.credentialTokenId, authToken.id))
      .where(
        and(
          eq(authToken.tokenHash, deviceSecretHash(credential)),
          eq(authToken.kind, 'device'),
          isNull(authToken.revokedAt),
          ne(device.status, 'revoked'),
        ),
      )
      .limit(1);
    return rows[0]?.device ?? null;
  }

  async #requireDevice(credential: string): Promise<DeviceRow> {
    const d = await this.authenticate(credential);
    if (!d || !this.#mgmt(d.id)) {
      throw new NovaError('auth_missing', 'this device credential is not valid', {
        action: 'Enroll the device again',
      });
    }
    return d;
  }

  /** `POST /agent/v1/heartbeat`: liveness, module reports, events, device-side decisions. */
  async heartbeat(
    credential: string,
    input: unknown,
  ): Promise<{ ok: true; heartbeatIntervalMs: number; capabilityRequested: boolean }> {
    const d = await this.#requireDevice(credential);
    const body = deviceHeartbeatSchema.parse(input);
    const nowIso = this.#iso();
    const mgmt = this.#mgmt(d.id)!;
    const before = parseJson<ModuleReport[]>(mgmt.modules, []);
    const from = d.status;
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(device)
        .set({
          status: 'active',
          lastSeenAt: nowIso,
          updatedAt: nowIso,
          novadVersion: body.novadVersion,
        })
        .where(eq(device.id, d.id));
      await this.#db.orm
        .update(transportEndpoint)
        .set({ healthy: true, lastCheckedAt: nowIso })
        .where(eq(transportEndpoint.deviceId, d.id));
      this.#run(
        `UPDATE device_management SET modules = ?, power = COALESCE(?, power), updated_at = ?
         WHERE device_id = ?`,
        JSON.stringify(body.modules),
        body.power ? JSON.stringify(body.power) : null,
        nowIso,
        d.id,
      );
    });
    if (from !== 'active') await this.#statusChanged(d, from, 'active');
    if (d.novadVersion !== body.novadVersion) {
      await this.#emit('device.capabilities.changed', d.accountId, {
        deviceId: d.id,
        novadVersion: body.novadVersion,
        previousVersion: d.novadVersion,
      });
    }
    await this.#moduleEvents(d, before, body.modules, body.events);
    for (const decision of body.accessDecisions) await this.#deviceDecided(d, decision);
    if (mgmt.config_revision > mgmt.pushed_revision) this.#pushConfigSoon(d.accountId, d.id);
    this.#passDecisionsSoon(d);
    return {
      ok: true,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      capabilityRequested: d.novadVersion !== body.novadVersion,
    };
  }

  /** `POST /agent/v1/capabilities`: a re-signed document; it must verify against the pinned key. */
  async updateCapabilities(credential: string, input: unknown): Promise<void> {
    const d = await this.#requireDevice(credential);
    const body = deviceCapabilitiesUpdateSchema.parse(input);
    this.#checkDocument(body.capability, body.signature, d.publicKey);
    const current = this.#document(d.id);
    if (current.deviceId && current.deviceId !== body.capability.deviceId) {
      throw new NovaError('validation', 'the capability document names a different device', {
        details: { reason: 'device_mismatch' },
      });
    }
    await this.#storeDocument(d, body.capability, body.novadVersion);
  }

  async #storeDocument(d: DeviceRow, doc: Record<string, unknown>, version: string | null) {
    const nowIso = this.#iso();
    const before = this.#document(d.id);
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(deviceCapability)
        .set({ document: JSON.stringify(doc), updatedAt: nowIso })
        .where(eq(deviceCapability.deviceId, d.id));
      await this.#db.orm
        .update(device)
        .set({
          platform: platformOf(doc),
          updatedAt: nowIso,
          ...(version ? { novadVersion: version } : {}),
        })
        .where(eq(device.id, d.id));
    });
    const modulesBefore = JSON.stringify(before.modules ?? []);
    if (
      modulesBefore !== JSON.stringify(doc.modules ?? []) ||
      (version && version !== d.novadVersion)
    ) {
      await this.#emit('device.capabilities.changed', d.accountId, {
        deviceId: d.id,
        novadVersion: version ?? d.novadVersion,
        modules: Array.isArray(doc.modules) ? doc.modules : [],
      });
    }
  }

  async #statusChanged(d: DeviceRow, from: string, status: string): Promise<void> {
    await this.#emit('device.status.changed', d.accountId, { deviceId: d.id, from, status });
  }

  async #moduleEvents(
    d: DeviceRow,
    before: ModuleReport[],
    after: ModuleReport[],
    events: Record<string, unknown>[],
  ): Promise<void> {
    for (const e of events) {
      if (e.kind === 'update' && isRecord(e.update)) {
        const u = e.update;
        if (u.target === 'novad' && typeof u.to === 'string') {
          await this.#recordUpdate(d, {
            target: 'novad',
            from: typeof u.from === 'string' ? u.from : null,
            to: u.to,
            channel: this.#mgmt(d.id)?.update_channel ?? 'stable',
            status: u.status === 'applied' ? 'applied' : 'rolled_back',
            detail: null,
          });
        }
        continue;
      }
      if (typeof e.module !== 'string' || typeof e.kind !== 'string') continue;
      const report = after.find((m) => m.name === e.module);
      await this.#emit('device.module.changed', d.accountId, {
        deviceId: d.id,
        module: e.module.slice(0, 50),
        kind: e.kind.slice(0, 50),
        state: report?.state ?? null,
        restarts: report?.restarts ?? null,
        exit: typeof e.exit === 'string' ? e.exit.slice(0, 200) : null,
        reason: typeof e.reason === 'string' ? e.reason.slice(0, 100) : null,
      });
      if (e.kind === 'crashed' || e.kind === 'disabled') {
        await this.#auditAppend(
          d.accountId,
          `device.module.${e.kind}`,
          d.id,
          { module: e.module, exit: e.exit ?? null, reason: e.reason ?? null },
          { actor: 'system' },
        );
      }
    }
    // A state change without an event (the Hub missed beats) is still reported.
    for (const m of after) {
      const prev = before.find((x) => x.name === m.name);
      const evented = events.some((e) => e.module === m.name);
      if (prev && prev.state !== m.state && !evented) {
        await this.#emit('device.module.changed', d.accountId, {
          deviceId: d.id,
          module: m.name,
          kind: 'state',
          state: m.state,
          restarts: m.restarts,
          exit: m.lastExit ?? null,
          reason: m.disabledReason ?? null,
        });
      }
    }
  }

  /** Mark devices that missed their heartbeats unreachable and expire old stages. */
  async sweep(): Promise<string[]> {
    const now = this.#now();
    const cutoff = new Date(
      now.getTime() - this.#missedBeats * this.heartbeatIntervalMs,
    ).toISOString();
    const stale = this.#all<{ id: string }>(
      `SELECT d.id FROM device d JOIN device_management m ON m.device_id = d.id
       WHERE d.status = 'active' AND (d.last_seen_at IS NULL OR d.last_seen_at < ?)`,
      cutoff,
    ).map((r) => r.id);
    const stageCutoff = new Date(now.getTime() - STAGE_TTL_MS).toISOString();
    await this.#db.transaction(() => {
      for (const id of stale) {
        this.#run(
          "UPDATE device SET status = 'unreachable', updated_at = ? WHERE id = ? AND status = 'active'",
          now.toISOString(),
          id,
        );
        this.#run(
          'UPDATE transport_endpoint SET healthy = 0, last_checked_at = ? WHERE device_id = ?',
          now.toISOString(),
          id,
        );
      }
      this.#run(
        "UPDATE staged_write SET status = 'expired' WHERE status = 'staged' AND created_at < ?",
        stageCutoff,
      );
    });
    for (const id of stale) {
      const row = await this.#row(id);
      if (row) await this.#statusChanged(row, 'active', 'unreachable');
    }
    return stale;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.#log.warn('device sweep failed', { err }));
    }, this.heartbeatIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- reading the registry ----------------------------------------------------------------

  #mgmt(deviceId: string): MgmtRow | undefined {
    return this.#get<MgmtRow>('SELECT * FROM device_management WHERE device_id = ?', deviceId);
  }

  #document(deviceId: string): Record<string, unknown> {
    const row = this.#get<{ document: string }>(
      'SELECT document FROM device_capability WHERE device_id = ?',
      deviceId,
    );
    const doc = parseJson<unknown>(row?.document, {});
    return isRecord(doc) ? doc : {};
  }

  async #row(id: string): Promise<DeviceRow | undefined> {
    const rows = await this.#db.orm.select().from(device).where(eq(device.id, id)).limit(1);
    return rows[0];
  }

  #endpoint(deviceId: string): string | null {
    return (
      this.#get<{ url: string }>(
        "SELECT url FROM transport_endpoint WHERE device_id = ? AND net = 'lan' LIMIT 1",
        deviceId,
      )?.url ?? null
    );
  }

  /** A novad device of the account (any status), or `not_found`. */
  async device(accountId: string, deviceId: string): Promise<ManagedDevice> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(and(eq(device.id, deviceId), eq(device.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    const mgmt = row ? this.#mgmt(row.id) : undefined;
    if (!row || !mgmt) throw new NovaError('not_found', 'device not found');
    return { row, mgmt, endpoint: this.#endpoint(row.id), document: this.#document(row.id) };
  }

  async #minimums() {
    return minimumNovadVersions((await this.#settings.minVersions?.()) ?? {});
  }

  /** Each capability with whether this device can serve it (FR-148). */
  async capabilities(accountId: string, deviceId: string): Promise<DeviceCapabilityStatus[]> {
    return this.#statuses(await this.device(accountId, deviceId));
  }

  async #statuses(d: ManagedDevice): Promise<DeviceCapabilityStatus[]> {
    const policy = parseJson<DevicePolicy>(d.mgmt.policy, {});
    const modules = Array.isArray(d.document.modules)
      ? d.document.modules.filter((m): m is string => typeof m === 'string')
      : [];
    return deviceCapabilityStatuses({
      novadVersion: d.row.novadVersion,
      modules,
      allowedModules: policy.allowedModules ?? null,
      minimums: await this.#minimums(),
    });
  }

  /** A reachable device that can serve `caps`; `capability_missing` / `node_unavailable` otherwise. */
  async #usable(
    accountId: string,
    deviceId: string,
    caps: readonly DeviceCapabilityName[],
  ): Promise<ManagedDevice & { endpoint: string }> {
    const d = await this.device(accountId, deviceId);
    if (d.row.status === 'revoked') throw new NovaError('not_found', 'device not found');
    if (d.row.status !== 'active' || !d.endpoint) {
      throw new NovaError('node_unavailable', 'the device is not reachable', {
        details: { reason: 'unreachable', status: d.row.status },
      });
    }
    requireDeviceCapabilities(await this.#statuses(d), caps, d.row.novadVersion);
    return { ...d, endpoint: d.endpoint };
  }

  async #call<T = Record<string, unknown>>(
    d: { row: DeviceRow; endpoint: string },
    path: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const token = await this.#secrets.get(managementTokenRef(d.row.id));
    if (!token)
      throw new NovaError('auth_missing', 'the Hub has no management token for this device');
    return callDevice<T>(
      this.#transport,
      d.endpoint,
      token,
      path,
      body,
      timeoutMs ?? this.#callTimeoutMs,
    );
  }

  async list(accountId: string): Promise<DeviceView[]> {
    const ids = this.#all<{ id: string }>(
      `SELECT d.id FROM device d JOIN device_management m ON m.device_id = d.id
       WHERE d.account_id = ? ORDER BY d.created_at, d.id`,
      accountId,
    );
    const out: DeviceView[] = [];
    for (const { id } of ids) out.push(await this.get(accountId, id));
    return out;
  }

  async get(accountId: string, deviceId: string): Promise<DeviceView> {
    const d = await this.device(accountId, deviceId);
    return this.#view(d);
  }

  async #view(d: ManagedDevice): Promise<DeviceView> {
    const statuses = await this.#statuses(d);
    const policy = parseJson<DevicePolicy>(d.mgmt.policy, {});
    const reports = parseJson<unknown[]>(d.mgmt.modules, [])
      .map((m) => moduleReportSchema.safeParse(m))
      .flatMap((r) => (r.success ? [moduleView(r.data)] : []));
    const power = isRecord(d.document.power) ? d.document.power : {};
    const nic =
      isRecord(d.document.hardware) && isRecord(d.document.hardware.nic)
        ? d.document.hardware.nic
        : {};
    const macs = Array.isArray(nic.macs)
      ? nic.macs.filter((m): m is string => typeof m === 'string')
      : [];
    return {
      id: d.row.id,
      name: d.row.name,
      roles: parseJson<string[]>(d.row.roles, []),
      status: d.row.status,
      platform: d.row.platform,
      novadVersion: d.row.novadVersion,
      updateChannel: d.mgmt.update_channel,
      endpoint: d.endpoint,
      capability: Object.keys(d.document).length ? d.document : null,
      capabilities: statuses,
      updateRequired: statuses.some((s) => s.reason === 'update_required'),
      capabilityOverrides: parseJson<DeviceCapabilityOverrides>(d.mgmt.capability_overrides, {}),
      policy,
      configPending: d.mgmt.config_revision > d.mgmt.pushed_revision,
      routingEligible: policy.routingEligible !== false,
      modules: reports,
      wake: { wakeable: power.wakeable === true && macs.length > 0, macs },
      lastSeenAt: d.row.lastSeenAt,
      createdAt: d.row.createdAt,
    };
  }

  // ---- overrides and policy (FR-142, FR-150) ------------------------------------------------

  /** Edit the name, overrides, policy or update channel; the device takes them at once or on its next heartbeat. */
  async update(
    accountId: string,
    deviceId: string,
    patch: {
      name?: string;
      capabilityOverrides?: DeviceCapabilityOverrides;
      policy?: DevicePolicy;
      updateChannel?: DeviceUpdateChannel;
    },
    ctx: DeviceCallContext = {},
  ): Promise<DeviceView> {
    const d = await this.device(accountId, deviceId);
    if (d.row.status === 'revoked') throw new NovaError('conflict', 'the device was revoked');
    const nowIso = this.#iso();
    const configChanged =
      patch.capabilityOverrides !== undefined ||
      patch.policy !== undefined ||
      patch.updateChannel !== undefined;
    await this.#db.transaction(async () => {
      if (patch.name !== undefined) {
        await this.#db.orm
          .update(device)
          .set({ name: patch.name, updatedAt: nowIso })
          .where(eq(device.id, deviceId));
      }
      if (configChanged) {
        const policy = patch.policy
          ? { ...parseJson<DevicePolicy>(d.mgmt.policy, {}), ...patch.policy }
          : parseJson<DevicePolicy>(d.mgmt.policy, {});
        this.#run(
          `UPDATE device_management SET capability_overrides = ?, policy = ?, update_channel = ?,
             config_revision = config_revision + 1, updated_at = ? WHERE device_id = ?`,
          JSON.stringify(patch.capabilityOverrides ?? parseJson(d.mgmt.capability_overrides, {})),
          JSON.stringify(policy),
          patch.updateChannel ?? d.mgmt.update_channel,
          nowIso,
          deviceId,
        );
      }
    });
    let pushed = false;
    if (configChanged) {
      pushed = await this.pushConfig(accountId, deviceId).catch((err: unknown) => {
        this.#log.info('device config pushed later', { deviceId, err });
        return false;
      });
      await this.#emit('device.overrides.changed', accountId, { deviceId, pushed }, ctx);
    }
    await this.#auditAppend(
      accountId,
      'device.update',
      deviceId,
      {
        fields: Object.keys(patch),
        pushed,
      },
      ctx,
    );
    return this.get(accountId, deviceId);
  }

  /** Send the Hub's overrides and policy; store the re-signed document it answers with. */
  async pushConfig(accountId: string, deviceId: string): Promise<boolean> {
    const d = await this.device(accountId, deviceId);
    if (d.row.status !== 'active' || !d.endpoint) return false;
    const revision = d.mgmt.config_revision;
    const res = await this.#call<{ capability?: unknown; signature?: unknown; revision?: unknown }>(
      { row: d.row, endpoint: d.endpoint },
      '/agent/v1/config',
      {
        capabilityOverrides: parseJson(d.mgmt.capability_overrides, {}),
        policy: parseJson(d.mgmt.policy, {}),
        updateChannel: d.mgmt.update_channel,
        revision,
      },
    );
    if (isRecord(res.capability) && typeof res.signature === 'string') {
      this.#checkDocument(res.capability, res.signature, d.row.publicKey);
      await this.#storeDocument(d.row, res.capability, null);
    }
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE device_management SET pushed_revision = MAX(pushed_revision, ?) WHERE device_id = ?',
        revision,
        deviceId,
      );
    });
    return true;
  }

  #pushConfigSoon(accountId: string, deviceId: string): void {
    if (this.#pushing.has(deviceId)) return;
    this.#pushing.add(deviceId);
    setTimeout(() => {
      this.pushConfig(accountId, deviceId)
        .catch((err: unknown) => this.#log.info('device config push failed', { deviceId, err }))
        .finally(() => this.#pushing.delete(deviceId));
    }, 0).unref();
  }

  /** Approval answers the device has not heard yet (it was unreachable when the user decided). */
  #passDecisionsSoon(d: DeviceRow): void {
    const waiting = this.#all<{ approval_id: string; decision: string }>(
      `SELECT g.approval_id, a.decision FROM device_grant g JOIN approval a ON a.id = g.approval_id
       WHERE g.device_id = ? AND g.status = 'pending' AND a.status = 'decided' AND a.decision IS NOT NULL
         AND (a.decided_by IS NULL OR a.decided_by NOT LIKE 'device:%')`,
      d.id,
    );
    if (!waiting.length) return;
    setTimeout(() => {
      void (async () => {
        for (const w of waiting) {
          await this.onApprovalDecided(d.accountId, w.approval_id, w.decision).catch(
            (err: unknown) => this.#log.warn('passing an access decision failed', { err }),
          );
        }
      })();
    }, 0).unref();
  }

  /** Routing eligibility and quiet hours as the Hub applies them (FR-150). */
  async policyOf(
    accountId: string,
    deviceId: string,
  ): Promise<DevicePolicy & { timeZone?: string }> {
    const d = await this.device(accountId, deviceId);
    const policy = parseJson<DevicePolicy>(d.mgmt.policy, {});
    const locale = isRecord(d.document.locale) ? d.document.locale : {};
    return {
      ...policy,
      ...(typeof locale.timezone === 'string' ? { timeZone: locale.timezone } : {}),
    };
  }

  /** Revoke: the credential and management token go, connections end, the device stops on its next call. */
  async revoke(accountId: string, deviceId: string, ctx: DeviceCallContext = {}): Promise<void> {
    const d = await this.device(accountId, deviceId);
    if (d.row.status === 'revoked') return;
    const nowIso = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(device)
        .set({ status: 'revoked', credentialTokenId: null, updatedAt: nowIso })
        .where(eq(device.id, deviceId));
      if (d.row.credentialTokenId)
        await this.#db.orm.delete(authToken).where(eq(authToken.id, d.row.credentialTokenId));
      await this.#db.orm
        .update(transportEndpoint)
        .set({ healthy: false, lastCheckedAt: nowIso })
        .where(eq(transportEndpoint.deviceId, deviceId));
      this.#run(
        "UPDATE agent_device_connection SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'",
        nowIso,
        deviceId,
      );
      this.#run(
        "UPDATE device_grant SET status = 'revoked', decided_at = ? WHERE device_id = ? AND status IN ('pending', 'granted')",
        nowIso,
        deviceId,
      );
    });
    await this.#secrets.delete(managementTokenRef(deviceId));
    await this.#statusChanged(d.row, d.row.status, 'revoked');
    await this.#auditAppend(accountId, 'device.revoke', deviceId, { name: d.row.name }, ctx);
    for (const hook of this.#revokeHooks) {
      try {
        await hook(accountId, deviceId);
      } catch (err) {
        this.#log.warn('revoke hook failed', { err });
      }
    }
  }

  // ---- modules, services, power, wake (FR-141, FR-144, FR-145, FR-150) -----------------------

  async moduleAction(
    accountId: string,
    deviceId: string,
    module: string,
    action: 'start' | 'stop' | 'restart' | 'rollback',
    ctx: DeviceCallContext = {},
  ): Promise<DeviceModuleView> {
    const d = await this.#usable(accountId, deviceId, ['services']);
    const policy = parseJson<DevicePolicy>(d.mgmt.policy, {});
    if (
      action !== 'stop' &&
      policy.allowedModules &&
      !policy.allowedModules.includes(module as never)
    ) {
      throw new NovaError('policy_denied', `the ${module} module is not allowed on this device`, {
        details: { reason: 'module_not_allowed', module },
      });
    }
    const res = await this.#call<{ module?: unknown }>(
      d,
      `/agent/v1/modules/${encodeURIComponent(module)}/${action}`,
      {},
    );
    const raw = action === 'rollback' ? await this.#moduleStatus(d, module) : res.module;
    const parsed = moduleReportSchema.safeParse(raw);
    if (!parsed.success)
      throw new NovaError('server_error', 'the device answered an unexpected module status');
    await this.#rememberModule(deviceId, parsed.data);
    await this.#emit(
      'device.module.changed',
      accountId,
      {
        deviceId,
        module,
        kind: action,
        state: parsed.data.state,
        restarts: parsed.data.restarts,
        exit: parsed.data.lastExit ?? null,
        reason: parsed.data.disabledReason ?? null,
      },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      `device.module.${action}`,
      deviceId,
      { module, state: parsed.data.state },
      ctx,
    );
    return moduleView(parsed.data);
  }

  async #moduleStatus(d: { row: DeviceRow; endpoint: string }, module: string): Promise<unknown> {
    const s = await this.#call<{ modules?: unknown[] }>(d, '/agent/v1/status', {});
    return (s.modules ?? []).find((m) => isRecord(m) && m.name === module);
  }

  async #rememberModule(deviceId: string, report: ModuleReport): Promise<void> {
    const mgmt = this.#mgmt(deviceId);
    if (!mgmt) return;
    const list = parseJson<ModuleReport[]>(mgmt.modules, []).filter((m) => m.name !== report.name);
    list.push(report);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE device_management SET modules = ? WHERE device_id = ?',
        JSON.stringify(list),
        deviceId,
      );
    });
  }

  async serviceAction(
    accountId: string,
    deviceId: string,
    service: string,
    action: 'start' | 'stop' | 'restart' | 'status',
    ctx: DeviceCallContext = {},
  ): Promise<Record<string, unknown>> {
    const d = await this.#usable(accountId, deviceId, ['services']);
    const res = await this.#call<{ service?: unknown }>(
      d,
      `/agent/v1/services/${encodeURIComponent(service)}/${action}`,
      {},
    );
    const svc = isRecord(res.service) ? res.service : {};
    if (action !== 'status') {
      await this.#emit(
        'device.service.changed',
        accountId,
        {
          deviceId,
          service,
          action,
          state: typeof svc.state === 'string' ? svc.state : null,
        },
        ctx,
      );
      await this.#auditAppend(
        accountId,
        `device.service.${action}`,
        deviceId,
        { service, state: svc.state ?? null },
        ctx,
      );
    }
    return svc;
  }

  /** Power status, WoL plans and changes, sleep/restart/shutdown (FR-144). */
  async power(
    accountId: string,
    deviceId: string,
    req: {
      action: 'status' | 'wol-plan' | 'wol-enable' | 'sleep' | 'restart' | 'shutdown';
      apply?: boolean;
    },
    ctx: DeviceCallContext = {},
  ): Promise<Record<string, unknown>> {
    const d = await this.#usable(accountId, deviceId, ['power']);
    const res = await this.#call<Record<string, unknown>>(d, '/agent/v1/power', req);
    if (req.action === 'status') {
      await this.#db.transaction(() => {
        this.#run(
          'UPDATE device_management SET power = ? WHERE device_id = ?',
          JSON.stringify(res),
          deviceId,
        );
      });
    }
    const changes = req.action !== 'status' && req.action !== 'wol-plan';
    if (changes) {
      const applied = req.action === 'wol-enable' ? res.applied === true : true;
      await this.#emit(
        'device.power.requested',
        accountId,
        { deviceId, action: req.action, applied },
        ctx,
      );
      await this.#auditAppend(
        accountId,
        `device.power.${req.action}`,
        deviceId,
        { applied, apply: req.apply ?? false },
        ctx,
      );
    }
    return res;
  }

  /**
   * Send a magic packet to a wakeable device: rate-limited and logged (FR-144), through a Wake
   * Helper on its LAN when a router is set (FR-138). `via` is the helper's device id or `hub`.
   */
  async wake(
    accountId: string,
    deviceId: string,
    ctx: DeviceCallContext = {},
  ): Promise<DeviceWakeView & { via: string }> {
    const d = await this.device(accountId, deviceId);
    if (d.row.status === 'revoked') throw new NovaError('not_found', 'device not found');
    const view = await this.#view(d);
    const mac = view.wake.macs.find((m) => parseMac(m) !== null);
    if (!view.wake.wakeable || !mac) {
      throw new NovaError('capability_missing', 'this device does not report Wake-on-LAN', {
        details: { reason: 'not_wakeable' },
        action: 'Enable Wake-on-LAN on the device',
      });
    }
    const now = this.#now();
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const limit = (await this.#settings.wakesPerHour?.()) ?? 6;
    const id = uuidv7();
    // Counted and recorded in one transaction before anything is sent, so concurrent wakes cannot
    // all pass the check while a Wake Helper call is in flight; failed attempts count too.
    const limited = await this.#db.transaction(() => {
      const started =
        this.#get<{ n: number }>(
          `SELECT count(*) AS n FROM wake_request WHERE target_device_id = ?
           AND status IN ('pending', 'sent', 'failed') AND created_at >= ?`,
          deviceId,
          hourAgo,
        )?.n ?? 0;
      const over = started >= limit;
      this.#run(
        `INSERT INTO wake_request (id, account_id, target_device_id, helper_device_id, mac, status, error, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`,
        id,
        accountId,
        deviceId,
        mac,
        over ? 'rate_limited' : 'pending',
        now.toISOString(),
      );
      return over;
    });
    const finish = (
      status: 'sent' | 'failed',
      error: string | null,
      helper: string | null = null,
    ) =>
      this.#db.transaction(() => {
        this.#run(
          'UPDATE wake_request SET status = ?, error = ?, helper_device_id = ? WHERE id = ?',
          status,
          error,
          helper,
          id,
        );
      });
    if (limited) {
      await this.#auditAppend(
        accountId,
        'device.wake',
        deviceId,
        { mac, status: 'rate_limited' },
        ctx,
      );
      throw new NovaError('rate_limited', `at most ${limit} wakes per hour for a device`, {
        details: { reason: 'wake_rate_limited', limit },
      });
    }
    let status: 'sent' | 'failed' = 'sent';
    let error: string | null = null;
    let helper: string | null = null;
    try {
      let address = this.#wol.address;
      if (this.#wakeRouter) {
        const route = await this.#wakeRouter.route({ accountId, deviceId, mac });
        if (route.via === 'helper') helper = route.helperDeviceId;
        else address ??= route.address ?? undefined;
      }
      if (!helper) {
        await (this.#wol.send ?? sendMagicPacket)(mac, {
          ...(address ? { address } : {}),
          ...(this.#wol.port ? { port: this.#wol.port } : {}),
        });
      }
    } catch (err) {
      // Nothing on the target's LAN can send it (FR-138): logged and audited, no packet sent.
      if (err instanceof NovaError && err.details?.reason === 'no_wake_helper') {
        await finish('failed', 'no_wake_helper');
        await this.#auditAppend(
          accountId,
          'device.wake',
          deviceId,
          { mac, status: 'failed', via: null, error: 'no_wake_helper' },
          ctx,
        );
        throw err;
      }
      status = 'failed';
      error = err instanceof Error ? err.message.slice(0, 300) : 'send failed';
    }
    const via = helper ?? 'hub';
    await finish(status, error, helper);
    await this.#emit(
      'device.wake.sent',
      accountId,
      { deviceId, wakeRequestId: id, mac, status, via },
      ctx,
    );
    await this.#auditAppend(accountId, 'device.wake', deviceId, { mac, status, error, via }, ctx);
    if (status === 'failed')
      throw new NovaError('server_error', `the magic packet was not sent: ${error ?? ''}`);
    return { id, deviceId, mac, status, createdAt: now.toISOString(), via };
  }

  // ---- updates (FR-148) ---------------------------------------------------------------------

  /** Push signed bundles in order; the supervisor (`novad`) goes last and only after the others applied. */
  async pushUpdates(
    accountId: string,
    deviceId: string,
    bundles: readonly DeviceUpdateBundle[],
    ctx: DeviceCallContext = {},
  ): Promise<DeviceUpdateView[]> {
    const d = await this.#usable(accountId, deviceId, ['updates']);
    const ordered = [...bundles].sort(
      (a, b) => Number(a.manifest.target === 'novad') - Number(b.manifest.target === 'novad'),
    );
    const out: DeviceUpdateView[] = [];
    let failed = false;
    for (const bundle of ordered) {
      const m = bundle.manifest;
      let from =
        m.target === 'novad'
          ? d.row.novadVersion
          : (parseJson<ModuleReport[]>(this.#mgmt(deviceId)?.modules, []).find(
              (x) => x.name === m.target,
            )?.version ?? null);
      let status: DeviceUpdateView['status'];
      let detail: string | null;
      if (failed && m.target === 'novad') {
        status = 'refused';
        detail = 'an earlier bundle did not apply; the supervisor is not updated';
      } else {
        try {
          const r = await this.#call<{ status?: unknown; reason?: unknown; from?: unknown }>(
            d,
            '/agent/v1/update',
            { bundle },
            120_000,
          );
          if (typeof r.from === 'string') from = r.from;
          status =
            r.status === 'applied'
              ? 'applied'
              : r.status === 'staged'
                ? 'staged'
                : r.status === 'rolled_back'
                  ? 'rolled_back'
                  : 'failed';
          detail = typeof r.reason === 'string' ? r.reason : null;
        } catch (err) {
          status =
            err instanceof NovaError &&
            ['policy_denied', 'conflict', 'validation'].includes(err.code)
              ? 'refused'
              : 'failed';
          detail = err instanceof Error ? err.message.slice(0, 300) : 'update failed';
        }
      }
      if (status !== 'applied' && status !== 'staged') failed = true;
      out.push(
        await this.#recordUpdate(d.row, {
          target: m.target,
          from,
          to: m.version,
          channel: m.channel,
          status,
          detail,
        }),
      );
      await this.#emit(
        'device.update.result',
        accountId,
        {
          deviceId,
          target: m.target,
          from,
          to: m.version,
          channel: m.channel,
          status,
        },
        ctx,
      );
      await this.#auditAppend(
        accountId,
        'device.update',
        deviceId,
        {
          target: m.target,
          from,
          to: m.version,
          channel: m.channel,
          sha256: m.sha256,
        },
        ctx,
        { result: status },
      );
    }
    return out;
  }

  async #recordUpdate(
    row: DeviceRow,
    u: {
      target: string;
      from: string | null;
      to: string;
      channel: DeviceUpdateChannel;
      status: DeviceUpdateView['status'];
      detail: string | null;
    },
  ): Promise<DeviceUpdateView> {
    const id = uuidv7();
    const createdAt = this.#iso();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO device_update (id, account_id, device_id, target, from_version, to_version, channel, status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        row.accountId,
        row.id,
        u.target,
        u.from,
        u.to,
        u.channel,
        u.status,
        u.detail,
        createdAt,
      );
    });
    return {
      id,
      deviceId: row.id,
      target: u.target,
      fromVersion: u.from,
      toVersion: u.to,
      channel: u.channel,
      status: u.status,
      detail: u.detail,
      createdAt,
    };
  }

  async updates(accountId: string, deviceId: string): Promise<DeviceUpdateView[]> {
    await this.device(accountId, deviceId);
    return this.#all<UpdateRow>(
      'SELECT * FROM device_update WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      deviceId,
    ).map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      target: r.target,
      fromVersion: r.from_version,
      toVersion: r.to_version,
      channel: (DEVICE_UPDATE_CHANNELS as readonly string[]).includes(r.channel)
        ? r.channel
        : 'stable',
      status: r.status,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  // ---- device file operations (FR-210) ------------------------------------------------------

  async listFiles(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    path: string,
  ): Promise<{ path: string; entries: DeviceDirent[]; truncated: boolean }> {
    const d = await this.#usable(accountId, deviceId, ['files']);
    const r = await this.#call<{ path?: unknown; entries?: unknown; truncated?: unknown }>(
      d,
      '/agent/v1/fs/list',
      { grantee, path },
    );
    const entries = z
      .array(
        z.object({
          name: z.string(),
          kind: z.enum(['file', 'dir', 'symlink', 'other']),
          size: z.number().nullable(),
        }),
      )
      .catch([])
      .parse(r.entries);
    return {
      path: typeof r.path === 'string' ? r.path : path,
      entries,
      truncated: r.truncated === true,
    };
  }

  async readFile(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    path: string,
    maxBytes?: number,
  ): Promise<{
    path: string;
    contentBase64: string;
    size: number;
    sha256: string;
    truncated: boolean;
  }> {
    const d = await this.#usable(accountId, deviceId, ['files']);
    const r = await this.#call<Record<string, unknown>>(d, '/agent/v1/fs/read', {
      grantee,
      path,
      ...(maxBytes ? { maxBytes } : {}),
    });
    return {
      path: typeof r.path === 'string' ? r.path : path,
      contentBase64: typeof r.contentBase64 === 'string' ? r.contentBase64 : '',
      size: typeof r.size === 'number' ? r.size : 0,
      sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
      truncated: r.truncated === true,
    };
  }

  async statFile(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    path: string,
  ): Promise<{ kind: DeviceDirent['kind']; size: number; mtimeMs: number }> {
    const d = await this.#usable(accountId, deviceId, ['files']);
    const r = await this.#call<Record<string, unknown>>(d, '/agent/v1/fs/stat', { grantee, path });
    const kind = r.kind === 'dir' || r.kind === 'file' ? r.kind : 'other';
    return {
      kind,
      size: typeof r.size === 'number' ? r.size : 0,
      mtimeMs: typeof r.mtimeMs === 'number' ? r.mtimeMs : 0,
    };
  }

  async deletePath(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    path: string,
    ctx: DeviceCallContext = {},
  ): Promise<void> {
    this.#hubProtected(path);
    const d = await this.#usable(accountId, deviceId, ['staged_writes']);
    await this.#call(d, '/agent/v1/fs/delete', { grantee, path });
    await this.#auditAppend(accountId, 'device.fs.delete', deviceId, { path, grantee }, ctx);
  }

  async movePath(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    from: string,
    to: string,
    ctx: DeviceCallContext = {},
  ): Promise<void> {
    this.#hubProtected(from);
    this.#hubProtected(to);
    const d = await this.#usable(accountId, deviceId, ['staged_writes']);
    await this.#call(d, '/agent/v1/fs/move', { grantee, from, to });
    await this.#auditAppend(accountId, 'device.fs.move', deviceId, { from, to, grantee }, ctx);
  }

  /**
   * The Hub's own protected-path check (FR-190), before anything reaches the device: credential
   * locations anywhere and the read-only locations (`.git`, shell startup files…) are refused.
   */
  #hubProtected(path: string): void {
    const p = canonicalPath(path);
    if (!p) throw new NovaError('validation', 'the path must be absolute with no . or .. segments');
    const root = /^[A-Z]:/.test(p) ? `${p.slice(0, 2)}/` : '/';
    const check = pathAccess(p, { entries: [{ path: root, access: 'write' }] });
    if (check.access !== 'write') {
      throw new NovaError('policy_denied', `protected path: ${check.reason}`, {
        details: { reason: 'protected_path', path: p },
      });
    }
  }

  /**
   * Ask for a folder (FR-210). The signed-in user asking for themselves is granted at once; a
   * session, run, thread or agent gets a pending request with a Hub approval card, which the
   * device can also decide (`novad access approve`).
   */
  async requestAccess(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    req: { path: string; access: 'read' | 'write'; reason?: string },
    ctx: DeviceCallContext = {},
  ): Promise<DeviceAccessRequestView> {
    const d = await this.#usable(accountId, deviceId, ['files']);
    const r = await this.#call<{ request?: unknown }>(d, '/agent/v1/fs/request-access', {
      grantee,
      kind: 'folder',
      path: req.path,
      access: req.access,
      ...(req.reason ? { reason: req.reason } : {}),
    });
    const wire = wireRequestSchema.parse(r.request);
    return this.#recordRequest(d, accountId, grantee, wire, req.reason ?? null, ctx);
  }

  /** Grant a folder or an MCP server directly: the signed-in user's own decision. */
  async grant(
    accountId: string,
    deviceId: string,
    g: {
      grantee: DeviceGrantee;
      kind: 'folder' | 'mcp';
      target: string;
      access: 'read' | 'write' | 'call';
    },
    ctx: DeviceCallContext = {},
  ): Promise<DeviceAccessRequestView> {
    if (g.kind === 'folder') this.#hubFolderCheck(g.target);
    const d = await this.#usable(accountId, deviceId, [g.kind === 'mcp' ? 'mcp' : 'files']);
    const r = await this.#call<{ request?: unknown }>(d, '/agent/v1/fs/grant', {
      grantee: g.grantee,
      kind: g.kind,
      target: g.target,
      access: g.access,
    });
    const wire = wireRequestSchema.parse(r.request);
    const view = await this.#upsertGrant(d.row, accountId, g.grantee, wire, null, 'hub');
    await this.#emit(
      'device.access.decided',
      accountId,
      {
        deviceId,
        requestId: view.id,
        status: view.status,
        decidedBy: 'hub',
      },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      'device.grant.create',
      deviceId,
      {
        grantee: g.grantee,
        kind: g.kind,
        target: wire.target,
        access: wire.access,
      },
      ctx,
    );
    return view;
  }

  /** A folder grant may name a whole drive, never a credential location (FR-190). */
  #hubFolderCheck(path: string): void {
    const p = canonicalPath(path);
    if (!p) throw new NovaError('validation', 'the path must be absolute with no . or .. segments');
    const check = pathAccess(p, { entries: [{ path: p, access: 'write' }] });
    if (check.access === 'deny') {
      throw new NovaError('policy_denied', `protected path: ${check.reason}`, {
        details: { reason: 'protected_path', path: p },
      });
    }
  }

  async #recordRequest(
    d: ManagedDevice,
    accountId: string,
    grantee: DeviceGrantee,
    wire: WireRequest,
    reason: string | null,
    ctx: DeviceCallContext,
  ): Promise<DeviceAccessRequestView> {
    if (wire.status !== 'pending') {
      return this.#upsertGrant(
        d.row,
        accountId,
        grantee,
        wire,
        reason,
        wire.decidedBy === 'device' ? 'device' : 'hub',
      );
    }
    if (grantee.kind === 'user') {
      // The signed-in user asked for their own access: that is the approval.
      const res = await this.#call<{ request?: unknown }>(
        { row: d.row, endpoint: d.endpoint! },
        '/agent/v1/fs/decide',
        { requestId: wire.id, decision: 'grant' },
      );
      const decided = wireRequestSchema.parse(res.request);
      const view = await this.#upsertGrant(d.row, accountId, grantee, decided, reason, 'hub');
      await this.#auditAppend(
        accountId,
        'device.grant.create',
        d.row.id,
        { grantee, kind: 'folder', target: decided.target, access: decided.access },
        ctx,
      );
      return view;
    }
    const existing = this.#get<GrantRow>(
      'SELECT * FROM device_grant WHERE device_id = ? AND device_request_id = ?',
      d.row.id,
      wire.id,
    );
    if (existing) return grantView(existing);
    const id = uuidv7();
    const approvalId = uuidv7();
    const now = this.#now();
    const nowIso = now.toISOString();
    const verb = wire.access === 'write' ? 'read and change' : 'read';
    const who = `${grantee.kind} ${grantee.id}`;
    const action = `Let ${who} ${verb} ${wire.target} on ${d.row.name}`;
    const argsPreview = JSON.stringify({
      device: d.row.name,
      path: wire.target,
      access: wire.access,
    });
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(approval).values({
        id: approvalId,
        accountId,
        toolCallId: null,
        threadId: ctx.threadId ?? (grantee.kind === 'thread' ? grantee.id : null),
        turnId: null,
        runId: ctx.runId ?? (grantee.kind === 'run' ? grantee.id : null),
        agentId: ctx.agentId ?? (grantee.kind === 'agent' ? grantee.id : null),
        toolName: 'device.fs.request_access',
        requestedAction: action,
        argsPreview,
        argsHash: sha256Hex(argsPreview),
        // The reason came from the session: shown as its words, never as an instruction (FR-189).
        reason: reason ? `Requested by ${who}: ${reason.slice(0, 300)}` : `Requested by ${who}`,
        scope: `device:${d.row.id}`,
        risk: wire.access === 'write' ? 'medium' : 'low',
        tier: 'confirm_at_action',
        userAsked: false,
        optionsJson: JSON.stringify(['allow_once', 'deny_continue']),
        alwaysScopesJson: '[]',
        status: 'pending',
        createdAt: nowIso,
        expiresAt: new Date(now.getTime() + STAGE_TTL_MS).toISOString(),
      });
      this.#run(
        `INSERT INTO device_grant (id, account_id, device_id, grantee_kind, grantee_ref, kind, target, access, status,
           device_request_id, approval_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        accountId,
        d.row.id,
        grantee.kind,
        grantee.id,
        wire.kind,
        wire.target,
        wire.access,
        wire.id,
        approvalId,
        reason,
        nowIso,
      );
    });
    await this.#emit(
      'approval.requested',
      accountId,
      {
        approvalId,
        callId: null,
        action,
        reason: reason ?? '',
        scope: `device:${d.row.id}`,
        risk: wire.access === 'write' ? 'medium' : 'low',
        tier: 'confirm_at_action',
      },
      { ...ctx, actor: 'system' },
    );
    await this.#emit(
      'device.access.requested',
      accountId,
      {
        deviceId: d.row.id,
        requestId: id,
        grantee,
        path: wire.target,
        access: wire.access,
        approvalId,
      },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      'device.access.request',
      d.row.id,
      {
        grantee,
        target: wire.target,
        access: wire.access,
        approvalId,
      },
      ctx,
    );
    if (this.#notifier) {
      await this.#notifier
        .notify({
          accountId,
          kind: 'approval',
          title: 'Folder access requested',
          body: action.slice(0, 200),
          href: `/approvals/${approvalId}`,
          dedupeKey: `approval:${approvalId}`,
        })
        .catch((err: unknown) => this.#log.warn('access request notification failed', { err }));
    }
    const row = this.#get<GrantRow>('SELECT * FROM device_grant WHERE id = ?', id)!;
    return grantView(row);
  }

  /** Insert or update the Hub's copy of a device-side request/grant. */
  async #upsertGrant(
    row: DeviceRow,
    accountId: string,
    grantee: DeviceGrantee,
    wire: WireRequest,
    reason: string | null,
    by: 'device' | 'hub',
  ): Promise<DeviceAccessRequestView> {
    const nowIso = this.#iso();
    const status = wire.status === 'pending' ? 'pending' : wire.status;
    // A covered request reuses the existing grant row.
    const existing =
      this.#get<GrantRow>(
        'SELECT * FROM device_grant WHERE device_id = ? AND device_request_id = ?',
        row.id,
        wire.id,
      ) ??
      (wire.grantId
        ? this.#get<GrantRow>(
            "SELECT * FROM device_grant WHERE device_id = ? AND device_grant_id = ? AND status = 'granted'",
            row.id,
            wire.grantId,
          )
        : undefined);
    if (existing) {
      if (existing.status === 'pending' && status !== 'pending') {
        await this.#db.transaction(() => {
          this.#run(
            'UPDATE device_grant SET status = ?, decided_by = ?, decided_at = ?, device_grant_id = ? WHERE id = ?',
            status,
            by,
            nowIso,
            wire.grantId ?? null,
            existing.id,
          );
        });
      }
      return grantView(
        this.#get<GrantRow>('SELECT * FROM device_grant WHERE id = ?', existing.id)!,
      );
    }
    const id = uuidv7();
    await this.#db.transaction(() => {
      // An upgraded grant (read -> write) replaces the Hub's older row for the same folder.
      if (status === 'granted') {
        this.#run(
          `UPDATE device_grant SET status = 'revoked', decided_at = ? WHERE device_id = ? AND grantee_kind = ?
             AND grantee_ref = ? AND kind = ? AND target = ? AND status = 'granted'`,
          nowIso,
          row.id,
          grantee.kind,
          grantee.id,
          wire.kind,
          wire.target,
        );
      }
      this.#run(
        `INSERT INTO device_grant (id, account_id, device_id, grantee_kind, grantee_ref, kind, target, access, status,
           device_request_id, device_grant_id, reason, decided_by, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        accountId,
        row.id,
        grantee.kind,
        grantee.id,
        wire.kind,
        wire.target,
        wire.access,
        status,
        wire.id.startsWith('covered-') ? null : wire.id,
        wire.grantId ?? null,
        reason,
        status === 'pending' ? null : by,
        nowIso,
        status === 'pending' ? null : nowIso,
      );
    });
    return grantView(this.#get<GrantRow>('SELECT * FROM device_grant WHERE id = ?', id)!);
  }

  /** The user answered a folder-access approval card. */
  async onApprovalDecided(accountId: string, approvalId: string, decision: string): Promise<void> {
    const row = this.#get<GrantRow>(
      "SELECT * FROM device_grant WHERE account_id = ? AND approval_id = ? AND status = 'pending'",
      accountId,
      approvalId,
    );
    if (!row?.device_request_id) return;
    const grant =
      decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_always';
    let decided: WireRequest | null = null;
    try {
      const d = await this.device(accountId, row.device_id);
      if (d.endpoint && d.row.status === 'active') {
        const r = await this.#call<{ request?: unknown }>(
          { row: d.row, endpoint: d.endpoint },
          '/agent/v1/fs/decide',
          {
            requestId: row.device_request_id,
            decision: grant ? 'grant' : 'deny',
          },
        );
        decided = wireRequestSchema.parse(r.request);
      }
    } catch (err) {
      // A conflict means the device decided first; its heartbeat reports that decision.
      this.#log.warn('could not pass the access decision to the device', {
        err,
        deviceId: row.device_id,
      });
    }
    if (!decided) {
      // Unreachable: a denial needs nothing on the device; a grant is passed on its next heartbeat.
      if (!grant) await this.#finishGrant(row, 'denied', 'hub', null);
      return;
    }
    await this.#finishGrant(
      row,
      decided.status === 'granted' ? 'granted' : 'denied',
      'hub',
      decided.grantId ?? null,
    );
  }

  async #finishGrant(
    row: GrantRow,
    status: 'granted' | 'denied',
    by: 'device' | 'hub',
    deviceGrantId: string | null,
  ): Promise<void> {
    const nowIso = this.#iso();
    const changed = await this.#db.transaction(() =>
      this.#run(
        "UPDATE device_grant SET status = ?, decided_by = ?, decided_at = ?, device_grant_id = ? WHERE id = ? AND status = 'pending'",
        status,
        by,
        nowIso,
        deviceGrantId,
        row.id,
      ),
    );
    if (!changed) return;
    await this.#emit('device.access.decided', row.account_id, {
      deviceId: row.device_id,
      requestId: row.id,
      status,
      decidedBy: by,
    });
    await this.#auditAppend(
      row.account_id,
      'device.access.decide',
      row.device_id,
      {
        grantee: { kind: row.grantee_kind, id: row.grantee_ref },
        target: row.target,
        access: row.access,
        decidedBy: by,
      },
      { actor: by === 'device' ? 'system' : 'user' },
      { decision: status },
    );
  }

  /** A decision made on the device, reported by its heartbeat. */
  async #deviceDecided(d: DeviceRow, raw: AccessDecision): Promise<void> {
    const row = this.#get<GrantRow>(
      'SELECT * FROM device_grant WHERE device_id = ? AND device_request_id = ?',
      d.id,
      raw.id,
    );
    if (!row) {
      const grantee = { kind: raw.grantee.kind, id: raw.grantee.id };
      const parsed = z
        .object({
          kind: z.enum(['user', 'agent', 'session', 'run', 'thread']),
          id: z.string().min(1),
        })
        .safeParse(grantee);
      if (!parsed.success) return;
      await this.#upsertGrant(
        d,
        d.accountId,
        parsed.data,
        { ...raw, reason: null },
        null,
        'device',
      );
      return;
    }
    // Already decided on the Hub: the Hub's answer stands.
    if (row.status !== 'pending') return;
    await this.#finishGrant(row, raw.status, 'device', raw.grantId ?? null);
    if (row.approval_id) {
      const nowIso = this.#iso();
      const decision = raw.status === 'granted' ? 'allow_once' : 'deny_continue';
      const changed = await this.#db.transaction(() =>
        this.#run(
          `UPDATE approval SET status = 'decided', decision = ?, decided_by = ?, decided_at = ?
           WHERE id = ? AND status = 'pending'`,
          decision,
          `device:${d.id}`,
          nowIso,
          row.approval_id,
        ),
      );
      if (changed) {
        await this.#emit('approval.decided', d.accountId, {
          approvalId: row.approval_id,
          decision,
          decidedBy: `device:${d.id}`,
          override: false,
        });
      }
    }
  }

  /** The Hub's copy of a device's grants and requests. */
  async grants(accountId: string, deviceId: string): Promise<DeviceAccessRequestView[]> {
    await this.device(accountId, deviceId);
    return this.#all<GrantRow>(
      "SELECT * FROM device_grant WHERE device_id = ? AND status IN ('pending', 'granted') ORDER BY created_at, id",
      deviceId,
    ).map(grantView);
  }

  accessRequest(accountId: string, requestId: string): Promise<DeviceAccessRequestView> {
    const row = this.#get<GrantRow>(
      'SELECT * FROM device_grant WHERE id = ? AND account_id = ?',
      requestId,
      accountId,
    );
    if (!row) return Promise.reject(new NovaError('not_found', 'access request not found'));
    return Promise.resolve(grantView(row));
  }

  /** Revoke a grant (the folder or MCP server is no longer reachable for its grantee). */
  async revokeGrant(
    accountId: string,
    deviceId: string,
    grantId: string,
    ctx: DeviceCallContext = {},
  ): Promise<void> {
    const row = this.#get<GrantRow>(
      'SELECT * FROM device_grant WHERE id = ? AND device_id = ? AND account_id = ?',
      grantId,
      deviceId,
      accountId,
    );
    if (!row) throw new NovaError('not_found', 'grant not found');
    if (row.status === 'revoked' || row.status === 'denied') return;
    const d = await this.#usable(accountId, deviceId, ['files']);
    if (row.device_grant_id)
      await this.#call(d, '/agent/v1/fs/revoke', { grantId: row.device_grant_id });
    await this.#db.transaction(() => {
      this.#run(
        "UPDATE device_grant SET status = 'revoked', decided_at = ? WHERE id = ?",
        this.#iso(),
        grantId,
      );
      if (row.approval_id) {
        this.#run(
          "UPDATE approval SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
          row.approval_id,
        );
      }
    });
    await this.#emit('device.grant.revoked', accountId, { deviceId, grantId }, ctx);
    await this.#auditAppend(
      accountId,
      'device.grant.revoke',
      deviceId,
      { grantee: { kind: row.grantee_kind, id: row.grantee_ref }, target: row.target },
      ctx,
    );
  }

  /**
   * Stage a write (FR-210). A path outside the grantee's folders files an access request (with a
   * Hub approval card) and fails with `policy_denied` / `folder_access_required`.
   */
  async stage(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    req: {
      path: string;
      contentBase64: string;
      baseSha256?: string;
      createDirs?: boolean;
      sessionRef?: string;
    },
    ctx: DeviceCallContext = {},
  ): Promise<StagedWriteView> {
    this.#hubProtected(req.path);
    const d = await this.#usable(accountId, deviceId, ['staged_writes']);
    const sessionRef = req.sessionRef ?? `${grantee.kind}:${grantee.id}`;
    let res: { staged?: unknown };
    try {
      res = await this.#call<{ staged?: unknown }>(d, '/agent/v1/fs/stage', {
        grantee,
        path: req.path,
        contentBase64: req.contentBase64,
        ...(req.baseSha256 ? { baseSha256: req.baseSha256 } : {}),
        createDirs: req.createDirs ?? false,
        sessionRef,
      });
    } catch (err) {
      throw await this.#accessRequired(d, accountId, grantee, err, ctx);
    }
    const s = wireStagedSchema.parse(res.staged);
    const id = uuidv7();
    const nowIso = this.#iso();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO staged_write (id, account_id, device_id, device_stage_id, grantee_kind, grantee_ref, session_ref,
           path, base_sha256, new_sha256, size, blob_path, diff, additions, deletions, binary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)`,
        id,
        accountId,
        deviceId,
        s.id,
        grantee.kind,
        grantee.id,
        sessionRef,
        s.path,
        s.baseSha256,
        s.newSha256,
        s.size,
        `novad:staged/${s.id}`,
        s.diff.slice(0, 256 * 1024),
        s.additions,
        s.deletions,
        s.binary ? 1 : 0,
        nowIso,
      );
    });
    await this.#emit(
      'device.write.staged',
      accountId,
      {
        deviceId,
        stagedId: id,
        path: s.path,
        additions: s.additions,
        deletions: s.deletions,
        sessionRef,
      },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      'device.write.stage',
      deviceId,
      {
        stagedId: id,
        path: s.path,
        grantee,
        newSha256: s.newSha256,
      },
      ctx,
      { inputHash: s.newSha256 },
    );
    return this.stagedWrite(accountId, id);
  }

  /** Turn a device's `folder_access_required` refusal into a recorded request with a card. */
  async #accessRequired(
    d: ManagedDevice,
    accountId: string,
    grantee: DeviceGrantee,
    err: unknown,
    ctx: DeviceCallContext,
  ): Promise<unknown> {
    if (!(err instanceof NovaError) || err.details?.reason !== 'folder_access_required') return err;
    const parsed = wireRequestSchema.safeParse(err.details.request);
    if (!parsed.success) return err;
    const view = await this.#recordRequest(
      d,
      accountId,
      grantee,
      parsed.data,
      'a write outside the granted folders',
      ctx,
    );
    if (view.status === 'granted') {
      return new NovaError('conflict', 'the folder was granted; stage the write again', {
        details: { reason: 'access_granted', requestId: view.id },
      });
    }
    return new NovaError(
      'policy_denied',
      `${parsed.data.target} is outside the granted folders; access was requested`,
      {
        details: {
          reason: 'folder_access_required',
          requestId: view.id,
          approvalId: view.approvalId,
          path: parsed.data.target,
          access: parsed.data.access,
        },
        action: 'Approve the folder request on the Hub or on the device',
      },
    );
  }

  stagedWrite(accountId: string, stagedId: string): Promise<StagedWriteView> {
    const row = this.#get<StagedRow>(
      'SELECT * FROM staged_write WHERE id = ? AND account_id = ?',
      stagedId,
      accountId,
    );
    if (!row) return Promise.reject(new NovaError('not_found', 'staged write not found'));
    return Promise.resolve(stagedView(row));
  }

  async stagedWrites(
    accountId: string,
    deviceId: string,
    q: { status?: StagedWriteView['status']; sessionRef?: string } = {},
  ): Promise<StagedWriteView[]> {
    await this.device(accountId, deviceId);
    const where = ['device_id = ?', 'account_id = ?'];
    const params: SqlValue[] = [deviceId, accountId];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.sessionRef) {
      where.push('session_ref = ?');
      params.push(q.sessionRef);
    }
    return this.#all<StagedRow>(
      `SELECT * FROM staged_write WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 200`,
      ...params,
    ).map(stagedView);
  }

  /** Commit a staged write: the device replaces the file only if it still has the staged base. */
  async commit(
    accountId: string,
    stagedId: string,
    ctx: DeviceCallContext = {},
  ): Promise<StagedWriteView> {
    const row = this.#get<StagedRow>(
      'SELECT * FROM staged_write WHERE id = ? AND account_id = ?',
      stagedId,
      accountId,
    );
    if (!row) throw new NovaError('not_found', 'staged write not found');
    if (row.status !== 'staged') {
      throw new NovaError('conflict', `the write is ${row.status}`, {
        details: { reason: row.status },
      });
    }
    this.#hubProtected(row.path);
    const d = await this.#usable(accountId, row.device_id, ['staged_writes']);
    const grantee = { kind: row.grantee_kind, id: row.grantee_ref };
    try {
      await this.#call(d, '/agent/v1/fs/commit', { grantee, stagedId: row.device_stage_id });
    } catch (err) {
      const status: StagedWriteView['status'] | null =
        err instanceof NovaError && err.code === 'conflict'
          ? 'conflict'
          : err instanceof NovaError && err.code === 'not_found'
            ? 'expired'
            : null;
      if (status) {
        const message = err instanceof Error ? err.message.slice(0, 300) : null;
        await this.#db.transaction(() => {
          this.#run(
            'UPDATE staged_write SET status = ?, error = ? WHERE id = ?',
            status,
            message,
            stagedId,
          );
        });
        if (status === 'conflict') {
          await this.#emit(
            'device.write.conflict',
            accountId,
            { deviceId: row.device_id, stagedId, path: row.path },
            ctx,
          );
        }
        await this.#auditAppend(
          accountId,
          'device.write.commit',
          row.device_id,
          { stagedId, path: row.path },
          ctx,
          { result: status },
        );
      }
      throw err;
    }
    const nowIso = this.#iso();
    await this.#db.transaction(() => {
      this.#run(
        "UPDATE staged_write SET status = 'committed', committed_at = ? WHERE id = ?",
        nowIso,
        stagedId,
      );
    });
    await this.#emit(
      'device.write.committed',
      accountId,
      {
        deviceId: row.device_id,
        stagedId,
        path: row.path,
        sha256: row.new_sha256,
      },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      'device.write.commit',
      row.device_id,
      {
        stagedId,
        path: row.path,
        grantee,
        sha256: row.new_sha256,
      },
      ctx,
      { result: 'committed', inputHash: row.new_sha256 },
    );
    return this.stagedWrite(accountId, stagedId);
  }

  async discard(
    accountId: string,
    stagedId: string,
    ctx: DeviceCallContext = {},
  ): Promise<StagedWriteView> {
    const row = this.#get<StagedRow>(
      'SELECT * FROM staged_write WHERE id = ? AND account_id = ?',
      stagedId,
      accountId,
    );
    if (!row) throw new NovaError('not_found', 'staged write not found');
    if (row.status !== 'staged') {
      throw new NovaError('conflict', `the write is ${row.status}`, {
        details: { reason: row.status },
      });
    }
    try {
      const d = await this.#usable(accountId, row.device_id, ['staged_writes']);
      await this.#call(d, '/agent/v1/fs/discard', {
        grantee: { kind: row.grantee_kind, id: row.grantee_ref },
        stagedId: row.device_stage_id,
      });
    } catch (err) {
      // Gone on the device already (expired) or unreachable: novad drops it within 24 h anyway.
      this.#log.info('discard on the device failed', { err, stagedId });
    }
    await this.#db.transaction(() => {
      this.#run("UPDATE staged_write SET status = 'discarded' WHERE id = ?", stagedId);
    });
    await this.#emit(
      'device.write.discarded',
      accountId,
      { deviceId: row.device_id, stagedId },
      ctx,
    );
    await this.#auditAppend(
      accountId,
      'device.write.discard',
      row.device_id,
      { stagedId, path: row.path },
      ctx,
    );
    return this.stagedWrite(accountId, stagedId);
  }

  /** A sandboxed command on the device (FR-081, FR-107): refused without a sandbox there. */
  async exec(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    spec: ComputerExecSpec,
    ctx: DeviceCallContext = {},
  ): Promise<ComputerExecResult> {
    const d = await this.#usable(accountId, deviceId, ['exec']);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 60_000, 100), 30 * 60_000);
    const body = {
      grantee,
      cmd: spec.cmd,
      args: spec.args ?? [],
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: spec.env ?? {},
      timeoutMs,
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      network: spec.network ?? 'off',
    };
    const inputHash = sha256Hex(
      JSON.stringify({ cmd: spec.cmd, args: spec.args ?? [], cwd: spec.cwd ?? null }),
    );
    let r: Record<string, unknown>;
    try {
      r = await this.#call<Record<string, unknown>>(d, '/agent/v1/exec', body, timeoutMs + 15_000);
    } catch (err) {
      await this.#auditAppend(
        accountId,
        'device.exec',
        deviceId,
        { cmd: spec.cmd, cwd: spec.cwd ?? null, grantee },
        ctx,
        {
          inputHash,
          result: err instanceof NovaError ? err.code : 'error',
        },
      );
      throw err;
    }
    const result: ComputerExecResult = {
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      timedOut: r.timedOut === true,
    };
    await this.#auditAppend(
      accountId,
      'device.exec',
      deviceId,
      {
        cmd: spec.cmd,
        cwd: spec.cwd ?? null,
        grantee,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      },
      ctx,
      { inputHash, result: result.timedOut ? 'timeout' : String(result.exitCode) },
    );
    return result;
  }

  /**
   * Long-running commands for Code sessions (FR-062, FR-078): novad keeps the process and its
   * output, so a dropped connection loses nothing; `procRead` continues from any offset.
   */
  async procSpawn(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    spec: { cmd: string; cwd: string; env?: Record<string, string>; tag?: string },
    ctx: DeviceCallContext = {},
  ): Promise<{ id: string }> {
    const d = await this.#usable(accountId, deviceId, ['exec']);
    const r = await this.#call<{ id?: unknown }>(d, '/agent/v1/proc/spawn', { grantee, ...spec });
    if (typeof r.id !== 'string')
      throw new NovaError('server_error', 'the device gave no process id');
    await this.#auditAppend(
      accountId,
      'device.exec',
      deviceId,
      { cmd: spec.cmd.slice(0, 200), cwd: spec.cwd, grantee, processId: r.id },
      ctx,
      { inputHash: sha256Hex(JSON.stringify({ cmd: spec.cmd, cwd: spec.cwd })) },
    );
    return { id: r.id };
  }

  async procRead(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    id: string,
    offset: number,
    waitMs: number,
  ): Promise<{
    data: string;
    offset: number;
    dropped: number;
    running: boolean;
    exitCode: number | null;
  }> {
    const d = await this.#usable(accountId, deviceId, ['exec']);
    const wait = Math.max(0, Math.min(waitMs, 30_000));
    const r = await this.#call<Record<string, unknown>>(
      d,
      '/agent/v1/proc/read',
      { grantee, id, offset, waitMs: wait },
      wait + this.#callTimeoutMs,
    );
    return {
      data: typeof r.data === 'string' ? r.data : '',
      offset: typeof r.offset === 'number' ? r.offset : offset,
      dropped: typeof r.dropped === 'number' ? r.dropped : 0,
      running: r.running === true,
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    };
  }

  async procWrite(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    id: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    const d = await this.#usable(accountId, deviceId, ['exec']);
    await this.#call(d, '/agent/v1/proc/write', { grantee, id, ...input });
  }

  async procList(accountId: string, deviceId: string, grantee: DeviceGrantee): Promise<unknown[]> {
    const d = await this.#usable(accountId, deviceId, ['exec']);
    const r = await this.#call<{ processes?: unknown }>(d, '/agent/v1/proc/list', { grantee });
    const list: unknown = r.processes;
    return Array.isArray(list) ? (list as unknown[]) : [];
  }

  /** The device's local MCP servers granted to `grantee`, with their tools. */
  async mcpList(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
  ): Promise<{ servers: unknown[] }> {
    const d = await this.#usable(accountId, deviceId, ['mcp']);
    const r = await this.#call<{ servers?: unknown }>(
      d,
      '/agent/v1/mcp/list',
      { grantee },
      120_000,
    );
    return { servers: Array.isArray(r.servers) ? r.servers : [] };
  }

  /** Call a device-local MCP tool. The output is untrusted (FR-189). */
  async mcpCall(
    accountId: string,
    deviceId: string,
    grantee: DeviceGrantee,
    call: { server: string; tool: string; arguments: Record<string, unknown> },
    ctx: DeviceCallContext = {},
  ): Promise<{ content: unknown[]; isError: boolean; untrusted: true }> {
    const d = await this.#usable(accountId, deviceId, ['mcp']);
    const inputHash = sha256Hex(JSON.stringify(call));
    const r = await this.#call<{ content?: unknown; isError?: unknown }>(
      d,
      '/agent/v1/mcp/call',
      { grantee, ...call },
      90_000,
    );
    const out = {
      content: Array.isArray(r.content) ? r.content : [],
      isError: r.isError === true,
      untrusted: true as const,
    };
    await this.#auditAppend(
      accountId,
      'device.mcp.call',
      deviceId,
      { server: call.server, tool: call.tool, grantee, isError: out.isError },
      ctx,
      { inputHash },
    );
    return out;
  }

  // ---- an agent's connected computer (FR-081) ------------------------------------------------

  /**
   * Connect a device to an agent: explicit, one active connection per agent, refused when the
   * device's novad is below the minimum for the requested capabilities.
   */
  async connect(
    accountId: string,
    input: {
      agentId: string;
      deviceId: string;
      capabilities: readonly string[];
      replace?: boolean;
    },
    ctx: DeviceCallContext = {},
  ): Promise<AgentDeviceConnectionView> {
    if (this.#agentExists && !(await this.#agentExists(accountId, input.agentId))) {
      throw new NovaError('not_found', 'agent not found');
    }
    const d = await this.device(accountId, input.deviceId);
    if (d.row.status === 'revoked') throw new NovaError('not_found', 'device not found');
    const policy = parseJson<DevicePolicy>(d.mgmt.policy, {});
    if (policy.routingEligible === false) {
      throw new NovaError('policy_denied', 'this device is not eligible for agent work', {
        details: { reason: 'not_routing_eligible' },
      });
    }
    const wanted = [...new Set(input.capabilities)].flatMap((c) =>
      CONNECTION_CAPABILITY[c] ? [CONNECTION_CAPABILITY[c]] : [],
    );
    requireDeviceCapabilities(await this.#statuses(d), wanted, d.row.novadVersion);
    const current = this.#get<ConnectionRow>(
      "SELECT * FROM agent_device_connection WHERE agent_id = ? AND account_id = ? AND status = 'active'",
      input.agentId,
      accountId,
    );
    if (current && current.device_id === input.deviceId) {
      await this.#db.transaction(() => {
        this.#run(
          'UPDATE agent_device_connection SET capabilities = ? WHERE id = ?',
          JSON.stringify([...new Set(input.capabilities)]),
          current.id,
        );
      });
      return this.#connectionView(current.id);
    }
    if (current && !input.replace) {
      throw new NovaError('conflict', 'this agent already has a connected computer', {
        details: {
          reason: 'agent_connected',
          connectionId: current.id,
          deviceId: current.device_id,
        },
        action: 'Disconnect it first, or replace it',
      });
    }
    if (current) await this.disconnect(accountId, current.id, ctx);
    const id = uuidv7();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO agent_device_connection (id, account_id, agent_id, device_id, capabilities, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        id,
        accountId,
        input.agentId,
        input.deviceId,
        JSON.stringify([...new Set(input.capabilities)]),
        this.#iso(),
      );
    });
    await this.#emit(
      'device.connection.changed',
      accountId,
      {
        connectionId: id,
        agentId: input.agentId,
        deviceId: input.deviceId,
        status: 'active',
      },
      { ...ctx, agentId: input.agentId },
    );
    await this.#connectionChanged(accountId, {
      deviceId: input.deviceId,
      agentId: input.agentId,
      status: 'active',
    });
    await this.#auditAppend(
      accountId,
      'device.connection.create',
      input.deviceId,
      {
        agentId: input.agentId,
        capabilities: input.capabilities,
      },
      ctx,
    );
    return this.#connectionView(id);
  }

  /** End a connection; the agent's grants on the device go with it. */
  async disconnect(
    accountId: string,
    connectionId: string,
    ctx: DeviceCallContext = {},
  ): Promise<AgentDeviceConnectionView> {
    const row = this.#get<ConnectionRow>(
      'SELECT * FROM agent_device_connection WHERE id = ? AND account_id = ?',
      connectionId,
      accountId,
    );
    if (!row) throw new NovaError('not_found', 'connection not found');
    if (row.status === 'revoked') return this.#connectionView(row.id);
    const nowIso = this.#iso();
    await this.#db.transaction(() => {
      this.#run(
        "UPDATE agent_device_connection SET status = 'revoked', revoked_at = ? WHERE id = ?",
        nowIso,
        row.id,
      );
      this.#run(
        `UPDATE device_grant SET status = 'revoked', decided_at = ? WHERE device_id = ? AND grantee_kind = 'agent'
           AND grantee_ref = ? AND status IN ('pending', 'granted')`,
        nowIso,
        row.device_id,
        row.agent_id,
      );
    });
    try {
      const d = await this.device(accountId, row.device_id);
      if (d.endpoint && d.row.status === 'active') {
        await this.#call({ row: d.row, endpoint: d.endpoint }, '/agent/v1/fs/revoke', {
          grantee: { kind: 'agent', id: row.agent_id },
        });
      }
    } catch (err) {
      this.#log.warn('could not revoke the agent’s grants on the device', {
        err,
        deviceId: row.device_id,
      });
    }
    await this.#emit(
      'device.connection.changed',
      accountId,
      {
        connectionId: row.id,
        agentId: row.agent_id,
        deviceId: row.device_id,
        status: 'revoked',
      },
      { ...ctx, agentId: row.agent_id },
    );
    await this.#connectionChanged(accountId, {
      deviceId: row.device_id,
      agentId: row.agent_id,
      status: 'revoked',
    });
    await this.#auditAppend(
      accountId,
      'device.connection.revoke',
      row.device_id,
      { agentId: row.agent_id },
      ctx,
    );
    return this.#connectionView(row.id);
  }

  async connections(
    accountId: string,
    q: { agentId?: string; deviceId?: string } = {},
  ): Promise<AgentDeviceConnectionView[]> {
    const where = ['account_id = ?'];
    const params: SqlValue[] = [accountId];
    if (q.agentId) {
      where.push('agent_id = ?');
      params.push(q.agentId);
    }
    if (q.deviceId) {
      where.push('device_id = ?');
      params.push(q.deviceId);
    }
    const rows = this.#all<ConnectionRow>(
      `SELECT * FROM agent_device_connection WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 200`,
      ...params,
    );
    return Promise.all(rows.map((r) => this.#connectionView(r.id)));
  }

  /** The agent's active connection, or null. */
  async activeConnection(
    accountId: string,
    agentId: string,
  ): Promise<AgentDeviceConnectionView | null> {
    const row = this.#get<ConnectionRow>(
      "SELECT * FROM agent_device_connection WHERE agent_id = ? AND account_id = ? AND status = 'active'",
      agentId,
      accountId,
    );
    return row ? this.#connectionView(row.id) : null;
  }

  async connection(accountId: string, connectionId: string): Promise<AgentDeviceConnectionView> {
    const row = this.#get<ConnectionRow>(
      'SELECT * FROM agent_device_connection WHERE id = ? AND account_id = ?',
      connectionId,
      accountId,
    );
    if (!row) throw new NovaError('not_found', 'connection not found');
    return this.#connectionView(row.id);
  }

  async #connectionView(id: string): Promise<AgentDeviceConnectionView> {
    const row = this.#get<ConnectionRow>('SELECT * FROM agent_device_connection WHERE id = ?', id)!;
    const d = await this.#row(row.device_id);
    return {
      id: row.id,
      agentId: row.agent_id,
      deviceId: row.device_id,
      deviceName: d?.name ?? '',
      capabilities: parseJson<AgentDeviceConnectionView['capabilities']>(row.capabilities, []),
      status: row.status,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  /** Whether the device is in its quiet hours now (FR-150); background work waits. */
  async quiet(accountId: string, deviceId: string): Promise<boolean> {
    const p = await this.policyOf(accountId, deviceId);
    return inDeviceQuietHours(p.quietHours ?? [], this.#now(), p.timeZone);
  }

  /** Every active novad device row of the account (oldest first). */
  async activeDevices(accountId: string): Promise<DeviceRow[]> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(and(eq(device.accountId, accountId), eq(device.status, 'active')))
      .orderBy(asc(device.createdAt));
    return rows.filter((r) => this.#mgmt(r.id) !== undefined);
  }
}

function moduleView(m: ModuleReport): DeviceModuleView {
  return {
    name: m.name,
    version: m.version,
    state: m.state,
    pid: m.pid ?? null,
    restarts: m.restarts,
    lastExit: m.lastExit ?? null,
    disabledReason: m.disabledReason ?? null,
    startedAt: m.startedAt ?? null,
    previousVersion: m.previousVersion ?? null,
  };
}

function grantView(r: GrantRow): DeviceAccessRequestView {
  return {
    id: r.id,
    deviceId: r.device_id,
    grantee: { kind: r.grantee_kind, id: r.grantee_ref },
    kind: r.kind,
    target: r.target,
    access: r.access,
    reason: r.reason,
    status: r.status,
    approvalId: r.status === 'pending' ? r.approval_id : null,
    decidedBy: r.decided_by,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

function stagedView(r: StagedRow): StagedWriteView {
  return {
    id: r.id,
    deviceId: r.device_id,
    grantee: { kind: r.grantee_kind, id: r.grantee_ref },
    sessionRef: r.session_ref,
    path: r.path,
    baseSha256: r.base_sha256,
    newSha256: r.new_sha256,
    size: r.size,
    diff: r.diff,
    additions: r.additions,
    deletions: r.deletions,
    binary: r.binary === 1,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    committedAt: r.committed_at,
  };
}

function platformOf(doc: Record<string, unknown>): string | null {
  const os = isRecord(doc.os) ? doc.os : {};
  return typeof os.family === 'string' ? os.family.slice(0, 50) : null;
}

function channelOf(doc: Record<string, unknown>): DeviceUpdateChannel {
  const data = isRecord(doc.data) ? doc.data : {};
  const c = data.updateChannel;
  return typeof c === 'string' && (DEVICE_UPDATE_CHANNELS as readonly string[]).includes(c)
    ? (c as DeviceUpdateChannel)
    : 'stable';
}
