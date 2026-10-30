// Settings › Providers (M5a), in Chromium against the real server: Nova recommends one chat model
// rather than listing them (one standout), a provider is set up and turned on through its tier-2
// sheet, and choosing the recommendation sends chat through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';

test('M5a: Settings › Providers recommends one chat model; set up, turned on with an OK, chosen, and chat goes through it', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const fake = await startFakeOpenAI({ model: 'example-chat', reply: () => 'Hello from the local model.' });
  const m = blank('nova-ui-providers-');
  // The model command counts as the cloud (agent_egress undeclared), and setup picks local-only.
  const nova = await m.start({ NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}` });
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280 });
    await page.goto(`${m.base}/settings#providers`);
    await ready(page);
    const section = page.locator('#providers');
    await section.locator('.settings-row').first().waitFor();
    assert.match((await section.textContent()) ?? '', /Chat uses Your model command/);
    assert.match((await section.textContent()) ?? '', /privacy setting is local-only/);
    assert.equal(await section.locator('.btn.primary').count(), 0, 'nothing to recommend yet, so nothing stands out');

    // Set up the local model in its sheet.
    await section.locator('details.raw summary').click();
    await page.locator('[data-action="provider-setup"][data-provider="openai-compatible"]').click();
    await page.fill('#pf-base_url', fake.url);
    await page.fill('#pf-model', 'example-chat');
    await page.locator('.provider-form button[type="submit"]').click();
    await page.locator('.toast', { hasText: 'Saved.' }).waitFor();

    // Turning it on asks first, saying where its data goes.
    await page.locator('[data-action="provider-on"][data-provider="openai-compatible"]').click();
    const sheet = page.locator('.approval-sheet[data-provider="openai-compatible"]');
    await sheet.waitFor();
    assert.match((await sheet.textContent()) ?? '', /Stays on this computer/);
    if (shots) await shoot(page, join(shots, 'm5a-provider-turn-on.png'));
    await sheet.locator('[data-action="approve"]').click();
    await page.locator('.toast', { hasText: 'is on' }).waitFor();

    // Now Nova recommends it for chat: one standout.
    const use = section.locator('.btn.primary[data-action="provider-choose"]');
    await use.waitFor();
    assert.equal(await section.locator('.btn.primary').count(), 1, 'one standout element');
    assert.match((await use.textContent()) ?? '', /Use Local model/);
    await section.evaluate((e) => e.scrollIntoView());
    if (shots) await shoot(page, join(shots, 'm5a-providers.png'));
    await use.click();
    await page.locator('.toast', { hasText: 'Chat uses' }).waitFor();
    await page.waitForFunction(() => /Chat uses Local model/.test(document.getElementById('providers')?.textContent ?? ''));

    // Chat goes through it.
    const { body } = await m.send('POST', '/api/sessions', { text: 'hello' });
    const s = await until<any>(() => m.get(`/api/sessions/${body.id}`), (x) => x.live === null && x.session.turns[0]?.state !== 'open', 400);
    assert.match(JSON.stringify(s.session.turns[0].items), /Hello from the local model\./);
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await b.close();
    await stop(nova);
    await fake.close();
  }
});
