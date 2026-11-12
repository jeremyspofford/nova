// While the main conversation loads, its composer (#dock) holds its place unseen (components.css,
// body[data-dock-wait]). Verifier finding V-1 on the served build 9fd054a2: on a slow load it was
// transparent but not hidden from assistive tech, so Tab reached invisible controls and a screen
// reader heard "Local only" and "Voice is off in local-only mode…" while the real mode was Local
// first. Unseen means unreachable (inert) too, and nothing in it claims a privacy mode before the
// profile has answered (the status-truth rule, docs/ledger/2026-11-10-status-truth.md). Once the
// conversation is in, the composer is reachable, has the arrival's focus, and names the true mode.
// The real server underneath; only the browser's reads are held. Chromium and WebKit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, webkitBrowser } from './support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDE = { width: 1280, height: 820, serviceWorkers: 'block' as const };
// What the composer said before the profile was in, whatever the real mode.
const LOCAL_ONLY = /Local only|local-only mode/i;

async function slowChat(b: Browser, base: string, engine: string) {
  const d = await device(b, WIDE);
  await d.ctx.route('**/api/**', async (r) => { await sleep(6000); await r.fallback().catch(() => {}); });
  await d.page.goto(`${base}/chat`, { waitUntil: 'commit' });
  // The window: the page shows (the shell is visible, the dock not `hidden`) and the conversation's
  // snapshot is still held back, so the dock waits unseen.
  await d.page.waitForFunction(() => document.body.hasAttribute('data-dock-wait') && !document.getElementById('dock')!.hidden && getComputedStyle(document.querySelector('.shell')!).visibility === 'visible', null, { timeout: 15000 });
  assert.equal(await d.page.evaluate(() => getComputedStyle(document.getElementById('dock')!).opacity), '0', `${engine}: the dock is unseen while it waits`);

  // (a) While the dock waits, nothing in it is reachable: inert (or aria-hidden), and Tab never lands in it.
  const hidden = await d.page.evaluate(() => {
    const dock = document.getElementById('dock')!;
    return { inert: dock.inert, ariaHidden: dock.closest('[aria-hidden="true"]') !== null };
  });
  assert.ok(hidden.inert || hidden.ariaHidden, `${engine}: the waiting dock is hidden from assistive tech (${JSON.stringify(hidden)})`);
  await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const reached: string[] = [];
  for (let i = 0; i < 60; i++) {
    await d.page.keyboard.press('Tab');
    const at = await d.page.evaluate(() => {
      const a = document.activeElement;
      return a && a !== document.body ? `${a.closest('#dock') ? 'DOCK ' : ''}${a.tagName.toLowerCase()}#${a.id}` : 'body';
    });
    reached.push(at);
  }
  assert.deepEqual(reached.filter((r) => r.startsWith('DOCK')), [], `${engine}: Tab never reaches the unseen composer`);
  // Put focus back where the arrival left it: a person who hasn't moved it.
  await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // (b) Nothing assistive tech reads claims Local only: not the page's accessibility tree, and not
  // the hidden placeholder either.
  const tree = await d.page.locator('body').ariaSnapshot();
  assert.doesNotMatch(tree, LOCAL_ONLY, `${engine}: the accessibility tree claims no privacy mode it hasn't read:\n${tree}`);
  const placeholder = await d.page.evaluate(() => `${document.getElementById('privacy-chip')!.textContent} | ${document.getElementById('privacy-chip')!.getAttribute('aria-label')} | ${document.getElementById('voice-note')!.textContent}`);
  assert.doesNotMatch(placeholder, LOCAL_ONLY, `${engine}: the composer's own words claim no mode before the profile is in: ${placeholder}`);
  // All of that was during the wait.
  assert.equal(await d.page.locator('body[data-dock-wait]').count(), 1, `${engine}: still waiting when checked`);

  // (c) Once in: the composer is shown, reachable, has the arrival's focus, and names the true mode.
  await ready(d.page);
  await d.page.waitForSelector('body:not([data-dock-wait]) #thread .chat-empty', { timeout: 30000 });
  await d.page.waitForFunction(() => document.getElementById('privacy-chip')?.textContent === 'Local first', null, { timeout: 30000 });
  const after = await d.page.evaluate(() => {
    const dock = document.getElementById('dock')!;
    return { inert: dock.inert, ariaHidden: dock.closest('[aria-hidden="true"]') !== null, opacity: getComputedStyle(dock).opacity, focus: document.activeElement?.id ?? '', label: document.getElementById('privacy-chip')!.getAttribute('aria-label'), voice: document.getElementById('voice-note')!.textContent };
  });
  assert.equal(after.inert, false, `${engine}: the shown dock is not inert`);
  assert.equal(after.ariaHidden, false, `${engine}: the shown dock is not aria-hidden`);
  assert.equal(after.opacity, '1', `${engine}: the dock shows`);
  assert.equal(after.focus, 'input', `${engine}: the composer has the arrival's focus`);
  assert.equal(after.label, 'Privacy: Local first. Change in Settings');
  assert.doesNotMatch(after.voice ?? '', LOCAL_ONLY, `${engine}: no local-only voice note under Local first`);
  assert.match(await d.page.locator('body').ariaSnapshot(), /Local first/, `${engine}: assistive tech hears the true mode`);
  await d.page.keyboard.type('hello');
  assert.equal(await d.page.locator('#input').inputValue(), 'hello', `${engine}: the composer takes typing`);
  assert.deepEqual(d.errors, [], `${engine}: no page errors`);
  await d.ctx.close();
}

test('V-1: while the main conversation loads, its unseen composer is inert and claims no privacy mode; then it shows the true one', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-chat-dock-hidden-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    // The verifier's profile: Local first (the default is Local only, which would hide the claim).
    assert.equal((await m.send('PUT', '/api/v1/profile/privacy/default', { value: 'local-preferred', confirm: true })).status, 200);
    await slowChat(b, m.base, 'chromium');
    const w = await webkitBrowser();
    if (typeof w !== 'string') { try { await slowChat(w, m.base, 'webkit'); } finally { await w.close(); } } else t.diagnostic(`webkit skipped: ${w}`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
