// Releases in Health, the supervisor's deploy and rollback, design-first (2026-11-09;
// ui/js/sg-supervisor.js): the styleguide entry for the owner's reaction draws every frame, full
// screen, in Nebula light and dark, in Chromium and WebKit, with no Content-Security-Policy
// violation, no page error and nothing sent. Each frame holds the house rules: no sideways scroll,
// 44 px targets, every control labelled, no duplicate ids, one status icon (the top bar's) and none in
// a gate or a history row, at most one primary control, no red anywhere (a stopped deploy leaves Nova
// running) and amber only on a problem that needs you. The words are the real model's: the gates in
// the supervisor's order, the failed one named, going back to the one release kept, both tier 3 on
// Nova's own screen only, no list of tags. On a phone (390×844) and a Duo's cover screen (380×900)
// Health is one column filling the screen, down to the foot, no dead band, and a paired device
// follows releases read-only. With NOVA_UI_SHOTS set (scripts/ui-test.sh), Chromium writes the
// owner's screenshots.
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

const FRAMES = ['running', 'deploy-form', 'deploying', 'switching', 'promoted', 'stopped-tests', 'rolled-back', 'rollback-confirm', 'rolling-back', 'went-back', 'rollback-refused', 'history', 'unsupervised', 'paired-running', 'paired-deploying', 'paired-stopped', 'paired-rolled-back'];
const NARROW_FRAMES = ['paired-running', 'paired-deploying', 'paired-stopped', 'paired-rolled-back', 'unsupervised'];
const LIGHT_TOO = new Set(['running', 'deploying', 'stopped-tests']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
const LIVE = 'v0.1.0-alpha.3';
const KEPT = 'v0.1.0-alpha.2';

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-sv-styleguide-'));
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
  await page.locator('[data-sv-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-sv-icon]').length > 0 && [...document.querySelectorAll('[data-sv-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-sv-frame], [data-sv-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-sv-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-sv-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-sv-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The status icon shows agent state: the top bar's, once per frame, never in a gate or a row.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-sv-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll(':is(.sv-gates, .sv-hist) .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-sv-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-sv-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
  // Red only for stopped (nothing here stops Nova), amber only for what needs you: the problem's tag.
  assert.deepEqual(await page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.append(probe);
    const tone = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
    const red = tone('--status-error');
    const amber = tone('--status-attention');
    const plain = getComputedStyle(probe.parentElement!).color;
    probe.remove();
    if (red === amber || red === plain || amber === plain) return ['the status tokens didn’t resolve'];
    return [...document.querySelectorAll<HTMLElement>('[data-sv-frame] *')]
      .filter((e) => e.checkVisibility() && !e.closest('.status-icon'))
      .flatMap((e) => {
        const s = getComputedStyle(e);
        const hits = [s.color, s.backgroundColor].filter((c) => c === red || c === amber);
        if (!hits.length) return [];
        if (hits.every((c) => c === amber) && e.matches('.sv-tag')) return [];
        return [`${e.tagName.toLowerCase()}.${e.className} ${hits.includes(red) ? 'red' : 'amber'}`];
      });
  }), [], `${label}: no red; amber only on a problem that needs you`);
}

// Narrow: Health's one column, as wide as the frame, down to the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const cols = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-sv-frame] .sv-col')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(cols.length, 1, `${label}: one column`);
  assert.ok(cols[0]!.left <= 1 && cols[0]!.width >= v.width - 1, `${label}: the column is the full width (${JSON.stringify(cols[0])})`);
  assert.ok(cols[0]!.bottom >= v.height - 1, `${label}: the column reaches the bottom, no dead band (${cols[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the supervisor's gates and outcomes, the tiers, and nothing it lacks.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-sv-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  // Case aside: a caption is upper-cased by its style, and innerText says it so.
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${label}: doesn’t say “${s}”`);
  const links = (name: string | RegExp) => f.getByRole('link', { name }).count();
  const gate = (g: string) => f.locator(`.sv-gate[data-g="${g}"]`).count();
  // Nothing the backend doesn't have: no list of releases to pick from, no recover button.
  for (const s of ['Available releases', 'Choose a release', 'Recover now', 'Exit safe mode']) lacks(s);
  assert.equal(await f.locator('select').count(), 0, `${label}: no picker: nothing lists the tags`);
  if (frame === 'running') {
    has(`${LIVE} is live`); has('Kept to go back to'); has('No problems are open.');
    assert.equal(await links('Deploy a release'), 1, `${label}: Deploy a release`);
    assert.equal(await links(`Go back to ${KEPT}`), 1, `${label}: go back to the one kept`);
  }
  if (frame === 'deploy-form') {
    has('Asks every time'); has('Nova doesn’t list the tags yet');
    assert.equal(await f.getByLabel('Release tag', { exact: true }).count(), 1, `${label}: Release tag`);
    for (const s of ['Its slot', 'Its tests', 'Sandbox start', 'Smoke probes', 'The switch', 'Canary window', 'Promoted']) has(s);
    assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  }
  if (frame === 'deploying') {
    has('Deploying v0.1.0-alpha.4'); has('Running now'); has('it rolls back by itself if its canary fails');
    assert.equal(await gate('pass'), 5, `${label}: five gates passed`); assert.equal(await gate('now'), 1, `${label}: the canary runs now`);
    assert.equal(await links('Deploy a release'), 0, `${label}: no second deploy while one runs`);
    assert.equal(await links(/^Go back/), 0, `${label}: no going back by hand while one runs`);
  }
  if (frame === 'switching') { has('Nova isn’t answering'); has('Restarting for the switch'); assert.equal(await gate('now'), 1, `${label}: the switch`); }
  if (frame === 'promoted') { assert.equal(await gate('pass'), 7, `${label}: every gate passed`); has(`v0.1.0-alpha.4 is live; ${LIVE} is kept to go back to`); }
  if (frame === 'stopped-tests' || frame === 'paired-stopped') {
    assert.equal(await gate('fail'), 1, `${label}: one gate didn’t pass`);
    assert.match(await f.locator('.sv-gate[data-g="fail"] .au-name').innerText(), /Its tests/, `${label}: the gate is named`);
    assert.equal(await f.getByText('Never ran: an earlier gate didn’t pass.').count(), 5, `${label}: the gates after it never ran`);
    has(`Nova kept running ${LIVE}`); has('A release didn’t pass its checks'); has('npm test failed (3 of 412 tests)');
  }
  if (frame === 'rolled-back' || frame === 'paired-rolled-back') {
    assert.match(await f.locator('.sv-gate[data-g="fail"] .au-name').innerText(), /Canary window/, `${label}: the canary failed`);
    has('Going back'); has('rolled back by itself'); has('Health failed: database');
  }
  if (frame === 'rollback-confirm') {
    has(`Go back to ${KEPT}?`); has('only if nothing was written since'); has('Nova can’t tell you which before you ask');
    assert.ok(await f.getByRole('button', { name: 'Confirm with passkey' }).isDisabled(), `${label}: the passkey waits for the box`);
  }
  if (frame === 'rolling-back') { has('Restarting to go back'); has('Nova isn’t answering'); }
  if (frame === 'went-back') { has('Went back, as you asked'); has('Nothing. Going back keeps nothing'); assert.equal(await links(/^Go back/), 0, `${label}: nothing kept to go back to`); }
  if (frame === 'rollback-refused') { has('would lose 14 changes'); has('Going back refused'); has('Nova couldn’t go back to the older release'); }
  if (frame === 'history') {
    assert.equal(await f.locator('.sv-hrow').count(), 5, `${label}: the last five`);
    for (const s of ['Promoted', 'Stopped at a gate', 'Went back, as you asked', 'Going back refused', 'The supervisor keeps fifty']) has(s);
  }
  if (frame === 'unsupervised') { has('Not running under the supervisor'); has('node src/supervisor/main.ts run'); assert.equal(await links('Deploy a release'), 0, `${label}: nothing to deploy`); }
  if (frame.startsWith('paired-')) {
    has('happen on Nova’s own screen');
    assert.equal(await links('Deploy a release'), 0, `${label}: no deploy on a paired device`);
    assert.equal(await links(/^Go back/), 0, `${label}: no going back on a paired device`);
  }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Releases in Health styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=supervisor&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-sv-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else { await oneColumn(p, label); await words(p, frame, label); }
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=supervisor`, theme);
              assert.equal(await p.locator('[data-sv-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // The passkey box enables its button, locally; pressing it sends nothing.
              const form = p.locator('[data-sv-frame="rollback-confirm"] form');
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
