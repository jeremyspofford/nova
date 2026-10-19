// A stand-in for novad's boot routes (ADR-096 D5) for tests: a bootloader with entries, a default
// and a ONE-SHOT next boot (the pending entry boots once, then the default again), the pending
// marker novad keeps across a restart, and the watchdog reports it puts in its next heartbeat.
// It checks the Hub's device authorization (D2) on its own, from the pinned Hub public key, the way
// novad does: signature, kind, device, body hash, time window with 120 s of skew, and change ids
// seen in the last 24 h (a replay is 409 `conflict` `replayed`). Nothing touches a real machine.
import { createHash, verify } from 'node:crypto';
import type { Bootloader } from '@nova/shared';
import type { DeviceTransport, DeviceTransportResponse } from '../devices/client.ts';
import { canonicalJson, ed25519PublicKey } from '../nodes/crypto.ts';
import {
  BOOT_COMMIT_PATH,
  BOOT_REVERT_PATH,
  BOOT_SET_PATH,
  BOOT_STATUS_PATH,
  type BootAuthzKind,
} from './protocol.ts';

const AUTHZ_DOMAIN = 'nova-device-authz-v1\n';
const SKEW_MS = 120_000;
const MAX_LIFETIME_MS = 10 * 60_000;
const REPLAY_MS = 24 * 60 * 60_000;

export interface FakeBootDeviceOptions {
  /** The Hub identity key novad pinned (raw Ed25519, base64url). */
  hubPublicKey: string;
  /** The Hub's id for this device (an authorization must name it). */
  deviceId: string;
  /** The management token the Hub presents; any is accepted without it. */
  managementToken?: string;
  entries?: { id: string; title: string }[];
  defaultEntry?: string;
  bootloader?: Bootloader;
  /** An unsupported bootloader answers `supported: false` with this reason. */
  unsupported?: string;
  /** The heartbeat answer's `policy.lowLevelBoot` as novad stored it (default false). */
  lowLevelBoot?: boolean;
  now?: () => Date;
}

