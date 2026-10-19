// Out-of-band management on the Hub (FR-147; docs/23 §7; ADR-043, ADR-096 D6): the owner's
// registry of BMCs and every action asked of them. Off by default (`devices.oob.enabled`), owner
// only, and fail closed: an action runs only while the setting is on, for the Hub's owner, on an
// endpoint the owner registered (the registry is the allowlist), and, except for the read actions,
// after the owner approved exactly that action on that BMC as it was (address, port, system, pin)
// with their own "Allow once" in Nova (a Hub-only confirm-at-action card; never a channel, link,
// hook or rule). An edit of the endpoint withdraws its open cards and approved plans. A Redfish
// BMC gets credentials only after the owner confirmed its certificate fingerprint. Every request,
// decision, refusal and outcome is audited as `device.oob.<action>` with the values before and
// after. Credentials live in the vault; no model tool reaches this service.
import { createHash } from 'node:crypto';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';
import {
  NovaError,
  OOB_ACTION_BODY_SCHEMAS,
  OOB_READ_ACTIONS,
  confirmOobPinSchema,
  createOobEndpointSchema,
  isNovaError,
  oobActionNeedsApproval,
  updateOobEndpointSchema,
  uuidv7,
  type OobAction,
  type OobActionStatus,
  type OobActionView,
  type OobBiosKey,
  type OobBiosPlanView,
  type OobBiosReadView,
  type OobBootTarget,
  type OobEndpointView,
  type OobKind,
  type OobPowerCycleLink,
  type OobPowerState,
  type OobSensorView,
  type OobStatusView,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { ProcessMeshRunner, type MeshCommandRunner } from '../network/mesh/runner.ts';
import { canonicalJson } from '../nodes/crypto.ts';
import { ownerOnlyError } from '../team/access.ts';
import { isHubOwner } from '../team/owner.ts';
import type { AuditSink, Notifier } from '../tools/types.ts';
import {
  parseOobAddress,
  resolveBmcAddress,
  type OobAddressPolicy,
  type OobOwnAddresses,
  type ResolveHost,
} from './address.ts';
import { biosSettings, biosSnapshot, biosVendorFor, planBios, type OobBiosVendor } from './bios.ts';
import { IpmiAdapter, type IpmiPowerOp, type IpmiTarget } from './ipmi.ts';
import {
  OOB_TIMEOUT_MS,
  OobTransportError,
  RedfishClient,
  bmcError,
  isJson,
  odataId,
  redfishPath,
  redfishServiceRoot,
  tlsRedfishTransport,
  type Json,
  type RedfishCredentials,
  type RedfishTransport,
} from './redfish.ts';

/** How long an approval card for an out-of-band action, and an approved BIOS plan, stay valid. */
export const OOB_APPROVAL_TTL_MS = 10 * 60_000;
export const REDFISH_DEFAULT_PORT = 443;

export function oobCredentialRef(endpointId: string): string {
  return `secret://oob/${endpointId}`;
}

export interface OobSettings {
  /** `devices.oob.enabled`. */
  enabled(): Promise<boolean>;
  /** `devices.firmware.allowChanges` (D3): BIOS plans and applies follow it. */
  firmwareAllowChanges(): Promise<boolean>;
  /** `devices.firmware.allowSecurityDegrading` (D3). */
  firmwareAllowSecurityDegrading(): Promise<boolean>;
}

export interface OobServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  log: Logger;
  settings: OobSettings;
  audit?: AuditSink;
  notifier?: Notifier;
  now?: () => Date;
  /** Runs `ipmitool` (tests: a fake program through `bins`). */
  runner?: MeshCommandRunner;
  /** How Redfish BMCs are reached (default: TLS with the pin checked before any request). */
  transport?: RedfishTransport;
  timeoutMs?: number;
  /** Who owns the Hub (default: the team area's owner row). */
  isOwner?: (accountId: string) => boolean;
  /** Resolves BMC host names (default: the system resolver); every answer is checked. */
  resolveHost?: ResolveHost;
  /** The Hub's own addresses and names (default: its interfaces and host name). */
  ownAddresses?: () => OobOwnAddresses;
  /** Tests only: the fake BMCs listen on 127.0.0.1. The Hub never sets it. */
  allowLoopbackForTests?: boolean;
}

interface EndpointRow {
  id: string;
  account_id: string;
  name: string;
  kind: OobKind;
  address: string;
  port: number | null;
  system_id: string | null;
  credential_ref: string;
  device_id: string | null;
  tls_pin: string | null;
  tls_pinned_at: string | null;
  tls_pin_confirmed_at: string | null;
  last_check_at: string | null;
  last_check_ok: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  account_id: string;
  endpoint_id: string | null;
  endpoint_name: string;
  action: OobAction;
  params_json: string;
  params_hash: string;
  status: OobActionStatus;
  approval_id: string | null;
  plan_id: string | null;
  before_json: string | null;
  after_json: string | null;
  result_json: string | null;
  error_code: string | null;
  error_reason: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string | null;
  decided_at: string | null;
  finished_at: string | null;
}

/** What the BMC reports of its BIOS, with the allowlist entry that applies. */
interface BiosRead {
  client: RedfishClient;
  entry: OobBiosVendor | null;
  reason: string | null;
  vendorName: string | null;
  attributes: Json;
  pending: Json;
  settingsPath: string | null;
  settingsEtag: string | null;
  applyTimes: string[] | null;
}

/** A BMC's service root read on a pinned connection, and whether the pin is confirmed. */
interface RedfishRoot {
  root: Json;
  pin: string;
  confirmed: boolean;
  connectTo: string;
  port: number;
}

interface Outcome {
  before?: unknown;
  after?: unknown;
  result: unknown;
}

const RESET_TYPES: Record<IpmiPowerOp, string> = {
  on: 'On',
  off: 'ForceOff',
  cycle: 'PowerCycle',
  reset: 'ForceRestart',
};

const BOOT_TARGETS: Record<OobBootTarget, string> = {
  pxe: 'Pxe',
  disk: 'Hdd',
  cdrom: 'Cd',
  bios: 'BiosSetup',
  usb: 'Usb',
};

const ACTION_WORDS: Record<OobAction, string> = {
  check: 'Check',
  'power.status': 'Read the power state of',
  'power.on': 'Power on',
  'power.off': 'Power off (hard)',
  'power.cycle': 'Power cycle',
  'power.reset': 'Reset (hard restart)',
  sensors: 'Read the sensors of',
  'bios.read': 'Read the BIOS settings of',
  'bios.plan': 'Change BIOS settings of',
  'bios.apply': 'Apply BIOS settings to',
  'boot.next': 'Set the next boot of',
};

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

function redfishPower(v: unknown): OobPowerState {
  switch (v) {
    case 'On':
      return 'on';
    case 'Off':
      return 'off';
    case 'PoweringOn':
      return 'powering_on';
    case 'PoweringOff':
      return 'powering_off';
    default:
      return 'unknown';
  }
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

function amtNotBuilt(): NovaError {
  return new NovaError(
    'capability_missing',
    'Intel AMT is not built: out-of-band management supports Redfish and IPMI BMCs in this version',
    { details: { reason: 'not_built' } },
  );
}

function notSupportedByIpmi(what: string): NovaError {
  return new NovaError('capability_missing', `${what} is not available over IPMI; use Redfish`, {
    details: { reason: 'not_supported_by_ipmi' },
  });
}

function reasonOf(err: unknown): string | null {
  if (!isNovaError(err)) return null;
  const r = err.details?.reason;
  return typeof r === 'string' ? r : null;
}

/** A value shown on a card: control and direction-override characters out, 200 characters. */
export function cardText(v: string, max = 200): string {
  const clean = [...v]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return !(
        n < 0x20 ||
        (n >= 0x7f && n <= 0x9f) ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069) ||
        n === 0x200e ||
        n === 0x200f
      );
    })
    .join('');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function errorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return defaultRedactor.redactString(m).slice(0, 500);
}

export class OobService {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #log: Logger;
  readonly #settings: OobSettings;
  readonly #audit: AuditSink | null;
  readonly #notifier: Notifier | null;
  readonly #now: () => Date;
  readonly #ipmi: IpmiAdapter;
  readonly #transport: RedfishTransport;
  readonly #timeoutMs: number;
  readonly #isOwner: (accountId: string) => boolean;
  readonly #addressPolicy: OobAddressPolicy;
  readonly #resolveHost: ResolveHost | undefined;

