// Restart after a browser crash (M7, docs/11 §10): a crashed page is replaced in the same browser,
// a browser that died starts again with the same profile (the checkpoint's cookies), the page it
// was on is opened again where the guards still allow it, the trace and the audit note the crash,
// only an idempotent action is repeated, and a browser that keeps crashing is closed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/index.ts';
import { BROWSER_MAX_RESTARTS } from '../src/browser/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';

let env: BrowserEnv;

const text = (r: ToolResult) =>
  r.ok ? r.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : r.error.message;

beforeEach(async () => {
  env = await makeBrowserEnv();
  for (const host of ['a.example', 'b.example']) {
    env.driver.pages.set(`https://${host}/`, {
      title: host,
      text: `Welcome to ${host}.`,
      elements: [{ role: 'button', tag: 'button', name: 'Show details' }],
    });
    await env.service.sites.put(ACCOUNT, { pattern: host, access: 'allow', level: 'always_allow' });
  }
  expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
});

afterEach(async () => {
  await env.close();
});

const trace = () =>
  env.service.recorder
    .list(ACCOUNT, { threadId: THREAD })
    .map((r) => `${r.tool}/${r.action}/${r.result}`);
const audits = (action: string) => env.audit.filter((a) => a.action === action);

describe('a crashed page', () => {
  it('is noted at once, and the next call restarts it on the page it was on', async () => {
    env.driver.current.crash('page');
    await expect.poll(() => trace().at(-1)).toBe('browser.crash/crash/error');
    expect(audits('browser.session.crashed')[0]).toMatchObject({
      resource: 'a.example',
      detail: { reason: 'the page crashed' },
    });
    expect(env.service.sessions(ACCOUNT)[0]).toMatchObject({
      state: 'error',
      crash: { reason: 'the page crashed' },
      restarts: 0,
    });
    const read = await env.service.read(env.call());
    expect(read.ok, text(read)).toBe(true);
    expect(text(read)).toContain('Welcome to a.example');
    expect(text(read)).toContain(
      'The browser crashed (the page crashed) and was restarted on https://a.example/',
    );
    // The same browser: a new page, no new launch.
    expect(env.driver.sessions).toHaveLength(1);
    expect(env.driver.current.recovers).toBe(1);
    expect(trace().slice(-1)).toEqual(['browser.restart/restart/ok']);
    expect(env.service.recorder.list(ACCOUNT).at(-1)).toMatchObject({
      target: 'a new page in the same browser',
      url: 'https://a.example/',
      after: true,
    });
    expect(audits('browser.session.restarted')[0]).toMatchObject({
      detail: { mode: 'page', reopened: true },
    });
    expect(env.service.sessions(ACCOUNT)[0]).toMatchObject({
      state: 'running',
      crash: null,
      restarts: 1,
    });
  });

  it('two calls on a crashed browser share one restart', async () => {
    env.driver.current.crash('page');
    const [a, b] = await Promise.all([
      env.service.read(env.call()),
      env.service.screenshot(env.call(), false),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(env.driver.current.recovers).toBe(1);
    expect(audits('browser.session.restarted')).toHaveLength(1);
  });

  it('a browser that died starts again with the cookies of the last checkpoint', async () => {
    env.driver.current.storage = {
      cookies: [{ name: 'sid', value: 'abc', domain: 'a.example', path: '/' }],
      origins: [],
    };
    // A completed action takes the checkpoint.
    expect((await env.service.navigate(env.call(), 'https://b.example/')).ok).toBe(true);
    env.driver.current.crash('browser');
    const nav = await env.service.read(env.call());
    expect(nav.ok, text(nav)).toBe(true);
    expect(env.driver.sessions).toHaveLength(2);
    expect(env.driver.launches[1]!.storageState).toEqual({
      cookies: [{ name: 'sid', value: 'abc', domain: 'a.example', path: '/' }],
      origins: [],
    });
    expect(env.driver.current.url()).toBe('https://b.example/');
    expect(audits('browser.session.restarted')[0]).toMatchObject({ detail: { mode: 'browser' } });
  });

  it('is not reopened on a site that was blocked meanwhile', async () => {
    env.driver.current.crash('page');
    await env.service.sites.put(ACCOUNT, { pattern: 'a.example', access: 'block' });
    const read = await env.service.read(env.call());
    expect(read).toMatchObject({ ok: false, error: { code: 'no_page' } });
    expect(text(read)).toContain('was restarted.');
    expect(env.driver.log.filter((l) => l === 'goto https://a.example/')).toHaveLength(1);
  });
});

describe('a crash during an action', () => {
  it('a click is not repeated: the agent is told to check', async () => {
    expect((await env.service.read(env.call())).ok).toBe(true);
    env.driver.current.crashOn = { call: 'click', kind: 'page', event: false };
    const out = await env.service.write(env.call(), { kind: 'click', ref: 'e1' });
    expect(out).toMatchObject({ ok: false, error: { code: 'browser_crashed' } });
    expect(text(out)).toContain('was not repeated');
    expect(env.driver.log.filter((l) => l === 'click e1')).toHaveLength(1);
    expect(trace().slice(-3)).toEqual([
      'browser.crash/crash/error',
      'browser.click/click/error',
      'browser.restart/restart/ok',
    ]);
  });

  it('opening a page is repeated after the restart', async () => {
    env.driver.current.crashOn = { call: 'goto', kind: 'page' };
    const out = await env.service.navigate(env.call(), 'https://b.example/');
    expect(out.ok, text(out)).toBe(true);
    expect(text(out)).toContain('restarted on https://a.example/');
    expect(env.driver.log.filter((l) => l.startsWith('goto')).slice(-3)).toEqual([
      'goto https://b.example/',
      'goto https://a.example/',
      'goto https://b.example/',
    ]);
    expect(env.driver.current.url()).toBe('https://b.example/');
  });

  it('a read and a screenshot are taken again; only a navigation is replayed', async () => {
    env.driver.current.crashOn = { call: 'snapshot', kind: 'page' };
    expect((await env.service.read(env.call())).ok).toBe(true);
    // A scroll is not a navigation: not repeated after the restart (docs/11 §10).
    env.driver.current.crashOn = { call: 'scroll', kind: 'page' };
    expect(await env.service.scroll(env.call(), 'down', 600)).toMatchObject({
      ok: false,
      error: { code: 'browser_crashed' },
    });
    expect(env.driver.log.filter((l) => l === 'scroll down 600')).toHaveLength(1);
    env.driver.current.crashOn = { call: 'screenshot', kind: 'page', event: false };
    // (the screenshot before the scroll's step is the first `screenshot` call)
    const shot = await env.service.screenshot(env.call(), false);
    expect(shot.ok, text(shot)).toBe(true);
  });

  it('an action on an element is never repeated: its refs are stale after a restart', async () => {
    expect((await env.service.read(env.call())).ok).toBe(true);
    env.driver.current.crashOn = { call: 'hover', kind: 'page' };
    expect(await env.service.hover(env.call(), 'e1')).toMatchObject({
      ok: false,
      error: { code: 'browser_crashed' },
    });
    expect(env.driver.log.filter((l) => l === 'hover e1')).toHaveLength(1);
    expect((await env.service.read(env.call())).ok).toBe(true);
    env.driver.current.crashOn = { call: 'screenshotElement', kind: 'page' };
    expect(await env.service.screenshot(env.call(), false, 'e1')).toMatchObject({
      ok: false,
      error: { code: 'browser_crashed' },
    });
  });

  it('a browser that keeps crashing is closed', async () => {
    for (let i = 0; i < BROWSER_MAX_RESTARTS; i++) {
      env.driver.current.crash('page');
      expect((await env.service.read(env.call())).ok).toBe(true);
    }
    env.driver.current.crash('page');
    const out = await env.service.read(env.call());
    expect(out).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    expect(text(out)).toContain(`crashed ${BROWSER_MAX_RESTARTS + 1} times`);
    expect(env.service.sessions(ACCOUNT)).toEqual([]);
    expect(audits('browser.session.restart_failed')[0]).toMatchObject({
      detail: { restarts: BROWSER_MAX_RESTARTS },
    });
  });

  it('crashes far apart are restarted every time (the limit is per 10 minutes)', async () => {
    await env.close();
    let clock = Date.parse('2026-10-17T10:00:00Z');
    env = await makeBrowserEnv({ now: () => new Date(clock) });
    env.driver.pages.set('https://a.example/', { title: 'A', text: 'a', elements: [] });
    await env.service.sites.put(ACCOUNT, { pattern: 'a.example', access: 'allow' });
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    for (let i = 0; i < BROWSER_MAX_RESTARTS + 2; i++) {
      env.driver.current.crash('page');
      const r = await env.service.read(env.call());
      expect(r.ok, text(r)).toBe(true);
      clock += 4 * 60_000;
    }
    expect(env.service.sessions(ACCOUNT)[0]!.restarts).toBe(BROWSER_MAX_RESTARTS + 2);
  });

  it('a browser that cannot start again is closed with the reason', async () => {
    env.driver.launchError = 'chromium is gone';
    env.driver.current.crash('browser');
    const out = await env.service.read(env.call());
    expect(out).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    expect(text(out)).toContain('could not start again: chromium is gone');
    expect(trace().at(-1)).toBe('browser.restart/restart/error');
    expect(env.service.sessions(ACCOUNT)).toEqual([]);
  });

  it('closing the browser on purpose is not a crash', async () => {
    const s = env.service.session(ACCOUNT, `thread-${THREAD}`)!;
    await env.service.closeSession(ACCOUNT, s.computerId);
    s.markCrashed('late event');
    expect(audits('browser.session.crashed')).toEqual([]);
  });

  it('page tools of the crashed page are gone after the restart', async () => {
    env.driver.current.register('lookup');
    expect(env.service.sessions(ACCOUNT)[0]!.pageTools).toEqual(['page:a.example.lookup']);
    env.driver.current.crash('page');
    expect((await env.service.read(env.call())).ok).toBe(true);
    expect(env.service.sessions(ACCOUNT)[0]!.pageTools).toEqual([]);
  });
});
