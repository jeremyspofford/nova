// Coding, infrastructure and network runs in Tasks, design-first (2026-11-09; ui/js/sg-task-runs.js):
// the styleguide entry for the owner's reaction draws every frame, full screen, in Nebula light and
// dark, in Chromium and WebKit, with no Content-Security-Policy violation, no page error and nothing
// sent. Each frame holds the house rules: no sideways scroll, 44 px targets, every control labelled,
// no duplicate ids, one status icon (the top bar's) and none in a row, at most one primary control.
// Colour is state only: a run's pill is its Tasks group's (amber only under Needs you, red only under
// Didn't finish), a red frame only on a run that stopped, a confirmation only where one waits. The
// words are the real model's: the steps and their tiers, the reviewed diff and Nova's own test run, the
// plan priced against its budget, the snapshot and the dead-man's switch, and each gap said, not drawn.
// On a phone (390×844) and a Duo's cover screen (380×900) each frame is one column filling the screen.
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

const FRAMES = ['list', 'coding-review', 'coding-running', 'coding-failed', 'infra-review', 'infra-applying', 'infra-over-budget', 'network-review', 'network-watching', 'network-revert-failed', 'cancelled', 'empty'];
const NARROW_FRAMES = ['list', 'coding-review', 'infra-review', 'network-watching', 'empty'];
const LIGHT_TOO = new Set(['list', 'infra-review', 'network-review']);
const ASKS = new Set(['list', 'coding-review', 'infra-review', 'network-review', 'network-revert-failed']);
const STOPPED = new Set(['coding-failed', 'infra-over-budget']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-tr-styleguide-'));
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
  await page.locator('[data-tr-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-tr-icon]').length > 0 && [...document.querySelectorAll('[data-tr-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-tr-frame], [data-tr-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-tr-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-tr-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-tr-frame] :is(button, a, input, select, textarea)')]
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
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-tr-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.tr-list .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-tr-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-tr-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
  // A row's pill is its group's: amber only under Needs you, red only under Didn't finish.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-tr-frame] .tr-item')]
    .filter((li) => li.querySelector('.status')?.getAttribute('data-status') !== li.closest('ul')?.getAttribute('aria-labelledby')?.replace(/^.*-g-/, ''))
    .map((li) => li.textContent?.trim().slice(0, 60))), [], `${label}: each run’s pill is its Tasks group’s`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-tr-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's steps, tiers, records and gaps, in the backend's words.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-tr-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  const buttons = (name: string) => f.getByRole('button', { name, exact: true }).count();
  assert.equal(await f.locator('.uc-title').innerText(), 'Tasks', `${label}: in Tasks`);
  // Nothing the backend doesn't have: no run-again, no retry, no putting back early, no push.
  for (const s of ['Run again', 'Retry', 'Put it back now', 'Push it']) lacks(s);
  assert.equal(await f.locator('.tr-stopped').count(), STOPPED.has(frame) ? 1 : 0, `${label}: a red frame only on a run that stopped`);
  assert.equal(await f.locator('.au-confirm').count(), ASKS.has(frame) ? 1 : 0, `${label}: a confirmation only where one waits`);
  assert.equal(await buttons('Confirm with passkey'), ASKS.has(frame) ? 1 : 0, `${label}: the passkey only where one waits`);
  if (ASKS.has(frame)) assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  if (frame !== 'empty') assert.equal(await f.locator('.au-list a[aria-current="true"]').count(), 1, `${label}: one run open`);
  if (frame === 'list') {
    for (const s of ['Needs you · 4', 'In progress · 3', 'Didn’t finish · 2', 'Done and checked · 3', 'Cancelled · 1', 'Coding · ~/code/notes-app, into main', 'Infrastructure · “Home lab”', 'Network · Home router', 'Task · Wrote lists/reading.md']) has(s);
  }
  if (frame === 'list' || frame === 'coding-review') {
    for (const s of ['Merge it into main? Nova moves main from 3f2e1d0 to a1b2c3d: exactly this diff. Nova doesn’t push.', 'Nova ran npm test itself on a1b2c3d: it passed (exit 0, 4.2 s)', 'tier 3, asks every time', 'tier 2, asks first', 'coding runs have no budget']) has(s);
    assert.equal(await buttons('Don’t merge'), 1, `${label}: Don’t merge`);
    assert.equal(await f.locator('summary', { hasText: 'The whole diff' }).count(), 1, `${label}: the whole diff`);
  }
  if (frame === 'coding-running') { has('Nothing in your repository changes before the merge'); has('not made yet'); assert.equal(await buttons('Stop and undo'), 1, `${label}: Stop and undo`); }
  if (frame === 'coding-failed') { has('Stopped. Nothing was merged.'); has('Nova won’t ask you to merge it.'); has('There is no run-again yet'); }
  if (frame === 'infra-review') {
    for (const s of ['$16.00 a month of the $20.00 budget (80 %)', 'That is past 80 % of the budget.', 'Plan: 2 to add, 0 to change, 0 to destroy.', 'example_vm.media2 · add · +$8.00 a month', 'not the provider’s bill']) has(s);
    assert.deepEqual([await f.locator('.tr-seg.is-now').count(), await f.locator('.tr-seg.is-added').count()], [4, 4], `${label}: $8 now and $8 more of $20, in tenths`);
    assert.equal(await buttons('Don’t apply'), 1, `${label}: Don’t apply`);
  }
  if (frame === 'infra-applying') { has('there is no live output while it runs'); has('ck-7d3e90a1b5'); assert.equal(await buttons('Cancel the apply'), 1, `${label}: Cancel the apply`); }
  if (frame === 'infra-over-budget') { has('over budget. Nova applied nothing and won’t offer it'); assert.equal(await f.locator('.tr-seg.is-added').count() + await f.locator('.tr-seg.is-now').count(), 10, `${label}: the bar is full`); }
  if (frame === 'network-review') { has('it puts the snapshot back by itself'); has('Sam’s phone or Firefox on the laptop, not from this computer'); has('The diff against the snapshot'); has('A change that sets one is refused'); }
  if (frame === 'network-watching') { has('Without that by 14:15'); has('You can’t put it back by hand while Nova waits'); has('ck-2a6f1c0e93'); }
  if (frame === 'network-revert-failed') { has('Check Tailnet policy yourself, then settle the change.'); has('takes no new change until you settle'); }
  if (frame === 'cancelled') { has('You didn’t apply it. Nothing in “Home lab” changed.'); assert.equal(await f.locator('a[aria-current="true"] .status[data-status="quiet"]').count(), 1, `${label}: quiet, not red`); }
  if (frame === 'empty') {
    has('No runs yet'); has('OpenTofu isn’t on this computer yet'); has('No phone or browser is paired');
    assert.equal(await f.locator('.tr-item').count(), 0, `${label}: no rows`);
  }
}

