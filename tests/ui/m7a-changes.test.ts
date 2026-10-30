// Settings › Changes (M7a) in a real browser, against the real server (its sandboxes are real
// processes too): a tier-3 change waits with what the sandbox showed, "Ship it" is the one
// standout and needs confirming; it canaries with its probes on view, goes live, and is rolled back
// by hand; a sabotaged change shows where it stopped and why. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { windDown } from '../support/changes.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M7a: Settings › Changes — the tier-3 Ship it with its sandbox evidence, the canary with its probes, live, rolled back by hand, a stopped change', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m7a-');
  const nova = await m.start({ NOVA_TEST_CLOCK: '1' });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm7') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const api = (p: string) => `/api/v1${p}`;
  try {
    await finishSetup(m);
    await m.send('PUT', api('/profile/user/timezone'), { value: 'UTC' });
    // A stopped one (its own test is wrong) and one a provider proposed: tier 3.
    const broken = await m.send('POST', api('/changes'), { kind: 'trigger-rules', artifact: windDown('0.9.0', { tests: [{ name: 'fires at eight', at: '20:00', expect: { rule: 'Wind down', fires: true } }] }) });
    await until<any>(() => m.get(api(`/changes/${broken.body.id}`)), (c) => c.state === 'stopped', 1600);
    // Its second rule starts a task: the OK is given on what that task would run.
    const pack = windDown('1.0.0');
    const note = { name: 'Morning note', class: 'heartbeat', cron: '0 6 * * 1', action: { kind: 'task', task: { title: 'Write the morning note', owner: 'workspace', goal: 'A note exists.', evidence_required: [{ kind: 'read_back', target: 'workspace:notes/morning.md' }], approval_tier: 0, inputs: { action: 'write', path: 'notes/morning.md', content: 'Good morning.' } } } };
    const proposed = await m.send('POST', api('/changes'), { kind: 'trigger-rules', artifact: { ...pack, rules: [...pack.rules, note] }, proposed_by: 'provider:example-agent' });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const id = proposed.body.id as string;
    await until<any>(() => m.get(api(`/changes/${id}`)), (c) => c.state === 'waiting', 1600);

    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#changes`);
    await ready(page);
    const section = page.locator('#changes');
    const ship = section.locator('.change-ship');
    await ship.waitFor();
    const top = () => section.evaluate((el) => el.scrollIntoView({ block: 'start' }));

    // The one standout, with what the sandbox showed, and a confirmation every time.
    assert.equal(await section.locator('.btn.primary').count(), 1, 'one standout');
    const go = ship.locator('[data-action="changes-ship"]');
    assert.equal(await go.textContent(), 'Ship it');
    assert.equal(await go.isDisabled(), true, 'tier 3: confirmed first');
    assert.match((await ship.textContent()) ?? '', /Proposed by example-agent · tier 3/);
    assert.match((await ship.textContent()) ?? '', /sends you “Time to wind down for the evening\.”/);
    assert.match((await ship.textContent()) ?? '', /starts “Write the morning note”, run by workspace, at tier 0 \(acts without asking\), privacy as your setting says, with inputs \{"action":"write","path":"notes\/morning\.md","content":"Good morning\."\}/);
    assert.deepEqual(await ship.locator('.change-stage').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-stage')}:${e.getAttribute('data-state')}`)), ['sandbox:passed', 'tests:passed', 'health:passed', 'release:passed']);
    assert.match((await ship.locator('.change-stage[data-stage="health"]').textContent()) ?? '', /Health and 6 smoke probes passed on the sandbox/);
    // The stopped one says where it stopped, and why; it was never offered.
    const stopped = section.locator(`.change-row[data-change="${broken.body.id}"]`);
    assert.match((await stopped.textContent()) ?? '', /Failed/);
    assert.match((await stopped.locator('.change-words').textContent()) ?? '', /Stopped at tests: .*fires at eight/);
    assert.equal(await stopped.locator('[data-action="changes-rollback"]').count(), 0);
    if (shots) { await top(); await shoot(page, join(shots, 'changes-ship-it.png')); }

    await ship.locator('input[data-action="changes-confirm"]').check();
    assert.equal(await go.isDisabled(), false);
    await go.click();
    // The canary, with its probes, from the pipeline's own record.
    const row = section.locator(`.change-row[data-change="${id}"]`);
    await row.locator('.change-canary').waitFor();
    assert.equal(await section.locator('.btn.primary').count(), 0, 'nothing waits for the person now');
    await m.send('POST', api('/changes/tick'), { now: '2030-01-15T08:10:00.000Z' });
    await page.waitForFunction((cid) => document.querySelectorAll(`#changes .change-row[data-change="${cid}"] .change-probe[data-ok="true"]`).length >= 4, id);
    assert.match((await row.locator('.change-canary').textContent()) ?? '', /Live on its first firings until .*Probes ran 1 time/);
    assert.match((await row.locator('.change-canary').textContent()) ?? '', /No problems opened since the change\./);
    if (shots) await shoot(page, join(shots, 'changes-canary.png'));
    await m.send('POST', api('/changes/tick'), { now: '2030-01-15T08:20:00.000Z' });
    await m.send('POST', api('/changes/tick'), { now: '2030-01-15T09:00:00.000Z' });
    await page.waitForFunction((cid) => document.querySelector(`#changes .change-row[data-change="${cid}"]`)?.getAttribute('data-state') === 'live', id);
    assert.match((await row.textContent()) ?? '', /Verified/);
    // Verified carries its evidence: the Ship task, verified by Nova.
    assert.equal(await row.locator('button.status[data-status="verified"]').getAttribute('data-task'), (await m.get(api(`/changes/${id}`))).ship_task_id);
    // Evidence for every stage, one layer down.
    assert.equal(await row.locator('details.change-evidence').getAttribute('open'), null);
    await row.locator('details.change-evidence summary').click();
    assert.deepEqual(await row.locator('details .change-stage').evaluateAll((els) => els.map((e) => e.getAttribute('data-state'))), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed']);

    // Roll back by hand: it asks, then puts back what was there.
    await row.locator('[data-action="changes-rollback"]').click();
    await row.locator('[data-action="changes-rollback-yes"]').waitFor();
    assert.match((await row.locator('.change-confirm').textContent()) ?? '', /Put back what was there before\? Only Daily wind-down changes\./);
    if (shots) await shoot(page, join(shots, 'changes-roll-back.png'));
    await row.locator('[data-action="changes-rollback-yes"]').click();
    await page.waitForFunction((cid) => document.querySelector(`#changes .change-row[data-change="${cid}"]`)?.getAttribute('data-state') === 'rolled_back', id);
    assert.match((await row.locator('.change-words').textContent()) ?? '', /You rolled it back/);
    assert.equal((await m.get(api('/triggers/rules'))).length, 0, 'the reminder is gone, as before');
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await b.close();
  }
});
