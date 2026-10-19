// Low-level boot on the Hub (FR-143, docs/23 §5.2, ADR-096 D2, D3, D5): named boot profiles per
// device, a one-shot trial of a profile with a watchdog, and making a confirmed trial the default.
//
// Every privileged change (`try`, `commit`, `revert`) is a request the owner makes; try and commit
// wait for an approval card for exactly that change (risk high, confirm at action) and are sent
// once, when it is approved, with a device authorization the Hub signs (D2). A revert is a safety
// action: the owner's own request is its approval and it works whatever the toggle says. With
// `devices.boot.allowLowLevel` off, try and commit are refused (403 `policy_denied`
// `low_level_boot_off`) when asked and again when sent. Nothing here is reachable by a model.
//
// The device boots the entry once (a one-shot), so a machine that never comes up returns to its
// default by itself on the next power cycle. The device reports `boot.watchdog.ok|reverted` in a
// heartbeat; a trial still pending 120 s after its deadline is `failed` by the Hub, which tells the
// owner (with the device's out-of-band power cycle when one is linked; the owner's action).
import {
  BOOT_WATCHDOG_GRACE_SECONDS,
  NovaError,
  uuidv7,
  type BootAttemptStatus,
  type BootAttemptView,
  type BootProfileView,
  type BootRequestKind,
  type BootRequestView,
  type CreateBootProfileInput,
  type DeviceBootStatusView,
  type DeviceBootView,
  type UpdateBootProfileInput,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { z } from 'zod';
import type { EventSink } from '../events.ts';
import { canonicalJson } from '../nodes/crypto.ts';
import type { AuditSink, NotificationInput, Notifier } from '../tools/types.ts';
import {
  BOOT_COMMIT_PATH,
  BOOT_REVERT_PATH,
  BOOT_SET_PATH,
  BOOT_STATUS_PATH,
  bootBodySha256,
  bootSetAnswerSchema,
  bootStatusView,
  bootWatchdogEventSchema,
  type BootAuthorizer,
  type BootAuthzKind,
} from './protocol.ts';

type SqlValue = string | number | null;

/** A novad device as the boot service needs it. */
export interface BootDevice {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
}

/** How the boot service reaches devices (the devices area's registry and management client). */
export interface BootDeviceLink {
  /** The account's novad device, or `not_found`. */
  device(accountId: string, deviceId: string): Promise<BootDevice>;
  /** A management call; device refusals and an unreachable device come back as NovaError. */
  call(
    accountId: string,
    deviceId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Bring the device's toggles up to date before a privileged send (`DeviceService.syncPolicy`,
   * D3): low-level boot turned on a moment ago reaches the device now, not at its next heartbeat.
   */
  syncPolicy?(
    accountId: string,
    deviceId: string,
    opts?: { force?: boolean },
  ): Promise<{ confirmed: boolean }>;
}

/**
 * The out-of-band endpoint linked to a device, whose power cycle a failed trial's alert offers
 * (the out-of-band area's `powerCycleFor`; the owner asks for and approves the cycle there).
 */
export interface BootPowerCycleLink {
  endpointId: string;
  endpointName: string;
}
export type BootPowerCycleLookup = (
  accountId: string,
  deviceId: string,
) => Promise<BootPowerCycleLink | null>;

export interface BootSettings {
  allowLowLevel(): Promise<boolean>;
  watchdogSeconds(): Promise<number>;
}

export interface BootServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  devices: BootDeviceLink;
  settings: BootSettings;
  /** The D2 signer; until it is bound, sending refuses with `identity_missing`. */
  authorize?: BootAuthorizer;
  log?: Logger;
  audit?: AuditSink;
  notifier?: Notifier;
  now?: () => Date;
  /** How long a request waits for its approval (default 30 minutes). */
  requestTtlMs?: number;
  /** How often the watchdog looks (default 15 s). */
  sweepIntervalMs?: number;
}

