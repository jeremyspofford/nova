// Messages and quiet hours, design-first (2026-11-09; ui/js/sg-inbox.js): the styleguide entry for
// the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's) and none in a message row, at most one primary control. The words are
// the real model's: unread, read, held and needs-your-OK rows, each with its source; the withdrawn
// Coding message is absent once quiet hours end. On a phone (390×844) and a Duo's cover screen
// (380×900) each frame is one column filling the screen: one pane, full width, down to the foot, no
// dead band. With NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the owner's screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, device, shortTargets, shotsDir, still, watchCsp, webkitBrowser } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const FRAMES = ['list', 'empty', 'open', 'held', 'released', 'quiet-edit', 'quiet-invalid', 'quiet-confirm'];
const NARROW_FRAMES = ['list', 'open', 'held', 'quiet-edit'];
const LIGHT_TOO = new Set(['list']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ib-styleguide-'));
  chmodSync(dir, 0o700);
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    const home = join(dir, 'nova');
    const user = join(dir, 'user');
    mkdirSync(user, { mode: 0o700 });
    ensureMark(home, { userHome: user });
    nova = createNova(loadConfig({ HOME: user, NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
    const server = nova.server;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (nova) {
      nova.scheduler.stop();
      nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>((done) => nova!.server.close(() => done()));
      await nova.core.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function open(page: Page, url: string, theme: string) {
  await page.goto(`${url}&ds=nebula&mode=${theme}`);
  await page.waitForSelector(`html[data-sg-preview="nebula-${theme}"]`);
  await page.locator('[data-ib-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-ib-icon]').length > 0 && [...document.querySelectorAll('[data-ib-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ib-frame], [data-ib-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-ib-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-ib-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ib-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The status icon shows agent state: the top bar's, once per frame, and never in a message row.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-ib-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.ib-msg .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-ib-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per message`);
  // One standout per view: at most one primary control visible in a frame.
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-ib-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ib-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's states and sources, and the targets they lead to.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-ib-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  const has = (s: string) => assert.ok(text.includes(s), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.includes(s), `${label}: doesn’t say “${s}”`);
  const rows = async (state: string) => f.locator('.ib-msg .au-state', { hasText: state }).count();
  if (frame === 'empty') { has('No messages yet'); assert.equal(await f.locator('.ib-msg').count(), 0, `${label}: no rows`); return; }
  // The quiet-hours row leads to the editor; a waiting OK is in every frame that has messages.
  assert.equal(await f.locator('a.ib-quiet[href$="-quiet"]').count(), 1, `${label}: the quiet-hours row`);
  assert.equal(await rows('Needs your OK'), 1, `${label}: one message waits for your OK`);
  if (frame === 'list') {
    assert.equal(await rows('Unread'), 2, `${label}: two unread`);
    assert.equal(await f.locator('.ib-msg:not(.is-new)').count(), 2, `${label}: two read`);
    for (const s of ['Front door left open', 'Network', 'Infrastructure', 'Timesheet reminder', 'Coding']) has(s);
    assert.equal(await f.getByRole('button', { name: 'Let it through' }).count(), 1, `${label}: Let it through`);
    assert.equal(await f.getByRole('link', { name: 'See the automation “Front door left open”' }).count(), 1, `${label}: the automation it came from`);
  }
  if (frame === 'open') { has('Just now, when you opened it'); assert.equal(await f.getByRole('link', { name: 'Go to Tasks' }).count(), 1, `${label}: Go to Tasks`); }
  if (frame === 'held') {
    has('Quiet hours, until 07:00');
    assert.equal(await rows('Held'), 3, `${label}: three held`);
    has('Quiet hours: the message waits until they end.');
    assert.equal(await f.getByRole('link', { name: 'Change quiet hours' }).count(), 1, `${label}: Change quiet hours`);
  }
  if (frame === 'released') {
    assert.equal(await rows('Held'), 0, `${label}: nothing held`);
    has('07:00, when quiet hours ended');
    lacks('Speed up the search index');
  }
  if (frame === 'quiet-edit' || frame === 'quiet-invalid') {
    assert.equal(await f.getByLabel('From').count(), 1, `${label}: From`);
    assert.equal(await f.getByLabel('Until').count(), 1, `${label}: Until`);
  }
  if (frame === 'quiet-edit') { has('Every day from 22:30 to 06:30'); assert.equal(await f.getByRole('button', { name: 'Save quiet hours' }).count(), 1, `${label}: Save`); }
  if (frame === 'quiet-invalid') { assert.equal(await f.locator('[aria-invalid="true"]').count(), 2, `${label}: both times marked`); has('The start and the end are the same time.'); }
  if (frame === 'quiet-confirm') { has('22:30–06:30'); assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Messages and quiet hours styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    const dir = engine === 'chromium' ? shotsDir() : null;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const runs: [keyof typeof SIZES, string, string[]][] = [['desktop', 'dark', FRAMES], ['desktop', 'light', FRAMES.filter((f) => LIGHT_TOO.has(f))], ['phone', 'dark', NARROW_FRAMES], ['phone', 'light', NARROW_FRAMES], ['duo', 'dark', NARROW_FRAMES], ['duo', 'light', NARROW_FRAMES]];
        for (const [size, theme, frames] of runs) {
          const s = SIZES[size];
          const d = await device(b!, { width: s.width, height: s.height, touch: s.touch, scheme: theme as 'light' | 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const csp = await watchCsp(p);
          const sent: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) sent.push(`${r.method()} ${r.url()}`); });
          try {
            for (const frame of frames) {
              const label = `${engine}/${s.name}/${theme}/${frame}`;
              await open(p, `${base}/styleguide?entry=inbox&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-ib-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=inbox`, theme);
              assert.equal(await p.locator('[data-ib-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-ib-frame="quiet-confirm"] form');
              await form.locator('input[name="confirm"]').check();
              const confirm = form.getByRole('button', { name: 'Confirm with passkey' });
              assert.equal(await confirm.isDisabled(), false, 'the box enables the passkey button');
              await confirm.click();
              assert.equal(await form.getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
              assert.deepEqual(await csp(), [], `${engine}/${theme}/entry: no Content-Security-Policy violation`);
            }
            assert.deepEqual(sent, [], `${engine}/${s.name}/${theme}: the compositions send nothing`);
            assert.deepEqual(d.errors, [], `${engine}/${s.name}/${theme}: no page errors`);
          } finally {
            await d.ctx.close();
          }
        }
      });
    } finally { await b?.close(); }
  });
}
