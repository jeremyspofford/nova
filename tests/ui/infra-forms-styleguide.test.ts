// Infrastructure projects and network targets, design-first (2026-11-09; ui/js/sg-infra-forms.js):
// the styleguide entry for the owner's reaction draws every frame, full screen, in Nebula light and
// dark, in Chromium and WebKit, with no Content-Security-Policy violation, no page error and nothing
// sent. Each frame holds the house rules: no sideways scroll, 44 px targets, every control labelled,
// no duplicate ids, one status icon (the top bar's), at most one primary control. The words are the
// real model's: budgets and secrets stored or not, the core's own validation, the vault, no test on
// save, and the missing remove routes said plainly. No secret value is ever drawn: every password
// field is empty, and a demo save clears it. On a phone (390×844) and a Duo's cover screen (380×900)
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

const FRAMES = ['list', 'empty', 'project-add', 'project-invalid', 'project-secrets', 'project-failed', 'project-edit', 'targets', 'target-add', 'target-invalid', 'target-token', 'target-failed', 'target-edit'];
const NARROW_FRAMES = ['list', 'empty', 'project-add', 'project-secrets', 'target-token', 'target-failed'];
const LIGHT_TOO = new Set(['list', 'empty', 'targets']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-if-styleguide-'));
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
  await page.locator('[data-if-frame]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-if-icon]').length > 0 && [...document.querySelectorAll('[data-if-icon]')].every((s) => s.querySelector('.status-icon')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-if-frame], [data-if-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-if-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await shortTargets(page, '[data-if-frame] :is(input[type="radio"], input[type="checkbox"])', { visible: true, label: true }), [], `${label}: 44 px choices`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-if-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The status icon shows agent state: the top bar's, once per frame, and never in a row.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-if-frame]')].map((f) => [f.querySelectorAll('.status-icon').length, f.querySelectorAll('.uc-top .status-icon').length, f.querySelectorAll('.if-item .status-icon').length])),
    await page.evaluate(() => [...document.querySelectorAll('[data-if-frame]')].map(() => [1, 1, 0])), `${label}: one status icon, the top bar's, none per row`);
  // One standout per view: at most one primary control visible in a frame.
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-if-frame]')].every((f) => [...f.querySelectorAll<HTMLElement>('.btn.primary')].filter((b) => b.checkVisibility()).length <= 1)), `${label}: at most one primary control`);
}

// Narrow: one pane shows, as wide as the frame, and reaches the bottom of the screen.
async function oneColumn(page: Page, label: string) {
  const v = page.viewportSize()!;
  const panes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-if-frame] :is(.au-list, .au-detail)')].filter((p) => p.checkVisibility()).map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }));
  assert.equal(panes.length, 1, `${label}: one pane at a time`);
  assert.ok(panes[0]!.left <= 1 && panes[0]!.width >= v.width - 1, `${label}: the pane is the full width (${JSON.stringify(panes[0])})`);
  assert.ok(panes[0]!.bottom >= v.height - 1, `${label}: the pane reaches the bottom, no dead band (${panes[0]!.bottom} of ${v.height})`);
}