// A narrow frame is a paired device: a tier-3 OK is the box and its button, no passkey anywhere, and
// one quiet line says so (flagged for the owner). Nova's own screen keeps the passkey (desktop frames).
async function asDevice(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-tr-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  assert.equal(await f.getByRole('button', { name: 'Confirm with passkey' }).count(), 0, `${label}: no passkey button on a paired device`);
  assert.ok(!text.includes('Confirm with your passkey'), `${label}: no passkey wording on a paired device`);
  // The list frame shows the list pane there; the confirmation is in the run's pane.
  const asks = ASKS.has(frame) && frame !== 'list';
  assert.equal(text.includes('A paired device approves this without a passkey'), asks, `${label}: the one quiet line, where an OK waits`);
  if (!asks) return;
  const act = frame === 'list' || frame === 'coding-review' ? 'Merge' : frame === 'network-revert-failed' ? 'Settle it' : 'Apply';
  const button = f.locator('.tr-device').getByRole('button', { name: act, exact: true });
  assert.equal(await button.count(), 1, `${label}: ${act}`);
  assert.ok(await button.isDisabled(), `${label}: ${act} waits for the box`);
  await f.locator('.tr-device input[name="confirm"]').check();
  assert.equal(await button.isDisabled(), false, `${label}: the box enables ${act}`);
  await f.locator('.tr-device input[name="confirm"]').uncheck();
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Runs in Tasks styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=task-runs&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-tr-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else { await oneColumn(p, label); await asDevice(p, frame, label); }
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=task-runs`, theme);
              assert.equal(await p.locator('[data-tr-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The box enables the passkey button, locally; pressing it sends nothing.
              const form = p.locator('[data-tr-frame="infra-review"] form.au-confirm');
              await form.locator('.tr-console input[name="confirm"]').check();
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
