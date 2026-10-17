// The browser's Activity trace (FR-098, docs/11 §9): every action keeps before/after screenshots
// under blobs/screenshots/<day>/, a trace row and a persisted `browser.action` event with the
// call's correlation; targets are redacted and URLs lose their query; screenshots expire after the
// retention; the screenshot tool returns the image and an artifact. Downloads and uploads stay in
// the computer's files.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService, useBlobKey } from '../src/index.ts';
import { traceUrl } from '../src/browser/recorder.ts';
import { filesPath } from '../src/browser/service.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import { PNG } from './browser-fake.ts';

let env: BrowserEnv;
let clock: { now: number };

beforeEach(async () => {
  clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  env = await makeBrowserEnv({ now: () => new Date(clock.now) });
  env.driver.pages.set('https://docs.example/?token=abc', {
    title: 'Docs',
    text: 'docs',
    elements: [
      {
        role: 'button',
        tag: 'button',
        name: 'Copy key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      {
        role: 'link',
        tag: 'a',
        name: 'Report (PDF)',
        href: 'https://docs.example/report.pdf',
        download: { name: 'report.pdf', data: '%PDF-1.4 fake' },
      },
      {
        role: 'link',
        tag: 'a',
        name: 'Installer',
        href: 'https://docs.example/setup.exe',
        download: { name: 'setup.exe', data: 'MZ' },
      },
      { role: 'button', tag: 'input', inputType: 'file', name: 'Attach a file' },
    ],
  });
  await env.service.sites.put(ACCOUNT, {
    pattern: 'docs.example',
    access: 'allow',
    level: 'always_allow',
  });
});

afterEach(async () => {
  await env.close();
});

