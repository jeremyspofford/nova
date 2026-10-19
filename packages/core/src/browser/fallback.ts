// The local browser fallback (FR-209, docs/11 §4.6; ADR-096 D7). When a site refuses an agent's
// own browser (a block page, or a bot challenge that repeats), and the agent has a connected
// computer (FR-081) whose novad offers the `browser` module, the user may let the agent continue
// that site on the computer's browser:
//   - "Continue on <device> (clean profile)": Chromium on the device with a fresh temporary
//     profile, its traffic through novad's per-session egress filter for the site only;
//   - "Continue in my own browser on <device> (extension)": a tab of the user's own browser through
//     the extension bridge (FR-096), only when the bridge is connected there and the site has an
//     owner-confirmed host grant.
// The offer is a question to the user (a server request with choices, FR-188), never something a
// model answers. Accepting records a consent per agent (or thread), device and site: a later block
// on the same site continues without asking until the consent is revoked (Settings, or
// `DELETE /browser/fallback/consents/:id`), which also stops a running fallback session. Every
// decision is audited; the session and each of its trace rows are marked (0043). The browser tools
// act through the same controller, so the site lists, levels, classifier and gate apply as ever.
import {
  NovaError,
  uuidv7,
  type BrowserFallbackConsentView,
  type BrowserFallbackEndReason,
  type BrowserFallbackOfferContext,
  type BrowserFallbackProfile,
  type BrowserFallbackScopeKind,
  type BrowserFallbackSessionView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { SettingReader } from '../approvals/gate.ts';
import type { EventSink } from '../events.ts';
import type { RequestBroker } from '../runtime/types.ts';
import type { AuditSink } from '../tools/types.ts';
import type {
  BrowserDriver,
  FallbackBeginInput,
  FallbackPlan,
  FallbackRefusal,
  LocalBrowserFallback,
} from './types.ts';

/** How long the offer waits for the user. */
export const FALLBACK_OFFER_TIMEOUT_MS = 10 * 60_000;
const NOT_NOW = 'Not now';

/** The computer a fallback continues on, for one call. */
export interface FallbackTarget {
  ok: true;
  scope: { kind: BrowserFallbackScopeKind; ref: string };
  deviceId: string;
  deviceName: string;
}

/** Which connected computer serves a computer's browser fallback (the devices area's view). */
export interface FallbackTargetResolver {
  target(input: {
    accountId: string;
    computerId: string;
    threadId: string | null;
  }): Promise<FallbackTarget | FallbackRefusal>;
}

/** What the fallback needs from the extension bridge (bridge.ts). */
export interface FallbackBridge {
  /** The bridge can serve `site` on the device now (enabled, connected, an active grant). */
  usable(accountId: string, deviceId: string, site: string): Promise<boolean>;
  tabDriver(input: {
    accountId: string;
    deviceId: string;
    deviceName: string;
    site: string;
  }): BrowserDriver;
  /** The OS user whose browser the bridge serves now (recorded on the session). */
  user(accountId: string, deviceId: string): string | null;
}

/** Makes the clean-profile driver for a device (device-launcher.ts over the devices area). */
export type DeviceDriverFactory = (input: {
  accountId: string;
  deviceId: string;
  deviceName: string;
  agentId: string | null;
  threadId: string | null;
  allowHosts: string[];
  onClosed: (egress: { allowed: number; refused: number } | null) => void;
}) => BrowserDriver;

export interface LocalFallbackServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  setting: SettingReader;
  audit?: AuditSink | null;
  requests?: RequestBroker | null;
  resolver?: FallbackTargetResolver | null;
  deviceDriver?: DeviceDriverFactory | null;
  bridge?: FallbackBridge | null;
  log?: Logger;
  now?: () => Date;
}

