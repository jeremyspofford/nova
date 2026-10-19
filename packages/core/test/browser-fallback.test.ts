// The local browser fallback (FR-209, docs/11 §4.6; ADR-096 D7): a block page or a repeated
// challenge on the agent's own browser offers to continue on the agent's connected computer; the
// user's answer records a revocable consent per agent, device and site; the computer's browser
// then serves that site through the same controller, and the session and its trace rows are
// marked and audited. Refusals: no connected computer, no browser module, the switch off, no
// chat to ask in, declined, expired. The device's browser is a second fake driver here; the real
// launcher over a fake novad is in browser-fallback-device.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskInput, AskResult, RequestBroker } from '../src/index.ts';
import { requestPayload } from '../src/requests/validate.ts';
import {
  BROWSER_CHALLENGE_REPEATS,
  BrowserChallengeCounter,
  ExtensionBridgeService,
  LocalFallbackService,
  browserFallbackAllowHosts,
  connectedComputerResolver,
  detectBrowserBlock,
  type DeviceDriverFactory,
  type FallbackDeviceSource,
  type FallbackTargetResolver,
} from '../src/browser/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import { FakeDriver } from './browser-fake.ts';

const AGENT = 'agent-1';
const DEVICE = 'dev-laptop';
const COMPUTER = 'comp-1';

/** Answers every question with `answer` (a choice index, or a status), and keeps them. */
class Asker implements RequestBroker {
  readonly asked: AskInput[] = [];
  answer: number | 'expired' | 'cancelled' | 'throw' = 0;
  ask(input: AskInput): Promise<AskResult> {
    this.asked.push(input);
    if (this.answer === 'throw') return Promise.reject(new Error('no stream'));
    if (this.answer === 'expired' || this.answer === 'cancelled')
      return Promise.resolve({ status: this.answer });
    const choices = (input.payload as { choices: string[] }).choices;
    return Promise.resolve({
      status: 'resolved',
      result: { choice: choices[this.answer] },
      by: 'owner-user',
    });
  }
}

let env: BrowserEnv;
let device: FakeDriver;
let asker: Asker;
let fallback: LocalFallbackService;
let factoryCalls: Parameters<DeviceDriverFactory>[0][];
let target: Awaited<ReturnType<FallbackTargetResolver['target']>>;