  constructor(o: OobServiceOptions) {
    this.#db = o.db;
    this.#secrets = o.secrets;
    this.#events = o.events;
    this.#log = o.log;
    this.#settings = o.settings;
    this.#audit = o.audit ?? null;
    this.#notifier = o.notifier ?? null;
    this.#now = o.now ?? (() => new Date());
    this.#timeoutMs = o.timeoutMs ?? OOB_TIMEOUT_MS;
    this.#ipmi = new IpmiAdapter({
      runner: o.runner ?? new ProcessMeshRunner(),
      timeoutMs: this.#timeoutMs,
    });
    this.#transport = o.transport ?? tlsRedfishTransport;
    this.#isOwner = o.isOwner ?? ((accountId) => isHubOwner(o.db, accountId));
    this.#addressPolicy = {
      ...(o.ownAddresses ? { own: o.ownAddresses } : {}),
      ...(o.allowLoopbackForTests ? { allowLoopback: true } : {}),
    };
    this.#resolveHost = o.resolveHost;
  }

  // ---- guards ----------------------------------------------------------------------------------

  /** Owner only (fail closed); a member's attempt is refused and audited. */
  async #owner(accountId: string, what: string): Promise<void> {
    if (this.#isOwner(accountId)) return;
    await this.#auditAppend(
      accountId,
      'device.oob.refuse',
      null,
      { what, reason: 'owner_only' },
      {
        decision: 'denied',
      },
    );
    throw ownerOnlyError('out-of-band management');
  }

  async #enabled(accountId: string, what: string, resource: string | null): Promise<void> {
    if (await this.#settings.enabled()) return;
    await this.#auditAppend(
      accountId,
      'device.oob.refuse',
      resource,
      { what, reason: 'oob_disabled' },
      {
        decision: 'denied',
      },
    );
    throw new NovaError('oob_disabled', 'Out-of-band management is off', {
      details: { reason: 'oob_disabled' },
      action: 'Turn on out-of-band management',
    });
  }

  // ---- status and the registry -----------------------------------------------------------------

  async status(accountId: string): Promise<OobStatusView> {
    await this.#owner(accountId, 'status');
    const n = this.#db.raw
      .prepare('SELECT count(*) AS n FROM oob_endpoint WHERE account_id = ?')
      .get(accountId) as { n: number };
    return {
      enabled: await this.#settings.enabled(),
      kinds: {
        redfish: { built: true },
        ipmi: { built: true },
        amt: { built: false, reason: 'not_built' },
      },
      readActions: [...OOB_READ_ACTIONS],
      endpoints: Number(n.n),
    };
  }

  #row(accountId: string, id: string): EndpointRow {
    const row = this.#db.raw
      .prepare('SELECT * FROM oob_endpoint WHERE id = ? AND account_id = ?')
      .get(id, accountId) as EndpointRow | undefined;
    if (!row) throw new NovaError('not_found', 'no such out-of-band endpoint');
    return row;
  }

  async #view(row: EndpointRow): Promise<OobEndpointView> {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      address: row.address,
      port: row.port,
      systemId: row.system_id,
      deviceId: row.device_id,
      credentialRef: row.credential_ref,
      hasCredentials: await this.#secrets.has(row.credential_ref),
      tlsPin: row.tls_pin,
      tlsPinnedAt: row.tls_pinned_at,
      tlsPinConfirmed: row.tls_pin !== null && row.tls_pin_confirmed_at !== null,
      tlsPinConfirmedAt: row.tls_pin_confirmed_at,
      lastCheckAt: row.last_check_at,
      lastCheckOk: row.last_check_ok === null ? null : row.last_check_ok === 1,
      lastError: row.last_error,
      supported: row.kind !== 'amt',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(accountId: string): Promise<OobEndpointView[]> {
    await this.#owner(accountId, 'endpoint.list');
    const rows = this.#db.raw
      .prepare('SELECT * FROM oob_endpoint WHERE account_id = ? ORDER BY created_at, id')
      .all(accountId) as unknown as EndpointRow[];
    return Promise.all(rows.map((r) => this.#view(r)));
  }

  async get(accountId: string, id: string): Promise<OobEndpointView> {
    await this.#owner(accountId, 'endpoint.get');
    return this.#view(this.#row(accountId, id));
  }

  #checkDevice(accountId: string, deviceId: string | null | undefined): void {
    if (!deviceId) return;
    const found = this.#db.raw
      .prepare('SELECT id FROM device WHERE id = ? AND account_id = ?')
      .get(deviceId, accountId);
    if (!found)
      throw new NovaError('validation', 'no such device to link', {
        details: { reason: 'unknown_device' },
      });
  }

  async create(accountId: string, input: unknown): Promise<OobEndpointView> {
    await this.#owner(accountId, 'endpoint.create');
    await this.#enabled(accountId, 'endpoint.create', null);
    const body = createOobEndpointSchema.parse(input);
    if (body.kind === 'amt') throw amtNotBuilt();
    const addr = parseOobAddress(body.address, body.kind, this.#addressPolicy);
    if (body.port !== undefined && addr.port !== null && body.port !== addr.port)
      throw new NovaError('validation', 'the address and the port name different ports');
    if (body.kind === 'ipmi' && body.systemId)
      throw new NovaError('validation', 'systemId is for Redfish endpoints only');
    if (body.kind === 'ipmi' && body.tlsPin)
      throw new NovaError('validation', 'IPMI has no TLS certificate to pin');
    this.#checkDevice(accountId, body.deviceId);
    const id = uuidv7();
    const ref = oobCredentialRef(id);
    const nowIso = this.#now().toISOString();
    await this.#secrets.put(ref, JSON.stringify(body.credentials));
    try {
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `INSERT INTO oob_endpoint (id, account_id, name, kind, address, port, system_id,
               credential_ref, device_id, tls_pin, tls_pinned_at, tls_pin_confirmed_at, created_at,
               updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            accountId,
            body.name,
            body.kind,
            addr.host,
            body.port ?? addr.port,
            body.systemId ?? null,
            ref,
            body.deviceId ?? null,
            body.tlsPin ?? null,
            // A fingerprint the owner entered is confirmed by entering it.
            body.tlsPin ? nowIso : null,
            body.tlsPin ? nowIso : null,
            nowIso,
            nowIso,
          );
      });
    } catch (err) {
      await this.#secrets.delete(ref).catch(() => false);
      throw err;
    }
    const row = this.#row(accountId, id);
    await this.#auditAppend(accountId, 'device.oob.endpoint.create', id, {
      after: this.#auditFields(row),
    });
    await this.#endpointEvent(accountId, row, 'created');
    return this.#view(row);
  }

  #auditFields(row: EndpointRow): Json {
    return {
      name: row.name,
      kind: row.kind,
      address: row.address,
      port: row.port,
      systemId: row.system_id,
      deviceId: row.device_id,
      tlsPin: row.tls_pin,
      tlsPinConfirmed: row.tls_pin_confirmed_at !== null,
    };
  }

  async update(accountId: string, id: string, input: unknown): Promise<OobEndpointView> {
    await this.#owner(accountId, 'endpoint.update');
    await this.#enabled(accountId, 'endpoint.update', id);
    const body = updateOobEndpointSchema.parse(input);
    const before = this.#row(accountId, id);
    if (before.kind === 'amt') throw amtNotBuilt();
    let host = before.address;
    let port = body.port === undefined ? before.port : body.port;
    if (body.address !== undefined) {
      const addr = parseOobAddress(body.address, before.kind, this.#addressPolicy);
      host = addr.host;
      if (addr.port !== null) {
        if (body.port !== undefined && body.port !== null && body.port !== addr.port)
          throw new NovaError('validation', 'the address and the port name different ports');
        port = addr.port;
      }
    }
    if (before.kind === 'ipmi' && (body.systemId || body.tlsPin))
      throw new NovaError('validation', 'systemId and tlsPin are for Redfish endpoints only');
    if (body.deviceId !== undefined) this.#checkDevice(accountId, body.deviceId);
    // Another address is another BMC: its certificate is pinned anew unless one was given.
    const moved = host !== before.address || port !== before.port;
    let pin = before.tls_pin;
    let pinnedAt = before.tls_pinned_at;
    let confirmedAt = before.tls_pin_confirmed_at;
    const nowIso = this.#now().toISOString();
    if (body.tlsPin !== undefined) {
      pin = body.tlsPin;
      pinnedAt = body.tlsPin ? nowIso : null;
      confirmedAt = body.tlsPin ? nowIso : null;
    } else if (moved) {
      pin = null;
      pinnedAt = null;
      confirmedAt = null;
    }
    if (body.credentials)
      await this.#secrets.put(before.credential_ref, JSON.stringify(body.credentials));
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE oob_endpoint SET name = ?, address = ?, port = ?, system_id = ?, device_id = ?,
             tls_pin = ?, tls_pinned_at = ?, tls_pin_confirmed_at = ?, last_check_at = ?,
             last_check_ok = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND account_id = ?`,
        )
        .run(
          body.name ?? before.name,
          host,
          port,
          body.systemId === undefined ? before.system_id : body.systemId,
          body.deviceId === undefined ? before.device_id : body.deviceId,
          pin,
          pinnedAt,
          confirmedAt,
          moved ? null : before.last_check_at,
          moved ? null : before.last_check_ok,
          moved ? null : before.last_error,
          nowIso,
          id,
          accountId,
        );
    });
    const after = this.#row(accountId, id);
    await this.#auditAppend(accountId, 'device.oob.endpoint.update', id, {
      before: this.#auditFields(before),
      after: this.#auditFields(after),
      ...(body.credentials ? { credentials: 'replaced' } : {}),
    });
    await this.#endpointEvent(accountId, after, 'updated');
    // A card or an approved plan names the endpoint as it was: an edit withdraws them, so an
    // approval never runs against another BMC, name, system, pin or set of credentials.
    await this.#withdraw(
      this.#db.raw
        .prepare(
          "SELECT * FROM oob_action WHERE endpoint_id = ? AND status IN ('awaiting_approval', 'approved')",
        )
        .all(id) as unknown as ActionRow[],
      'endpoint_changed',
      'the endpoint was changed after the approval was asked',
      'cancelled',
    );
    return this.#view(after);
  }

  /**
   * The owner confirms the certificate fingerprint a first `check` read (SSH-style: the key is
   * shown, the owner accepts it, and only then is the password sent). The fingerprint in the body
   * must be the one stored, so a certificate that changed in between is not confirmed.
   */
  async confirmPin(accountId: string, id: string, input: unknown): Promise<OobEndpointView> {
    await this.#owner(accountId, 'pin.confirm');
    await this.#enabled(accountId, 'pin.confirm', id);
    const body = confirmOobPinSchema.parse(input);
    const row = this.#row(accountId, id);
    if (row.kind !== 'redfish')
      throw new NovaError('validation', 'only a Redfish BMC has a certificate to confirm');
    if (!row.tls_pin)
      throw new NovaError('conflict', 'no fingerprint yet: run check first', {
        details: { reason: 'no_pin' },
      });
    if (row.tls_pin !== body.tlsPin)
      throw new NovaError('conflict', 'the BMC certificate is not the one you confirmed', {
        details: { reason: 'pin_changed', tlsPin: row.tls_pin },
      });
    if (!row.tls_pin_confirmed_at) {
      const nowIso = this.#now().toISOString();
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            'UPDATE oob_endpoint SET tls_pin_confirmed_at = ?, updated_at = ? WHERE id = ? AND tls_pin = ?',
          )
          .run(nowIso, nowIso, id, body.tlsPin);
      });
      await this.#auditAppend(
        accountId,
        'device.oob.pin',
        id,
        { endpoint: row.name, address: row.address, tlsPin: body.tlsPin, confirmed: true },
        { decision: 'confirmed' },
      );
      await this.#endpointEvent(accountId, row, 'pin_confirmed');
    }
    return this.#view(this.#row(accountId, id));
  }

  /** Delete an endpoint and its credentials (allowed while the setting is off). */
  async remove(accountId: string, id: string): Promise<void> {
    await this.#owner(accountId, 'endpoint.delete');
    const row = this.#row(accountId, id);
    const nowIso = this.#now().toISOString();
    const open = this.#db.raw
      .prepare(
        "SELECT approval_id FROM oob_action WHERE endpoint_id = ? AND status = 'awaiting_approval' AND approval_id IS NOT NULL",
      )
      .all(id) as { approval_id: string }[];
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE oob_action SET status = 'expired', error_code = 'conflict',
             error_reason = 'endpoint_deleted', error_message = 'the endpoint was deleted',
             finished_at = ?
           WHERE endpoint_id = ? AND status IN ('awaiting_approval', 'approved')`,
        )
        .run(nowIso, id);
      for (const a of open)
        this.#db.raw
          .prepare("UPDATE approval SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
          .run(a.approval_id);
      this.#db.raw.prepare('DELETE FROM oob_endpoint WHERE id = ?').run(id);
    });
    await this.#secrets.delete(row.credential_ref).catch(() => false);
    for (const a of open)
      await this.#emit(accountId, 'approval.cancelled', {
        approvalId: a.approval_id,
        reason: 'endpoint_deleted',
      });
    await this.#auditAppend(accountId, 'device.oob.endpoint.delete', id, {
      before: this.#auditFields(row),
    });
    await this.#endpointEvent(accountId, row, 'deleted');
  }

  // ---- actions ---------------------------------------------------------------------------------

  #actionRow(accountId: string, id: string): ActionRow {
    const row = this.#db.raw
      .prepare('SELECT * FROM oob_action WHERE id = ? AND account_id = ?')
      .get(id, accountId) as ActionRow | undefined;
    if (!row) throw new NovaError('not_found', 'no such out-of-band action');
    return row;
  }

  #actionView(r: ActionRow): OobActionView {
    return {
      id: r.id,
      endpointId: r.endpoint_id,
      endpointName: r.endpoint_name,
      action: r.action,
      params: (parse(r.params_json) ?? {}) as Record<string, unknown>,
      status: r.status,
      approvalId: r.approval_id,
      planId: r.plan_id,
      before: parse(r.before_json),
      after: parse(r.after_json),
      result: parse(r.result_json),
      error: r.error_code
        ? { code: r.error_code, reason: r.error_reason, message: r.error_message ?? '' }
        : null,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
      finishedAt: r.finished_at,
    };
  }

  async listActions(
    accountId: string,
    q: { endpointId?: string; limit?: number } = {},
  ): Promise<OobActionView[]> {
    await this.#owner(accountId, 'action.list');
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = (q.endpointId
      ? this.#db.raw
          .prepare(
            'SELECT * FROM oob_action WHERE account_id = ? AND endpoint_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          )
          .all(accountId, q.endpointId, limit)
      : this.#db.raw
          .prepare(
            'SELECT * FROM oob_action WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          )
          .all(accountId, limit)) as unknown as ActionRow[];
    return rows.map((r) => this.#actionView(r));
  }

  async getAction(accountId: string, id: string): Promise<OobActionView> {
    await this.#owner(accountId, 'action.get');
    return this.#actionView(this.#actionRow(accountId, id));
  }

  /**
   * Ask for an action. Read actions (`check`, `power.status`, `sensors`, `bios.read`) run now and
   * come back `done` (or throw). `bios.apply` runs now on an approved plan. Every other action files
   * an approval card and comes back `awaiting_approval` (`pending: true`); it runs when the owner
   * allows it (`onApprovalDecided`). A `bios.plan` is the dry run whose card shows the diff.
   */
  async act(
    accountId: string,
    endpointId: string,
    action: OobAction,
    input: unknown,
  ): Promise<{ pending: boolean; action: OobActionView }> {
    await this.#owner(accountId, action);
    const ep = this.#row(accountId, endpointId);
    await this.#enabled(accountId, action, ep.id);
    if (ep.kind === 'amt') throw amtNotBuilt();
    const params = OOB_ACTION_BODY_SCHEMAS[action].parse(input ?? {});
    if (ep.kind === 'ipmi' && action.startsWith('bios.')) throw notSupportedByIpmi('BIOS settings');
    if (ep.kind === 'ipmi' && action === 'boot.next' && params.target === 'usb')
      throw notSupportedByIpmi('A one-time USB boot');
    // Credentials go to a Redfish BMC only after its pin is confirmed: until then only `check`.
    if (ep.kind === 'redfish' && action !== 'check') this.#assertPinConfirmed(ep);
    if (!oobActionNeedsApproval(action)) {
      const row = await this.#insertAction(ep, action, params, 'running');
      const done = await this.#run(ep, row);
      return { pending: false, action: this.#actionView(done) };
    }
    if (action === 'bios.apply')
      return { pending: false, action: await this.#applyPlan(ep, params) };
    if (action === 'bios.plan') return { pending: true, action: await this.#plan(ep, params) };
    const row = await this.#fileApproval(ep, action, params, null, null);
    return { pending: true, action: this.#actionView(row) };
  }

  /**
   * What an approval covers: the action, its parameters and the BMC as it was when the card was
   * asked (address, port, system, certificate pin). Any of them changing voids the approval.
   */
  #paramsHash(ep: EndpointRow, action: OobAction, params: Json): string {
    return sha256(
      canonicalJson({
        endpointId: ep.id,
        action,
        params,
        target: {
          kind: ep.kind,
          address: ep.address,
          port: ep.port,
          systemId: ep.system_id,
          tlsPin: ep.tls_pin,
          tlsPinConfirmedAt: ep.tls_pin_confirmed_at,
        },
      }),
    );
  }

  #assertPinConfirmed(ep: EndpointRow): void {
    if (ep.tls_pin && ep.tls_pin_confirmed_at) return;
    throw new NovaError(
      'conflict',
      ep.tls_pin
        ? 'confirm the BMC certificate fingerprint first: no credentials are sent before that'
        : 'check the BMC first, then confirm its certificate fingerprint',
      { details: { reason: 'pin_unconfirmed', tlsPin: ep.tls_pin } },
    );
  }

  async #insertAction(
    ep: EndpointRow,
    action: OobAction,
    params: Json,
    status: OobActionStatus,
    extra: { planId?: string } = {},
  ): Promise<ActionRow> {
    const id = uuidv7();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO oob_action (id, account_id, endpoint_id, endpoint_name, action, params_json,
             params_hash, status, plan_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ep.account_id,
          ep.id,
          ep.name,
          action,
          JSON.stringify(params),
          this.#paramsHash(ep, action, params),
          status,
          extra.planId ?? null,
          this.#now().toISOString(),
        );
    });
    return this.#actionRow(ep.account_id, id);
  }

  /** File the approval card and the waiting action in one transaction. */
  async #fileApproval(
    ep: EndpointRow,
    action: OobAction,
    params: Json,
    plan: OobBiosPlanView | null,
    before: unknown,
    actionId: string = uuidv7(),
  ): Promise<ActionRow> {
    const approvalId = uuidv7();
    const now = this.#now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + OOB_APPROVAL_TTL_MS).toISOString();
    const where = `${cardText(ep.name)} (${ep.address}${ep.port ? `:${ep.port}` : ''})`;
    // The warning comes first, so no value can push it out of the card.
    const degrading = plan?.diff.some((d) => d.securityDegrading) ?? false;
    let summary = `${degrading ? 'Weakens security: ' : ''}${ACTION_WORDS[action]} ${where} through its BMC`;
    if (action === 'boot.next')
      summary += `: ${str(params.target) ?? ''} once${str(params.mode) ? ` (${str(params.mode)})` : ''}`;
    if (plan)
      summary += `: ${plan.diff
        .map(
          (d) => `${d.key} ${d.from === null ? '(unset)' : cardText(d.from)} -> ${cardText(d.to)}`,
        )
        .join(', ')}; applied at the next reboot`;
    const paramsHash = this.#paramsHash(ep, action, params);
    const argsPreview = JSON.stringify({
      endpoint: ep.name,
      address: ep.address,
      kind: ep.kind,
      action,
      params,
      ...(plan
        ? {
            diff: plan.diff.map((d) => ({
              ...d,
              from: d.from === null ? null : cardText(d.from),
            })),
          }
        : {}),
    });
    const reason =
      'Out-of-band action asked by the owner. It acts on the hardware even when its operating system is down.';
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(schema.approval).values({
        id: approvalId,
        accountId: ep.account_id,
        toolCallId: null,
        threadId: null,
        turnId: null,
        runId: null,
        agentId: null,
        toolName: `oob.${action}`,
        requestedAction: summary.slice(0, 1000),
        argsPreview,
        argsHash: paramsHash,
        reason,
        scope: `oob:${ep.id}`,
        risk: 'high',
        // Answered only in a Nova client, never from a channel (FR-189), and only by the
        // signed-in user: never a link or a hook (docs/23 §6.3).
        tier: 'confirm_at_action',
        answerIn: 'hub',
        userAsked: true,
        optionsJson: JSON.stringify(['allow_once', 'deny_continue']),
        alwaysScopesJson: '[]',
        status: 'pending',
        createdAt: nowIso,
        expiresAt,
      });
      this.#db.raw
        .prepare(
          `INSERT INTO oob_action (id, account_id, endpoint_id, endpoint_name, action, params_json,
             params_hash, status, approval_id, before_json, result_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?, ?)`,
        )
        .run(
          actionId,
          ep.account_id,
          ep.id,
          ep.name,
          action,
          JSON.stringify(params),
          paramsHash,
          approvalId,
          before === null || before === undefined ? null : JSON.stringify(before),
          plan ? JSON.stringify(plan) : null,
          nowIso,
          expiresAt,
        );
    });
    const row = this.#actionRow(ep.account_id, actionId);
    await this.#emit(ep.account_id, 'approval.requested', {
      approvalId,
      callId: null,
      action: summary.slice(0, 500),
      reason,
      scope: `oob:${ep.id}`,
      risk: 'high',
      tier: 'confirm_at_action',
    });
    await this.#actionEvent(ep, row);
    await this.#auditAction(ep, row, 'requested', {
      ...(plan ? { diff: plan.diff, snapshotSha256: plan.snapshot.sha256 } : {}),
    });
    if (this.#notifier)
      await this.#notifier
        .notify({
          accountId: ep.account_id,
          kind: 'approval',
          title: 'Out-of-band action needs your approval',
          body: summary.slice(0, 200),
          href: `/approvals/${approvalId}`,
          dedupeKey: `approval:${approvalId}`,
        })
        .catch((err: unknown) =>
          this.#log.warn('out-of-band approval notification failed', { err }),
        );
    return row;
  }

  /**
   * An approval card was answered (`approval.decided`). The card's row is the authority, not the
   * event: only `allow_once` on a card that is still within its time runs the action.
   */
  async onApprovalDecided(accountId: string, approvalId: string): Promise<void> {
    const row = this.#db.raw
      .prepare(
        "SELECT * FROM oob_action WHERE account_id = ? AND approval_id = ? AND status = 'awaiting_approval'",
      )
      .get(accountId, approvalId) as ActionRow | undefined;
    if (!row) return;
    const ap = this.#db.raw
      .prepare(
        'SELECT status, decision, decided_by, args_hash FROM approval WHERE id = ? AND account_id = ?',
      )
      .get(approvalId, accountId) as
      | {
          status: string;
          decision: string | null;
          decided_by: string | null;
          args_hash: string | null;
        }
      | undefined;
    if (!ap || ap.status === 'pending') return;
    const now = this.#now();
    const nowIso = now.toISOString();
    const ep = row.endpoint_id
      ? (this.#db.raw.prepare('SELECT * FROM oob_endpoint WHERE id = ?').get(row.endpoint_id) as
          EndpointRow | undefined)
      : undefined;
    // Only the signed-in owner's own "Allow once" counts: never a hook, a rule or a channel.
    const byUser = ap.decided_by === 'user';
    const allowed = ap.status === 'decided' && ap.decision === 'allow_once' && byUser;
    const late = row.expires_at !== null && now.getTime() > Date.parse(row.expires_at);
    const settle = async (
      status: OobActionStatus,
      decision: string,
      error: { reason: string; message: string } | null,
      expiresAt: string | null = row.expires_at,
    ): Promise<ActionRow | null> => {
      const changed = await this.#db.transaction(
        () =>
          this.#db.raw
            .prepare(
              `UPDATE oob_action SET status = ?, decided_at = ?, expires_at = ?, error_code = ?,
                 error_reason = ?, error_message = ?, finished_at = ?
               WHERE id = ? AND status = 'awaiting_approval'`,
            )
            .run(
              status,
              nowIso,
              expiresAt,
              error ? 'policy_denied' : null,
              error?.reason ?? null,
              error?.message ?? null,
              status === 'approved' || status === 'running' ? null : nowIso,
              row.id,
            ).changes,
      );
      if (Number(changed) === 0) return null;
      const next = this.#actionRow(accountId, row.id);
      if (ep) {
        await this.#actionEvent(ep, next);
        await this.#auditAction(ep, next, decision);
      }
      return next;
    };
    if (!allowed) {
      const expired = ap.decision === 'timeout' || ap.status === 'expired';
      await settle(
        expired ? 'expired' : 'denied',
        expired ? 'expired' : 'denied',
        expired
          ? { reason: 'approval_expired', message: 'the approval expired' }
          : ap.decision === 'allow_once' && !byUser
            ? {
                reason: 'approval_not_by_user',
                message: "only the owner's own answer in Nova runs an out-of-band action",
              }
            : { reason: 'approval_denied', message: 'the owner denied the action' },
      );
      return;
    }
    if (!ep) {
      await settle('expired', 'expired', {
        reason: 'endpoint_deleted',
        message: 'the endpoint was deleted',
      });
      return;
    }
    if (late) {
      await settle('expired', 'expired', {
        reason: 'approval_expired',
        message: 'the approval came after the action expired',
      });
      return;
    }
    const params = (parse(row.params_json) ?? {}) as Json;
    if (
      ap.args_hash !== row.params_hash ||
      this.#paramsHash(ep, row.action, params) !== row.params_hash
    ) {
      await settle('failed', 'failed', {
        reason: 'approval_mismatch',
        message: 'the approval does not cover this action on this BMC as it is now',
      });
      return;
    }
    if (row.action === 'bios.plan') {
      // An approved plan can be applied for the next 10 minutes.
      await settle(
        'approved',
        'approved',
        null,
        new Date(now.getTime() + OOB_APPROVAL_TTL_MS).toISOString(),
      );
      return;
    }
    const running = await settle('running', 'approved', null);
    if (!running) return;
    try {
      await this.#owner(accountId, row.action);
      await this.#enabled(accountId, row.action, ep.id);
    } catch (err) {
      await this.#finish(ep, running, null, err);
      return;
    }
    await this.#run(ep, running).catch(() => undefined);
  }

  /** Run a recorded action now and record its outcome; failures are recorded, then thrown. */
  async #run(ep: EndpointRow, row: ActionRow): Promise<ActionRow> {
    const params = (parse(row.params_json) ?? {}) as Json;
    let outcome: Outcome;
    try {
      outcome = await this.#perform(ep, row.action, params);
    } catch (err) {
      await this.#finish(ep, row, null, err);
      throw err;
    }
    return this.#finish(ep, row, outcome, null);
  }

  async #finish(
    ep: EndpointRow,
    row: ActionRow,
    outcome: Outcome | null,
    err: unknown,
  ): Promise<ActionRow> {
    const nowIso = this.#now().toISOString();
    const code = err ? (isNovaError(err) ? err.code : 'server_error') : null;
    const reason = err ? reasonOf(err) : null;
    const message = err ? errorMessage(err) : null;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE oob_action SET status = ?, before_json = coalesce(?, before_json), after_json = ?,
             result_json = coalesce(?, result_json), error_code = ?, error_reason = ?,
             error_message = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          err ? 'failed' : 'done',
          outcome?.before === undefined ? null : JSON.stringify(outcome.before),
          outcome?.after === undefined ? null : JSON.stringify(outcome.after),
          outcome ? JSON.stringify(outcome.result) : null,
          code,
          reason,
          message,
          nowIso,
          row.id,
        );
      const check = row.action === 'check';
      this.#db.raw
        .prepare(
          `UPDATE oob_endpoint SET last_error = ?,
             last_check_at = CASE WHEN ? THEN ? ELSE last_check_at END,
             last_check_ok = CASE WHEN ? THEN ? ELSE last_check_ok END
           WHERE id = ?`,
        )
        .run(message, check ? 1 : 0, nowIso, check ? 1 : 0, err ? 0 : 1, ep.id);
    });
    if (reason === 'tls_pin_mismatch' && isNovaError(err)) {
      await this.#auditAppend(
        ep.account_id,
        'device.oob.pin_mismatch',
        ep.id,
        {
          endpoint: ep.name,
          address: ep.address,
          expected: err.details?.expected ?? null,
          presented: err.details?.presented ?? null,
          actionId: row.id,
        },
        { decision: 'denied' },
      );
      await this.#endpointEvent(ep.account_id, ep, 'pin_mismatch');
    }
    const done = this.#actionRow(ep.account_id, row.id);
    await this.#actionEvent(ep, done);
    await this.#auditAction(ep, done, err ? 'failed' : 'done');
    return done;
  }

  // ---- BIOS plans ------------------------------------------------------------------------------

  async #firmwareOn(): Promise<void> {
    if (await this.#settings.firmwareAllowChanges()) return;
    throw new NovaError(
      'firmware_disabled',
      'BIOS/firmware changes are off: turn on "Allow BIOS/firmware changes" first',
      { details: { reason: 'firmware_changes_off' } },
    );
  }

  /** The dry run: read, diff, and file the card that shows the diff. Nothing is written. */
  async #plan(ep: EndpointRow, params: Json): Promise<OobActionView> {
    await this.#firmwareOn();
    const changes = params.changes as { key: OobBiosKey; value: string }[];
    const wantsDegrading = params.allowSecurityDegrading === true;
    const allowDegrading =
      wantsDegrading && (await this.#settings.firmwareAllowSecurityDegrading());
    const actionId = uuidv7();
    let read: BiosRead;
    let p: ReturnType<typeof planBios>;
    try {
      read = await this.#readBios(ep);
      if (!read.entry)
        throw bmcError('unsupported_hardware', read.reason ?? 'unsupported hardware', {
          detail: read.reason,
        });
      if (!read.settingsPath)
        throw bmcError('unsupported_hardware', 'the BMC offers no pending BIOS settings object', {
          detail: 'no @Redfish.Settings on the Bios resource',
        });
      p = planBios(read.entry, read.attributes, changes, allowDegrading);
      if (p.diff.length === 0)
        throw new NovaError('conflict', 'nothing to change', {
          details: { reason: 'nothing_to_change', refused: p.refused },
        });
    } catch (err) {
      // A plan that could not be made is still on the record (and audited).
      const row = await this.#insertAction(ep, 'bios.plan', params, 'running');
      await this.#finish(ep, row, null, err);
      throw err;
    }
    const plan: OobBiosPlanView = {
      planId: actionId,
      vendor: read.entry.label,
      snapshot: { takenAt: this.#now().toISOString(), ...p.snapshot },
      diff: p.diff,
      refused: p.refused,
      requiresReboot: true,
      allowSecurityDegrading: p.diff.some((d) => d.securityDegrading),
    };
    const row = await this.#fileApproval(
      ep,
      'bios.plan',
      params,
      plan,
      p.snapshot.values,
      actionId,
    );
    return this.#actionView(row);
  }

  async #applyPlan(ep: EndpointRow, params: Json): Promise<OobActionView> {
    const accountId = ep.account_id;
    const planId = String(params.planId);
    const planRow = this.#db.raw
      .prepare(
        "SELECT * FROM oob_action WHERE id = ? AND account_id = ? AND endpoint_id = ? AND action = 'bios.plan'",
      )
      .get(planId, accountId, ep.id) as ActionRow | undefined;
    if (!planRow) throw new NovaError('not_found', 'no such BIOS plan for this endpoint');
    if (planRow.status === 'applied')
      throw new NovaError('conflict', 'this plan was applied already', {
        details: { reason: 'plan_used' },
      });
    if (planRow.status === 'failed' || planRow.status === 'expired')
      throw new NovaError(
        'conflict',
        'this plan can no longer be applied; read the BIOS and plan again',
        {
          details: { reason: `plan_${planRow.status}`, cause: planRow.error_reason },
        },
      );
    if (planRow.status !== 'approved')
      throw new NovaError('approval_required', 'the BIOS plan needs your approval first', {
        details: { approvalId: planRow.approval_id, status: planRow.status },
      });
    const now = this.#now();
    if (planRow.expires_at && now.getTime() > Date.parse(planRow.expires_at)) {
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            "UPDATE oob_action SET status = 'expired', finished_at = ? WHERE id = ? AND status = 'approved'",
          )
          .run(now.toISOString(), planRow.id);
      });
      throw new NovaError('conflict', 'the approved plan expired; plan again', {
        details: { reason: 'plan_expired' },
      });
    }
    const plan = parse(planRow.result_json) as OobBiosPlanView;
    // The plan was approved for the BMC as it was (address, port, system, pin).
    if (
      this.#paramsHash(ep, 'bios.plan', (parse(planRow.params_json) ?? {}) as Json) !==
      planRow.params_hash
    )
      throw new NovaError(
        'conflict',
        'the endpoint changed since the plan was approved; plan again',
        {
          details: { reason: 'plan_target_changed' },
        },
      );
    await this.#firmwareOn();
    if (
      plan.diff.some((d) => d.securityDegrading) &&
      !(await this.#settings.firmwareAllowSecurityDegrading())
    )
      throw new NovaError('policy_denied', 'security-degrading BIOS changes are not allowed', {
        details: { reason: 'security_degrading' },
      });
    // Claim the plan before touching the BMC: one plan, one apply.
    const claimed = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare("UPDATE oob_action SET status = 'applied' WHERE id = ? AND status = 'approved'")
          .run(planRow.id).changes,
    );
    if (Number(claimed) === 0)
      throw new NovaError('conflict', 'this plan was applied already', {
        details: { reason: 'plan_used' },
      });
    const row = await this.#insertAction(ep, 'bios.apply', params, 'running', { planId });
    let outcome: Outcome;
    const progress = { patched: false };
    try {
      outcome = await this.#writeBios(ep, plan, progress);
    } catch (err) {
      await this.#db.transaction(() => {
        if (progress.patched)
          // The PATCH went out: the BMC may hold some or all of it. Never retried as it is: the
          // owner reads the BIOS again and makes a new plan.
          this.#db.raw
            .prepare(
              `UPDATE oob_action SET status = 'failed', error_code = 'conflict',
                 error_reason = 'apply_outcome_unknown',
                 error_message = 'the BMC may have taken part of the change; read the BIOS and plan again',
                 finished_at = ?
               WHERE id = ? AND status = 'applied'`,
            )
            .run(this.#now().toISOString(), planRow.id);
        // Before the PATCH nothing was written: the approved plan may be retried.
        else
          this.#db.raw
            .prepare(
              "UPDATE oob_action SET status = 'approved' WHERE id = ? AND status = 'applied'",
            )
            .run(planRow.id);
      });
      await this.#finish(ep, row, null, err);
      if (progress.patched) await this.#actionEvent(ep, this.#actionRow(accountId, planRow.id));
      throw err;
    }
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE oob_action SET finished_at = ? WHERE id = ?')
        .run(this.#now().toISOString(), planRow.id);
    });
    const done = await this.#finish(ep, row, outcome, null);
    await this.#actionEvent(ep, this.#actionRow(accountId, planRow.id));
    return this.#actionView(done);
  }

  // ---- protocol work ---------------------------------------------------------------------------

  async #credentials(ep: EndpointRow): Promise<RedfishCredentials> {
    const raw = await this.#secrets.get(ep.credential_ref);
    let creds: RedfishCredentials | null = null;
    try {
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      if (isJson(v) && typeof v.username === 'string' && typeof v.password === 'string')
        creds = { username: v.username, password: v.password };
    } catch {
      creds = null;
    }
    if (!creds)
      throw new NovaError('conflict', 'the endpoint has no credentials; enter them again', {
        details: { reason: 'credentials_missing' },
      });
    // The vault registers the stored JSON as one literal. The password alone joins the global
    // redactor only when it is long enough not to be a common word (a default `ADMIN` or
    // `calvin` would otherwise be masked in every log line); messages from the BMC and ipmitool
    // have it taken out locally when it has at least 4 characters (`withoutSecret`: a shorter one
    // would cut up every message that happens to contain those letters).
    if (creds.password.length >= 8) defaultRedactor.addLiteral(creds.password);
    return creds;
  }

  #endpointNow(ep: EndpointRow): EndpointRow {
    return (
      (this.#db.raw.prepare('SELECT * FROM oob_endpoint WHERE id = ?').get(ep.id) as
        EndpointRow | undefined) ?? ep
    );
  }

  /** The checked address to connect to (every resolved address checked, then pinned). */
  async #connectTo(ep: EndpointRow): Promise<string> {
    return resolveBmcAddress(ep.address, this.#addressPolicy, this.#resolveHost);
  }

  /**
   * The BMC's service root on a pinned connection. The first use reads the certificate pin with
   * a handshake only and keeps it unconfirmed (SSH-style): no credentials are sent until the
   * owner confirms it (`confirmPin`). Returns no client while the pin is unconfirmed.
   */
  async #redfishRoot(ep: EndpointRow): Promise<RedfishRoot> {
    const port = ep.port ?? REDFISH_DEFAULT_PORT;
    const connectTo = await this.#connectTo(ep);
    let pin = ep.tls_pin;
    let confirmed = pin !== null && ep.tls_pin_confirmed_at !== null;
    if (!pin) {
      let presented: string;
      try {
        presented = await this.#transport.peerPin(ep.address, port, this.#timeoutMs, connectTo);
      } catch (err) {
        if (err instanceof OobTransportError) throw bmcError(`bmc_${err.failure}`, err.message);
        throw err;
      }
      const nowIso = this.#now().toISOString();
      const changed = await this.#db.transaction(
        () =>
          this.#db.raw
            .prepare(
              `UPDATE oob_endpoint SET tls_pin = ?, tls_pinned_at = ?, tls_pin_confirmed_at = NULL,
                 updated_at = ?
               WHERE id = ? AND tls_pin IS NULL`,
            )
            .run(presented, nowIso, nowIso, ep.id).changes,
      );
      if (Number(changed) === 1) {
        await this.#auditAppend(
          ep.account_id,
          'device.oob.pin',
          ep.id,
          { endpoint: ep.name, address: ep.address, tlsPin: presented, firstUse: true },
          { decision: 'unconfirmed' },
        );
        await this.#endpointEvent(ep.account_id, { ...ep, tls_pin: presented }, 'pinned');
        pin = presented;
        confirmed = false;
      } else {
        const now = this.#db.raw
          .prepare('SELECT tls_pin, tls_pin_confirmed_at FROM oob_endpoint WHERE id = ?')
          .get(ep.id) as
          { tls_pin: string | null; tls_pin_confirmed_at: string | null } | undefined;
        pin = now?.tls_pin ?? presented;
        confirmed = now?.tls_pin === pin && now.tls_pin_confirmed_at !== null;
      }
    }
    // Read without credentials on a pinned connection: it proves the pin before any are sent.
    const root = await redfishServiceRoot(
      this.#transport,
      { host: ep.address, connectTo, port, pin },
      this.#timeoutMs,
    );
    return { root, pin, confirmed, connectTo, port };
  }

  /** A client with credentials, only for a BMC whose pin the owner confirmed. */
  async #redfish(
    ep: EndpointRow,
    known?: RedfishRoot,
  ): Promise<{ client: RedfishClient; root: Json; pin: string }> {
    this.#assertPinConfirmed(ep);
    const r = known ?? (await this.#redfishRoot(ep));
    if (!r.confirmed) this.#assertPinConfirmed({ ...ep, tls_pin_confirmed_at: null });
    const client = new RedfishClient({
      host: ep.address,
      connectTo: r.connectTo,
      port: r.port,
      pin: r.pin,
      credentials: await this.#credentials(ep),
      transport: this.#transport,
      timeoutMs: this.#timeoutMs,
    });
    return { client, root: r.root, pin: r.pin };
  }

  async #ipmiTarget(ep: EndpointRow): Promise<IpmiTarget> {
    // ipmitool gets the checked address, never a name it would resolve again.
    return {
      host: await this.#connectTo(ep),
      port: ep.port,
      credentials: await this.#credentials(ep),
    };
  }

  async #systems(client: RedfishClient, root: Json): Promise<string[]> {
    const path = redfishPath(odataId(root.Systems) ?? '/redfish/v1/Systems');
    const { json } = await client.get(path);
    const members = Array.isArray(json.Members) ? json.Members : [];
    return members.map((m) => odataId(m)).filter((m): m is string => m !== null);
  }

  /** The ComputerSystem to manage: the one named by `systemId`, or the only one. */
  async #system(
    ep: EndpointRow,
    client: RedfishClient,
    root: Json,
  ): Promise<{ path: string; json: Json; etag: string | null }> {
    const members = await this.#systems(client, root);
    const idOf = (m: string) => m.replace(/\/$/, '').split('/').pop() ?? m;
    const pick = ep.system_id
      ? members.find((m) => idOf(m) === ep.system_id)
      : members.length === 1
        ? members[0]
        : undefined;
    if (!pick)
      throw bmcError(
        members.length === 0 ? 'no_system' : ep.system_id ? 'system_not_found' : 'system_ambiguous',
        members.length > 1 && !ep.system_id
          ? 'the BMC manages several systems: choose one (systemId)'
          : 'the BMC lists no such system',
        { systems: members.map(idOf) },
      );
    const path = redfishPath(pick);
    const { json, etag } = await client.get(path);
    return { path, json, etag };
  }

  async #readBios(ep: EndpointRow): Promise<BiosRead> {
    const { client, root } = await this.#redfish(ep);
    const sys = await this.#system(ep, client, root);
    const biosPath = odataId(sys.json.Bios);
    if (!biosPath)
      throw bmcError('unsupported_hardware', 'the BMC exposes no BIOS settings for this system', {
        detail: 'no Bios resource',
      });
    const bios = await client.get(redfishPath(biosPath));
    const names = [str(root.Vendor), str(sys.json.Manufacturer)];
    const vendorName = names.find((n) => n) ?? null;
    const match = biosVendorFor(names);
    const attributes = isJson(bios.json.Attributes) ? bios.json.Attributes : {};
    const settings = isJson(bios.json['@Redfish.Settings']) ? bios.json['@Redfish.Settings'] : null;
    const settingsId = settings ? odataId(settings.SettingsObject) : null;
    let pending: Json = {};
    let settingsEtag: string | null = null;
    if (settingsId) {
      const s = await client.get(redfishPath(settingsId));
      pending = isJson(s.json.Attributes) ? s.json.Attributes : {};
      settingsEtag = s.etag;
    }
    return {
      client,
      entry: match.entry,
      reason: match.entry ? null : match.reason,
      vendorName,
      attributes,
      pending,
      settingsPath: settingsId ? redfishPath(settingsId) : null,
      settingsEtag,
      applyTimes: settings ? strings(settings.SupportedApplyTimes) : null,
    };
  }

  async #writeBios(
    ep: EndpointRow,
    plan: OobBiosPlanView,
    progress: { patched: boolean },
  ): Promise<Outcome> {
    const read = await this.#readBios(ep);
    if (!read.entry || !read.settingsPath)
      throw bmcError(
        'unsupported_hardware',
        read.reason ?? 'the BMC offers no pending BIOS settings',
      );
    const current = biosSnapshot(read.entry, read.attributes);
    if (current.sha256 !== plan.snapshot.sha256)
      throw new NovaError('conflict', 'the BIOS settings changed since the plan; plan again', {
        details: { reason: 'base_mismatch' },
      });
    const attributes: Json = {};
    for (const d of plan.diff) attributes[d.vendorKey] = d.to;
    // From here on a failure is not "nothing written": the BMC may have taken the request.
    progress.patched = true;
    await read.client.patch(
      read.settingsPath,
      {
        Attributes: attributes,
        ...(read.applyTimes?.includes('OnReset')
          ? { '@Redfish.SettingsApplyTime': { ApplyTime: 'OnReset' } }
          : {}),
      },
      read.settingsEtag,
    );
    const after = await read.client.get(read.settingsPath);
    const pending = isJson(after.json.Attributes) ? after.json.Attributes : {};
    const afterValues: Record<string, string | null> = {};
    for (const d of plan.diff) afterValues[d.key] = str(pending[d.vendorKey]);
    return {
      before: plan.snapshot.values,
      after: afterValues,
      result: {
        applied: plan.diff.map((d) => ({ key: d.key, from: d.from, to: d.to })),
        pending: afterValues,
        pendingReboot: true,
      },
    };
  }

  async #perform(ep: EndpointRow, action: OobAction, params: Json): Promise<Outcome> {
    if (ep.kind === 'amt') throw amtNotBuilt();
    return ep.kind === 'ipmi'
      ? this.#performIpmi(ep, action, params)
      : this.#performRedfish(ep, action, params);
  }

  async #performIpmi(ep: EndpointRow, action: OobAction, params: Json): Promise<Outcome> {
    const t = await this.#ipmiTarget(ep);
    switch (action) {
      case 'check': {
        const s = await this.#ipmi.chassisStatus(t);
        return { result: { protocol: 'ipmi', powerState: s.powerState } };
      }
      case 'power.status':
        return { result: { powerState: await this.#ipmi.powerStatus(t) } };
      case 'power.on':
      case 'power.off':
      case 'power.cycle':
      case 'power.reset': {
        const op = action.slice('power.'.length) as IpmiPowerOp;
        const before = { powerState: await this.#ipmi.powerStatus(t) };
        await this.#ipmi.power(t, op);
        const after = { powerState: await this.#ipmi.powerStatus(t) };
        return { before, after, result: { command: `chassis power ${op}`, before, after } };
      }
      case 'sensors': {
        const sensors: OobSensorView[] = await this.#ipmi.sensors(t);
        return { result: { sensors } };
      }
      case 'boot.next': {
        const target = params.target as OobBootTarget;
        const mode = params.mode as 'uefi' | 'legacy' | undefined;
        const flags = () => this.#ipmi.bootFlags(t).catch(() => null);
        const before = { bootDevice: await flags() };
        await this.#ipmi.bootNext(t, target, mode);
        const after = { bootDevice: await flags() };
        return {
          before,
          after,
          result: {
            target,
            oneTime: true,
            note: 'Many BMCs drop an IPMI boot override if the machine does not restart within 60 seconds: restart it right away.',
          },
        };
      }
      default:
        throw notSupportedByIpmi(action);
    }
  }

  async #performRedfish(ep: EndpointRow, action: OobAction, params: Json): Promise<Outcome> {
    if (action === 'bios.read') {
      const read = await this.#readBios(ep);
      const view: OobBiosReadView = read.entry
        ? {
            supported: true,
            reason: null,
            vendor: read.entry.label,
            settings: biosSettings(read.entry, read.attributes, read.pending),
          }
        : { supported: false, reason: read.reason, vendor: read.vendorName, settings: [] };
      return { result: view };
    }
    if (action === 'check') {
      // Until the owner confirms the fingerprint, check reads only the unauthenticated service
      // root: the credentials stay in the vault.
      const r = await this.#redfishRoot(ep);
      const base = {
        protocol: 'redfish',
        vendor: str(r.root.Vendor),
        product: str(r.root.Product),
        redfishVersion: str(r.root.RedfishVersion),
        tlsPin: r.pin,
        pinConfirmed: r.confirmed,
      };
      if (!r.confirmed) return { result: { ...base, authenticated: false, systems: null } };
      const { client, root } = await this.#redfish(this.#endpointNow(ep), r);
      const systems = await this.#systems(client, root);
      return {
        result: {
          ...base,
          authenticated: true,
          systems: systems.map((m) => m.replace(/\/$/, '').split('/').pop() ?? m),
        },
      };
    }
    const { client, root } = await this.#redfish(ep);
    const sys = await this.#system(ep, client, root);
    switch (action) {
      case 'power.status':
        return { result: { powerState: redfishPower(sys.json.PowerState) } };
      case 'power.on':
      case 'power.off':
      case 'power.cycle':
      case 'power.reset': {
        const op = action.slice('power.'.length) as IpmiPowerOp;
        const resetType = RESET_TYPES[op];
        const actions = isJson(sys.json.Actions) ? sys.json.Actions : {};
        const reset = isJson(actions['#ComputerSystem.Reset'])
          ? actions['#ComputerSystem.Reset']
          : {};
        const allowed = strings(reset['ResetType@Redfish.AllowableValues']);
        if (allowed && !allowed.includes(resetType))
          throw bmcError('unsupported_by_bmc', `this BMC does not offer ${resetType}`, { allowed });
        const target = redfishPath(
          typeof reset.target === 'string'
            ? reset.target
            : `${sys.path}/Actions/ComputerSystem.Reset`,
        );
        const before = { powerState: redfishPower(sys.json.PowerState) };
        await client.post(target, { ResetType: resetType });
        const again = await client.get(sys.path);
        const after = { powerState: redfishPower(again.json.PowerState) };
        return { before, after, result: { resetType, before, after } };
      }
      case 'sensors':
        return { result: { sensors: await this.#redfishSensors(client, root, sys.json) } };
      case 'boot.next': {
        const boot = isJson(sys.json.Boot) ? sys.json.Boot : {};
        const target = BOOT_TARGETS[params.target as OobBootTarget];
        const allowed = strings(boot['BootSourceOverrideTarget@Redfish.AllowableValues']);
        if (allowed && !allowed.includes(target))
          throw bmcError('unsupported_by_bmc', `this BMC cannot boot ${target} once`, { allowed });
        const pick = (b: Json) => ({
          enabled: str(b.BootSourceOverrideEnabled),
          target: str(b.BootSourceOverrideTarget),
          mode: str(b.BootSourceOverrideMode),
        });
        const before = pick(boot);
        const mode = params.mode === 'uefi' ? 'UEFI' : params.mode === 'legacy' ? 'Legacy' : null;
        await client.patch(
          sys.path,
          {
            Boot: {
              // Once: the override is spent by the next boot; the machine returns to its order.
              BootSourceOverrideEnabled: 'Once',
              BootSourceOverrideTarget: target,
              ...(mode ? { BootSourceOverrideMode: mode } : {}),
            },
          },
          sys.etag,
        );
        const again = await client.get(sys.path);
        const after = pick(isJson(again.json.Boot) ? again.json.Boot : {});
        return { before, after, result: { target: params.target, oneTime: true, before, after } };
      }
      default:
        throw new NovaError('validation', `${action} is not a Redfish action here`);
    }
  }

  /** Temperatures and fans (Thermal), voltages and power draw (Power) of the system's chassis. */
  async #redfishSensors(client: RedfishClient, root: Json, sys: Json): Promise<OobSensorView[]> {
    const links = isJson(sys.Links) && Array.isArray(sys.Links.Chassis) ? sys.Links.Chassis : [];
    let chassisPath = odataId(links[0]);
    if (!chassisPath) {
      const coll = await client.get(redfishPath(odataId(root.Chassis) ?? '/redfish/v1/Chassis'));
      chassisPath = Array.isArray(coll.json.Members) ? odataId(coll.json.Members[0]) : null;
    }
    if (!chassisPath) return [];
    const chassis = (await client.get(redfishPath(chassisPath))).json;
    const out: OobSensorView[] = [];
    const health = (v: unknown): OobSensorView['health'] => {
      const h = isJson(v) ? v.Health : null;
      return h === 'OK'
        ? 'ok'
        : h === 'Warning'
          ? 'warning'
          : h === 'Critical'
            ? 'critical'
            : 'unknown';
    };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const name = (v: Json, fallback: string) => (str(v.Name) ?? fallback).slice(0, 100);
    const thermalPath = odataId(chassis.Thermal);
    if (thermalPath) {
      const t = (await client.get(redfishPath(thermalPath))).json;
      for (const x of Array.isArray(t.Temperatures) ? t.Temperatures : [])
        if (isJson(x))
          out.push({
            name: name(x, 'Temperature'),
            kind: 'temperature',
            reading: num(x.ReadingCelsius),
            unit: 'Cel',
            health: health(x.Status),
          });
      for (const x of Array.isArray(t.Fans) ? t.Fans : [])
        if (isJson(x))
          out.push({
            name: name(x, 'Fan'),
            kind: 'fan',
            reading: num(x.Reading),
            unit: str(x.ReadingUnits) ?? 'RPM',
            health: health(x.Status),
          });
    }
    const powerPath = odataId(chassis.Power);
    if (powerPath) {
      const p = (await client.get(redfishPath(powerPath))).json;
      for (const x of Array.isArray(p.Voltages) ? p.Voltages : [])
        if (isJson(x))
          out.push({
            name: name(x, 'Voltage'),
            kind: 'voltage',
            reading: num(x.ReadingVolts),
            unit: 'V',
            health: health(x.Status),
          });
      for (const x of Array.isArray(p.PowerControl) ? p.PowerControl : [])
        if (isJson(x))
          out.push({
            name: name(x, 'Power'),
            kind: 'power',
            reading: num(x.PowerConsumedWatts),
            unit: 'W',
            health: health(x.Status),
          });
    }
    return out.slice(0, 200);
  }

  // ---- the boot area's seam and housekeeping ---------------------------------------------------

  /**
   * The power cycle a failed-boot alert offers (D5): a link to this area's action for the BMC
   * linked to the device, or null (not the owner, the setting off, or no linked BMC). The owner
   * still asks for it and approves it; the boot area never runs it.
   */
  async powerCycleFor(accountId: string, deviceId: string): Promise<OobPowerCycleLink | null> {
    if (!this.#isOwner(accountId)) return null;
    if (!(await this.#settings.enabled())) return null;
    const row = this.#db.raw
      .prepare(
        `SELECT * FROM oob_endpoint WHERE account_id = ? AND device_id = ? AND kind IN ('redfish', 'ipmi')
         ORDER BY coalesce(last_check_ok, 0) DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get(accountId, deviceId) as EndpointRow | undefined;
    if (!row) return null;
    return {
      endpointId: row.id,
      endpointName: row.name,
      deviceId,
      action: 'power.cycle',
      method: 'POST',
      href: `/api/v1/oob/endpoints/${row.id}/actions/power.cycle`,
    };
  }

  /** Cards past their time: the action expires and its card is withdrawn. */
  async sweepExpired(): Promise<number> {
    const rows = this.#db.raw
      .prepare(
        "SELECT * FROM oob_action WHERE status IN ('awaiting_approval', 'approved') AND expires_at IS NOT NULL AND expires_at < ?",
      )
      .all(this.#now().toISOString()) as unknown as ActionRow[];
    // A card withdrawn elsewhere (the approvals area cancels pending cards at a restart) can no
    // longer be answered: its action ends too.
    const orphans = this.#db.raw
      .prepare(
        `SELECT o.* FROM oob_action o JOIN approval a ON a.id = o.approval_id
         WHERE o.status = 'awaiting_approval' AND a.status IN ('cancelled', 'expired')`,
      )
      .all() as unknown as ActionRow[];
    return (
      (await this.#withdraw(rows, 'approval_expired', 'the approval expired', 'expired')) +
      (await this.#withdraw(
        orphans,
        'approval_cancelled',
        'the approval was withdrawn',
        'cancelled',
      ))
    );
  }

  /**
   * Out-of-band management was turned off: every waiting card and approved plan is withdrawn (a
   * card answered later would be refused at run time anyway; this keeps the list honest).
   */
  async withdrawOpen(): Promise<number> {
    const rows = this.#db.raw
      .prepare("SELECT * FROM oob_action WHERE status IN ('awaiting_approval', 'approved')")
      .all() as unknown as ActionRow[];
    return this.#withdraw(
      rows,
      'oob_disabled',
      'out-of-band management was turned off',
      'cancelled',
    );
  }

  async #withdraw(
    rows: ActionRow[],
    reason: string,
    message: string,
    cardStatus: 'expired' | 'cancelled',
  ): Promise<number> {
    const nowIso = this.#now().toISOString();
    let n = 0;
    for (const row of rows) {
      const changed = await this.#db.transaction(() => {
        const c = this.#db.raw
          .prepare(
            `UPDATE oob_action SET status = 'expired', error_code = 'conflict', error_reason = ?,
               error_message = ?, finished_at = ?
             WHERE id = ? AND status IN ('awaiting_approval', 'approved')`,
          )
          .run(reason, message, nowIso, row.id).changes;
        if (Number(c) > 0 && row.approval_id)
          this.#db.raw
            .prepare("UPDATE approval SET status = ? WHERE id = ? AND status = 'pending'")
            .run(cardStatus, row.approval_id);
        return c;
      });
      if (Number(changed) === 0) continue;
      n += 1;
      if (row.approval_id && row.status === 'awaiting_approval')
        await this.#emit(row.account_id, 'approval.cancelled', {
          approvalId: row.approval_id,
          reason: cardStatus === 'expired' ? 'expired' : reason,
        });
      const ep = row.endpoint_id
        ? (this.#db.raw.prepare('SELECT * FROM oob_endpoint WHERE id = ?').get(row.endpoint_id) as
            EndpointRow | undefined)
        : undefined;
      if (ep) {
        const next = this.#actionRow(row.account_id, row.id);
        await this.#actionEvent(ep, next);
        await this.#auditAction(ep, next, 'expired');
      }
    }
    return n;
  }

  /**
   * Turn out-of-band management on or off: the owner's explicit action (turning it on needs the
   * consent the route checks, ADR-043). `write` is the Hub's settings writer: a managed lock
   * refuses it, and its `settings.changed` (before, after, confirmed) is the change's one audit
   * entry, `setting.changed` from the ops subscriber (ADR-096 D3), so nothing is audited here.
   */
  async setEnabled(
    accountId: string,
    enabled: boolean,
    write: (value: boolean) => Promise<void>,
  ): Promise<OobStatusView> {
    await this.#owner(accountId, enabled ? 'enable' : 'disable');
    await write(enabled);
    if (!(await this.#settings.enabled())) await this.withdrawOpen();
    return this.status(accountId);
  }

  /** At start: actions a restart interrupted are failed (never re-run on their own). */
  async recover(): Promise<number> {
    const nowIso = this.#now().toISOString();
    const n = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare(
            `UPDATE oob_action SET status = 'failed', error_code = 'server_error',
               error_reason = 'interrupted', error_message = 'the Hub restarted during the action',
               finished_at = ?
             WHERE status = 'running'`,
          )
          .run(nowIso).changes,
    );
    return Number(n);
  }

  /** For diagnostics: counts only, never addresses or pins. */
  counts(): { endpoints: number; pinned: number; awaitingApproval: number } {
    const e = this.#db.raw
      .prepare(
        'SELECT count(*) AS n, sum(CASE WHEN tls_pin IS NULL THEN 0 ELSE 1 END) AS p FROM oob_endpoint',
      )
      .get() as { n: number; p: number | null };
    const a = this.#db.raw
      .prepare("SELECT count(*) AS n FROM oob_action WHERE status = 'awaiting_approval'")
      .get() as { n: number };
    return { endpoints: Number(e.n), pinned: Number(e.p ?? 0), awaitingApproval: Number(a.n) };
  }

  // ---- events and audit ------------------------------------------------------------------------

  async #emit(accountId: string, name: string, payload: Json, actor = 'user'): Promise<void> {
    try {
      await this.#events.emit({ name, accountId, actor, payload });
    } catch (err) {
      this.#log.warn('out-of-band event failed', { err, name });
    }
  }

  async #endpointEvent(
    accountId: string,
    row: EndpointRow,
    change: 'created' | 'updated' | 'deleted' | 'pinned' | 'pin_confirmed' | 'pin_mismatch',
  ): Promise<void> {
    await this.#emit(
      accountId,
      'device.oob.endpoint.changed',
      { endpointId: row.id, change, kind: row.kind, deviceId: row.device_id },
      change === 'pin_mismatch' ? 'system' : 'user',
    );
  }

  async #actionEvent(ep: EndpointRow, row: ActionRow): Promise<void> {
    await this.#emit(ep.account_id, 'device.oob.action.changed', {
      actionId: row.id,
      endpointId: ep.id,
      deviceId: ep.device_id,
      action: row.action,
      status: row.status,
      approvalId: row.approval_id,
      ...(row.error_reason ? { reason: row.error_reason } : {}),
    });
  }

  async #auditAction(
    ep: EndpointRow,
    row: ActionRow,
    decision: string,
    extra: Json = {},
  ): Promise<void> {
    const reads = (OOB_READ_ACTIONS as readonly string[]).includes(row.action);
    await this.#auditAppend(
      ep.account_id,
      `device.oob.${row.action}`,
      ep.id,
      {
        endpoint: ep.name,
        kind: ep.kind,
        address: ep.address,
        actionId: row.id,
        approvalId: row.approval_id,
        planId: row.plan_id,
        params: parse(row.params_json),
        // Reads change nothing: their results stay in the action log, not the audit chain.
        ...(reads ? {} : { before: parse(row.before_json), after: parse(row.after_json) }),
        ...(row.error_reason ? { error: row.error_reason } : {}),
        ...extra,
      },
      {
        decision,
        inputHash: row.params_hash,
        ...(row.status === 'done' || row.status === 'failed' ? { result: row.status } : {}),
      },
    );
  }

  async #auditAppend(
    accountId: string,
    action: string,
    resource: string | null,
    detail: Json,
    extra: { decision?: string; result?: string; inputHash?: string } = {},
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: 'user',
        kind: 'device',
        action,
        resource,
        detail,
        ...(extra.decision ? { decision: extra.decision } : {}),
        ...(extra.result ? { result: extra.result } : {}),
        ...(extra.inputHash ? { inputHash: extra.inputHash } : {}),
      });
    } catch (err) {
      this.#log.warn('out-of-band audit failed', { err, action });
    }
  }
}
