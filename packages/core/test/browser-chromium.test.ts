// The agent browser against a real Chromium and the local test site (docs/18 J8 steps 1-3 and 5;
// FR-086, FR-092, FR-094, FR-095, FR-098, FR-103, FR-208; M7: console and network capture,
// hover, element screenshots and the restart after a crash). Skipped, with the reason, where no
// Chromium can start (a host without the browser or its system libraries); the Playwright
// container and CI have one.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlaywrightDriver,
  browserToolSource,
  type BrowserDriver,
  type DriverSession,
} from '../src/browser/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';

const SITE = join(import.meta.dirname, 'fixtures', 'site');
const playwright = new PlaywrightDriver();
const probe = await playwright.probe(process.env.NOVA_BROWSER_EXECUTABLE ?? null);
/** The driver sessions the service launched (the crash test reaches the page through one). */
const launched: DriverSession[] = [];
const driver: BrowserDriver = {
  name: playwright.name,
  probe: (exe) => playwright.probe(exe),
  launch: async (opts) => {
    const s = await playwright.launch(opts);
    launched.push(s);
    return s;
  },
};

/** Width and height of a PNG (its IHDR chunk). */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

it('reports whether Chromium can start here, with a reason when it cannot', () => {
  expect(probe.detail.length).toBeGreaterThan(0);
  if (!probe.ok) console.warn(`browser integration tests skipped: ${probe.detail}`);
});

