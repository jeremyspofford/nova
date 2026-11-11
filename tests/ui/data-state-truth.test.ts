// What a page says before its data is in, or when it never comes, is true (the status-truth rule,
// docs/ledger/2026-11-10-status-truth.md). Walker findings on the served build f0a83d4e (QA/UX loop):
//   W-3: with Nova's API unreachable, Home and the right column never say an empty state ("No brief
//        yet", "Nothing kept yet", "Nothing in progress", "Only this device for now"); each part
//        says it couldn't be loaded, with Try again.
//   W-4: with a slow API, the page title and the rail's current mark are there at once (they need no
//        data), the main column waits with the loading pattern, and the right column waits too:
//        never an empty-state sentence before its data has arrived.
//   W-6: Health on a slow link doesn't jump when its data lands (CLS under 0.1).
//   W-7: a conversation whose server can't be reached ends in "couldn't be opened" with Try again,
//        never "Loading the conversation…" for good; Send stays off; Try again opens it once back.
// The real server underneath; only the browser's reads are held or cut. No model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, ready, shotsDir, webkitBrowser } from './support.ts';
import { CHAT, seeded } from './m9-support.ts';
import { observe, compute } from './vitals-support.ts';
import { withHealthProblem } from './health-problem-fixture.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDE = { width: 1280, height: 820, serviceWorkers: 'block' as const, scheme: 'dark' as const };
// The empty states a part may say only once it has answered.
const EMPTY_WORDS = /No brief yet|Nothing kept yet|Nothing in progress|Only this device for now/;
const shown = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => (n as HTMLElement).innerText).join('\n'), sel);
const SHOTS = shotsDir();
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `data-state-${name}.png`) }); };

async function unreachableHome(b: Browser, base: string, engine: string) {
  const d = await device(b, WIDE);
  await d.ctx.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await d.page.goto(`${base}/`, { waitUntil: 'commit' });
  await d.page.waitForFunction(() => /isn’t answering/.test(document.getElementById('banner')?.textContent ?? ''), null, { timeout: 20000 });
  await d.page.waitForSelector('#home .home-cards');
  await sleep(1500);
  const said = `${await shown(d.page, '#home')}\n${await shown(d.page, '#aside')}`;
  await shot(d.page, `api-down-home-${engine}`);
  assert.doesNotMatch(said, EMPTY_WORDS, `${engine}: no empty state while Nova is unreachable:\n${said}`);
  assert.match(said, /Tasks couldn’t be loaded/, `${engine}: the work Nova is handling says it couldn't be loaded`);
  assert.match(said, /Devices couldn’t be loaded/, `${engine}: the devices say they couldn't be loaded`);
  assert.match(said, /Memory couldn’t be loaded/, `${engine}: memory says it couldn't be loaded`);
  assert.match(said, /Brief couldn’t be loaded/, `${engine}: the brief makes no claim either`);
  assert.ok(await d.page.locator('#home .home-cards [data-action="retry-part"]:visible, #aside [data-action="retry-part"]:visible').count() >= 3, `${engine}: each part has Try again`);
  await d.ctx.close();
}

test('W-3: with Nova unreachable, Home and the right column say what couldn’t be loaded, never an empty state', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ui-data-state-down-');
  try {
    await unreachableHome(b, m.base, 'chromium');
    const w = await webkitBrowser();
    if (typeof w !== 'string') { try { await unreachableHome(w, m.base, 'webkit'); } finally { await w.close(); } }

    // Try again, once Nova answers, reads the part and draws it in place.
    const d = await device(b, WIDE);
    let down = true;
    await d.ctx.route('**/api/**', (r) => (down ? r.abort('internetdisconnected') : r.continue()));
    await d.page.goto(`${m.base}/`, { waitUntil: 'commit' });
    await d.page.waitForSelector('#home .memory-highlight-card [data-action="retry-part"]');
    down = false;
    await d.page.locator('#home .memory-highlight-card [data-action="retry-part"]').click();
    // One of the seeded memories (m9-support MEMORIES), drawn in place of the failure.
    await d.page.waitForFunction(() => /Prefers tea|raised beds|water on Sundays|short answers|Works from home|seed order/.test((document.querySelector('#home .memory-highlight-card') as HTMLElement)?.innerText ?? ''), null, { timeout: 10000 });
    assert.equal(await d.page.locator('#home .memory-highlight-card [data-action="retry-part"]').count(), 0, 'Try again is gone once memory is in');
    await d.ctx.close();
  } finally {
    await b.close();
    await stop(nova);
  }
});

const SLOW: [string, string, string][] = [['/memory', 'memory', 'Memory'], ['/tasks', 'tasks', 'Tasks'], ['/chat', 'chat', 'Nova'], ['/health', 'health', 'Health']];

