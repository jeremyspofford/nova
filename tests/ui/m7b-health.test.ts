// Health › Keeping Nova running (M7b) in a real browser, against the real server: the supervisor
// (here: not running under it, said plainly), backups and the last restore drill as calm facts,
// and an open problem with its playbook: what Nova already did, the person's steps, and a repair
// they can run. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M7b: Health shows the supervisor, backups and the last drill, and a problem’s playbook with a repair that works', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m7b-');
  const target = join(m.dir, 'backups');
  mkdirSync(target);
  const nova = await m.start();
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm7') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const api = (p: string) => `/api/v1${p}`;
  const settled = (id: string) => until<any>(() => m.get(api(`/tasks/${id}`)), (x) => ['done', 'failed'].includes(x.state), 60_000);
  try {
    await finishSetup(m);
    assert.equal((await m.send('PUT', api('/backups/settings'), { target })).status, 200);
    assert.equal((await settled((await m.send('POST', api('/backups'))).body.id)).state, 'done');
    assert.equal((await settled((await m.send('POST', api('/backups/drill'))).body.id)).state, 'done');
    // The drive is unplugged: the next backup fails into its playbook.
    rmSync(target, { recursive: true });
    assert.equal((await settled((await m.send('POST', api('/backups'))).body.id)).state, 'failed');

    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/health`);
    await ready(page);
    const facts = page.locator('[data-resilience]');
    await facts.waitFor();
    const words = (await facts.textContent()) ?? '';
    assert.match(words, /Not running under the supervisor/);
    assert.match(words, /The backup folder .*backups isn’t there .* Last backup /);
    assert.match(words, /Passed .*: \d+ of \d+ checks/);
    assert.equal(await page.locator('[data-action="backup-now"]').count(), 1);
    // How to restore a backup (F-018): Health links to the command's document, which Nova serves.
    const doc = page.locator('[data-resilience] a[data-restore-doc]');
    assert.equal(await doc.getAttribute('href'), '/docs/restore');
    const served = await page.request.get(`${m.base}/docs/restore`);
    assert.equal(served.status(), 200);
    assert.match(await served.text(), /node scripts\/restore-backup\.js/);

    const pb = page.locator('.playbook[data-playbook="backup-target-missing"]');
    await pb.waitFor();
    assert.match((await pb.textContent()) ?? '', /What Nova did/);
    assert.match((await pb.textContent()) ?? '', /still isn’t there/);
    assert.match((await pb.textContent()) ?? '', /Plug in or mount the drive/);
    if (shots) { await pb.scrollIntoViewIfNeeded(); await shoot(page, join(shots, 'health-playbook.png')); }

    // The drive is back; the person runs the repair: a backup is made. The repair's own word no
    // longer closes the problem (owner's order, 2026-11-11: a repair may not close its own problem;
    // closure requires a verification independent of the repair action). Health says it is
    // repaired and being checked, and the problem closes at the next heartbeat (every 30 s), once
    // the check reads the new backup back from its folder.
    const problemId = (await m.get(api('/problems'))).find((x: any) => !x.resolved_at && /isn’t there/.test(x.message)).id;
    mkdirSync(target);
    await pb.locator('[data-action="repair-problem"]').click();
    const checking = page.locator('.playbook[data-playbook="backup-target-missing"]', { hasText: 'Repaired, checking: this closes when Nova reads a backup made since back from its folder.' });
    // Unless the heartbeat's check happened to run in between, Health shows it as being checked.
    await Promise.race([checking.waitFor({ timeout: 15_000 }), page.locator('.playbook[data-playbook="backup-target-missing"]').waitFor({ state: 'detached', timeout: 15_000 })]);
    await page.locator('.playbook[data-playbook="backup-target-missing"]').waitFor({ state: 'detached', timeout: 75_000 });
    // Closed by the check, not the repair: the repair is marked as having held, and the check's
    // words are the last thing recorded.
    const done = await m.get(api(`/problems/${problemId}/playbook`));
    const repair = done.repairs.find((x: any) => x.name === 'retry-backup' && x.ok);
    assert.equal(repair.verified, true, JSON.stringify(done.repairs));
    assert.equal(done.repairs.at(-1).name, 'watch');
    assert.match(done.repairs.at(-1).said, /read nova-backup-\d+ back from the backup folder/);
    // The folder came back empty (the old backup went with it): the repair's backup is the one kept.
    await page.locator('[data-resilience]', { hasText: '1 kept' }).waitFor({ timeout: 15_000 });
    assert.equal((await m.get(api('/resilience'))).backups.count, 1);
    if (shots) { await facts.scrollIntoViewIfNeeded(); await shoot(page, join(shots, 'health-keeping-running.png')); }
    assert.deepEqual(errors, []);
  } finally {
    await stop(nova);
    await b.close();
  }
});
