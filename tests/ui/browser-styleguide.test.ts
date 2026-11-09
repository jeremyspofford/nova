// Nova's browser, design-first (2026-11-09; ui/js/sg-browser.js): the styleguide entry for the
// owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and WebKit,
// with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds the
// house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's) and none in a row, at most one primary control. The words are the real
// model's: a task names the sites it may visit and signs in with the one sign-in saved for that
// site, never shown; there is a live picture, and only Nova's own screen and approving devices act on
// it; a checkout asks every time and stops at the total; a flow lists its shape, not its steps, and
// has no edit or retire; there is no planner from words. Failures quote the backend's own words. On a
// phone (390×844) and a Duo's cover screen (380×900) each frame is one column filling the screen:
// one pane, full width, down to the foot, no dead band. With NOVA_UI_SHOTS set (scripts/ui-test.sh),
// Chromium writes the owner's screenshots.
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

const FRAMES = ['door', 'door-empty', 'no-chromium', 'start', 'start-words', 'approve', 'running', 'needs-you', 'done', 'failed', 'flows', 'flows-empty', 'sites', 'forget-confirm'];
const NARROW_FRAMES = ['door', 'start', 'approve', 'running', 'needs-you', 'flows'];
const LIGHT_TOO = new Set(['door', 'running', 'flows']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-bw-styleguide-'));
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
  await page.locator('[data-bw-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-bw-icon]').length > 0 && [...document.querySelectorAll('[data-bw-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-bw-frame], [data-bw-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-bw-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-bw-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-bw-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-bw-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.bw-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-bw-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-bw-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-bw-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

const DOOR = new Set(['door', 'door-empty', 'no-chromium']);

// What each frame must say: the real model's reach, sign-ins, tiers and gaps, and the backend's words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-bw-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  // Nothing the backend doesn't have: no pay button, no flow editor, no account picker, no
  // password shown back.
  for (const s of ['Pay now', 'Edit the flow', 'Edit step', 'Delete the flow', 'Choose an account', 'Show password']) lacks(s);
  assert.equal(await f.locator('input[type="password"][value]:not([value=""])').count(), 0, `${label}: no saved value in a field`);
  if (DOOR.has(frame)) {
    // The door: one Settings category, under What Nova works with, current, with its state beneath.
    assert.equal(await f.locator('.uc-title').innerText(), 'Settings', `${label}: Settings`);
    const row = f.locator('nav[aria-label="Settings categories"] a[aria-current="true"]');
    assert.equal(await row.count(), 1, `${label}: one current category`);
    assert.match(await row.innerText(), /Nova’s browser/, `${label}: the door is Nova’s browser`);
    assert.equal(await f.locator('nav[aria-label="Settings categories"] ul[aria-labelledby$="-g1"] a[aria-current="true"]').count(), 1, `${label}: under What Nova works with`);
    assert.equal(await f.locator('.uc-rail').count(), 0, `${label}: no new place in a rail`);
  }
  if (frame === 'door') { has('Ready · 3 flows, 3 sites, nothing running'); has('Chromium at /usr/bin/chromium.'); assert.equal(await f.getByRole('link', { name: 'Start a task' }).count(), 1, `${label}: Start a task`); }
  if (frame === 'door-empty') { has('Nothing has run in Nova’s browser yet'); has('Ready · no flows or sites yet'); }
  if (frame === 'no-chromium') { has('Browser work is unavailable: Nova found no Chromium on this machine. Install Chromium, or set NOVA_CHROMIUM to its path.'); lacks('Start a task'); }
  if (frame === 'start') {
    for (const l of ['Flow', 'Sites it may visit', 'The page that shows it worked', 'What it must show']) assert.equal(await f.getByLabel(l, { exact: true }).count(), 1, `${label}: ${l}`);
    has('The sign-in saved for shop.example.com: there is one per site');
    has('It is never shown, here or in chat.');
    has('It asks every time (tier 3), because it ends at a checkout.');
    assert.equal(await f.getByRole('radio', { name: /Nova’s own/ }).isChecked(), true, `${label}: Nova’s own profile by default`);
    assert.equal(await f.locator('select option[disabled]').count(), 1, `${label}: a flow being checked can’t be picked`);
  }
  if (frame === 'start-words') { has('Not possible yet'); has('an account change only'); assert.equal(await f.locator('textarea').count(), 0, `${label}: no box that would do nothing`); }
  if (frame === 'approve' || frame === 'forget-confirm') {
    has('every time');
    assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  }
  if (frame === 'approve') { has('Waiting for your OK'); has('Signs in with'); has('shop.example.com only'); }
  if (frame === 'running') {
    has('Nova is working. Step 3 of 7: fill in the delivery address.');
    has('Only Nova’s own screen, or a device you’ve allowed to approve, can pause, stop or take over.');
    for (const b of ['Take over', 'Pause', 'Stop']) assert.equal(await f.getByRole('button', { name: b, exact: true }).count(), 1, `${label}: ${b}`);
    has('ads.example.net');
  }
  if (frame === 'needs-you') { has('Needs you'); has('Nova never solves one: take over, do it, then hand back.'); assert.equal(await f.getByRole('button', { name: 'Take over' }).count(), 1, `${label}: Take over`); }
  if (frame === 'done') { has('Paying is yours: Nova never presses pay.'); has('Refused 1 host the task didn’t declare: ads.example.net.'); lacks('Retry'); }
  if (frame === 'failed') { has('There is no sign-in saved for parcels.example.com.'); has('Nova doesn’t run it again by itself'); }
  if (frame === 'flows') {
    has('browser-site.shop.example.com.reorder-paper');
    has('Seeing its steps: Nova keeps them, but lists only how many.');
    assert.equal(await f.getByRole('link', { name: 'Run it' }).count(), 1, `${label}: Run it`);
  }
  if (frame === 'flows-empty') { has('No flows yet'); has('inputs.learn'); }
  if (frame === 'sites') { has('Sign-in saved'); has('The one saved now isn’t shown.'); assert.equal(await f.getByLabel('Password', { exact: true }).inputValue(), '', `${label}: the password field is empty`); }
  if (frame === 'forget-confirm') { has('Forget shop.example.com?'); assert.equal(await f.getByRole('checkbox', { name: 'Also delete its saved sign-in' }).isChecked(), true, `${label}: its sign-in too, by default`); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Nova's browser styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=browser-tasks&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-bw-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=browser-tasks`, theme);
              assert.equal(await p.locator('[data-bw-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-bw-frame="forget-confirm"] form');
              await form.locator('input[name="confirm"]').check();
              const confirm = form.getByRole('button', { name: 'Confirm with passkey' });
              assert.equal(await confirm.isDisabled(), false, 'the box enables the passkey button');
              await confirm.click();
              assert.equal(await form.getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
              // So does Take over.
              const take = p.locator('[data-bw-frame="running"]').getByRole('button', { name: 'Take over' });
              await take.click();
              assert.equal(await p.locator('[data-bw-frame="running"]').getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'Take over is a demo');
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
