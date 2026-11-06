// Config onboarding, door 2, in Chromium against the real server: Settings › Configuration draws
// each personal setting from the schema with its layer; a few guided questions end in the same
// diff as a file, nothing saves before the OK, and privacy and quiet hours (tier 3) go through the
// passkey step; "Use the default" deletes a setting so the default shows through; a value that
// doesn't fit is said plainly and saves nothing; at the fold cover, no sideways scroll and 44px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shortTargets } from './support.ts';

test('Config door 2: questions end in the diff and save through the checked path; Use the default; plain refusals', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-config-form-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const base = m.base.replace('//127.0.0.1', '//localhost');
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${base}/settings#config`);
    await ready(page);
    const form = page.locator('#config-form');
    const row = (key: string) => form.locator(`li[data-config-key="${key}"]`);
    await row('tuning.warmth').waitFor();
    // Setup set the directness (your pack); warmth is still Nova's default, with nothing to reset.
    assert.equal(await row('tuning.directness').locator('[data-layer]').getAttribute('data-layer'), 'pack');
    assert.equal(await row('tuning.warmth').locator('[data-layer]').getAttribute('data-layer'), 'default');
    assert.equal(await row('tuning.warmth').locator('[data-action="config-reset"]').count(), 0);

    await form.locator('[data-action="config-ask"]').click();
    await form.getByRole('heading', { name: 'Where and when' }).waitFor();
    await page.fill('#cfg-policy-quiet-hours', '22:00–07:00');
    await form.locator('[data-action="config-next"]').click();
    await form.getByRole('heading', { name: 'How Nova talks' }).waitFor();
    await page.selectOption('#cfg-tuning-directness', 'blunt');
    await form.locator('[data-action="config-next"]').click();
    await form.getByRole('heading', { name: 'Privacy' }).waitFor();
    await page.selectOption('#cfg-privacy-default', 'local-preferred');
    await form.locator('[data-action="config-next"]').click();
    await form.locator('[data-config-setup="review"]').waitFor();
    const diff = await form.locator('[data-config-diff]').innerText();
    assert.match(diff, /Quiet hours[\s\S]*22:00–07:00/);
    assert.match(diff, /Directness[\s\S]*Plainly[\s\S]*Bluntly/);
    assert.match(diff, /Privacy[\s\S]*Local first/);
    assert.equal(await form.locator('[data-config-diff] [data-config-key="user.name"]').count(), 0, 'an answer left as it was is no change');
    assert.equal((await m.get('/api/v1/profile')).tuning.directness, 'balanced', 'nothing saved before the OK');

    // Privacy and quiet hours: tier 3, so Save goes through the passkey step on this screen.
    await form.locator('[data-action="config-apply"]').click();
    const after = await until<any>(() => m.get('/api/v1/profile'), (x) => x.privacy?.default === 'local-preferred');
    assert.deepEqual([after.tuning.directness, after.policy.quiet_hours], ['blunt', { start: '22:00', end: '07:00' }]);
    await form.locator('[data-config-form-said]', { hasText: /Saved 3 changes/ }).waitFor();

    // Use the default: the setting is deleted, so Nova's default shows through.
    await row('tuning.directness').locator('[data-action="config-reset"]').click();
    await until<any>(() => m.get('/api/v1/profile'), (x) => x.tuning?.directness === undefined);
    await row('tuning.directness').locator('[data-layer="default"]').waitFor();
    assert.equal(await page.inputValue('#cfg-tuning-directness'), 'balanced');
    await row('privacy.default').locator('[data-action="config-reset"]').click(); // tier 3 again
    await until<any>(() => m.get('/api/v1/profile'), (x) => x.privacy?.default === undefined);

    // A value that doesn't fit is said plainly, and nothing is saved.
    await page.fill('#cfg-policy-quiet-hours', 'soon');
    await form.locator('[data-action="config-review"]').click();
    await form.locator('[data-config-form-said]', { hasText: /a start and an end, like 22:00–07:00/ }).waitFor();
    assert.deepEqual((await m.get('/api/v1/profile')).policy.quiet_hours, { start: '22:00', end: '07:00' });

    // The fold cover: no sideways scroll, every target at least 44px.
    await page.setViewportSize({ width: 344, height: 882 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
    assert.deepEqual(await shortTargets(page, '#config-form :is(button, select, input)', { enabled: false }), [], '44px targets');
    assert.deepEqual(errors, []);
  } finally {
    await b.close();
    await stop(nova);
  }
});