interface ProfileRow {
  id: string;
  account_id: string;
  device_id: string;
  name: string;
  entry_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RequestRow {
  id: string;
  account_id: string;
  device_id: string;
  kind: BootRequestKind;
  profile_id: string | null;
  attempt_id: string | null;
  entry_id: string | null;
  body_json: string;
  before_json: string;
  approval_id: string | null;
  change_id: string;
  status: BootRequestView['status'];
  error_code: string | null;
  error_reason: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  sent_at: string | null;
}

interface AttemptRow {
  id: string;
  account_id: string;
  device_id: string;
  profile_id: string;
  request_id: string;
  entry_id: string;
  status: BootAttemptStatus;
  reboot: number;
  watchdog_seconds: number;
  deadline: string;
  reason: string | null;
  detail: string | null;
  verified: number | null;
  committed_at: string | null;
  created_at: string;
  finished_at: string | null;
}

/** The device's boot state when a change was asked: shown as "from" and audited as before. */
interface BootBefore {
  booted: string | null;
  default: string | null;
  pending: { profileId: string; entryId: string } | null;
}

const REQUEST_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 15_000;
const LIST_LIMIT = 20;
/** The clock skew D2 allows between the Hub and a device. */
const CLOCK_SKEW_MS = 120_000;
/** Reasons the Hub's own watchdog gives; a later device report may still close such a trial. */
const HUB_FAILURES = ['no_heartbeat', 'no_watchdog_report'];

const AUTHZ_KIND: Record<BootRequestKind, BootAuthzKind> = {
  try: 'boot.set',
  commit: 'boot.commit',
  revert: 'boot.revert',
};
const PATH: Record<BootRequestKind, string> = {
  try: BOOT_SET_PATH,
  commit: BOOT_COMMIT_PATH,
  revert: BOOT_REVERT_PATH,
};

function errorOf(err: unknown): { code: string; reason: string | null; message: string } {
  if (err instanceof NovaError) {
    const reason = err.details?.reason;
    return {
      code: err.code,
      reason: typeof reason === 'string' ? reason : null,
      message: err.message.slice(0, 500),
    };
  }
  if (err instanceof z.ZodError)
    return {
      code: 'server_error',
      reason: 'bad_answer',
      message: 'the device sent an answer the Hub cannot read',
    };
  return { code: 'server_error', reason: null, message: 'the boot change failed' };
}

/** novad refused because its copy of the low-level boot toggle is off. */
function deviceLowLevelOff(err: unknown): boolean {
  return (
    err instanceof NovaError &&
    err.code === 'policy_denied' &&
    err.details?.reason === 'low_level_boot_off'
  );
}

/**
 * The device still holds the old toggle after a push and a retry: the request goes back to
 * waiting with its approval unspent, and the sweep sends it again until it expires.
 */
const POLICY_STALE = 'device_policy_stale';

function lowLevelOff(): NovaError {
  return new NovaError('policy_denied', 'low-level boot changes are turned off on this Hub', {
    details: { reason: 'low_level_boot_off' },
    action: 'Turn on "Allow low-level boot changes" in settings',
  });
}

function parseJson<T>(raw: string | null, fallback: T): T {
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

/**
 * Why the device ended a trial on its default entry, in words, from novad's reason (the first
 * word of the attempt's detail): `deadline` (it restarted into the entry and was not back in
 * time), `not_booted` (it started another entry), `not_restarted` (it never restarted before the
 * deadline, so the one-shot was cleared).
 */
export function bootRevertText(profile: string, detail: string | null): string {
  switch (detail?.split(':')[0]?.trim() ?? null) {
    case 'deadline':
      return `The device restarted into ${profile} but was not back in time, so it returned to its default entry.`;
    case 'not_booted':
      return `The device did not start ${profile} (it booted another entry), so it is on its default entry.`;
    case 'not_restarted':
      return `The device did not restart before the watchdog deadline, so the one-shot boot of ${profile} was cleared and it stays on its default entry.`;
    default:
      return `The trial of ${profile} ended and the device is on its default entry.`;
  }
}

/** `verified` of a `boot.watchdog.ok`, on the event or in its detail; true when absent. */
function verifiedOf(e: { verified?: boolean | null; detail?: unknown }): boolean {
  if (typeof e.verified === 'boolean') return e.verified;
  if (isRecord(e.detail) && typeof e.detail.verified === 'boolean') return e.detail.verified;
  return true;
}

/**
 * A watchdog event's `detail` as one line: novad's object (`{reason, error?, booted?}`) as its
 * reason and error, anything else as text.
 */
function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  if (isRecord(detail) && typeof detail.reason === 'string') {
    const error = typeof detail.error === 'string' && detail.error ? `: ${detail.error}` : '';
    return `${detail.reason}${error}`.slice(0, 500);
  }
  if (isRecord(detail) && Object.keys(detail).length === 0) return null;
  const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return s.slice(0, 500);
}

export class BootService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #devices: BootDeviceLink;
  readonly #settings: BootSettings;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #requestTtlMs: number;
  readonly #sweepIntervalMs: number;
  #authorize: BootAuthorizer | null;
  #audit: AuditSink | null;
  #notifier: Notifier | null;
  #powerCycle: BootPowerCycleLookup | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BootServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#devices = opts.devices;
    this.#settings = opts.settings;
    this.#authorize = opts.authorize ?? null;
    this.#log = opts.log ?? new Logger({ module: 'core.boot', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#notifier = opts.notifier ?? null;
    this.#now = opts.now ?? (() => new Date());
    this.#requestTtlMs = opts.requestTtlMs ?? REQUEST_TTL_MS;
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  useAuthorizer(authorize: BootAuthorizer | null): void {
    this.#authorize = authorize;
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  useNotifier(notifier: Notifier): void {
    this.#notifier = notifier;
  }

  /** Where a failed trial's alert sends the owner: the device's out-of-band power cycle. */
  usePowerCycle(lookup: BootPowerCycleLookup | null): void {
    this.#powerCycle = lookup;
  }

  /** `policy.lowLevelBoot` of the heartbeat answer (D3): whether the device may set or commit. */
  lowLevelBoot(): Promise<boolean> {
    return this.#settings.allowLowLevel();
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** The device's own boot status with the Hub's profiles, trials and requests. */
  async view(
    accountId: string,
    deviceId: string,
  ): Promise<Omit<DeviceBootView, 'pxe' | 'pxeEnabled'>> {
    const d = await this.#devices.device(accountId, deviceId);
    let status: DeviceBootStatusView | null = null;
    let statusError: DeviceBootView['statusError'] = null;
    if (d.status !== 'revoked') {
      try {
        status = bootStatusView(await this.#devices.call(accountId, d.id, BOOT_STATUS_PATH, {}));
        await this.#reconcile(accountId, d, status);
      } catch (err) {
        statusError = errorOf(err);
      }
    } else {
      statusError = { code: 'conflict', reason: 'revoked', message: 'the device is revoked' };
    }
    await this.#auditAppend(
      accountId,
      'device.boot.read',
      d.id,
      {
        supported: status?.supported ?? null,
        bootloader: status?.bootloader ?? null,
        booted: status?.booted ?? null,
        pending: status?.pending ?? null,
      },
      { result: statusError ? statusError.code : 'ok' },
    );
    return {
      deviceId: d.id,
      lowLevelBoot: await this.#settings.allowLowLevel(),
      watchdogSeconds: await this.#settings.watchdogSeconds(),
      status,
      statusError,
      profiles: await this.profiles(accountId, d.id),
      attempts: this.#all<AttemptRow>(
        'SELECT * FROM boot_attempt WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        d.id,
        LIST_LIMIT,
      ).map(attemptView),
      requests: this.#all<RequestRow>(
        'SELECT * FROM boot_request WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        d.id,
        LIST_LIMIT,
      ).map(requestView),
    };
  }

