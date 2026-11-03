// Task1: real shared view in the living styleguide; no app flow or backup/key operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, still, ROOT } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const STATES = ['loading', 'empty', 'configured', 'saving', 'error', 'first-key', 'confirm', 'shown', 'paired-viewer', 'paired-approver', 'paired-first-key', 'standby', 'unavailable', 'long-paths'];
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, halfopen: { width: 842, height: 675 } };
const KEY = '01234567-89abcdef-01234567-89abcdef-01234567-89abcdef-01234567-89abcdef';

// Ownership starts before Core initialization, including its reset mark. No setup/model workers
// start. The outer finally owns the browser, listener, Core and private fixture even on failure.
async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-backups-styleguide-'));
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

// preview() swaps the theme CSS and then redraws the whole catalogue on the next frame. Wait for
// that redraw too, or a later step can read a specimen node the redraw is about to replace.
async function themeApplied(page: Page, css: string) {
  await page.waitForFunction((text) => document.getElementById('ds')?.textContent === text && !document.getElementById('ds-boot'), css);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function choose(page: Page, state: string) {
  await page.getByLabel('Specimen state').selectOption(state);
  await page.locator(`[data-backups-specimen="${state}"]`).waitFor();
}
async function failureShot(page: Page, label: string) {
  if (!process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS) return;
  const folder = resolve(process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS, 'failures');
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${label.replaceAll('/', '-')}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
}
async function geometry(page: Page, label: string) {
  const viewport = page.viewportSize()!;
  const overflow = await page.evaluate((width) => ({ pageWidth: document.documentElement.scrollWidth, viewport: width, elements: [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.getBoundingClientRect().right > width + 1).map((el) => ({ tag: el.tagName, id: el.id, class: el.className, right: el.getBoundingClientRect().right })) }), viewport.width);
  if (overflow.pageWidth > viewport.width) await failureShot(page, `${label}-overflow`);
  assert.ok(overflow.pageWidth <= viewport.width, `${label}: page overflow ${JSON.stringify(overflow)}`);
  assert.deepEqual(await page.locator('.backups-settings').evaluate((root) => [...root.querySelectorAll<HTMLElement>('button, label, p, pre, code, h2, h3')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)), [], `${label}: clipped text`);
  assert.deepEqual(await page.locator('.backups-settings button, .backups-settings input').evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).disabled).filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML)), [], `${label}: touch targets`);
  const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids`);
  assert.equal(await page.locator('form form').count(), 0);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Backups entry exists in ${engine}`, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const d = await device(b!, { serviceWorkers: 'block' });
        await d.page.goto(`${base}/styleguide?entry=backups-settings`);
        assert.equal(await d.page.getByRole('heading', { name: 'Backups settings', exact: true }).count(), 1);
        assert.equal(await d.page.locator('#sg-backups-settings').count(), 1);
        assert.deepEqual(d.errors, []);
      });
    } finally { await b?.close(); }
  });

  test(`Backups ${engine}: every state, posture and installed theme; local interactions and accessibility`, { timeout: 300_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string');
      b = launched as Browser;
      await fixture(async (base) => {
        const results: object[] = [];
        for (const [size, dimensions] of Object.entries(SIZES)) {
          const d = await device(b!, { ...dimensions, touch: size !== 'desktop', scheme: 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const requests: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) || /\/backups(?:\/|\?|$)/.test(r.url())) requests.push(`${r.method()} ${r.url()}`); });
          await p.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => { throw new Error('The Backups demo must not use the clipboard'); } } }); });
          await p.clock.setFixedTime(new Date('2026-11-03T12:00:00Z'));
          await p.goto(`${base}/styleguide?entry=backups-settings`);
          await p.getByLabel('Specimen state').waitFor();
          await p.locator('#sg-ds option').first().waitFor({ state: 'attached' });
          const themes = await p.locator('#sg-ds option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
          assert.equal(themes.length, 6);
          for (const theme of themes) {
            const response = p.waitForResponse((r) => r.url().includes('/preview.css') && r.status() === 200);
            await p.locator('#sg-ds').selectOption(theme);
            const css = await (await response).text();
            await themeApplied(p, css);
            await still(p);
            for (const state of STATES) {
              await choose(p, state);
              assert.equal(await p.locator('.sg-broken').count(), 0);
              await geometry(p, `${engine}/${theme}/${size}/${state}`);
              const root = p.locator('.backups-settings');
              const text = await root.innerText();
              if (!['first-key', 'shown', 'paired-first-key'].includes(state)) assert.ok(!(await root.innerHTML()).includes(KEY), `${state}: hidden key bytes`);
              if (state.startsWith('paired')) assert.equal(await root.locator('[data-action="backups-reveal"], [data-action="backups-confirm"]').count(), 0);
              if (['paired-viewer', 'standby', 'unavailable'].includes(state)) assert.equal(await root.locator('[data-action="backups-save"]').count(), 0);
              if (state === 'error') {
                assert.match(text, /not writable/);
                assert.equal(await root.locator('[aria-invalid="true"]').count(), 3);
                assert.equal(await p.getByLabel('Backup folder', { exact: true }).inputValue(), '/srv/backup-copies');
                assert.equal(await p.getByLabel('Copies to keep', { exact: true }).inputValue(), '0', 'the retention error preserves an actually invalid draft');
              }
              // Real token-derived foreground/background contrast, for labels/help/fields/key;
              // labels, help, fields and key use readable text in every installed package.
              const contrast = await root.evaluate((el) => {
                const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
                const lum = (s: string) => parse(s).slice(0, 3).map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
                return [...el.querySelectorAll<HTMLElement>('label, .settings-note, .input, code, .view-title')].map((node) => {
                  const style = getComputedStyle(node); let bg: Element | null = node;
                  while (bg && (getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)' || getComputedStyle(bg).backgroundColor === 'transparent')) bg = bg.parentElement;
                  const a = lum(style.color), b = lum(bg ? getComputedStyle(bg).backgroundColor : 'rgb(0, 0, 0)');
                  return { text: node.tagName, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
                });
              });
              results.push({ engine, theme, size, state, contrast });
              if (contrast.some((c) => c.ratio < 4.5)) await failureShot(p, `${engine}/${theme}/${size}/${state}-contrast`);
              assert.ok(contrast.every((c) => c.ratio >= 4.5), `${engine}/${theme}/${size}/${state}: text contrast ${JSON.stringify(contrast)}`);
              if (process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS && theme === 'orb-teal') {
                const folder = resolve(process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS, engine);
                mkdirSync(folder, { recursive: true });
                await p.screenshot({ path: join(folder, `${state}-${size}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
              }
            }
          }
          await choose(p, 'configured');
          const target = p.getByLabel('Backup folder', { exact: true });
          await p.getByLabel('Specimen state').focus();
          await p.keyboard.press('Tab');
          assert.equal(await target.evaluate((e) => e === document.activeElement), true, 'keyboard reaches first setting');
          await target.fill('/srv/edited draft');
          await p.getByRole('button', { name: 'Save backup settings', exact: true }).click();
          assert.match(await p.locator('[data-backups-demo-notice]').innerText(), /Demo only/);
          assert.equal(await target.inputValue(), '/srv/edited draft');
          await choose(p, 'confirm');
          const reveal = p.getByRole('button', { name: 'Show recovery key', exact: true });
          assert.equal(await reveal.isDisabled(), true);
          await p.getByLabel('I understand that the recovery key will be visible on this screen.').check();
          assert.equal(await reveal.isEnabled(), true);
          await reveal.click();
          assert.equal(await p.locator('.backups-settings code').innerText(), KEY);
          await p.getByRole('button', { name: 'Copy key', exact: true }).click();
          assert.match(await p.locator('[data-backups-demo-notice]').innerText(), /clipboard is unchanged/);
          await p.getByRole('button', { name: 'Hide key', exact: true }).click();
          assert.ok(!(await p.locator('.backups-settings').innerHTML()).includes(KEY));
          await choose(p, 'empty');
          assert.equal(await p.getByLabel('Copies to keep', { exact: true }).getAttribute('min'), '1');
          assert.equal(await p.getByLabel('Copies to keep', { exact: true }).getAttribute('max'), '365');
          // Axe checks only this component: the catalogue's inherited heading structure is outside it.
          await p.addScriptTag({ content: readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') });
          for (const state of ['empty', 'error', 'confirm', 'shown', 'paired-viewer']) {
            await choose(p, state);
            const axe = await p.evaluate(async () => (window as any).axe.run(document.querySelector('.backups-settings')));
            assert.deepEqual(axe.violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })), [], `${engine}/${size}/${state}: axe`);
          }
          assert.deepEqual(requests, [], 'no backup/key requests or mutation requests');
          assert.deepEqual(d.errors, []);
          await d.ctx.close();
        }
        if (process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS) writeFileSync(join(resolve(process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS), `${engine}-matrix.json`), JSON.stringify(results, null, 2));
      });
    } finally { await b?.close(); }
  });

  test(`Backups ${engine}: shared loading wait preserves age in every posture and theme`, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string');
      b = launched as Browser;
      await fixture(async (base) => {
        const measured: object[] = [];
        for (const [size, dimensions] of Object.entries(SIZES)) {
          const d = await device(b!, { ...dimensions, touch: size !== 'desktop', scheme: 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const requests: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) || /\/backups(?:\/|\?|$)/.test(r.url())) requests.push(`${r.method()} ${r.url()}`); });
          await p.clock.setFixedTime(new Date('2026-11-03T12:00:00Z'));
          await p.goto(`${base}/styleguide?entry=backups-settings`);
          await choose(p, 'loading');
          const waiting = p.locator('.backups-settings [data-waiting="view-backups"]');
          assert.equal(await waiting.count(), 1, 'Backups must compose the shared wait line');
          const since = Number(await waiting.getAttribute('data-since'));
          assert.equal(since, Date.parse('2026-11-03T12:00:00Z') - 1500, 'the specimen supplies a stable request start');
          const themes = await p.locator('#sg-ds option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
          assert.equal(themes.length, 6);
          for (const theme of themes) {
            const response = p.waitForResponse((r) => r.url().includes('/preview.css') && r.status() === 200);
            await p.locator('#sg-ds').selectOption(theme);
            const css = await (await response).text();
            await themeApplied(p, css);
            for (const [phase, elapsed] of [['quiet', 400], ['indicator', 1500], ['long', 12000]] as const) {
              await p.clock.setFixedTime(new Date(since + elapsed));
              await choose(p, 'loading');
              assert.equal(await waiting.getAttribute('data-since'), String(since), 'redraw retains the actual start');
              assert.equal(await p.locator('.backups-settings').getAttribute('aria-busy'), 'true');
              assert.equal(await waiting.getAttribute('role'), 'status');
              assert.equal(await p.locator('.backups-settings form, .backups-settings button, .backups-settings input').count(), 0);
              const text = await waiting.innerText();
              if (phase === 'quiet') {
                assert.equal(await waiting.getAttribute('class'), 'waiting');
                assert.match(await waiting.getAttribute('style') ?? '', /--wait-left: 600ms/);
                assert.equal(await waiting.evaluate((e) => getComputedStyle(e).opacity), '0', 'under 1s the indicator is unseen');
              } else {
                assert.match(await waiting.getAttribute('class') ?? '', /is-late/);
                assert.equal(await waiting.evaluate((e) => getComputedStyle(e).opacity), '1');
              }
              if (phase === 'long') assert.match(text, /12 s so far · it usually takes under a second/);
              else assert.doesNotMatch(text, /so far|it usually takes/);
              assert.doesNotMatch(text, /%|of \d/);
              await geometry(p, `${engine}/${theme}/${size}/loading-${phase}`);
              measured.push({ engine, theme, size, phase, elapsed, since, text });
              if (process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS && theme === 'orb-teal') {
                const folder = resolve(process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS, 'ci-i1-loading', engine);
                mkdirSync(folder, { recursive: true });
                // Fast-forwarding the finite appear animation would falsify the quiet screenshot.
                await p.screenshot({ path: join(folder, `loading-${phase}-${size}.png`), fullPage: true, animations: phase === 'quiet' ? 'allow' : 'disabled', caret: 'hide' });
              }
            }
          }
          assert.deepEqual(requests, []);
          assert.deepEqual(d.errors, []);
          await d.ctx.close();
        }
        if (process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS) writeFileSync(join(resolve(process.env.NOVA_BACKUPS_STYLEGUIDE_SHOTS), `${engine}-loading-matrix.json`), JSON.stringify(measured, null, 2));
      });
    } finally { await b?.close(); }
  });
}