interface ConsentRow {
  id: string;
  account_id: string;
  scope_kind: BrowserFallbackScopeKind;
  scope_ref: string;
  device_id: string;
  site: string;
  profile: BrowserFallbackProfile;
  granted_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

interface SessionRow {
  id: string;
  account_id: string;
  computer_id: string;
  thread_id: string | null;
  device_id: string;
  site: string;
  profile: BrowserFallbackProfile;
  cause: BrowserFallbackSessionView['cause'];
  consent_id: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: BrowserFallbackEndReason | null;
  egress_allowed: number | null;
  egress_refused: number | null;
  bridge_user: string | null;
}

function refusal(reason: FallbackRefusal['reason'], message: string): FallbackRefusal {
  return { ok: false, reason, message };
}

function clip(s: string, n: number): string {
  const t = s.replace(/[\p{Cc}]/gu, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export class LocalFallbackService implements LocalBrowserFallback {
  readonly #o: LocalFallbackServiceOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  #requests: RequestBroker | null;
  #resolver: FallbackTargetResolver | null;
  #deviceDriver: DeviceDriverFactory | null;
  #bridge: FallbackBridge | null;
  #audit: AuditSink | null;
  readonly #stops = new Set<(sessionId: string, reason: BrowserFallbackEndReason) => void>();
  /** One offer at a time per computer and site: a second call waits for the same answer. */
  readonly #offers = new Map<string, Promise<FallbackPlan | FallbackRefusal>>();
  /** Egress counts the device reported when a session's browser closed (until `end`). */
  readonly #egress = new Map<string, { allowed: number; refused: number }>();

  constructor(opts: LocalFallbackServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.browser.fallback', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#requests = opts.requests ?? null;
    this.#resolver = opts.resolver ?? null;
    this.#deviceDriver = opts.deviceDriver ?? null;
    this.#bridge = opts.bridge ?? null;
    this.#audit = opts.audit ?? null;
  }

  useRequests(requests: RequestBroker): void {
    this.#requests = requests;
  }
  useResolver(resolver: FallbackTargetResolver): void {
    this.#resolver = resolver;
  }
  useDeviceDriver(factory: DeviceDriverFactory): void {
    this.#deviceDriver = factory;
  }
  useBridge(bridge: FallbackBridge): void {
    this.#bridge = bridge;
  }
  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  onStop(listener: (sessionId: string, reason: BrowserFallbackEndReason) => void): () => void {
    this.#stops.add(listener);
    return () => this.#stops.delete(listener);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  async #auditAppend(
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    extra: {
      actor?: 'user' | 'system';
      decision?: string;
      threadId?: string | null;
      turnId?: string | null;
    } = {},
  ): Promise<void> {
    await this.#audit
      ?.append({
        accountId,
        actor: extra.actor ?? 'system',
        kind: 'browser',
        action,
        resource,
        decision: extra.decision ?? null,
        threadId: extra.threadId ?? null,
        turnId: extra.turnId ?? null,
        detail,
      })
      .catch((err: unknown) => this.#log.warn('fallback audit failed', { err }));
  }

  async #emit(accountId: string, payload: Record<string, unknown>): Promise<void> {
    await this.#o.events
      .emit({ name: 'browser.fallback.changed', accountId, actor: 'system', payload })
      .catch(() => undefined);
  }

  // ---- consents -------------------------------------------------------------------------------

  #consentView(r: ConsentRow): BrowserFallbackConsentView {
    const name = this.#o.db.raw.prepare('SELECT name FROM device WHERE id = ?').get(r.device_id) as
      { name: string | null } | undefined;
    return {
      id: r.id,
      scopeKind: r.scope_kind,
      scopeRef: r.scope_ref,
      deviceId: r.device_id,
      deviceName: name?.name ?? null,
      site: r.site,
      profile: r.profile,
      grantedBy: r.granted_by,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      revokedBy: r.revoked_by,
    };
  }

  /** Consents of the account (live ones unless `all`), newest first. */
  consents(
    accountId: string,
    q: {
      scopeKind?: BrowserFallbackScopeKind;
      scopeRef?: string;
      deviceId?: string;
      all?: boolean;
    } = {},
  ): BrowserFallbackConsentView[] {
    const where = ['account_id = ?'];
    const params: string[] = [accountId];
    if (!q.all) where.push('revoked_at IS NULL');
    for (const [col, v] of [
      ['scope_kind', q.scopeKind],
      ['scope_ref', q.scopeRef],
      ['device_id', q.deviceId],
    ] as const)
      if (v) {
        where.push(`${col} = ?`);
        params.push(v);
      }
    const rows = this.#o.db.raw
      .prepare(
        `SELECT * FROM browser_fallback_consent WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT 500`,
      )
      .all(...params) as unknown as ConsentRow[];
    return rows.map((r) => this.#consentView(r));
  }

  #live(
    accountId: string,
    scope: { kind: BrowserFallbackScopeKind; ref: string },
    deviceId: string,
    site: string,
  ): ConsentRow | null {
    return (
      (this.#o.db.raw
        .prepare(
          `SELECT * FROM browser_fallback_consent WHERE account_id = ? AND scope_kind = ?
           AND scope_ref = ? AND device_id = ? AND site = ? AND revoked_at IS NULL`,
        )
        .get(accountId, scope.kind, scope.ref, deviceId, site) as ConsentRow | undefined) ?? null
    );
  }

  async #grant(input: {
    accountId: string;
    scope: { kind: BrowserFallbackScopeKind; ref: string };
    deviceId: string;
    site: string;
    profile: BrowserFallbackProfile;
    by: string;
    threadId: string | null;
    turnId: string | null;
  }): Promise<ConsentRow> {
    const at = this.#iso();
    const id = uuidv7();
    let before: ConsentRow | null = null;
    await this.#o.db.transaction(() => {
      before = this.#live(input.accountId, input.scope, input.deviceId, input.site);
      if (before)
        this.#o.db.raw
          .prepare('UPDATE browser_fallback_consent SET profile = ?, last_used_at = ? WHERE id = ?')
          .run(input.profile, at, before.id);
      else
        this.#o.db.raw
          .prepare(
            `INSERT INTO browser_fallback_consent (id, account_id, scope_kind, scope_ref, device_id,
               site, profile, granted_by, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.accountId,
            input.scope.kind,
            input.scope.ref,
            input.deviceId,
            input.site,
            input.profile,
            input.by,
            at,
            at,
          );
    });
    const prior = before as ConsentRow | null;
    const row = this.#live(input.accountId, input.scope, input.deviceId, input.site)!;
    await this.#auditAppend(
      input.accountId,
      'browser.fallback.consent.granted',
      input.site,
      {
        consentId: row.id,
        scopeKind: input.scope.kind,
        scopeRef: input.scope.ref,
        deviceId: input.deviceId,
        before: prior ? { profile: prior.profile } : null,
        after: { profile: input.profile },
      },
      { actor: 'user', decision: 'allow', threadId: input.threadId, turnId: input.turnId },
    );
    await this.#emit(input.accountId, {
      consentId: row.id,
      deviceId: input.deviceId,
      site: input.site,
      state: 'consent_granted',
    });
    return row;
  }

  /** Revoke a consent; a fallback session running on it stops. */
  async revokeConsent(accountId: string, consentId: string, by: string): Promise<void> {
    const row = this.#o.db.raw
      .prepare('SELECT * FROM browser_fallback_consent WHERE id = ? AND account_id = ?')
      .get(consentId, accountId) as ConsentRow | undefined;
    if (!row) throw new NovaError('not_found', 'consent not found');
    if (row.revoked_at) return;
    const at = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          'UPDATE browser_fallback_consent SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
        )
        .run(at, by, consentId);
    });
    await this.#auditAppend(
      accountId,
      'browser.fallback.consent.revoked',
      row.site,
      {
        consentId,
        scopeKind: row.scope_kind,
        scopeRef: row.scope_ref,
        deviceId: row.device_id,
        before: { profile: row.profile, revokedAt: null },
        after: { revokedAt: at },
      },
      { actor: by === 'system' ? 'system' : 'user' },
    );
    await this.#emit(accountId, {
      consentId,
      deviceId: row.device_id,
      site: row.site,
      state: 'consent_revoked',
    });
    this.#stopWhere('consent_id = ?', [consentId], 'consent_revoked');
  }

  /**
   * A device left (revoked, decommissioned, disconnected from the agent): its consents are revoked
   * and its fallback sessions stop.
   */
  async forgetDevice(accountId: string, deviceId: string): Promise<void> {
    const ids = this.#o.db.raw
      .prepare(
        'SELECT id FROM browser_fallback_consent WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL',
      )
      .all(accountId, deviceId) as { id: string }[];
    for (const { id } of ids) await this.revokeConsent(accountId, id, 'system');
    this.#stopWhere('account_id = ? AND device_id = ?', [accountId, deviceId], 'device_gone');
  }

  /**
   * An agent's connection to the device ended (FR-081): its fallback sessions there stop. The
   * consents stay (they are the user's, per agent and device) but need a connection to be used.
   */
  connectionEnded(accountId: string, agentId: string, deviceId: string): void {
    this.#stopWhere(
      `account_id = ? AND device_id = ? AND consent_id IN (SELECT id FROM browser_fallback_consent
         WHERE scope_kind = 'agent' AND scope_ref = ?)`,
      [accountId, deviceId, agentId],
      'device_gone',
    );
  }

  /**
   * At the Hub's start: sessions left open by the previous run ended with it (their browsers were
   * not carried over). Returns how many.
   */
  async recover(): Promise<number> {
    const open = this.#o.db.raw
      .prepare('SELECT id FROM browser_fallback_session WHERE ended_at IS NULL')
      .all() as { id: string }[];
    for (const { id } of open) await this.end(id, 'restarted');
    return open.length;
  }

  /** `browser.localFallback` was turned off: every running fallback session stops. */
  stopAll(reason: BrowserFallbackEndReason = 'disabled'): void {
    this.#stopWhere('1 = 1', [], reason);
  }

  /** The extension on a device disconnected: the fallback sessions in the user's browser stop. */
  bridgeDisconnected(accountId: string, deviceId: string): void {
    this.#stopWhere(
      "account_id = ? AND device_id = ? AND profile = 'extension'",
      [accountId, deviceId],
      'device_gone',
    );
  }

  #stopWhere(cond: string, params: string[], reason: BrowserFallbackEndReason): void {
    const live = this.#o.db.raw
      .prepare(`SELECT id FROM browser_fallback_session WHERE ended_at IS NULL AND ${cond}`)
      .all(...params) as { id: string }[];
    for (const { id } of live)
      for (const fn of this.#stops) {
        try {
          fn(id, reason);
        } catch (err) {
          this.#log.warn('fallback stop listener failed', { err });
        }
      }
  }

  // ---- sessions -------------------------------------------------------------------------------

  #sessionView(r: SessionRow): BrowserFallbackSessionView {
    return {
      id: r.id,
      computerId: r.computer_id,
      threadId: r.thread_id,
      deviceId: r.device_id,
      site: r.site,
      profile: r.profile,
      cause: r.cause,
      consentId: r.consent_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endReason: r.end_reason,
      egress:
        r.egress_allowed === null && r.egress_refused === null
          ? null
          : { allowed: r.egress_allowed ?? 0, refused: r.egress_refused ?? 0 },
      bridgeUser: r.bridge_user,
    };
  }

  sessions(
    accountId: string,
    q: { computerId?: string; limit?: number } = {},
  ): BrowserFallbackSessionView[] {
    const rows = (q.computerId
      ? this.#o.db.raw
          .prepare(
            `SELECT * FROM browser_fallback_session WHERE account_id = ? AND computer_id = ?
               ORDER BY started_at DESC, id DESC LIMIT ?`,
          )
          .all(accountId, q.computerId, q.limit ?? 50)
      : this.#o.db.raw
          .prepare(
            `SELECT * FROM browser_fallback_session WHERE account_id = ?
               ORDER BY started_at DESC, id DESC LIMIT ?`,
          )
          .all(accountId, q.limit ?? 50)) as unknown as SessionRow[];
    return rows.map((r) => this.#sessionView(r));
  }

  /** The fallback marks of trace rows (`GET /browser/actions` adds them). */
  marks(
    accountId: string,
    actionIds: readonly string[],
  ): Map<string, { sessionId: string; deviceId: string; profile: BrowserFallbackProfile }> {
    const out = new Map<
      string,
      { sessionId: string; deviceId: string; profile: BrowserFallbackProfile }
    >();
    for (let i = 0; i < actionIds.length; i += 200) {
      const chunk = actionIds.slice(i, i + 200);
      if (!chunk.length) continue;
      const rows = this.#o.db.raw
        .prepare(
          `SELECT a.action_id AS actionId, s.id AS sessionId, s.device_id AS deviceId,
                  s.profile AS profile
             FROM browser_fallback_action a JOIN browser_fallback_session s ON s.id = a.session_id
            WHERE s.account_id = ? AND a.action_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(accountId, ...chunk) as {
        actionId: string;
        sessionId: string;
        deviceId: string;
        profile: BrowserFallbackProfile;
      }[];
      for (const r of rows)
        out.set(r.actionId, { sessionId: r.sessionId, deviceId: r.deviceId, profile: r.profile });
    }
    return out;
  }

