// Add Device (FR-132, FR-140; docs/22 §4, §9; contracts/hub-api.md §1; ADR-094). The owner starts a
// pairing and gets a short code (single use, 5 minutes, at most 20 starts an hour); a new device
// completes it with the code, its Ed25519 public key and a commitment to a secret nonce (5 wrong
// codes burn the pairing; guesses without a pairing id have their own budget), gets the Hub's
// nonce, then reveals its own within 2 minutes (v2, commit-then-reveal: nobody on the path can
// grind a key with the same digits). Both screens show the same confirmation and the owner
// approves on the Hub, which creates the device record. A Relay claim keeps v1. The device polls its status with requests signed by its key and newer than the last
// one; the first approved poll hands out its grant exactly once: a device session for a browser
// or app, or a one-use enrollment token bound to its key for novad and compute nodes. Revoking a
// device deletes its sessions and blocks its key. Codes are stored only as hashes, and a grant
// never reaches a log, event or audit row.
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  ADD_DEVICE_KINDS_BY_ROLE,
  NovaError,
  addDeviceCompleteSchema,
  addDeviceRevealSchema,
  uuidv7,
  type AddDeviceCompleteView,
  type AddDeviceRevealView,
  type AddDeviceGrant,
  type AddDeviceKind,
  type AddDeviceRequestStatus,
  type AddDeviceRequestView,
  type AddDeviceRole,
  type AddDeviceStatusView,
  type AddDeviceTransport,
  type DeviceSummaryView,
} from '@nova/shared';
import { hashToken, newToken } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink, Notifier } from '../tools/types.ts';
import { keyFingerprint } from '../nodes/crypto.ts';
import {
  hubRevealStatement,
  newPairingCode,
  newPairingNonce,
  normalizeConfirmation,
  normalizePairingCode,
  pairingCodeHash,
  pairingCommitment,
  pairingConfirmation,
  pairingConfirmationV2,
  sameDigest,
  verifyRevealSignature,
  verifyStatusSignature,
} from './code.ts';

const {
  authToken,
  device,
  devicePairing,
  devicePairingRequest,
  deviceSession,
  revokedDeviceKey,
  transportEndpoint,
} = schema;

type PairingRow = typeof devicePairing.$inferSelect;
type RequestRow = typeof devicePairingRequest.$inferSelect;
type DeviceRow = typeof device.$inferSelect;

/** A pairing code lives 5 minutes (docs/22 §4.1). */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** A completed request waits 10 minutes for the owner; an approval leaves 10 more to collect. */
export const PAIRING_REQUEST_TTL_MS = 10 * 60_000;
/** A committed request (v2) must be revealed within 2 minutes. */
export const PAIRING_REVEAL_TTL_MS = 2 * 60_000;
/** Wrong guesses without a pairing id an account takes per window before they are refused. */
export const PAIRING_CODE_ONLY_GUESSES = 10;
export const PAIRING_CODE_ONLY_WINDOW_MS = 5 * 60_000;
/** How long code-only completes stay refused after the budget is spent. */
export const PAIRING_CODE_ONLY_LOCK_MS = 5 * 60_000;
/** Wrong codes a pairing takes before it is burned. */
export const PAIRING_MAX_ATTEMPTS = 5;
/** Pairings an account may start per hour. */
export const PAIRING_STARTS_PER_HOUR = 20;
/** How far a status poll's time may be from the Hub's clock. */
export const PAIRING_STATUS_SKEW_S = 60;
/** Default lifetime of a device session (`devices.add.sessionDays`). */
export const DEVICE_SESSION_DAYS = 30;

/** What a grant issuer knows about the device it serves. */
export interface PairingGrantContext {
  accountId: string;
  requestId: string;
  deviceId: string;
  role: AddDeviceRole;
  kind: AddDeviceKind;
  publicKey: string;
  name: string;
  scopes: string[];
  /** The Hub URL the device polled (novad's command text names it). */
  hubUrl: string;
}

/** The Hub identity (trust area, seam `useHubIdentity`): its fingerprint and Ed25519 signer. */
export interface PairingHubIdentity {
  fingerprint: string;
  sign(bytes: Uint8Array | string): Uint8Array;
}

/** Enrollment tokens for novad and compute nodes, bound to the device key (the Hub wires them). */
export interface PairingGrantIssuers {
  novad?: (ctx: PairingGrantContext) => Promise<string>;
  compute?: (ctx: PairingGrantContext) => Promise<string>;
}

/** The trust area's device certificates (seam `useCertIssuer`). */
export interface PairingCertIssuer {
  /** Null when the trust mode issues no device certificates. */
  issueDeviceCertificate(input: {
    deviceId: string;
    publicKey: string;
    role: AddDeviceRole;
  }): Promise<{ certificatePem: string; expiresAt: string } | null>;
  /** Revocation revokes the device's certificates too (docs/22 §4.5). */
  revokeDeviceCertificates?(deviceId: string): Promise<unknown>;
}

/** The Relay area opens a pairing slot for `transport: relay` (seam `useRelayPairing`). */
export type PairingRelayOpener = (input: {
  accountId: string;
  pairingId: string;
  role: AddDeviceRole;
  expiresAt: string;
  /** The code in its display form; the opener derives whatever the Relay may see from it. */
  code: string;
  /** `pairingCodeHash(pairingId, code)`. */
  codeHash: string;
}) => Promise<{ relayUrl: string; relayPairingId: string }>;

/** A decision on a request, for the Relay area (`onDecided`). */
export interface PairingDecision {
  accountId: string;
  requestId: string;
  pairingId: string;
  decision: 'approved' | 'denied' | 'expired';
  deviceId: string | null;
  kind: AddDeviceKind;
  role: AddDeviceRole;
  publicKey: string;
  via: AddDeviceTransport;
  relayClientId: string | null;
}

export interface PairingSettings {
  /** `devices.add.enabled`. */
  enabled?: () => Promise<boolean>;
  /** `devices.add.sessionDays`. */
  sessionDays?: () => Promise<number>;
}

export interface PairingServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  log?: Logger;
  audit?: AuditSink;
  notifier?: Notifier;
  now?: () => Date;
  settings?: PairingSettings;
  grants?: PairingGrantIssuers;
  /** Sweep interval for `startSweeper()` (default 30 s). */
  sweepIntervalMs?: number;
}

export interface PairingStartInput {
  role: AddDeviceRole;
  scopes?: string[] | undefined;
  name?: string | undefined;
  transport?: AddDeviceTransport | undefined;
}

export interface PairingStarted {
  pairingId: string;
  /** Display form `ABCD-EFGH`; shown once. */
  code: string;
  expiresAt: string;
  role: AddDeviceRole;
  scopes: string[];
  transport: AddDeviceTransport;
  relay: { relayUrl: string; relayPairingId: string } | null;
}

export interface PairingRelayClaim {
  pairingId: string;
  /** `pairingCodeHash(pairingId, code)`, computed by the client or the Relay area. */
  codeHashCheck: string;
  publicKey: string;
  name: string;
  platform: string;
  relayClientId: string;
  /** Default `native`. */
  kind?: 'browser' | 'native';
  /** The code itself when the Relay area has it (checked against the hash). */
  code?: string;
}

export interface PairingStatusProof {
  /** `x-nova-device-time`: Unix seconds. */
  time: string | number | undefined;
  /** `x-nova-device-signature`: base64url Ed25519 signature. */
  signature: string | undefined;
}

export interface PairingStatusResult {
  view: AddDeviceStatusView;
  kind: AddDeviceKind;
  /** Lifetime of a session grant, for the browser cookie. */
  sessionMaxAgeS: number | null;
}

