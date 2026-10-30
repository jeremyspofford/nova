// Settings › Backups › Checkpoints (M7 amendment §1) in a real browser, against the real server:
// the retention rule stated; taking a named checkpoint (the one standout while nothing is being
// confirmed); the list with kind, date, size and version; restoring asks on the hub's own screen,
// every time, with what it undoes and that a checkpoint of now comes first, and its button becomes
// the view's one standout; Nova restarts by itself and the page carries on; deleting a named one
// asks first. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M7 amendment: Settings › Checkpoints — take one, the list, restore with its confirmation and no manual restart, delete', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-cp-');
  const nova = await m.start();
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm7') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const api = (p: string) => `/api/v1${p}`;
  const memories = async () => ((await m.get(api('/memory'))) as { content: string }[]).map((x) => x.content).sort();
  try {
    await finishSetup(m);
    await m.send('POST', api('/memory'), { kind: 'fact', content: 'The plants get water on Sundays.' });

    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#checkpoints`);
    await ready(page);
    const section = page.locator('#checkpoints');
    await section.locator('[data-action="cp-take"]').waitFor();
    assert.match((await section.textContent()) ?? '', /newest 10 automatic checkpoints, counted in the order they were taken, never by date/);
    assert.match((await section.textContent()) ?? '', /until you delete it/);
    assert.equal(await section.locator('.btn.primary').count(), 1, 'one standout');
    assert.equal(await section.locator('.btn.primary').getAttribute('data-action'), 'cp-take');

    // Take one, by name.
    await section.locator('input[name="cp-name"]').fill('Before the experiment');
    await section.locator('[data-action="cp-take"]').click();
    const row = section.locator('.cp-row', { hasText: 'Before the experiment' });
    await row.waitFor();
    const text = (await row.textContent()) ?? '';
    assert.match(text, /Named/);
    assert.match(text, /\d+(\.\d)? (KB|MB|bytes)/, 'its size, in units a person reads');
    assert.match(text, /Nova 0\.1\.0/);
    if (shots) await shoot(page, join(shots, 'checkpoints-list.png'));

    await m.send('POST', api('/memory'), { kind: 'fact', content: 'Added during the experiment.' });

    // Restore asks, every time: what it undoes, a checkpoint of now first, a required checkbox.
    await row.locator('[data-action="cp-restore"]').click();
    const ask = section.locator('.cp-confirm');
    await ask.locator('input[data-action="cp-restore-confirm"]').waitFor();
    const asked = (await ask.textContent()) ?? '';
    assert.match(asked, /Nova goes back to how it was on /);
    assert.match(asked, /Everything since then is undone: tasks, memories, settings and changes\./);
    assert.match(asked, /takes a checkpoint of now first/);
    assert.match(asked, /restarts by itself/);
    const go = ask.locator('[data-action="cp-restore-yes"]');
    assert.equal(await go.isDisabled(), true, 'not before the checkbox');
    assert.equal(await section.locator('.btn.primary').count(), 1, 'still one standout');
    assert.equal(await section.locator('.btn.primary').getAttribute('data-action'), 'cp-restore-yes', 'the restore stands out now');
    if (shots) await shoot(page, join(shots, 'checkpoints-restore-confirm.png'));
    await ask.locator('input[data-action="cp-restore-confirm"]').check();
    assert.equal(await go.isDisabled(), false);
    await go.click();

    // Nova restarts by itself; the page says so, then shows the list again.
    await section.locator('.cp-restoring').waitFor();
    await page.waitForFunction(() => !document.querySelector('#checkpoints .cp-restoring') && !!document.querySelector('#checkpoints .cp-row'), null, { timeout: 60_000 });
    assert.deepEqual(await until(memories, (x) => x.length === 1, 400), ['The plants get water on Sundays.']);
    await section.locator('.cp-row', { hasText: 'Before restoring to “Before the experiment”' }).waitFor();
    assert.match((await section.locator('.cp-row', { hasText: 'Before restoring' }).textContent()) ?? '', /Automatic/);

    // Deleting a named one asks first; automatic ones have no delete.
    assert.equal(await section.locator('.cp-row', { hasText: 'Before restoring' }).locator('[data-action="cp-delete"]').count(), 0);
    const mine = section.locator('.cp-row[data-kind="named"]', { hasText: 'Before the experiment' });
    await mine.locator('[data-action="cp-delete"]').click();
    await mine.locator('[data-action="cp-delete-yes"]').waitFor();
    assert.match((await mine.textContent()) ?? '', /can’t be undone/);
    await mine.locator('[data-action="cp-delete-yes"]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('#checkpoints .cp-row')].some((r) => r.getAttribute('data-kind') === 'named'));
    assert.deepEqual(errors.filter((e) => !/ERR_CONNECTION|Failed to load resource|EventSource/.test(e)), []);
  } finally {
    await stop(nova);
    await b.close();
  }
});
