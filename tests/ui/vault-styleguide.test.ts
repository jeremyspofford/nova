// The vault, design-first (2026-11-09; ui/js/sg-vault.js): the styleguide entry for the owner's
// reaction draws every frame, full screen, in Nebula light and dark, in Chromium and WebKit, with no
// Content-Security-Policy violation, no page error and nothing sent. Each frame holds the house
// rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one status icon
// (the top bar's) and none in a row, at most one primary control. No frame draws a secret's value:
// every password field is empty, and nothing offers to show, reveal or copy one. The words are the
// real model's (src/core/vault.ts, the /vault routes): names only, the vault deletes providers'
// secrets alone, a reset is tier 3 with a passkey on Nova's own screen, the old file is set aside,
// and each failure quotes the backend's own words. On a phone (390×844) and a Duo's cover screen
// (380×900) each frame is one column filling the screen. With NOVA_UI_SHOTS set
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

const FRAMES = ['list', 'empty', 'secret', 'delete-confirm', 'deleted', 'elsewhere', 'own-key', 'reset-confirm', 'reset-no-passkey', 'reset-paired', 'reset-done', 'file-key', 'keychain-waiting', 'lost'];
const NARROW_FRAMES = ['list', 'secret', 'delete-confirm', 'reset-confirm', 'reset-paired', 'keychain-waiting'];
const LIGHT_TOO = new Set(['list', 'delete-confirm', 'reset-confirm']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-vt-styleguide-'));
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
  await page.locator('[data-vt-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-vt-icon]').length > 0 && [...document.querySelectorAll('[data-vt-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-vt-frame], [data-vt-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-vt-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-vt-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-vt-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-vt-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.vt-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-vt-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-vt-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
  // No value is ever drawn: every secret field is empty.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('[data-vt-frame] input[type="password"]')].filter((i) => i.value !== '').map((i) => i.id)), [], `${label}: secret fields are empty`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-vt-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

const RESETS = new Set(['reset-confirm', 'reset-no-passkey', 'reset-paired']);

// What each frame must say: names never values, the core's routes and tiers, the backend's words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-vt-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  // Nothing the backend doesn't have, and nothing that would show a value.
  for (const s of ['Show the value', 'Reveal', 'Copy the value', 'Export the vault', 'Rename']) lacks(s);
  assert.equal(await f.getByRole('button', { name: /show|reveal|copy/i }).count(), 0, `${label}: no control shows a value`);
  if (frame === 'list') {
    has('14 secrets, key in the system keychain (secret-tool).');
    for (const s of ['Models and providers', 'Connections', 'Sign-ins for Nova’s browser', 'Capture', 'Infrastructure and network', 'Nova’s own keys', 'provider/CLOUD_MODELS_KEY', 'connector/home-assistant/HA_TOKEN', 'never their values']) has(s);
    assert.equal(await f.locator('.vt-list a').count(), 14, `${label}: every name is a row`);
  }
  if (frame === 'empty') { has('Nothing saved yet'); assert.equal(await f.locator('.vt-list').count(), 0, `${label}: no rows`); }
  if (frame === 'secret') {
    for (const s of ['secret://CLOUD_MODELS_KEY', 'Cloud models', 'Never shown again', 'doesn’t say which provider names a secret']) has(s);
    assert.equal(await f.getByLabel('New value').getAttribute('type'), 'password', `${label}: the new value is a password field`);
  }
  if (frame === 'delete-confirm') {
    for (const s of ['can’t be brought back', 'The key CLOUD_MODELS_KEY isn’t in the vault yet.', 'under a new key', 'no confirm and no passkey']) has(s);
    assert.equal(await f.getByRole('button', { name: 'Delete CLOUD_MODELS_KEY' }).count(), 1, `${label}: one delete`);
  }
  if (frame === 'deleted') { has('Cloud models needs a key again'); assert.equal(await f.locator('.vt-list a').count(), 13, `${label}: the name is gone from the list`); }
  if (frame === 'elsewhere') { has('The vault deletes providers’ keys only'); has('Disconnecting Home Assistant'); has('no route removes a project’s secret or a target’s token'); }
  if (frame === 'own-key') { has('nova/backup-key'); has('recovery key'); has('Not deleted here'); }
  if (RESETS.has(frame)) {
    for (const s of ['Start a new, empty vault?', 'All 14 secrets are left behind', 'secrets.json.unopenable-<time>', 'Home Assistant must be connected again', 'can’t be put back', 'The old key isn’t removed']) has(s);
  }
  if (frame === 'reset-confirm') { has('Asks every time'); assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`); }
  if (frame === 'reset-no-passkey') { has('Add one first'); assert.equal(await f.getByRole('button', { name: 'Add a passkey' }).count(), 1, `${label}: Add a passkey`); assert.equal(await f.getByRole('button', { name: 'Confirm with passkey' }).count(), 0, `${label}: nothing to confirm with`); }
  if (frame === 'reset-paired') { has('the core asks only for this box: no passkey'); assert.ok(await f.getByRole('button', { name: 'Start a new vault' }).isDisabled(), `${label}: waits for the box`); }
  if (frame === 'reset-done') { has('secrets.json.unopenable-2026-11-09'); has('To set again'); }
  if (frame === 'file-key') has('Anyone who can read Nova’s home folder can open them.');
  if (frame === 'keychain-waiting') { has('Nova waits for the keychain rather than starting over'); has('Can’t open now'); assert.equal(await f.locator('.vt-list').count(), 0, `${label}: no names while it can’t open`); }
  if (frame === 'lost') { has('is damaged and can’t be read'); has('starts a new vault'); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Vault styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=vault&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-vt-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=vault`, theme);
              assert.equal(await p.locator('[data-vt-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-vt-frame="reset-confirm"] form');
              await form.locator('input[name="confirm"]').check();
              const confirm = form.getByRole('button', { name: 'Confirm with passkey' });
              assert.equal(await confirm.isDisabled(), false, 'the box enables the passkey button');
              await confirm.click();
              assert.equal(await form.getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
              // A typed value is cleared when the demo "saves" it, and never sent.
              const sec = p.locator('[data-vt-frame="secret"] form');
              await sec.getByLabel('New value').fill('not-a-real-secret');
              await sec.getByRole('button', { name: 'Save the new value' }).click();
              assert.equal(await sec.getByLabel('New value').inputValue(), '', 'the field is cleared');
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
