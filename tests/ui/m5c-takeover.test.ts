// M5c, takeover and hand-back mid-task, in a real browser on both sides: Nova's browser worker
// fills the local form site, and at the step the site says a person must do it asks for a
// takeover; the task shows Needs you. The person, in the PWA, opens it from the Needs-you card,
// sees the live picture, takes over, clicks and types through the step on the picture, and hands
// back; the worker finishes and Nova verifies the site's final state itself. A paired phone that
// may not approve can watch but not take over. Also: a takeover the person starts on their own in
// the middle of a step, on a phone-sized screen, during which the worker does nothing. Frames and
// screenshots never land in the service worker's cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sleep, stop } from '../acceptance/support.ts';
import { call, enroll } from '../core/mesh-support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';
import { browserEnv, delegate, events, formPlan, settled, startFormSite, waitTask, type Site } from './m5c-support.ts';

const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });

function shots(): string | null {
  const m3 = shotsDir();
  if (!m3) return null;
  const dir = join(dirname(m3), 'm5');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Where an element of a site page sits, as fractions of a 1280×800 screen: measured in a browser
// of the test's own, the same Chromium at the same size as Nova's, so the person can aim at it in
// the live picture the way they would by eye.
async function spot(b: Browser, url: string, selector: string): Promise<{ x: number; y: number }> {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const p = await ctx.newPage();
    await p.goto(url);
    const box = (await p.locator(selector).boundingBox())!;
    return { x: (box.x + box.width / 2) / 1280, y: (box.y + box.height / 2) / 800 };
  } finally {
    await ctx.close();
  }
}

// A click on the live picture at a spot of the page.
async function clickFrame(page: Page, at: { x: number; y: number }) {
  const img = page.locator('#sheet .takeover-frame');
  const box = (await img.boundingBox())!;
  await page.mouse.click(box.x + at.x * box.width, box.y + at.y * box.height);
}

const frameSeq = (page: Page) => page.evaluate(() => Number((document.querySelector('#sheet .takeover-frame') as HTMLImageElement | null)?.dataset.seq ?? 0));
const cachedPaths = (page: Page) => page.evaluate(async () => {
  const out: string[] = [];
  for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
  return out;
});