  async marked(sessionId: string, actionId: string): Promise<void> {
    try {
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            'INSERT OR IGNORE INTO browser_fallback_action (action_id, session_id) VALUES (?, ?)',
          )
          .run(actionId, sessionId);
      });
    } catch (err) {
      this.#log.warn('could not mark a trace row as local fallback', { err });
    }
  }

  async end(
    sessionId: string,
    reason: BrowserFallbackEndReason,
    egress?: { allowed: number; refused: number } | null,
  ): Promise<void> {
    const counts = egress ?? this.#egress.get(sessionId) ?? null;
    this.#egress.delete(sessionId);
    const row = this.#o.db.raw
      .prepare('SELECT * FROM browser_fallback_session WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    if (!row || row.ended_at) return;
    const at = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE browser_fallback_session SET ended_at = ?, end_reason = ?, egress_allowed = ?,
             egress_refused = ? WHERE id = ? AND ended_at IS NULL`,
        )
        .run(at, reason, counts?.allowed ?? null, counts?.refused ?? null, sessionId);
    });
    await this.#auditAppend(
      row.account_id,
      'browser.fallback.ended',
      row.site,
      {
        sessionId,
        computerId: row.computer_id,
        deviceId: row.device_id,
        profile: row.profile,
        reason,
        egress: counts,
      },
      { threadId: row.thread_id },
    );
    await this.#emit(row.account_id, {
      sessionId,
      computerId: row.computer_id,
      deviceId: row.device_id,
      site: row.site,
      state: 'ended',
      reason,
    });
  }

  // ---- the offer --------------------------------------------------------------------------------

  async begin(input: FallbackBeginInput): Promise<FallbackPlan | FallbackRefusal> {
    const key = `${input.accountId}:${input.computerId}:${input.site}`;
    const pending = this.#offers.get(key);
    if (pending) return pending;
    const p = this.#begin(input).finally(() => this.#offers.delete(key));
    this.#offers.set(key, p);
    return p;
  }

  async #begin(input: FallbackBeginInput): Promise<FallbackPlan | FallbackRefusal> {
    const refused = async (r: FallbackRefusal, detail: Record<string, unknown> = {}) => {
      await this.#auditAppend(
        input.accountId,
        'browser.fallback.refused',
        input.site,
        { computerId: input.computerId, cause: input.cause, reason: r.reason, ...detail },
        { decision: 'deny', threadId: input.threadId, turnId: input.turnId },
      );
      return r;
    };
    if (!(await this.#o.setting('browser.localFallback')))
      return refused(
        refusal('disabled', 'The local browser fallback is turned off (browser.localFallback).'),
      );
    if (!this.#resolver || !this.#deviceDriver)
      return refused(
        refusal('not_available', 'The local browser fallback is not connected on this Hub.'),
      );
    let target: FallbackTarget | FallbackRefusal;
    try {
      target = await this.#resolver.target(input);
    } catch (err) {
      this.#log.warn('the fallback target could not be resolved', { err });
      target = refusal('failed', 'The connected computer could not be checked.');
    }
    if (!target.ok) return refused(target);
    const extension = await this.#bridgeUsable(input.accountId, target.deviceId, input.site);
    const consent = this.#live(input.accountId, target.scope, target.deviceId, input.site);
    let profile: BrowserFallbackProfile;
    let consentRow: ConsentRow;
    let reused = false;
    if (consent && (consent.profile === 'clean' || extension)) {
      profile = consent.profile;
      consentRow = consent;
      reused = true;
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare('UPDATE browser_fallback_consent SET last_used_at = ? WHERE id = ?')
          .run(this.#iso(), consent.id);
      });
      await this.#auditAppend(
        input.accountId,
        'browser.fallback.consent.used',
        input.site,
        { consentId: consent.id, deviceId: target.deviceId, profile },
        { threadId: input.threadId, turnId: input.turnId },
      );
    } else {
      const answer = await this.#ask(input, target, extension);
      if (!answer.ok) return refused(answer, { deviceId: target.deviceId });
      profile = answer.profile;
      consentRow = await this.#grant({
        accountId: input.accountId,
        scope: target.scope,
        deviceId: target.deviceId,
        site: input.site,
        profile,
        by: answer.by,
        threadId: input.threadId,
        turnId: input.turnId,
      });
    }
    const sessionId = uuidv7();
    const driver =
      profile === 'extension' && this.#bridge
        ? this.#bridge.tabDriver({
            accountId: input.accountId,
            deviceId: target.deviceId,
            deviceName: target.deviceName,
            site: input.site,
          })
        : this.#deviceDriver({
            accountId: input.accountId,
            deviceId: target.deviceId,
            deviceName: target.deviceName,
            agentId: target.scope.kind === 'agent' ? target.scope.ref : null,
            threadId: input.threadId,
            allowHosts: input.allowHosts,
            onClosed: (egress) => {
              if (!egress) return;
              const prev = this.#egress.get(sessionId);
              this.#egress.set(sessionId, {
                allowed: (prev?.allowed ?? 0) + egress.allowed,
                refused: (prev?.refused ?? 0) + egress.refused,
              });
            },
          });
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO browser_fallback_session (id, account_id, computer_id, thread_id, device_id,
             site, profile, cause, consent_id, started_at, bridge_user)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          input.accountId,
          input.computerId,
          input.threadId,
          target.deviceId,
          input.site,
          profile,
          input.cause,
          consentRow.id,
          this.#iso(),
          profile === 'extension'
            ? (this.#bridge?.user(input.accountId, target.deviceId) ?? null)
            : null,
        );
    });
    await this.#emit(input.accountId, {
      sessionId,
      computerId: input.computerId,
      deviceId: target.deviceId,
      site: input.site,
      profile,
      state: 'started',
    });
    return {
      ok: true,
      sessionId,
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      profile,
      consentId: consentRow.id,
      consentReused: reused,
      driver,
    };
  }

  async #bridgeUsable(accountId: string, deviceId: string, site: string): Promise<boolean> {
    if (!this.#bridge) return false;
    try {
      return await this.#bridge.usable(accountId, deviceId, site);
    } catch {
      return false;
    }
  }

  /** The approval-like question: which browser, or not now. Only the user answers it. */
  async #ask(
    input: FallbackBeginInput,
    target: FallbackTarget,
    extension: boolean,
  ): Promise<{ ok: true; profile: BrowserFallbackProfile; by: string } | FallbackRefusal> {
    if (!input.threadId)
      return refusal('no_thread', 'The fallback is offered in a chat; this call has none.');
    const requests = this.#requests;
    if (!requests)
      return refusal('not_available', 'The Hub cannot ask the user right now, so it did not.');
    const name = clip(target.deviceName || 'your computer', 60);
    const clean = `Continue on ${name} (clean profile)`;
    const own = `Continue in my own browser on ${name} (extension)`;
    const choices = extension ? [clean, own, NOT_NOW] : [clean, NOT_NOW];
    const question =
      `${input.site} refused the agent's browser (${clip(input.detail, 80)}). Let the agent ` +
      `continue ${input.site} on ${name}'s browser? A clean profile starts empty and reaches ` +
      `only ${input.site} and its subdomains; in your own browser the agent acts only in a tab ` +
      `it opens or one you shared, on ${input.site}. It stops when the agent leaves the site. ` +
      `Your choice is remembered for ${input.site} on ${name} until you revoke it in ` +
      `Settings → Browser.`;
    await this.#auditAppend(
      input.accountId,
      'browser.fallback.offered',
      input.site,
      {
        computerId: input.computerId,
        deviceId: target.deviceId,
        cause: input.cause,
        detail: clip(input.detail, 80),
        extension,
      },
      { threadId: input.threadId, turnId: input.turnId },
    );
    const correlation: { threadId?: string; turnId?: string; callId?: string } = {
      threadId: input.threadId,
      callId: input.callId,
    };
    if (input.turnId) correlation.turnId = input.turnId;
    const offered: BrowserFallbackOfferContext['choices'] = [
      { id: 'clean', label: clean, profile: 'clean' },
    ];
    if (extension) offered.push({ id: 'extension', label: own, profile: 'extension' });
    offered.push({ id: 'decline', label: NOT_NOW, profile: null });
    const context: BrowserFallbackOfferContext = {
      kind: 'browser.fallback',
      site: input.site,
      deviceId: target.deviceId,
      deviceName: name,
      cause: input.cause,
      choices: offered,
    };
    let answer;
    try {
      answer = await requests.ask(
        {
          accountId: input.accountId,
          kind: 'user_input',
          correlation,
          payload: {
            question,
            choices,
            allowFreeText: false,
            // The same offer, structured, for clients that show it their own way.
            context,
          },
          timeoutMs: FALLBACK_OFFER_TIMEOUT_MS,
        },
        input.signal,
      );
    } catch (err) {
      this.#log.warn('the fallback offer could not be asked', { err });
      return refusal('failed', 'The question could not be shown to the user.');
    }
    if (answer.status === 'expired')
      return refusal('expired', 'Nobody answered the offer in time.');
    if (answer.status === 'cancelled') return refusal('cancelled', 'The offer was cancelled.');
    const choice = (answer.result as { choice?: unknown } | null)?.choice;
    if (choice === clean) return { ok: true, profile: 'clean', by: answer.by };
    if (extension && choice === own) return { ok: true, profile: 'extension', by: answer.by };
    return refusal('declined', 'The user chose not to continue on their computer.');
  }
}

