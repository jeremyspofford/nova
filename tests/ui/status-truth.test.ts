// What the page says about Nova's state is true, and says it the same way everywhere.
//   F-022 (ruling D5): the status mark, the Health badge, Home's first line and health card, and
//         Health agree: (a) a failed scheduled task is amber "needs you"; (b) Nova stopped is red.
//   F-075: stopped and needs-you differ without colour, on the mark and the badge, motion reduced.
//   F-021: a problems list that couldn't be read is never "No problems are open"; Try again reads it.
//   F-023: a failed health reading says so with a retry; a slow list never flashes its empty words;
//          an older pane shows a waiting line at once.
//   F-024: a conversation that doesn't exist isn't an outage; an unknown address is a page with Home.
// The real server underneath; only the reads named are answered or held in the browser. No model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../../src/core/browser/png.ts';
import { stop } from '../acceptance/support.ts';
import { addStyle, blank, browser, device, finishSetup, ready } from './support.ts';

const at = new Date(Date.now() - 60_000).toISOString();
const FAILED_TASK = { id: 9101, at, source: 'ledger', message: 'A task failed: Nightly backup. The backup folder isn’t there.', detail: null, task_id: null, stops: 0, resolved_at: null };
const STOPPED = { id: 9102, at, source: 'resilience', message: 'Nova is held in safe mode.', detail: null, task_id: null, stops: 1, resolved_at: null };
// Service workers blocked: a read the page routes here must not go round by the worker instead.
const WIDE = { width: 1280, height: 900, serviceWorkers: 'block' as const };

const withProblems = (ctx: BrowserContext, list: unknown[]) => ctx.route('**/api/v1/problems', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));
const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();

// Every surface's say, from one page load of Home and one of Health.
async function surfaces(page: Page, base: string) {
  await page.goto(`${base}/`);
  await ready(page);
  await page.locator('.health-card:visible .card-lead').first().waitFor();
  await page.locator('#rail [data-dest="health"] .nav-badge').waitFor();
  const mark = await page.locator('#rail .rail-home .status-icon').getAttribute('data-state');
  const rail = await page.locator('#rail .rail-home').getAttribute('aria-label');
  const badge = page.locator('#rail [data-dest="health"]');
  const out = {
    mark, rail,
    badgeTone: await badge.locator('.nav-badge').getAttribute('data-tone'),
    badgeLabel: await badge.getAttribute('aria-label'),
    summary: await text(page, '[data-summary]'),
    card: await page.locator('.health-card:visible .card-lead').first().getAttribute('data-status'),
    cardText: await text(page, '.health-card:visible'),
    lede: '', row: '',
  };
  await page.goto(`${base}/health`);
  await ready(page);
  await page.locator('#health-view .problem-row').first().waitFor({ state: 'attached' });
  out.lede = await text(page, '#health-view .view-lede');
  out.row = await text(page, '#health-view .problem-row .settings-note');
  return out;
}

test('F-022, D5: the mark, the badge, Home and Health agree for a failed scheduled task (amber) and for Nova stopped (red)', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-status-truth-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    // (a) A failed scheduled task: needs you, Nova running.
    const a = await device(b, WIDE);
    await withProblems(a.ctx, [FAILED_TASK]);
    const amber = await surfaces(a.page, m.base);
    assert.equal(amber.mark, 'needs-you', JSON.stringify(amber));
    assert.equal(amber.rail, 'Home. Something needs you');
    assert.equal(amber.badgeTone, 'attention');
    assert.equal(amber.badgeLabel, 'Health, 1 problem, it needs you');
    assert.match(amber.summary, /One thing needs you; see Health\.$/);
    assert.doesNotMatch(amber.summary, /stopped|went wrong/i);
    assert.equal(amber.card, 'needs-you');
    assert.match(amber.cardText, /Nothing has stopped Nova/);
    assert.match(amber.lede, /^Nova is running, and something needs you/);
    assert.match(amber.row, /^Needs you/);
    assert.deepEqual(a.errors, []);
    await a.ctx.close();

    // (b) Nova stopped: red everywhere, said as stopped.
    const s = await device(b, WIDE);
    await withProblems(s.ctx, [STOPPED, FAILED_TASK]);
    const red = await surfaces(s.page, m.base);
    assert.equal(red.mark, 'stopped', JSON.stringify(red));
    assert.equal(red.rail, 'Home. Nova is stopped; see Health');
    assert.equal(red.badgeTone, 'alert');
    assert.equal(red.badgeLabel, 'Health, 2 problems, Nova is stopped');
    assert.match(red.summary, /Nova is stopped, and one thing needs you; it’s in Health\.$/);
    assert.equal(red.card, 'failed');
    assert.match(red.cardText, /Nova is stopped/);
    assert.match(red.lede, /^Nova is stopped/);
    assert.match(red.row, /^Failed/);
    // Home's first line links to Health.
    await s.page.goto(`${m.base}/`);
    await ready(s.page);
    await s.page.locator('[data-summary] a[href="/health"]').waitFor({ state: 'attached' });
    assert.equal(await s.page.locator('[data-summary] a[href="/health"]').count(), 1);
    assert.deepEqual(s.errors, []);
    await s.ctx.close();
  } finally {
    await stop(nova);
    await b.close();
  }
});

