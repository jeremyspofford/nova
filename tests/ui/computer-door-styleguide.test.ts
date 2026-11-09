// Nova Computer's door, design-first (2026-11-09; ui/js/sg-computer.js): the styleguide entry for
// the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium and
// WebKit, with no Content-Security-Policy violation, no page error and nothing sent. Each frame holds
// the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids, one
// status icon (the top bar's) and none in a row, at most one primary control. The words are the real
// model's: the door is a Settings category; a workspace has one folder, no network unless declared,
// a read-only .git; there is no terminal; the tiers ask as policy.ts says; each failure quotes the
// backend's own words. On a phone (390×844) and a Duo's cover screen (380×900) each frame is one
// column filling the screen: one pane, full width, down to the foot, no dead band. With
// NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the owner's screenshots.
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

const FRAMES = ['door-empty', 'door-idle', 'door-working', 'workspace', 'run', 'create', 'create-approve', 'outside-confirm', 'delete-confirm', 'local-only', 'broken', 'no-docker', 'not-answering', 'no-image', 'remote-docker'];
const NARROW_FRAMES = ['door-idle', 'door-working', 'workspace', 'create-approve', 'no-image'];
const LIGHT_TOO = new Set(['door-empty', 'door-idle', 'door-working']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-nc-styleguide-'));
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
  await page.locator('[data-nc-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-nc-icon]').length > 0 && [...document.querySelectorAll('[data-nc-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-nc-frame], [data-nc-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-nc-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-nc-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-nc-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-nc-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.nc-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-nc-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-nc-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-nc-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

const DOOR = new Set(['door-empty', 'door-idle', 'door-working', 'no-docker', 'not-answering', 'no-image', 'remote-docker']);

// What each frame must say: the real model's states, reach and tiers, and the backend's own words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-nc-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  // Nothing the backend doesn't have: no terminal, no screen, no on/off switch.
  for (const s of ['terminal', 'Turn on', 'Turn off', 'Start the computer', 'Stop the computer']) lacks(s);
  if (DOOR.has(frame)) {
    // The door: one Settings category, under What Nova works with, current, with its state beneath.
    assert.equal(await f.locator('.uc-title').innerText(), 'Settings', `${label}: Settings`);
    const row = f.locator('nav[aria-label="Settings categories"] a[aria-current="true"]');
    assert.equal(await row.count(), 1, `${label}: one current category`);
    assert.match(await row.innerText(), /Nova’s computer/, `${label}: the door is Nova’s computer`);
    assert.equal(await f.locator('nav[aria-label="Settings categories"] ul[aria-labelledby$="-g1"] a[aria-current="true"]').count(), 1, `${label}: under What Nova works with`);
    assert.equal(await f.locator('.uc-rail').count(), 0, `${label}: no new place in a rail`);
  }
  if (frame === 'door-empty') { has('No workspaces yet'); has('Ready · no workspaces yet'); assert.equal(await f.getByRole('link', { name: 'Make a workspace' }).count(), 1, `${label}: one next step`); }
  if (frame === 'door-idle') { has('Ready · 2 workspaces, nothing running'); has('Docker 28.5.1, with Nova’s computer image.'); has('Nova’s chat can’t use it yet'); }
  if (frame === 'door-working') { has('Running npm test in “notes-app”'); assert.equal(await f.locator('.nc-live').count(), 1, `${label}: the row says it is working`); }
  if (frame === 'workspace') {
    has('Running now: npm test');
    for (const s of ['/workspace', 'Read-only inside', 'None. Its machine has no network at all.', 'Your own user, not root', '2 CPUs, 2 GB of memory, 512 processes', 'Output held back: screened quarantine']) has(s);
    assert.equal(await f.getByRole('button', { name: 'Stop it' }).count(), 1, `${label}: Stop it`);
    assert.equal(await f.getByRole('link', { name: 'Open in Tasks' }).count(), 1, `${label}: Open in Tasks`);
    assert.equal(await f.getByRole('button', { name: 'Undo' }).count(), 2, `${label}: undo for the two changes, not the read`);
  }
  if (frame === 'run') { assert.equal(await f.getByLabel('Command', { exact: true }).count(), 1, `${label}: Command`); has('It doesn’t wait for your OK: Nova takes a checkpoint first'); }
  if (frame === 'create') { has('This asks first, because it is a folder of yours.'); assert.equal(await f.getByRole('radio', { name: /None/ }).isChecked(), true, `${label}: no network by default`); }
  if (frame === 'create-approve') { has('Waiting for your OK'); has('First (tier 2)'); assert.equal(await f.getByRole('button', { name: 'Approve' }).count(), 1, `${label}: Approve`); }
  if (frame === 'outside-confirm' || frame === 'delete-confirm') {
    has('Asks every time');
    assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  }
  if (frame === 'outside-confirm') has('registry.npmjs.org');
  if (frame === 'delete-confirm') has('stays as it is');
  if (frame === 'local-only') has('Runs nothing while your Nova is local-only');
  if (frame === 'broken') { has('Its machine couldn’t be made'); has('Docker couldn’t start the workspace'); }
  if (frame === 'no-docker') has('Docker isn’t installed on this machine, so Nova’s computer can’t run.');
  if (frame === 'not-answering') has('Docker isn’t answering on this machine: Cannot connect to the Docker daemon');
  if (frame === 'no-image') { has('Get it once with: docker pull node:26-trixie@sha256:'); assert.equal(await f.getByRole('button', { name: 'Copy the command' }).count(), 1, `${label}: Copy`); }
  if (frame === 'remote-docker') has('runs only on this machine’s own Docker (a unix socket)');
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Nova Computer door styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=computer-door&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-nc-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=computer-door`, theme);
              assert.equal(await p.locator('[data-nc-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-nc-frame="delete-confirm"] form');
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
