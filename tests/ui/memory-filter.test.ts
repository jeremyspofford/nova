// Slice 1a of the knowledge-graph ADR (docs/plans/knowledge-graph-adr-2026-11-10.md §6; F-062): the
// Memory view's filter, in the page. Typing narrows the rows already loaded and keeps their order;
// it sends nothing, changes no address and puts nothing typed in browser storage. The count is a status
// line ("3 of 6 shown.") with where it looked; held items ("Waiting for your OK") are never hidden
// or counted; a section or day left with no rows goes; a forget while filtering drops the count by
// one; clearing restores everything with focus kept in the box; the arrow keys skip hidden rows; and
// at a phone's width nothing scrolls sideways and the box is a full-size target. Chromium.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { Browser, Page, Route } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, shortTargets, until } from './support.ts';
import { seeded, settled } from './m9-support.ts';

let server: Awaited<ReturnType<typeof seeded>> | null = null;
before(async () => { server = await seeded('nova-memfilter-'); });
after(async () => { if (server) { await stop(server.nova); rmSync(server.m.dir, { recursive: true, force: true }); } });

const visible = (page: Page) => page.$$eval('#memory .memory-item:not([data-candidate])', (rows) => rows.filter((r) => !r.closest('[hidden]')).map((r) => r.querySelector('.memory-text')!.textContent!.trim()));
const all = (page: Page) => page.$$eval('#memory .memory-item:not([data-candidate])', (rows) => rows.map((r) => r.querySelector('.memory-text')!.textContent!.trim()));
const countText = (page: Page) => page.$eval('#memory-filter-count', (e) => e.textContent ?? '');
const storage = (page: Page) => page.evaluate(() => JSON.stringify([Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()]));

async function type(page: Page, text: string) {
  await page.fill('#memory-filter', text);
  await until(page, (t) => (document.querySelector<HTMLInputElement>('#memory-filter')?.value ?? '') === t, text);
}

test('memory filter: narrows in the page, says how many, sends and stores nothing, survives a forget', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  t.after(() => (b as Browser).close());
  const { page, errors } = await device(b, { width: 1280, height: 900 });
  await page.goto(`${server!.m.base}/memory`);
  await settled(page, 'memory');

  const rows = await all(page);
  assert.ok(rows.length >= 6, `seeded memories: ${rows.join(' | ')}`);
  assert.equal(await countText(page), '', 'no count until something is typed');
  assert.equal(await page.$eval('#memory-filter-scope', (e) => (e as HTMLElement).hidden), true);

  // Typing: no request carries it, the address doesn't change, browser storage doesn't change.
  const url = page.url();
  const sent: string[] = [];
  page.on('request', (r) => { const s = `${r.url()} ${r.postData() ?? ''}`; if (/frida|Frida/.test(s) || /\/api\/memory/.test(r.url())) sent.push(s); });
  await page.focus('#memory-filter');
  await page.keyboard.type('Frida', { delay: 20 });
  await until(page, () => document.querySelector('#memory-filter-count')?.textContent === '1 of ' + document.querySelectorAll('#memory .memory-item:not([data-candidate])').length + ' shown.');
  assert.deepEqual(await visible(page), ['Works from home on Fridays.']);
  assert.equal(await countText(page), `1 of ${rows.length} shown.`);
  assert.equal(await page.$eval('#memory-filter-count', (e) => e.getAttribute('role')), 'status');
  assert.equal(await page.$eval('#memory-filter-scope', (e) => (e as HTMLElement).hidden ? '' : e.textContent), 'Looked in memories and day notes. Did not look inside conversations.');
  assert.equal(page.url(), url, 'the address does not change');
  // The app keeps its own timings in storage (nova.waits); what is typed must be in none of it.
  assert.doesNotMatch(await storage(page), /frida/i, 'nothing typed is written to browser storage');
  assert.deepEqual(sent, [], 'no request is made by typing');

  // Order is kept, and a section with no rows left goes.
  await type(page, 'the');
  const shown = await visible(page);
  assert.deepEqual(shown, rows.filter((r) => shown.includes(r)), 'the list keeps its order');
  assert.ok(shown.length > 1 && shown.length < rows.length, `several, not all: ${shown.join(' | ')}`);
  const emptySections = await page.$$eval('#memory .memory-section:not(#waiting)', (ss) => ss.filter((s) => !(s as HTMLElement).hidden && !s.querySelector('.memory-item:not([hidden])')).length);
  assert.equal(emptySections, 0, 'no section is shown without a row');

  // The arrow keys move between the rows shown, never to a hidden one.
  await page.focus('#memory .memory-item:not([hidden])');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).closest('[hidden]') === null && document.activeElement!.matches('.memory-item')), true);
  assert.equal(await page.evaluate(() => document.activeElement!.querySelector('.memory-text')!.textContent!.trim()), shown[1]);

  // A forget while filtering: the row leaves and the count drops by one, with no word about it.
  await page.click('#memory .memory-item:not([hidden]) [data-action="forget-memory"]', { force: true });
  await until(page, ([n, total]) => document.querySelector('#memory-filter-count')?.textContent === `${n} of ${total} shown.`, [shown.length - 1, rows.length - 1]);
  assert.equal(await page.$eval('#memory-filter', (e) => (e as HTMLInputElement).value), 'the', 'what was typed survives the re-render');

  // Clearing restores the whole list and keeps focus in the box.
  await page.focus('#memory-filter');
  await page.fill('#memory-filter', '');
  await until(page, () => !document.querySelector('#memory .memory-item[hidden]'));
  assert.equal((await visible(page)).length, rows.length - 1);
  assert.equal(await countText(page), '');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'memory-filter');

  // Nothing matches: one line says so.
  await type(page, 'zzqx');
  assert.equal(await page.$eval('#memory .memory-filter-none', (e) => (e as HTMLElement).hidden), false);
  assert.equal(await countText(page), `0 of ${rows.length - 1} shown.`);
  assert.deepEqual(errors, []);
});

