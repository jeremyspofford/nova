// M10g in a real browser: on the hub's Settings › Devices, the standby (a hub candidate) has "Promote
// to hub"; the sheet says each pre-check first, and with no fresh backup refuses with the reason and
// no button. With a backup and a passed drill it offers the promotion at tier 3 (nothing happens
// until the box is ticked); the hub hands over, its own screen then says it is the standby, and the
// Devices page says when the promotion is verified. The full drill is tests/acceptance/m10g-drill.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stop, until, type Running } from '../acceptance/support.ts';
import { setup } from '../acceptance/m4c-support.ts';
import { browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M10g: “Promote to hub” on the hub’s Devices page: the pre-checks first, tier 3, then the hub hands over and says so', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const fast = { NOVA_PROMOTION_WINDOW_S: '4', NOVA_PROMOTION_PROBE_MS: '300' };
  let s: Awaited<ReturnType<typeof setup>>;
  try { s = await setup('nova-ui-m10g', () => {}, fast); } catch (e) { await b.close(); throw e; }
  let standbyProc: Running | null = null;
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm10g') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(s.hub);
    standbyProc = await s.standby.start({ ...s.env(s.standbyMesh), ...fast });
    await until(() => s.hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_at && h.checks.mesh.standby.lag.rows === 0, 400);

    const hub = await device(b, { width: 1280, height: 900 });
    await hub.page.goto(`${s.hub.base}/settings#devices`);
    await ready(hub.page);
    const row = hub.page.locator('#devices .device-row', { hasText: 'Standby' });
    await row.waitFor();
    await row.locator('[data-action="promote-device"]').click();
    let sheet = hub.page.locator('#sheet .approval-sheet[data-promotion]');
    await sheet.waitFor();
    assert.match((await sheet.textContent()) ?? '', /There is no backup\./);
    assert.equal(await sheet.locator('[data-action="approve"]').count(), 0, 'a refused pre-check offers no button');
    if (shots) await shoot(hub.page, join(shots, 'promote-refused.png'));
    await sheet.locator('[data-action="close-sheet"]').click();

    // A backup, and its restore drill.
    const folder = mkdtempSync(join(tmpdir(), 'nova-ui-m10g-backups-'));
    assert.equal((await s.hub.send('PUT', '/api/v1/backups/settings', { target: folder })).status, 200);
    for (const path of ['/api/v1/backups', '/api/v1/backups/drill']) {
      const r = await s.hub.send('POST', path, {});
      assert.equal(r.status, 202);
      const done = await until(() => s.hub.get(`/api/v1/tasks/${r.body.id}`), (x: any) => ['done', 'failed'].includes(x.state), 2400);
      assert.equal(done.state, 'done', done.reason);
    }
    await until(() => s.hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.rows === 0, 400);

    await row.locator('[data-action="promote-device"]').click();
    sheet = hub.page.locator('#sheet .approval-sheet[data-promotion]');
    await sheet.waitFor();
    const text = (await sheet.textContent()) ?? '';
    assert.match(text, /What happens/);
    assert.match(text, /A backup from .*, and its restore drill passed\./);
    const confirm = sheet.locator('[data-action="approve"]');
    assert.equal(await confirm.isDisabled(), true, 'tier 3: nothing happens until the box is ticked');
    if (shots) await shoot(hub.page, join(shots, 'promote-sheet.png'));
    await sheet.locator('input[name="confirm"]').check();
    await confirm.click();
    await hub.page.getByText(/Handing the hub over\./).first().waitFor();
    const banner = hub.page.locator('#banner');
    await banner.waitFor({ state: 'visible', timeout: 60_000 });
    assert.match((await banner.textContent()) ?? '', /^This is the standby; “Standby” at http:\/\/127\.0\.0\.1:\d+ is the hub\./);
    await until(() => s.standby.get('/api/v1/mesh/status'), (v: any) => v.role === 'hub' && v.epoch === 2, 400);
    await until(() => s.hub.get('/api/v1/mesh/promotion'), (v: any) => v.promotion?.state === 'verified', 1200);
    await hub.page.reload();
    await ready(hub.page);
    await hub.page.locator('#promotion-row').getByText(/passed every check for 4 seconds: the promotion is verified/).waitFor();
    if (shots) await shoot(hub.page, join(shots, 'promoted-devices.png'));
    assert.deepEqual(hub.errors.filter((e) => !/Failed to load resource/.test(e)), []);
  } finally {
    await stop(s.hubProc).catch(() => {});
    if (standbyProc) await stop(standbyProc);
    await b.close();
  }
});
