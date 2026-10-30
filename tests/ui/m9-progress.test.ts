// M9 gate, progress (DESIGN-SYSTEM §1 "Progress and waiting", binding): in the real PWA, against the
// real server, with the waits made real (a held request, a model that thinks before it speaks):
//   under 1 s no indicator · from 1 s an indicator · after 10 s real units and an estimate ·
//   a finished answer appears whole · streamed text arrives only as the server's pieces ·
//   a failed send puts the words back with the reason · "Sending" only for a send that is slow ·
//   an edit says "Saved" only when the server does, and a failed one keeps what was typed.
// The rules themselves are unit-tested in tests/m9-wait.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page, Route } from 'playwright-core';
import { ROOT, stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { CHAT, DESKTOP, seeded, settled } from './m9-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// What a waiting indicator looks like right now: on screen and seen, and what it says.
const indicator = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => ({
  seen: Number(getComputedStyle(e).opacity) > 0.5 && (e as HTMLElement).checkVisibility(),
  text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
  how: `${e.outerHTML.slice(0, 200)} opacity ${getComputedStyle(e).opacity}`,
})), sel);

// Holds requests that match, until released.
function hold(page: Page, pattern: string | RegExp) {
  const held: Route[] = [];
  let open = false;
  const ready = page.route(pattern, (r) => { if (open || r.request().method() !== 'GET') r.fallback(); else held.push(r); });
  return { ready, release: async () => { open = true; await page.unroute(pattern); for (const r of held.splice(0)) await r.fallback().catch(() => {}); } };
}

