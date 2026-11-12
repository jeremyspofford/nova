// Tier 3 in the conversation (NOVA-SPEC §6, M3 §2): an Era 2 tool step that can't be undone asks
// for an explicit confirm every time; Enter alone never allows it. An ordinary step still asks
// once. (Review finding: every tool step was drawn as tier 2.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { ROOT, blank, browser, composerShown, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M3: an irreversible command needs the confirm box; an ordinary one asks once', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-tier3-');
  const nova = await m.start({ NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' });
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280 });
    await page.goto(`${m.base}/chat`);
    await ready(page);
    // V-1: the composer is inert until the main conversation is in; typing before then reaches nothing.
    await composerShown(page);

    await page.fill('#input', 'clear out the scratch folder');
    await page.keyboard.press('Enter');
    const card = page.locator('.approval[data-tier="3"]');
    await card.waitFor({ timeout: 10000 });
    const allow = card.locator('[data-action="allow"]');
    assert.equal(await allow.isDisabled(), true, 'Allow starts locked');
    assert.doesNotMatch((await card.locator('.keys').textContent()) ?? '', /Enter/, 'the hint doesn’t offer Enter');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.confirm !== undefined), true, 'focus starts on the confirm box');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(await card.count(), 1, 'Enter alone did nothing: the step is still waiting');
    if (shots) await shoot(page, join(shots, 'tier3-command.png'));
    // T2: the box alone never allowed it on the server. A plain allow (only X-Nova, as any program
    // here could send) is refused; the page's own Allow goes through the passkey step.
    const tool = await card.getAttribute('data-tool');
    const plain = await page.evaluate(async (t) => { const id = 'main'; const r = await fetch(`/api/sessions/${id}/approvals/${t}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: '{"decision":"allow"}' }); return { status: r.status, error: (await r.json()).error }; }, tool);
    assert.equal(plain.status, 403, 'a tier-3 allow without a passkey is refused');
    assert.match(plain.error, /confirmed with a passkey/);
    await card.locator('[data-confirm]').check();
    assert.equal(await allow.isDisabled(), false, 'ticking the box unlocks Allow');
    await allow.click();
    await page.waitForFunction(() => /The scratch folder is gone/.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 10000 });

    // An ordinary command: tier 2, one click or Enter.
    await page.fill('#input', 'run git status');
    await page.keyboard.press('Enter');
    const two = page.locator('.approval[data-tier="2"]');
    await two.waitFor({ timeout: 10000 });
    assert.equal(await two.locator('[data-confirm]').count(), 0);
    assert.equal(await two.locator('[data-action="allow"]').isDisabled(), false);
    await two.locator('[data-action="allow"]').click();
    await page.waitForFunction(() => /nothing to commit before standup/.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 10000 });
    // (The one 403 is the test's own plain allow above, refused as it must be.)
    assert.deepEqual(errors.filter((e) => !/status of 403/.test(e)), [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
