// M4c in a real browser: the standby's own screen says it is the standby and which node is hub,
// on every page, and offers "Make this the hub" (tier 3); the hub's Health shows the standby and
// how far behind it is; the registry shows roles. Then the hub is killed and the standby is made
// hub from its screen, with the confirm box. The full M4 gate is tests/ui/m4-mesh.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stop, until, type Running } from '../acceptance/support.ts';
import { kill, setup } from '../acceptance/m4c-support.ts';
import { browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M4c: the standby says what it is, the hub shows its lag, and the standby is made hub from its own screen', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  let s: Awaited<ReturnType<typeof setup>>;
  try { s = await setup('nova-ui-m4c'); } catch (e) { await b.close(); throw e; }
  let hubProc: Running | null = s.hubProc;
  let standbyProc: Running | null = null;
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm4') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(s.hub);
    standbyProc = await s.standby.start(s.env(s.standbyMesh));
    await until(() => s.standby.get('/api/v1/setup'), (v: any) => v?.done === true, 400);
    await until(() => s.hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_at && h.checks.mesh.standby.lag.rows === 0, 400);

    // The hub's Health: the standby, caught up.
    const hub = await device(b, { width: 1280, height: 900 });
    await hub.page.goto(`${s.hub.base}/health`);
    await ready(hub.page);
    await hub.page.getByText(/The standby “Standby” is caught up\./).waitFor();
    if (shots) await shoot(hub.page, join(shots, 'hub-health-standby.png'));

    // The standby's screen: the banner on every page, the action, roles in the registry.
    const sb = await device(b, { width: 1280, height: 900 });
    await sb.page.goto(`${s.standby.base}/settings#devices`);
    await ready(sb.page);
    const banner = sb.page.locator('#banner');
    await banner.waitFor({ state: 'visible' });
    assert.match((await banner.textContent()) ?? '', /^This is the standby; “Hub” at http:\/\/127\.0\.0\.1:\d+ is the hub\./);
    const section = sb.page.locator('#devices');
    // The registry's own rows (they carry an id), not the placeholder shown before it answers.
    await section.locator('.device-row[data-device]').first().waitFor();
    const registry = (await section.textContent()) ?? '';
    assert.match(registry, /The hub/);
    assert.match(registry, /Standby\s*· this device\s*The standby/);
    assert.equal(await section.locator('[data-action="add-device"], [data-action="revoke-device"]').count(), 0, 'devices are added and revoked on the hub');
    if (shots) await shoot(sb.page, join(shots, 'standby-banner-devices.png'));
    await sb.page.goto(`${s.standby.base}/health`);
    await ready(sb.page);
    await sb.page.getByText(/Last copied/).waitFor();
    assert.ok(await banner.isVisible(), 'the banner is on every page');

    // The hub dies; the standby is made hub from its own screen, tier 3.
    await kill(hubProc);
    hubProc = null;
    await banner.locator('[data-action="promote"]').click();
    const sheet = sb.page.locator('#sheet .approval-sheet[data-promote]');
    await sheet.waitFor();
    const confirm = sheet.locator('[data-action="approve"]');
    assert.equal(await confirm.isDisabled(), true, 'tier 3: nothing happens until the box is ticked');
    if (shots) await shoot(sb.page, join(shots, 'standby-promote-sheet.png'));
    await sheet.locator('input[name="confirm"]').check();
    await confirm.click();
    await sb.page.getByText(/This node is the hub now \(epoch 2\)\./).first().waitFor();
    await banner.waitFor({ state: 'hidden' });
    await sb.page.getByText(/This is the hub \(epoch 2\)\./).waitFor();
    if (shots) await shoot(sb.page, join(shots, 'promoted-health.png'));
    assert.deepEqual(sb.errors.filter((e) => !/Failed to load resource/.test(e)), []);
  } finally {
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
    await b.close();
  }
});