  async profiles(accountId: string, deviceId: string): Promise<BootProfileView[]> {
    const d = await this.#devices.device(accountId, deviceId);
    return this.#all<ProfileRow>(
      'SELECT * FROM boot_profile WHERE device_id = ? AND deleted_at IS NULL ORDER BY name, id',
      d.id,
    ).map(profileView);
  }

  async request(accountId: string, deviceId: string, requestId: string): Promise<BootRequestView> {
    const d = await this.#devices.device(accountId, deviceId);
    const row = this.#get<RequestRow>(
      'SELECT * FROM boot_request WHERE id = ? AND device_id = ?',
      requestId,
      d.id,
    );
    if (!row) throw new NovaError('not_found', 'boot request not found');
    return requestView(row);
  }

  async attempt(accountId: string, deviceId: string, attemptId: string): Promise<BootAttemptView> {
    const d = await this.#devices.device(accountId, deviceId);
    return attemptView(this.#attemptRow(d.id, attemptId));
  }

  // ---- profiles --------------------------------------------------------------------------------

  async createProfile(
    accountId: string,
    deviceId: string,
    input: CreateBootProfileInput,
  ): Promise<BootProfileView> {
    const d = await this.#activeDevice(accountId, deviceId);
    this.#nameFree(d.id, input.name, null);
    await this.#checkEntry(accountId, d.id, input.entryId, 'optional');
    const id = uuidv7();
    const now = this.#iso();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO boot_profile (id, account_id, device_id, name, entry_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        accountId,
        d.id,
        input.name,
        input.entryId,
        now,
        now,
      );
    });
    const view = profileView(this.#profileRow(d.id, id));
    await this.#changed(accountId, d.id, { kind: 'profile', id, status: 'created' }, 'user');
    await this.#auditAppend(accountId, 'device.boot.profile.create', d.id, {
      profileId: id,
      before: null,
      after: { name: view.name, entryId: view.entryId },
    });
    return view;
  }

  async updateProfile(
    accountId: string,
    deviceId: string,
    profileId: string,
    input: UpdateBootProfileInput,
  ): Promise<BootProfileView> {
    const d = await this.#activeDevice(accountId, deviceId);
    const row = this.#profileRow(d.id, profileId);
    if (input.name !== undefined) this.#nameFree(d.id, input.name, row.id);
    if (input.entryId !== undefined && input.entryId !== row.entry_id)
      await this.#checkEntry(accountId, d.id, input.entryId, 'optional');
    const name = input.name ?? row.name;
    const entryId = input.entryId ?? row.entry_id;
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE boot_profile SET name = ?, entry_id = ?, updated_at = ? WHERE id = ?',
        name,
        entryId,
        this.#iso(),
        row.id,
      );
    });
    await this.#changed(
      accountId,
      d.id,
      { kind: 'profile', id: row.id, status: 'updated' },
      'user',
    );
    await this.#auditAppend(accountId, 'device.boot.profile.update', d.id, {
      profileId: row.id,
      before: { name: row.name, entryId: row.entry_id },
      after: { name, entryId },
    });
    return profileView(this.#profileRow(d.id, row.id));
  }

  /** Delete a profile; its trials keep their history (the row stays, marked deleted). */
  async deleteProfile(accountId: string, deviceId: string, profileId: string): Promise<void> {
    const d = await this.#devices.device(accountId, deviceId);
    const row = this.#profileRow(d.id, profileId);
    await this.#db.transaction(() => {
      this.#run('UPDATE boot_profile SET deleted_at = ? WHERE id = ?', this.#iso(), row.id);
    });
    await this.#changed(
      accountId,
      d.id,
      { kind: 'profile', id: row.id, status: 'deleted' },
      'user',
    );
    await this.#auditAppend(accountId, 'device.boot.profile.delete', d.id, {
      profileId: row.id,
      before: { name: row.name, entryId: row.entry_id },
      after: null,
    });
  }

  // ---- privileged changes ----------------------------------------------------------------------

  /**
   * Ask to boot a profile's entry once (`try`): an approval card for exactly this change. When it
   * is approved the Hub signs the authorization and sends `boot/set`; the trial is then pending.
   */
  async requestTry(
    accountId: string,
    deviceId: string,
    profileId: string,
    input: { watchdogSeconds?: number | undefined; reboot: boolean },
  ): Promise<BootRequestView> {
    const d = await this.#activeDevice(accountId, deviceId);
    if (!(await this.#settings.allowLowLevel())) throw lowLevelOff();
    const profile = this.#profileRow(d.id, profileId);
    this.#noPendingAttempt(d.id);
    this.#noOpenRequest(d.id);
    const status = await this.#checkEntry(accountId, d.id, profile.entry_id, 'required');
    const watchdogSeconds = input.watchdogSeconds ?? (await this.#settings.watchdogSeconds());
    const body = {
      profileId: profile.id,
      entryId: profile.entry_id,
      watchdogSeconds,
      reboot: input.reboot,
    };
    const before = beforeOf(status);
    const title = status?.entries.find((e) => e.id === profile.entry_id)?.title ?? profile.entry_id;
    const minutes = Math.round(watchdogSeconds / 60);
    return this.#createRequest(accountId, d, {
      kind: 'try',
      profileId: profile.id,
      attemptId: null,
      entryId: profile.entry_id,
      body,
      before,
      action: `${input.reboot ? 'Restart' : 'Next restart'}: boot ${d.name} once into "${title}" (profile ${profile.name}); it returns to its default entry if it is not back within ${minutes} min`,
      preview: {
        device: d.name,
        change: 'boot once',
        profile: profile.name,
        from: before,
        to: { nextBoot: profile.entry_id, title },
        watchdogSeconds,
        reboot: input.reboot,
      },
    });
  }

  /** Ask to make a confirmed trial's entry the default (`commit`), with an approval card. */
  async requestCommit(
    accountId: string,
    deviceId: string,
    attemptId: string,
    opts: { confirmUnverified?: boolean } = {},
  ): Promise<BootRequestView> {
    const d = await this.#activeDevice(accountId, deviceId);
    if (!(await this.#settings.allowLowLevel())) throw lowLevelOff();
    const attempt = this.#attemptRow(d.id, attemptId);
    this.#committable(attempt);
    // The device could not see which entry booted (GRUB): the trial may never have taken, so the
    // owner confirms making it the default anyway.
    const unverified = attempt.verified === 0;
    if (unverified && opts.confirmUnverified !== true)
      throw new NovaError('conflict', 'the device could not verify that this trial booted', {
        details: { reason: 'unverified_trial' },
        action: 'Check the machine booted this entry, then confirm with confirmUnverified',
      });
    this.#noOpenRequest(d.id);
    const status = await this.#checkEntry(accountId, d.id, attempt.entry_id, 'required');
    const before = beforeOf(status);
    const profile = this.#get<ProfileRow>(
      'SELECT * FROM boot_profile WHERE id = ?',
      attempt.profile_id,
    );
    const title = status?.entries.find((e) => e.id === attempt.entry_id)?.title ?? attempt.entry_id;
    return this.#createRequest(accountId, d, {
      kind: 'commit',
      profileId: attempt.profile_id,
      attemptId: attempt.id,
      entryId: attempt.entry_id,
      body: { profileId: attempt.profile_id, entryId: attempt.entry_id },
      before,
      action:
        `Make "${title}" the default boot entry of ${d.name}${profile ? ` (profile ${profile.name})` : ''}` +
        (unverified ? ' (the device could not verify the trial booted)' : ''),
      preview: {
        device: d.name,
        change: 'default entry',
        profile: profile?.name ?? null,
        verified: !unverified,
        from: { default: before.default },
        to: { default: attempt.entry_id, title },
      },
    });
  }

  /**
   * Clear a pending one-shot (`revert`): a safety action, so it works whatever the toggle says and
   * the owner's own request is its approval (recorded as an approved card). Sent at once.
   */
  async revert(accountId: string, deviceId: string): Promise<BootRequestView> {
    const d = await this.#activeDevice(accountId, deviceId);
    const pending = this.#pendingAttempt(d.id);
    const before: BootBefore = {
      booted: null,
      default: null,
      pending: pending ? { profileId: pending.profile_id, entryId: pending.entry_id } : null,
    };
    const view = await this.#createRequest(accountId, d, {
      kind: 'revert',
      profileId: pending?.profile_id ?? null,
      attemptId: pending?.id ?? null,
      entryId: pending?.entry_id ?? null,
      body: {},
      before,
      action: `Clear the pending one-shot boot of ${d.name}; it boots its default entry`,
      preview: { device: d.name, change: 'clear one-shot', from: before, to: { pending: null } },
      approvedByRequest: true,
    });
    return this.#send(accountId, view.id);
  }

  /** An approval card was answered (the policy area's `approval.decided`). */
  async onApprovalDecided(accountId: string, approvalId: string, decision: string): Promise<void> {
    const row = this.#get<RequestRow>(
      `SELECT * FROM boot_request WHERE account_id = ? AND approval_id = ?
         AND status = 'awaiting_approval' AND decided_at IS NULL`,
      accountId,
      approvalId,
    );
    if (!row) return;
    if (decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_always') {
      await this.#send(accountId, row.id);
      return;
    }
    const n = await this.#db.transaction(() =>
      this.#run(
        `UPDATE boot_request SET status = 'denied', decided_at = ?
         WHERE id = ? AND status = 'awaiting_approval' AND decided_at IS NULL`,
        this.#iso(),
        row.id,
      ),
    );
    if (!n) return;
    await this.#changed(
      accountId,
      row.device_id,
      { kind: 'request', id: row.id, request: row.kind, status: 'denied', reason: null },
      'user',
    );
    await this.#auditAppend(
      accountId,
      'device.boot.denied',
      row.device_id,
      { requestId: row.id, kind: row.kind, approvalId, changeId: row.change_id },
      { decision },
    );
  }

  /**
   * The device's heartbeat events (D5): `boot.watchdog.ok` confirms a trial, `.reverted` says the
   * device gave up on it and booted its default. Other events are ignored. A trial the Hub's
   * watchdog already failed is corrected by a later report.
   */
  async heartbeatEvents(
    accountId: string,
    deviceId: string,
    events: readonly unknown[],
  ): Promise<void> {
    const owned = this.#get<{ id: string; name: string }>(
      'SELECT id, name FROM device WHERE id = ? AND account_id = ?',
      deviceId,
      accountId,
    );
    if (!owned) return;
    for (const raw of events) {
      const parsed = bootWatchdogEventSchema.safeParse(raw);
      if (!parsed.success) continue;
      const e = parsed.data;
      // Matched by the authorization's change id: exactly the trial that `set` started. Only an
      // event without one (an older novad) falls back to the profile, then the entry.
      const candidates = this.#all<AttemptRow & { set_change_id: string | null }>(
        `SELECT a.*, r.change_id AS set_change_id FROM boot_attempt a
           LEFT JOIN boot_request r ON r.id = a.request_id
         WHERE a.device_id = ?
           AND (a.status = 'pending' OR (a.status = 'failed' AND a.reason IN (?, ?)))
         ORDER BY a.created_at DESC, a.id DESC`,
        deviceId,
        HUB_FAILURES[0]!,
        HUB_FAILURES[1]!,
      );
      const attempt = candidates.find((a) =>
        e.changeId
          ? a.set_change_id === e.changeId
          : e.profileId
            ? a.profile_id === e.profileId
            : e.entryId
              ? a.entry_id === e.entryId
              : false,
      );
      if (!attempt) {
        this.#log.info('a boot watchdog report matched no open trial', { deviceId, kind: e.kind });
        continue;
      }
      await this.#closeAttempt(accountId, owned.name, attempt, {
        status: e.kind === 'boot.watchdog.ok' ? 'ok' : 'reverted',
        reason: e.kind === 'boot.watchdog.ok' ? null : 'reverted_by_device',
        detail: detailText(e.detail),
        source: 'device',
        // An ok without `verified` (an older novad) is taken as seen: it compared the entry.
        ...(e.kind === 'boot.watchdog.ok' ? { verified: verifiedOf(e) } : {}),
      });
    }
  }

  /** The device was revoked: open requests fail, their cards close, pending trials fail. */
  async onDeviceRevoked(accountId: string, deviceId: string): Promise<void> {
    const now = this.#iso();
    const requests = this.#all<RequestRow>(
      "SELECT * FROM boot_request WHERE device_id = ? AND status = 'awaiting_approval'",
      deviceId,
    );
    const attempts = this.#all<AttemptRow>(
      "SELECT * FROM boot_attempt WHERE device_id = ? AND status = 'pending'",
      deviceId,
    );
    await this.#db.transaction(() => {
      for (const r of requests) {
        this.#run(
          `UPDATE boot_request SET status = 'failed', error_code = 'conflict', error_reason = 'revoked',
             error_message = 'the device was revoked', decided_at = COALESCE(decided_at, ?)
           WHERE id = ?`,
          now,
          r.id,
        );
        if (r.approval_id)
          this.#run(
            "UPDATE approval SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
            r.approval_id,
          );
      }
      for (const a of attempts)
        this.#run(
          "UPDATE boot_attempt SET status = 'failed', reason = 'revoked', finished_at = ? WHERE id = ?",
          now,
          a.id,
        );
    });
    for (const r of requests)
      await this.#changed(
        accountId,
        deviceId,
        { kind: 'request', id: r.id, request: r.kind, status: 'failed', reason: 'revoked' },
        'system',
      );
    for (const a of attempts)
      await this.#changed(
        accountId,
        deviceId,
        {
          kind: 'attempt',
          id: a.id,
          profileId: a.profile_id,
          entryId: a.entry_id,
          status: 'failed',
          reason: 'revoked',
        },
        'system',
      );
  }

  // ---- the watchdog ----------------------------------------------------------------------------

  /**
   * Fail trials still pending 120 s after their deadline and tell the owner; expire requests whose
   * approval never came. Returns the attempts it failed.
   */
  async sweep(): Promise<string[]> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - BOOT_WATCHDOG_GRACE_SECONDS * 1000).toISOString();
    const overdue = this.#all<AttemptRow & { device_name: string; last_seen_at: string | null }>(
      `SELECT a.*, d.name AS device_name, d.last_seen_at AS last_seen_at
       FROM boot_attempt a JOIN device d ON d.id = a.device_id
       WHERE a.status = 'pending' AND a.deadline < ?`,
      cutoff,
    );
    const failed: string[] = [];
    for (const a of overdue) {
      // Heard from after the deadline: it is up but never confirmed the entry.
      const up = a.last_seen_at !== null && a.last_seen_at > a.deadline;
      const done = await this.#closeAttempt(a.account_id, a.device_name, a, {
        status: 'failed',
        reason: up ? 'no_watchdog_report' : 'no_heartbeat',
        detail: null,
        source: 'hub',
      });
      if (done) failed.push(a.id);
    }
    const expired = this.#all<RequestRow>(
      `SELECT * FROM boot_request WHERE status = 'awaiting_approval' AND decided_at IS NULL
         AND expires_at < ?`,
      now.toISOString(),
    );
    for (const r of expired) await this.#expire(r);
    await this.#resendHeld(now);
    return failed;
  }

  /**
   * After a restart: a request caught between its approval and the device's answer is failed
   * (`interrupted`), since nobody knows whether the device took it; its status tells the owner.
   */
  async recover(): Promise<number> {
    const rows = this.#all<RequestRow>(
      "SELECT * FROM boot_request WHERE status = 'awaiting_approval' AND decided_at IS NOT NULL",
    );
    if (!rows.length) return 0;
    await this.#db.transaction(() => {
      for (const r of rows)
        this.#run(
          `UPDATE boot_request SET status = 'failed', error_code = 'server_error',
             error_reason = 'interrupted',
             error_message = 'the Hub restarted while sending this; check the device''s boot status'
           WHERE id = ?`,
          r.id,
        );
    });
    return rows.length;
  }

  start(): void {
    if (this.#timer) return;
    void this.recover().catch((err: unknown) => this.#log.warn('boot recovery failed', { err }));
    this.#timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.#log.warn('boot watchdog sweep failed', { err }));
    }, this.#sweepIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- internals -------------------------------------------------------------------------------

  async #activeDevice(accountId: string, deviceId: string): Promise<BootDevice> {
    const d = await this.#devices.device(accountId, deviceId);
    if (d.status === 'revoked')
      throw new NovaError('conflict', 'the device is revoked', { details: { reason: 'revoked' } });
    return d;
  }

  #profileRow(deviceId: string, profileId: string): ProfileRow {
    const row = this.#get<ProfileRow>(
      'SELECT * FROM boot_profile WHERE id = ? AND device_id = ? AND deleted_at IS NULL',
      profileId,
      deviceId,
    );
    if (!row) throw new NovaError('not_found', 'boot profile not found');
    return row;
  }

  #attemptRow(deviceId: string, attemptId: string): AttemptRow {
    const row = this.#get<AttemptRow>(
      'SELECT * FROM boot_attempt WHERE id = ? AND device_id = ?',
      attemptId,
      deviceId,
    );
    if (!row) throw new NovaError('not_found', 'boot attempt not found');
    return row;
  }

  #pendingAttempt(deviceId: string): AttemptRow | undefined {
    return this.#get<AttemptRow>(
      "SELECT * FROM boot_attempt WHERE device_id = ? AND status = 'pending'",
      deviceId,
    );
  }

  #nameFree(deviceId: string, name: string, except: string | null): void {
    const taken = this.#get<{ id: string }>(
      'SELECT id FROM boot_profile WHERE device_id = ? AND name = ? AND deleted_at IS NULL',
      deviceId,
      name,
    );
    if (taken && taken.id !== except)
      throw new NovaError('conflict', 'a boot profile of this device already has that name', {
        details: { reason: 'name_taken' },
      });
  }

  #noPendingAttempt(deviceId: string): void {
    const pending = this.#pendingAttempt(deviceId);
    if (pending)
      throw new NovaError('conflict', 'a boot trial is already pending on this device', {
        details: { reason: 'attempt_pending', attemptId: pending.id },
      });
  }

  #noOpenRequest(deviceId: string): void {
    const open = this.#get<{ id: string }>(
      "SELECT id FROM boot_request WHERE device_id = ? AND status = 'awaiting_approval'",
      deviceId,
    );
    if (open)
      throw new NovaError('conflict', 'a boot change for this device is waiting for approval', {
        details: { reason: 'request_pending', requestId: open.id },
      });
  }

  /**
   * D2 (c): the approval record of exactly this change exists, is the account's and was approved.
   * Checked against the table itself, never only the event that announced it.
   */
  #approved(row: RequestRow, body: Record<string, unknown>): void {
    const a = row.approval_id
      ? this.#get<{
          status: string;
          decision: string | null;
          decided_by: string | null;
          args_hash: string | null;
        }>(
          'SELECT status, decision, decided_by, args_hash FROM approval WHERE id = ? AND account_id = ?',
          row.approval_id,
          row.account_id,
        )
      : undefined;
    // Only the signed-in user's answer in a Nova client counts (a Hub-only card, docs/23 §6.3).
    const allowed =
      a?.status === 'decided' &&
      a.decided_by === 'user' &&
      (a.decision === 'allow_once' ||
        a.decision === 'allow_session' ||
        a.decision === 'allow_always') &&
      a.args_hash === bootBodySha256(body);
    if (!allowed)
      throw new NovaError('policy_denied', 'this boot change has no approval', {
        details: { reason: 'approval_missing' },
      });
  }

  #committable(attempt: AttemptRow): void {
    if (attempt.status !== 'ok')
      throw new NovaError('conflict', 'only a trial the device confirmed can become the default', {
        details: { reason: 'not_confirmed', status: attempt.status },
      });
    if (attempt.committed_at)
      throw new NovaError('conflict', 'this trial is already the default', {
        details: { reason: 'already_default' },
      });
  }

  /**
   * The entry must be one the device lists, on a bootloader it supports (never a guess). With
   * `optional`, an unreachable device skips the check (it checks again when asked to boot).
   */
  async #checkEntry(
    accountId: string,
    deviceId: string,
    entryId: string,
    mode: 'optional' | 'required',
  ): Promise<DeviceBootStatusView | null> {
    let status: DeviceBootStatusView;
    try {
      status = bootStatusView(await this.#devices.call(accountId, deviceId, BOOT_STATUS_PATH, {}));
    } catch (err) {
      if (mode === 'optional' && err instanceof NovaError && err.code === 'node_unavailable')
        return null;
      if (err instanceof z.ZodError)
        throw new NovaError('server_error', 'the device sent a boot status the Hub cannot read', {
          details: { reason: 'bad_answer' },
        });
      throw err;
    }
    if (!status.supported)
      throw new NovaError(
        'conflict',
        `this device's boot cannot be managed: ${status.reason ?? 'unsupported bootloader'}`,
        { details: { reason: 'unsupported_hardware', detail: status.reason } },
      );
    if (!status.entries.some((e) => e.id === entryId))
      throw new NovaError('validation', 'the device has no boot entry with that id', {
        details: { reason: 'unknown_entry', entries: status.entries.map((e) => e.id) },
      });
    return status;
  }

  async #createRequest(
    accountId: string,
    d: BootDevice,
    r: {
      kind: BootRequestKind;
      profileId: string | null;
      attemptId: string | null;
      entryId: string | null;
      body: Record<string, unknown>;
      before: BootBefore;
      action: string;
      preview: Record<string, unknown>;
      approvedByRequest?: boolean;
    },
  ): Promise<BootRequestView> {
    const id = uuidv7();
    const approvalId = uuidv7();
    const changeId = uuidv7();
    const now = this.#now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#requestTtlMs).toISOString();
    const argsHash = bootBodySha256(r.body);
    const auto = r.approvedByRequest === true;
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(schema.approval).values({
        id: approvalId,
        accountId,
        toolCallId: null,
        threadId: null,
        turnId: null,
        runId: null,
        agentId: null,
        toolName: `device.boot.${r.kind}`,
        requestedAction: r.action.slice(0, 500),
        argsPreview: JSON.stringify(r.preview).slice(0, 4000),
        argsHash,
        reason: auto
          ? 'Asked by the owner (a revert is approved by the request)'
          : 'Asked by the owner',
        scope: `device:${d.id}`,
        risk: 'high',
        tier: 'confirm_at_action',
        userAsked: true,
        optionsJson: JSON.stringify(['allow_once', 'deny_continue']),
        alwaysScopesJson: '[]',
        // Answered on the Hub only (docs/23 §6.3, M7.5): never from a channel.
        answerIn: 'hub',
        status: auto ? 'decided' : 'pending',
        ...(auto ? { decision: 'allow_once' as const, decidedBy: 'user', decidedAt: nowIso } : {}),
        createdAt: nowIso,
        expiresAt,
      });
      this.#run(
        `INSERT INTO boot_request (id, account_id, device_id, kind, profile_id, attempt_id, entry_id,
           body_json, before_json, approval_id, change_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
        id,
        accountId,
        d.id,
        r.kind,
        r.profileId,
        r.attemptId,
        r.entryId,
        canonicalJson(r.body),
        JSON.stringify(r.before),
        approvalId,
        changeId,
        nowIso,
        expiresAt,
      );
    });
    if (!auto) {
      await this.#events.emit({
        name: 'approval.requested',
        accountId,
        actor: 'user',
        payload: {
          approvalId,
          callId: null,
          action: r.action.slice(0, 500),
          reason: 'Asked by the owner',
          scope: `device:${d.id}`,
          risk: 'high',
          tier: 'confirm_at_action',
        },
      });
    }
    await this.#changed(
      accountId,
      d.id,
      { kind: 'request', id, request: r.kind, status: 'awaiting_approval', reason: null },
      'user',
    );
    await this.#auditAppend(
      accountId,
      'device.boot.request',
      d.id,
      {
        requestId: id,
        kind: r.kind,
        approvalId,
        changeId,
        profileId: r.profileId,
        attemptId: r.attemptId,
        before: r.before,
        after: r.body,
      },
      { inputHash: argsHash },
    );
    if (!auto && this.#notifier) {
      await this.#notifier
        .notify({
          accountId,
          kind: 'approval',
          title: 'Boot change needs your approval',
          body: r.action.slice(0, 200),
          href: `/approvals/${approvalId}`,
          dedupeKey: `approval:${approvalId}`,
        })
        .catch((err: unknown) => this.#log.warn('boot approval notification failed', { err }));
    }
    return requestView(this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', id)!);
  }

  /** Send an approved request to the device, once. */
  async #send(accountId: string, requestId: string): Promise<BootRequestView> {
    const claimed = await this.#db.transaction(() =>
      this.#run(
        `UPDATE boot_request SET decided_at = ?, error_code = NULL, error_reason = NULL,
           error_message = NULL
         WHERE id = ? AND account_id = ? AND status = 'awaiting_approval' AND decided_at IS NULL`,
        this.#iso(),
        requestId,
        accountId,
      ),
    );
    let row = this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', requestId)!;
    if (!claimed) return requestView(row);
    if (this.#now().toISOString() > row.expires_at) {
      await this.#expire(row);
      return requestView(this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', row.id)!);
    }
    const body = parseJson<Record<string, unknown>>(row.body_json, {});
    const before = parseJson<BootBefore>(row.before_json, {
      booted: null,
      default: null,
      pending: null,
    });
    let device: BootDevice | null = null;
    try {
      device = await this.#activeDevice(accountId, row.device_id);
      if (row.kind !== 'revert' && !(await this.#settings.allowLowLevel())) throw lowLevelOff();
      if (row.kind === 'try') this.#noPendingAttempt(row.device_id);
      if (row.kind === 'commit')
        this.#committable(this.#attemptRow(row.device_id, row.attempt_id!));
      this.#approved(row, body);
      const authorize = this.#authorize;
      if (!authorize)
        throw new NovaError('conflict', 'the Hub identity is not loaded: it cannot sign this', {
          details: { reason: 'identity_missing' },
        });
      const privileged = row.kind !== 'revert';
      // The device must hold the current toggle before the send (D3): pushed now when what it
      // last confirmed differs. Best effort: the send itself says when the device is away.
      if (privileged)
        await this.#devices.syncPolicy?.(accountId, row.device_id).catch((err: unknown) => {
          this.#log.info('syncing the device policy before a boot send failed', { err });
        });
      const sendOnce = async (): Promise<unknown> => {
        const authorization = await authorize({
          kind: AUTHZ_KIND[row.kind],
          deviceId: row.device_id,
          changeId: row.change_id,
          approvalId: row.approval_id!,
          body,
        });
        return this.#devices.call(accountId, row.device_id, PATH[row.kind], {
          ...body,
          authorization,
        });
      };
      let answer: unknown;
      try {
        answer = await sendOnce();
      } catch (err) {
        // The device still had low-level boot off while the Hub's switch is on: push the policy
        // and retry once with a new change id (one is never used twice, D2).
        if (!privileged || !deviceLowLevelOff(err) || !this.#devices.syncPolicy) throw err;
        await this.#devices.syncPolicy(accountId, row.device_id, { force: true });
        const fresh = uuidv7();
        await this.#db.transaction(() => {
          this.#run('UPDATE boot_request SET change_id = ? WHERE id = ?', fresh, row.id);
        });
        row = { ...row, change_id: fresh };
        try {
          answer = await sendOnce();
        } catch (err2) {
          if (deviceLowLevelOff(err2))
            throw new NovaError(
              'conflict',
              'the device has not taken the "Allow low-level boot changes" switch yet',
              { details: { reason: POLICY_STALE }, retryable: true },
            );
          throw err2;
        }
      }
      await this.#applySent(row, body, answer);
    } catch (err) {
      const e = errorOf(err);
      if (e.reason === POLICY_STALE) return this.#keepWaiting(accountId, row, e);
      await this.#db.transaction(() => {
        this.#run(
          `UPDATE boot_request SET status = 'failed', error_code = ?, error_reason = ?,
             error_message = ? WHERE id = ?`,
          e.code,
          e.reason,
          e.message,
          row.id,
        );
      });
      row = this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', row.id)!;
      await this.#changed(
        accountId,
        row.device_id,
        { kind: 'request', id: row.id, request: row.kind, status: 'failed', reason: e.reason },
        'system',
      );
      await this.#auditAppend(
        accountId,
        `device.boot.${row.kind === 'try' ? 'set' : row.kind}`,
        row.device_id,
        {
          requestId: row.id,
          approvalId: row.approval_id,
          changeId: row.change_id,
          before,
          after: before,
          error: e,
        },
        { result: 'failed', inputHash: bootBodySha256(body) },
      );
      if (this.#notifier && row.kind !== 'revert') {
        await this.#notifier
          .notify({
            accountId,
            kind: 'error',
            title: `The boot change for ${device?.name ?? 'a device'} was not made`,
            body: e.message.slice(0, 200),
            href: `/devices/${row.device_id}/boot`,
            dedupeKey: `boot-request:${row.id}`,
          })
          .catch((err2: unknown) => this.#log.warn('boot failure notification failed', { err2 }));
      }
      return requestView(row);
    }
    row = this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', row.id)!;
    await this.#changed(
      accountId,
      row.device_id,
      { kind: 'request', id: row.id, request: row.kind, status: 'sent', reason: null },
      row.kind === 'revert' ? 'user' : 'system',
    );
    const after: Record<string, unknown> =
      row.kind === 'try'
        ? { ...before, pending: { profileId: body.profileId, entryId: body.entryId } }
        : row.kind === 'commit'
          ? { ...before, default: body.entryId }
          : { ...before, pending: null };
    await this.#auditAppend(
      accountId,
      `device.boot.${row.kind === 'try' ? 'set' : row.kind}`,
      row.device_id,
      {
        requestId: row.id,
        approvalId: row.approval_id,
        changeId: row.change_id,
        attemptId: row.attempt_id,
        before,
        after,
      },
      { result: 'ok', inputHash: bootBodySha256(body) },
    );
    return requestView(row);
  }

  /**
   * A send the device refused only because it still had the old toggle: the request waits again
   * with its approval unspent (`decided_at` cleared, the reason kept for the owner) and the sweep
   * sends it again until it expires. Audited as an error, not a failure.
   */
  async #keepWaiting(
    accountId: string,
    row: RequestRow,
    e: { code: string; reason: string | null; message: string },
  ): Promise<BootRequestView> {
    await this.#db.transaction(() => {
      this.#run(
        `UPDATE boot_request SET decided_at = NULL, error_code = ?, error_reason = ?,
           error_message = ? WHERE id = ? AND status = 'awaiting_approval'`,
        e.code,
        e.reason,
        e.message,
        row.id,
      );
    });
    const kept = this.#get<RequestRow>('SELECT * FROM boot_request WHERE id = ?', row.id)!;
    await this.#changed(
      accountId,
      row.device_id,
      {
        kind: 'request',
        id: row.id,
        request: row.kind,
        status: 'awaiting_approval',
        reason: e.reason,
      },
      'system',
    );
    await this.#auditAppend(
      accountId,
      `device.boot.${row.kind === 'try' ? 'set' : row.kind}`,
      row.device_id,
      { requestId: row.id, approvalId: row.approval_id, changeId: row.change_id, error: e },
      { result: 'error' },
    );
    return requestView(kept);
  }

  /** Requests a stale device policy held back, sent again (their approval is still good). */
  async #resendHeld(now: Date): Promise<void> {
    const held = this.#all<RequestRow>(
      `SELECT * FROM boot_request WHERE status = 'awaiting_approval' AND decided_at IS NULL
         AND error_reason = ? AND expires_at >= ?`,
      POLICY_STALE,
      now.toISOString(),
    );
    for (const r of held) {
      try {
        await this.#send(r.account_id, r.id);
      } catch (err) {
        this.#log.warn('sending a held boot request again failed', { err, requestId: r.id });
      }
    }
  }

  /** What a request the device accepted changes on the Hub. */
  async #applySent(row: RequestRow, body: Record<string, unknown>, answer: unknown): Promise<void> {
    const now = this.#now();
    const nowIso = now.toISOString();
    let attempt: AttemptRow | undefined;
    if (row.kind === 'try') {
      const watchdogSeconds = Number(body.watchdogSeconds);
      const deadline = new Date(now.getTime() + watchdogSeconds * 1000).toISOString();
      const pending = bootSetAnswerSchema.safeParse(answer);
      const attemptId = uuidv7();
      await this.#db.transaction(() => {
        this.#run(
          `INSERT INTO boot_attempt (id, account_id, device_id, profile_id, request_id, entry_id,
             status, reboot, watchdog_seconds, deadline, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          attemptId,
          row.account_id,
          row.device_id,
          row.profile_id,
          row.id,
          row.entry_id,
          body.reboot === true ? 1 : 0,
          watchdogSeconds,
          deadline,
          pending.success ? `device deadline ${pending.data.pending.deadline}` : null,
          nowIso,
        );
        this.#run(
          "UPDATE boot_request SET status = 'sent', sent_at = ?, attempt_id = ? WHERE id = ?",
          nowIso,
          attemptId,
          row.id,
        );
      });
      attempt = this.#get<AttemptRow>('SELECT * FROM boot_attempt WHERE id = ?', attemptId);
    } else if (row.kind === 'commit') {
      await this.#db.transaction(() => {
        this.#run('UPDATE boot_attempt SET committed_at = ? WHERE id = ?', nowIso, row.attempt_id);
        this.#run(
          "UPDATE boot_request SET status = 'sent', sent_at = ? WHERE id = ?",
          nowIso,
          row.id,
        );
      });
    } else {
      // The one-shot is cleared: the pending trial ends, back on the default entry.
      attempt = this.#pendingAttempt(row.device_id);
      await this.#db.transaction(() => {
        if (attempt)
          this.#run(
            `UPDATE boot_attempt SET status = 'reverted', reason = 'revert', finished_at = ?
             WHERE id = ? AND status = 'pending'`,
            nowIso,
            attempt.id,
          );
        this.#run(
          `UPDATE boot_request SET status = 'sent', sent_at = ?, attempt_id = COALESCE(attempt_id, ?)
           WHERE id = ?`,
          nowIso,
          attempt?.id ?? null,
          row.id,
        );
      });
      if (attempt)
        attempt = this.#get<AttemptRow>('SELECT * FROM boot_attempt WHERE id = ?', attempt.id);
    }
    if (attempt)
      await this.#changed(
        row.account_id,
        row.device_id,
        {
          kind: 'attempt',
          id: attempt.id,
          profileId: attempt.profile_id,
          entryId: attempt.entry_id,
          status: attempt.status,
          reason: attempt.reason,
        },
        row.kind === 'revert' ? 'user' : 'system',
      );
  }

  async #expire(r: RequestRow): Promise<void> {
    const n = await this.#db.transaction(() => {
      const changed = this.#run(
        `UPDATE boot_request SET status = 'expired', decided_at = COALESCE(decided_at, ?)
         WHERE id = ? AND status = 'awaiting_approval'`,
        this.#iso(),
        r.id,
      );
      if (changed && r.approval_id)
        this.#run(
          "UPDATE approval SET status = 'expired' WHERE id = ? AND status = 'pending'",
          r.approval_id,
        );
      return changed;
    });
    if (!n) return;
    await this.#changed(
      r.account_id,
      r.device_id,
      { kind: 'request', id: r.id, request: r.kind, status: 'expired', reason: null },
      'system',
    );
    await this.#auditAppend(
      r.account_id,
      'device.boot.expired',
      r.device_id,
      { requestId: r.id, kind: r.kind, approvalId: r.approval_id, changeId: r.change_id },
      { actor: 'system' },
    );
  }

  /**
   * Bring an open trial up to date with the device's `last` result, for a report the Hub missed.
   * Only a result at or after the trial started (with D2's 120 s of clock skew) counts, and never
   * while the device still holds the trial as pending.
   */
  async #reconcile(accountId: string, d: BootDevice, status: DeviceBootStatusView): Promise<void> {
    const last = status.last;
    if (!last || last.result === 'failed') return;
    if (status.pending?.profileId === last.profileId) return;
    const at = Date.parse(last.at);
    if (!Number.isFinite(at)) return;
    const open = this.#all<AttemptRow>(
      `SELECT * FROM boot_attempt WHERE device_id = ? AND profile_id = ?
         AND (status = 'pending' OR (status = 'failed' AND reason IN (?, ?)))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      d.id,
      last.profileId,
      HUB_FAILURES[0]!,
      HUB_FAILURES[1]!,
    )[0];
    if (!open || at < Date.parse(open.created_at) - CLOCK_SKEW_MS) return;
    await this.#closeAttempt(accountId, d.name, open, {
      status: last.result,
      reason: last.result === 'ok' ? null : 'reverted_by_device',
      detail: null,
      source: 'device',
    });
  }

  /** Move a trial to its result once; announce, audit and tell the owner. */
  async #closeAttempt(
    accountId: string,
    deviceName: string,
    a: AttemptRow,
    to: {
      status: Exclude<BootAttemptStatus, 'pending'>;
      reason: string | null;
      detail: string | null;
      source: 'device' | 'hub';
      /** A device's ok: whether it saw the entry booted. */
      verified?: boolean | null;
    },
  ): Promise<boolean> {
    const nowIso = this.#iso();
    const verified = to.verified === undefined || to.verified === null ? null : to.verified ? 1 : 0;
    const n = await this.#db.transaction(() =>
      this.#run(
        `UPDATE boot_attempt SET status = ?, reason = ?, detail = COALESCE(?, detail),
           verified = COALESCE(?, verified), finished_at = ? WHERE id = ? AND status = ?`,
        to.status,
        to.reason,
        to.detail,
        verified,
        nowIso,
        a.id,
        a.status,
      ),
    );
    if (!n) return false;
    await this.#changed(
      accountId,
      a.device_id,
      {
        kind: 'attempt',
        id: a.id,
        profileId: a.profile_id,
        entryId: a.entry_id,
        status: to.status,
        reason: to.reason,
      },
      'system',
    );
    await this.#auditAppend(
      accountId,
      'device.boot.watchdog',
      a.device_id,
      {
        attemptId: a.id,
        profileId: a.profile_id,
        entryId: a.entry_id,
        source: to.source,
        before: { status: a.status, reason: a.reason },
        after: { status: to.status, reason: to.reason },
        detail: to.detail,
      },
      { actor: 'system', result: to.status },
    );
    await this.#notifyResult(accountId, deviceName, a, to.status, to.reason, to.detail);
    return true;
  }

  async #notifyResult(
    accountId: string,
    deviceName: string,
    a: AttemptRow,
    status: Exclude<BootAttemptStatus, 'pending'>,
    reason: string | null,
    detail: string | null = null,
  ): Promise<void> {
    if (!this.#notifier) return;
    const profile =
      this.#get<{ name: string }>('SELECT name FROM boot_profile WHERE id = ?', a.profile_id)
        ?.name ?? a.entry_id;
    const page = `/devices/${a.device_id}/boot`;
    let note: NotificationInput;
    if (status === 'ok') {
      note = {
        accountId,
        kind: 'completion',
        title: `${deviceName} came back on ${profile}`,
        body: 'Make it the default entry from the device page; until then it boots its default at the next restart.',
        href: page,
      };
    } else if (status === 'reverted') {
      note = {
        accountId,
        kind: 'attention',
        title: `${deviceName} is back on its default boot entry`,
        body:
          reason === 'revert'
            ? `The one-shot boot of ${profile} was cleared.`
            : bootRevertText(profile, detail),
        href: page,
      };
    } else {
      let cycle: BootPowerCycleLink | null = null;
      if (this.#powerCycle) {
        cycle = await this.#powerCycle(accountId, a.device_id).catch((err: unknown) => {
          this.#log.warn('out-of-band lookup failed', { err });
          return null;
        });
      }
      const why =
        reason === 'no_watchdog_report'
          ? `It is online but never confirmed ${profile}.`
          : `It has not been heard from since the trial of ${profile}.`;
      note = {
        accountId,
        kind: 'error',
        os: true,
        title: `${deviceName} did not come back from a boot trial`,
        body: cycle
          ? `${why} It returns to its default entry on its next power cycle; you can power-cycle it through ${cycle.endpointName}.`
          : `${why} It returns to its default entry on its next power cycle.`,
        href: cycle
          ? `/devices/${a.device_id}/oob/${encodeURIComponent(cycle.endpointId)}?action=power.cycle`
          : page,
      };
    }
    await this.#notifier
      .notify({ ...note, dedupeKey: `boot-attempt:${a.id}:${status}` })
      .catch((err: unknown) => this.#log.warn('boot notification failed', { err }));
  }

  async #changed(
    accountId: string,
    deviceId: string,
    payload: Record<string, unknown>,
    actor: 'user' | 'system',
  ): Promise<void> {
    await this.#events.emit({
      name: 'device.boot.changed',
      accountId,
      actor,
      payload: { deviceId, ...payload },
    });
  }

  async #auditAppend(
    accountId: string,
    action: string,
    deviceId: string,
    detail: Record<string, unknown>,
    extra: { actor?: string; decision?: string; result?: string; inputHash?: string } = {},
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor: extra.actor ?? 'user',
        kind: 'device',
        action,
        resource: deviceId,
        detail,
        ...(extra.decision ? { decision: extra.decision } : {}),
        ...(extra.result ? { result: extra.result } : {}),
        ...(extra.inputHash ? { inputHash: extra.inputHash } : {}),
      });
    } catch (err) {
      this.#log.warn('boot audit failed', { err, action });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.raw.prepare(sql).all(...params) as unknown as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.raw.prepare(sql).get(...params) as unknown as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): number {
    return Number(this.#db.raw.prepare(sql).run(...params).changes);
  }
}

function beforeOf(status: DeviceBootStatusView | null): BootBefore {
  return {
    booted: status?.booted ?? null,
    default: status?.entries.find((e) => e.isDefault)?.id ?? null,
    pending: status?.pending
      ? { profileId: status.pending.profileId, entryId: status.pending.entryId }
      : null,
  };
}

function profileView(r: ProfileRow): BootProfileView {
  return {
    id: r.id,
    deviceId: r.device_id,
    name: r.name,
    entryId: r.entry_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function attemptView(r: AttemptRow): BootAttemptView {
  return {
    id: r.id,
    deviceId: r.device_id,
    profileId: r.profile_id,
    requestId: r.request_id,
    entryId: r.entry_id,
    status: r.status,
    reboot: r.reboot === 1,
    watchdogSeconds: r.watchdog_seconds,
    deadline: r.deadline,
    reason: r.reason,
    detail: r.detail,
    verified: r.verified === null ? null : r.verified === 1,
    committedAt: r.committed_at,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

function requestView(r: RequestRow): BootRequestView {
  return {
    id: r.id,
    deviceId: r.device_id,
    kind: r.kind,
    status: r.status,
    profileId: r.profile_id,
    attemptId: r.attempt_id,
    entryId: r.entry_id,
    approvalId: r.approval_id,
    changeId: r.change_id,
    error: r.error_code
      ? { code: r.error_code, reason: r.error_reason, message: r.error_message ?? '' }
      : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    sentAt: r.sent_at,
  };
}