describe('the Activity trace', () => {
  it('records each action with before/after screenshots and a correlated event', async () => {
    const nav = env.call({ callId: 'call-nav' });
    expect((await env.service.navigate(nav, 'https://docs.example/?token=abc')).ok).toBe(true);
    await env.service.read(env.call());
    const click = await env.service.write(env.call({ callId: 'call-click' }), {
      kind: 'click',
      ref: 'e1',
    });
    expect(click.ok).toBe(true);
    const meta = click.ok
      ? (click.meta?.browserAction as { id: string; before: boolean; after: boolean })
      : null;
    expect(meta).toMatchObject({ before: true, after: true });
    const rows = env.service.recorder.list(ACCOUNT, { threadId: THREAD });
    expect(rows.map((r) => r.action)).toEqual(['navigate', 'click']);
    expect(rows[0]).toMatchObject({
      url: 'https://docs.example/',
      host: 'docs.example',
      result: 'ok',
      callId: 'call-nav',
      computerId: `thread-${THREAD}`,
    });
    expect(rows[1]!.target).toContain('[REDACTED');
    expect(rows[1]!.target).not.toContain('AAAAAAAA');
    const shot = env.service.recorder.screenshot(ACCOUNT, meta!.id, 'after');
    expect(shot.equals(PNG)).toBe(true);
    expect(existsSync(join(env.dir, 'data', 'blobs', 'screenshots', '20261001'))).toBe(true);
    const ev = env.events.events.filter((e) => e.name === 'browser.action');
    expect(ev.at(-1)).toMatchObject({
      ephemeral: false,
      correlation: { threadId: THREAD, callId: 'call-click', turnId: 'turn-1' },
      payload: expect.objectContaining({
        action: 'click',
        result: 'ok',
        before: true,
        after: true,
      }),
    });
    expect(env.service.recorder.list(ACCOUNT, { callId: 'call-click' })).toHaveLength(1);
    expect(env.service.recorder.list(ACCOUNT, { computerId: 'nope' })).toEqual([]);
    expect(() => env.service.recorder.screenshot('someone-else', meta!.id, 'after')).toThrow(
      /no such screenshot/,
    );
  });

  it('seals screenshots with the data key when encryption is on (docs/12 §5)', async () => {
    const dataDir = join(env.dir, 'data');
    useBlobKey(dataDir, randomBytes(32));
    try {
      expect((await env.service.navigate(env.call(), 'https://docs.example/?token=abc')).ok).toBe(
        true,
      );
      const day = join(dataDir, 'blobs', 'screenshots', '20261001');
      const files = readdirSync(day);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const raw = readFileSync(join(day, f));
        expect(raw.subarray(0, PNG.length).equals(PNG)).toBe(false);
      }
      const [row] = env.service.recorder.list(ACCOUNT);
      expect(env.service.recorder.screenshot(ACCOUNT, row!.id, 'after').equals(PNG)).toBe(true);
      // A sealed file moved to another action's path no longer opens.
      const [a, b] = files.map((f) => join(day, f));
      writeFileSync(b!, readFileSync(a!));
      const other = files[1]!.replace(/-(before|after)\.png$/, '');
      const which = files[1]!.endsWith('-before.png') ? 'before' : 'after';
      expect(() => env.service.recorder.screenshot(ACCOUNT, other, which)).toThrow();
    } finally {
      useBlobKey(dataDir, null);
    }
  });

  it('deletes screenshots after the retention, keeping the trace rows', async () => {
    expect((await env.service.navigate(env.call(), 'https://docs.example/?token=abc')).ok).toBe(
      true,
    );
    const [row] = env.service.recorder.list(ACCOUNT);
    expect(await env.service.sweep()).toBe(0);
    clock.now += 31 * 86_400_000;
    expect(await env.service.sweep()).toBe(2);
    expect(env.service.recorder.list(ACCOUNT)[0]).toMatchObject({
      id: row!.id,
      before: false,
      after: false,
    });
    expect(() => env.service.recorder.screenshot(ACCOUNT, row!.id, 'before')).toThrow();
  });

  it('the screenshot tool returns the image and saves an artifact', async () => {
    await env.close();
    clock = { now: Date.now() };
    env = await makeBrowserEnv();
    const artifacts = new ArtifactService({
      db: env.db,
      events: env.events,
      dataDir: join(env.dir, 'data'),
    });
    env.service.useArtifacts(artifacts);
    env.driver.pages.set('https://docs.example/', { title: 'Docs', text: 'd', elements: [] });
    await env.service.sites.put(ACCOUNT, { pattern: 'docs.example', access: 'allow' });
    expect((await env.service.navigate(env.call(), 'https://docs.example/')).ok).toBe(true);
    const out = await env.service.screenshot(env.call(), true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content.find((c) => c.type === 'image')).toMatchObject({ mime: 'image/png' });
    expect(out.meta?.artifact).toMatchObject({ kind: 'image' });
    expect((await artifacts.list(ACCOUNT, THREAD))[0]!.title).toContain('docs.example');
    expect(env.events.events.some((e) => e.name === 'browser.screenshot' && e.ephemeral)).toBe(
      true,
    );
  });

  it('trace URLs drop the query; file paths stay inside the computer', () => {
    expect(traceUrl('https://a.example/p?code=secret#x')).toBe('https://a.example/p');
    expect(traceUrl(null)).toBeNull();
    expect(filesPath('Downloads/a.pdf')).toBe('Downloads/a.pdf');
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', '', 'a\0b'])
      expect(filesPath(bad)).toBeNull();
  });
});

describe('files', () => {
  it("downloads into the computer's files; programs ask first; uploads send a file", async () => {
    expect((await env.service.navigate(env.call(), 'https://docs.example/?token=abc')).ok).toBe(
      true,
    );
    await env.service.read(env.call());
    const dl = await env.service.download(env.call(), 'e2', undefined);
    expect(dl.ok && dl.content[0]).toMatchObject({
      text: expect.stringContaining('Downloads/report.pdf'),
    });
    const files = join(env.dir, 'data', 'browser', 'files');
    expect(existsSync(files)).toBe(true);
    const exe = env.service.download(env.call(), 'e3', 'tools/setup.exe');
    const a = await env.answer('deny_continue');
    expect(a.tier).toBe('confirm_at_action');
    expect(await exe).toMatchObject({ ok: false });
    expect(await env.service.download(env.call(), 'e2', '../escape')).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    // Upload from the computer's files: it sends the file, so it asks.
    const dir = env.driver.launches[0]!.profileDir.replace(/profiles/, 'files');
    mkdirSync(join(dir, 'Docs'), { recursive: true });
    writeFileSync(join(dir, 'Docs', 'cv.txt'), 'hello');
    const up = env.service.upload(env.call(), 'e4', 'Docs/cv.txt');
    await env.answer('allow_once');
    const r = await up;
    expect(r.ok).toBe(true);
    expect(env.driver.log).toContain('upload e4 cv.txt:5');
  });
});