// What each frame must say: the real model's states, the core's words, and nothing secret.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-if-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  const has = (s: string) => assert.ok(text.includes(s), `${label}: says “${s}”`);
  const lacks = (s: string) => assert.ok(!text.includes(s), `${label}: doesn’t say “${s}”`);
  // Every secret field is empty: no value is ever drawn, and nothing overclaims the vault.
  assert.ok((await f.locator('input[type="password"]').evaluateAll((l) => l.map((i) => (i as HTMLInputElement).value))).every((v) => v === ''), `${label}: secret fields are empty`);
  lacks('encrypted');
  if (frame === 'empty') {
    has('Nothing added yet');
    has('OpenTofu isn’t on this computer');
    assert.equal(await f.locator('.if-item').count(), 0, `${label}: no rows`);
    return;
  }
  // Both lists, and the two ways in.
  assert.equal(await f.getByRole('link', { name: 'Add a project' }).count(), 1, `${label}: Add a project`);
  assert.equal(await f.getByRole('link', { name: 'Add a target' }).count(), 1, `${label}: Add a target`);
  if (frame === 'list') {
    for (const s of ['Home lab', 'Static site', 'Home router', 'NAS firewall', '$8.00 a month of the $20.00 budget (40 %)', 'Needs a secret', 'example_vm.media', 'by size: small $4.00, medium $8.00 a month']) has(s);
    assert.equal(await f.getByRole('link', { name: 'Plan it' }).count(), 1, `${label}: Plan it`);
  }
  if (frame === 'project-add' || frame === 'project-invalid') {
    for (const l of ['Name', 'Folder', 'Budget a month (USD)', 'Names of its secrets', 'To a cloud', 'To a provider on your own network']) assert.equal(await f.getByLabel(l, { exact: true }).count(), 1, `${label}: ${l}`);
  }
  if (frame === 'project-invalid') {
    assert.equal(await f.locator('[aria-invalid="true"]').count(), 3, `${label}: three fields marked`);
    has('has no OpenTofu configuration (.tf or .tf.json files).');
    has('capital letters, digits and underscores');
  }
  if (frame === 'project-secrets') {
    assert.equal(await f.getByLabel('CLOUD_SECRET').getAttribute('type'), 'password', `${label}: the value is a password field`);
    for (const s of ['In Nova’s vault, under this project', 'to OpenTofu’s process only', 'Nova doesn’t check a secret when you save it', 'It isn’t shown again']) has(s);
  }
  if (frame === 'project-failed') { has('The first plan failed'); has('nothing changed'); }
  if (frame === 'project-edit') {
    has('stay as they were added');
    has('no remove route');
    assert.equal(await f.getByRole('button', { name: 'Plan destroying everything in it' }).count(), 1, `${label}: destroying starts with a plan`);
  }
  if (frame === 'targets') { for (const s of ['http-config', 'https://router.example/api/config', 'Nova waits 5 min to hear from Your phone', 'Waiting for you']) has(s); }
  if (frame === 'target-add' || frame === 'target-invalid') {
    for (const l of ['Name', 'Address of its configuration', 'Router', 'DNS', 'Firewall', 'Tailnet policy']) assert.equal(await f.getByLabel(l, { exact: true }).count(), 1, `${label}: ${l}`);
  }
  if (frame === 'target-invalid') { assert.equal(await f.locator('[aria-invalid="true"]').count(), 3, `${label}: three marked`); has('is plain http'); }
  if (frame === 'target-token') {
    assert.equal(await f.getByLabel('Token', { exact: true }).getAttribute('type'), 'password', `${label}: the token is a password field`);
    for (const s of ['In Nova’s vault, under this target', 'only to nas.example', 'Nova doesn’t check a token when you save it', 'Paired now: Your phone']) has(s);
  }
  if (frame === 'target-failed') { has('nas.example refused the token (401).'); assert.equal(await f.getByRole('link', { name: 'Replace the token' }).count(), 1, `${label}: Replace the token`); }
  if (frame === 'target-edit') {
    has('can’t be changed yet');
    has('no remove, rename or readdress route');
    assert.equal(await f.getByLabel('New token').getAttribute('type'), 'password', `${label}: a password field`);
  }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Infrastructure and network styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
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
              await open(p, `${base}/styleguide?entry=infra-forms&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-if-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=infra-forms`, theme);
              assert.equal(await p.locator('[data-if-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // A demo save sends nothing, clears the secret it was given, and says so.
              const form = p.locator('[data-if-frame="project-secrets"] form');
              await form.locator('input[type="password"]').fill('made-up-value');
              await form.getByRole('button', { name: 'Save to the vault' }).click();
              assert.equal(await form.getByRole('button', { name: 'Demo: nothing was sent' }).count(), 1, 'the demo says so');
              assert.equal(await form.locator('input[type="password"]').inputValue(), '', 'the demo clears the secret');
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
