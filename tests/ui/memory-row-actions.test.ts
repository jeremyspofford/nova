// A Memory row's actions (Confirm, Edit, Forget; Keep and Drop on a held item) never cover its words:
// on hover and on keyboard focus, every action's box is clear of the memory's text and its source
// line, for long and short rows, at a desktop (1280 and a half-screen 820), a phone (390, touch) and
// the fold postures (Duo cover 380, inner 820, touch), and a narrow desktop window (500). Seen on the
// served page after F-038: Confirm was drawn over the end of a long fact. Also the owner's calls of
// 2026-11-10: Confirm at rest on rows awaiting review, and Keep and Drop at rest on a held item;
// nothing at rest on reviewed rows; 44 px targets; and the actions stacked under the words below
// 600 px wide. Chromium.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { Browser, Page, Route } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { seeded, settled } from './m9-support.ts';

let server: Awaited<ReturnType<typeof seeded>> | null = null;
before(async () => { server = await seeded('nova-rowactions-'); });
after(async () => { if (server) { await stop(server.nova); rmSync(server.m.dir, { recursive: true, force: true }); } });

const LONG = 'Name is Jeremy Spofford. Works as a cloud and DevOps engineer, studies for the AWS Solutions Architect exam in the evenings, and lives in the eastern United States. Timezone America/New_York.';
const row = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, time: null, from: null, at: '2026-11-09T10:00:00Z', updated: null, by: 'nova', state: 'unreviewed', device: null, root: id, ...extra });
const stub = {
  sections: [{ title: 'Facts', entries: [
    row('b0000001-0000-4000-8000-000000000001', LONG),
    row('b0000001-0000-4000-8000-000000000002', 'Short one.', { state: 'confirmed' }),
    row('b0000001-0000-4000-8000-000000000003', 'Timezone America/New_York.', { from: 'device:phone-1' }),
  ] }],
  days: [], titles: {}, devices: { 'phone-1': 'Kitchen phone' }, captured: {},
  candidates: [{ id: 'c1', op: 'remember', content: `${LONG} Held for your OK.`, taint: [{ origin: 'a web page', verdict: 'pass' }] }],
};

// Every visible action box that meets the row's text or source line, in one row.
const overlaps = (page: Page, sel: string) => page.$eval(sel, (li) => {
  const r = (e: Element) => e.getBoundingClientRect();
  const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const words = [...li.querySelectorAll('.memory-text, .memory-source')].map((e) => ({ what: e.className, box: r(e) }));
  const out: string[] = [];
  for (const b of li.querySelectorAll<HTMLElement>('.memory-actions button')) {
    if (!b.checkVisibility()) continue;
    for (const w of words) if (meet(r(b), w.box)) out.push(`${b.textContent} over ${w.what}`);
  }
  return out;
});

const SIZES = [
  { name: 'desktop 1280', width: 1280, height: 820, touch: false },
  { name: 'half-screen 820', width: 820, height: 900, touch: false },
  { name: 'phone 390', width: 390, height: 844, touch: true },
  { name: 'Duo cover 380', width: 380, height: 900, touch: true },
  { name: 'Duo inner 820', width: 820, height: 900, touch: true },
  { name: 'narrow window 500', width: 500, height: 900, touch: false },
];
// Below this width the actions stack under the words (ui/styles/views.css, owner's call 2026-11-10).
const STACK_BELOW = 600;

// At rest (no hover, no focus in the row): which actions can be seen, per row.
const shownAtRest = (page: Page, sel: string) => page.$eval(sel, (li) => [...li.querySelectorAll<HTMLElement>('.memory-actions button')]
  .filter((b) => b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && Number(getComputedStyle(b).opacity) > 0)
  .map((b) => b.dataset.action ?? ''));
// Where the actions sit against the words, and how wide the text is against the row's content box.
const placement = (page: Page, sel: string) => page.$eval(sel, (li) => {
  const r = (q: string) => li.querySelector(q)!.getBoundingClientRect();
  const cs = getComputedStyle(li);
  const inner = li.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { actionsTop: r('.memory-actions').top, wordsBottom: Math.max(r('.memory-text').bottom, r('.memory-source').bottom), text: r('.memory-text').width, inner };
});

