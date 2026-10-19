// The agent browser per computer (FR-092, FR-096, FR-087 hooks, FR-208, FR-209; docs/11 §4, §8):
// unavailable browsers and a missing egress proxy fail closed, the proxy session and its relaunch
// with the same cookies, the concurrency cap, cookies kept only when enabled, pause/resume and the
// user's takeover input, the live frame stream, page-registered tools, the local fallback, the
// seam controller, and the tool source's listing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EgressPolicy, EgressProxy } from '../src/index.ts';
import { browserToolSource, playwrightProxy } from '../src/browser/index.ts';
import { caSpki } from '../src/browser/session.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import { PNG } from './browser-fake.ts';

class FakeEgress implements EgressProxy {
  readonly opened: { policy: EgressPolicy; scope: { kind: string; id: string } }[] = [];
  closed = 0;
  ca: string | null = null;
  open(input: Parameters<EgressProxy['open']>[0]) {
    this.opened.push({ policy: input.policy, scope: input.scope });
    const n = this.opened.length;
    return Promise.resolve({
      proxyUrl: `http://127.0.0.1:${9000 + n}`,
      caCertPem: this.ca,
      close: () => {
        this.closed++;
        return Promise.resolve();
      },
    });
  }
}

let env: BrowserEnv;

beforeEach(async () => {
  env = await makeBrowserEnv();
  env.driver.pages.set('https://a.example/', {
    title: 'A',
    text: 'page a',
    elements: [{ role: 'link', tag: 'a', name: 'B', href: 'https://b.example/' }],
  });
  env.driver.pages.set('https://b.example/', { title: 'B', text: 'page b', elements: [] });
  await env.service.sites.put(ACCOUNT, {
    pattern: 'a.example',
    access: 'allow',
    level: 'always_allow',
  });
});

afterEach(async () => {
  await env.close();
});

describe('availability', () => {
  it('reports a missing Chromium and every tool fails closed with that reason', async () => {
    env.driver.available = false;
    const st = await env.service.status();
    expect(st).toMatchObject({ available: false, driver: 'fake' });
    const out = await env.service.navigate(env.call(), 'https://a.example/');
    expect(out).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    expect(!out.ok && out.error.message).toContain('No Chromium');
    expect((await env.service.read(env.call())).ok).toBe(false);
    expect(env.driver.launches).toEqual([]);
  });

  it('stays closed without the egress proxy unless direct network is allowed', async () => {
    await env.close();
    env = await makeBrowserEnv({ requireEgress: true });
    expect(await env.service.status()).toMatchObject({ available: false, egress: 'missing' });
    const out = await env.service.navigate(env.call(), 'https://a.example/');
    expect(!out.ok && out.error.message).toContain('egress proxy');
  });
});

