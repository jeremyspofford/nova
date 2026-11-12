// Config onboarding, door 3, in Chromium against the real server: Nova proposes a settings change in
// the conversation; the card shows the same diff as Settings › Configuration, nothing changes until
// the person allows it, and then it does, through the same checked path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { ROOT, blank, browser, composerShown, device, finishSetup, ready } from './support.ts';

test('Config door 3: Nova proposes a settings change in chat, shown as a diff; it applies only on the OK', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-config-chat-');
  const nova = await m.start({ NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/chat`);
    await ready(page);
    await composerShown(page); // V-1: the composer is inert until the main conversation is in
    await page.fill('#input', 'set my timezone to Asia/Tokyo');
    await page.keyboard.press('Enter');
    const card = page.locator('.approval[data-tool]');
    await card.waitFor({ timeout: 10000 });
    assert.equal(await card.getAttribute('data-tier'), '2', 'a timezone is tier 2: it asks once');
    assert.match(await card.innerText(), /Nova wants to change one of your settings/);
    assert.match(await card.locator('[data-config-key="user.timezone"]').innerText(), /User › Timezone[\s\S]*asia\/tokyo/i);
    assert.doesNotMatch(String((await m.get('/api/v1/profile')).user?.timezone ?? ''), /tokyo/i, 'nothing changes before the OK');
    await card.locator('[data-action="allow"]').click();
    await page.waitForFunction(() => /Done: your timezone is asia\/tokyo now\./i.test(document.getElementById('thread')?.textContent ?? ''), null, { timeout: 10000 });
    assert.equal((await until<any>(() => m.get('/api/v1/profile'), (x) => /asia\/tokyo/i.test(x.user?.timezone ?? ''))).user.timezone.toLowerCase(), 'asia/tokyo');
    assert.deepEqual(errors, []);
  } finally {
    await b.close();
    await stop(nova);
  }
});