class FakeBootError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;
  constructor(status: number, code: string, message: string, reason: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') return Date.parse(v);
  return Number.NaN;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The boot side of a fake novad. */
export class FakeBootDevice {
  readonly deviceId: string;
  readonly entries: { id: string; title: string }[];
  defaultEntry: string;
  /** The entry the machine runs now. */
  booted: string;
  /** The bootloader's one-shot next boot (consumed by the next boot). */
  oneShot: string | null = null;
  /** novad's `boot/pending.json`, with the change id of the `set` that wrote it. */
  marker: { profileId: string; entryId: string; deadline: number; changeId: string } | null = null;
  /** Leave the change id out of watchdog events, as a novad from before the M7.5 review did. */
  omitChangeId = false;
  /**
   * GRUB: novad cannot see which entry booted, so an ok is `verified: false`; and
   * `grub-set-default` only works with `GRUB_DEFAULT=saved` (commit answers 409 otherwise).
   */
  grub: { defaultSaved: boolean } | null = null;
  last: {
    profileId: string;
    entryId: string;
    result: 'ok' | 'reverted' | 'failed';
    at: string;
  } | null = null;
  lowLevelBoot: boolean;
  /** The other device-side toggle, kept for `/agent/v1/config` answers. */
  firmwareChanges = false;
  /** Whether novad is running (a machine that did not come up sends nothing). */
  up = true;
  /** Restarts asked for by `boot/set` with `reboot: true`. */
  rebootsRequested = 0;
  readonly calls: { path: string; body: Record<string, unknown> }[] = [];
  /** Every refusal, for assertions (`authorization_invalid`, `replayed`, …). */
  readonly refusals: { path: string; code: string; reason: string | null }[] = [];
  readonly #hubKey: ReturnType<typeof ed25519PublicKey>;
  readonly #token: string | null;
  readonly #bootloader: Bootloader;
  readonly #unsupported: string | null;
  readonly #now: () => Date;
  readonly #used = new Map<string, number>();
  readonly #events: Record<string, unknown>[] = [];

  constructor(opts: FakeBootDeviceOptions) {
    this.deviceId = opts.deviceId;
    this.#hubKey = ed25519PublicKey(opts.hubPublicKey);
    this.#token = opts.managementToken ?? null;
    this.entries = opts.entries ?? [
      { id: 'linux.conf', title: 'Linux' },
      { id: 'linux-next.conf', title: 'Linux (next kernel)' },
    ];
    this.defaultEntry = opts.defaultEntry ?? this.entries[0]!.id;
    this.booted = this.defaultEntry;
    this.#bootloader = opts.bootloader ?? 'systemd-boot';
    this.#unsupported = opts.unsupported ?? null;
    this.lowLevelBoot = opts.lowLevelBoot ?? false;
    this.#now = opts.now ?? (() => new Date());
  }

  /** A `DeviceTransport` that answers the boot routes in process. */
  transport(): DeviceTransport {
    return {
      post: (url, token, body) => Promise.resolve(this.handle(new URL(url).pathname, body, token)),
    };
  }

  /** The machine restarts: a one-shot boots once, then novad starts and checks its marker. */
  powerCycle(opts: { comesUp?: boolean } = {}): void {
    this.booted = this.oneShot ?? this.defaultEntry;
    this.oneShot = null;
    this.up = opts.comesUp ?? true;
    if (this.up) this.#start();
  }

  /** What novad puts in the `events` of its next heartbeat (drained). */
  takeEvents(): Record<string, unknown>[] {
    return this.up ? this.#events.splice(0) : [];
  }

  /** novad starting with a pending marker (D5): confirmed on the entry before the deadline, else back to the default. */
  #start(): void {
    const m = this.marker;
    if (!m) return;
    this.marker = null;
    const at = this.#now().toISOString();
    // novad's event shape (R1): the trial's change id, ok `{booted}`, reverted `{reason, rebooted,
    // error, booted?}`.
    const head = {
      ...(this.omitChangeId ? {} : { changeId: m.changeId }),
      profileId: m.profileId,
      entryId: m.entryId,
      at,
    };
    // GRUB cannot tell which entry booted: any start before the deadline counts (unverified).
    const seen = this.grub !== null || this.booted === m.entryId;
    if (seen && this.#now().getTime() <= m.deadline) {
      this.last = { profileId: m.profileId, entryId: m.entryId, result: 'ok', at };
      this.#events.push({
        kind: 'boot.watchdog.ok',
        ...head,
        verified: this.grub === null,
        detail: { booted: this.grub === null ? this.booted : null },
      });
      return;
    }
    this.last = { profileId: m.profileId, entryId: m.entryId, result: 'reverted', at };
    this.#events.push({
      kind: 'boot.watchdog.reverted',
      ...head,
      detail: {
        reason: this.booted === m.entryId ? 'deadline' : 'not_booted',
        rebooted: this.booted === m.entryId,
        error: null,
        booted: this.booted,
      },
    });
    // It reboots once into the default (never loops: the marker is gone).
    this.booted = this.defaultEntry;
  }

  handle(path: string, raw: unknown, token?: string): DeviceTransportResponse {
    try {
      if (this.#token && token !== this.#token)
        throw new FakeBootError(401, 'token_required', 'a valid management token is required');
      if (!this.up) throw new FakeBootError(503, 'node_unavailable', 'the device is down');
      if (!isRecord(raw)) throw new FakeBootError(400, 'validation', 'expected a JSON object');
      this.calls.push({ path, body: raw });
      return { status: 200, body: this.#route(path, raw) };
    } catch (err) {
      if (!(err instanceof FakeBootError)) throw err;
      this.refusals.push({ path, code: err.code, reason: err.reason });
      return {
        status: err.status,
        body: {
          error: {
            code: err.code,
            message: err.message,
            ...(err.reason ? { details: { reason: err.reason } } : {}),
          },
        },
      };
    }
  }

  #route(path: string, body: Record<string, unknown>): Record<string, unknown> {
    switch (path) {
      case BOOT_STATUS_PATH:
        return this.#status();
      case '/agent/v1/config': {
        // The Hub's toggles pushed at once (D3, M7.5): only `true` turns one on, an absent one
        // keeps its value; the answer says what is in effect.
        const p = isRecord(body.policy) ? body.policy : {};
        if (typeof p.lowLevelBoot === 'boolean') this.lowLevelBoot = p.lowLevelBoot;
        if (typeof p.firmwareChanges === 'boolean') this.firmwareChanges = p.firmwareChanges;
        return {
          policy: { firmwareChanges: this.firmwareChanges, lowLevelBoot: this.lowLevelBoot },
        };
      }
      case BOOT_SET_PATH: {
        this.#supported();
        this.#policy();
        this.#verify('boot.set', body);
        const entryId = this.#entry(body.entryId);
        if (this.marker)
          throw new FakeBootError(409, 'conflict', 'a boot is pending', 'boot_pending');
        const seconds = Number(body.watchdogSeconds);
        if (!Number.isInteger(seconds) || seconds <= 0)
          throw new FakeBootError(400, 'validation', 'watchdogSeconds');
        const deadline = this.#now().getTime() + seconds * 1000;
        const auth = isRecord(body.authorization) ? body.authorization : {};
        const payload = isRecord(auth.payload) ? auth.payload : {};
        this.marker = {
          profileId: String(body.profileId),
          entryId,
          deadline,
          changeId: typeof payload.changeId === 'string' ? payload.changeId : '',
        };
        this.oneShot = entryId;
        if (body.reboot === true) this.rebootsRequested += 1;
        return {
          pending: {
            profileId: this.marker.profileId,
            entryId,
            deadline: new Date(deadline).toISOString(),
          },
        };
      }
      case BOOT_COMMIT_PATH: {
        this.#supported();
        this.#policy();
        this.#verify('boot.commit', body);
        if (this.grub && !this.grub.defaultSaved)
          throw new FakeBootError(
            409,
            'conflict',
            'GRUB_DEFAULT is not "saved": grub-set-default would change nothing',
            'grub_default_not_saved',
          );
        this.defaultEntry = this.#entry(body.entryId);
        return { default: this.defaultEntry };
      }
      case BOOT_REVERT_PATH: {
        // Revert always works whatever the policy says, but needs its authorization.
        this.#verify('boot.revert', body);
        const cleared = this.oneShot !== null || this.marker !== null;
        this.oneShot = null;
        this.marker = null;
        return { cleared };
      }
      default:
        throw new FakeBootError(404, 'not_found', 'unknown route');
    }
  }

  #status(): Record<string, unknown> {
    return {
      supported: this.#unsupported === null,
      ...(this.#unsupported ? { reason: this.#unsupported } : {}),
      bootloader: this.#unsupported ? 'none' : this.#bootloader,
      entries: this.#unsupported
        ? []
        : this.entries.map((e) => ({ ...e, isDefault: e.id === this.defaultEntry })),
      booted: this.booted,
      pending: this.marker
        ? {
            profileId: this.marker.profileId,
            entryId: this.marker.entryId,
            deadline: new Date(this.marker.deadline).toISOString(),
          }
        : null,
      last: this.last,
    };
  }

  #supported(): void {
    if (this.#unsupported)
      throw new FakeBootError(409, 'conflict', this.#unsupported, 'unsupported_hardware');
  }

  #policy(): void {
    if (!this.lowLevelBoot)
      throw new FakeBootError(403, 'policy_denied', 'low-level boot is off', 'low_level_boot_off');
  }

  #entry(v: unknown): string {
    const e = this.entries.find((x) => x.id === v);
    if (!e) throw new FakeBootError(404, 'not_found', 'no such boot entry');
    return e.id;
  }

  /** novad's D2 check, written independently of the Hub's signer. */
  #verify(kind: BootAuthzKind, body: Record<string, unknown>): void {
    const bad = (reason: string, status = 403, code = 'policy_denied') =>
      new FakeBootError(status, code, `authorization refused: ${reason}`, reason);
    const auth = body.authorization;
    if (!isRecord(auth) || !isRecord(auth.payload) || typeof auth.signature !== 'string')
      throw bad('authorization_invalid');
    const payload = auth.payload;
    const bytes = Buffer.from(AUTHZ_DOMAIN + canonicalJson(payload), 'utf8');
    let ok: boolean;
    try {
      ok =
        this.#hubKey !== null &&
        verify(null, bytes, this.#hubKey, Buffer.from(auth.signature, 'base64url'));
    } catch {
      ok = false;
    }
    if (!ok || payload.v !== 1) throw bad('authorization_invalid');
    const rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'authorization'));
    const sha = createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
    if (payload.kind !== kind || payload.deviceId !== this.deviceId || payload.bodySha256 !== sha)
      throw bad('authorization_mismatch');
    const issued = toMs(payload.issuedAt);
    const expires = toMs(payload.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires - issued > MAX_LIFETIME_MS)
      throw bad('authorization_invalid');
    const now = this.#now().getTime();
    if (now < issued - SKEW_MS || now > expires + SKEW_MS) throw bad('authorization_expired');
    for (const [id, until] of this.#used) if (until < now) this.#used.delete(id);
    const changeId = typeof payload.changeId === 'string' ? payload.changeId : '';
    if (!changeId) throw bad('authorization_invalid');
    if (this.#used.has(changeId)) throw bad('replayed', 409, 'conflict');
    this.#used.set(changeId, now + REPLAY_MS);
  }
}