test('memory filter: held items stay and are not counted; day notes filter by day', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  t.after(() => (b as Browser).close());
  const { page } = await device(b, { width: 1280, height: 900, serviceWorkers: 'block' });
  const stub = {
    sections: [{ title: 'Facts', entries: [
      { id: 'm1', text: 'The garden has four raised beds.', time: null, from: 'capture:ev1', at: '2026-11-09T10:00:00Z', updated: null, by: 'nova' },
      { id: 'm2', text: 'Works from home on Fridays.', time: null, from: null, at: null, updated: null, by: 'hand' },
    ] }],
    days: [
      { day: '2026-11-09', entries: [{ id: 'd1', text: 'Planted garlic in bed two.', time: '09:10', from: null, at: null, updated: null, by: 'nova' }] },
      { day: '2026-11-08', entries: [{ id: 'd2', text: 'Called the plumber.', time: '14:00', from: null, at: null, updated: null, by: 'nova' }] },
    ],
    candidates: [{ id: 'c1', op: 'forget', target_text: 'Works from home on Fridays.', taint: [{ origin: 'a web page', verdict: 'pass' }] }],
    titles: {},
  };
  await page.route('**/api/memory', (r: Route) => (r.request().method() === 'GET' ? r.fulfill({ json: stub }) : r.continue()));
  await page.goto(`${server!.m.base}/memory`);
  await settled(page, 'memory');

  assert.equal(await page.$eval('#m-m1 .memory-source', (e) => e.textContent), 'Nova cannot show where this came from yet.');
  assert.equal(await page.locator('#memory').getByText('from a conversation', { exact: false }).count(), 1, 'only the held item’s own words say it');

  await type(page, 'garlic');
  await until(page, () => document.querySelector('#memory-filter-count')?.textContent === '1 of 4 shown.');
  assert.deepEqual(await visible(page), ['Planted garlic in bed two.']);
  assert.equal(await page.$eval('[data-candidate="c1"]', (e) => !e.closest('[hidden]')), true, 'the held item stays');
  const days = await page.$$eval('#memory .memory-day', (hs) => hs.map((h) => [(h as HTMLElement).hidden, h.textContent]));
  assert.deepEqual(days.map(([hidden]) => hidden), [false, true], 'the day with no row left goes');
  assert.equal(await page.$eval('#memory .memory-section:not(#waiting):not([aria-labelledby="ms-days"])', (s) => (s as HTMLElement).hidden), true, 'Facts, with no row left, goes');
});

// The focus order is the ADR's (docs/plans/knowledge-graph-adr-2026-11-10.md §6, "Acceptance
// criteria", keyboard only; owner ruling 2026-11-10): the filter box, then the list. Each row's
// disclosure joins the order after its row with slice 1c.
test('memory filter: from the view, Tab reaches the filter box, then the first memory', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  t.after(() => (b as Browser).close());
  const { page } = await device(b, { width: 1280, height: 900 });
  await page.goto(`${server!.m.base}/memory`);
  await settled(page, 'memory');
  await until(page, () => document.activeElement?.id === 'memory');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'memory-filter', 'the box comes first');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#memory .memory-item:not([data-candidate])')), true, 'then the first memory');
});

test('memory filter: an empty Memory draws its empty state, with no box', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  t.after(() => (b as Browser).close());
  const { page } = await device(b, { width: 1280, height: 900, serviceWorkers: 'block' });
  const stub = { sections: [{ title: 'Facts', entries: [] }], days: [], candidates: [], titles: {} };
  await page.route('**/api/memory', (r: Route) => (r.request().method() === 'GET' ? r.fulfill({ json: stub }) : r.continue()));
  await page.goto(`${server!.m.base}/memory`);
  await page.locator('#memory .memory-empty').waitFor();
  assert.equal(await page.locator('#memory-filter').count(), 0);
  assert.equal(await page.locator('#memory .view-waiting').count(), 0, 'the loading line is gone');
});

for (const width of [390, 320]) {
  test(`memory filter at ${width} px: nothing scrolls sideways, and the box is a full-size target`, async (t) => {
    const b = await browser();
    if (typeof b === 'string') { t.skip(b); return; }
    t.after(() => (b as Browser).close());
    const { page } = await device(b, { width, height: 844, touch: true });
    await page.goto(`${server!.m.base}/memory`);
    await settled(page, 'memory');
    await type(page, 'the');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(await shortTargets(page, '#memory-filter', { min: 44 }), []);
  });
}
