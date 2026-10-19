// The extension bridge, the Hub's side (FR-096, docs/11 §4.3; ADR-096 D8). The user's own browser
// runs our extension, which talks to novad's native-messaging host on the same computer; novad
// relays the extension's events to `POST /agent/v1/bridge/events` (device credential) and the
// Hub's calls to the extension through `POST /agent/v1/bridge/call`. No third-party relay.
//   - Status per device (connected, shared tabs) comes only from those events and lives in memory:
//     after a Hub restart a device counts as disconnected until novad reports again.
//   - Per-host grants are owner-confirmed rows (0043). "All sites" (`*`) is a separate grant with
//     its own acknowledgement of the elevated risk, and `browser.extensionBridgeAllSites` can
//     disable it. A host the extension reports the browser's permission for becomes a `pending`
//     grant until the owner confirms it. `browser.extensionBridge` (managed policy can lock it off)
//     disables everything.
//   - Per-tab consent: the agent acts only in tabs the user shared (`tab.shared`) or that it
//     opened itself in the Nova tab group; closing or unsharing a tab ends it.
//   - Calls: only the listed methods, and `cdp.send` only with the protocol methods the tab driver
//     uses (bridge-tab.ts), never a cookie, storage or network-capture method, on a consented tab
//     whose host has an active grant. The page actions themselves pass the browser controller's
//     checks (site lists and levels, the classifier, the gate) like every agent browser action.
//   - `history.search` has no standing grant: the extension asks the user for every request.
// Refusals fail closed and are audited.
import {
  BROWSER_BRIDGE_SCRIPTS,
  NovaError,
  uuidv7,
  type BridgeEvent,
  type BrowserBridgeGrantState,
  type BrowserBridgeGrantView,
  type BrowserBridgeMethod,
  type BrowserBridgeStatusView,
  type BrowserBridgeTabView,
  type CreateBridgeGrantRequest,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { SettingReader } from '../approvals/gate.ts';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { BridgeTabDriver } from './bridge-tab.ts';
import type { DeviceBridgeCaller } from './device-link.ts';
import { isLoopbackHost, normalizeHost, sameSite } from './sites.ts';
import type { BrowserDriver } from './types.ts';

/** The protocol methods `cdp.send` may carry (what the tab driver needs, nothing else). */
export const BRIDGE_CDP_METHODS: readonly string[] = [
  'Runtime.evaluate',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.navigate',
  'Page.captureScreenshot',
];
/** How long a `history.search` waits for the user's answer in the extension. */
export const BRIDGE_HISTORY_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_TABS = 50;

interface DeviceState {
  accountId: string;
  connected: boolean;
  since: string | null;
  extensionVersion: string | null;
  browser: string | null;
  user: string | null;
  tabs: Map<number, BrowserBridgeTabView>;
}

interface GrantRow {
  id: string;
  account_id: string;
  device_id: string;
  host: string;
  state: BrowserBridgeGrantState;
  browser_permission: number;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface ExtensionBridgeOptions {
  db: NovaDatabase;
  events: EventSink;
  setting: SettingReader;
  audit?: AuditSink | null;
  caller?: DeviceBridgeCaller | null;
  /**
   * The Hub's own host names and addresses (its configured names, LAN addresses, `.local` name,
   * the Relay): no grant, all sites included, ever covers them.
   */
  hubHosts?: () => Promise<readonly string[]>;
  log?: Logger;
  now?: () => Date;
}

/** The host of a URL the extension reported, or null (non-web pages). */
function urlHost(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class ExtensionBridgeService {
  readonly #o: ExtensionBridgeOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  #caller: DeviceBridgeCaller | null;
  #audit: AuditSink | null;
  #hubHosts: () => Promise<readonly string[]>;
  readonly #devices = new Map<string, DeviceState>();
  readonly #disconnects = new Set<(accountId: string, deviceId: string) => void>();

  constructor(opts: ExtensionBridgeOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.browser.bridge', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#caller = opts.caller ?? null;
    this.#audit = opts.audit ?? null;
    this.#hubHosts = opts.hubHosts ?? (() => Promise.resolve([]));
  }

  /** Where the Hub itself answers (names and addresses); never reachable through a grant. */
  useHubHosts(fn: () => Promise<readonly string[]>): void {
    this.#hubHosts = fn;
  }

  /** Whether `host` is one of the Hub's own (loopback names count: the browser may run there). */
  async isHubHost(host: string): Promise<boolean> {
    const h = normalizeHost(host);
    if (isLoopbackHost(h)) return true;
    let own: readonly string[];
    try {
      own = await this.#hubHosts();
    } catch {
      // Fail closed: without the list nothing can be told apart from the Hub.
      return true;
    }
    return own.some((o) => {
      const n = normalizeHost(o);
      return n !== '' && (n === h || (h.endsWith(`.${n}`) && n.includes('.')));
    });
  }

  useCaller(caller: DeviceBridgeCaller): void {
    this.#caller = caller;
  }
  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }
  /** Called when a device's bridge disconnects or the device is forgotten. */
  onDisconnected(fn: (accountId: string, deviceId: string) => void): () => void {
    this.#disconnects.add(fn);
    return () => this.#disconnects.delete(fn);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  async #auditAppend(
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    actor: 'user' | 'system' = 'system',
    decision: string | null = null,
  ): Promise<void> {
    await this.#audit
      ?.append({ accountId, actor, kind: 'browser', action, resource, decision, detail })
      .catch((err: unknown) => this.#log.warn('bridge audit failed', { err }));
  }

  async #changed(accountId: string, deviceId: string): Promise<void> {
    const st = this.#devices.get(deviceId);
    await this.#o.events
      .emit({
        name: 'browser.bridge.changed',
        accountId,
        actor: 'system',
        payload: { deviceId, connected: st?.connected ?? false, tabs: st?.tabs.size ?? 0 },
      })
      .catch(() => undefined);
  }

  #device(accountId: string, deviceId: string): { name: string | null } {
    const row = this.#o.db.raw
      .prepare('SELECT name, account_id, status FROM device WHERE id = ?')
      .get(deviceId) as { name: string | null; account_id: string; status: string } | undefined;
    if (!row || row.account_id !== accountId || row.status === 'revoked')
      throw new NovaError('not_found', 'device not found');
    return { name: row.name };
  }

  #state(accountId: string, deviceId: string): DeviceState {
    let st = this.#devices.get(deviceId);
    if (!st || st.accountId !== accountId) {
      st = {
        accountId,
        connected: false,
        since: null,
        extensionVersion: null,
        browser: null,
        user: null,
        tabs: new Map(),
      };
      this.#devices.set(deviceId, st);
    }
    return st;
  }

  // ---- events from novad (D8) ---------------------------------------------------------------

  /** Apply the events novad relayed for an authenticated device. */
  async applyEvents(
    device: { id: string; accountId: string },
    events: readonly BridgeEvent[],
  ): Promise<{ accepted: number }> {
    const st = this.#state(device.accountId, device.id);
    let accepted = 0;
    for (const e of events) {
      accepted++;
      const at = this.#iso();
      switch (e.kind) {
        case 'connected':
          // A host replacing another (novad sends no `disconnected` for it), or another OS
          // user's browser, ends everything the previous connection held.
          if (st.connected) {
            st.tabs.clear();
            await this.#auditAppend(device.accountId, 'browser.bridge.replaced', device.id, {
              before: { user: st.user },
              after: { user: e.user ?? null },
            });
            this.#notifyDisconnect(device.accountId, device.id);
          }
          st.connected = true;
          st.since = at;
          st.extensionVersion = e.extensionVersion ?? null;
          st.browser = e.browser ?? null;
          st.user = e.user ?? null;
          // A new connection starts without consents: tabs are shared again.
          st.tabs.clear();
          await this.#auditAppend(device.accountId, 'browser.bridge.connected', device.id, {
            user: st.user,
            extensionVersion: st.extensionVersion,
            browser: st.browser,
          });
          break;
        case 'disconnected':
          st.connected = false;
          st.since = at;
          st.tabs.clear();
          await this.#auditAppend(device.accountId, 'browser.bridge.disconnected', device.id, {});
          this.#notifyDisconnect(device.accountId, device.id);
          break;
        case 'tab.shared': {
          if (!st.tabs.has(e.tabId) && st.tabs.size >= MAX_TABS) break;
          const host = e.host ? normalizeHost(e.host) : null;
          // The consent belongs to the OS user whose browser shared it (novad's `connected`).
          st.tabs.set(e.tabId, {
            tabId: e.tabId,
            host,
            title: e.title ?? null,
            origin: e.origin ?? 'shared',
            since: at,
            user: st.user,
          });
          await this.#auditAppend(device.accountId, 'browser.bridge.tab.shared', host, {
            deviceId: device.id,
            tabId: e.tabId,
            origin: e.origin ?? 'shared',
            user: st.user,
          });
          break;
        }
        case 'tab.unshared':
        case 'tab.closed':
          if (st.tabs.delete(e.tabId))
            await this.#auditAppend(
              device.accountId,
              e.kind === 'tab.closed' ? 'browser.bridge.tab.closed' : 'browser.bridge.tab.unshared',
              null,
              { deviceId: device.id, tabId: e.tabId },
            );
          break;
        case 'host.granted':
          await this.#browserPermission(device, e.host, true);
          break;
        case 'host.revoked':
          await this.#browserPermission(device, e.host, false);
          break;
      }
    }
    await this.#changed(device.accountId, device.id);
    return { accepted };
  }

  #notifyDisconnect(accountId: string, deviceId: string): void {
    for (const fn of this.#disconnects) {
      try {
        fn(accountId, deviceId);
      } catch (err) {
        this.#log.warn('bridge disconnect listener failed', { err });
      }
    }
  }

  /**
   * The extension reports the browser's own permission for a host. A host without a grant gets a
   * `pending` one the owner may confirm; the permission never activates a grant by itself.
   */
  async #browserPermission(
    device: { id: string; accountId: string },
    host: string,
    granted: boolean,
  ): Promise<void> {
    const at = this.#iso();
    const live = this.#liveGrant(device.id, host);
    await this.#o.db.transaction(() => {
      if (live)
        this.#o.db.raw
          .prepare(
            'UPDATE browser_bridge_grant SET browser_permission = ?, updated_at = ? WHERE id = ?',
          )
          .run(granted ? 1 : 0, at, live.id);
      else if (granted)
        this.#o.db.raw
          .prepare(
            `INSERT INTO browser_bridge_grant (id, account_id, device_id, host, state,
               browser_permission, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)`,
          )
          .run(uuidv7(), device.accountId, device.id, host, at, at);
    });
    await this.#auditAppend(
      device.accountId,
      granted ? 'browser.bridge.host.reported' : 'browser.bridge.host.withdrawn',
      host,
      { deviceId: device.id, grantId: live?.id ?? null, grantState: live?.state ?? null },
    );
  }

  // ---- status --------------------------------------------------------------------------------

  async status(accountId: string, deviceId: string): Promise<BrowserBridgeStatusView> {
    const { name } = this.#device(accountId, deviceId);
    const st = this.#devices.get(deviceId);
    const [enabled, allSitesAllowed] = await Promise.all([
      this.#o.setting('browser.extensionBridge'),
      this.#o.setting('browser.extensionBridgeAllSites'),
    ]);
    return {
      deviceId,
      deviceName: name,
      connected: st?.accountId === accountId ? st.connected : false,
      since: st?.accountId === accountId ? st.since : null,
      extensionVersion: st?.accountId === accountId ? st.extensionVersion : null,
      browser: st?.accountId === accountId ? st.browser : null,
      user: st?.accountId === accountId ? st.user : null,
      enabled,
      allSitesAllowed,
      tabs: st?.accountId === accountId ? [...st.tabs.values()] : [],
    };
  }

  connected(accountId: string, deviceId: string): boolean {
    const st = this.#devices.get(deviceId);
    return st?.accountId === accountId && st.connected;
  }

  /** A tab the user shared on `site` (same site), if any. */
  sharedTab(accountId: string, deviceId: string, site: string): BrowserBridgeTabView | null {
    const st = this.#devices.get(deviceId);
    if (st?.accountId !== accountId) return null;
    for (const t of st.tabs.values())
      if (t.origin === 'shared' && t.host && sameSite(site, t.host)) return t;
    return null;
  }

  /**
   * The tab may be acted in: the user shared it, or the agent opened it in the Nova group, in the
   * browser of the OS user connected now (a tab id of another user's browser is not the same tab).
   */
  tabConsented(accountId: string, deviceId: string, tabId: number): boolean {
    const st = this.#devices.get(deviceId);
    const tab = st?.accountId === accountId ? st.tabs.get(tabId) : undefined;
    return tab !== undefined && (tab.user ?? null) === st!.user;
  }

  /** The OS user whose browser the bridge serves now (null when unknown). */
  user(accountId: string, deviceId: string): string | null {
    const st = this.#devices.get(deviceId);
    return st?.accountId === accountId ? st.user : null;
  }

  /** Forget a device (revoked or decommissioned): its state goes and its grants are revoked. */
  async forgetDevice(accountId: string, deviceId: string): Promise<void> {
    this.#devices.delete(deviceId);
    const rows = this.#o.db.raw
      .prepare(
        "SELECT * FROM browser_bridge_grant WHERE account_id = ? AND device_id = ? AND state <> 'revoked'",
      )
      .all(accountId, deviceId) as unknown as GrantRow[];
    for (const r of rows) await this.#revoke(r, 'system');
    this.#notifyDisconnect(accountId, deviceId);
  }

  // ---- grants --------------------------------------------------------------------------------

  #view(r: GrantRow): BrowserBridgeGrantView {
    return {
      id: r.id,
      deviceId: r.device_id,
      host: r.host,
      allSites: r.host === '*',
      state: r.state,
      browserPermission: r.browser_permission === 1,
      confirmedBy: r.confirmed_by,
      confirmedAt: r.confirmed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      revokedAt: r.revoked_at,
      revokedBy: r.revoked_by,
    };
  }

  #liveGrant(deviceId: string, host: string): GrantRow | null {
    return (
      (this.#o.db.raw
        .prepare(
          "SELECT * FROM browser_bridge_grant WHERE device_id = ? AND host = ? AND state <> 'revoked'",
        )
        .get(deviceId, host) as GrantRow | undefined) ?? null
    );
  }

  grants(accountId: string, deviceId: string, all = false): BrowserBridgeGrantView[] {
    this.#device(accountId, deviceId);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT * FROM browser_bridge_grant WHERE account_id = ? AND device_id = ?
         ${all ? '' : "AND state <> 'revoked'"} ORDER BY created_at DESC, id DESC LIMIT 500`,
      )
      .all(accountId, deviceId) as unknown as GrantRow[];
    return rows.map((r) => this.#view(r));
  }

  #grantRow(accountId: string, grantId: string): GrantRow {
    const row = this.#o.db.raw
      .prepare('SELECT * FROM browser_bridge_grant WHERE id = ? AND account_id = ?')
      .get(grantId, accountId) as GrantRow | undefined;
    if (!row) throw new NovaError('not_found', 'grant not found');
    return row;
  }

  async #allSitesAllowed(): Promise<void> {
    if (!(await this.#o.setting('browser.extensionBridgeAllSites')))
      throw new NovaError('policy_denied', 'the "all sites" grant is turned off by policy', {
        details: { reason: 'all_sites_disabled' },
      });
  }

  /** Grant one host, or all sites (owner-confirmed, its own acknowledgement for all sites). */
  async createGrant(
    accountId: string,
    deviceId: string,
    body: CreateBridgeGrantRequest,
    by: string,
  ): Promise<BrowserBridgeGrantView> {
    this.#device(accountId, deviceId);
    if (!(await this.#o.setting('browser.extensionBridge')))
      throw new NovaError('policy_denied', 'the extension bridge is turned off', {
        details: { reason: 'bridge_disabled' },
      });
    const host = body.kind === 'all_sites' ? '*' : normalizeHost(body.host);
    if (host === '*') await this.#allSitesAllowed();
    else if (await this.isHubHost(host))
      throw new NovaError(
        'policy_denied',
        'the Hub’s own addresses are never granted to the bridge',
        {
          details: { reason: 'hub_host' },
        },
      );
    const at = this.#iso();
    const before = this.#liveGrant(deviceId, host);
    if (before?.state === 'active') return this.#view(before);
    await this.#o.db.transaction(() => {
      if (before)
        this.#o.db.raw
          .prepare(
            `UPDATE browser_bridge_grant SET state = 'active', confirmed_by = ?, confirmed_at = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(by, at, at, before.id);
      else
        this.#o.db.raw
          .prepare(
            `INSERT INTO browser_bridge_grant (id, account_id, device_id, host, state,
               browser_permission, confirmed_by, confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
          )
          .run(uuidv7(), accountId, deviceId, host, by, at, at, at);
    });
    const row = this.#liveGrant(deviceId, host)!;
    await this.#auditAppend(
      accountId,
      host === '*' ? 'browser.bridge.grant.all_sites' : 'browser.bridge.grant.created',
      host,
      {
        deviceId,
        grantId: row.id,
        elevated: host === '*',
        before: before ? { state: before.state } : null,
        after: { state: 'active' },
      },
      'user',
      'allow',
    );
    await this.#grantEvent(accountId, row);
    return this.#view(row);
  }

  /** Confirm a pending grant (one the extension reported). All sites needs its acknowledgement. */
  async confirmGrant(
    accountId: string,
    grantId: string,
    body: { acknowledgeElevatedRisk?: true | undefined },
    by: string,
  ): Promise<BrowserBridgeGrantView> {
    const row = this.#grantRow(accountId, grantId);
    if (row.state === 'revoked') throw new NovaError('conflict', 'the grant was revoked');
    if (row.host === '*') {
      if (body.acknowledgeElevatedRisk !== true)
        throw new NovaError('validation', '"all sites" needs its own acknowledgement of the risk', {
          details: { reason: 'elevated_ack_required' },
        });
    }
    return this.createGrant(
      accountId,
      row.device_id,
      row.host === '*'
        ? { kind: 'all_sites', confirm: true, acknowledgeElevatedRisk: true }
        : { kind: 'host', host: row.host, confirm: true },
      by,
    );
  }

  async revokeGrant(accountId: string, grantId: string, by: string): Promise<void> {
    const row = this.#grantRow(accountId, grantId);
    if (row.state === 'revoked') return;
    await this.#revoke(row, by);
  }

  async #revoke(row: GrantRow, by: string): Promise<void> {
    const at = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE browser_bridge_grant SET state = 'revoked', revoked_at = ?, revoked_by = ?,
             updated_at = ? WHERE id = ? AND state <> 'revoked'`,
        )
        .run(at, by, at, row.id);
    });
    await this.#auditAppend(
      row.account_id,
      'browser.bridge.grant.revoked',
      row.host,
      {
        deviceId: row.device_id,
        grantId: row.id,
        before: { state: row.state },
        after: { state: 'revoked' },
      },
      by === 'system' ? 'system' : 'user',
    );
    await this.#grantEvent(row.account_id, { ...row, state: 'revoked' });
  }

  async #grantEvent(accountId: string, row: GrantRow): Promise<void> {
    await this.#o.events
      .emit({
        name: 'browser.bridge.grant.changed',
        accountId,
        actor: 'system',
        payload: { deviceId: row.device_id, grantId: row.id, host: row.host, state: row.state },
      })
      .catch(() => undefined);
  }

  /**
   * Whether the bridge may act on `host` of the device: the switch is on and an owner-confirmed
   * grant covers the host (the host itself, its `www.` twin, or all sites while allowed).
   */
  async hostAllowed(
    accountId: string,
    deviceId: string,
    host: string,
  ): Promise<{ ok: true; grantId: string } | { ok: false; reason: string }> {
    if (!(await this.#o.setting('browser.extensionBridge')))
      return { ok: false, reason: 'bridge_disabled' };
    const h = normalizeHost(host);
    if (await this.isHubHost(h)) return { ok: false, reason: 'hub_host' };
    const rows = this.#o.db.raw
      .prepare(
        "SELECT * FROM browser_bridge_grant WHERE account_id = ? AND device_id = ? AND state = 'active'",
      )
      .all(accountId, deviceId) as unknown as GrantRow[];
    const exact = rows.find((r) => r.host !== '*' && sameSite(r.host, h));
    if (exact) return { ok: true, grantId: exact.id };
    const all = rows.find((r) => r.host === '*');
    if (all) {
      if (await this.#o.setting('browser.extensionBridgeAllSites'))
        return { ok: true, grantId: all.id };
      return { ok: false, reason: 'all_sites_disabled' };
    }
    return { ok: false, reason: 'host_not_granted' };
  }

  /** The bridge can serve `site` now: enabled, connected, and the host granted. */
  async usable(accountId: string, deviceId: string, site: string): Promise<boolean> {
    if (!this.connected(accountId, deviceId)) return false;
    return (await this.hostAllowed(accountId, deviceId, site)).ok;
  }

  // ---- calls -----------------------------------------------------------------------------------

  async #refuse(
    accountId: string,
    deviceId: string,
    method: string,
    reason: string,
    message: string,
  ): Promise<never> {
    await this.#auditAppend(
      accountId,
      'browser.bridge.refused',
      null,
      { deviceId, method, reason },
      'system',
      'deny',
    );
    throw new NovaError('policy_denied', message, { details: { reason } });
  }

  /**
   * One call to the extension (D8), checked first: the switch, the method, the tab's consent, the
   * host's grant and the protocol method. `host` is the page's host for `cdp.send`, the target
   * site for `tabs.open`. The extension's answer is untrusted.
   */
  async call(
    accountId: string,
    deviceId: string,
    method: BrowserBridgeMethod,
    params: Record<string, unknown>,
    opts: {
      /** The site the caller acts for: the grant `tabs.open` and an about:blank page need. */
      site?: string;
      /** The OS user the caller's tab belongs to (a tab driver pins it at launch). */
      user?: string | null;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const refuse = (reason: string, message: string) =>
      this.#refuse(accountId, deviceId, method, reason, message);
    if (!(await this.#o.setting('browser.extensionBridge')))
      return refuse('bridge_disabled', 'the extension bridge is turned off');
    const caller = this.#caller;
    if (!caller) return refuse('not_wired', 'the extension bridge is not connected on this Hub');
    this.#device(accountId, deviceId);
    if (opts.user !== undefined && this.user(accountId, deviceId) !== opts.user)
      return refuse('user_changed', 'another person’s browser is connected now');
    const tabId = typeof params.tabId === 'number' ? params.tabId : null;
    if (method === 'tab.attach' || method === 'tab.detach' || method === 'cdp.send') {
      if (tabId === null || !this.tabConsented(accountId, deviceId, tabId))
        return refuse('tab_not_shared', 'the agent may act only in tabs you shared or it opened');
    }
    let grantHost: string | null = null;
    if (method === 'tabs.open') grantHost = opts.site ? normalizeHost(opts.site) : null;
    if (method === 'cdp.send') {
      const proto = typeof params.method === 'string' ? params.method : '';
      if (!BRIDGE_CDP_METHODS.includes(proto))
        return refuse(
          'cdp_method_not_allowed',
          `${proto.slice(0, 60) || 'that method'} is not available through the bridge`,
        );
      const inner = isRecord(params.params) ? params.params : {};
      // The host the tab must be on (null: about:blank); the extension refuses any other.
      const expect = params.expectHost;
      if (expect !== null && (typeof expect !== 'string' || !expect))
        return refuse('host_unknown', 'the page of that tab is not known');
      if (proto === 'Page.navigate') {
        grantHost = typeof inner.url === 'string' ? urlHost(inner.url) : null;
      } else {
        // An about:blank page is checked against the site the caller acts for: a null host
        // never skips the grant.
        grantHost =
          expect !== null ? normalizeHost(expect) : opts.site ? normalizeHost(opts.site) : null;
      }
      if (proto === 'Runtime.evaluate') {
        const script = inner.script;
        if (
          inner.expression !== undefined ||
          typeof script !== 'string' ||
          !(BROWSER_BRIDGE_SCRIPTS as readonly string[]).includes(script)
        )
          return refuse('script_not_allowed', 'only the extension’s own page scripts run');
      }
      if (proto === 'Input.dispatchKeyEvent' || proto === 'Input.dispatchMouseEvent') {
        const mods = typeof inner.modifiers === 'number' ? inner.modifiers : 0;
        // Alt, Control and Meta make shortcuts (paste, copy, cut the user's clipboard).
        if ((mods & 7) !== 0 || inner.commands !== undefined)
          return refuse('modifier_not_allowed', 'only Shift may be held in your own browser');
      }
    }
    if (method === 'cdp.send' || method === 'tabs.open') {
      if (!grantHost) return refuse('host_unknown', 'the page of that tab is not known');
      const grant = await this.hostAllowed(accountId, deviceId, grantHost);
      if (!grant.ok)
        return refuse(grant.reason, `${grantHost} is not granted to the extension bridge`);
    }
    const r = await caller.bridgeCall({
      accountId,
      deviceId,
      method,
      params,
      timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS,
    });
    if ('error' in r)
      throw new NovaError('policy_denied', `the extension refused: ${r.error.message}`, {
        details: { reason: 'extension_refused', code: r.error.code },
      });
    if (method === 'tabs.open') {
      const opened =
        isRecord(r.result) && typeof r.result.tabId === 'number' ? r.result.tabId : null;
      if (opened === null) throw new NovaError('server_error', 'the extension opened no tab');
      const st = this.#state(accountId, deviceId);
      st.tabs.set(opened, {
        tabId: opened,
        host: null,
        title: null,
        origin: 'agent',
        since: this.#iso(),
        user: st.user,
      });
      await this.#auditAppend(accountId, 'browser.bridge.tab.opened', opts.site ?? null, {
        deviceId,
        tabId: opened,
      });
    }
    if (method === 'tab.attach' || method === 'tab.detach')
      await this.#auditAppend(accountId, `browser.bridge.${method}`, null, { deviceId, tabId });
    return r.result;
  }

  /**
   * Where a consented tab is now, as the extension sees it: its committed host, and whether a
   * navigation is still under way (and to which host). Null when the tab is gone.
   */
  async tabInfo(
    accountId: string,
    deviceId: string,
    tabId: number,
    user?: string | null,
  ): Promise<{ host: string | null; loading: boolean; pendingHost: string | null } | null> {
    const r = await this.call(
      accountId,
      deviceId,
      'tabs.list',
      {},
      user === undefined ? {} : { user },
    );
    const tabs = isRecord(r) && Array.isArray(r.tabs) ? r.tabs : [];
    const t = tabs.find((x): x is Record<string, unknown> => isRecord(x) && x.tabId === tabId);
    if (!t) return null;
    return {
      host: typeof t.host === 'string' ? normalizeHost(t.host) : null,
      loading: t.loading === true,
      pendingHost: typeof t.pendingHost === 'string' ? normalizeHost(t.pendingHost) : null,
    };
  }

  /** Update what the Hub knows of a consented tab's host (after the agent's own navigation). */
  noteTabHost(accountId: string, deviceId: string, tabId: number, host: string | null): void {
    const t = this.#devices.get(deviceId)?.tabs.get(tabId);
    if (t && this.#devices.get(deviceId)?.accountId === accountId) t.host = host;
  }

  /**
   * Search the user's history (FR-096): no standing grant, the extension asks the user for this
   * request and answers nothing without their yes. Audited with the query's length only.
   */
  async historySearch(
    accountId: string,
    deviceId: string,
    query: string,
    maxResults = 20,
  ): Promise<{ items: { title: string; host: string | null; lastVisit: string | null }[] }> {
    const q = query.trim().slice(0, 200);
    if (!q) throw new NovaError('validation', 'a search needs some text');
    let result: unknown;
    try {
      result = await this.call(
        accountId,
        deviceId,
        'history.search',
        { query: q, maxResults: Math.min(Math.max(maxResults, 1), 50) },
        { timeoutMs: BRIDGE_HISTORY_TIMEOUT_MS },
      );
    } finally {
      // Listed per computer: the resource is the device.
      await this.#auditAppend(accountId, 'browser.bridge.history.search', `device:${deviceId}`, {
        deviceId,
        queryLength: q.length,
      });
    }
    const raw = isRecord(result) && Array.isArray(result.items) ? result.items : [];
    return {
      items: raw.slice(0, 50).flatMap((it) =>
        isRecord(it)
          ? [
              {
                title: typeof it.title === 'string' ? it.title.slice(0, 300) : '',
                // Hosts only: full addresses of the user's history may carry tokens.
                // The extension sends hosts only; a full address is cut to its host anyway.
                host:
                  typeof it.host === 'string'
                    ? normalizeHost(it.host).slice(0, 253)
                    : typeof it.url === 'string'
                      ? urlHost(it.url)
                      : null,
                lastVisit: typeof it.lastVisit === 'string' ? it.lastVisit.slice(0, 40) : null,
              },
            ]
          : [],
      ),
    };
  }

  /** The fallback's driver for the user's own browser: a tab on `site` (FR-209 with FR-096). */
  tabDriver(input: {
    accountId: string;
    deviceId: string;
    deviceName: string;
    site: string;
  }): BrowserDriver {
    return new BridgeTabDriver({ ...input, bridge: this, log: this.#log });
  }
}