test('W-4: with a slow API, the title and the rail’s mark are there at once, the page waits, and the right column says nothing it doesn’t know', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ui-data-state-slow-');
  try {
    for (const [path, dest, title] of SLOW) {
      const d = await device(b, WIDE);
      await d.ctx.route('**/api/**', async (r) => { await sleep(3000); await r.fallback().catch(() => {}); });
      await d.page.goto(`${m.base}${path}`, { waitUntil: 'commit' });
      await sleep(1200);
      await shot(d.page, `slow-${dest}-1s`);
      const now = await d.page.evaluate(() => ({
        title: document.getElementById('title')?.textContent ?? '',
        current: document.querySelector('#rail [aria-current="page"]')?.getAttribute('data-dest') ?? null,
        shown: getComputedStyle(document.querySelector('.shell')!).visibility,
        waiting: !!document.querySelector('#main [data-waiting], #main .view-waiting, #main [data-skeleton]'),
        aside: (document.getElementById('aside') as HTMLElement).innerText,
        asideWaits: !!document.querySelector('#aside [data-waiting]'),
      }));
      assert.equal(now.shown, 'visible', `${path}: the page shows`);
      assert.equal(now.title, title, `${path}: the title is there at once`);
      assert.equal(now.current, dest, `${path}: the rail marks the page at once`);
      assert.ok(now.waiting, `${path}: the main column shows it is waiting`);
      assert.doesNotMatch(now.aside, EMPTY_WORDS, `${path}: the right column says nothing it doesn’t know yet:\n${now.aside}`);
      assert.ok(now.asideWaits, `${path}: the right column waits too`);
      // And once the data is in, the right column says it.
      await d.page.waitForFunction(() => !document.querySelector('#aside [data-waiting]'), null, { timeout: 20000 });
      assert.deepEqual(d.errors, [], `${path}: no page errors`);
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});

test('W-6: Health on a slow link doesn’t jump when its data lands (CLS under 0.1)', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ui-data-state-cls-');
  try {
    // As the walker met it, a profile with an open problem and its playbook (a failed task); and one without.
    for (const problem of [true, false]) {
      const run = problem ? 'with a problem' : 'no problem';
      const d = await device(b, WIDE);
      await d.ctx.addInitScript(observe);
      if (problem) await withHealthProblem(d.ctx);
      await d.ctx.route('**/api/**', async (r) => { await sleep(3000); await r.fallback().catch(() => {}); });
      await d.page.goto(`${m.base}/health`, { waitUntil: 'commit' });
      await ready(d.page);
      await d.page.waitForFunction(() => !document.querySelector('#health-view [data-waiting]') && document.querySelector('#health-view [data-work-costs-state="ready"]'), null, { timeout: 30000 });
      await sleep(1500);
      const v = await d.page.evaluate(compute);
      console.log(`W-6 ${run}: CLS ${v.cls.toFixed(4)} ${v.moved}`);
      assert.ok(v.cls < 0.1, `${run}: Health's CLS on a slow link is ${v.cls.toFixed(4)} (${v.moved})`);
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});

async function chatDown(b: Browser, base: string, engine: string) {
  const d = await device(b, WIDE);
  let down = true;
  await d.ctx.route('**/api/**', (r) => (down ? r.abort('internetdisconnected') : r.continue()));
  await d.page.goto(`${base}/c/${CHAT}`, { waitUntil: 'commit' });
  await d.page.waitForSelector('#thread [data-missing="unreachable"]', { timeout: 15000 });
  await shot(d.page, `chat-down-${engine}`);
  assert.equal(await d.page.locator('#thread [data-waiting-view], #thread [data-skeleton]').count(), 0, `${engine}: the wait is over`);
  assert.match(await d.page.locator('#thread').innerText(), /This conversation couldn’t be opened\./);
  assert.notEqual(await d.page.locator('#title').textContent(), 'Untitled', `${engine}: a conversation that couldn’t be read isn’t called Untitled`);
  await d.page.locator('#input').fill('typed while down');
  assert.equal(await d.page.locator('#send').isDisabled(), true, `${engine}: Send stays off while Nova is unreachable`);
  // Back: Try again opens the conversation.
  down = false;
  await d.page.locator('#thread [data-action="retry-chat"]').click();
  await d.page.waitForSelector('#thread .turn', { timeout: 15000 });
  assert.equal(await d.page.locator('#thread [data-missing]').count(), 0, `${engine}: the failure is gone once it opens`);
  await d.ctx.close();
}

test('W-7: a conversation whose server can’t be reached says it couldn’t be opened, with Try again, and Send stays off', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-ui-data-state-chat-');
  try {
    await chatDown(b, m.base, 'chromium');
    // The main conversation too, at /chat.
    const d = await device(b, WIDE);
    await d.ctx.route('**/api/**', (r) => r.abort('internetdisconnected'));
    await d.page.goto(`${m.base}/chat`, { waitUntil: 'commit' });
    await d.page.waitForSelector('#thread [data-missing="unreachable"] [data-action="retry-chat"]', { timeout: 15000 });
    await d.ctx.close();
    const w = await webkitBrowser();
    if (typeof w !== 'string') { try { await chatDown(w, m.base, 'webkit'); } finally { await w.close(); } }
  } finally {
    await b.close();
    await stop(nova);
  }
});
