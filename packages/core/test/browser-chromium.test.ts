// The agent browser against a real Chromium and the local test site (docs/18 J8 steps 1-3 and 5;
// FR-086, FR-092, FR-094, FR-095, FR-098, FR-103, FR-208). Skipped, with the reason, where no
// Chromium can start (a host without the browser or its system libraries); the Playwright
// container and CI have one.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightDriver, browserToolSource } from '../src/browser/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';

const SITE = join(import.meta.dirname, 'fixtures', 'site');
const driver = new PlaywrightDriver();
const probe = await driver.probe(process.env.NOVA_BROWSER_EXECUTABLE ?? null);

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
});