describe('the egress proxy and the profile', () => {
  it("opens its proxy session in the Hub's network mode: off and limited bound it (FR-193)", async () => {
    await env.close();
    const egress = new FakeEgress();
    egress.ca = readFileSync(join(import.meta.dirname, 'fixtures', 'egress-ca.pem'), 'utf8');
    env = await makeBrowserEnv({ requireEgress: true, egress });
    env.settings['network.egressMode'] = 'limited';
    env.driver.pages.set('https://a.example/', { title: 'A', text: 'a', elements: [] });
    await env.service.sites.put(ACCOUNT, { pattern: 'a.example', access: 'allow' });
    await env.service.navigate(env.call(), 'https://a.example/');
    expect(egress.opened[0]!.policy.mode).toBe('limited');
  });

  it('routes through a proxy session that allows the permitted sites, and relaunches for a new one', async () => {
    await env.close();
    const egress = new FakeEgress();
    egress.ca = readFileSync(join(import.meta.dirname, 'fixtures', 'egress-ca.pem'), 'utf8');
    env = await makeBrowserEnv({ requireEgress: true, egress });
    env.driver.pages.set('https://a.example/', { title: 'A', text: 'a', elements: [] });
    env.driver.pages.set('https://b.example/', { title: 'B', text: 'b', elements: [] });
    await env.service.sites.put(ACCOUNT, { pattern: 'a.example', access: 'allow' });
    await env.service.sites.put(ACCOUNT, { pattern: 'evil.example', access: 'block' });
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    expect(egress.opened[0]!.policy).toMatchObject({
      mode: 'allowlist',
      allow: ['*.a.example', 'a.example'],
      deny: ['evil.example'],
      credentials: [],
      allowLocalBinding: false,
    });
    expect(egress.opened[0]!.scope).toEqual({ kind: 'sandbox', id: 'browser:thread-' + THREAD });
    const launch = env.driver.launches[0]!;
    expect(launch.proxy?.server).toBe('http://127.0.0.1:9001');
    expect(launch.proxy?.caSpki).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // A cookie set on a.example survives the relaunch the new site needs.
    env.driver.current.storage = {
      cookies: [{ name: 'sid', value: 'x', domain: 'a.example' }],
      origins: [],
    };
    const pending = env.service.navigate(env.call(), 'https://b.example/');
    await env.answer('allow_once');
    expect((await pending).ok).toBe(true);
    expect(egress.opened).toHaveLength(2);
    expect(egress.opened[1]!.policy.allow).toEqual([
      '*.a.example',
      '*.b.example',
      'a.example',
      'b.example',
    ]);
    expect(egress.closed).toBe(1);
    expect(env.driver.sessions[0]!.closed).toBe(true);
    expect(env.driver.launches[1]!.storageState?.cookies).toEqual([
      { name: 'sid', value: 'x', domain: 'a.example' },
    ]);
    expect(caSpki('not a certificate')).toBeNull();
    expect(caSpki(null)).toBeNull();
  });

  it("keeps cookies only with browser.persistCookies, in the computer's profile", async () => {
    env.settings['browser.persistCookies'] = true;
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    env.driver.current.storage = { cookies: [{ name: 'sid', value: 'keep' }], origins: [] };
    const computerId = `thread-${THREAD}`;
    expect(env.service.sessions(ACCOUNT)).toEqual([
      expect.objectContaining({
        computerId,
        state: 'running',
        host: 'a.example',
        persistCookies: true,
      }),
    ]);
    expect(await env.service.closeSession(ACCOUNT, computerId)).toBe(true);
    expect(await env.service.closeSession(ACCOUNT, computerId)).toBe(false);
    expect(env.audit.some((a) => a.action === 'browser.session.closed')).toBe(true);
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    expect(env.driver.launches[1]!.storageState?.cookies).toEqual([{ name: 'sid', value: 'keep' }]);
    const profile = env.driver.launches[1]!.profileDir;
    expect(existsSync(join(profile, 'state.json'))).toBe(true);
    await env.service.closeSession(ACCOUNT, computerId);
    // Turning it off forgets them at the next start.
    env.settings['browser.persistCookies'] = false;
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    expect(env.driver.launches[2]!.storageState).toBeNull();
    expect(existsSync(join(profile, 'state.json'))).toBe(false);
  });

  it('caps concurrent browsers by closing the least recently used idle one', async () => {
    env.settings['browser.maxConcurrent'] = 1;
    const one = env.call({ computerId: 'one' });
    expect((await env.service.navigate(one, 'https://a.example/')).ok).toBe(true);
    expect(
      (await env.service.navigate(env.call({ computerId: 'two' }), 'https://a.example/')).ok,
    ).toBe(true);
    expect(env.driver.sessions[0]!.closed).toBe(true);
    expect(env.service.sessions(ACCOUNT).map((s) => s.computerId)).toEqual(['two']);
    const busy = env.service.session(ACCOUNT, 'two')!;
    busy.busy++;
    const third = await env.service.navigate(
      env.call({ computerId: 'three' }),
      'https://a.example/',
    );
    expect(third).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    busy.busy--;
  });
});

