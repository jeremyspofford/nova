// Home Assistant, design-first (2026-11-09; ui/js/sg-home-assistant.js): the styleguide entry for
// the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's) and none in a row, at most one primary control. The words are the real
// model's (src/core/connectors/home-assistant.ts): the door is Settings › Connections; the token is
// tried before the vault keeps it; Nova sees state only; a change the person asks for is made and
// reported (tier 1, owner ruling 2026-11-09; it asked first, tier 2, before), the service tier is a
// setting, kinds the person marks confirm every time (tier 3, none by default) with the passkey, and
// a chat that read something from outside asks first; Nova reads the device back and holds the task
// rather than calling again; each failure quotes the backend's own words. On a phone (390×844) and a Duo's
// cover screen (380×900) each frame is one column filling the screen: one pane, full width, down to
// the foot, no dead band. With NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the owner's
// screenshots (docs/screenshots/home-assistant-compositions-2026-11-09 for this entry).
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

// 'done' replaced 'approve' (a light waiting for an OK) with the owner's ruling of 2026-11-09.
const FRAMES = ['connect', 'connected', 'devices', 'done', 'approve-lock', 'check-failed', 'confirm-list', 'disconnect', 'disconnected-note', 'unreachable', 'bad-token', 'not-ha', 'outside', 'token-revoked', 'reconnecting', 'paused'];
const NARROW_FRAMES = ['connect', 'connected', 'devices', 'approve-lock', 'token-revoked'];
const LIGHT_TOO = new Set(['connect', 'connected', 'devices']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
const INSIDE = new Set(['devices', 'done', 'approve-lock', 'check-failed']);

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ha-styleguide-'));
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
  await page.locator('[data-ha-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-ha-icon]').length > 0 && [...document.querySelectorAll('[data-ha-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ha-frame], [data-ha-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-ha-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-ha-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ha-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-ha-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.ha-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-ha-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-ha-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ha-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// The backend's own words (home-assistant.ts, connectors/index.ts, ledger.ts), quoted by the frames.
const SAID: Record<string, string> = {
  unreachable: 'Couldn’t reach Home Assistant at homeassistant.local:8123. Check that it is running and the address is right.',
  'bad-token': 'Home Assistant didn’t accept that token. Make a long-lived access token in your Home Assistant profile and paste all of it.',
  'not-ha': 'That address answers, but not like Home Assistant does.',
  outside: 'Your Home Assistant is outside your network (ha.example.net), and Nova is set to local-only, so Nova doesn’t contact it.',
  'token-revoked': 'Home Assistant no longer accepts Nova’s token. Make a new one and connect again.',
  paused: 'Paused: it’s outside your network and Nova is set to local-only.',
  reconnecting: 'The live connection dropped; Nova is reconnecting.',
  'disconnected-note': 'Couldn’t reach Home Assistant. Delete the token in your Home Assistant profile, under Long-lived access tokens.',
  'confirm-list': 'Taking lock off the list means Nova no longer asks for a confirmation every time. Send confirm: true to do that.',
  done: 'light.turn_off: light.kitchen is off now.',
  'check-failed': 'May already have happened: The evidence didn\'t hold up: Nova read light.kitchen from Home Assistant itself: it is on, not off. Check, then retry or cancel.',
};

// What each frame must say: the real model's reach, tiers and failures.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-ha-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  // Nothing the backend doesn't have, and not the softened claim's strong words.
  // Nor the words the owner's ruling of 2026-11-09 retired: a change the person asks for doesn't wait.
  for (const s of ['after asking you first', 'Asks first (tier 2)', 'Chat can’t', 'chat can’t change', 'brightness:', 'Set the temperature', 'Ask Nova to']) lacks(s);
  if (SAID[frame]) has(SAID[frame]!);
  if (INSIDE.has(frame)) {
    assert.equal(await f.locator('.uc-title').innerText(), 'Home Assistant', `${label}: Home Assistant`);
    has('no brightness, no units');
  } else {
    // The door: Settings › Connections, under What Nova works with, current.
    assert.equal(await f.locator('.uc-title').innerText(), 'Settings', `${label}: Settings`);
    const row = f.locator('nav[aria-label="Settings categories"] a[aria-current="true"]');
    assert.equal(await row.count(), 1, `${label}: one current category`);
    assert.match(await row.innerText(), /Connections/, `${label}: the door is Connections`);
    assert.equal(await f.locator('nav[aria-label="Settings categories"] ul[aria-labelledby$="-g1"] a[aria-current="true"]').count(), 1, `${label}: under What Nova works with`);
  }
  if (['connect', 'unreachable', 'bad-token', 'not-ha', 'outside', 'disconnected-note', 'token-revoked'].includes(frame)) {
    has('What happens to the token'); has('connector/home-assistant/HA_TOKEN'); has('Only if Home Assistant accepts it does Nova keep it');
    assert.equal(await f.getByLabel('Long-lived access token').getAttribute('type'), 'password', `${label}: the token is never shown`);
    assert.equal(await f.getByLabel('Long-lived access token').inputValue(), '', `${label}: no token drawn`);
  }
  if (['unreachable', 'bad-token', 'not-ha'].includes(frame)) has('Nothing was kept');
  if (frame === 'outside') has('Nothing was sent there');
  if (frame === 'connect') { has('Turn things on and off when you ask, and tell you what changed.'); has('Never: change anything unless you, or a rule you set up, asks'); has('without asking you first'); }
  if (frame === 'connected' || frame === 'reconnecting' || frame === 'paused') {
    for (const s of ['Connected to Home since', 'Without asking (tier 0)', 'Made when you ask (tier 1), and reported', 'None by default', 'confirm every time (tier 3)', 'Nova asks you first before any change', 'One rule listens to it']) has(s);
    assert.equal(await f.getByRole('link', { name: 'Disconnect' }).count(), 1, `${label}: the way out`);
  }
  if (frame === 'connected') has('Hearing changes as they happen.');
  if (frame === 'reconnecting') has('a rule listening misses them');
  if (frame === 'devices') { has('21.5'); has('Made when you ask (tier 1), and reported'); has('in chat'); assert.equal(await f.getByRole('button', { name: 'Turn off' }).count(), 1, `${label}: one change, for the open light`); }
  if (frame === 'done') {
    has('Done and reported'); has('tier 1, act and report'); has('Nova read light.kitchen from Home Assistant itself after the call: off.'); has('Nova doesn’t call again by itself');
    assert.equal(await f.getByRole('button', { name: 'Approve' }).count(), 0, `${label}: nothing to approve`);
  }
  if (frame === 'approve-lock') {
    has('Asks every time'); has('Home Assistant runs lock.unlock on lock.front_door'); has('you marked locks'); has('Unmarked, an unlock you ask for just happens');
    assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  }
  if (frame === 'check-failed') assert.equal(await f.getByRole('button', { name: 'Retry' }).count(), 1, `${label}: Retry, by the person`);
  if (frame === 'confirm-list') {
    has('not your passkey'); has('Flagged for the owner');
    assert.equal(await f.getByRole('radio', { name: /Make the change and tell me/ }).isChecked(), true, `${label}: tier 1 is the default`);
    assert.equal(await f.getByRole('radio', { name: /Ask me first/ }).isChecked(), false, `${label}: tier 2 is a choice`);
    assert.equal(await f.getByRole('checkbox', { name: /Locks/ }).isChecked(), true, `${label}: locks being marked`);
    assert.equal(await f.getByRole('checkbox', { name: /Alarms/ }).isChecked(), false, `${label}: alarms not marked`);
  }
  if (frame === 'disconnect') { has('Nova asks Home Assistant to delete its token'); assert.equal(await f.getByRole('button', { name: 'Keep it' }).count(), 1, `${label}: Keep it`); }
  if (frame === 'token-revoked') { has('Home Assistant needs you'); assert.equal(await f.getByRole('button', { name: 'Connect again' }).count(), 1, `${label}: Connect again`); }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Home Assistant styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=home-assistant&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-ha-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=home-assistant`, theme);
              assert.equal(await p.locator('[data-ha-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-ha-frame="approve-lock"] form');
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