/** The devices area's view the default resolver reads (DeviceService fits it). */
export interface FallbackDeviceSource {
  activeConnection(
    accountId: string,
    agentId: string,
  ): Promise<{ deviceId: string; deviceName: string; capabilities: readonly string[] } | null>;
  capabilities(
    accountId: string,
    deviceId: string,
  ): Promise<{ name: string; available: boolean; reason: string | null }[]>;
  device(
    accountId: string,
    deviceId: string,
  ): Promise<{ row: { status: string }; endpoint: string | null }>;
}

/**
 * The default resolver: the computer's agent, its one active connection (FR-081) that was given
 * the browser, and a device whose novad serves the `browser` module and is reachable now.
 */
export function connectedComputerResolver(opts: {
  agentOfComputer: (accountId: string, computerId: string) => Promise<string | null>;
  devices: FallbackDeviceSource;
}): FallbackTargetResolver {
  return {
    async target({ accountId, computerId }) {
      const agentId = await opts.agentOfComputer(accountId, computerId);
      if (!agentId)
        return refusal(
          'no_connected_computer',
          'Only an agent with a connected computer can continue on it, and this browser is not an agent’s.',
        );
      const conn = await opts.devices.activeConnection(accountId, agentId);
      if (!conn) return refusal('no_connected_computer', 'This agent has no connected computer.');
      if (!conn.capabilities.includes('browser'))
        return refusal(
          'no_browser_module',
          `${conn.deviceName} is connected to this agent without its browser.`,
        );
      const caps = await opts.devices.capabilities(accountId, conn.deviceId);
      const browser = caps.find((c) => c.name === 'browser');
      if (!browser?.available)
        return refusal(
          'no_browser_module',
          `${conn.deviceName} does not offer its browser (${browser?.reason ?? 'module_missing'}).`,
        );
      const d = await opts.devices.device(accountId, conn.deviceId);
      if (d.row.status !== 'active' || !d.endpoint)
        return refusal('device_unreachable', `${conn.deviceName} is not reachable now.`);
      return {
        ok: true,
        scope: { kind: 'agent', ref: agentId },
        deviceId: conn.deviceId,
        deviceName: conn.deviceName,
      };
    },
  };
}