describe('takeover hooks (FR-087)', () => {
  it("pausing holds the agent's writes until the user returns control", async () => {
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    await env.service.read(env.call());
    const ctl = env.service.controllerFor(ACCOUNT, `thread-${THREAD}`);
    await ctl.pause('user');
    expect(ctl.view()).toMatchObject({ state: 'paused', pausedBy: 'user' });
    let done = false;
    const pending = env.service.write(env.call(), { kind: 'press', key: 'Escape' }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    // The user's own input goes through while paused, without approvals.
    await ctl.input({ kind: 'click', x: 10, y: 10 });
    const userNav = await ctl.act(
      { kind: 'navigate', url: 'https://b.example/' },
      new AbortController().signal,
    );
    expect(userNav.ok).toBe(true);
    expect(env.approvals()).toEqual([]);
    expect(env.driver.log).toContain('input click');
    ctl.resume();
    expect((await pending).ok).toBe(true);
    await expect(ctl.input({ kind: 'key', key: 'Enter' })).rejects.toThrow(
      /only while the user has control/,
    );
    const names = env.events.events
      .filter((e) => e.name === 'browser.session.changed')
      .map((e) => e.payload.state);
    expect(names).toEqual(expect.arrayContaining(['running', 'paused']));
  });

  it('a call cancelled while paused ends; the service pause hooks act on a running browser only', async () => {
    await env.service.pauseComputer(ACCOUNT, 'nothing', 'user');
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    await env.service.pauseComputer(ACCOUNT, `thread-${THREAD}`, 'kill');
    const ac = new AbortController();
    const pending = env.service.read(env.call({ signal: ac.signal }));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await env.service.resumeComputer(ACCOUNT, `thread-${THREAD}`);
    expect(env.service.session(ACCOUNT, `thread-${THREAD}`)!.paused).toBe(false);
  });

  it('streams live frames at most once per 2 s', async () => {
    const ticks: { fn: () => void; ms: number }[] = [];
    await env.close();
    env = await makeBrowserEnv({
      timers: {
        setInterval: (fn, ms) => (ticks.push({ fn, ms }), ticks.length),
        clearInterval: () => undefined,
      },
    });
    const ctl = env.service.controllerFor(ACCOUNT, 'c1');
    const frames: Uint8Array[] = [];
    const stop = await ctl.onFrame((png) => frames.push(png), 100);
    expect(ticks[0]!.ms).toBe(2_000);
    ticks[0]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(Buffer.from(frames[0]!).equals(PNG)).toBe(true);
    stop();
  });
});

describe('page-registered tools (FR-208)', () => {
  it('lists top-frame tools of the current origin, runs them, and drops them on leaving', async () => {
    const source = browserToolSource({
      service: env.service,
      threadMode: () => Promise.resolve('work'),
    });
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    const page = env.driver.current;
    page.register('search_catalog', 'Search the catalog');
    page.register('bad name!');
    page.register('other', 'from elsewhere', 'https://evil.example');
    for (let i = 0; i < 25; i++) page.register(`t${i}`);
    const listed = (await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).map(
      (t) => t.descriptor.name,
    );
    const pageTools = listed.filter((n) => n.startsWith('page:'));
    expect(pageTools).toContain('page:a.example.search_catalog');
    expect(pageTools).toHaveLength(20);
    expect(pageTools.some((n) => n.includes('other') || n.includes('bad'))).toBe(false);
    const def = (await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).find(
      (t) => t.descriptor.name === 'page:a.example.search_catalog',
    )!;
    expect(def.descriptor).toMatchObject({ source: 'page' });
    expect(def.descriptor.description).toContain('untrusted');
    const ctx = {
      accountId: ACCOUNT,
      threadId: THREAD,
      turnId: 't',
      callId: 'c',
      projectId: null,
      origin: 'model' as const,
      profile: { id: 'workspace', hash: 'h' },
      roots: [],
      sandbox: {} as never,
      signal: new AbortController().signal,
      log: {} as never,
    };
    const r = await def.handler({ q: 'shoes' }, ctx);
    expect(r.ok && r.content[0]).toMatchObject({ text: expect.stringContaining('untrusted') });
    expect(env.driver.log).toContain('pagetool search_catalog {"q":"shoes"}');
    // Leaving the origin drops them; a stale definition refuses.
    await env.service.read(env.call());
    const away = env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    await env.answer('allow_once').catch(() => undefined);
    await away;
    const nav = env.service.navigate(env.call(), 'https://b.example/');
    await env.answer('allow_once');
    expect((await nav).ok).toBe(true);
    expect(
      (await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).some((t) =>
        t.descriptor.name.startsWith('page:'),
      ),
    ).toBe(false);
    const stale = await def.handler({ q: 'x' }, ctx);
    expect(stale).toMatchObject({ ok: false, error: { code: 'not_available' } });
  });
});

describe('the tool source and the seam', () => {
  it('lists the browser tools in agent, Work and Code threads only; evaluate with a dev site', async () => {
    const source = browserToolSource({
      service: env.service,
      threadMode: () => Promise.resolve('work'),
    });
    expect(await source.list(ACCOUNT, { threadId: THREAD, mode: 'chat' })).toEqual([]);
    const names = (await source.list(ACCOUNT, { threadId: THREAD, mode: 'agent' })).map(
      (t) => t.descriptor.name,
    );
    expect(names).toEqual([
      'browser.navigate',
      'browser.read',
      'browser.click',
      'browser.type',
      'browser.hover',
      'browser.select',
      'browser.press',
      'browser.scroll',
      'browser.wait',
      'browser.back',
      'browser.screenshot',
      'browser.console',
      'browser.network',
      'browser.download',
      'browser.upload',
      'browser.sign_in',
    ]);
    await env.service.sites.patch(ACCOUNT, 'a.example', { devProtocol: true });
    expect((await source.list(ACCOUNT)).map((t) => t.descriptor.name)).toContain(
      'browser.evaluate',
    );
  });

  it('serves the computers area through BrowserController, under the same policy', async () => {
    const factory = env.service.browserFactory();
    expect(await factory({ id: 'c9' })).toBeNull();
    const ctl = (await factory({ id: 'c9', accountId: ACCOUNT }))!;
    expect(await ctl.read()).toBeNull();
    const r = await ctl.act(
      { kind: 'navigate', url: 'https://a.example/' },
      new AbortController().signal,
    );
    expect(r).toMatchObject({ ok: true, page: { url: 'https://a.example/', title: 'A' } });
    expect(r.before).toMatch(/^browser-action:.+:before$/);
    expect((await ctl.read({ maxChars: 100 }))!.elements).toEqual([
      { ref: 'e1', role: 'link', name: 'B' },
    ]);
    expect(Buffer.from(await ctl.screenshot()).equals(PNG)).toBe(true);
    // An unknown site still asks, even through the seam (no thread: a global approval).
    const pending = ctl.act(
      { kind: 'navigate', url: 'https://b.example/' },
      new AbortController().signal,
    );
    await env.answer('deny_continue');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'denied' } });
    for (const a of [
      { kind: 'scroll', direction: 'down' } as const,
      { kind: 'wait', for: 'load' } as const,
      { kind: 'back' } as const,
      { kind: 'press', key: 'Tab' } as const,
    ])
      expect((await ctl.act(a, new AbortController().signal)).ok).toBe(true);
    await ctl.close();
    expect(ctl.view()).toBeNull();
  });

  it('refuses the local browser fallback until a connected computer offers it', async () => {
    const none = await env.service.localFallback(env.call());
    expect(none).toMatchObject({ ok: false, error: { code: 'not_available' } });
    expect(env.audit.at(-1)).toMatchObject({ action: 'browser.fallback.refused' });
    // The full flow (offer, consent, the device's browser) is in browser-fallback.test.ts.
    env.service.useLocalFallback({
      begin: (input) =>
        Promise.resolve({
          ok: true,
          sessionId: `fs-${input.site}`,
          deviceId: `dev-for-${input.site}`,
          deviceName: 'Laptop',
          profile: 'clean',
          consentId: 'c1',
          consentReused: true,
          driver: env.driver,
        }),
      marked: () => Promise.resolve(),
      end: () => Promise.resolve(),
    });
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    const ok = await env.service.localFallback(env.call());
    expect(ok.ok).toBe(true);
    expect(env.audit.find((a) => a.action === 'browser.fallback.started')).toMatchObject({
      detail: expect.objectContaining({ deviceId: 'dev-for-a.example' }),
    });
  });
});

