// A real snapshot render schedules animation enablement after its DOM already exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../src/core/browser/png.ts';
import { stop } from '../acceptance/support.ts';
import { reviewProfile } from './axe-support.ts';
import { withMesh } from './fold-support.ts';
import { openFoldView } from './fold-navigation.ts';
import { ROOT, browser, device, shotsDir } from './support.ts';

type RenderFrameFixture = typeof window & {
  foldHeldFrames: FrameRequestCallback[]; foldIntercepted: number;
  foldReleaseFrames: () => void; foldRestoreFrames: () => void;
};
// The baseline gate's existing masks, channel threshold and 2% tolerance, unchanged.
const MASK = 'time, .greeting, .greeting-sub, .device-detail, .task-meta, .verified-result-card .card-line, .capture-chip';
function share(a: Buffer, b: Buffer) {
  const x = decodePng(a), y = decodePng(b);
  assert.equal(x.width, y.width); assert.equal(x.height, y.height);
  let different = 0;
  for (let i = 0, j = 0; i < x.data.length; i += x.channels, j += y.channels) {
    if ([0, 1, 2].some((k) => Math.abs(x.data[i + k]! - y.data[j + k]!) > 48)) different++;
  }
  return different / (x.width * x.height);
}

test('fold capture waits for the actual snapshot animation frame before settling', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await reviewProfile('nova-fold-render-');
  const d = await device(b, { width: 380, height: 900, touch: true, serviceWorkers: 'block' });
  let navigation: Promise<void> | undefined;
  try {
    await withMesh(d.ctx);
    await d.page.clock.setFixedTime(new Date('2026-10-31T12:00:00.000Z'));
    await d.ctx.addInitScript(() => {
      const w = window as RenderFrameFixture;
      const original = window.requestAnimationFrame;
      w.foldHeldFrames = []; w.foldIntercepted = 0;
      window.requestAnimationFrame = (callback) => {
        if (String(callback).includes("el.thread.classList.remove('no-anim')")) {
          w.foldHeldFrames.push(callback); return -(++w.foldIntercepted);
        }
        return original.call(window, callback);
      };
      w.foldReleaseFrames = () => { for (const callback of w.foldHeldFrames.splice(0)) original.call(window, callback); };
      w.foldRestoreFrames = () => { w.foldReleaseFrames(); window.requestAnimationFrame = original; };
    });
    await openFoldView(d.page, `${m.base}/`);
    await d.page.screenshot({ animations: 'disabled', caret: 'hide', mask: [d.page.locator(MASK)] });
    navigation = openFoldView(d.page, `${m.base}/chat`);
    await d.page.waitForFunction(() => (window as RenderFrameFixture).foldIntercepted > 0 && !!document.querySelector('#thread .turn table') && document.getElementById('thread')?.textContent?.includes('And plan 3?'));
    const held = await d.page.evaluate(() => ({
      callbacks: (window as RenderFrameFixture).foldHeldFrames.length,
      noAnim: document.getElementById('thread')!.classList.contains('no-anim'),
      opacity: getComputedStyle(document.getElementById('thread')!).opacity,
      finite: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length,
    }));
    assert.equal(held.callbacks, 1, 'intercepted the actual renderAll callback');
    assert.equal(held.noAnim, true);
    assert.equal(held.opacity, '1', 'current opacity alone does not establish settled paint');
    assert.equal(held.finite, 0, 'the pending callback has not enabled the finite animations yet');
    const outcome = await Promise.race([
      navigation.then(() => 'early'),
      d.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))).then(() => 'held'),
    ]);
    await d.page.evaluate(() => (window as RenderFrameFixture).foldReleaseFrames());
    if (outcome === 'held') await navigation;
    const dir = shotsDir();
    const png = await d.page.screenshot({ ...(dir ? { path: join(dir, `fold-frame-${outcome}.png`) } : {}), animations: 'disabled', caret: 'hide', mask: [d.page.locator(MASK)] });
    const difference = share(readFileSync(join(ROOT, 'tests/ui/baselines/fold/chromium-duo-cover-chat.png')), png);
    console.log(`FOLD held render ${JSON.stringify({ outcome, sha256: createHash('sha256').update(png).digest('hex'), difference })}`);
    assert.equal(outcome, 'held', 'readiness cannot return before the actual scheduled render callback');
    assert.ok(difference <= 0.02, `settled conversation differs by ${difference * 100}% (at most 2%)`);
    assert.equal(await d.page.locator('#thread').evaluate((thread) => thread.classList.contains('no-anim')), false);
    assert.match(await d.page.locator('#thread').innerText(), /That is all for now/);
    assert.deepEqual(d.errors, []);
  } finally {
    try { await d.page.evaluate(() => (window as RenderFrameFixture).foldRestoreFrames?.()); await navigation; }
    finally { await b.close(); await stop(nova); }
  }
});