test('M5c: the worker asks for a person; they take over in the PWA, do the step, hand back; Nova verifies', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const site: Site = await startFormSite();
  const m = blank('nova-ui-m5c-takeover-');
  const meshPort = await freePort();
  const mesh = `http://127.0.0.1:${meshPort}`;
  const nova = await m.start({ ...browserEnv(), NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  const dir = shots();
  try {
    await finishSetup(m);
    const r = await delegate(m, formPlan(site, { person: true }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id as string;
    const asking = await waitTask(m, id, (x) => x.state === 'waiting' || settled(x));
    assert.equal(asking.state, 'waiting', asking.reason ?? '');
    assert.match(asking.reason!, /^Needs you: Type the code shown in the picture/);

    // A paired phone that may not approve: it can see the browser, not take it over.
    const h = { mesh, nowS: () => Math.floor(Date.now() / 1000), c: (method: string, path: string, body?: unknown) => call(m.base, method, `/api/v1${path}`, body) };
    const { token } = await enroll(h as never, { name: 'Example phone', kind: 'phone' });
    const phone = (method: string, path: string, body?: unknown) => call(mesh, method, `/api/v1${path}`, body, { authorization: `Bearer ${token}` });
    assert.equal((await phone('GET', `/browser/tasks/${id}`)).body.mode, 'needs_person', 'a phone can watch');
    const refused = await phone('POST', `/browser/tasks/${id}/takeover`);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /Only the hub’s own screen, or a device you’ve allowed to approve/);
    assert.equal((await phone('POST', `/browser/tasks/${id}/input`, { type: 'text', text: 'X' })).status, 403);
    assert.equal((await phone('POST', `/browser/tasks/${id}/handback`)).status, 403);

    // The person, at the hub's own screen: the Needs-you card on Home.
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/`);
    await ready(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const row = page.locator(`.needs-you-card .task-row[data-task="${id}"]`);
    await row.waitFor({ timeout: 10_000 });
    assert.match((await row.textContent()) ?? '', /Needs you/);
    if (dir) await shoot(page, join(dir, 'takeover-needs-you-card.png'));
    await row.locator('[data-action="open-task"]').click();

    const sheet = page.locator('#sheet .takeover');
    await sheet.waitFor();
    await page.waitForFunction(() => !(document.querySelector('#sheet .takeover-frame') as HTMLImageElement).hidden, null, { timeout: 15_000 });
    assert.match((await sheet.locator('.takeover-status').textContent()) ?? '', /Needs you/);
    assert.match((await sheet.locator('.takeover-line').textContent()) ?? '', /Needs you: Type the code shown in the picture/);
    assert.equal(await sheet.locator('.btn.primary').count(), 1, 'one standout action');
    assert.equal(await sheet.locator('.btn.primary').textContent(), 'Take over');
    if (dir) await shoot(page, join(dir, 'takeover-requested.png'));

    await sheet.locator('[data-action="take-over"]').click();
    await page.waitForFunction(() => /You have control/.test(document.querySelector('#sheet .takeover-line')?.textContent ?? ''));
    assert.equal(await sheet.locator('.btn.primary').textContent(), 'Hand back');
    assert.equal(await sheet.locator('.takeover-screen').getAttribute('data-held'), 'true');

    // The step itself, through the picture: click the field, type the code, click Confirm.
    const draft = site.drafts().find((d: { checked: boolean }) => !d.checked)!;
    const checkUrl = `${site.url}/form/${draft.id}/check`;
    const field = await spot(b, checkUrl, '#code');
    const confirm = await spot(b, checkUrl, '#confirm');
    await clickFrame(page, field);
    await page.locator('#sheet .takeover-frame').focus();
    await page.keyboard.type(draft.code, { delay: 30 });
    const before = await frameSeq(page);
    await clickFrame(page, confirm);
    for (let i = 0; i < 100 && !site.drafts().find((d: { id: string; checked: boolean }) => d.id === draft.id)?.checked; i++) await sleep(100);
    assert.equal(site.drafts().find((d: { id: string }) => d.id === draft.id)?.checked, true, 'the site took the code the person typed');
    await page.waitForFunction((n) => Number((document.querySelector('#sheet .takeover-frame') as HTMLImageElement).dataset.seq) > n, before, { timeout: 10_000 });
    if (dir) await shoot(page, join(dir, 'takeover-held.png'));
    // While the person holds it, the worker does nothing.
    const held = (await events(m, id)).filter((e) => e.kind === 'step').length;
    await sleep(1000);
    assert.equal((await events(m, id)).filter((e) => e.kind === 'step').length, held, 'no step while the person has the browser');

    await sheet.locator('[data-action="hand-back"]').click();
    const done = await waitTask(m, id, settled);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(done.verification!.ok, true);
    assert.match(done.report.summary, /you did one of them/);
    // Checked independently of Nova: the site's own record.
    assert.equal(site.records.length, 1);
    assert.equal(site.records[0].person_checked, true);
    assert.equal(site.records[0].name, 'Ada Example');

    const ev = await events(m, id);
    const kinds = ev.map((e) => e.kind);
    const started = ev.find((e) => e.kind === 'takeover_started')!;
    const ended = ev.find((e) => e.kind === 'takeover_ended')!;
    assert.ok(started && ended, `both takeover events are in the ledger: ${kinds.join(', ')}`);
    assert.equal(started.detail.by, 'console');
    assert.equal(started.detail.requested, true);
    assert.equal(ended.detail.by, 'console');
    assert.ok(ended.detail.duration_ms > 0);
    assert.ok(kinds.indexOf('needs_person') < kinds.indexOf('takeover_started') && kinds.indexOf('takeover_ended') < kinds.indexOf('person_done'));

    // The sheet follows the task to its evidence, with the screenshot.
    await page.locator('#sheet .evidence').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => /Verified/.test(document.querySelector('#sheet .evidence .sheet-kicker')?.textContent ?? ''), null, { timeout: 15_000 });
    await page.locator('#sheet .evidence-shot').waitFor();
    await page.waitForFunction(() => (document.querySelector('#sheet .evidence-shot') as HTMLImageElement).naturalWidth > 0);
    if (dir) await shoot(page, join(dir, 'takeover-verified.png'));
    await page.locator('#sheet details.raw summary', { hasText: 'What happened' }).click();
    assert.match((await page.locator('#sheet .timeline').textContent()) ?? '', /takeover started · The hub’s own screen, as Nova asked[\s\S]*takeover ended · The hub’s own screen, after \d+ s/);

    // Nothing of the browser was kept by the service worker: no frame, no screenshot.
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'the service worker controls the page');
    const cached = await cachedPaths(page);
    assert.ok(cached.length > 0, 'the shell is cached');
    assert.deepEqual(cached.filter((p) => p.startsWith('/api/v1/browser')), [], `nothing of the browser is cached: ${cached.join(', ')}`);
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
    await site.close();
  }
});

test('M5c: a takeover in the middle of a step, on a phone: the worker waits, then carries on from the page as left', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const site: Site = await startFormSite();
  const m = blank('nova-ui-m5c-voluntary-');
  const nova = await m.start(browserEnv());
  const dir = shots();
  try {
    await finishSetup(m);
    // The site takes 6 s to answer the first page, so the person can step in while it loads.
    const r = await delegate(m, formPlan(site, { person: false, delay: 6000 }), 'Sign up, slowly');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id as string;
    for (let i = 0; i < 100; i++) {
      const v = await m.get(`/api/v1/browser/tasks/${id}`);
      if (v.live && v.step?.n === 1) break;
      await sleep(50);
    }

    const { page, errors } = await device(b, { width: 390, height: 844 });
    await page.goto(`${m.base}/tasks`);
    await ready(page);
    assert.equal(await page.evaluate(() => document.body.dataset.layout), 'phone');
    const row = page.locator(`#tasks-view .task-row[data-task="${id}"]`);
    await row.waitFor({ timeout: 10_000 });
    await row.locator('[data-action="open-task"]').click();
    const sheet = page.locator('#sheet .takeover');
    await sheet.waitFor();
    assert.match((await sheet.locator('.takeover-line').textContent()) ?? '', /Nova is working\. Step 1 of 9/);
    assert.equal(await sheet.locator('.btn.primary').textContent(), 'Take over');
    await sheet.locator('[data-action="take-over"]').click();
    await page.waitForFunction(() => /You have control/.test(document.querySelector('#sheet .takeover-line')?.textContent ?? ''));
    const takenAt = (await events(m, id)).filter((e) => e.kind === 'step').length;
    assert.equal(takenAt, 1, 'taken over during the first step, while its page loads');

    // The page arrives while the person holds the browser; the worker still does nothing.
    for (let i = 0; i < 100 && !(await m.get(`/api/v1/browser/tasks/${id}`)).url.includes('/details'); i++) await sleep(100);
    await page.waitForFunction(() => !(document.querySelector('#sheet .takeover-frame') as HTMLImageElement).hidden, null, { timeout: 15_000 });
    await sleep(1500);
    assert.equal((await events(m, id)).filter((e) => e.kind === 'step').length, 1, 'no further step while the person has it');
    // The person ticks a box the plan never mentions, by tapping it on the picture.
    const draft = site.drafts()[0]!;
    const box = await spot(b, `${site.url}/form/${draft.id}/details`, '#newsletter');
    const seq = await frameSeq(page);
    await clickFrame(page, box);
    await page.waitForFunction((n) => Number((document.querySelector('#sheet .takeover-frame') as HTMLImageElement).dataset.seq) > n, seq, { timeout: 10_000 });
    if (dir) await shoot(page, join(dir, 'takeover-phone-held.png'));
    await sheet.locator('[data-action="hand-back"]').click();

    const done = await waitTask(m, id, settled);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(done.verification!.ok, true);
    assert.equal(site.records.length, 1);
    assert.equal(site.records[0].newsletter, true, 'what the person did stayed: the worker carried on from the page as they left it');
    assert.equal(site.records[0].name, 'Ada Example', 'and the worker did the rest');
    const kinds = (await events(m, id)).map((e) => e.kind);
    const firstStep = kinds.indexOf('step');
    const secondStep = kinds.indexOf('step', firstStep + 1);
    assert.ok(firstStep < kinds.indexOf('takeover_started') && kinds.indexOf('takeover_ended') < secondStep, `the takeover sits inside the first step: ${kinds.join(', ')}`);
    const started = (await events(m, id)).find((e) => e.kind === 'takeover_started')!;
    assert.equal(started.detail.requested, false, 'the person stepped in on their own');
    assert.equal(kinds.includes('needs_person'), false);
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
    await site.close();
  }
});