describe('the tools map their arguments onto the browser', () => {
  it('runs each tool through the service', async () => {
    env.driver.pages.set('https://a.example/', {
      title: 'A',
      text: 'page a with Hello',
      elements: [
        { role: 'textbox', tag: 'input', name: 'Name' },
        { role: 'combobox', tag: 'select', name: 'Size', options: ['S', 'M'] },
        { role: 'button', tag: 'button', name: 'Get', download: { name: 'x.txt', data: 'x' } },
        { role: 'button', tag: 'input', inputType: 'file', name: 'Attach' },
      ],
    });
    const source = browserToolSource({
      service: env.service,
      threadMode: () => Promise.resolve('work'),
    });
    const tools = new Map(
      (await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).map((t) => [
        t.descriptor.name,
        t,
      ]),
    );
    const ctx = {
      accountId: ACCOUNT,
      threadId: THREAD,
      turnId: 't',
      callId: 'c',
      projectId: null,
      origin: 'model' as const,
      profile: { id: 'workspace', hash: 'h' },
      roots: [],
      sandbox: {} as never,
      signal: new AbortController().signal,
      log: {} as never,
    };
    const run = (name: string, args: Record<string, unknown>) =>
      tools.get(name)!.handler(args, ctx);
    expect((await run('browser.navigate', { url: 'https://a.example/' })).ok).toBe(true);
    expect((await run('browser.read', { maxChars: 2000 })).ok).toBe(true);
    expect((await run('browser.type', { ref: 'e1', text: 'Ada', submit: false })).ok).toBe(true);
    expect((await run('browser.select', { ref: 'e2', value: 'M' })).ok).toBe(true);
    expect((await run('browser.press', { key: 'Tab' })).ok).toBe(true);
    expect((await run('browser.scroll', { direction: 'up', amount: 100 })).ok).toBe(true);
    expect((await run('browser.wait', { for: 'text', text: 'Hello', timeoutMs: 100 })).ok).toBe(
      true,
    );
    expect(await run('browser.wait', { for: 'text' })).toMatchObject({ ok: false });
    expect((await run('browser.wait', { for: 'idle' })).ok).toBe(true);
    expect((await run('browser.screenshot', { fullPage: false })).ok).toBe(true);
    expect((await run('browser.download', { ref: 'e3' })).ok).toBe(true);
    expect(await run('browser.upload', { ref: 'e4', path: 'missing.txt' })).toMatchObject({
      ok: false,
    });
    expect((await run('browser.click', { ref: 'e3' })).ok).toBe(true);
    expect((await run('browser.back', {})).ok).toBe(true);
    expect(env.driver.log).toEqual(
      expect.arrayContaining([
        'fill e1',
        'select e2 M',
        'press Tab',
        'scroll up 100',
        'wait idle',
        'back',
      ]),
    );
    const navigate = tools.get('browser.navigate') as unknown as {
      resource: (a: unknown) => unknown;
    };
    expect(navigate.resource({ url: 'https://A.example/x' })).toEqual({
      kind: 'host',
      value: 'a.example',
    });
    expect(navigate.resource({ url: 'nope' })).toBeUndefined();
  });
});

