// Review of PR #238, must-fix 1: a pause that arrives while Nova's world is being made for an action
// must stop that action. A real Chromium session on the stand-in shop; its CDP is wrapped so the
// person's pause lands exactly during `Page.createIsolatedWorld` for the action (the await between
// the gate and the call that acts). For a fill, a click, an element action (a11y target) and a click
// at a point: the stand-in server sees nothing while paused, and the action happens once, after
// resume. Stop during the same window: nothing at all. Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type LaunchOptions } from '../../src/core/browser/chromium.ts';
import { Session } from '../../src/core/browser/session.ts';
import { CLICK, FILL } from '../../src/core/browser/facts.ts';
import { chromiumPath } from './support.ts';
import { canBrowse, sleep, startShop } from './m10b-support.ts';

const H = { key: 'console', label: 'The hub’s own screen' };

async function rigged(host: string) {
  let arm: null | ((s: Session) => void) = null;
  let s!: Session;
  const wrapped = async (o: LaunchOptions) => {
    const l = await launch(o);
    const send = l.cdp.send.bind(l.cdp);
    l.cdp.send = ((method: string, params?: Record<string, unknown>, sid?: string, opt?: { timeoutMs?: number }) => {
      if (method === 'Page.createIsolatedWorld' && arm) { const fn = arm; arm = null; fn(s); }
      return send(method, params, sid, opt);
    }) as typeof l.cdp.send;
    return l;
  };
  s = new Session({ taskId: 'task-race-1', chromium: chromiumPath(), hosts: [host], sandbox: false, launch: wrapped });
  return { s, armWith: (fn: (s: Session) => void) => { arm = fn; } };
}

test('review 1: a pause during the world read stops a pending fill, click, element action and point click; stop stops it for good', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const { s, armWith } = await rigged(shop.host);
  try {
    await s.open();
    await s.navigate(`${shop.url}/race`);
    const sel = (q: string) => JSON.stringify(q);
    const cases: [string, () => Promise<unknown>, () => number][] = [
      ['fill (selector, act)', () => s.act(`(${FILL}).apply(document.querySelector(${sel('#field')}), ["typed"])`), () => shop.hits('/saw-input').length],
      ['fill (a11y target, actOn)', () => s.actOn({ target: { role: 'textbox', name: 'Note' } }, FILL, ['again']), () => shop.hits('/saw-input').length],
      ['click (selector, act)', () => { s.allowSends(1, [`${shop.url}/cart/add`]); return s.act(`(${CLICK}).apply(document.querySelector(${sel('#add')}), [])`); }, () => shop.hits('/cart/add').length],
    ];
    for (const [what, run, seen] of cases) {
      if (!s.url.endsWith('/race')) await s.navigate(`${shop.url}/race`);
      const before = seen();
      armWith((x) => x.pause(H));
      const pending = run();
      await sleep(1500);
      assert.equal(s.mode, 'paused', what);
      assert.equal(seen(), before, `${what}: nothing reached the server while paused`);
      s.resume(H);
      assert.equal(await pending, 'ok', what);
      await s.settle();
      await sleep(300);
      assert.equal(seen(), before + 1, `${what}: it happened once, after resume`);
      s.allowSends(null);
    }
    // A click at a point (the vision fallback's) has nothing to await between its check and the
    // click; asked for while paused, it waits until resume.
    await s.navigate(`${shop.url}/race`);
    s.pause(H);
    let clicked = false;
    const point = s.clickAt(5, 5).then(() => { clicked = true; });
    await sleep(800);
    assert.equal(clicked, false, 'a point click waits while paused');
    s.resume(H);
    await point;
    assert.equal(clicked, true);
    // Stop during the window: the action never runs, and nothing lands afterwards.
    await s.navigate(`${shop.url}/race`);
    const before = shop.hits('/saw-input').length;
    armWith((x) => { void x.close('stopped by the person'); });
    await assert.rejects(s.act(`(${FILL}).apply(document.querySelector(${sel('#field')}), ["late"])`));
    await sleep(800);
    assert.equal(shop.hits('/saw-input').length, before, 'stopped: nothing ran');
  } finally {
    await s.close();
    await shop.close();
  }
});
