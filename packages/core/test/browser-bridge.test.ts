// The extension bridge, the Hub's side (FR-096, docs/11 §4.3; ADR-096 D8): status and tab
// consents from novad's events, per-host grants (owner-confirmed; "all sites" separate, with its
// own acknowledgement, and a policy switch; `browser.extensionBridge` disables everything), the
// checks before every call (consented tab, granted host, allowed protocol method), history only
// through the extension's own prompt, and a tab of the user's browser driven by the browser
// controller through `cdp.send`, also as the local fallback's "my own browser" (FR-209).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskInput, AskResult, AuditRecord } from '../src/index.ts';
import {
  BRIDGE_HISTORY_TIMEOUT_MS,
  BRIDGE_HISTORY_TOOL,
  ExtensionBridgeService,
  bridgeToolSource,
  LocalFallbackService,
  type DeviceBridgeCaller,
  type DriverLaunchOptions,
} from '../src/browser/index.ts';
import { ACCOUNT, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import { PNG } from './browser-fake.ts';

const DEVICE = 'dev-laptop';
const OTHER_DEVICE = 'dev-other';

interface FakePage {
  title: string;
  text: string;
  elements: { ref: string; role: string; name: string; tag: string; href?: string }[];
  /** Clicking goes here. */
  next?: string;
}

interface FakeTab {
  url: string;
  /** A navigation under way (not committed yet). */
  pendingUrl?: string;
  /** tabs.list polls the navigation stays pending for. */
  pendingPolls?: number;
}

function hostOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * The extension behind novad, as the real one behaves (apps/extension/src/bridge.ts): tabs with a
 * page each, `cdp.send` refused unless the tab is on the expected host (a pending navigation
 * counts), page scripts by name only, and every call kept.
 */
class FakeExtension implements DeviceBridgeCaller {
  readonly calls: { method: string; params: Record<string, unknown>; timeoutMs: number }[] = [];
  readonly pages = new Map<string, FakePage>();
  readonly tabs = new Map<number, FakeTab>();
  nextTab = 40;
  refuse: string | null = null;
  history: unknown = { items: [] };
  secretField = false;
  /** Fail the next DevTools command with this message (the browser's own wording). */
  failNext: string | null = null;
  navigateError: string | null = null;
  /** Clicks start a navigation that stays pending for this many tabs.list polls. */
  clickPendingPolls = 0;

  url(tabId: number): string {
    return this.tabs.get(tabId)?.url ?? 'about:blank';
  }

  /** The page (or the user) moves the tab. */
  move(tabId: number, url: string): void {
    this.tabs.set(tabId, { url });
  }

  bridgeCall(input: {
    method: string;
    params: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<{ result: unknown } | { error: { code: string; message: string } }> {
    this.calls.push(input);
    if (this.refuse) return Promise.resolve({ error: { code: 'refused', message: this.refuse } });
    const p = input.params;
    switch (input.method) {
      case 'tabs.open': {
        const id = this.nextTab++;
        this.tabs.set(id, { url: String(p.url) });
        return Promise.resolve({ result: { tabId: id } });
      }
      case 'tabs.list':
        return Promise.resolve({
          result: {
            tabs: [...this.tabs].map(([tabId, t]) => {
              const pending = t.pendingUrl !== undefined && (t.pendingPolls ?? 0) > 0;
              if (t.pendingUrl !== undefined && !pending) {
                t.url = t.pendingUrl;
                delete t.pendingUrl;
              } else if (pending) t.pendingPolls = (t.pendingPolls ?? 1) - 1;
              return {
                tabId,
                host: hostOfUrl(t.url),
                title: '',
                origin: 'shared',
                loading: pending,
                pendingHost: pending ? hostOfUrl(t.pendingUrl!) : null,
              };
            }),
          },
        });
      case 'tab.attach':
      case 'tab.detach':
        return Promise.resolve({ result: { ok: true } });
      case 'history.search':
        return Promise.resolve({ result: this.history });
      case 'cdp.send': {
        if (this.failNext) {
          const message = this.failNext;
          this.failNext = null;
          return Promise.resolve({ error: { code: 'failed', message } });
        }
        const tabId = Number(p.tabId);
        const tab = this.tabs.get(tabId) ?? { url: 'about:blank' };
        const now = tab.pendingUrl ?? tab.url;
        const nowHost = now === 'about:blank' ? null : hostOfUrl(now);
        if (now !== 'about:blank' && !nowHost)
          return Promise.resolve({
            error: { code: 'not_web', message: 'the tab shows a page that is not a web site' },
          });
        if (nowHost !== (p.expectHost ?? null))
          return Promise.resolve({
            error: {
              code: 'host_changed',
              message: 'the tab is no longer on the site the call was for',
            },
          });
        return Promise.resolve({
          result: this.#cdp(tabId, String(p.method), p.params as Record<string, unknown>),
        });
      }
    }
    return Promise.resolve({ error: { code: 'unknown', message: 'unknown method' } });
  }

  #cdp(tabId: number, method: string, params: Record<string, unknown>): unknown {
    const url = this.url(tabId);
    const page = this.pages.get(url);
    switch (method) {
      case 'Page.navigate':
        if (this.navigateError) return { frameId: 'f', errorText: this.navigateError };
        this.tabs.set(tabId, { url: String(params.url) });
        return { frameId: 'f' };
      case 'Page.captureScreenshot':
        return { data: PNG.toString('base64') };
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased' && page?.next) {
          if (this.clickPendingPolls)
            this.tabs.set(tabId, {
              url,
              pendingUrl: page.next,
              pendingPolls: this.clickPendingPolls,
            });
          else this.tabs.set(tabId, { url: page.next });
        }
        return {};
      case 'Input.insertText':
      case 'Input.dispatchKeyEvent':
        return {};
      case 'Runtime.evaluate': {
        if (params.expression !== undefined) return { exceptionDetails: { text: 'refused' } };
        const arg = (params.arg ?? {}) as Record<string, unknown>;
        const value = (() => {
          switch (params.script) {
            case 'href':
              return url;
            case 'readyState':
              return 'complete';
            case 'navStatus':
              return 200;
            case 'frames':
              return [];
            case 'read':
              return {
                title: page?.title ?? '',
                text: page?.text ?? '',
                elements: page?.elements ?? [],
              };
            case 'describe':
              return page?.elements.find((x) => x.ref === arg.ref) ?? null;
            case 'point':
            case 'box':
              return { x: 10, y: 20, width: 5, height: 5 };
            case 'focus':
              return true;
            case 'focusedSecret':
              return this.secretField;
            case 'select':
              return arg.value === 'Large';
            case 'hasText':
              return (page?.text ?? '').includes(String(arg.text));
            case 'back':
              return null;
          }
          return undefined;
        })();
        return { result: { value } };
      }
    }
    return {};
  }
}

let env: BrowserEnv;
let ext: FakeExtension;
let bridge: ExtensionBridgeService;
let audit: AuditRecord[];
const settings: Record<string, unknown> = {};
const defaults: Record<string, unknown> = {
  'browser.extensionBridge': true,
  'browser.extensionBridgeAllSites': true,
  'browser.localFallback': true,
};

function insertDevice(id: string, account = ACCOUNT): void {
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status,
         created_at, updated_at) VALUES (?, ?, 'Laptop', 'client', ?, 'k', '["client"]', 'active', ?, ?)`,
    )
    .run(id, account, `fp-${id}`, now, now);
}

const dev = { id: DEVICE, accountId: ACCOUNT };
const refusals = () =>
  audit
    .filter((a) => a.action === 'browser.bridge.refused')
    .map((a) => (a.detail as { reason: string }).reason);

beforeEach(async () => {
  env = await makeBrowserEnv({ computerFor: () => Promise.resolve('comp-1') });
  for (const k of Object.keys(settings)) delete settings[k];
  insertDevice(DEVICE);
  insertDevice(OTHER_DEVICE);
  ext = new FakeExtension();
  audit = [];
  bridge = new ExtensionBridgeService({
    db: env.db,
    events: env.events,
    setting: (key) => Promise.resolve((settings[key] ?? defaults[key]) as never),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    caller: ext,
  });
});

afterEach(async () => {
  await env.close();
});

describe('status and consents from events', () => {
  it('follows connected, shared tabs and disconnects', async () => {
    expect(await bridge.status(ACCOUNT, DEVICE)).toMatchObject({
      connected: false,
      tabs: [],
      enabled: true,
    });
    await bridge.applyEvents(dev, [
      { kind: 'connected', extensionVersion: '0.7.5', browser: 'Chromium 140' },
      { kind: 'tab.shared', tabId: 7, host: 'GitHub.com', title: 'Pulls' },
      { kind: 'tab.shared', tabId: 8, host: null },
    ]);
    const st = await bridge.status(ACCOUNT, DEVICE);
    expect(st).toMatchObject({
      connected: true,
      extensionVersion: '0.7.5',
      browser: 'Chromium 140',
    });
    // Hosts only: the address may carry tokens.
    expect(st.tabs).toEqual([
      expect.objectContaining({ tabId: 7, host: 'github.com', origin: 'shared', title: 'Pulls' }),
      expect.objectContaining({ tabId: 8, host: null }),
    ]);
    expect(bridge.sharedTab(ACCOUNT, DEVICE, 'github.com')?.tabId).toBe(7);
    expect(bridge.sharedTab(ACCOUNT, DEVICE, 'gitlab.com')).toBeNull();
    await bridge.applyEvents(dev, [
      { kind: 'tab.unshared', tabId: 7 },
      { kind: 'tab.closed', tabId: 8 },
    ]);
    expect((await bridge.status(ACCOUNT, DEVICE)).tabs).toEqual([]);
    let gone = 0;
    bridge.onDisconnected(() => gone++);
    await bridge.applyEvents(dev, [
      { kind: 'tab.shared', tabId: 9, host: 'a.example' },
      { kind: 'disconnected' },
    ]);
    expect(await bridge.status(ACCOUNT, DEVICE)).toMatchObject({ connected: false, tabs: [] });
    expect(gone).toBe(1);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'browser.bridge.connected',
        'browser.bridge.tab.shared',
        'browser.bridge.disconnected',
      ]),
    );
    expect(env.events.names()).toContain('browser.bridge.changed');
    // Another account sees nothing of this device.
    await expect(bridge.status('someone-else', DEVICE)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('per-host grants', () => {
  it('needs the owner: a host the browser reported stays pending until confirmed', async () => {
    await bridge.applyEvents(dev, [{ kind: 'host.granted', host: 'github.com' }]);
    const [pending] = bridge.grants(ACCOUNT, DEVICE);
    expect(pending).toMatchObject({
      host: 'github.com',
      state: 'pending',
      browserPermission: true,
      confirmedAt: null,
    });
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'github.com')).toEqual({
      ok: false,
      reason: 'host_not_granted',
    });
    const confirmed = await bridge.confirmGrant(ACCOUNT, pending!.id, {}, 'owner');
    expect(confirmed).toMatchObject({ id: pending!.id, state: 'active', confirmedBy: 'owner' });
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'www.github.com')).toMatchObject({ ok: true });
    // The browser withdrew its permission: noted; the Hub's grant is the owner's to revoke.
    await bridge.applyEvents(dev, [{ kind: 'host.revoked', host: 'github.com' }]);
    expect(bridge.grants(ACCOUNT, DEVICE)[0]).toMatchObject({
      browserPermission: false,
      state: 'active',
    });
    await bridge.revokeGrant(ACCOUNT, pending!.id, 'owner');
    await bridge.revokeGrant(ACCOUNT, pending!.id, 'owner');
    expect(bridge.grants(ACCOUNT, DEVICE)).toEqual([]);
    expect(bridge.grants(ACCOUNT, DEVICE, true)[0]).toMatchObject({
      state: 'revoked',
      revokedBy: 'owner',
    });
    expect(audit.find((a) => a.action === 'browser.bridge.grant.revoked')).toMatchObject({
      actor: 'user',
      detail: expect.objectContaining({ before: { state: 'active' }, after: { state: 'revoked' } }),
    });
    await expect(bridge.revokeGrant(ACCOUNT, 'nope', 'owner')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(bridge.confirmGrant(ACCOUNT, pending!.id, {}, 'owner')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('keeps "all sites" separate: its own acknowledgement, and policy can turn it off', async () => {
    await bridge.applyEvents(dev, [{ kind: 'host.granted', host: '*' }]);
    const [pending] = bridge.grants(ACCOUNT, DEVICE);
    expect(pending).toMatchObject({ host: '*', allSites: true, state: 'pending' });
    await expect(bridge.confirmGrant(ACCOUNT, pending!.id, {}, 'owner')).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'elevated_ack_required' },
    });
    await bridge.confirmGrant(ACCOUNT, pending!.id, { acknowledgeElevatedRisk: true }, 'owner');
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'anything.example')).toMatchObject({
      ok: true,
    });
    expect(audit.find((a) => a.action === 'browser.bridge.grant.all_sites')).toMatchObject({
      detail: expect.objectContaining({ elevated: true }),
    });
    settings['browser.extensionBridgeAllSites'] = false;
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'anything.example')).toEqual({
      ok: false,
      reason: 'all_sites_disabled',
    });
    await expect(
      bridge.createGrant(
        ACCOUNT,
        OTHER_DEVICE,
        { kind: 'all_sites', confirm: true, acknowledgeElevatedRisk: true },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'all_sites_disabled' } });
  });

  it('refuses everything while the managed switch is off', async () => {
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'github.com', confirm: true },
      'owner',
    );
    settings['browser.extensionBridge'] = false;
    await expect(
      bridge.createGrant(
        ACCOUNT,
        DEVICE,
        { kind: 'host', host: 'gitlab.com', confirm: true },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'bridge_disabled' } });
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'github.com')).toEqual({
      ok: false,
      reason: 'bridge_disabled',
    });
    await expect(bridge.call(ACCOUNT, DEVICE, 'tabs.list', {})).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(refusals()).toEqual(['bridge_disabled']);
    expect(ext.calls).toEqual([]);
  });

  it('grants once per host, and forgets a device with its grants', async () => {
    const a = await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'GitHub.com', confirm: true },
      'owner',
    );
    const b = await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'github.com', confirm: true },
      'owner',
    );
    expect(b.id).toBe(a.id);
    expect(a.host).toBe('github.com');
    await bridge.applyEvents(dev, [{ kind: 'connected' }]);
    await bridge.forgetDevice(ACCOUNT, DEVICE);
    expect(bridge.grants(ACCOUNT, DEVICE)).toEqual([]);
    expect(bridge.connected(ACCOUNT, DEVICE)).toBe(false);
    expect(() => bridge.grants('someone-else', DEVICE)).toThrow();
  });
});

describe('calls', () => {
  beforeEach(async () => {
    await bridge.applyEvents(dev, [
      { kind: 'connected' },
      { kind: 'tab.shared', tabId: 7, host: 'github.com' },
    ]);
    ext.move(7, 'https://github.com/');
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'github.com', confirm: true },
      'owner',
    );
  });

  it('checks the tab, the host and the protocol method before anything leaves', async () => {
    const send = (
      tabId: number,
      method: string,
      expectHost: string | null = 'github.com',
      params: Record<string, unknown> = { script: 'href' },
      opts: { site?: string } = {},
    ) => bridge.call(ACCOUNT, DEVICE, 'cdp.send', { tabId, method, params, expectHost }, opts);
    const reasons: [Promise<unknown>, string][] = [
      [send(99, 'Runtime.evaluate'), 'tab_not_shared'],
      [send(7, 'Network.getAllCookies'), 'cdp_method_not_allowed'],
      [send(7, 'Storage.getCookies'), 'cdp_method_not_allowed'],
      [send(7, 'Runtime.evaluate', 'gitlab.com'), 'host_not_granted'],
      // Page code is never sent: only the extension's own scripts, by name.
      [
        send(7, 'Runtime.evaluate', 'github.com', { expression: 'document.cookie' }),
        'script_not_allowed',
      ],
      [send(7, 'Runtime.evaluate', 'github.com', { script: 'cookies' }), 'script_not_allowed'],
      // No shortcut keys in the user's browser (paste, copy, cut).
      [
        send(7, 'Input.dispatchKeyEvent', 'github.com', {
          type: 'rawKeyDown',
          key: 'v',
          modifiers: 2,
        }),
        'modifier_not_allowed',
      ],
      [
        send(7, 'Input.dispatchKeyEvent', 'github.com', { type: 'keyDown', commands: ['paste'] }),
        'modifier_not_allowed',
      ],
      [
        send(7, 'Input.dispatchMouseEvent', 'github.com', { type: 'mousePressed', modifiers: 4 }),
        'modifier_not_allowed',
      ],
      // The call must say which host the tab is on; about:blank (null) is checked against the
      // site the caller acts for, and never skips the grant.
      [send(7, 'Runtime.evaluate', ''), 'host_unknown'],
      [send(7, 'Runtime.evaluate', null), 'host_unknown'],
      [
        send(7, 'Runtime.evaluate', null, { script: 'href' }, { site: 'gitlab.com' }),
        'host_not_granted',
      ],
      [send(7, 'Page.navigate', 'github.com', { url: 'https://gitlab.com/' }), 'host_not_granted'],
    ];
    for (const [p, reason] of reasons)
      await expect(p).rejects.toMatchObject({ details: { reason } });
    expect(ext.calls).toEqual([]);
    await send(7, 'Runtime.evaluate');
    await send(7, 'Runtime.evaluate', null, { script: 'href' }, { site: 'github.com' }).catch(
      () => null,
    );
    await send(7, 'Input.dispatchKeyEvent', 'github.com', {
      type: 'keyDown',
      key: 'A',
      modifiers: 8,
    });
    expect(ext.calls.filter((c) => c.method === 'cdp.send')).toHaveLength(3);
    expect(ext.calls.every((c) => 'expectHost' in c.params)).toBe(true);
    // The checks run side by side: the same refusals, in any order.
    expect([...refusals()].sort()).toEqual(reasons.map(([, r]) => r).sort());
  });

  it('never grants the Hub’s own hosts, all sites included', async () => {
    bridge.useHubHosts(() =>
      Promise.resolve(['nova-hub.local', '192.168.1.10', 'relay.nova.example']),
    );
    await expect(
      bridge.createGrant(
        ACCOUNT,
        DEVICE,
        { kind: 'host', host: 'nova-hub.local', confirm: true },
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'policy_denied', details: { reason: 'hub_host' } });
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'all_sites', confirm: true, acknowledgeElevatedRisk: true },
      'owner',
    );
    for (const host of [
      'nova-hub.local',
      '192.168.1.10',
      'relay.nova.example',
      'a.relay.nova.example',
      'localhost',
      '127.0.0.1',
    ])
      expect(await bridge.hostAllowed(ACCOUNT, DEVICE, host)).toEqual({
        ok: false,
        reason: 'hub_host',
      });
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'example.org')).toMatchObject({ ok: true });
    // Without the list nothing can be told apart from the Hub: refused.
    bridge.useHubHosts(() => Promise.reject(new Error('no network area')));
    expect(await bridge.hostAllowed(ACCOUNT, DEVICE, 'example.org')).toEqual({
      ok: false,
      reason: 'hub_host',
    });
  });

  it('treats a second connected, or another OS user, as a disconnect (review #3)', async () => {
    let stops = 0;
    bridge.onDisconnected(() => stops++);
    await bridge.applyEvents(dev, [
      { kind: 'connected', user: 'alice' },
      { kind: 'tab.shared', tabId: 7, host: 'github.com' },
    ]);
    expect(stops).toBe(1);
    expect((await bridge.status(ACCOUNT, DEVICE)).tabs[0]).toMatchObject({
      tabId: 7,
      user: 'alice',
    });
    // Bob's host replaces Alice's (novad reports no disconnect for a replaced host).
    await bridge.applyEvents(dev, [{ kind: 'connected', user: 'bob' }]);
    expect(stops).toBe(2);
    expect(bridge.tabConsented(ACCOUNT, DEVICE, 7)).toBe(false);
    await expect(
      bridge.call(ACCOUNT, DEVICE, 'cdp.send', {
        tabId: 7,
        method: 'Input.insertText',
        params: { text: 'secret' },
        expectHost: 'github.com',
      }),
    ).rejects.toMatchObject({ details: { reason: 'tab_not_shared' } });
    // Bob shares the same tab number: a caller pinned to Alice's browser is refused.
    await bridge.applyEvents(dev, [{ kind: 'tab.shared', tabId: 7, host: 'github.com' }]);
    await expect(
      bridge.call(
        ACCOUNT,
        DEVICE,
        'cdp.send',
        {
          tabId: 7,
          method: 'Input.insertText',
          params: { text: 'secret' },
          expectHost: 'github.com',
        },
        { user: 'alice' },
      ),
    ).rejects.toMatchObject({ details: { reason: 'user_changed' } });
    expect(ext.calls.filter((c) => c.method === 'cdp.send')).toEqual([]);
    expect(audit.filter((a) => a.action === 'browser.bridge.replaced').at(-1)).toMatchObject({
      detail: { before: { user: 'alice' }, after: { user: 'bob' } },
    });
  });

  it('opens agent tabs in the group as consented tabs, and passes the extension refusals on', async () => {
    await expect(
      bridge.call(ACCOUNT, DEVICE, 'tabs.open', { url: 'about:blank' }, { site: 'gitlab.com' }),
    ).rejects.toMatchObject({
      details: { reason: 'host_not_granted' },
    });
    const r = (await bridge.call(
      ACCOUNT,
      DEVICE,
      'tabs.open',
      { url: 'about:blank', group: 'Nova' },
      { site: 'github.com' },
    )) as { tabId: number };
    expect(bridge.tabConsented(ACCOUNT, DEVICE, r.tabId)).toBe(true);
    expect(
      (await bridge.status(ACCOUNT, DEVICE)).tabs.find((t) => t.tabId === r.tabId),
    ).toMatchObject({ origin: 'agent' });
    ext.refuse = 'the browser did not permit github.com';
    await expect(
      bridge.call(ACCOUNT, DEVICE, 'tab.attach', { tabId: r.tabId }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'extension_refused' },
    });
    const bare = new ExtensionBridgeService({
      db: env.db,
      events: env.events,
      setting: () => Promise.resolve(true as never),
    });
    await expect(bare.call(ACCOUNT, DEVICE, 'tabs.list', {})).rejects.toMatchObject({
      details: { reason: 'not_wired' },
    });
  });

  it('searches history only through the extension, which asks each time', async () => {
    ext.history = {
      items: [{ title: 'Nova PR', host: 'GitHub.com', lastVisit: '2026-10-01T00:00:00Z' }, 'junk'],
    };
    const out = await bridge.historySearch(ACCOUNT, DEVICE, '  nova  ');
    expect(out.items).toEqual([
      { title: 'Nova PR', host: 'github.com', lastVisit: '2026-10-01T00:00:00Z' },
    ]);
    expect(ext.calls.at(-1)).toMatchObject({
      method: 'history.search',
      params: { query: 'nova', maxResults: 20 },
      timeoutMs: BRIDGE_HISTORY_TIMEOUT_MS,
    });
    expect(audit.find((a) => a.action === 'browser.bridge.history.search')).toMatchObject({
      resource: `device:${DEVICE}`,
      detail: { deviceId: DEVICE, queryLength: 4 },
    });
    expect(JSON.stringify(audit)).not.toContain('nova pull');
    await expect(bridge.historySearch(ACCOUNT, DEVICE, '   ')).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('a tab of the user’s browser as the agent browser', () => {
  beforeEach(async () => {
    await env.service.sites.put(ACCOUNT, {
      pattern: 'github.com',
      access: 'allow',
      level: 'always_allow',
    });
    await bridge.applyEvents(dev, [{ kind: 'connected' }]);
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'github.com', confirm: true },
      'owner',
    );
    ext.pages.set('https://github.com/', {
      title: 'GitHub',
      text: 'Your repositories',
      elements: [
        { ref: 'e1', role: 'link', name: 'Elsewhere', tag: 'a', href: 'https://evil.example/' },
        { ref: 'e2', role: 'textbox', name: 'Search', tag: 'input' },
      ],
      next: 'https://evil.example/',
    });
    // Block page on the agent's own browser: the fallback offers the user's own browser.
    env.driver.pages.set('https://github.com/', {
      title: 'Access Denied',
      text: 'You have been blocked',
      elements: [],
      status: 403,
    });
    const fallback = new LocalFallbackService({
      db: env.db,
      events: env.events,
      setting: (key) => Promise.resolve((settings[key] ?? defaults[key]) as never),
      audit: { append: (r) => (audit.push(r), Promise.resolve()) },
      requests: {
        ask: (input: AskInput): Promise<AskResult> =>
          Promise.resolve({
            status: 'resolved',
            result: { choice: (input.payload as { choices: string[] }).choices[1] },
            by: 'owner',
          }),
      },
      resolver: {
        target: () =>
          Promise.resolve({
            ok: true,
            scope: { kind: 'agent', ref: 'agent-1' },
            deviceId: DEVICE,
            deviceName: 'Laptop',
          }),
      },
      deviceDriver: () => env.driver,
      bridge,
    });
    env.service.useLocalFallback(fallback);
  });

  it('opens a Nova tab, navigates and reads through cdp.send, and never reads cookies', async () => {
    const r = await env.service.navigate(env.call(), 'https://github.com/');
    expect(r.ok && (r.content[0] as { text: string }).text).toContain(
      'your own browser on Laptop (extension)',
    );
    expect(ext.calls.slice(0, 2)).toMatchObject([
      { method: 'tabs.open', params: { url: 'about:blank', group: 'Nova' } },
      { method: 'tab.attach', params: { tabId: 40 } },
    ]);
    expect(ext.calls.some((c) => c.params.method === 'Page.navigate')).toBe(true);
    const read = await env.service.read(env.call());
    expect(read.ok && (read.content[0] as { text: string }).text).toContain('Your repositories');
    const typed = await env.service.write(env.call(), { kind: 'type', ref: 'e2', text: 'nova' });
    expect(typed.ok).toBe(true);
    expect(
      ext.calls.some(
        (c) =>
          c.params.method === 'Input.insertText' &&
          (c.params.params as { text: string }).text === 'nova',
      ),
    ).toBe(true);
    const shot = await env.service.screenshot(env.call(), false);
    expect(shot.ok).toBe(true);
    // Only the allowed protocol methods ever left, and never a cookie or storage read.
    const methods = new Set(
      ext.calls.filter((c) => c.method === 'cdp.send').map((c) => c.params.method),
    );
    expect(
      [...methods].every((m) =>
        [
          'Runtime.evaluate',
          'Input.dispatchMouseEvent',
          'Input.dispatchKeyEvent',
          'Input.insertText',
          'Page.navigate',
          'Page.captureScreenshot',
        ].includes(String(m)),
      ),
    ).toBe(true);
    expect(JSON.stringify(ext.calls)).not.toMatch(/cookie/i);
    // Developer-protocol scripts are not available in the user's browser.
    const s = env.service.session(ACCOUNT, 'comp-1')!;
    await expect(s.driver.evaluate('document.cookie', 1_000)).rejects.toThrow(/not available/);
    expect(await s.driver.cookies()).toEqual([]);
    expect(await s.driver.storageState()).toEqual({ cookies: [], origins: [] });
    await expect(s.driver.download('e1', 1_000)).rejects.toThrow(/not available/);
    await expect(s.driver.input({ kind: 'key', key: 'Enter' })).rejects.toThrow();
  });

  it('stops acting when the tab leaves the granted sites, and detaches on close', async () => {
    const reads = () =>
      ext.calls.filter(
        (c) =>
          c.method === 'cdp.send' && (c.params.params as { script?: string }).script === 'read',
      ).length;
    await env.service.navigate(env.call(), 'https://github.com/');
    await env.service.read(env.call());
    const before = reads();
    // The link leads to a site that is neither allowed nor granted.
    await env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    const after = await env.service.read(env.call());
    expect(after).toMatchObject({ ok: false });
    expect(reads()).toBe(before);
    await env.service.closeSession(ACCOUNT, 'comp-1');
    expect(ext.calls.at(-1)).toMatchObject({ method: 'tab.detach', params: { tabId: 40 } });
  });

  it('uses a tab the user shared on the site instead of opening one', async () => {
    ext.move(7, 'https://github.com/');
    await bridge.applyEvents(dev, [{ kind: 'tab.shared', tabId: 7, host: 'github.com' }]);
    const r = await env.service.navigate(env.call(), 'https://github.com/');
    expect(r.ok).toBe(true);
    expect(ext.calls.some((c) => c.method === 'tabs.open')).toBe(false);
    expect(ext.calls[0]).toMatchObject({ method: 'tab.attach', params: { tabId: 7 } });
  });
});

describe('the tab driver, action by action', () => {
  const opts = (allow = (u: string) => u.startsWith('https://github.com/')) => {
    const blocked: string[] = [];
    const navigated: string[] = [];
    return {
      blocked,
      navigated,
      o: {
        allowNavigation: allow,
        onBlockedNavigation: (u: string) => blocked.push(u),
        onNavigated: (u: string) => navigated.push(u),
      } as unknown as DriverLaunchOptions,
    };
  };
  const sent = (method: string) =>
    ext.calls.filter((c) => c.method === 'cdp.send' && c.params.method === method);

  beforeEach(async () => {
    await bridge.applyEvents(dev, [{ kind: 'connected' }]);
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'github.com', confirm: true },
      'owner',
    );
    ext.pages.set('https://github.com/', {
      title: 'GitHub',
      text: 'Your repositories',
      elements: [
        { ref: 'e1', role: 'link', name: 'Repo', tag: 'a' },
        { ref: 'e2', role: 'combobox', name: 'Size', tag: 'select' },
      ],
    });
  });

  it('acts through the protocol: keys, choices, pointer, waiting, screenshots', async () => {
    const driver = bridge.tabDriver({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      site: 'github.com',
    });
    expect(await driver.probe(null)).toMatchObject({ ok: true });
    const { o, navigated } = opts();
    const s = await driver.launch(o);
    expect(await s.goto('https://github.com/', 2_000)).toEqual({ status: 200 });
    expect(navigated).toEqual([]);
    expect(s.url()).toBe('https://github.com/');
    expect((await s.snapshot(1_000)).elements).toHaveLength(2);
    expect(await s.describe('e1')).toMatchObject({ name: 'Repo' });
    expect(await s.describe('bad')).toBeNull();
    await s.hover('e1', 1_000);
    expect(sent('Input.dispatchMouseEvent').at(-1)?.params.params).toMatchObject({
      type: 'mouseMoved',
      x: 10,
      y: 20,
    });
    // Shift is typing; Control, Alt and Meta make shortcuts (the clipboard): refused.
    await s.press('Shift+a', 1_000);
    expect(sent('Input.dispatchKeyEvent').at(-2)?.params.params).toMatchObject({
      type: 'keyDown',
      key: 'A',
      modifiers: 8,
    });
    const before = sent('Input.dispatchKeyEvent').length;
    for (const k of ['Control+v', 'Ctrl+c', 'Meta+v', 'Alt+x', 'Control+Shift+v'])
      await expect(s.press(k, 1_000)).rejects.toThrow('not available in your own browser');
    expect(sent('Input.dispatchKeyEvent')).toHaveLength(before);
    await s.press('Enter', 1_000);
    expect(sent('Input.dispatchKeyEvent').at(-2)?.params.params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      text: '\r',
    });
    await s.press('7', 1_000);
    await expect(s.press('Hyper+x', 1_000)).rejects.toThrow('not a key name');
    await expect(s.press('F13', 1_000)).rejects.toThrow('not a key name');
    await expect(s.press('a;b', 1_000)).rejects.toThrow('not a key name');
    await s.select('e2', 'Large', 1_000);
    await expect(s.select('e2', 'Huge', 1_000)).rejects.toThrow('not an option');
    await s.fill('e1', '', 1_000);
    expect(sent('Input.dispatchKeyEvent').at(-2)?.params.params).toMatchObject({
      key: 'Backspace',
    });
    await s.scroll('up', 300);
    expect(sent('Input.dispatchMouseEvent').at(-1)?.params.params).toMatchObject({
      type: 'mouseWheel',
      deltaY: -300,
    });
    expect(await s.waitFor('load', undefined, 1_000)).toBe(true);
    expect(await s.waitFor('text', 'repositories', 1_000)).toBe(true);
    expect(await s.waitFor('text', 'absent words', 10)).toBe(false);
    await s.back(1_000);
    expect((await s.screenshotElement('e1')).length).toBeGreaterThan(0);
    expect((await s.screenshot(true)).length).toBeGreaterThan(0);
    expect(sent('Page.captureScreenshot').at(-1)?.params.params).toMatchObject({
      captureBeyondViewport: true,
    });
    expect(await s.focusedSecret()).toBe(false);
    ext.secretField = true;
    expect(await s.focusedSecret()).toBe(true);
    await expect(s.upload('e1', [])).rejects.toThrow('not available');
    await expect(s.callPageTool('x', {}, 1_000)).rejects.toThrow('not available');
    expect(await s.recover()).toBe(false);
    expect(await s.crashState()).toBeNull();
    for (const bad of ['x1', 'e1"]'])
      for (const f of [
        () => s.click(bad, 1),
        () => s.hover(bad, 1),
        () => s.fill(bad, 'a', 1),
        () => s.select(bad, 'a', 1),
        () => s.screenshotElement(bad),
      ])
        await expect(f()).rejects.toThrow('not an element ref');
    await s.close();
    await s.close();
    expect(ext.calls.filter((c) => c.method === 'tab.detach')).toHaveLength(1);
    await expect(s.snapshot(10)).rejects.toThrow('no longer controlled');
  });

  it('refuses navigations the guards or the grant do not allow, and pages that fail', async () => {
    const driver = bridge.tabDriver({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      site: 'github.com',
    });
    const { o, blocked } = opts();
    const s = await driver.launch(o);
    await expect(s.goto('https://evil.example/', 1_000)).rejects.toThrow('navigation refused');
    expect(blocked).toEqual(['https://evil.example/']);
    ext.navigateError = 'net::ERR_NAME_NOT_RESOLVED';
    await expect(s.goto('https://github.com/', 1_000)).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    ext.navigateError = null;
    // The tab was closed by the user: the session says so, as a crash the controller sees.
    ext.failNext = 'No tab with id: 40.';
    await expect(s.goto('https://github.com/', 1_000)).rejects.toThrow();
    expect(await s.crashState()).toBe('the tab was closed');
    await expect(s.snapshot(10)).rejects.toThrow('the tab was closed');
  });

  it('never reads a page the tab moved to after the driver last looked (review #1)', async () => {
    // The browser also allows mail.example (the user shared a tab there once); the Hub grant for
    // it is only pending.
    await bridge.applyEvents(dev, [{ kind: 'host.granted', host: 'mail.example' }]);
    expect((await bridge.hostAllowed(ACCOUNT, DEVICE, 'mail.example')).ok).toBe(false);
    ext.pages.set('https://mail.example/inbox', {
      title: 'Inbox',
      text: 'PRIVATE MAIL',
      elements: [],
    });
    const driver = bridge.tabDriver({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      site: 'github.com',
    });
    const s = await driver.launch(opts(() => true).o);
    await s.goto('https://github.com/', 1_000);
    // A delayed redirect (or the user) moves the tab; the driver has not looked since.
    ext.move(40, 'https://mail.example/inbox');
    await expect(s.snapshot(1_000)).rejects.toThrow();
    // Every command named the host its grant was checked for; the extension refused it.
    const lastRead = sent('Runtime.evaluate').filter(
      (c) => (c.params.params as { script: string }).script === 'read',
    );
    expect(lastRead.map((c) => c.params.expectHost)).toEqual(['github.com']);
    expect(JSON.stringify(ext.calls)).not.toContain('PRIVATE MAIL');
    // Until the tab is back on a usable site, nothing more is sent.
    const n = ext.calls.length;
    await expect(s.snapshot(1_000)).rejects.toThrow('left the sites');
    expect(ext.calls.length).toBe(n);
    // Navigating back is allowed, from where the tab really is.
    await s.goto('https://github.com/', 1_000);
    expect(sent('Page.navigate').at(-1)?.params.expectHost).toBe('mail.example');
    expect((await s.snapshot(1_000)).text).toBe('Your repositories');
  });

  it('waits for a navigation to commit before it looks, and follows only granted sites', async () => {
    await bridge.createGrant(
      ACCOUNT,
      DEVICE,
      { kind: 'host', host: 'docs.github.com', confirm: true },
      'owner',
    );
    ext.pages.set('https://github.com/', {
      title: 'GitHub',
      text: 'Your repositories',
      elements: [{ ref: 'e1', role: 'link', name: 'Docs', tag: 'a' }],
      next: 'https://docs.github.com/',
    });
    ext.pages.set('https://docs.github.com/', { title: 'Docs', text: 'The docs', elements: [] });
    const driver = bridge.tabDriver({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      site: 'github.com',
    });
    const { o, navigated } = opts((u) => /^https:\/\/(docs\.)?github\.com\//.test(u));
    const s = await driver.launch(o);
    await s.goto('https://github.com/', 1_000);
    // The click starts a navigation that commits only after a few polls.
    ext.clickPendingPolls = 3;
    await s.click('e1', 1_000);
    expect(s.url()).toBe('https://docs.github.com/');
    expect(navigated).toEqual(['https://docs.github.com/']);
    expect((await s.snapshot(1_000)).text).toBe('The docs');
    // No page script ran while the navigation was pending (it would have been refused anyway).
    expect(
      sent('Runtime.evaluate').some(
        (c) =>
          c.params.expectHost === 'github.com' &&
          (c.params.params as { script: string }).script === 'href' &&
          ext.calls.indexOf(c) >
            ext.calls.findIndex(
              (x) =>
                x.params.method === 'Input.dispatchMouseEvent' &&
                (x.params.params as { type: string }).type === 'mouseReleased',
            ),
      ),
    ).toBe(false);
  });

  it('refuses a shared tab that is no longer on a usable site, and reports a disconnected bridge', async () => {
    ext.move(7, 'https://evil.example/');
    await bridge.applyEvents(dev, [{ kind: 'tab.shared', tabId: 7, host: 'github.com' }]);
    const driver = bridge.tabDriver({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      site: 'github.com',
    });
    await expect(driver.launch(opts().o)).rejects.toThrow('no longer on a site');
    // A page that is not a web site has no host: the session stays on nothing of it.
    ext.move(7, 'chrome://settings/');
    await expect(driver.launch(opts().o)).rejects.toThrow();
    await bridge.applyEvents(dev, [{ kind: 'disconnected' }]);
    expect(await driver.probe(null)).toMatchObject({ ok: false });
  });
});

describe('browser.history_search', () => {
  const ctx = (threadId: string | null) =>
    ({ accountId: ACCOUNT, threadId, turnId: 't', callId: 'c' }) as unknown as Parameters<
      Awaited<ReturnType<ReturnType<typeof bridgeToolSource>['list']>>[number]['handler']
    >[1];

  it('is listed only for an agent whose computer has the bridge, and asks through it', async () => {
    let device: string | null = DEVICE;
    const source = bridgeToolSource({
      bridge,
      deviceForThread: () => Promise.resolve(device),
      setting: (key) => Promise.resolve((settings[key] ?? defaults[key]) as boolean),
    });
    const names = async (mode: 'agent' | 'chat', threadId: string | null = 't1') =>
      (await source.list(ACCOUNT, { mode, threadId })).map((t) => t.descriptor.name);
    expect(await names('agent')).toEqual([]);
    await bridge.applyEvents(dev, [{ kind: 'connected' }]);
    expect(await names('agent')).toEqual([BRIDGE_HISTORY_TOOL]);
    expect(await names('chat')).toEqual([]);
    expect(await names('agent', null)).toEqual([]);
    expect((await source.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual([
      BRIDGE_HISTORY_TOOL,
    ]);
    const [tool] = await source.list(ACCOUNT, { mode: 'agent', threadId: 't1' });
    ext.history = { items: [{ title: 'Nova PR', host: 'github.com' }] };
    const r = await tool!.handler({ query: 'nova' }, ctx('t1'));
    expect(r.ok && (r.content[0] as { text: string }).text).toContain('"Nova PR" (github.com)');
    expect(ext.calls.at(-1)).toMatchObject({ method: 'history.search', params: { query: 'nova' } });
    ext.history = { items: [] };
    const none = await tool!.handler({ query: 'x' }, ctx('t1'));
    expect(none.ok && (none.content[0] as { text: string }).text).toContain('No pages');
    ext.refuse = 'the user did not allow this search';
    expect(await tool!.handler({ query: 'x' }, ctx('t1'))).toMatchObject({
      ok: false,
      error: { code: 'denied' },
    });
    device = null;
    expect(await tool!.handler({ query: 'x' }, ctx('t1'))).toMatchObject({
      ok: false,
      error: { code: 'not_available' },
    });
    expect(await tool!.handler({ query: 'x' }, ctx(null))).toMatchObject({ ok: false });
    settings['browser.extensionBridge'] = false;
    device = DEVICE;
    expect(await names('agent')).toEqual([]);
  });
});
