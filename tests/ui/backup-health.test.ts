// With no backup to fall back on (F-019), Home doesn't say "All systems normal" and Health doesn't
// call backups fine: both say it plainly, in amber, never red. Once a backup is made they are
// normal again, and the folder backup is said to be unencrypted wherever it is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';

test('F-019: no backup is never "All systems normal"; a backup is, and it says it isn’t encrypted', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-backup-health-');
  const target = join(m.dir, 'backups');
  mkdirSync(target);
  const nova = await m.start();
  const api = (p: string) => `/api/v1${p}`;
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    const card = async () => {
      await page.goto(`${m.base}/`);
      await ready(page);
      const lead = page.locator('.health-card:visible .card-lead').first();
      await lead.waitFor({ timeout: 15_000 });
      return { tone: await lead.getAttribute('data-status'), text: (await page.locator('.health-card:visible').first().innerText()).replace(/\s+/g, ' ') };
    };
    const backupsRow = async () => {
      await page.goto(`${m.base}/health`);
      await ready(page);
      const row = page.locator('#health-view .settings-row', { has: page.locator('.settings-label', { hasText: /^Backups$/ }) });
      await row.waitFor({ timeout: 15_000 });
      return (await row.innerText()).replace(/\s+/g, ' ');
    };

    // No folder: amber, in words, never "All systems normal" and never red.
    let c = await card();
    assert.doesNotMatch(c.text, /All systems normal/);
    assert.equal(c.tone, 'needs-you', c.text);
    assert.match(c.text, /Backups: nothing is backed up: no backup folder is set/);
    assert.match(await backupsRow(), /No backup folder is set, so nothing is backed up\..*Needs a look/);

    // A folder, no backup yet: still not normal.
    assert.equal((await m.send('PUT', api('/backups/settings'), { target })).status, 200);
    c = await card();
    assert.equal(c.tone, 'needs-you', c.text);
    assert.match(c.text, /nothing is backed up yet/);

    // A backup: normal again, and the folder backup is named unencrypted.
    const id = (await m.send('POST', api('/backups'))).body.id;
    await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => x.state === 'done', 60_000);
    c = await card();
    assert.equal(c.tone, 'verified', c.text);
    assert.match(c.text, /All systems normal/);
    const row = await backupsRow();
    assert.match(row, /not encrypted.*Fine/);
    assert.match((await page.locator('[data-resilience]').innerText()).replace(/\s+/g, ' '), /\(not encrypted\)\. 1 kept .* No encrypted copy/);

    await page.goto(`${m.base}/settings`);
    await ready(page);
    await page.locator('#settings-nav a[data-cat="backups"]').click();
    await page.locator('#settings-backups input[name="target"]').waitFor({ timeout: 15_000 });
    assert.match(await page.locator('#settings-backups [id$="-target-help"]').first().innerText(), /^Not encrypted/);
    assert.match(await page.locator('#settings-backups [id$="-encrypted_target-help"]').first().innerText(), /^Encrypted/);
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await b.close();
  }
});