test('M9 gate, progress: the 1 s and 10 s bands on a view that waits, with real units', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-progress-');
  try {
    const d = await device(b, DESKTOP);
    await d.page.clock.install();
    const h = hold(d.page, /\/api\/v1\/(tasks|problems|health|profile|identity|memory|triggers|messages|workers|mesh|resilience)/);
    await h.ready;
    await d.page.goto(`${m.base}/tasks`);
    await d.page.waitForSelector('html[data-ready]');
    await sleep(300);
    let w = await indicator(d.page, '#tasks-view [data-waiting]');
    assert.ok(w.length === 1, 'the view says it is waiting (one line)');
    assert.equal(w[0]!.seen, false, 'under 1 s: nothing seen');
    await d.page.clock.runFor(1200);
    await sleep(1300); // the fade-in is CSS, on the real clock
    w = await indicator(d.page, '#tasks-view [data-waiting]');
    assert.equal(w[0]!.seen, true, 'from 1 s: the indicator shows');
    assert.match(w[0]!.text, /^Loading Tasks…$/, 'it says what it waits for, and nothing more yet');
    await d.page.clock.runFor(10_000);
    w = await indicator(d.page, '#tasks-view [data-waiting]');
    assert.match(w[0]!.text, /Loading Tasks… · \d+ of \d+ parts · /, `after 10 s: real units (${w[0]!.text})`);
    assert.doesNotMatch(w[0]!.text, /%/, 'no percentage');
    await h.release();
    await settled(d.page, 'tasks');
    assert.equal(await d.page.locator('#tasks-view [data-waiting]').count(), 0, 'the indicator goes when the data is in');
    assert.deepEqual(d.errors, [], 'no errors in the page');
    await d.ctx.close();

    // A view whose data comes at once shows no indicator at all.
    const q = await device(b, DESKTOP);
    await q.ctx.addInitScript(() => {
      (window as any).__seen = 0;
      new MutationObserver(() => { for (const e of document.querySelectorAll('[data-waiting]')) if (Number(getComputedStyle(e).opacity) > 0) (window as any).__seen++; }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await q.page.goto(`${m.base}/tasks`);
    await settled(q.page, 'tasks');
    assert.equal(await q.page.evaluate(() => (window as any).__seen), 0, 'a quick load: no indicator was ever seen');
    await q.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('M9 gate, progress: chat names the real phase from 1 s, counts after 10 s, and streams only real pieces', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-chat-', { NOVA_AGENT_CMD: `THINK_MS=11500 node ${join(ROOT, 'tests/ui/m9-thinker.js')}`, NOVA_AGENT_EGRESS: 'none' });
  try {
    const d = await device(b, DESKTOP);
    // A finished answer is there whole the moment the conversation is drawn: no caret, no growing.
    await d.page.goto(`${m.base}/c/${CHAT}`);
    await settled(d.page, 'chat');
    const first = await d.page.locator('#thread').textContent();
    assert.equal(await d.page.locator('#thread .caret, #thread [data-live]').count(), 0, 'no caret on a finished answer');
    await sleep(800);
    assert.equal(await d.page.locator('#thread').textContent(), first, 'nothing more appears: nothing is replayed');

    // A new message: Nova thinks for 11.5 s before a word.
    await d.page.goto(`${m.base}/chat`);
    await settled(d.page, 'chat').catch(() => {});
    await d.page.waitForSelector('html[data-ready]');
    const pieces: string[] = [];
    await d.page.exposeFunction('__piece', (s: string) => pieces.push(s));
    await d.page.evaluate(() => {
      new MutationObserver(() => { const l = document.querySelector('#thread [data-live]'); if (l) (window as any).__piece(l.textContent ?? ''); }).observe(document.getElementById('thread')!, { subtree: true, childList: true, characterData: true });
    });
    await d.page.fill('#input', 'What should go in first?');
    await d.page.keyboard.press('Enter');
    await d.page.waitForSelector('#thread .turn:last-child .msg-user');
    assert.ok((await d.page.locator('#thread .turn:last-child .bubble').innerText()).includes('What should go in first?'), 'your words show at once');
    await sleep(400);
    let w = await indicator(d.page, '#thread [data-waiting="reply"]');
    assert.equal(w.length, 1, 'the turn is waiting on Nova');
    assert.equal(w[0]!.seen, false, 'under 1 s: no indicator');
    await sleep(1200);
    w = await indicator(d.page, '#thread [data-waiting="reply"]');
    assert.equal(w[0]!.seen, true, `from 1 s: it shows (${w[0]!.how})`);
    assert.match(w[0]!.text, /^Thinking…$/, 'named for the real phase, never “typing”');
    await sleep(9500);
    w = await indicator(d.page, '#thread [data-waiting="reply"]');
    assert.match(w[0]!.text, /^Thinking… · (0 steps done · )?1\d s so far/, `after 10 s: the time so far (${w[0]!.text})`);
    await d.page.waitForFunction(() => /the peas go first/.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 15000 });
    assert.equal(await d.page.locator('#thread [data-waiting="reply"]').count(), 0, 'Thinking goes when the words come');
    const distinct = [...new Set(pieces.map((p) => p.trim()).filter(Boolean))];
    assert.ok(distinct.length >= 2, `the reply grew as it came (${distinct.length} states)`);
    assert.ok(distinct.length <= 5, `no more states than the pieces the model sent (${distinct.length})`);
    for (const s of distinct) assert.ok('Here is what I found: the peas go first.'.startsWith(s), `each state is a real prefix: “${s}”`);
    assert.deepEqual(d.errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('M9 gate, progress: optimistic UI is honest — a slow send says so, a failed one gives the words back, an edit is saved only when it is', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-honest-', { NOVA_AGENT_CMD: `THINK_MS=200 node ${join(ROOT, 'tests/ui/m9-thinker.js')}`, NOVA_AGENT_EGRESS: 'none' });
  try {
    const d = await device(b, DESKTOP);
    await d.page.goto(`${m.base}/c/${CHAT}`);
    await settled(d.page, 'chat');
    // A send the server is slow to take: "Sending" from 1 s, under the words.
    let release: () => void = () => {};
    await d.page.route(`**/api/sessions/${CHAT}/messages`, async (r) => { await new Promise<void>((ok) => { release = ok; }); await r.fallback(); });
    await d.page.fill('#input', 'One more question');
    await d.page.keyboard.press('Enter');
    await sleep(300);
    let w = await indicator(d.page, '#thread [data-waiting="send"]');
    assert.equal(w.length === 1 && !w[0]!.seen, true, 'under 1 s: the words show, no “Sending”');
    await sleep(1200);
    w = await indicator(d.page, '#thread [data-waiting="send"]');
    assert.equal(w[0]?.seen, true, 'from 1 s: “Sending” shows');
    assert.match(w[0]!.text, /^Sending…/);
    release();
    await d.page.waitForFunction(() => !document.querySelector('#thread [data-waiting="send"]'), null, { timeout: 10000 });
    await d.page.unroute(`**/api/sessions/${CHAT}/messages`);
    await d.page.waitForFunction(() => /the peas go first/.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 15000 });

    // A send that fails: the words go back in the box, and the reason is said.
    await d.page.waitForFunction(() => document.getElementById('send')?.getAttribute('aria-label') === 'Send', null, { timeout: 15000 });
    await d.page.route(`**/api/sessions/${CHAT}/messages`, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Nova is restarting.' }) }));
    await d.page.fill('#input', 'This one fails');
    await d.page.keyboard.press('Enter');
    await d.page.waitForFunction(() => (document.getElementById('input') as HTMLTextAreaElement).value === 'This one fails');
    assert.match(await d.page.locator('#hint').innerText(), /Nova is restarting\. Your message is back in the box\./);
    assert.equal(await d.page.locator('#thread').innerText().then((x) => x.includes('This one fails')), false, 'and it isn’t left in the conversation as if sent');
    await d.page.unroute(`**/api/sessions/${CHAT}/messages`);

    // A memory edit: the new words at once, "Saved" only when the server has it.
    await d.page.goto(`${m.base}/memory`);
    await settled(d.page, 'memory');
    const item = d.page.locator('#memory .memory-item').first();
    const id = await item.getAttribute('data-id');
    let let_go: () => void = () => {};
    await d.page.route(`**/api/memory/${id}`, async (r) => { await new Promise<void>((ok) => { let_go = ok; }); await r.fallback(); });
    await item.locator('.memory-text').click();
    await d.page.keyboard.press('ControlOrMeta+a');
    await d.page.keyboard.type('Prefers green tea in the afternoon.');
    await d.page.keyboard.press('Enter');
    assert.equal(await item.locator('.memory-text').innerText(), 'Prefers green tea in the afternoon.', 'the new words show at once');
    assert.doesNotMatch(await d.page.locator('#toast').innerText().catch(() => ''), /Saved/, 'but not “Saved” yet');
    await sleep(1300);
    w = await indicator(d.page, '#memory [data-waiting="memory-save"]');
    assert.equal(w[0]?.seen, true, 'a slow save says “Saving” from 1 s');
    let_go();
    await d.page.waitForFunction(() => /Saved/.test(document.getElementById('toast')?.textContent ?? ''), null, { timeout: 10000 });
    await d.page.unroute(`**/api/memory/${id}`);

    // A failed edit: the old words come back, the reason is said, and what was typed is one tap away.
    const again = d.page.locator('#memory .memory-item').first();
    const id2 = await again.getAttribute('data-id');
    await d.page.route(`**/api/memory/${id2}`, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Nova is restarting.' }) }));
    const before = await again.locator('.memory-text').innerText();
    await again.locator('.memory-text').click();
    await d.page.keyboard.press('ControlOrMeta+a');
    await d.page.keyboard.type('A change that will not save.');
    await d.page.keyboard.press('Enter');
    await d.page.waitForFunction(() => /Nova is restarting/.test(document.getElementById('toast')?.textContent ?? ''), null, { timeout: 10000 });
    assert.equal(await d.page.locator('#memory .memory-item').first().locator('.memory-text').innerText(), before, 'the memory shows what is really saved');
    await d.page.locator('#toast button', { hasText: 'Edit again' }).click();
    assert.equal(await d.page.locator('#memory .memory-edit').inputValue(), 'A change that will not save.', 'what was typed is not lost');
    assert.deepEqual(d.errors.filter((e) => !/503/.test(e)), [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
