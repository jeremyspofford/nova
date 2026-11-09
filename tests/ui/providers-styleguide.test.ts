// Providers and models, design-first (2026-11-09; ui/js/sg-providers.js): the styleguide entry for
// the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's) and none in a row, at most one primary control. The words are the real
// model's: it lives in Settings › Models and providers; each check answer is the backend's own; only
// a provider with an address has Check now; the callback token shows once and never again, not even
// a hint; keys are vault names, never values; there is no warm-up control and no price list Nova can
// show. On a phone (390×844) and a Duo's cover screen (380×900) each frame is one column filling the
// screen: one pane, full width, down to the foot, no dead band. With NOVA_UI_SHOTS set
// (scripts/ui-test.sh), Chromium writes the owner's screenshots.
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

const FRAMES = ['overview', 'provider', 'check-ok', 'check-unreachable', 'check-no-model', 'check-key', 'check-held', 'not-installed', 'callback-once', 'callback-after', 'callback-rotate', 'policy', 'policy-allow', 'roles', 'wake', 'wake-failed', 'cloud', 'cloud-set', 'prices'];
const NARROW_FRAMES = ['overview', 'provider', 'check-unreachable', 'callback-once', 'roles', 'cloud'];
const LIGHT_TOO = new Set(['overview', 'provider', 'roles']);
const IN_SETTINGS = new Set(['overview', 'policy', 'policy-allow', 'roles', 'wake', 'wake-failed', 'cloud', 'cloud-set', 'prices']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
// The demo callback token the once frame shows (sg-providers.js DEMO_TOKEN): nowhere else.
const DEMO_TOKEN = 'Hd3kQ9vL2xW7nB4tR8mZ1cY6pF0sJ5gA-uE2oK7iN3w';

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-pv-styleguide-'));
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
  await page.locator('[data-pv-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-pv-icon]').length > 0 && [...document.querySelectorAll('[data-pv-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-pv-frame], [data-pv-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-pv-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-pv-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-pv-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-pv-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.pv-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-pv-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-pv-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-pv-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's states and the backend's own words, and nothing it lacks.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-pv-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  const html = await f.innerHTML();
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const button = (name: string | RegExp) => f.getByRole('button', { name });
  // No secret value anywhere: keys are vault names; the demo token is only in the frame that shows it once.
  assert.equal(html.includes(DEMO_TOKEN), frame === 'callback-once', `${label}: the callback token only where it is shown once`);
  assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]|Bearer /, `${label}: no key drawn`);
  // Nothing the backend doesn't have: no warm-up control, no price list read back.
  assert.equal(await button(/warm/i).count(), 0, `${label}: no warm-up button`);
  if (IN_SETTINGS.has(frame)) {
    // It lives in Settings: Models and providers, under What Nova works with, current.
    assert.equal(await f.locator('.uc-title').innerText(), 'Settings', `${label}: Settings`);
    const row = f.locator('nav[aria-label="Settings categories"] a[aria-current="true"]');
    assert.equal(await row.count(), 1, `${label}: one current category`);
    assert.match(await row.innerText(), /Models and providers/, `${label}: Models and providers`);
    assert.equal(await f.locator('nav[aria-label="Settings categories"] ul[aria-labelledby$="-g1"] a[aria-current="true"]').count(), 1, `${label}: under What Nova works with`);
    assert.equal(await f.locator('.uc-rail').count(), 0, `${label}: no new place in a rail`);
  } else {
    assert.equal(await f.locator('.au-list .pv-list > li').count(), 6, `${label}: the six built-in providers`);
  }
  if (frame === 'overview') {
    for (const s of ['Providers · 2 of 6 on', 'Not installed. Nova can’t find codex on this computer.', 'Installed.', 'This month: $3.42 of $20.00', 'There is no transcription runtime on your devices']) has(s);
  }
  if (frame === 'provider') { has('Not checked yet.'); assert.equal(await button('Check now').count(), 1, `${label}: Check now`); }
  if (frame === 'check-ok') { has('Reachable at 127.0.0.1:11434.'); has('Checked at 14:02'); }
  if (frame === 'check-unreachable') has('Unreachable. Nova couldn’t reach 127.0.0.1:11434: connect ECONNREFUSED 127.0.0.1:11434.');
  if (frame === 'check-no-model') has('127.0.0.1:11434 answers, but has no model called qwen3:14b');
  if (frame === 'check-key') { has('api.example.com turned down the key'); has('secret://EXAMPLE_KEY, a name in the vault'); }
  if (frame === 'check-held') { has('your privacy setting keeps Nova from reaching it'); assert.equal(await button('Check now').count(), 0, `${label}: nothing to press`); }
  if (frame === 'not-installed') {
    has('Nova can’t find codex on this computer.');
    assert.equal(await button('Check now').count(), 0, `${label}: nothing to check`);
    assert.ok(await button('Turn on').isDisabled(), `${label}: it can’t be turned on`);
  }
  if (frame === 'callback-once') {
    has('Nova keeps only a hash of it and won’t show it again.'); has('x-nova-hook-token');
    assert.equal((await f.getByLabel(/Callback token/).inputValue()).length, 43, `${label}: the token’s shape`);
  }
  if (frame === 'callback-after' || frame === 'callback-rotate') { has('can’t show it, or any part of it, again'); assert.ok(!/Ends in/i.test(text), `${label}: no hint`); }
  if (frame === 'callback-rotate') has('The old token stops working now');
  if (frame === 'policy' || frame === 'policy-allow') { has('A task can be stricter than this, never looser.'); has('your own network included, counts as the cloud'); }
  if (frame === 'policy') has('Nova asks before running them.');
  if (frame === 'policy-allow') assert.ok(await button('Allow').isDisabled(), `${label}: Allow waits for the box`);
  if (frame === 'roles') for (const s of ['Sorting', 'Thinking and writing', 'Finding by meaning', 'Transcription']) has(s);
  if (frame === 'wake') { has('Asleep, wakeable'); has('No warm-up yet'); assert.equal(await button('Wake it now').count(), 1, `${label}: Wake it now`); }
  if (frame === 'wake-failed') {
    has('didn’t answer');
    assert.equal(await button('Try waking it again').count(), 1, `${label}: try again`);
    assert.equal(await button('Use the cloud model this once').count(), 1, `${label}: cloud once`);
  }
  if (frame === 'cloud') { has('Yours now'); has('secret://CLOUD_KEY'); }
  if (frame === 'cloud-set') { has('Setting a cloud model lets local-preferred and cloud-allowed work go to api.other.example.'); assert.ok(await button('Save').isDisabled(), `${label}: Save waits for the box`); }
  if (frame === 'prices') { has('Nova can’t list your prices yet'); has('it reported tokens but no price'); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Providers and models styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=providers&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-pv-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=providers`, theme);
              assert.equal(await p.locator('[data-pv-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The confirmation box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-pv-frame="policy-allow"] form');
              await form.locator('input[name="confirm"]').check();
              const allow = form.getByRole('button', { name: 'Allow' });
              assert.equal(await allow.isDisabled(), false, 'the box enables Allow');
              await allow.click();
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
