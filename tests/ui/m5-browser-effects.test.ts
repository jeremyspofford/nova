// A browser task that sent a form is never sent again by itself (M5 review, should-fix 2), in a
// real browser: the reviewer's probe, whose plan expects text the site's records never show, used
// to send the form three times. Now it sends once, waits as Needs you with "May already have
// happened" and what didn't match, and the person, in the PWA, sees Retry (which asks for the OK
// again: the form plan is tier 2) and Cancel. Runs where Chromium can start (scripts/ui-test.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';
import { browserEnv, delegate, events, formPlan, startFormSite, waitTask } from './m5c-support.ts';

const MAY = /^May already have happened: .*Check, then retry or cancel\.$/;

test('the reviewer’s resubmit probe: evidence that doesn’t hold up after a form went out sends it once, then asks you', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const site = await startFormSite();
  const m = blank('nova-ui-effects-');
  const nova = await m.start(browserEnv());
  try {
    await finishSetup(m);
    const plan = { ...formPlan(site, { person: false }), verify: { url: `${site.url}/records`, expect: ['Ada Example', 'Text the site never shows'] } };
    const r = await delegate(m, plan, 'Sign up, then check for something that isn’t there');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const held = await waitTask(m, r.body.id, (x) => (x.state === 'waiting' && MAY.test(x.reason ?? '')) || ['done', 'failed'].includes(x.state), 120_000);
    assert.equal(held.state, 'waiting', held.reason ?? '');
    assert.match(held.reason!, MAY);
    assert.match(held.reason!, /doesn’t show “Text the site never shows”/);
    await sleep(2000);
    assert.equal(site.records.length, 1, 'the form went out once');
    const ev = await events(m, held.id);
    assert.equal(ev.filter((e) => e.kind === 'dispatched').length, 1, 'and the plan ran once');
    const failed = ev.find((e) => e.kind === 'verification_failed')!;
    assert.equal(failed.detail.held, true);
    assert.match(JSON.stringify(failed.detail.discrepancy), /Text the site never shows/);

    // The person, at the hub's own screen: the task is Needs you, with Retry and Cancel.
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/`);
    await ready(page);
    const row = page.locator(`.needs-you-card .task-row[data-task="${held.id}"]`);
    await row.waitFor({ timeout: 10_000 });
    assert.match((await row.textContent()) ?? '', /Needs you/);
    await row.locator('[data-action="open-task"]').click();
    const sheet = page.locator('#sheet');
    await sheet.locator('.task-reason').waitFor();
    assert.match((await sheet.locator('.task-reason').textContent()) ?? '', MAY);
    const retry = sheet.locator('[data-action="retry-task"]');
    assert.equal(await retry.textContent(), 'Try again (asks for your OK)');
    assert.equal(await sheet.locator('[data-action="cancel-task"]').count(), 1);

    // Retrying asks for the OK first; nothing is sent until then.
    await retry.click();
    await sheet.locator('form.approval-sheet [data-action="approve"]').waitFor({ timeout: 10_000 });
    const asking = await m.get(`/api/v1/tasks/${held.id}`);
    assert.deepEqual([asking.state, asking.approved_at, asking.reason], ['waiting', null, 'Needs your OK before it runs.']);
    await sleep(1000);
    assert.equal(site.records.length, 1, 'still once: retrying waits for the OK');
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
    await site.close();
  }
});
