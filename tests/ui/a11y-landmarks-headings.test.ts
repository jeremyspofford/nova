// W-11 (UI walker, 2026-11-11): axe's landmark-unique and heading-order rules hold on every app
// page, at a desktop's and a phone's width, in Chromium and WebKit. The advisory sweep
// (axe-advisory.ts) reports every rule but never fails; this holds these two. The profile is the
// advisory's (reviewProfile) with what the walker's had and the review's didn't: a daily report
// delivered to the main conversation on three days (three handoffs with one schedule's name).
// Beyond the pages: Settings' "Backups and changes" category (two sections both headed Backups),
// and the topology map's three screens (overview, a machine, a service) on the M10i fixture.
// Visible wording is unchanged by the fix (owner's call): only landmark names and heading levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { APP_PAGES } from '../../src/server.js';
import { browser, device, ready, webkitBrowser } from './support.ts';
import { reviewProfile } from './axe-support.ts';
import { topologyFixture } from './m10i-support.ts';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const RULES = ['landmark-unique', 'heading-order'];
const SIZES = [['desktop', { width: 1280, height: 820 }], ['phone', { width: 390, height: 844, touch: true }]] as const;

// Every node in violation of the two rules, with what it duplicates.
async function violations(page: Page, where: string): Promise<string[]> {
  await page.evaluate(AXE);
  const found: string[] = await page.evaluate(async (rules) => {
    const r = await (window as any).axe.run(document, { runOnly: { type: 'rule', values: rules } });
    return r.violations.flatMap((v: any) => v.nodes.map((n: any) => {
      const related = [...n.any, ...n.all, ...n.none].flatMap((c: any) => c.relatedNodes ?? []).map((x: any) => x.html.slice(0, 100));
      return `${v.id} ${n.html.slice(0, 120)}${related.length ? ` (same as ${related.join(' and ')})` : ''}`;
    }));
  }, RULES);
  return found.map((f) => `${where}: ${f}`);
}

const DAYS = ['2026-10-28', '2026-10-29', '2026-10-30'];

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`W-11: ${engine}, landmark-unique and heading-order on every app page, Settings' backups and the topology screens`, { timeout: 600_000 }, async (t) => {
    const b = await launch();
    if (typeof b === 'string') return t.skip(b);
    const found: string[] = [];
    const { m, nova } = await reviewProfile('nova-w11-');
    appendFileSync(join(m.home, 'sessions', 'main.jsonl'), DAYS.map((day) => JSON.stringify({ ts: `${day}T07:00:00.000Z`, type: 'handoff', id: `digest-${day}`, name: 'Morning digest', schedule: 'morning-digest', text: 'One thing matters today.', ok: true })).join('\n') + '\n');
    try {
      for (const [size, vp] of SIZES) {
        const d = await device(b, { ...vp, serviceWorkers: 'block' });
        for (const path of APP_PAGES) {
          await d.page.goto(m.base + path);
          await ready(d.page);
          // Drawn: no view still waiting for its data (the axe advisory's 900 ms, and then some).
          await d.page.waitForFunction(() => !document.querySelector('main .waiting:not(.is-late), main [data-skeleton]'), null, { timeout: 15_000 }).catch(() => {});
          await d.page.waitForTimeout(900);
          if (path === '/chat') assert.equal(await d.page.locator('#thread .handoff').count(), DAYS.length, 'the three reports are in the main conversation');
          found.push(...await violations(d.page, `${size} ${path}`));
        }
        await d.page.goto(`${m.base}/settings#backups`);
        await d.page.locator('#settings-view #checkpoints').waitFor();
        await d.page.waitForTimeout(900);
        found.push(...await violations(d.page, `${size} /settings#backups`));
        await d.ctx.close();
      }
    } finally {
      await stop(nova);
    }
    const f = await topologyFixture();
    try {
      for (const [size, vp] of SIZES) {
        const d = await device(b, { ...vp, serviceWorkers: 'block' });
        await d.page.goto(`${f.base}/topology`);
        await ready(d.page);
        await d.page.locator('#topology-view [data-topology-machine]').first().waitFor();
        found.push(...await violations(d.page, `${size} /topology overview`));
        await d.page.locator(`[data-topology-machine="${f.hubId}"]`).click();
        await d.page.locator('#topology-view [data-topology-service]').first().waitFor();
        found.push(...await violations(d.page, `${size} /topology machine`));
        await d.page.locator('#topology-view [data-topology-service]').first().click();
        await d.page.locator('#topology-view [data-topology-action="promote"]').waitFor();
        found.push(...await violations(d.page, `${size} /topology service`));
        await d.ctx.close();
      }
    } finally {
      await b.close();
      await f.close();
    }
    assert.deepEqual(found, [], `axe ${RULES.join(' and ')}: every landmark has a unique name and no heading skips a level`);
  });
}