function insertDevice(id = DEVICE, name = 'Laptop'): void {
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status,
         created_at, updated_at) VALUES (?, ?, ?, 'client', ?, 'k', '["client"]', 'active', ?, ?)`,
    )
    .run(id, ACCOUNT, name, `fp-${id}`, now, now);
}

const BLOCKED = {
  title: 'Access Denied',
  text: 'Access denied. You have been blocked by the site.',
  elements: [],
  status: 403,
};
const CHALLENGE = {
  title: 'Just a moment...',
  text: 'Checking your browser before accessing shop.example.',
  elements: [],
  frames: ['https://challenges.cloudflare.com/turnstile/v0'],
};
const SHOP = {
  title: 'Shop',
  text: 'Welcome to the shop',
  elements: [
    { role: 'link', tag: 'a', name: 'Cart', href: 'https://shop.example/cart' },
    {
      role: 'link',
      tag: 'a',
      name: 'Partner',
      href: 'https://other.example/',
      navigates: 'https://other.example/',
    },
  ],
};

beforeEach(async () => {
  env = await makeBrowserEnv({ computerFor: () => Promise.resolve(COMPUTER) });
  insertDevice();
  for (const pattern of ['shop.example', 'other.example'])
    await env.service.sites.put(ACCOUNT, { pattern, access: 'allow', level: 'always_allow' });
  env.driver.pages.set('https://shop.example/', BLOCKED);
  env.driver.pages.set('https://other.example/', { title: 'O', text: 'other', elements: [] });
  device = new FakeDriver();
  device.pages.set('https://shop.example/', SHOP);
  asker = new Asker();
  factoryCalls = [];
  target = {
    ok: true,
    scope: { kind: 'agent', ref: AGENT },
    deviceId: DEVICE,
    deviceName: 'Laptop',
  };
  fallback = new LocalFallbackService({
    db: env.db,
    events: env.events,
    setting: (key) => Promise.resolve((env.settings[key] ?? defaults[key]) as never),
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    requests: asker,
    resolver: { target: () => Promise.resolve(target) },
    deviceDriver: (input) => {
      factoryCalls.push(input);
      return device;
    },
  });
  env.service.useLocalFallback(fallback);
});

const defaults: Record<string, unknown> = {
  'browser.localFallback': true,
  'browser.extensionBridge': true,
  'browser.extensionBridgeAllSites': true,
};

afterEach(async () => {
  await env.close();
});

const actions = () =>
  env.db.raw
    .prepare(
      'SELECT id, tool, action, computer_id AS computerId FROM browser_action ORDER BY created_at, id',
    )
    .all() as { id: string; tool: string; action: string; computerId: string }[];
const auditActions = () => env.audit.map((a) => a.action);

describe('block pages and challenges', () => {
  it('tells block pages and challenges from ordinary pages', () => {
    expect(
      detectBrowserBlock({ status: 403, title: 'Access Denied', text: '', frames: [] }),
    ).toMatchObject({ kind: 'block' });
    expect(detectBrowserBlock({ status: 429, title: 'x', text: '', frames: [] })).toMatchObject({
      kind: 'block',
    });
    expect(
      detectBrowserBlock({ status: 200, title: 'Just a moment...', text: '', frames: [] }),
    ).toMatchObject({ kind: 'challenge' });
    expect(
      detectBrowserBlock({
        status: 200,
        title: 'x',
        text: '',
        frames: ['https://www.google.com/recaptcha/api2/anchor'],
      }),
    ).toMatchObject({ kind: 'challenge', reason: 'a CAPTCHA widget' });
    // A 403 that asks for a sign-in is not a block page; neither is an ordinary page.
    expect(
      detectBrowserBlock({
        status: 403,
        title: 'Sign in',
        text: 'Please sign in to continue',
        frames: [],
      }),
    ).toBeNull();
    expect(
      detectBrowserBlock({ status: 200, title: 'Shop', text: 'Welcome', frames: [] }),
    ).toBeNull();
    expect(
      detectBrowserBlock({
        status: 200,
        title: 'Help',
        text: 'Our login uses a captcha',
        frames: [],
      }),
    ).toMatchObject({ kind: 'challenge' });
  });

  it('counts a challenge as repeated only within the window', () => {
    let now = 0;
    const c = new BrowserChallengeCounter(() => now);
    const ch = { kind: 'challenge' as const, reason: 'x' };
    expect(c.note('a', ch)).toBe(false);
    now += 11 * 60_000;
    expect(c.note('a', ch)).toBe(false);
    for (let i = 1; i < BROWSER_CHALLENGE_REPEATS; i++) expect(c.note('a', ch)).toBe(true);
    c.reset('a');
    expect(c.note('a', ch)).toBe(false);
    expect(c.note('b', { kind: 'block', reason: 'y' })).toBe(true);
  });

  it('gives the device exactly the site and its subdomains, as novad takes them (#5, #6)', () => {
    expect(browserFallbackAllowHosts('Shop.Example.')).toEqual(['shop.example', '*.shop.example']);
    // Never a wildcard over a top-level domain, nothing novad would refuse.
    expect(browserFallbackAllowHosts('intranet')).toEqual(['intranet']);
    for (const bad of ['10.0.0.1', '[::1]', '*', '*.dev', 'a..b', '-x.example', 'x.123'])
      expect(browserFallbackAllowHosts(bad)).toEqual([]);
  });
});

describe('the consent and the session', () => {
  it('offers on a block page, records the consent and continues on the device, marked', async () => {
    const r = await env.service.navigate(env.call(), 'https://shop.example/');
    expect(r.ok).toBe(true);
    const text = r.ok ? (r.content[0] as { text: string }).text : '';
    expect(text).toContain('a clean profile on Laptop (local fallback, marked in the trace)');
    expect(text).toContain('Opened https://shop.example/');
    // The question went to the user, with the choices (no extension: no bridge here).
    expect(asker.asked).toHaveLength(1);
    expect(asker.asked[0]).toMatchObject({
      kind: 'user_input',
      correlation: { threadId: THREAD },
      payload: { choices: ['Continue on Laptop (clean profile)', 'Not now'] },
    });
    // The same offer, structured, for clients that show it their own way; a valid request.
    expect((asker.asked[0]!.payload as { context: unknown }).context).toEqual({
      kind: 'browser.fallback',
      site: 'shop.example',
      deviceId: DEVICE,
      deviceName: 'Laptop',
      cause: 'block_page',
      choices: [
        { id: 'clean', label: 'Continue on Laptop (clean profile)', profile: 'clean' },
        { id: 'decline', label: 'Not now', profile: null },
      ],
    });
    expect(() => requestPayload('user_input', asker.asked[0]!.payload)).not.toThrow();
    // The device's browser got the site and the allowed hosts; the Hub's browser closed.
    expect(factoryCalls[0]).toMatchObject({ deviceId: DEVICE, agentId: AGENT, threadId: THREAD });
    // Exactly what the user consented to: the site and its subdomains (#6).
    expect(factoryCalls[0]!.allowHosts).toEqual(['shop.example', '*.shop.example']);
    expect(device.current.url()).toBe('https://shop.example/');
    expect(env.driver.current.closed).toBe(true);
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toMatchObject({
      deviceId: DEVICE,
      profile: 'clean',
      site: 'shop.example',
    });
    const consents = fallback.consents(ACCOUNT);
    expect(consents).toEqual([
      expect.objectContaining({
        scopeKind: 'agent',
        scopeRef: AGENT,
        deviceId: DEVICE,
        deviceName: 'Laptop',
        site: 'shop.example',
        profile: 'clean',
        grantedBy: 'owner-user',
      }),
    ]);
    expect(auditActions()).toEqual(
      expect.arrayContaining([
        'browser.fallback.offered',
        'browser.fallback.consent.granted',
        'browser.fallback.started',
      ]),
    );
    // The trace: the start row and the device navigation are marked; the Hub's own row is not.
    const rows = actions();
    const marks = fallback.marks(
      ACCOUNT,
      rows.map((a) => a.id),
    );
    const start = rows.find((a) => a.action === 'local_fallback')!;
    expect(marks.get(start.id)).toMatchObject({ deviceId: DEVICE, profile: 'clean' });
    const navs = rows.filter((a) => a.tool === 'browser.navigate');
    expect(navs).toHaveLength(2);
    expect(marks.has(navs[0]!.id)).toBe(false);
    expect(marks.has(navs[1]!.id)).toBe(true);
    // Reads and actions now go to the device's browser through the same checks.
    const read = await env.service.read(env.call());
    expect(read.ok && (read.content[0] as { text: string }).text).toContain('Welcome to the shop');
    const [session] = fallback.sessions(ACCOUNT);
    expect(session).toMatchObject({ computerId: COMPUTER, cause: 'block_page', endedAt: null });
    expect(env.events.names()).toContain('browser.fallback.changed');
  });

  it('ends the session when the agent leaves the site, and reuses the consent next time', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    const other = await env.service.navigate(env.call(), 'https://other.example/');
    expect(other.ok).toBe(true);
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
    expect(device.current.closed).toBe(true);
    expect(env.driver.current.url()).toBe('https://other.example/');
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ endReason: 'left_site' });
    expect(actions().some((a) => a.action === 'local_fallback_end')).toBe(true);
    // The same site blocks again: no question, the consent is used.
    const again = await env.service.navigate(env.call(), 'https://shop.example/');
    expect(again.ok).toBe(true);
    expect(asker.asked).toHaveLength(1);
    expect(auditActions()).toContain('browser.fallback.consent.used');
    expect(
      env.audit.find(
        (a) =>
          a.action === 'browser.fallback.started' &&
          (a.detail as { consentReused: boolean }).consentReused,
      ),
    ).toBeTruthy();
  });

  it('stops the running session when the consent is revoked, and asks again later', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    const [consent] = fallback.consents(ACCOUNT);
    await fallback.revokeConsent(ACCOUNT, consent!.id, 'owner-user');
    await expect.poll(() => env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
    await expect.poll(() => fallback.sessions(ACCOUNT)[0]?.endReason).toBe('consent_revoked');
    expect(fallback.consents(ACCOUNT)).toEqual([]);
    expect(fallback.consents(ACCOUNT, { all: true })[0]).toMatchObject({ revokedBy: 'owner-user' });
    expect(env.audit.find((a) => a.action === 'browser.fallback.consent.revoked')).toMatchObject({
      actor: 'user',
      detail: expect.objectContaining({ before: expect.objectContaining({ revokedAt: null }) }),
    });
    // Revoking twice changes nothing; an unknown consent is not found.
    await fallback.revokeConsent(ACCOUNT, consent!.id, 'owner-user');
    await expect(fallback.revokeConsent(ACCOUNT, 'nope', 'u')).rejects.toMatchObject({
      code: 'not_found',
    });
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect(asker.asked).toHaveLength(2);
  });

  it('closes the fallback with the session and records the egress counts', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    factoryCalls[0]!.onClosed({ allowed: 7, refused: 2 });
    expect(await env.service.closeSession(ACCOUNT, COMPUTER)).toBe(true);
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({
      endReason: 'closed',
      egress: { allowed: 7, refused: 2 },
    });
    expect(auditActions()).toContain('browser.fallback.ended');
  });

  it('forgets a device: consents revoked and its session stopped', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    await fallback.forgetDevice(ACCOUNT, DEVICE);
    await expect.poll(() => env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
    expect(fallback.consents(ACCOUNT)).toEqual([]);
    expect(fallback.sessions(ACCOUNT)[0]?.endReason).toMatch(/consent_revoked|device_gone/);
  });

  it('ends when a click takes the page off the site (#6)', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    await env.service.read(env.call());
    const r = await env.service.write(env.call(), { kind: 'click', ref: 'e2' });
    expect(r.ok && (r.content[0] as { text: string }).text).toContain('local fallback ended');
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
    expect(device.current.closed).toBe(true);
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ endReason: 'left_site' });
  });

  it('turns downloads off in the device’s browser (#8)', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    await env.service.read(env.call());
    expect(await env.service.download(env.call(), 'e1', undefined)).toMatchObject({
      ok: false,
      error: { code: 'not_available' },
    });
  });

  it('stops running sessions when browser.localFallback is turned off', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    env.settings['browser.localFallback'] = false;
    // The next action ends the fallback and runs on the agent's own browser (a fresh one).
    const read = await env.service.read(env.call());
    expect(read).toMatchObject({ ok: false, error: { code: 'no_page' } });
    expect(device.current.closed).toBe(true);
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ endReason: 'disabled' });
    // The area's switch hook stops everything at once.
    env.settings['browser.localFallback'] = true;
    await env.service.navigate(env.call(), 'https://other.example/');
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).not.toBeNull();
    fallback.stopAll('disabled');
    await expect.poll(() => env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
  });

  it('ends the sessions a previous run left open (#7)', async () => {
    await env.service.navigate(env.call(), 'https://shop.example/');
    const restarted = new LocalFallbackService({
      db: env.db,
      events: env.events,
      setting: () => Promise.resolve(true as never),
    });
    expect(await restarted.recover()).toBe(1);
    expect(restarted.sessions(ACCOUNT)[0]).toMatchObject({ endReason: 'restarted' });
    expect(await restarted.recover()).toBe(0);
  });

  it('offers on a challenge only when it repeats, not when the same page is read', async () => {
    env.driver.pages.set('https://shop.example/', CHALLENGE);
    const first = await env.service.navigate(env.call(), 'https://shop.example/');
    expect(first.ok).toBe(true);
    await env.service.read(env.call());
    expect(asker.asked).toHaveLength(0);
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect(asker.asked).toHaveLength(1);
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ cause: 'repeated_challenge' });
  });

  it('asks once for two calls at the same time', async () => {
    const plan = (n: number) =>
      fallback.begin({
        accountId: ACCOUNT,
        threadId: THREAD,
        turnId: 't',
        callId: `c${n}`,
        computerId: COMPUTER,
        site: 'shop.example',
        url: 'https://shop.example/',
        cause: 'block_page',
        detail: 'x',
        allowHosts: ['shop.example'],
        signal: new AbortController().signal,
      });
    const [a, b] = await Promise.all([plan(1), plan(2)]);
    expect(asker.asked).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('starts nothing when the device browser cannot start, and says so', async () => {
    device.launchError = 'no browser on the device';
    const r = await env.service.navigate(env.call(), 'https://shop.example/');
    expect(r).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ endReason: 'error' });
    expect(auditActions()).toContain('browser.fallback.failed');
  });

  it('can be asked for on the current site (the UI), and refuses a second time', async () => {
    env.driver.pages.set('https://shop.example/', SHOP);
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect(asker.asked).toHaveLength(0);
    const r = await env.service.localFallback(env.call());
    expect(r.ok).toBe(true);
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({ cause: 'requested' });
    expect(await env.service.localFallback(env.call())).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });
});

describe('refusals', () => {
  const refusedWith = () =>
    env.audit
      .filter((a) => a.action === 'browser.fallback.refused')
      .map((a) => (a.detail as { reason: string }).reason);

  it('keeps the agent browser and explains when there is no connected computer', async () => {
    target = {
      ok: false,
      reason: 'no_connected_computer',
      message: 'This agent has no connected computer.',
    };
    const r = await env.service.navigate(env.call(), 'https://shop.example/');
    expect(r.ok).toBe(true);
    expect(r.ok && (r.content[0] as { text: string }).text).toContain(
      'This agent has no connected computer.',
    );
    expect(refusedWith()).toEqual(['no_connected_computer']);
    expect(asker.asked).toHaveLength(0);
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toBeNull();
  });

  it('never offers for a local or private-network site', async () => {
    env.settings['browser.allowLocalSites'] = true;
    await env.service.sites.put(ACCOUNT, {
      pattern: '192.168.1.1',
      access: 'allow',
      level: 'always_allow',
    });
    env.driver.pages.set('http://192.168.1.1/', BLOCKED);
    const r = await env.service.navigate(env.call(), 'http://192.168.1.1/');
    expect(r.ok).toBe(true);
    expect(asker.asked).toHaveLength(0);
    expect(refusedWith()).toEqual([]);
  });

  it('refuses when the switch is off, nobody can be asked, or the user says no', async () => {
    env.settings['browser.localFallback'] = false;
    await env.service.navigate(env.call(), 'https://shop.example/');
    env.settings['browser.localFallback'] = true;
    for (const a of ['expired', 'cancelled', 'throw', 1] as const) {
      asker.answer = a;
      await env.service.navigate(env.call(), 'https://shop.example/');
    }
    expect(refusedWith()).toEqual(['disabled', 'expired', 'cancelled', 'failed', 'declined']);
    expect(fallback.consents(ACCOUNT, { all: true })).toEqual([]);
  });

  it('needs a chat to ask in, the broker and the parts it runs on', async () => {
    const base = {
      accountId: ACCOUNT,
      turnId: null,
      callId: 'c',
      computerId: COMPUTER,
      site: 'shop.example',
      url: 'https://shop.example/',
      cause: 'requested' as const,
      detail: 'x',
      allowHosts: [],
      signal: new AbortController().signal,
    };
    expect(await fallback.begin({ ...base, threadId: null })).toMatchObject({
      ok: false,
      reason: 'no_thread',
    });
    const bare = new LocalFallbackService({
      db: env.db,
      events: env.events,
      setting: () => Promise.resolve(true as never),
    });
    expect(await bare.begin({ ...base, threadId: THREAD })).toMatchObject({
      ok: false,
      reason: 'not_available',
    });
    bare.useResolver({ target: () => Promise.reject(new Error('db down')) });
    bare.useDeviceDriver(() => device);
    expect(await bare.begin({ ...base, threadId: THREAD })).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    bare.useResolver({ target: () => Promise.resolve(target) });
    expect(await bare.begin({ ...base, threadId: THREAD })).toMatchObject({
      ok: false,
      reason: 'not_available',
    });
  });
});

describe('the user’s own browser as the fallback', () => {
  it('offers the extension only when the bridge can serve the site, and uses its tab', async () => {
    const bridge = new ExtensionBridgeService({
      db: env.db,
      events: env.events,
      setting: (key) => Promise.resolve((env.settings[key] ?? defaults[key]) as never),
    });
    const tabDriver = new FakeDriver();
    tabDriver.pages.set('https://shop.example/', SHOP);
    let usable = false;
    fallback.useBridge({
      usable: () => Promise.resolve(usable),
      tabDriver: () => tabDriver,
      user: () => 'jeremy',
    });
    asker.answer = 1;
    await env.service.navigate(env.call(), 'https://shop.example/');
    // Without the bridge the second choice is "Not now".
    expect((asker.asked[0]!.payload as { choices: string[] }).choices).toHaveLength(2);
    usable = true;
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect((asker.asked[1]!.payload as { choices: string[] }).choices[1]).toBe(
      'Continue in my own browser on Laptop (extension)',
    );
    expect(env.service.fallbackOf(ACCOUNT, COMPUTER)).toMatchObject({ profile: 'extension' });
    expect(tabDriver.current.url()).toBe('https://shop.example/');
    // The OS user whose browser it is, on the session (#3).
    expect(fallback.sessions(ACCOUNT)[0]).toMatchObject({
      profile: 'extension',
      bridgeUser: 'jeremy',
    });
    // An extension consent whose bridge went away asks again rather than failing.
    await env.service.closeSession(ACCOUNT, COMPUTER);
    usable = false;
    asker.answer = 0;
    await env.service.navigate(env.call(), 'https://shop.example/');
    expect(asker.asked).toHaveLength(3);
    expect(fallback.consents(ACCOUNT)[0]).toMatchObject({ profile: 'clean' });
    expect(bridge).toBeTruthy();
  });
});

describe('the connected computer', () => {
  const source = (over: Partial<FallbackDeviceSource> = {}): FallbackDeviceSource => ({
    activeConnection: () =>
      Promise.resolve({
        deviceId: DEVICE,
        deviceName: 'Laptop',
        capabilities: ['files', 'browser'],
      }),
    capabilities: () => Promise.resolve([{ name: 'browser', available: true, reason: null }]),
    device: () => Promise.resolve({ row: { status: 'active' }, endpoint: 'http://127.0.0.1:7420' }),
    ...over,
  });
  const resolve = (src: FallbackDeviceSource, agent: string | null = AGENT) =>
    connectedComputerResolver({
      agentOfComputer: () => Promise.resolve(agent),
      devices: src,
    }).target({ accountId: ACCOUNT, computerId: COMPUTER, threadId: THREAD });

  it('is the agent’s connection that was given the browser of a reachable device', async () => {
    expect(await resolve(source())).toEqual({
      ok: true,
      scope: { kind: 'agent', ref: AGENT },
      deviceId: DEVICE,
      deviceName: 'Laptop',
    });
  });

  it('refuses without an agent, a connection, the browser, its module or the device', async () => {
    expect(await resolve(source(), null)).toMatchObject({ reason: 'no_connected_computer' });
    expect(await resolve(source({ activeConnection: () => Promise.resolve(null) }))).toMatchObject({
      reason: 'no_connected_computer',
    });
    expect(
      await resolve(
        source({
          activeConnection: () =>
            Promise.resolve({ deviceId: DEVICE, deviceName: 'Laptop', capabilities: ['files'] }),
        }),
      ),
    ).toMatchObject({ reason: 'no_browser_module' });
    expect(
      await resolve(
        source({
          capabilities: () =>
            Promise.resolve([{ name: 'browser', available: false, reason: 'update_required' }]),
        }),
      ),
    ).toMatchObject({
      reason: 'no_browser_module',
      message: expect.stringContaining('update_required'),
    });
    expect(
      await resolve(
        source({
          device: () => Promise.resolve({ row: { status: 'unreachable' }, endpoint: null }),
        }),
      ),
    ).toMatchObject({ reason: 'device_unreachable' });
  });
});
