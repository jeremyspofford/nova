// Owner's stage-1 approval, 2026-11-01: reproduce F0's actual geometry, not the larger
// desktop specimen. This protects the existing fix; no new composer behavior is claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { browser, webkitBrowser, device, ready, shotsDir, still } from './support.ts';
import { reviewProfile } from './axe-support.ts';
import { withMesh } from './fold-support.ts';

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`F0: 20-line composer stays a bounded control at 1280x820 (${engine})`, async (t) => {
    const b = await launch();
    if (typeof b === 'string') { t.skip(b); return; }
    t.after(() => b.close());
    const { m, nova } = await reviewProfile(`nova-f0-${engine}-`);
    t.after(async () => { await stop(nova); rmSync(m.dir, { recursive: true, force: true }); });
    const d = await device(b, { width: 1280, height: 820, scheme: 'dark', serviceWorkers: 'block' });
    await withMesh(d.ctx);
    await d.page.clock.setFixedTime(new Date('2026-10-31T12:00:00.000Z'));
    await d.page.goto(`${m.base}/chat`);
    await ready(d.page);
    const box = d.page.locator('#composer textarea').first();
    await box.fill(Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: a note for the weekly plan.`).join('\n'));
    await d.page.waitForFunction(() => document.querySelector('#composer')?.classList.contains('is-grown'));
    await still(d.page);
    await box.evaluate((e) => { e.scrollTop = 0; });
    const geometry = await box.evaluate((e) => {
      const input = e as HTMLTextAreaElement;
      const form = document.querySelector<HTMLElement>('#composer')!;
      const rect = form.getBoundingClientRect();
      const style = getComputedStyle(form);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        lines: input.value.split('\n').length,
        inputHeight: input.getBoundingClientRect().height,
        scrollHeight: input.scrollHeight,
        clientHeight: input.clientHeight,
        radius: style.borderTopLeftRadius,
        controlRadius: getComputedStyle(document.documentElement).getPropertyValue('--radius-input').trim(),
        form: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    assert.deepEqual(geometry.viewport, { width: 1280, height: 820 });
    assert.equal(geometry.lines, 20);
    assert.ok(geometry.scrollHeight > geometry.clientHeight, 'all twenty lines really overflow the grown control');
    assert.ok(geometry.inputHeight <= 820 * 0.25 + 1, JSON.stringify(geometry));
    assert.equal(geometry.radius, geometry.controlRadius, 'the grown composer keeps the control radius, never a pill or ellipse');
    assert.ok(!geometry.radius.includes('%') && parseFloat(geometry.radius) < geometry.form.height / 4);
    assert.ok(geometry.form.x >= 0 && geometry.form.right <= 1280 && geometry.form.bottom <= 821);
    assert.ok(geometry.pageWidth <= 1280, 'the original window has no horizontal overflow');
    assert.equal(d.errors.length, 0, d.errors.join('\n'));
    console.log(`F0 ${engine} ${JSON.stringify(geometry)}`);
    const out = shotsDir();
    if (out) {
      await d.page.screenshot({ path: join(out, `composer-20-lines-1280x820-${engine}.png`), animations: 'disabled', caret: 'hide' });
      writeFileSync(join(out, `composer-20-lines-1280x820-${engine}.json`), `${JSON.stringify(geometry, null, 2)}\n`);
    }
  });
}