// The mark's corner and the badge, as greys: how far apart two states are, per pixel (0–255).
async function grey(page: Page): Promise<{ mark: number[]; badge: number[] }> {
  await addStyle(page, 'html { filter: grayscale(1) !important; }');
  await page.waitForTimeout(200);
  const img = decodePng(await page.screenshot());
  const scale = img.width / page.viewportSize()!.width;
  // The badge: the Health row's top-right corner, where the dot (or the octagon) sits, the same
  // region on both pages.
  const corner = async (sel: string) => { const r = (await page.locator(sel).first().boundingBox())!; return { x: r.x + r.width - 28, y: r.y, width: 28, height: 28 }; };
  const box = async (sel: string, region?: { x: number; y: number; width: number; height: number }) => {
    const r = region ?? (await page.locator(sel).first().boundingBox())!;
    const out: number[] = [];
    for (let y = Math.floor(r.y * scale); y < Math.ceil((r.y + r.height) * scale); y++) {
      for (let x = Math.floor(r.x * scale); x < Math.ceil((r.x + r.width) * scale); x++) {
        const i = (y * img.width + x) * img.channels;
        out.push((img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3);
      }
    }
    return out;
  };
  return { mark: await box('#rail .rail-home .status-icon'), badge: await box('', await corner('#rail [data-dest="health"]')) };
}
const apart = (a: number[], b: number[]) => a.reduce((s, v, k) => s + Math.abs(v - (b[k] ?? v)), 0) / a.length;
// What "different" means here: a mean grey difference over the whole mark (or the whole Health
// row) of at least this much. Hue alone, greyed, comes out near nothing; a shape of its own doesn't.
const MIN_APART = 3;

test('F-075: stopped and needs-you differ without colour on the mark and the Health badge, with motion reduced', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-status-cue-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const look = async (problems: unknown[]) => {
      const d = await device(b, WIDE);
      await d.page.emulateMedia({ reducedMotion: 'reduce' });
      await withProblems(d.ctx, problems);
      await d.page.goto(`${m.base}/settings`);
      await ready(d.page);
      await d.page.locator('#rail [data-dest="health"] .nav-badge').waitFor();
      await d.page.waitForTimeout(400);
      const g = await grey(d.page);
      await d.ctx.close();
      return g;
    };
    const needs = await look([FAILED_TASK]);
    const stopped = await look([STOPPED]);
    const mark = apart(needs.mark, stopped.mark);
    const badge = apart(needs.badge, stopped.badge);
    assert.ok(mark >= MIN_APART, `the mark without colour: ${mark.toFixed(2)} apart, want ≥ ${MIN_APART}`);
    assert.ok(badge >= MIN_APART, `the Health badge without colour: ${badge.toFixed(2)} apart, want ≥ ${MIN_APART}`);
  } finally {
    await stop(nova);
    await b.close();
  }
});

