// Settings › Models keeps what the person typed across a redraw (found fixing #426): a new disk
// budget typed, the section redrawn underneath it by a change from elsewhere, then Tab to Save and
// Enter. What is saved is what was typed, not what the redraw put back. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop } from '../acceptance/support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { INSTALLED, LIBRARY, hardwareFile } from '../support/models.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';

test('Settings › Models: a value typed, then a redraw, then Save, saves the typed value', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY });
  const m = blank('nova-ui-models-keep-');
  const nova = await m.start({ NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir) });
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#models`);
    await ready(page);
    const section = page.locator('#models');
    const gb = section.locator('form[data-form="disk"] input[name="gb"]');
    await gb.waitFor();

    // The person types a budget; before they save it, the budget changes elsewhere (another
    // screen, the API) and Nova tells this page, which loads Models again.
    await gb.fill('7');
    const reloaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models/decisions' && r.request().method() === 'GET');
    assert.equal((await m.send('PUT', '/api/v1/models/disk-budget', { gb: 50 })).status, 200);
    await reloaded;

    // Tab to Save: the redraw held while they typed happens now. Their 7 is still there, and Save
    // still has the focus.
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => /of a 50 GB budget/.test(document.querySelector('#models form[data-form="disk"]')?.textContent ?? ''));
    assert.equal(await gb.inputValue(), '7', 'the typed budget survives the redraw');
    assert.ok(await page.evaluate(() => document.activeElement?.matches('#models form[data-form="disk"] [type="submit"]')), 'Save keeps the focus across the redraw');

    // Enter on Save: the 7 they typed is what Nova keeps, and the field then shows what was saved.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /of a 7 GB budget/.test(document.querySelector('#models form[data-form="disk"]')?.textContent ?? ''));
    const saved = await m.plain('GET', '/api/v1/models');
    assert.equal(saved.body.disk.budget_bytes, 7 * 1024 ** 3, 'the saved budget is the typed one');
    assert.equal(await gb.inputValue(), '7');
    assert.equal(await gb.evaluate((el) => (el as HTMLInputElement).defaultValue), '7', 'the form was reset to what was saved');
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await ollama.close();
    await b.close();
  }
});
