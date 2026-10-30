// Settings › Danger zone (M7 amendment §2) in a real browser, against the real server: last in
// Settings and set apart, its one standout the erase button; the export first, with its recovery
// key shown once and the words about what it leaves out; the confirmation listing what is erased
// and what is not, the erase button held until the box is ticked; then Nova restarts in place, by
// itself, and the page opens first-run setup with what the reset did. The export then opens with
// the key the page showed.
// A throwaway home and folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openEncrypted } from '../../src/core/index.ts';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M7 amendment: the Danger zone — export first, the confirmation, erase, first run with the result', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m7-reset-');
  const nova = await m.start();
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm7') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const out = join(m.dir, 'export-here');
  mkdirSync(out, { mode: 0o700 });
  try {
    await finishSetup(m);
    assert.equal((await m.send('POST', '/api/v1/memory', { kind: 'preference', content: 'Prefers tea in the afternoon.' })).status, 201);

    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#danger-zone`);
    await ready(page);
    const zone = page.locator('#danger-zone');
    await zone.locator('[data-action="reset-start"]').waitFor();
    // Last on the Settings page, and set apart.
    assert.equal(await page.locator('.settings-part').last().getAttribute('id'), 'settings-danger');
    assert.equal(await zone.locator('.btn.primary').count(), 1, 'one standout');
    assert.match((await zone.locator('.btn.primary').getAttribute('class')) ?? '', /danger/, 'and it is the destructive one');
    assert.equal(await zone.locator('.btn.primary').textContent(), 'Erase Nova and start over…');
    if (shots) { await zone.scrollIntoViewIfNeeded(); await shoot(page, join(shots, 'reset-danger-zone.png')); }

    // The export first: recommended, with what it leaves out said plainly.
    await zone.locator('[data-action="reset-start"]').click();
    const sheet = page.locator('#sheet .reset-sheet');
    await sheet.locator('input[name="folder"]').waitFor();
    assert.match((await sheet.textContent()) ?? '', /Your saved passwords and keys aren’t in the export; you’ll add them again\./);
    assert.equal(await sheet.locator('.btn.primary').count(), 1);
    assert.equal(await sheet.locator('.btn.primary').textContent(), 'Export');
    // A folder that isn't there is refused: Nova never creates it.
    await sheet.locator('input[name="folder"]').fill(join(m.dir, 'not-there'));
    await sheet.locator('.btn.primary').click();
    await page.locator('#sheet .reset-error').waitFor();
    assert.match((await page.locator('#sheet .reset-error').textContent()) ?? '', /never creates the folder/);
    await page.locator('#sheet input[name="folder"]').fill(out);
    await page.locator('#sheet .reset-sheet .btn.primary').click();
    const key = page.locator('#sheet .reset-key');
    await key.waitFor();
    const recovery = ((await key.textContent()) ?? '').trim();
    assert.match(recovery, /^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    if (shots) await shoot(page, join(shots, 'reset-exported.png'));

    // The confirmation: what goes, what stays, and a box to tick, every time.
    await page.locator('#sheet [data-action="reset-continue"]').click();
    const confirm = page.locator('#sheet .reset-sheet[data-step="confirm"]');
    await confirm.waitFor();
    const words = (await confirm.textContent()) ?? '';
    assert.match(words, /Erase Nova on this machine\?/);
    assert.match(words, /Nova’s own files in its home: .*nova\.db/);
    assert.match(words, /The supervisor’s code releases stay/);
    assert.match(words, new RegExp(`Your export in ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(words, /I understand this erases Nova on this machine, and I want to start over\./);
    const erase = confirm.locator('[data-action="reset-erase"]');
    assert.equal(await confirm.locator('.btn.primary').count(), 1, 'one standout');
    assert.equal(await erase.isDisabled(), true, 'tier 3: the box first');
    await confirm.locator('input[name="confirm"]').check();
    assert.equal(await erase.isDisabled(), false);
    if (shots) await shoot(page, join(shots, 'reset-confirm.png'));
    // The only console line so far is the folder Nova refused (a 400), on purpose.
    assert.deepEqual(errors.filter((e) => !/status of 400/.test(e)), []);
    const before = errors.length;
    // Something this browser kept of the old Nova: a draft, and an offline copy.
    await page.evaluate(async () => { localStorage.setItem('nova.draft.new', 'half a thought'); await (await caches.open('nova-test')).put('/kept', new Response('old')); });
    await erase.click();
    await page.locator('#sheet .reset-sheet[data-step="erasing"]').waitFor();
    assert.match((await page.locator('#sheet .reset-sheet').textContent()) ?? '', /opens first-run setup once Nova is back/);

    // Nova restarts in place by itself (same address), and this page opens first-run setup, with
    // what the reset did. Nobody restarted anything.
    await page.locator('#setup .reset-result').waitFor({ timeout: 60_000 });
    assert.match((await page.locator('#setup .reset-result').textContent()) ?? '', /Nova was erased on this machine and started over\./);
    assert.equal((await m.get('/api/v1/setup')).done, false);
    assert.deepEqual(await m.get('/api/v1/memory'), [], 'nothing remembered');
    if (shots) await shoot(page, join(shots, 'reset-first-run.png'));
    // And it forgot what it kept of the Nova that was erased.
    // (The fresh page makes its own new entries again; nothing of the old ones is there.)
    const kept = await page.evaluate(async () => ({ draft: localStorage.getItem('nova.draft.new'), old: (await caches.keys()).includes('nova-test') }));
    assert.deepEqual(kept, { draft: null, old: false });
    // While Nova was down, its open streams broke and a look for it found nothing: nothing else.
    assert.deepEqual(errors.slice(before).filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(e)), []);

    // The export opens with the key the page showed, once.
    const folder = join(out, readdirSync(out)[0]!);
    const opened = openEncrypted(join(folder, 'nova-export.nbk'), recovery, join(m.dir, 'opened'));
    assert.ok(opened.files.length > 0);
    assert.ok(readdirSync(folder).includes('memory.md'));
  } finally {
    await stop(nova);
    await b.close();
  }
});