test('F-021, F-023: an unread list is never empty, says so with Try again, and a slow one never flashes its empty words', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-unread-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    // The problems read answers 500 on the first load.
    const d = await device(b, WIDE);
    let failing = true;
    await d.ctx.route('**/api/v1/problems', (r) => (failing ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAILED_TASK]) })));
    await d.page.goto(`${m.base}/`);
    await ready(d.page);
    await d.page.locator('.health-card:visible .card-lead').first().waitFor();
    const summary = await text(d.page, '[data-summary]');
    assert.doesNotMatch(summary, /Nothing needs you/);
    assert.match(summary, /couldn’t load its problems/);
    assert.doesNotMatch(await text(d.page, '.health-card:visible'), /All systems normal/);
    assert.equal(await d.page.locator('#rail [data-dest="health"] .nav-badge').getAttribute('data-tone'), 'unknown');
    assert.notEqual(await d.page.locator('#rail .rail-home').getAttribute('aria-label'), 'Home. Nova is quiet');
    await d.page.goto(`${m.base}/health`);
    await ready(d.page);
    const unread = d.page.locator('#health-view [data-unloaded="problems"]');
    await unread.waitFor({ state: 'attached' });
    assert.equal(await d.page.getByText('No problems are open.').count(), 0);
    // Try again reads that part alone, and draws the real list without a reload.
    failing = false;
    const reads: string[] = [];
    d.page.on('request', (r) => { if (r.url().includes('/api/v1/')) reads.push(new URL(r.url()).pathname); });
    await unread.getByRole('button', { name: 'Try again' }).click();
    await d.page.locator('#health-view .problem-row').first().waitFor({ state: 'attached' });
    assert.deepEqual(reads, ['/api/v1/problems']);

    // Tasks and rules that couldn't be read aren't "No tasks yet" or "No rules yet".
    const e = await device(b, WIDE);
    await e.ctx.route('**/api/v1/tasks?limit=100', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    await e.ctx.route('**/api/v1/triggers/rules', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    await e.page.goto(`${m.base}/tasks`);
    await ready(e.page);
    await e.page.locator('#tasks-view [data-unloaded="tasks"]').waitFor();
    assert.equal(await e.page.getByText('No tasks yet', { exact: false }).count(), 0);
    await e.page.goto(`${m.base}/automations`);
    await ready(e.page);
    await e.page.locator('#rules [data-unloaded="rules"]').waitFor();
    assert.equal(await e.page.getByText('No rules yet', { exact: false }).count(), 0);

    // The health reading fails: said with a retry within the read's limit, never an open-ended wait.
    const h = await device(b, WIDE);
    await h.ctx.route('**/api/v1/health', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    await h.page.goto(`${m.base}/health`);
    await ready(h.page);
    await h.page.locator('#health-view [data-unloaded="health"]').waitFor({ state: 'attached', timeout: 20_000 });
    assert.equal(await h.page.getByText('Checking Nova’s health', { exact: false }).count(), 0);
    assert.match(await text(h.page, '#health-view .diagnostics-download'), /until Nova’s health reading is in/);

    // Every read 1.5 s late: Health never shows "No problems are open" while it has a problem.
    const slow = await device(b, WIDE);
    await slow.ctx.route('**/api/v1/**', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
    await withProblems(slow.ctx, [FAILED_TASK]);
    await slow.ctx.route('**/api/v1/problems', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAILED_TASK]) }); });
    await slow.page.goto(`${m.base}/health`);
    let flashed = false;
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (await slow.page.getByText('No problems are open.').count()) flashed = true;
      if (await slow.page.locator('#health-view .problem-row').count()) break;
      await slow.page.waitForTimeout(50);
    }
    assert.equal(flashed, false, 'the empty words never showed while the list was on its way');
    await slow.page.locator('#health-view .problem-row').first().waitFor({ state: 'attached' });

    // An older pane, its read unanswered: a waiting line at once, not a blank pane.
    const old = await device(b, WIDE);
    await old.ctx.route('**/api/skills', () => { /* never answered */ });
    await old.page.goto(`${m.base}/skills`);
    await ready(old.page);
    await old.page.locator('#skills .waiting').waitFor({ timeout: 3000 });
  } finally {
    await stop(nova);
    await b.close();
  }
});

test('F-024: a conversation that doesn’t exist isn’t an outage; an unknown address is a page with a way Home', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-wrong-surface-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const d = await device(b, WIDE);
    await d.page.goto(`${m.base}/c/2026-01-01-nosuch`);
    await ready(d.page);
    await d.page.locator('[data-missing="gone"]').waitFor();
    assert.match(await text(d.page, '[data-missing="gone"]'), /This conversation doesn’t exist\..*Open the main conversation/);
    assert.equal(await d.page.locator('#banner:visible', { hasText: 'isn’t answering' }).count(), 0, 'no outage banner');
    assert.equal(await d.page.title().then((x) => /Untitled/.test(x)), false);

    const p = await device(b, WIDE);
    const res = await p.page.goto(`${m.base}/no-such-page`);
    assert.equal(res?.status(), 404);
    assert.equal(await p.page.locator('h1').count(), 1);
    assert.equal(await p.page.locator('a[href="/"]').count(), 1);
    // The browser itself logs the 404 status of the page it was asked for; that line is the status
    // this test asks for. Nothing else may be logged: no script error, no refused or missing file.
    assert.deepEqual(p.errors.filter((e) => !/^Failed to load resource: the server responded with a status of 404/.test(e) || p.errors.length > 1), [], 'no other console errors on the not-found page');
    assert.ok(p.errors.length <= 1);
  } finally {
    await stop(nova);
    await b.close();
  }
});