function parseScopes(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function deviceKindFor(role: AddDeviceRole, kind: AddDeviceKind): DeviceRow['kind'] {
  if (kind === 'compute') return 'compute';
  // novad devices are never `compute` rows: that stays the M2 node registration.
  if (kind === 'novad' && role === 'wake-helper') return 'wake-helper';
  return 'client';
}

function grantTypeFor(kind: AddDeviceKind): 'session' | 'novad' | 'compute' {
  if (kind === 'novad') return 'novad';
  if (kind === 'compute') return 'compute';
  return 'session';
}

function requestView(r: RequestRow): AddDeviceRequestView {
  return {
    id: r.id,
    pairingId: r.pairingId,
    role: r.role,
    kind: r.kind,
    name: r.name,
    platform: r.platform,
    scopes: parseScopes(r.scopes),
    confirmation: r.confirmation ?? '',
    fingerprint: r.fingerprint,
    via: r.via,
    // Owners never see a committed request; the mapping only keeps the type honest.
    status: r.status === 'committed' ? 'pending' : r.status,
    deviceId: r.deviceId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
  };
}

export class PairingService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #settings: PairingSettings;
  readonly #sweepIntervalMs: number;
  #audit: AuditSink | null;
  #notifier: Notifier | null;
  #grants: PairingGrantIssuers;
  #hubIdentity: (() => PairingHubIdentity | null) | null = null;
  #certIssuer: PairingCertIssuer | null = null;
  #relayOpener: PairingRelayOpener | null = null;
  readonly #decided = new Set<(d: PairingDecision) => void | Promise<void>>();
  /**
   * Codes of open Relay pairings, in memory only and only until used or expired: a Relay claim
   * carries the code's hash, and the confirmation needs the code (docs/22 §3.1).
   */
  readonly #relayCodes = new Map<string, { code: string; expiresAt: string }>();
  /**
   * Codes of committed requests (v2), in memory only until the reveal (at most 2 minutes): the
   * confirmation needs the code, and the database keeps only its hash. A restart in between
   * expires the request.
   */
  readonly #revealCodes = new Map<string, { code: string; expiresAt: string }>();
  /** Wrong guesses without a pairing id, per account (review finding 4). */
  readonly #codeOnly = new Map<string, { fails: number[]; lockedUntil: number }>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PairingServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#log = opts.log ?? new Logger({ module: 'core.pairing', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#settings = opts.settings ?? {};
    this.#grants = { ...opts.grants };
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
  }

  // ---- seams ------------------------------------------------------------------------------------

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  useNotifier(notifier: Notifier): void {
    this.#notifier = notifier;
  }

  /** novad and compute enrollment tokens (the Hub area binds the devices and nodes services). */
  useGrants(grants: PairingGrantIssuers): void {
    this.#grants = { ...this.#grants, ...grants };
  }

  /**
   * The Hub identity (trust area): its fingerprint goes into the confirmation and it signs the
   * reveal answer. Until wired, or while it returns null, the fingerprint is '' and the signature
   * null.
   */
  useHubIdentity(identity: () => PairingHubIdentity | null): void {
    this.#hubIdentity = identity;
  }

  /** Device certificates (trust area); the grant carries one when it can issue it. */
  useCertIssuer(issuer: PairingCertIssuer): void {
    this.#certIssuer = issuer;
  }

  /** Relay pairing slots (relay area); `transport: relay` is refused without it. */
  useRelayPairing(opener: PairingRelayOpener): void {
    this.#relayOpener = opener;
  }

  /** Called after every approval, denial and expiry of a request. */
  onDecided(listener: (d: PairingDecision) => void | Promise<void>): () => void {
    this.#decided.add(listener);
    return () => this.#decided.delete(listener);
  }

  #identity(): PairingHubIdentity | null {
    try {
      const id = this.#hubIdentity?.() ?? null;
      return id?.fingerprint ? id : null;
    } catch (err) {
      this.#log.warn('hub identity unavailable', { err });
      return null;
    }
  }

  /** The fingerprint bound into confirmations, or null while the Hub has no identity. */
  hubFingerprint(): string | null {
    return this.#identity()?.fingerprint ?? null;
  }

  /** True while code-only completes are refused for the account. */
  #codeOnlyLocked(accountId: string, nowMs: number): boolean {
    return (this.#codeOnly.get(accountId)?.lockedUntil ?? 0) > nowMs;
  }

  /** Count a wrong code-only guess; returns the guesses left before the lock. */
  #codeOnlyFail(accountId: string, nowMs: number): number {
    const cur = this.#codeOnly.get(accountId) ?? { fails: [], lockedUntil: 0 };
    cur.fails = cur.fails.filter((t) => t > nowMs - PAIRING_CODE_ONLY_WINDOW_MS);
    cur.fails.push(nowMs);
    if (cur.fails.length >= PAIRING_CODE_ONLY_GUESSES) {
      cur.lockedUntil = nowMs + PAIRING_CODE_ONLY_LOCK_MS;
      cur.fails = [];
    }
    this.#codeOnly.set(accountId, cur);
    return cur.lockedUntil > nowMs ? 0 : PAIRING_CODE_ONLY_GUESSES - cur.fails.length;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  #iso(): string {
    return this.#now().toISOString();
  }

  async #enabled(): Promise<boolean> {
    return (await this.#settings.enabled?.()) ?? true;
  }

  async #requireEnabled(): Promise<void> {
    if (!(await this.#enabled())) {
      throw new NovaError('policy_denied', 'adding devices is turned off on this Hub', {
        details: { reason: 'add_device_disabled' },
        action: 'Turn on Add Device in Settings → Devices',
      });
    }
  }

  async #auditAppend(
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    extra: { actor?: string; result?: string; decision?: string } = {},
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: extra.actor ?? 'system',
        kind: 'device',
        action,
        resource,
        detail,
        ...(extra.result ? { result: extra.result } : {}),
        ...(extra.decision ? { decision: extra.decision } : {}),
      });
    } catch (err) {
      this.#log.warn('add device audit failed', { err, action });
    }
  }

  async #emit(
    name: string,
    accountId: string,
    payload: Record<string, unknown>,
    actor: 'user' | 'system' = 'system',
  ): Promise<void> {
    try {
      await this.#events.emit({ name, accountId, actor, payload });
    } catch (err) {
      this.#log.warn('add device event failed', { err, name });
    }
  }

  async #announce(r: RequestRow, decision: PairingDecision['decision']): Promise<void> {
    await this.#emit(
      'device.add.decided',
      r.accountId,
      { requestId: r.id, decision },
      decision === 'expired' ? 'system' : 'user',
    );
    const d: PairingDecision = {
      accountId: r.accountId,
      requestId: r.id,
      pairingId: r.pairingId,
      decision,
      deviceId: r.deviceId,
      kind: r.kind,
      role: r.role,
      publicKey: r.publicKey,
      via: r.via,
      relayClientId: r.relayClientId,
    };
    for (const fn of this.#decided) {
      try {
        await fn(d);
      } catch (err) {
        this.#log.warn('add device decision listener failed', { err });
      }
    }
  }

  async #request(id: string): Promise<RequestRow | undefined> {
    if (!id || id.length > 100) return undefined;
    const rows = await this.#db.orm
      .select()
      .from(devicePairingRequest)
      .where(eq(devicePairingRequest.id, id))
      .limit(1);
    return rows[0];
  }

  /** True when a revoked device used this key (docs/22 §4.5). */
  async isKeyRevoked(publicKey: string): Promise<boolean> {
    const rows = await this.#db.orm
      .select({ fp: revokedDeviceKey.fingerprint })
      .from(revokedDeviceKey)
      .where(eq(revokedDeviceKey.fingerprint, keyFingerprint(publicKey)))
      .limit(1);
    return rows.length > 0;
  }

  // ---- start (owner) ---------------------------------------------------------------------------

  /** A new pairing; at most 20 per account per hour. The code is returned once. */
  async start(accountId: string, input: PairingStartInput): Promise<PairingStarted> {
    await this.#requireEnabled();
    const now = this.#now();
    const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
    const recent = await this.#db.orm
      .select({ n: sql<number>`count(*)` })
      .from(devicePairing)
      .where(and(eq(devicePairing.accountId, accountId), gt(devicePairing.createdAt, hourAgo)));
    if ((recent[0]?.n ?? 0) >= PAIRING_STARTS_PER_HOUR) {
      throw new NovaError('rate_limited', 'too many devices added in the last hour', {
        details: { reason: 'start_rate_limited', limit: PAIRING_STARTS_PER_HOUR },
        action: 'Try again later',
      });
    }
    const transport = input.transport ?? 'direct';
    const scopes = [...new Set(input.scopes ?? [])];
    const pairingId = uuidv7();
    const code = newPairingCode();
    const codeHash = pairingCodeHash(pairingId, code);
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    let relay: PairingStarted['relay'] = null;
    if (transport === 'relay') {
      if (!this.#relayOpener) {
        throw new NovaError('capability_missing', 'the Relay is not set up on this Hub', {
          details: { reason: 'relay_unavailable' },
          action: 'Set up a Relay in Settings → Network, or add the device directly',
        });
      }
      relay = await this.#relayOpener({
        accountId,
        pairingId,
        role: input.role,
        expiresAt,
        code,
        codeHash,
      });
    }
    await this.#db.transaction(() =>
      this.#db.orm.insert(devicePairing).values({
        id: pairingId,
        accountId,
        role: input.role,
        scopes: JSON.stringify(scopes),
        name: input.name ?? null,
        transport,
        codeHash,
        relayPairingId: relay?.relayPairingId ?? null,
        status: 'open',
        expiresAt,
        createdAt: now.toISOString(),
      }),
    );
    if (relay) this.#relayCodes.set(pairingId, { code, expiresAt });
    await this.#auditAppend(
      accountId,
      'device.add.start',
      pairingId,
      { role: input.role, scopes, transport, expiresAt },
      { actor: 'user' },
    );
    return { pairingId, code, expiresAt, role: input.role, scopes, transport, relay };
  }

  // ---- complete and reveal (the new device; the code, then its key authenticate it) ----------

  /**
   * `POST /api/v1/devices/add/complete` (v2): the code, the device key and a commitment to the
   * device's secret nonce. A good code is consumed; the answer is the Hub's nonce, and nothing is
   * shown to the owner before the reveal.
   */
  async complete(input: unknown, ctx: { ip?: string } = {}): Promise<AddDeviceCompleteView> {
    await this.#requireEnabled();
    const body = addDeviceCompleteSchema.parse(input);
    const { row, code } = await this.#claim(
      {
        pairingId: body.pairingId,
        publicKey: body.publicKey,
        name: body.name,
        platform: body.platform,
        kind: body.kind,
        via: 'direct',
        relayClientId: null,
      },
      (p) => {
        const canonical = normalizePairingCode(body.code);
        const ok = canonical !== null && sameDigest(pairingCodeHash(p.id, canonical), p.codeHash);
        return ok ? canonical : null;
      },
      { v: 2, commitment: body.commitment },
      ctx,
    );
    this.#revealCodes.set(row.id, { code, expiresAt: row.expiresAt });
    await this.#auditAppend(
      row.accountId,
      'device.add.complete',
      row.id,
      {
        pairingId: row.pairingId,
        role: row.role,
        kind: row.kind,
        name: row.name,
        platform: row.platform,
        fingerprint: row.fingerprint,
        via: row.via,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
      },
      { result: 'committed' },
    );
    return {
      requestId: row.id,
      pairingId: row.pairingId,
      expiresAt: row.expiresAt,
      hubNonce: row.hubNonce!,
      status: 'committed',
    };
  }

  /**
   * `POST /api/v1/devices/add/reveal` (v2): the device's nonce, signed by its key over
   * `nova-add-device-reveal-v1.<requestId>.<time>`. It must match the commitment; a wrong nonce or
   * signature burns the request. Once per request. Answers the confirmation and the Hub
   * identity's signature over it; only now the owner sees the request.
   */
  async reveal(
    input: unknown,
    proof: PairingStatusProof,
    ctx: { ip?: string } = {},
  ): Promise<AddDeviceRevealView> {
    await this.#requireEnabled();
    const body = addDeviceRevealSchema.parse(input);
    const denied = (reason: string) =>
      new NovaError('auth_missing', 'this reveal is not signed by the device', {
        details: { reason },
      });
    const timeText = typeof proof.time === 'number' ? String(proof.time) : (proof.time ?? '');
    if (!/^\d{1,12}$/.test(timeText) || !proof.signature) throw denied('missing_proof');
    const time = Number(timeText);
    const r = await this.#request(body.requestId);
    // An unknown request answers like a bad signature: no oracle for request ids.
    if (!r || r.via !== 'direct' || !r.commitment || !r.hubNonce) throw denied('bad_signature');
    if (r.revealedAt) {
      throw new NovaError('conflict', 'this request was revealed already', {
        details: { reason: 'already_revealed' },
      });
    }
    const gone = () =>
      new NovaError('request_expired', 'this request has expired', {
        details: { reason: 'expired' },
        action: 'Start Add Device again on the Hub',
      });
    if (r.status !== 'committed') throw gone();
    const nowIso = this.#iso();
    if (r.expiresAt <= nowIso) {
      await this.#expireCommitted([r]);
      throw gone();
    }
    const signed = verifyRevealSignature(r.publicKey, r.id, time, proof.signature);
    const matches = signed && sameDigest(pairingCommitment(r.publicKey, body.nonce), r.commitment);
    if (!matches) {
      // A wrong nonce or signature burns the request and counts against its pairing.
      const burned = await this.#db.transaction(() => {
        const res = this.#db.raw
          .prepare(
            `UPDATE device_pairing_request SET status = 'denied', decided_at = ?
             WHERE id = ? AND status = 'committed'`,
          )
          .run(nowIso, r.id);
        this.#db.raw
          .prepare('UPDATE device_pairing SET attempts = attempts + 1 WHERE id = ?')
          .run(r.pairingId);
        return Number(res.changes) === 1;
      });
      this.#revealCodes.delete(r.id);
      if (burned) {
        await this.#auditAppend(
          r.accountId,
          'device.add.reveal',
          r.id,
          {
            reason: 'bad_reveal',
            fingerprint: r.fingerprint,
            ...(ctx.ip ? { ip: ctx.ip } : {}),
          },
          { result: 'denied' },
        );
      }
      throw denied('bad_reveal');
    }
    const nowS = Math.floor(this.#now().getTime() / 1000);
    if (Math.abs(nowS - time) > PAIRING_STATUS_SKEW_S) throw denied('stale_time');
    const code = this.#revealCodes.get(r.id)?.code;
    if (!code) {
      // The Hub restarted since the commit: the code is gone, so is the request.
      await this.#expireCommitted([r]);
      throw gone();
    }
    const identity = this.#identity();
    const confirmation = pairingConfirmationV2({
      hubFingerprint: identity?.fingerprint ?? '',
      pairingId: r.pairingId,
      publicKey: r.publicKey,
      code,
      deviceNonce: body.nonce,
      hubNonce: r.hubNonce,
    });
    const revealed = await this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE device_pairing_request
           SET status = 'pending', confirmation = ?, revealed_at = ?, expires_at = ?
           WHERE id = ? AND status = 'committed' AND revealed_at IS NULL`,
        )
        .run(
          confirmation,
          nowIso,
          new Date(this.#now().getTime() + PAIRING_REQUEST_TTL_MS).toISOString(),
          r.id,
        );
      return Number(res.changes) === 1;
    });
    if (!revealed) {
      throw new NovaError('conflict', 'this request was revealed already', {
        details: { reason: 'already_revealed' },
      });
    }
    this.#revealCodes.delete(r.id);
    let hubSignature: string | null = null;
    if (identity) {
      try {
        hubSignature = Buffer.from(
          identity.sign(
            hubRevealStatement({
              requestId: r.id,
              pairingId: r.pairingId,
              publicKey: r.publicKey,
              confirmation,
            }),
          ),
        ).toString('base64url');
      } catch (err) {
        this.#log.warn('the Hub identity could not sign the reveal', { err });
      }
    }
    await this.#requested((await this.#request(r.id))!, 'device.add.reveal', ctx);
    return { requestId: r.id, confirmation, status: 'pending', hubSignature };
  }

  /**
   * A client claimed a Relay pairing (the relay area calls this; docs/22 §3.1). The claim carries
   * `pairingCodeHash(pairingId, code)`; a wrong one counts like a wrong code. The Relay path keeps
   * the v1 confirmation: its claim travels sealed with a key derived from the code, so nobody on
   * the path sees the code.
   */
  async requestFromRelay(
    claim: PairingRelayClaim,
  ): Promise<{ requestId: string; confirmation: string }> {
    await this.#requireEnabled();
    const body = addDeviceCompleteSchema.omit({ commitment: true }).parse({
      pairingId: claim.pairingId,
      code: 'XXXXXXXX',
      publicKey: claim.publicKey,
      name: claim.name,
      platform: claim.platform,
      kind: claim.kind ?? 'native',
    });
    if (body.kind !== 'browser' && body.kind !== 'native') {
      throw new NovaError('validation', 'a Relay client is a browser or the app', {
        details: { reason: 'kind_not_allowed' },
      });
    }
    if (!body.pairingId) throw new NovaError('validation', 'the pairing id is missing');
    if (typeof claim.relayClientId !== 'string' || !claim.relayClientId) {
      throw new NovaError('validation', 'the Relay client id is missing');
    }
    const { row } = await this.#claim(
      {
        pairingId: body.pairingId,
        publicKey: body.publicKey,
        name: body.name,
        platform: body.platform,
        kind: body.kind,
        via: 'relay',
        relayClientId: claim.relayClientId.slice(0, 200),
      },
      (p) => {
        if (p.transport !== 'relay') return null;
        if (!sameDigest(String(claim.codeHashCheck), p.codeHash)) return null;
        const given = claim.code !== undefined ? normalizePairingCode(claim.code) : null;
        if (given && sameDigest(pairingCodeHash(p.id, given), p.codeHash)) return given;
        const kept = this.#relayCodes.get(p.id)?.code;
        return kept ? normalizePairingCode(kept) : null;
      },
      { v: 1 },
      {},
    );
    await this.#requested(row, 'device.add.complete', {});
    return { requestId: row.id, confirmation: row.confirmation! };
  }

  /** The request is now the owner's to decide: event, audit and a notification. */
  async #requested(
    r: RequestRow,
    action: 'device.add.complete' | 'device.add.reveal',
    ctx: { ip?: string },
  ): Promise<void> {
    await this.#emit('device.add.requested', r.accountId, {
      requestId: r.id,
      role: r.role,
      kind: r.kind,
      platform: r.platform,
      name: r.name,
    });
    await this.#auditAppend(
      r.accountId,
      action,
      r.id,
      {
        pairingId: r.pairingId,
        role: r.role,
        kind: r.kind,
        name: r.name,
        platform: r.platform,
        fingerprint: r.fingerprint,
        via: r.via,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
      },
      { result: 'ok' },
    );
    if (this.#notifier) {
      // The confirmation stays out of notifications: they may leave the Hub (channels).
      await this.#notifier
        .notify({
          accountId: r.accountId,
          kind: 'attention',
          title: 'A device wants to join',
          body: `${r.name} (${r.platform}) asks to join as ${r.role}. Approve it on the Hub if the codes match.`,
          href: `/devices/add?request=${r.id}`,
          dedupeKey: `device-add:${r.id}`,
        })
        .catch((err: unknown) => this.#log.warn('add device notification failed', { err }));
    }
  }

  async #claim(
    req: {
      pairingId: string | undefined;
      publicKey: string;
      name: string;
      platform: string;
      kind: AddDeviceKind;
      via: AddDeviceTransport;
      relayClientId: string | null;
    },
    check: (p: PairingRow) => string | null,
    mode: { v: 1 } | { v: 2; commitment: string },
    ctx: { ip?: string },
  ): Promise<{ row: RequestRow; code: string }> {
    const nowIso = this.#iso();
    const nowMs = this.#now().getTime();
    const fingerprint = keyFingerprint(req.publicKey);
    const revoked = await this.isKeyRevoked(req.publicKey);
    const hubFp = this.hubFingerprint() ?? '';
    type Failure = {
      ok: false;
      /** Where the refusal is audited: the pairing, or the account for a code-only guess. */
      seen: { accountId: string; pairingId: string | null }[];
      error: NovaError;
      reason: string;
    };
    type Outcome = { ok: true; row: RequestRow; code: string } | Failure;
    const fail = (
      p: PairingRow | PairingRow[] | undefined,
      reason: string,
      error: NovaError,
    ): Failure => ({
      ok: false,
      seen: (Array.isArray(p) ? p : p ? [p] : []).map((x) => ({
        accountId: x.accountId,
        pairingId: x.id,
      })),
      reason,
      error,
    });
    const gone = (p: PairingRow | undefined, reason: string): Failure =>
      fail(
        p,
        reason,
        new NovaError('request_expired', 'this code has expired or was already used', {
          details: { reason: 'expired' },
          action: 'Start Add Device again on the Hub',
        }),
      );
    const wrongCode = (attemptsLeft: number) =>
      new NovaError('auth_missing', 'the code is not right', {
        details: { reason: 'wrong_code', attemptsLeft },
      });
    const outcome = await this.#db.transaction(async (): Promise<Outcome> => {
      let p: PairingRow | undefined;
      let code: string | null = null;
      if (req.pairingId) {
        const rows = await this.#db.orm
          .select()
          .from(devicePairing)
          .where(eq(devicePairing.id, req.pairingId))
          .limit(1);
        p = rows[0];
        // An unknown pairing answers like an expired one: no oracle for pairing ids.
        if (!p) return gone(undefined, 'unknown');
        if (p.status === 'open' && p.expiresAt <= nowIso) {
          await this.#db.orm
            .update(devicePairing)
            .set({ status: 'expired' })
            .where(eq(devicePairing.id, p.id));
          return gone(p, 'expired');
        }
        if (p.status !== 'open') return gone(p, p.status);
        code = check(p);
        if (!code) {
          // A wrong code counts against this pairing; the fifth burns it.
          const attempts = p.attempts + 1;
          const burned = attempts >= PAIRING_MAX_ATTEMPTS;
          await this.#db.orm
            .update(devicePairing)
            .set({ attempts, ...(burned ? { status: 'burned' as const } : {}) })
            .where(eq(devicePairing.id, p.id));
          return fail(
            p,
            burned ? 'burned' : 'wrong_code',
            wrongCode(Math.max(0, PAIRING_MAX_ATTEMPTS - attempts)),
          );
        }
      } else {
        // The code alone (typed): try every open pairing (a handful at most). Wrong guesses spend
        // the account's own code-only budget, never the pairings' attempts, so nobody can burn
        // the owner's pairings without knowing their ids (review finding 4).
        const open = await this.#db.orm
          .select()
          .from(devicePairing)
          .where(and(eq(devicePairing.status, 'open'), gt(devicePairing.expiresAt, nowIso)));
        if (!open.length) return gone(undefined, 'unknown');
        const usable = open.filter((c) => !this.#codeOnlyLocked(c.accountId, nowMs));
        const accounts = (rows: PairingRow[]) =>
          [...new Set(rows.map((x) => x.accountId))].map((accountId) => ({
            accountId,
            pairingId: null,
          }));
        if (!usable.length) {
          return {
            ok: false,
            seen: accounts(open),
            reason: 'code_only_locked',
            error: new NovaError('rate_limited', 'too many wrong codes were typed', {
              details: { reason: 'code_only_locked' },
              action: 'Scan the QR code or use the install command, or try again in 5 minutes',
            }),
          };
        }
        for (const c of usable) {
          code = check(c);
          if (code) {
            p = c;
            break;
          }
        }
        if (!p || !code) {
          let left = PAIRING_CODE_ONLY_GUESSES;
          for (const a of accounts(usable))
            left = Math.min(left, this.#codeOnlyFail(a.accountId, nowMs));
          return {
            ok: false,
            seen: accounts(usable),
            reason: 'wrong_code',
            error: wrongCode(left),
          };
        }
      }
      if (revoked) {
        return fail(
          p,
          'key_revoked',
          new NovaError('policy_denied', 'this device key was revoked', {
            details: { reason: 'key_revoked' },
            action: 'Reset the device so it makes a new key, then add it again',
          }),
        );
      }
      if (!ADD_DEVICE_KINDS_BY_ROLE[p.role].includes(req.kind)) {
        return fail(
          p,
          'kind_not_allowed',
          new NovaError('validation', `a ${req.kind} cannot join as ${p.role}`, {
            details: { reason: 'kind_not_allowed', role: p.role, kind: req.kind },
          }),
        );
      }
      const taken = await this.#db.orm
        .select({ status: device.status, accountId: device.accountId })
        .from(device)
        .where(eq(device.certFingerprint, fingerprint))
        .limit(1);
      const existing = taken[0];
      // A device approved earlier that never registered may try again with the same key.
      if (existing && !(existing.status === 'pending' && existing.accountId === p.accountId)) {
        return fail(
          p,
          'key_in_use',
          new NovaError('conflict', 'this device key is already registered', {
            details: { reason: 'key_in_use' },
            action: 'Add the device with a new key',
          }),
        );
      }
      const v2 = mode.v === 2;
      const row: RequestRow = {
        id: uuidv7(),
        accountId: p.accountId,
        pairingId: p.id,
        role: p.role,
        kind: req.kind,
        scopes: p.scopes,
        // The name the owner gave on the Hub wins over the one the device reports.
        name: p.name ?? req.name,
        platform: req.platform,
        publicKey: req.publicKey,
        fingerprint,
        // v2 computes it at the reveal, once both nonces are known.
        confirmation: v2
          ? null
          : pairingConfirmation({
              hubFingerprint: hubFp,
              pairingId: p.id,
              publicKey: req.publicKey,
              code,
            }),
        commitment: v2 ? mode.commitment : null,
        hubNonce: v2 ? newPairingNonce() : null,
        revealedAt: null,
        via: req.via,
        relayClientId: req.relayClientId,
        status: v2 ? 'committed' : 'pending',
        deviceId: null,
        lastPoll: null,
        grantType: null,
        grantedAt: null,
        decidedAt: null,
        expiresAt: new Date(
          nowMs + (v2 ? PAIRING_REVEAL_TTL_MS : PAIRING_REQUEST_TTL_MS),
        ).toISOString(),
        createdAt: nowIso,
      };
      await this.#db.orm
        .update(devicePairing)
        .set({ status: 'used', usedAt: nowIso })
        .where(eq(devicePairing.id, p.id));
      await this.#db.orm.insert(devicePairingRequest).values(row);
      return { ok: true, row, code };
    });
    if (!outcome.ok) {
      for (const seen of outcome.seen) {
        await this.#auditAppend(
          seen.accountId,
          'device.add.complete',
          seen.pairingId,
          {
            reason: outcome.reason,
            kind: req.kind,
            fingerprint,
            via: req.via,
            ...(ctx.ip ? { ip: ctx.ip } : {}),
          },
          { result: 'denied' },
        );
        if (seen.pairingId && (outcome.reason === 'burned' || outcome.reason === 'expired'))
          this.#relayCodes.delete(seen.pairingId);
      }
      throw outcome.error;
    }
    this.#relayCodes.delete(outcome.row.pairingId);
    return { row: outcome.row, code: outcome.code };
  }

  /** Committed requests (v2) past their reveal time: expired, never shown to the owner. */
  async #expireCommitted(rows: RequestRow[]): Promise<void> {
    if (!rows.length) return;
    await this.#db.transaction(() =>
      this.#db.orm
        .update(devicePairingRequest)
        .set({ status: 'expired', decidedAt: this.#iso() })
        .where(
          and(
            inArray(
              devicePairingRequest.id,
              rows.map((r) => r.id),
            ),
            eq(devicePairingRequest.status, 'committed'),
          ),
        ),
    );
    for (const r of rows) {
      this.#revealCodes.delete(r.id);
      await this.#auditAppend(r.accountId, 'device.add.expire', r.id, { what: 'commit' });
    }
  }

  // ---- status (the new device; its key authenticates it) ---------------------------------------

  /**
   * `GET /api/v1/devices/add/status/:requestId`. The poll is signed by the device key over its
   * request id and a time within 60 s that is newer than the last accepted poll. The first
   * approved poll returns the grant; later ones never repeat it.
   */
  async status(
    requestId: string,
    proof: PairingStatusProof,
    ctx: { hubUrl: string },
  ): Promise<PairingStatusResult> {
    const denied = (reason: string) =>
      new NovaError('auth_missing', 'this status request is not signed by the device', {
        details: { reason },
      });
    const timeText = typeof proof.time === 'number' ? String(proof.time) : (proof.time ?? '');
    if (!/^\d{1,12}$/.test(timeText) || !proof.signature) throw denied('missing_proof');
    const time = Number(timeText);
    const nowS = Math.floor(this.#now().getTime() / 1000);
    const r = await this.#request(requestId);
    // An unknown request answers like a bad signature: no oracle for request ids.
    if (!r) throw denied('bad_signature');
    if (!verifyStatusSignature(r.publicKey, r.id, time, proof.signature))
      throw denied('bad_signature');
    if (Math.abs(nowS - time) > PAIRING_STATUS_SKEW_S) throw denied('stale_time');
    const nowIso = this.#iso();
    const step = await this.#db.transaction(async () => {
      // A poll must be newer than the last accepted one: a captured poll cannot be replayed.
      const res = this.#db.raw
        .prepare(
          `UPDATE device_pairing_request SET last_poll = ?
           WHERE id = ? AND (last_poll IS NULL OR last_poll < ?)`,
        )
        .run(time, r.id, time);
      if (Number(res.changes) !== 1) return { replayed: true as const };
      const cur = (await this.#request(r.id))!;
      if ((cur.status === 'pending' || cur.status === 'committed') && cur.expiresAt <= nowIso) {
        await this.#db.orm
          .update(devicePairingRequest)
          .set({ status: 'expired', decidedAt: nowIso })
          .where(eq(devicePairingRequest.id, cur.id));
        return {
          replayed: false as const,
          row: cur,
          expiredNow: cur.status === 'committed' ? ('commit' as const) : ('pending' as const),
        };
      }
      if (cur.status === 'approved' && !cur.grantedAt) {
        // A device revoked before it collected its grant gets nothing (fail closed).
        const dev = cur.deviceId
          ? await this.#db.orm
              .select({ status: device.status })
              .from(device)
              .where(eq(device.id, cur.deviceId))
              .limit(1)
          : [];
        if (dev[0]?.status === 'revoked' || !dev[0]) {
          await this.#db.orm
            .update(devicePairingRequest)
            .set({ status: 'denied' })
            .where(eq(devicePairingRequest.id, cur.id));
          return { replayed: false as const, row: { ...cur, status: 'denied' as const } };
        }
        if (cur.expiresAt <= nowIso) {
          await this.#db.orm
            .update(devicePairingRequest)
            .set({ status: 'expired' })
            .where(eq(devicePairingRequest.id, cur.id));
          return { replayed: false as const, row: cur, expiredNow: 'grant' as const };
        }
        // Claim the grant inside the transaction: it is handed out exactly once.
        await this.#db.orm
          .update(devicePairingRequest)
          .set({ grantType: grantTypeFor(cur.kind), grantedAt: nowIso })
          .where(and(eq(devicePairingRequest.id, cur.id), isNull(devicePairingRequest.grantedAt)));
        return { replayed: false as const, row: cur, claim: true as const };
      }
      return { replayed: false as const, row: cur };
    });
    if (step.replayed) throw denied('replayed');
    const row = step.row;
    if ('expiredNow' in step) {
      if (step.expiredNow === 'pending') await this.#announce(row, 'expired');
      if (step.expiredNow === 'commit') this.#revealCodes.delete(row.id);
      await this.#auditAppend(row.accountId, 'device.add.expire', row.id, {
        what: step.expiredNow === 'pending' ? 'request' : step.expiredNow,
      });
      return { view: { status: 'expired' }, kind: row.kind, sessionMaxAgeS: null };
    }
    if (row.status !== 'approved') {
      // A committed request waits for its reveal: still pending as far as the device knows.
      const status = row.status === 'committed' ? 'pending' : row.status;
      return { view: { status }, kind: row.kind, sessionMaxAgeS: null };
    }
    const view: AddDeviceStatusView = { status: 'approved', deviceId: row.deviceId! };
    if (!('claim' in step)) return { view, kind: row.kind, sessionMaxAgeS: null };
    try {
      const out = await this.#issueGrant(row, ctx.hubUrl);
      view.grant = out.grant;
      return { view, kind: row.kind, sessionMaxAgeS: out.sessionMaxAgeS };
    } catch (err) {
      if (err instanceof NovaError && err.details?.reason === 'device_revoked') {
        // Revoked while the grant was being made: it gets nothing, now or later (fail closed).
        await this.#db
          .transaction(() =>
            this.#db.orm
              .update(devicePairingRequest)
              .set({ status: 'denied', grantType: null, grantedAt: null })
              .where(eq(devicePairingRequest.id, row.id)),
          )
          .catch(() => undefined);
        return { view: { status: 'denied' }, kind: row.kind, sessionMaxAgeS: null };
      }
      // Nothing was handed out: let the device try again with its next poll.
      await this.#db
        .transaction(() =>
          this.#db.orm
            .update(devicePairingRequest)
            .set({ grantType: null, grantedAt: null })
            .where(eq(devicePairingRequest.id, row.id)),
        )
        .catch(() => undefined);
      this.#log.warn('add device grant failed', { err, requestId: row.id });
      throw err instanceof NovaError
        ? err
        : new NovaError('server_error', 'the Hub could not finish adding this device', {
            retryable: true,
          });
    }
  }

  async #issueGrant(
    r: RequestRow,
    hubUrl: string,
  ): Promise<{ grant: AddDeviceGrant; sessionMaxAgeS: number | null }> {
    const ctx: PairingGrantContext = {
      accountId: r.accountId,
      requestId: r.id,
      deviceId: r.deviceId!,
      role: r.role,
      kind: r.kind,
      publicKey: r.publicKey,
      name: r.name,
      scopes: parseScopes(r.scopes),
      hubUrl,
    };
    let grant: AddDeviceGrant;
    let sessionMaxAgeS: number | null = null;
    if (r.kind === 'novad' || r.kind === 'compute') {
      const issue = this.#grants[r.kind];
      if (!issue) {
        throw new NovaError('capability_missing', `the Hub cannot enroll a ${r.kind} device yet`, {
          details: { reason: 'grant_unavailable' },
        });
      }
      const enrollToken = await issue(ctx);
      grant =
        r.kind === 'novad' ? { type: 'novad', enrollToken } : { type: 'compute', enrollToken };
    } else {
      const days = (await this.#settings.sessionDays?.()) ?? DEVICE_SESSION_DAYS;
      sessionMaxAgeS = days * 24 * 60 * 60;
      grant = { type: 'session', token: await this.#issueSession(ctx, sessionMaxAgeS * 1000) };
    }
    if (this.#certIssuer && (await this.#deviceLive(ctx.deviceId))) {
      try {
        const cert = await this.#certIssuer.issueDeviceCertificate({
          deviceId: ctx.deviceId,
          publicKey: ctx.publicKey,
          role: ctx.role,
        });
        if (cert) grant.certificatePem = cert.certificatePem;
      } catch (err) {
        // The certificate is an extra; the grant stands without it.
        this.#log.warn('device certificate not issued', { err, deviceId: ctx.deviceId });
      }
    }
    return { grant, sessionMaxAgeS };
  }

  /**
   * A device session: an `auth_token` of kind `session` exactly as the Hub's AuthService issues
   * them (so the Hub's session check accepts it), tied to the device in `device_session`.
   */
  async #issueSession(ctx: PairingGrantContext, ttlMs: number): Promise<string> {
    const token = newToken('session');
    const now = this.#now();
    const tokenId = uuidv7();
    await this.#db.transaction(async () => {
      // A revocation may land between the claim and here: check in the same transaction that
      // inserts the session (review finding 16).
      if (!(await this.#deviceLive(ctx.deviceId))) {
        throw new NovaError('policy_denied', 'this device was revoked', {
          details: { reason: 'device_revoked' },
        });
      }
      await this.#db.orm.insert(authToken).values({
        id: tokenId,
        kind: 'session',
        tokenHash: hashToken(token),
        accountId: ctx.accountId,
        label: `device:${ctx.name}`.slice(0, 120),
        scopes: JSON.stringify(['device']),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      });
      await this.#db.orm.insert(deviceSession).values({
        tokenId,
        deviceId: ctx.deviceId,
        accountId: ctx.accountId,
        requestId: ctx.requestId,
        createdAt: now.toISOString(),
      });
      await this.#db.orm
        .update(device)
        .set({ lastSeenAt: now.toISOString(), updatedAt: now.toISOString() })
        .where(eq(device.id, ctx.deviceId));
    });
    return token;
  }

  /** True when the device record exists and is not revoked. */
  async #deviceLive(deviceId: string): Promise<boolean> {
    const rows = await this.#db.orm
      .select({ status: device.status })
      .from(device)
      .where(eq(device.id, deviceId))
      .limit(1);
    return rows[0] !== undefined && rows[0].status !== 'revoked';
  }

  // ---- approve and deny (owner) ----------------------------------------------------------------

  /** Requests of the account, newest first; pending ones by default. */
  async requests(
    accountId: string,
    status: AddDeviceRequestStatus | 'all' = 'pending',
  ): Promise<AddDeviceRequestView[]> {
    await this.sweep();
    // A committed request (v2) is not the owner's until the device reveals: it has no
    // confirmation yet, and one that never revealed is never shown.
    const where = [
      eq(devicePairingRequest.accountId, accountId),
      isNotNull(devicePairingRequest.confirmation),
    ];
    if (status !== 'all') where.push(eq(devicePairingRequest.status, status));
    const rows = await this.#db.orm
      .select()
      .from(devicePairingRequest)
      .where(and(...where))
      .orderBy(desc(devicePairingRequest.createdAt), desc(devicePairingRequest.id))
      .limit(200);
    return rows.map(requestView);
  }

  async #pendingFor(accountId: string, requestId: string): Promise<RequestRow> {
    const r = await this.#request(requestId);
    if (!r || r.accountId !== accountId || r.confirmation === null)
      throw new NovaError('not_found', 'request not found');
    if (r.status === 'pending' && r.expiresAt <= this.#iso()) {
      await this.sweep();
      throw new NovaError('request_expired', 'this request has expired', {
        details: { reason: 'expired' },
        action: 'Add the device again',
      });
    }
    if (r.status !== 'pending') {
      throw new NovaError('conflict', `this request was already ${r.status}`, {
        details: { reason: 'decided', status: r.status },
      });
    }
    return r;
  }

  /**
   * Approve: the owner typed the confirmation the device shows. Creates the device record (active
   * for a browser or app; pending until it registers for novad and compute nodes).
   */
  async approve(
    accountId: string,
    requestId: string,
    confirmation: string,
  ): Promise<AddDeviceRequestView> {
    const r = await this.#pendingFor(accountId, requestId);
    const typed = normalizeConfirmation(confirmation);
    if (!typed || !sameDigest(typed, r.confirmation ?? '')) {
      throw new NovaError('validation', 'the confirmation does not match the device', {
        details: { reason: 'confirmation_mismatch', field: 'confirmation' },
        action: 'Compare the six digits on both screens',
      });
    }
    if (await this.isKeyRevoked(r.publicKey)) {
      throw new NovaError('policy_denied', 'this device key was revoked', {
        details: { reason: 'key_revoked' },
      });
    }
    const nowIso = this.#iso();
    const scopes = parseScopes(r.scopes);
    const active = r.kind === 'browser' || r.kind === 'native';
    const deviceId = await this.#db.transaction(async () => {
      const cur = (await this.#request(r.id))!;
      if (cur.status !== 'pending') {
        throw new NovaError('conflict', `this request was already ${cur.status}`, {
          details: { reason: 'decided', status: cur.status },
        });
      }
      const fields = {
        name: r.name,
        kind: deviceKindFor(r.role, r.kind),
        platform: r.platform,
        publicKey: r.publicKey,
        roles: JSON.stringify([r.role]),
        scopes: JSON.stringify(scopes),
        status: active ? ('active' as const) : ('pending' as const),
        offlineReplica: scopes.includes('offline-replica'),
        localRuntime: scopes.includes('local-runtime'),
        lastSeenAt: active ? nowIso : null,
        updatedAt: nowIso,
      };
      const taken = await this.#db.orm
        .select()
        .from(device)
        .where(eq(device.certFingerprint, r.fingerprint))
        .limit(1);
      const existing = taken[0];
      let id: string;
      if (existing) {
        if (existing.status !== 'pending' || existing.accountId !== accountId) {
          throw new NovaError('conflict', 'this device key is already registered', {
            details: { reason: 'key_in_use' },
          });
        }
        id = existing.id;
        await this.#db.orm.update(device).set(fields).where(eq(device.id, id));
      } else {
        id = uuidv7();
        await this.#db.orm.insert(device).values({
          id,
          accountId,
          certFingerprint: r.fingerprint,
          createdAt: nowIso,
          ...fields,
        });
      }
      await this.#db.orm
        .update(devicePairingRequest)
        .set({
          status: 'approved',
          deviceId: id,
          decidedAt: nowIso,
          // The device has 10 more minutes to collect its grant.
          expiresAt: new Date(this.#now().getTime() + PAIRING_REQUEST_TTL_MS).toISOString(),
        })
        .where(eq(devicePairingRequest.id, r.id));
      return id;
    });
    const done = (await this.#request(r.id))!;
    await this.#auditAppend(
      accountId,
      'device.add.approve',
      r.id,
      { deviceId, role: r.role, kind: r.kind, name: r.name, fingerprint: r.fingerprint },
      { actor: 'user', decision: 'approved' },
    );
    await this.#announce(done, 'approved');
    return requestView(done);
  }

  async deny(accountId: string, requestId: string): Promise<AddDeviceRequestView> {
    const r = await this.#pendingFor(accountId, requestId);
    const nowIso = this.#iso();
    const changed = await this.#db.transaction(() =>
      Number(
        this.#db.raw
          .prepare(
            `UPDATE device_pairing_request SET status = 'denied', decided_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(nowIso, r.id).changes,
      ),
    );
    const done = (await this.#request(r.id))!;
    // A concurrent approval (or expiry) won: nothing was denied, so nothing is announced.
    if (changed !== 1) {
      throw new NovaError('conflict', `this request was already ${done.status}`, {
        details: { reason: 'decided', status: done.status },
      });
    }
    await this.#auditAppend(
      accountId,
      'device.add.deny',
      r.id,
      { role: r.role, kind: r.kind, name: r.name, fingerprint: r.fingerprint },
      { actor: 'user', decision: 'denied' },
    );
    await this.#announce(done, 'denied');
    return requestView(done);
  }

  // ---- expiry --------------------------------------------------------------------------------

  /** Expire open pairings and undecided or uncollected requests past their time. */
  async sweep(): Promise<{ pairings: number; requests: number }> {
    const nowIso = this.#iso();
    for (const [id, kept] of this.#relayCodes)
      if (kept.expiresAt <= nowIso) this.#relayCodes.delete(id);
    const { pairings, requests, grants, commits } = await this.#db.transaction(async () => {
      const pairings = await this.#db.orm
        .select()
        .from(devicePairing)
        .where(and(eq(devicePairing.status, 'open'), lte(devicePairing.expiresAt, nowIso)));
      if (pairings.length) {
        await this.#db.orm
          .update(devicePairing)
          .set({ status: 'expired' })
          .where(
            inArray(
              devicePairing.id,
              pairings.map((p) => p.id),
            ),
          );
      }
      const requests = await this.#db.orm
        .select()
        .from(devicePairingRequest)
        .where(
          and(
            eq(devicePairingRequest.status, 'pending'),
            lte(devicePairingRequest.expiresAt, nowIso),
          ),
        );
      const grants = await this.#db.orm
        .select()
        .from(devicePairingRequest)
        .where(
          and(
            eq(devicePairingRequest.status, 'approved'),
            isNull(devicePairingRequest.grantedAt),
            lte(devicePairingRequest.expiresAt, nowIso),
          ),
        );
      const commits = await this.#db.orm
        .select()
        .from(devicePairingRequest)
        .where(
          and(
            eq(devicePairingRequest.status, 'committed'),
            lte(devicePairingRequest.expiresAt, nowIso),
          ),
        );
      if (requests.length) {
        await this.#db.orm
          .update(devicePairingRequest)
          .set({ status: 'expired', decidedAt: nowIso })
          .where(
            inArray(
              devicePairingRequest.id,
              requests.map((r) => r.id),
            ),
          );
      }
      if (grants.length) {
        await this.#db.orm
          .update(devicePairingRequest)
          .set({ status: 'expired' })
          .where(
            inArray(
              devicePairingRequest.id,
              grants.map((r) => r.id),
            ),
          );
      }
      return { pairings, requests, grants, commits };
    });
    await this.#expireCommitted(commits);
    for (const [id, kept] of this.#revealCodes)
      if (kept.expiresAt <= nowIso) this.#revealCodes.delete(id);
    for (const p of pairings) {
      this.#relayCodes.delete(p.id);
      await this.#auditAppend(p.accountId, 'device.add.expire', p.id, { what: 'pairing' });
    }
    for (const r of requests) {
      await this.#auditAppend(r.accountId, 'device.add.expire', r.id, { what: 'request' });
      await this.#announce({ ...r, status: 'expired' }, 'expired');
    }
    for (const r of grants)
      await this.#auditAppend(r.accountId, 'device.add.expire', r.id, { what: 'grant' });
    return {
      pairings: pairings.length,
      requests: requests.length + grants.length + commits.length,
    };
  }

  /** Sweep on an interval until `stopSweeper()`. */
  startSweeper(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.#log.warn('add device sweep failed', { err }));
    }, this.#sweepIntervalMs);
    this.#timer.unref();
  }

  stopSweeper(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- revocation (docs/22 §4.5) ---------------------------------------------------------------

  /**
   * After any revocation (a compute node, a novad device, a browser or app): its sessions are
   * deleted, enrollment tokens still bound to it are refused, and its key is blocked from joining
   * again. `audit` records `device.revoke` for callers that do not audit it themselves.
   */
  async deviceRevoked(
    deviceId: string,
    opts: { accountId?: string; audit?: boolean; actor?: string } = {},
  ): Promise<void> {
    const rows = await this.#db.orm.select().from(device).where(eq(device.id, deviceId)).limit(1);
    const d = rows[0];
    if (!d || (opts.accountId && d.accountId !== opts.accountId)) return;
    const nowIso = this.#iso();
    const sessions = await this.#db.transaction(async () => {
      const tokens = await this.#db.orm
        .select({ tokenId: deviceSession.tokenId })
        .from(deviceSession)
        .where(eq(deviceSession.deviceId, d.id));
      const ids = tokens.map((t) => t.tokenId);
      if (ids.length) {
        await this.#db.orm.delete(deviceSession).where(inArray(deviceSession.tokenId, ids));
        await this.#db.orm.delete(authToken).where(inArray(authToken.id, ids));
      }
      this.#db.raw
        .prepare(
          `INSERT INTO revoked_device_key (fingerprint, account_id, device_id, reason, created_at)
           VALUES (?, ?, ?, 'revoked', ?) ON CONFLICT (fingerprint) DO NOTHING`,
        )
        .run(d.certFingerprint, d.accountId, d.id, nowIso);
      // An enrollment token handed to this device but not used yet dies with it, and so does a
      // grant it has not collected.
      this.#db.raw
        .prepare(
          `UPDATE add_device_request SET status = 'denied'
           WHERE status = 'pending' AND json_extract(scopes, '$.bind.deviceId') = ?`,
        )
        .run(d.id);
      this.#db.raw
        .prepare(
          `UPDATE device_pairing_request SET status = 'denied'
           WHERE device_id = ? AND status = 'approved' AND granted_at IS NULL`,
        )
        .run(d.id);
      return ids.length;
    });
    if (opts.audit) {
      await this.#auditAppend(
        d.accountId,
        'device.revoke',
        d.id,
        { name: d.name, kind: d.kind, sessions, fingerprint: d.certFingerprint },
        { actor: opts.actor ?? 'user' },
      );
    }
    if (this.#certIssuer?.revokeDeviceCertificates) {
      try {
        await this.#certIssuer.revokeDeviceCertificates(d.id);
      } catch (err) {
        // The key is blocked and the sessions are gone either way; say what was left.
        this.#log.error('device certificates not revoked', { err, deviceId: d.id });
      }
    }
  }

  /**
   * Revoke a device that neither the compute-node registry nor novad manages: a browser or app,
   * or a novad device approved here that never registered. Idempotent.
   */
  async revokeDevice(accountId: string, deviceId: string): Promise<void> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(and(eq(device.id, deviceId), eq(device.accountId, accountId)))
      .limit(1);
    const d = rows[0];
    if (!d) throw new NovaError('not_found', 'device not found');
    if (d.status === 'revoked') return;
    const nowIso = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(device)
        .set({ status: 'revoked', credentialTokenId: null, updatedAt: nowIso })
        .where(eq(device.id, d.id));
      if (d.credentialTokenId)
        await this.#db.orm.delete(authToken).where(eq(authToken.id, d.credentialTokenId));
      await this.#db.orm
        .update(transportEndpoint)
        .set({ healthy: false, lastCheckedAt: nowIso })
        .where(eq(transportEndpoint.deviceId, d.id));
    });
    await this.deviceRevoked(d.id, { accountId, audit: true });
    await this.#emit(
      'device.status.changed',
      accountId,
      { deviceId: d.id, from: d.status, status: 'revoked' },
      'user',
    );
  }

  // ---- the device list and scopes (FR-140) -----------------------------------------------------

  /** Every device record of the account, whatever it runs, oldest first. */
  async list(accountId: string): Promise<DeviceSummaryView[]> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(eq(device.accountId, accountId))
      .orderBy(asc(device.createdAt), asc(device.id));
    return Promise.all(rows.map((d) => this.#summary(d)));
  }

  async summary(accountId: string, deviceId: string): Promise<DeviceSummaryView> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(and(eq(device.id, deviceId), eq(device.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'device not found');
    return this.#summary(rows[0]);
  }

  async #summary(d: DeviceRow): Promise<DeviceSummaryView> {
    const nowIso = this.#iso();
    const live = this.#db.raw
      .prepare(
        `SELECT count(*) AS n FROM device_session s JOIN auth_token t ON t.id = s.token_id
         WHERE s.device_id = ? AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at > ?)`,
      )
      .get(d.id, nowIso) as { n: number } | undefined;
    const added = await this.#db.orm
      .select({ kind: devicePairingRequest.kind })
      .from(devicePairingRequest)
      .where(
        and(eq(devicePairingRequest.deviceId, d.id), eq(devicePairingRequest.status, 'approved')),
      )
      .orderBy(desc(devicePairingRequest.createdAt))
      .limit(1);
    let roles: string[] = [];
    try {
      const v: unknown = JSON.parse(d.roles);
      if (Array.isArray(v)) roles = v.filter((x): x is string => typeof x === 'string');
    } catch {
      roles = [];
    }
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      addedAs: added[0]?.kind ?? null,
      roles,
      scopes: parseScopes(d.scopes),
      platform: d.platform,
      status: d.status,
      fingerprint: d.certFingerprint,
      sessions: live?.n ?? 0,
      novadVersion: d.novadVersion,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    };
  }

  /** Replace a device's scopes (docs/22 §4.2: chosen at add time, editable later). */
  async setScopes(
    accountId: string,
    deviceId: string,
    scopes: readonly string[],
  ): Promise<DeviceSummaryView> {
    const before = await this.summary(accountId, deviceId);
    if (before.status === 'revoked') {
      throw new NovaError('conflict', 'this device was revoked', {
        details: { reason: 'revoked' },
      });
    }
    const next = [...new Set(scopes)];
    const nowIso = this.#iso();
    await this.#db.transaction(() =>
      this.#db.orm
        .update(device)
        .set({
          scopes: JSON.stringify(next),
          offlineReplica: next.includes('offline-replica'),
          localRuntime: next.includes('local-runtime'),
          updatedAt: nowIso,
        })
        .where(eq(device.id, deviceId)),
    );
    await this.#auditAppend(
      accountId,
      'device.scopes.update',
      deviceId,
      { from: before.scopes, to: next },
      { actor: 'user' },
    );
    await this.#emit('device.scopes.changed', accountId, { deviceId, scopes: next }, 'user');
    return this.summary(accountId, deviceId);
  }
}