for (const size of SIZES) {
  test(`memory row actions at ${size.name}: clear of the words on hover and on focus`, async (t) => {
    const b = await browser();
    if (typeof b === 'string') { t.skip(b); return; }
    t.after(() => (b as Browser).close());
    const { page, errors } = await device(b, { width: size.width, height: size.height, touch: size.touch, serviceWorkers: 'block' });
    await page.route('**/api/memory', (r: Route) => (r.request().method() === 'GET' ? r.fulfill({ json: stub }) : r.continue()));
    await page.goto(`${server!.m.base}/memory`);
    await settled(page, 'memory');
    // At rest. Owner's call 2026-11-10: Confirm shows on a row awaiting review, on every pointer; a
    // reviewed row shows no action (on touch, Edit and Forget are always shown, as before).
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const unchecked = ['#m-b0000001-0000-4000-8000-000000000001', '#m-b0000001-0000-4000-8000-000000000003'];
    // A held item waits for the person's decision too: Keep and Drop at rest, on every pointer.
    assert.deepEqual(await shownAtRest(page, '[data-candidate="c1"]'), ['keep-candidate', 'drop-candidate'], `${size.name}: Keep and Drop shown at rest on a held item`);
    for (const action of ['keep-candidate', 'drop-candidate']) {
      const box = await page.locator(`[data-candidate="c1"] [data-action="${action}"]`).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${size.name}: ${action} is at least 44 px (${box?.width}×${box?.height})`);
    }
    for (const sel of unchecked) assert.ok((await shownAtRest(page, sel)).includes('confirm-memory'), `${size.name}: Confirm shown at rest on ${sel}`);
    assert.deepEqual(await shownAtRest(page, '#m-b0000001-0000-4000-8000-000000000002'), size.touch ? ['edit-memory', 'forget-memory'] : [], `${size.name}: a reviewed row at rest`);
    if (!size.touch) for (const sel of unchecked) assert.deepEqual(await shownAtRest(page, sel), ['confirm-memory'], `${size.name}: only Confirm at rest on ${sel}`);
    const confirmBox = await page.locator('#m-b0000001-0000-4000-8000-000000000001 [data-action="confirm-memory"]').boundingBox();
    assert.ok(confirmBox && confirmBox.width >= 44 && confirmBox.height >= 44, `${size.name}: Confirm is at least 44 px (${confirmBox?.width}×${confirmBox?.height})`);
    // Stacked below the words when narrow, the text keeping the row's width; beside them when wide.
    for (const sel of [...unchecked, '[data-candidate="c1"]']) {
      const p = await placement(page, sel);
      if (size.width < STACK_BELOW) {
        assert.ok(p.actionsTop >= p.wordsBottom - 0.5, `${size.name}: actions below the words on ${sel}`);
        assert.ok(p.text >= p.inner - 1, `${size.name}: the text keeps the row's width (${p.text} of ${p.inner})`);
      } else assert.ok(p.actionsTop < p.wordsBottom, `${size.name}: actions beside the words on ${sel}`);
    }

    const rows = ['#m-b0000001-0000-4000-8000-000000000001', '#m-b0000001-0000-4000-8000-000000000002', '#m-b0000001-0000-4000-8000-000000000003', '[data-candidate="c1"]'];
    for (const sel of rows) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.hover(`${sel} .memory-text`);
      assert.deepEqual(await overlaps(page, sel), [], `${size.name}, hover, ${sel}`);
      await page.mouse.move(0, 0);
      if (!sel.startsWith('[data-candidate')) {
        await page.focus(sel);
        assert.deepEqual(await overlaps(page, sel), [], `${size.name}, focus, ${sel}`);
      }
      await page.focus(`${sel} .memory-actions button`);
      assert.deepEqual(await overlaps(page, sel), [], `${size.name}, a button focused, ${sel}`);
    }
    // Nothing scrolls sideways.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
  });
}