describe('the Playwright driver without a browser', () => {
  it('reports why it cannot start', async () => {
    const { PlaywrightDriver } = await import('../src/browser/playwright.ts');
    const none = new PlaywrightDriver({ load: () => Promise.resolve(null) });
    expect(await none.probe(null)).toEqual({
      ok: false,
      detail: 'playwright-core is not installed on this Hub',
    });
    await expect(none.launch({} as never)).rejects.toThrow(/not installed/);
    const missing = new PlaywrightDriver({
      load: () =>
        Promise.resolve({
          chromium: { executablePath: () => '/nonexistent/chrome' },
        } as never),
    });
    expect((await missing.probe(null)).detail).toMatch(/No Chromium is installed/);
    const broken = new PlaywrightDriver({
      load: () =>
        Promise.resolve({
          chromium: {
            executablePath: () => process.execPath,
            launch: () =>
              Promise.reject(
                new Error('chrome: error while loading shared libraries: libnspr4.so: cannot open'),
              ),
          },
        } as never),
    });
    const p = await broken.probe(null);
    expect(p.detail).toContain('libnspr4.so');
    // Cached per executable.
    expect(await broken.probe(null)).toBe(p);
  });
});

describe('the Playwright proxy option', () => {
  it('passes the session credentials apart from the server (Chromium ignores them in the URL)', () => {
    expect(playwrightProxy('http://nova:t%2Fk3n@127.0.0.1:9001')).toEqual({
      server: 'http://127.0.0.1:9001',
      username: 'nova',
      password: 't/k3n',
    });
    expect(playwrightProxy('http://127.0.0.1:9001')).toEqual({ server: 'http://127.0.0.1:9001' });
  });
});
