// A saved Screenpipe source in Settings › Capture: its address and lookback can be changed in the
// console (a mistyped address used to need the API to fix), and its API key entered as a password,
// kept in the vault, never shown back, and removable. A Screenpipe that refuses Nova says so in its
// own words, not as "isn't answering". Against the stand-in Screenpipe, with its key turned on.
// Neutral placeholders only; nothing on this machine is captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop, until } from '../acceptance/support.ts';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { blank, browser, device, finishSetup, ready } from './support.ts';

const KEY = 'example-screenpipe-key-2';

test('M6a: edit a Screenpipe source’s address and lookback, and give it the API key it asks for', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const sp = await startFakeScreenpipe();
  sp.requireKey(KEY);
  const m = blank('nova-ui-m6a-source-');
  const nova = await m.start({ NOVA_CAPTURE_POLL_MS: '150' });
  try {
    await finishSetup(m);
    // Saved with a mistyped port, then turned on: it can't be reached.
    const wrong = `http://127.0.0.1:${sp.port === 1 ? 2 : 1}`;
    const added = await m.send('POST', '/api/v1/capture/sources/screenpipe', { url: wrong });
    const id = added.body.id;
    await m.send('POST', `/api/v1/capture/sources/${encodeURIComponent(id)}/enable`);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#capture`);
    await ready(page);
    const row = page.locator('#capture .conn[data-source^="screenpipe:"]');
    await row.waitFor();
    await page.waitForFunction(() => /isn’t answering/.test(document.querySelector('#capture .conn')?.textContent ?? ''));

    // The address is fixed from the console, with the lookback, and round-trips.
    const form = row.locator('form[data-form="screenpipe-edit"]');
    assert.equal(await form.isVisible(), true, 'open by itself while the source can’t be reached');
    assert.equal(await form.locator('input[name="url"]').inputValue(), wrong);
    assert.equal(await form.locator('input[name="api_key"]').getAttribute('type'), 'password');
    await form.locator('input[name="url"]').fill(`${sp.base}/`);
    await form.locator('input[name="lookback_minutes"]').fill('20');
    await form.locator('button[type="submit"]').click();
    const source = (await until(() => m.get('/api/v1/capture'), (c: any) => c.sources[0].url === sp.base, 100)).sources[0];
    assert.deepEqual([source.url, source.lookback_minutes], [sp.base, 20], 'the edit reached Nova');
    await page.waitForFunction((b) => (document.querySelector('#capture form[data-form="screenpipe-edit"] input[name="url"]') as HTMLInputElement | null)?.value === b, sp.base);

    // Screenpipe answers but refuses Nova: said in its own words, not "isn't answering".
    await page.waitForFunction(() => /refused Nova; it needs the API key from Screenpipe’s Settings > Privacy/.test(document.querySelector('#capture .conn')?.textContent ?? ''));
    assert.match((await row.locator('.pill').textContent()) ?? '', /Needs you/);

    // The key, typed as a password, saved to the vault, then Capturing; never shown back.
    await form.locator('input[name="api_key"]').fill(KEY);
    await form.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /Capturing/.test(document.querySelector('#capture .conn .pill')?.textContent ?? ''));
    assert.equal((await m.get('/api/v1/capture')).sources[0].has_api_key, true);
    assert.equal(await row.locator('input[name="api_key"]').inputValue(), '', 'the field is never filled back in');
    assert.doesNotMatch(await page.content(), new RegExp(KEY), 'the key is nowhere on the page');
    assert.ok(sp.auths.includes(`Bearer ${KEY}`), 'Screenpipe got the key');

    // Removable.
    const details = row.locator('details.capture-edit');
    if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator('summary').click();
    await row.locator('[data-action="capture-key-remove"]').click();
    await until(() => m.get('/api/v1/capture'), (c: any) => c.sources[0].has_api_key === false, 100);
    assert.deepEqual(errors.filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING|Failed to load resource/.test(e)), []);
  } finally {
    await b.close();
    await stop(nova);
    await sp.close();
  }
});
