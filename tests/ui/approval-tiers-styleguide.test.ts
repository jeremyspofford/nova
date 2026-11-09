// Approvals in Settings, design-first (2026-11-09; ui/js/sg-approval-tiers.js): the styleguide entry
// for the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's), at most one primary control, and no amber or red outside needs-you.
// The words are the real model's: Approvals sits in Settings › Privacy and permissions; Home
// Assistant is the one part with tier settings (service_tier, tier3_domains); lowering quotes the
// route's own words and, on Nova's own screen, waits for the box and a passkey; a paired phone's
// loosening is flagged; the outside-content guard lists src/runner.js's steps and has no switch;
// Nova never presses pay; proposals say they need backend work and offer no live control. On a
// phone (390×844) and a Duo's cover screen (380×900) each frame is one column filling the screen.
// With NOVA_UI_SHOTS set (NOVA_UI_SHOTS=docs/screenshots/tier-settings-compositions-2026-11-09
// scripts/ui-test.sh), Chromium writes the owner's screenshots.
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
import { GUARDED } from '../../src/runner.js';

const FRAMES = ['door', 'overview', 'home-assistant', 'raise', 'lower', 'lower-device', 'guard', 'fixed', 'chat-steps', 'proposed'];
const NARROW_FRAMES = ['door', 'overview', 'home-assistant', 'lower', 'lower-device', 'guard', 'proposed'];
const LIGHT_TOO = new Set(['overview', 'home-assistant', 'lower']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ap-styleguide-'));
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
  await page.locator('[data-ap-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-ap-icon]').length > 0 && [...document.querySelectorAll('[data-ap-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ap-frame], [data-ap-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-ap-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-ap-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ap-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The status icon shows agent state: the top bar's, once per frame.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-ap-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-ap-frame]')].map(() => [1, 1])), `${label}: one status icon, the top bar's`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-ap-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
  // No popovers, no overflow menus.
  assert.equal(await page.locator('[data-ap-frame] :is([popover], details, [aria-haspopup], dialog)').count(), 0, `${label}: no popovers or menus`);
  // A tier is words, never a colour: no step, kind or tag is drawn in amber or red.
  assert.deepEqual(await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const warn = [css.getPropertyValue('--status-attention').trim(), css.getPropertyValue('--status-error').trim()].filter(Boolean);
    const probe = document.createElement('span');
    document.body.append(probe);
    const rgb = warn.map((c) => { probe.style.color = c; return getComputedStyle(probe).color; });
    probe.remove();
    return [...document.querySelectorAll<HTMLElement>('[data-ap-frame] :is(.ap-tier, .ap-how, .ap-kind, .ap-cap-name, .au-state, .au-meta)')].filter((e) => rgb.includes(getComputedStyle(e).color)).map((e) => e.textContent);
  }), [], `${label}: no amber or red on a tier`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ap-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's tiers, settings and words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-ap-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  // Approvals is inside Privacy and permissions: one current category, under You.
  assert.equal(await f.locator('.uc-title').innerText(), 'Settings', `${label}: Settings`);
  const row = f.locator('nav[aria-label="Settings categories"] a[aria-current="true"]');
  assert.equal(await row.count(), 1, `${label}: one current category`);
  assert.match(await row.innerText(), /Privacy and permissions/, `${label}: Privacy and permissions`);
  assert.equal(await f.locator('nav[aria-label="Settings categories"] ul[aria-labelledby$="-g0"] a[aria-current="true"]').count(), 1, `${label}: under You`);
  if (frame === 'door' || frame === 'overview') {
    for (const s of ['Just does it', 'Does it and tells you', 'Asks first', 'Confirms every time', 'You can change this', 'Your ruling, 9 November', 'Fixed for now', 'Fixed by design', 'Nova never presses pay']) has(s);
    for (const s of ['Home Assistant', 'Steps in a conversation', 'Nova’s browser', 'The vault', 'Coding', 'Infrastructure', 'Your network', 'Nova’s computer', 'Providers', 'Nova’s own releases']) has(s);
    // Only Home Assistant and the conversation switches are settings today.
    const settable = await f.locator('.ap-cap').evaluateAll((caps) => caps.filter((c) => c.querySelector('[data-how="setting"]')).map((c) => c.querySelector('.ap-cap-name')?.textContent));
    assert.deepEqual(settable, ['Home Assistant', 'Steps in a conversation'], `${label}: the two real settings`);
  }
  if (frame === 'home-assistant' || frame === 'raise') {
    assert.equal(await f.getByRole('radio').count(), 2, `${label}: service_tier is 1 or 2`);
    has('Confirm these every time');
    assert.equal(await f.getByRole('checkbox', { name: /lock/ }).count(), 1, `${label}: a kind is its domain`);
    has('an automation or a schedule starts');
  }
  if (frame === 'home-assistant') {
    assert.equal(await f.getByRole('radio', { name: /Does it and tells you/ }).isChecked(), true, `${label}: tier 1 by default`);
    assert.equal(await f.getByRole('checkbox', { checked: true }).count(), 0, `${label}: no kind marked by default`);
  }
  if (frame === 'raise') has('saved without a confirmation');
  if (frame === 'lower' || frame === 'lower-device') {
    has('Lowering the service tier to 1 means Nova changes your home when you ask, without waiting for your OK');
    has('Loosens: confirms first');
  }
  if (frame === 'lower') assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  if (frame === 'lower-device') {
    assert.equal(await f.getByRole('button', { name: 'Confirm with passkey' }).count(), 0, `${label}: no passkey on a paired phone`);
    has('your ruling, 2026-11-09');
  }
  if (frame === 'guard') {
    for (const g of Object.values(GUARDED) as string[]) has(g);
    assert.equal(await f.locator('input, [role="switch"]').count(), 0, `${label}: no switch`);
    has('Why no switch');
  }
  if (frame === 'fixed') { has('Nova never presses pay'); has('It never presses pay.'); }
  if (frame === 'chat-steps') { has('permissions.md'); assert.equal(await f.getByRole('switch').count(), 6, `${label}: one switch per kind`); has('with no confirmation'); }
  if (frame === 'proposed') {
    has('None of these is a setting yet'); has('SEND_TIER');
    assert.ok(await f.getByRole('radio').evaluateAll((rs) => rs.length > 0 && rs.every((r) => (r as HTMLInputElement).disabled)), `${label}: proposals offer no live control`);
  }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Approvals styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=approval-tiers&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-ap-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=approval-tiers`, theme);
              assert.equal(await p.locator('[data-ap-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The box enables the passkey button, locally; pressing it sends nothing.
              const form = p.locator('[data-ap-frame="lower"] form');
              await form.locator('input[name="confirm"]').check();
              const confirm = form.getByRole('button', { name: 'Confirm with passkey' });
              assert.equal(await confirm.isDisabled(), false, 'the box enables the passkey button');
              await confirm.click();
              assert.equal(await form.getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
              // A switch flips its own words, and nothing else.
              const sw = p.locator('[data-ap-frame="chat-steps"] [role="switch"]').first();
              await sw.click();
              assert.equal(await sw.getAttribute('aria-checked'), 'true', 'the switch turns on');
              assert.equal((await sw.innerText()).trim(), 'Without asking', 'and says so');
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
