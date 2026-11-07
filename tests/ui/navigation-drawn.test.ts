// The navigation crawl's step (navigation-support.ts press, then drawn) must not return into a
// conversation whose entrance hasn't begun. app.js renderAll draws a conversation whole under
// no-anim and enables its fade from opacity 0 on the next frame; a crawl read on that fade's first
// frame saw no links in the thread (#356's phone failure: the /schedules link "missing"). Here that
// frame is held for 300 ms, so the window is open every time, not by chance. press() also waits for
// the tap's route to change first: until it does, the page it left still reads as ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, until } from './support.ts';
import { drawn, press, trackDocument } from './navigation-support.ts';

test('press() waits for the route, then drawn() waits out a conversation’s held entrance before anything is read', { timeout: 120_000 }, async () => {
  const b = await browser();
  assert.notEqual(typeof b, 'string', 'needs a real browser');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-drawn-');
  const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    writeFileSync(join(m.home, 'sessions', '2026-11-02-nav001.jsonl'), [
      { ts: '2026-11-02T12:00:00Z', type: 'session', id: '2026-11-02-nav001', title: 'Navigation example', v: 1 },
      { ts: '2026-11-02T12:01:00Z', type: 'handoff', id: 'navigation-report', name: 'Navigation schedule', schedule: 'navigation-example', text: 'A synthetic completed report.', ok: true },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const d = await device(b, { width: 390, height: 900, touch: true, serviceWorkers: 'block' });
    const page = d.page;
    trackDocument(page);
    await d.ctx.addInitScript(() => {
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => (String(cb).includes("el.thread.classList.remove('no-anim')") ? (setTimeout(() => original.call(window, cb), 300), -1) : original.call(window, cb));
    });
    await page.goto(`${m.base}/`);
    await drawn(page);
    await press(page, { href: '/chat', label: 'Chat', section: '' }, true);
    await press(page, { button: '#menu', label: 'Conversations' }, true);
    await press(page, { href: '/c/2026-11-02-nav001', label: 'Navigation example', section: '' }, true);
    const at = await page.evaluate(() => {
      const t = document.getElementById('thread')!;
      const a = document.querySelector<HTMLElement>('a[href="/schedules#sc-navigation-example"]');
      return { noAnim: t.classList.contains('no-anim'), opacity: getComputedStyle(t).opacity, link: !!a?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) };
    });
    assert.deepEqual(at, { noAnim: false, opacity: '1', link: true }, 'drawn() returned after the entrance ran, with the thread’s links readable');
  } finally { await b.close(); await stop(nova); }
});

test('until() awaits an async check, as page.waitForFunction does not', { timeout: 60_000 }, async () => {
  const b = await browser();
  if (typeof b === 'string') throw new Error(b);
  try {
    const d = await device(b, {});
    await d.page.setContent('<p>x</p>');
    // The trap this replaces: a Promise is truthy, so an async predicate that says false "passes".
    assert.ok(await d.page.waitForFunction(async () => false, null, { timeout: 2000 }), 'waitForFunction resolves on an async false');
    await assert.rejects(until(d.page, async () => false, undefined, { timeout: 400 }), /Timed out after 400 ms/);
    const t0 = Date.now();
    await d.page.evaluate(() => { setTimeout(() => { (window as unknown as { done: boolean }).done = true; }, 300); });
    assert.equal(await until(d.page, async () => (window as unknown as { done?: boolean }).done === true), true);
    assert.ok(Date.now() - t0 >= 250, 'it waited for the check to come true');
  } finally { await b.close(); }
});
