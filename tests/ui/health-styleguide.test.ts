// Removing the named entries, escaping, loaded-only saving, finite validation or local-only
// interactions must fail these tests. All data belongs to a disposable synthetic server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { blank, stop } from '../acceptance/support.ts';
import { browser, webkitBrowser, device, ROOT, still } from './support.ts';
import { DEFAULT_LIMITS } from '../../src/core/caps/index.ts';
import type { Locator } from 'playwright-core';

const sizes = {
  desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844, touch: true },
  tablet: { width: 820, height: 1180, touch: true }, halfopen: { width: 1100, height: 900, touch: true },
};
const states = ['loading', 'unavailable', 'zero', 'mixed', 'configured', 'unlimited', 'invalid', 'saving', 'save-error', 'success', 'adversarial'];

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Health styleguide: ${engine} states, postures and safe local save/download`, { timeout: 300_000 }, async () => {
    const b = await launch();
    assert.notEqual(typeof b, 'string', 'a browser is required; no skips');
    if (typeof b === 'string') throw new Error(b);
    const m = blank(`nova-health-styleguide-${engine}-`);
    const nova = await m.start();
    const out = join(ROOT, 'docs/screenshots/health-caps-diagnostics-2026-11-03/styleguide', engine);
    if (process.env.NOVA_HEALTH_STYLEGUIDE_SHOTS === '1') mkdirSync(out, { recursive: true });
    try {
      for (const [posture, size] of Object.entries(sizes)) {
        const d = await device(b, { ...size, scheme: 'dark', serviceWorkers: 'block' });
        const p = d.page;
        const activate = (control: Locator) => 'touch' in size ? control.tap() : control.click();
        const forbidden: string[] = [];
        p.on('request', (r) => {
          if (!['GET', 'HEAD'].includes(r.method()) || /\/api\/v1\/(caps|diagnostics)(?:[/?]|$)/.test(r.url())) forbidden.push(`${r.method()} ${r.url()}`);
        });
        for (const entry of ['work-costs', 'diagnostics']) {
          await p.goto(`${m.base}/styleguide?entry=${entry}`);
          await p.locator('#sg-ds').waitFor();
          assert.equal(await p.locator(`#sg-${entry}`).count(), 1, `missing named ${entry} entry`);
          assert.equal(await p.locator('.sg-broken').count(), 0);
          for (const state of entry === 'work-costs' ? states : ['available', 'unavailable']) {
            await p.locator(`#${entry}-state`).selectOption(state);
            await p.locator(`[data-${entry}-state="${state}"]`).waitFor();
            assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${entry}/${state}/${posture}: page overflow`);
            assert.deepEqual(await p.locator(`#sg-${entry}`).evaluate((root) => [...root.querySelectorAll<HTMLElement>('input, button, p, label, summary, .settings-control')].filter((e) => e.clientWidth && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent)), [], `${entry}/${state}/${posture}: clipped text`);
            if (entry === 'work-costs') {
              assert.equal(await p.locator('[data-save-work-limits]').isDisabled(), ['loading', 'unavailable', 'saving', 'invalid'].includes(state));
              assert.equal(await p.locator('input[type="number"]').count(), 6);
              if (state === 'mixed') {
                assert.match(await p.locator('.work-costs').innerText(), /23,000 tokens/);
                assert.match(await p.locator('.work-costs').innerText(), /4,000 estimated/);
                assert.match(await p.locator('.work-costs').innerText(), /6,000 unpriced/);
                for (const [scope, values] of Object.entries(DEFAULT_LIMITS)) for (const [key, value] of Object.entries(values)) {
                  assert.equal(await p.locator(`[name="${scope}.${key}"]`).inputValue(), String(value), 'public specimen defaults match Core');
                }
              }
              if (state === 'adversarial') assert.equal(await p.locator('.work-costs img').count(), 0);
            }
            await still(p);
            if (process.env.NOVA_HEALTH_STYLEGUIDE_SHOTS === '1') await p.screenshot({ path: join(out, `${entry}-${state}-${posture}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
          }
          await p.locator(`#${entry}-state`).selectOption(entry === 'work-costs' ? 'mixed' : 'available');
          await activate(p.locator(`#sg-${entry} summary`));
          assert.equal(await p.locator(`#sg-${entry} details`).getAttribute('open'), '');
          assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'expanded disclosure has no overflow');
          if (entry === 'work-costs') assert.match(await p.locator('.work-cost-details').innerText(), /Provider-owned loops are not capped live/);
          else assert.match(await p.locator('.work-cost-details').innerText(), /not a guarantee that every private detail is removed/);
          if (process.env.NOVA_HEALTH_STYLEGUIDE_SHOTS === '1') await p.screenshot({ path: join(out, `${entry}-details-${posture}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
          if (entry === 'work-costs') {
            await p.locator('#work-costs-state').selectOption('configured');
            const field = p.getByRole('spinbutton', { name: 'Per task priced USD', exact: true });
            await field.fill('1.25');
            await p.evaluate(() => { window.dispatchEvent(new Event('nova:appearance')); return new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
            assert.equal(await field.inputValue(), '1.25', 'appearance redraw preserves unsaved edits');
            for (const invalid of ['', '0', '-1', '1e309']) {
              await field.fill(invalid);
              await activate(p.locator('[data-save-work-limits]'));
              await p.waitForFunction(() => document.querySelector('[data-work-costs-notice]')?.textContent?.includes('finite number greater than zero'));
              assert.equal(await field.getAttribute('aria-invalid'), 'true', `${invalid}: rejected`);
              assert.match(await p.locator('[data-work-costs-notice]').innerText(), /finite number greater than zero/);
              await field.fill('0.75');
            }
            await p.getByLabel('Per task priced USD unlimited', { exact: true }).check();
            assert.equal(await field.isDisabled(), true);
            await activate(p.locator('[data-save-work-limits]'));
            await p.waitForFunction(() => document.querySelector('[data-work-costs-notice]')?.textContent?.includes('No limits were saved'));
            assert.match(await p.locator('[data-work-costs-notice]').innerText(), /No limits were saved/);
            await p.getByLabel('Per task priced USD unlimited', { exact: true }).uncheck();
            assert.equal(await field.inputValue(), '0.75', 'unlimited toggle preserves the edited number');
          } else {
            await p.locator('#diagnostics-state').selectOption('available');
            const link = p.getByRole('link', { name: 'Download diagnostics', exact: true });
            assert.equal(await link.getAttribute('download'), '');
            assert.equal(await link.getAttribute('href'), '#sg-diagnostics', 'even opening the specimen link separately cannot read diagnostics');
            await link.focus();
            await p.keyboard.press('Enter');
            await p.waitForFunction(() => document.querySelector('[data-diagnostics-notice]')?.textContent?.includes('No file was downloaded'));
            assert.match(await p.locator('[data-diagnostics-notice]').innerText(), /No file was downloaded/);
            await link.click({ button: 'middle' });
            assert.equal(d.ctx.pages().length, 1, 'auxiliary activation stays local too');
            if ('touch' in size) {
              await p.locator('#diagnostics-state').selectOption('available');
              await link.tap();
              await p.waitForFunction(() => document.querySelector('[data-diagnostics-notice]')?.textContent?.includes('No file was downloaded'));
            }
            await p.locator('#diagnostics-state').selectOption('unavailable');
            assert.equal(await p.getByRole('button', { name: 'Download diagnostics', exact: true }).isDisabled(), true);
          }
        }
        assert.deepEqual(forbidden, [], 'specimens never read real costs/diagnostics or send mutations');
        assert.deepEqual(d.errors, [], 'no browser errors');
        await d.ctx.close();
      }
    } finally { await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true }); }
  });
}
