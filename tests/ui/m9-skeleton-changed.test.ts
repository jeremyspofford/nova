// Review of #234, item 6: a skeleton is the view's own last layout on this device. What happens when
// that can't be the final shape?
//   · another conversation: its shape was never kept here, so there is no skeleton (a waiting line
//     only), never another conversation's shape;
//   · Tasks after new tasks arrived while away: the kept shape is the last visit's. What hasn't
//     changed lands exactly where it stood; what has, grows below it, and nothing moves (no layout
//     shift); the new shape is kept for next time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { stop, until } from '../acceptance/support.ts';
import { browser, device, still } from './support.ts';
import { CHAT, CHAT2, DESKTOP, seeded, settled } from './m9-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CORE = /\/api\/v1\/(tasks|problems|health|profile|identity|memory|triggers|messages|workers|mesh|resilience)/;
type Box = [number, number, number, number];

function shifts() {
  (window as any).__shifts = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) (window as any).__shifts.push({ at: e.startTime, value: e.value, input: e.hadRecentInput }); }).observe({ type: 'layout-shift', buffered: true });
}
const shiftSince = (page: Page, t0: number) => page.evaluate((t) => (window as any).__shifts.filter((s: any) => s.at >= t && !s.input).reduce((n: number, s: any) => n + s.value, 0), t0);

// Each request waits inside its own handler until released, then goes on to the server.
async function holding(page: Page, pattern: RegExp) {
  let go: () => void = () => {};
  const released = new Promise<void>((r) => { go = r; });
  await page.route(pattern, async (r) => { if (r.request().method() === 'GET') await released; await r.fallback(); });
  return async () => { go(); await sleep(50); await page.unroute(pattern); };
}

test('M9 gate, skeletons: never another conversation’s shape; after new tasks, what stayed lands exactly and nothing moves', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m9-skel2-');
  try {
    const d = await device(b, { ...DESKTOP, serviceWorkers: 'block' });
    await d.ctx.addInitScript(shifts);

    // One conversation, opened here; then another, whose shape was never kept, with its data slow.
    await d.page.goto(`${m.base}/c/${CHAT}`);
    await settled(d.page, 'chat');
    await still(d.page);
    await d.page.waitForFunction((c) => Object.keys(JSON.parse(localStorage.getItem('nova.shape') ?? '{}')).some((k) => k.startsWith(`chat:${c}|`)), CHAT);
    let release = await holding(d.page, new RegExp(`/api/sessions/${CHAT2}/events`));
    await d.page.goto(`${m.base}/c/${CHAT2}`);
    await d.page.waitForSelector('html[data-ready]');
    await sleep(1500);
    assert.equal(await d.page.locator('#thread [data-skeleton]').count(), 0, 'no skeleton borrowed from another conversation');
    assert.equal(await d.page.$eval('#thread .view-waiting .waiting', (e) => Number(getComputedStyle(e).opacity)), 1, 'a waiting line instead');
    let t0 = await d.page.evaluate(() => performance.now());
    await release();
    await d.page.waitForFunction(() => document.querySelector('#thread .turn'), null, { timeout: 10000 }).catch(async () => { throw new Error(`the conversation never came: ${(await d.page.locator('#thread').innerHTML()).slice(0, 300)} / ${await d.page.evaluate(() => [location.pathname, document.body.dataset.view].join(' '))}`); });
    await still(d.page);
    assert.equal(await shiftSince(d.page, t0), 0, 'the conversation arrives without moving anything');

    // Tasks, kept here; then three new tasks arrive while the page is away.
    await d.page.goto(`${m.base}/tasks`);
    await settled(d.page, 'tasks');
    await still(d.page);
    await d.page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('nova.shape') ?? '{}')).some((k) => k.startsWith('tasks|')));
    const ids: string[] = [];
    for (const name of ['garden', 'tools', 'recipes']) {
      const r = await m.send('POST', '/api/v1/tasks', { title: `Save the ${name} list`, owner: 'workspace', goal: `The ${name} list is saved.`, evidence_required: [{ kind: 'read_back', target: `workspace:lists/${name}.md` }], inputs: { action: 'write', path: `lists/${name}.md`, content: '- one\n' } });
      ids.push(r.body.id);
    }
    for (const id of ids) await until(() => m.get(`/api/v1/tasks/${id}`), (x: any) => x.state === 'done');
    release = await holding(d.page, CORE);
    await d.page.reload();
    await d.page.waitForSelector('#tasks-view [data-skeleton]', { state: 'attached' });
    await sleep(1500);
    const skel: Box[] = await d.page.$$eval('#tasks-view .skel-block', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] as Box; }));
    t0 = await d.page.evaluate(() => performance.now());
    await release();
    await settled(d.page, 'tasks');
    await still(d.page);
    const final: Box[] = await d.page.$$eval('#tasks-view > *', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] as Box; }));
    // The view's heading is unchanged: exact. The list grew by three tasks: it starts where it stood.
    skel[0]!.forEach((v, k) => assert.ok(Math.abs(v - final[0]![k]!) <= 0.5, `the heading lands where its skeleton stood (${skel[0]} vs ${final[0]})`));
    assert.ok(Math.abs(skel[1]![1] - final[1]![1]) <= 0.5 && Math.abs(skel[1]![0] - final[1]![0]) <= 0.5, 'the list starts where its skeleton did');
    assert.ok(final[1]![3] > skel[1]![3], `and is taller now: ${Math.round(skel[1]![3])} → ${Math.round(final[1]![3])} px`);
    assert.equal(await shiftSince(d.page, t0), 0, 'nothing moved: the new rows grew below');
    // The new shape is kept for next time.
    await d.page.waitForFunction((h) => Object.entries(JSON.parse(localStorage.getItem('nova.shape') ?? '{}')).some(([k, v]: [string, any]) => k.startsWith('tasks|') && Math.abs(v.blocks[1].h - h) < 1), final[1]![3]);
    assert.deepEqual(d.errors, [], 'no errors in the page');
    console.log(`skeletons when the shape changed:\nanother conversation: none borrowed, shift 0\ntasks with 3 new: heading exact; list ${Math.round(skel[1]![3])} → ${Math.round(final[1]![3])} px, starting where it stood; shift 0`);
  } finally {
    await b.close();
    await stop(nova);
  }
});