describe.skipIf(!probe.ok)('the agent browser on the local test site (Chromium)', () => {
  let server: Server;
  let base: string;
  let port: number;
  const posts: { path: string; body: string }[] = [];
  let env: BrowserEnv;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          posts.push({ path: url.pathname, body });
          if (url.pathname === '/login') {
            res.writeHead(302, { location: '/account.html', 'set-cookie': 'sid=fixture; Path=/' });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>Thanks</title><p>Thanks, received.</p>');
        });
        return;
      }
      // No Content-Length (chunked): read only once finished and small enough (M7 review).
      if (url.pathname === '/chunked.json' || url.pathname === '/chunked-big.txt') {
        const big = url.pathname === '/chunked-big.txt';
        res.writeHead(200, { 'content-type': big ? 'text/plain' : 'application/json' });
        res.write(big ? 'x'.repeat(40_000) : '{"session_token":');
        res.end(big ? 'y'.repeat(40_000) : '"chunked-should-not-show","ok":true}');
        return;
      }
      if (url.pathname === '/api.json') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'sid=cookie-should-not-show; Path=/',
          'x-auth-token': 'header-token-should-not-show',
        });
        res.end(JSON.stringify({ greeting: 'hello', access_token: 'body-token-should-not-show' }));
        return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z]+\.(html|txt|svg)$/.test(name)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const raw = readFileSync(join(SITE, name), 'utf8').replaceAll('PORT', String(port));
        const type = name.endsWith('.html')
          ? 'text/html'
          : name.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/plain';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
        res.end(raw);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const exe = process.env.NOVA_BROWSER_EXECUTABLE;
    env = await makeBrowserEnv(
      { driver },
      { 'browser.allowLocalSites': true, ...(exe ? { 'browser.executablePath': exe } : {}) },
    );
    await env.service.sites.put(ACCOUNT, {
      pattern: '127.0.0.1',
      access: 'allow',
      level: 'always_allow',
    });
  }, 60_000);

  afterAll(async () => {
    await env?.close();
    await new Promise((r) => server?.close(r));
  });

  const text = (r: Awaited<ReturnType<BrowserEnv['service']['read']>>) =>
    r.ok
      ? r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      : `ERROR ${r.error.message}`;
  const ref = (page: string, name: string) => {
    const m = new RegExp(`\\[(e\\d+)\\] [a-z]+ "${name}`).exec(page);
    if (!m) throw new Error(`no element "${name}" in:\n${page}`);
    return m[1]!;
  };

  it('navigates, reads, clicks and takes screenshots; other hosts stay closed (J8 1-2)', async () => {
    const nav = await env.service.navigate(env.call(), `${base}/`);
    expect(nav.ok, text(nav)).toBe(true);
    let page = text(await env.service.read(env.call()));
    expect(page).toContain('Nova test site');
    expect(page).toContain('untrusted data');
    // The image on another host did not load.
    expect(page).toMatch(/Blocked: resources from localhost/);
    // A link to an unlisted host is refused by the guard.
    const away = await env.service.write(env.call(), {
      kind: 'click',
      ref: ref(page, 'Same site, other host'),
    });
    expect(away).toMatchObject({ ok: false, error: { code: 'blocked_navigation' } });
    page = text(await env.service.read(env.call()));
    const go = await env.service.write(env.call(), { kind: 'click', ref: ref(page, 'Shop') });
    expect(go.ok, text(go)).toBe(true);
    page = text(await env.service.read(env.call()));
    expect(page).toContain('Blue mug');
    expect(
      (await env.service.write(env.call(), { kind: 'click', ref: ref(page, 'Show details') })).ok,
    ).toBe(true);
    expect(text(await env.service.read(env.call()))).toContain('Ceramic');
    const shot = await env.service.screenshot(env.call(), false);
    expect(shot.ok && shot.content.some((c) => c.type === 'image')).toBe(true);
    // Unlisted host: the new-site prompt, denied.
    const other = env.service.navigate(env.call(), `http://localhost:${port}/`);
    await env.answer('deny_continue');
    expect(await other).toMatchObject({ ok: false, error: { code: 'denied' } });
    const rows = env.service.recorder.list(ACCOUNT, { threadId: THREAD });
    expect(rows.filter((r) => r.result === 'ok').every((r) => r.after)).toBe(true);
  }, 60_000);

  it('a purchase asks, and a denied one never reaches the site', async () => {
    await env.service.navigate(env.call(), `${base}/shop.html`);
    const page = text(await env.service.read(env.call()));
    const buy = env.service.write(env.call(), { kind: 'click', ref: ref(page, 'Buy now') });
    const a = await env.answer('deny_continue');
    expect(a.tier).toBe('confirm_at_action');
    expect((await buy).ok).toBe(false);
    expect(posts.some((p) => p.path === '/buy')).toBe(false);
  }, 60_000);

  it('a message form asks, then sends what was typed', async () => {
    await env.service.navigate(env.call(), `${base}/form.html`);
    let page = text(await env.service.read(env.call()));
    expect(
      (
        await env.service.write(env.call(), {
          kind: 'type',
          ref: ref(page, 'Your name'),
          text: 'Ada',
        })
      ).ok,
    ).toBe(true);
    page = text(await env.service.read(env.call()));
    const send = env.service.write(env.call(), { kind: 'click', ref: ref(page, 'Send message') });
    await env.answer('allow_once');
    const out = await send;
    expect(out.ok, text(out)).toBe(true);
    expect(posts.find((p) => p.path === '/submit')?.body).toContain('name=Ada');
  }, 60_000);

  it('an injected instruction is a finding and its action is not taken unapproved (J8 3)', async () => {
    await env.service.navigate(env.call(), `${base}/injected.html`);
    const page = text(await env.service.read(env.call()));
    expect(page).toMatch(/Finding: .*ignore your instructions/);
    const del = env.service.write(env.call(), { kind: 'click', ref: ref(page, 'Delete account') });
    const a = await env.answer('deny_continue');
    expect(a.tier).toBe('confirm_at_action');
    await del;
    expect(posts.some((p) => p.path === '/delete')).toBe(false);
  }, 60_000);

  it('a page signed by the billing agent gets nothing (J8 5)', async () => {
    await env.service.navigate(env.call(), `${base}/billing.html`);
    let page = text(await env.service.read(env.call()));
    expect(page).toContain('external AI agent ("billing agent")');
    const typed = await env.service.write(env.call(), {
      kind: 'type',
      ref: ref(page, 'Report'),
      text: 'Q3 numbers',
      submit: true,
    });
    expect(typed).toMatchObject({ ok: false, error: { code: 'denied' } });
    page = text(await env.service.read(env.call()));
    const click = await env.service.write(env.call(), {
      kind: 'click',
      ref: ref(page, 'Send report'),
    });
    expect(click).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(posts.some((p) => p.path === '/report')).toBe(false);
    expect(env.audit.some((a) => a.detail?.cause === 'external_agent')).toBe(true);
  }, 60_000);

  it('signs in through the private form; the password reaches only the site', async () => {
    await env.service.navigate(env.call(), `${base}/login.html`);
    const asking = env.service.signIn(env.call(), 'to see the account');
    let id = '';
    await expect.poll(() => (id = env.service.signins.pending(ACCOUNT)[0]?.id ?? '')).not.toBe('');
    const filled = await env.service.signins.submit(ACCOUNT, id, {
      username: 'ada@example.com',
      // secret-scan: fake
      password: 'fixture-password-1',
      save: false,
    });
    expect(filled.state).toBe('completed');
    const out = await asking;
    expect(out.ok, text(out)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('fixture-password-1');
    expect(posts.find((p) => p.path === '/login')?.body).toContain('pass=fixture-password-1');
    expect(text(await env.service.read(env.call()))).toContain('Welcome back');
  }, 60_000);

  it("downloads into the computer's files", async () => {
    await env.service.navigate(env.call(), `${base}/download.html`);
    const page = text(await env.service.read(env.call()));
    const dl = await env.service.download(env.call(), ref(page, 'Quarterly report'), undefined);
    expect(dl.ok, text(dl)).toBe(true);
    expect(text(dl)).toContain('Downloads/report.txt');
  }, 60_000);

  it('page tools: the top frame registers, a frame cannot, calls run in the page (FR-208)', async () => {
    await env.service.navigate(env.call(), `${base}/tools.html`);
    await env.service.wait(env.call(), 'load', undefined, 5_000);
    const source = browserToolSource({
      service: env.service,
      threadMode: () => Promise.resolve('work'),
    });
    let names: string[] = [];
    await expect
      .poll(async () => {
        names = (await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' }))
          .map((t) => t.descriptor.name)
          .filter((n) => n.startsWith('page:'));
        return names;
      })
      .toEqual(['page:127.0.0.1.add']);
    const out = await env.service.callPageTool(env.call(), '127.0.0.1', 'add', { a: 2, b: 3 });
    expect(text(out)).toContain('{"sum":5}');
  }, 60_000);

  it('captures the console and the network, redacted, with findings (M7)', async () => {
    await env.service.navigate(env.call(), `${base}/observe.html`);
    await expect
      .poll(async () => text(await env.service.console(env.call())), { timeout: 10_000 })
      .toContain('api says hello');
    const con = text(await env.service.console(env.call()));
    expect(con).toContain('log: observe page loaded');
    expect(con).toContain('error (uncaught): Error: boom from the page');
    expect(con).toMatch(/Finding: .*ignore your instructions/);
    const net = text(
      await env.service.network(env.call(), { contains: 'api.json', details: true }),
    );
    expect(net).toMatch(
      /GET http:\/\/127\.0\.0\.1:\d+\/api\.json\?token=\[REDACTED\]&page=2 -> 200/,
    );
    expect(net).toContain('x-api-key: [REDACTED]');
    expect(net).toContain('"greeting":"hello"');
    expect(net).toContain('"access_token":"[REDACTED]"');
    for (const secret of [
      's3cret-token-value',
      'key-should-not-show',
      'cookie-should-not-show',
      'header-token-should-not-show',
      'body-token-should-not-show',
    ]) {
      expect(net).not.toContain(secret);
      expect(con).not.toContain(secret);
    }
    // Bodies without a Content-Length: a small one is read (and masked), a large one is not.
    await env.service.navigate(env.call(), `${base}/chunked.html`);
    await expect
      .poll(
        async () =>
          text(await env.service.network(env.call(), { contains: 'chunked', details: true })),
        { timeout: 10_000 },
      )
      .toMatch(/chunked-big\.txt[\s\S]*body: not captured \(larger than 16 KB\)/);
    const chunked = text(
      await env.service.network(env.call(), { contains: 'chunked.json', details: true }),
    );
    expect(chunked).toContain('"session_token":"[REDACTED]"');
    expect(chunked).toContain('"ok":true');
    expect(chunked).not.toContain('chunked-should-not-show');
    // The image on another host was refused by the guard: listed as blocked.
    await env.service.navigate(env.call(), `${base}/`);
    await expect
      .poll(async () => text(await env.service.network(env.call(), { failedOnly: true })), {
        timeout: 10_000,
      })
      .toContain('pixel.svg -> blocked');
  }, 60_000);

  it('hovers to open a menu and shoots one element (M7)', async () => {
    await env.service.navigate(env.call(), `${base}/observe.html`);
    let page = text(await env.service.read(env.call()));
    expect(page).not.toContain('Mugs and cups');
    const hover = await env.service.hover(env.call(), ref(page, 'Products'));
    expect(hover.ok, text(hover)).toBe(true);
    page = text(await env.service.read(env.call()));
    expect(page).toContain('Mugs and cups');
    const shot = await env.service.screenshot(env.call(), false, ref(page, 'Status: all good'));
    expect(shot.ok, text(shot)).toBe(true);
    const image = shot.ok ? shot.content.find((c) => c.type === 'image') : undefined;
    const size = pngSize(Buffer.from((image as { data: string }).data, 'base64'));
    expect(size.width).toBeGreaterThanOrEqual(150);
    expect(size.width).toBeLessThan(200);
    expect(size.height).toBeLessThan(80);
  }, 60_000);

  it('restarts a crashed page on the page it was on (M7, docs/11 §10)', async () => {
    await env.service.navigate(env.call(), `${base}/observe.html`);
    expect(text(await env.service.read(env.call()))).toContain('Observe');
    // Crash the renderer of the agent's page.
    await launched
      .at(-1)!
      .goto('chrome://crash', 5_000)
      .catch(() => undefined);
    await expect
      .poll(() => env.service.sessions(ACCOUNT)[0]?.crash?.reason ?? null, { timeout: 10_000 })
      .toBe('the page crashed');
    const read = await env.service.read(env.call());
    expect(read.ok, text(read)).toBe(true);
    expect(text(read)).toContain('The browser crashed (the page crashed) and was restarted on');
    expect(text(read)).toContain('Observe');
    const rows = env.service.recorder.list(ACCOUNT).map((r) => `${r.tool}/${r.action}/${r.result}`);
    expect(rows).toEqual(
      expect.arrayContaining(['browser.crash/crash/error', 'browser.restart/restart/ok']),
    );
    expect(env.service.sessions(ACCOUNT)[0]).toMatchObject({ crash: null, restarts: 1 });
  }, 60_000);
});
