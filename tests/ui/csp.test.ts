// The Content-Security-Policy (src/core/csp.ts) breaks nothing Nova draws: every place in the app,
// the pairing page and the styleguide (with a few of its entries, and another design system
// previewed, which refills the nonced <style id="ds">) load at a desktop and on a phone, in
// Chromium and WebKit, with no `securitypolicyviolation` event and no console line about the policy.
// And the watch itself is real: an inline script and a <style> slipped into the page are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, watchCsp, webkitBrowser } from './support.ts';

const APP = ['/', '/chat', '/new', '/tasks', '/memory', '/settings', '/health', '/about', '/changelog', '/pipeline'];
const STYLEGUIDE = ['/styleguide', '/styleguide?entry=status-icon', '/styleguide?entry=nebula-match', '/styleguide?entry=jarvis', '/styleguide?ds=nova&mode=dark'];
const LAYOUTS = [['desktop', 1440, 900, false], ['phone', 390, 844, true]] as const;

const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 400)));

async function sweep(b: Browser, engine: string, base: string) {
  for (const [layout, width, height, touch] of LAYOUTS) {
    const d = await device(b, { width, height, touch, serviceWorkers: 'block' });
    const read = await watchCsp(d.page);
    const found: string[] = [];
    try {
      for (const path of [...APP, '/pair', ...STYLEGUIDE]) {
        const res = await d.page.goto(base + path);
        assert.ok(res?.headers()['content-security-policy'], `${engine} ${layout} ${path}: served with the policy`);
        if (APP.includes(path)) await ready(d.page);
        else if (path.startsWith('/styleguide')) await d.page.waitForFunction(() => (document.getElementById('sg')?.childElementCount ?? 0) > 0);
        else await d.page.waitForFunction(() => !/Checking this browser/.test(document.getElementById('pair-body')?.textContent ?? ''), undefined, { timeout: 15_000 }).catch(() => {});
        if (path === '/styleguide?ds=nova&mode=dark') await d.page.waitForFunction(() => document.documentElement.dataset.sgPreview === 'nova-dark');
        await settle(d.page);
        found.push(...(await read()).map((v) => `${engine} ${layout} ${path}: ${v}`));
      }
      // The design system's own CSS really applied under the nonce (the swap replaced the boot sheet).
      await d.page.goto(`${base}/`);
      await ready(d.page);
      await d.page.waitForFunction(() => !!document.getElementById('ds')?.textContent && !document.getElementById('ds-boot'));
      assert.ok(await d.page.evaluate(() => ((document.getElementById('ds') as HTMLStyleElement).sheet?.cssRules.length ?? 0) > 0), `${engine} ${layout}: the nonced design sheet is applied`);
      // Swap the design again and again (WebKit refused a refilled nonced <style> on later swaps).
      const swapped = await d.page.evaluate(async () => {
        const t = await import(String('/js/theme.js'));
        const ids = t.current().list.filter((x: { valid: boolean }) => x.valid).map((x: { id: string }) => x.id).slice(0, 3);
        const seen: string[] = [];
        for (const id of ids) for (const mode of ['light', 'dark']) {
          await t.preview(id, mode);
          const s = document.getElementById('ds') as HTMLStyleElement;
          seen.push(`${id}/${mode}:${s.sheet?.cssRules.length ?? 0}:${s.textContent!.split('\n')[0]!.includes(`(${id})`)}`);
        }
        await t.endPreview();
        return seen;
      });
      assert.ok(swapped.length >= 4 && swapped.every((s) => !/:0:|:false$/.test(s)), `${engine} ${layout}: every swapped design applies: ${swapped.join(' ')}`);
      found.push(...(await read()).map((v) => `${engine} ${layout} / (design swap): ${v}`));
      // A control: what the policy is for is refused, and the watch sees it.
      await d.page.evaluate(() => {
        const s = document.createElement('script'); s.textContent = 'window.__ran = true'; document.body.append(s);
        const st = document.createElement('style'); st.textContent = 'body { outline: 9px solid red }'; document.head.append(st);
      });
      await settle(d.page);
      assert.equal(await d.page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran ?? false), false, `${engine} ${layout}: an injected inline script never runs`);
      assert.notEqual(await d.page.evaluate(() => getComputedStyle(document.body).outlineWidth), '9px', `${engine} ${layout}: an injected <style> never applies`);
      const control = await read();
      assert.ok(control.some((v) => /script-src/.test(v)) && control.some((v) => /style-src/.test(v)), `${engine} ${layout}: the watch saw both refusals: ${JSON.stringify(control)}`);
    } finally {
      await d.ctx.close();
    }
    assert.deepEqual(found, [], `${engine} ${layout}: no Content-Security-Policy violations`);
  }
}

test('no Content-Security-Policy violation anywhere Nova draws, desktop and phone, Chromium and WebKit', { timeout: 900_000 }, async () => {
  const chromium = await browser();
  assert.notEqual(typeof chromium, 'string', 'needs a real browser');
  if (typeof chromium === 'string') throw new Error(chromium);
  const webkit = await webkitBrowser();
  const m = blank('nova-csp-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    await sweep(chromium, 'chromium', m.base);
    if (typeof webkit !== 'string') await sweep(webkit, 'webkit', m.base);
    else console.log(`WebKit skipped: ${webkit}`);
  } finally {
    await chromium.close();
    if (typeof webkit !== 'string') await webkit.close();
    await stop(nova);
  }
});
