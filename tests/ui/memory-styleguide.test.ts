// Core memory, design-first (2026-11-09; ui/js/sg-memory.js): the styleguide entry for the owner's
// reaction draws every frame, full screen, in Nebula light and dark, in Chromium and WebKit, with no
// Content-Security-Policy violation, no page error and nothing sent. Each frame holds the house rules:
// no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one status icon (the
// top bar's) and none in a row, at most one primary control. The words are the real model's: search
// matches words, not meaning; Nova reads a memory whether or not it is confirmed; a correction keeps
// the old wording, marked corrected; export writes memory.json and memory.md on the computer Nova
// runs on, with no download; the memory gate is off by default and has no switch in Settings; each
// failure quotes the backend's own words. On a phone (390×844) and a Duo's cover screen (380×900)
// each frame is one column filling the screen: one pane, full width, down to the foot, no dead band.
// With NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the owner's screenshots.
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

const FRAMES = ['list', 'search', 'search-empty', 'search-no-words', 'memory', 'history', 'review', 'waiting-gate-off', 'waiting-gate-on', 'correct', 'correct-empty', 'correct-conflict', 'export', 'export-done', 'export-failed', 'not-answering', 'empty'];
const NARROW_FRAMES = ['list', 'search', 'memory', 'waiting-gate-on', 'correct', 'export-done'];
const LIGHT_TOO = new Set(['list', 'search', 'memory']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-mm-styleguide-'));
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
  await page.locator('[data-mm-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-mm-icon]').length > 0 && [...document.querySelectorAll('[data-mm-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mm-frame], [data-mm-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-mm-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mm-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The status icon shows agent state: the top bar's, once per frame, never in a row.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-mm-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.mm-list .status-icon, .mm-cards .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-mm-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-mm-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mm-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's states and limits, and the backend's own words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-mm-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  assert.equal(await f.locator('.uc-title').innerText(), 'Memory', `${label}: the Memory view`);
  // Nothing the backend doesn't have: no download, no meaning search, no gate switch, no import here.
  assert.equal(await f.getByRole('button', { name: /download/i }).count() + await f.getByRole('link', { name: /download/i }).count(), 0, `${label}: no download control`);
  assert.equal(await f.getByRole('checkbox').count() + await f.getByRole('switch').count(), 0, `${label}: no gate switch`);
  for (const s of ['similar meaning', 'semantic', 'Import a file', 'Nova only reads confirmed']) lacks(s);
  if (frame === 'list') { has('7 memories Nova holds now'); has('Waiting for your OK · 1'); has('Not yet reviewed · 3'); has('People, places and things'); assert.equal(await f.getByRole('searchbox', { name: 'Search memory' }).count(), 1, `${label}: search`); }
  if (frame === 'search') {
    has('2 memories share a word with “calendar”');
    has('It doesn’t look at meaning');
    has('Use email for family plans.');
    assert.equal(await f.getByRole('searchbox', { name: 'Search memory' }).inputValue(), 'calendar', `${label}: the query`);
  }
  if (frame === 'search-empty') has('Nothing Nova remembers has the word “dentist”.');
  if (frame === 'search-no-words') has('search skips words like what, you and about');
  if (frame === 'memory') {
    for (const s of ['Not yet reviewed', 'Nova kept it from the conversation “Morning plan”', 'Low, 0.4', 'Nova reads it either way; confirming only marks it as right.', 'Dec 31']) has(s);
    assert.equal(await f.getByRole('button', { name: 'Confirm it’s right' }).count(), 1, `${label}: Confirm`);
    assert.equal(await f.getByRole('link', { name: 'Correct it' }).count(), 1, `${label}: Correct`);
    assert.equal(await f.getByRole('link', { name: 'Open “Morning plan” at that turn' }).count(), 1, `${label}: its source opens`);
  }
  if (frame === 'history') { has('Use the shared calendar for family plans, not email.'); has('Use email for family plans.'); has('A correction never rewrites'); assert.equal(await f.getByRole('button', { name: 'Confirm it’s right' }).count(), 0, `${label}: nothing to confirm on the person’s own`); }
  if (frame === 'review') { has('Not yet reviewed · 3'); assert.equal(await f.getByRole('button', { name: 'Confirm' }).count(), 3, `${label}: Confirm each`); }
  if (frame === 'waiting-gate-off') { has('The memory gate is off, as it is by default.'); has('rail.example.com'); has('There is no switch for it in Settings yet.'); assert.equal(await f.getByRole('button', { name: 'Keep' }).count(), 1, `${label}: one to keep`); }
  if (frame === 'waiting-gate-on') { has('The memory gate is on.'); has('It may conflict with what Nova remembers: “Takes coffee with oat milk.”'); assert.equal(await f.getByRole('button', { name: 'Keep' }).count(), 2, `${label}: two to keep`); }
  if (frame === 'correct') { assert.equal(await f.getByLabel('What’s true now').count(), 1, `${label}: the field`); has('The old wording is kept, marked corrected'); }
  if (frame === 'correct-empty') { has('An entry needs some words. To remove it, forget it instead.'); assert.equal(await f.getByLabel('What’s true now').getAttribute('aria-invalid'), 'true', `${label}: the field says so`); }
  if (frame === 'correct-conflict') { has('That memory has already been corrected; correct the newer one'); has('Nothing changed.'); }
  if (frame === 'export') { has('memory.json'); has('memory.md'); has('aren’t encrypted'); has('not the earlier wording of corrected memories, not day notes'); }
  if (frame === 'export-done') { has('Wrote 7 memories'); has('~/Nova/exports/memory-2026-11-09T14-02-11-000Z/'); has('No download yet'); has('Exported 2026-11-09T14:02:11.000Z. 7 records.'); }
  if (frame === 'export-failed') { has('Something went wrong inside Nova. It has been recorded as a problem.'); has('Your memories didn’t change.'); }
  if (frame === 'not-answering') has('Nova’s server didn’t answer, so memory can’t be read right now.');
  if (frame === 'empty') { has('Nothing kept yet.'); assert.equal(await f.getByRole('link', { name: 'Tell Nova something to remember' }).count(), 1, `${label}: one next step`); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Memory styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=memory-surface&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-mm-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=memory-surface`, theme);
              assert.equal(await p.locator('[data-mm-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // A demo button says it is a demo; pressing it sends nothing.
              const confirm = p.locator('[data-mm-frame="memory"]').getByRole('button', { name: 'Confirm it’s right' });
              await confirm.click();
              assert.equal(await p.locator('[data-mm-frame="memory"]').getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
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
