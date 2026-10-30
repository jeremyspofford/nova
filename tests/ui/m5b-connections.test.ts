// Settings › Connections (M5b) in a real browser, against the real server and the stand-in Home
// Assistant: nothing connected, Nova recommends one (its Connect is the one standout) and keeps
// the rest one layer down, Gmail saying plainly why it is off under local-only; the vault's
// key-file notice; connecting Home Assistant with an address and a token; its status in plain
// words, live; disconnecting through a sheet that says what goes. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M5b: connect Home Assistant in Settings › Connections, see it live, disconnect it', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const ha = await startFakeHomeAssistant();
  const m = blank('nova-ui-m5b-');
  const nova = await m.start();
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm5') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#connections`);
    await ready(page);
    const section = page.locator('#connections');
    const top = () => section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await section.locator('.conn-offer').first().waitFor();
    assert.match((await section.textContent()) ?? '', /Nothing is connected yet/);
    // One recommendation, one standout; Gmail is one layer down and says why it is off.
    assert.equal(await section.locator('.btn.primary').count(), 1, 'one standout');
    assert.match((await section.locator('.conn-offer').first().textContent()) ?? '', /Home Assistant/);
    assert.match((await section.locator('.conn-offer').first().textContent()) ?? '', /after asking you first/);
    assert.equal(await section.locator('.conn-more').getAttribute('open'), null, 'the rest are folded away');
    if (shots) { await top(); await shoot(page, join(shots, 'connections-empty.png')); }
    await section.locator('.conn-more summary').click();
    assert.match((await section.locator('.conn-more').textContent()) ?? '', /Gmail[\s\S]*local-only/);

    await section.locator('input[name="url"]').fill(ha.base);
    await section.locator('input[name="token"]').fill(ha.token);
    assert.equal(await section.locator('input[name="token"]').getAttribute('type'), 'password');
    await section.locator('.conn-form button[type="submit"]').click();
    const row = section.locator('.conn[data-connector="home-assistant"]');
    await row.waitFor();
    await page.waitForFunction(() => /Hearing changes as they happen/.test(document.querySelector('.conn[data-connector="home-assistant"]')?.textContent ?? ''));
    const text = (await row.textContent()) ?? '';
    assert.match(text, /Connected to Home since/);
    assert.match(text, /Connected/);
    // The vault's key sits in a file here (no keychain in the container): said plainly.
    assert.match((await section.locator('.conn-notice').textContent()) ?? '', /key is in a file next to them/);
    // Nothing else to recommend under local-only: no standout left in the view.
    assert.equal(await section.locator('.btn.primary').count(), 0);
    if (shots) { await top(); await shoot(page, join(shots, 'connections-connected.png')); }

    await row.locator('[data-action="disconnect-connector"]').click();
    const sheet = page.locator('#sheet .conn-disconnect');
    await sheet.waitFor();
    assert.match((await sheet.textContent()) ?? '', /signs out at Home Assistant where it can, then deletes its secret in Nova’s vault and its settings/);
    if (shots) await shoot(page, join(shots, 'connections-disconnect.png'));
    await sheet.locator('button[type="submit"]').click();
    await section.locator('.conn-offer').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.conn[data-connector="home-assistant"]'));
    assert.deepEqual(ha.state.revoked, [ha.tokenId], 'the token was deleted at Home Assistant');
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await ha.close();
    await b.close();
  }
});
