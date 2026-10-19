// J9.5 — Device firmware, boot and out-of-band (docs/17 §M7.5; T-M75-05; FR-143, FR-146,
// FR-147; ADR-096). A device joins through Add Device with the real novad build (as J8.5) and runs
// with novad's fake firmware and bootloader backends, so the Hub <-> novad protocol, the
// Hub-signed authorizations, the device-side policy and novad's watchdogs run for real.
//
// Exit criteria and demo: BIOS changes are impossible until "Allow BIOS/firmware changes" is on
// (the tab says why, the Hub refuses with `firmware_disabled`); turning it on needs the
// confirmation dialog (the settings routes refuse without it: `consent_required`) and is audited
// with before/after. The demo plans Wake-on-LAN on and power-on-after-power-loss "On": the diff
// shows both, the approval card is Hub-only, the owner allows it, applies it, the device's values
// change (in the UI and in novad's fake BIOS), the history shows before/after and the audit has
// `device.firmware.plan|approval|apply`. Rolling the snapshot back needs its own approval and
// restores the values. Secure Boot off is refused without the separate override, and the UI says
// why. A change applied with a restart whose machine never comes back is reverted by novad's
// watchdog and shows "Reverted by the watchdog". Boot: with low-level boot off a trial is refused;
// turned on (confirmation), a trial whose machine never comes back is reverted by the watchdog and
// the default entry is untouched. Out-of-band management is off by default (actions refused);
// turning it on needs consent; a Redfish BMC is added, its certificate pinned and confirmed, the
// power state read, a power cycle approved on its Hub-only card and run; the action log shows it.
// Every page visited passes the axe checks.
//
// How the outside world is played (see e2e/support/m75.ts and bmc-redirect.ts for the details):
// - The machine is novad's fake BIOS and bootloader files, restarts go to a fake `systemctl` that
//   only records them, and "the machine never came back" is played by stopping novad until its
//   watchdog deadline (2 minutes, the shortest the Hub offers) has passed, then starting it again:
//   novad then reverts with `reason: not_restarted` (the boot id cannot change in a container; the
//   Rust tests cover the restart with a new boot id).
// - The fake Redfish BMC (packages/core/test/fixtures/oob/fake-redfish.ts) listens on loopback,
//   which the Hub refuses as a BMC address (the journey shows the refusal); the owner gives it a
//   TEST-NET-1 address and a preload in the Hub process sends only the TCP connection for that
//   address to the fake.
// - A Hub-only card cannot be answered from a channel: no channel is set up here, so the journey
//   asserts what the card says and the `answerIn: 'hub'` the Hub returns; the channel refusals are
//   covered by packages/core/test/channels-hub-only.test.ts.
// - The journey never waits for a heartbeat before a privileged change: the Hub pushes a toggle to
//   the device when it changes and syncs it before each firmware apply and boot trial.
import { expect, test, type Page } from '@playwright/test';
import { startFakeRedfish, type FakeBmc } from '../packages/core/test/fixtures/oob/fake-redfish.ts';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { json, toast, until } from './support/m6.ts';
import {
  BMC_STAND_IN,
  addNovadDevice,
  auditExport,
  consentSwitch,
  openDeviceTab,
  openFirmwareBootSettings,
  setUpM75Hub,
  watchdogMarker,
  watchdogPending,
  type M75Hub,
  type NovadDevice,
} from './support/m75.ts';

const portFor = (parallelIndex: number) => 7661 + parallelIndex;
const HUB_ONLY =
  'Only you can answer this, in Nova: here or on the Approvals page. Chat channels, email links and agents cannot answer it.';

let hub: M75Hub | null = null;
let device: NovadDevice | null = null;
let bmc: FakeBmc | null = null;

test.use({ colorScheme: 'light' });
test.setTimeout(300_000);

test.afterEach(async () => {
  const testInfo = test.info();
  if (device && testInfo.status !== testInfo.expectedStatus)
    await testInfo.attach('novad.log', { body: device.logs(), contentType: 'text/plain' });
  await device?.stop();
  await hub?.stop();
  await bmc?.close();
  device = null;
  hub = null;
  bmc = null;
});

interface ApiError {
  status: number;
  code: string;
  reason: string | null;
}

/** A refused Hub call: its status, code and `details.reason`. */
async function refusal(res: Awaited<ReturnType<Page['request']['get']>>): Promise<ApiError> {
  const body = (await res.json()) as {
    error?: { code?: string; details?: { reason?: string } };
  };
  return {
    status: res.status(),
    code: body.error?.code ?? '',
    reason: body.error?.details?.reason ?? null,
  };
}

interface ChangeJson {
  id: string;
  kind: 'apply' | 'rollback';
  status: string;
  snapshotId: string | null;
  diff: { key: string; from: unknown; to: unknown; securityDegrading: boolean }[];
  approval: { id: string; status: string; decision: string | null } | null;
  watchdog: { state: string; deadline: string | null } | null;
}

async function history(page: Page, dev: NovadDevice): Promise<ChangeJson[]> {
  const h = await json<{ changes: ChangeJson[] }>(
    await page.request.get(`${hub!.lan}/api/v1/devices/${dev.id}/firmware/history`),
  );
  return h.changes;
}

/** A row of a table (the setting's header cell first), as its cells' text. */
async function rowCells(table: ReturnType<Page['getByRole']>, header: string): Promise<string[]> {
  const row = table
    .getByRole('row')
    .filter({ has: table.page().getByRole('rowheader', { name: header }) });
  await expect(row).toHaveCount(1);
  return row.getByRole('cell').allInnerTexts();
}

test('J9.5: firmware is off by default; with consent, the demo change is approved, applied, rolled back; the security override; the watchdog reverts', async ({
  page,
}, testInfo) => {
  hub = await setUpM75Hub(page, portFor(testInfo.parallelIndex));
  const { lan } = hub;
  const fw = (path = '') => `${lan}/api/v1/devices/${device!.id}/firmware${path}`;

  // 1. A device joins through Add Device and runs novad with the fake BIOS. Its Firmware tab
  //    shows the supported platform and the allowlisted settings; with the global toggle off
  //    (the default) the tab says changes are off and offers no plan; the Hub refuses too.
  device = await addNovadDevice(page, hub, 'desk-pc');
  const dev = device;
  let panel = await openDeviceTab(page, hub, dev, 'Firmware');
  await expect(panel.getByText('Supported', { exact: true })).toBeVisible({ timeout: 20_000 });
  const platform = panel.getByLabel('Platform');
  await expect(platform).toContainText('Nova Labs E2E Desk PC');
  await expect(platform).toContainText('Nova 1.0.4 (2026-09-01), UEFI');
  await expect(platform).toContainText('Test backend (no real firmware)');
  const settingsTable = panel.getByRole('table', {
    name: 'The settings Nova may change (an allowlist); it never touches others',
  });
  expect(await rowCells(settingsTable, 'Wake-on-LAN WakeOnLan')).toEqual(
    expect.arrayContaining(['Disabled']),
  );
  expect(await rowCells(settingsTable, 'After a power cut AcPowerRecovery')).toEqual(
    expect.arrayContaining(['Off']),
  );
  const off = panel.getByRole('note').filter({ hasText: 'BIOS and firmware changes are off.' });
  await expect(off).toBeVisible();
  await expect(off.getByRole('link', { name: 'Turn it on in Settings → Devices' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Plan the change' })).toHaveCount(0);
  await expectNoSeriousA11yIssues(page, 'device firmware tab: changes off');
  const offPlan = await refusal(
    await page.request.post(fw('/plan'), { data: { changes: [{ key: 'wol', value: 'Enabled' }] } }),
  );
  expect(offPlan).toEqual({ status: 403, code: 'firmware_disabled', reason: 'firmware_disabled' });
  const offApply = await refusal(
    await page.request.post(fw('/changes/01920000-0000-7000-8000-00000000abcd/apply'), {
      data: {},
    }),
  );
  expect(offApply.code).toBe('firmware_disabled');
  expect(dev.policy().firmwareChanges).toBe(false);

  // 2. Settings → Devices → Firmware and boot: the switch asks first; the routes refuse turning
  //    it on without the confirmation; the audit has the change with before and after.
  for (const res of [
    await page.request.put(`${lan}/api/v1/devices/firmware/policy`, {
      data: { allowChanges: true },
    }),
    await page.request.patch(`${lan}/api/v1/settings`, {
      data: { key: 'devices.firmware.allowChanges', value: true },
    }),
  ])
    expect(await refusal(res)).toEqual({
      status: 403,
      code: 'policy_denied',
      reason: 'consent_required',
    });
  const section = await openFirmwareBootSettings(page, hub);
  await expectNoSeriousA11yIssues(page, 'settings: firmware and boot');
  const allow = section.getByRole('switch', { name: 'Allow BIOS/firmware changes' });
  await allow.click();
  const consent = page.getByRole('dialog', { name: 'Allow BIOS and firmware changes on devices?' });
  await expect(consent).toContainText('needs your approval here in Nova, and can be rolled back');
  await consent.getByRole('button', { name: 'Cancel' }).click();
  await expect(allow).toHaveAttribute('aria-checked', 'false');
  await consentSwitch(
    page,
    section,
    'Allow BIOS/firmware changes',
    'Allow BIOS and firmware changes on devices?',
    'Allow firmware changes',
    'settings: allow firmware changes?',
  );
  await expect(
    section.getByRole('switch', { name: 'Allow changes that weaken security' }),
  ).toHaveAttribute('aria-checked', 'false');
  //    The firmware watchdog: the shortest window, 2 minutes (step 6 restarts with it).
  const fwWatchdog = section.getByRole('combobox', { name: 'Firmware watchdog' });
  await expect(fwWatchdog).toHaveValue('600');
  await fwWatchdog.selectOption({ label: '2 minutes' });
  await expect(fwWatchdog).toHaveValue('120');
  //    One audit entry for the change, with before, after and the confirmation.
  expect(
    (await auditExport(page, hub)).filter((l) => l.resource === 'devices.firmware.allowChanges'),
  ).toEqual([
    expect.objectContaining({
      kind: 'settings',
      action: 'setting.changed',
      actor: 'user',
      detail: expect.objectContaining({ before: false, after: true, confirmed: true }),
    }),
  ]);

  // 3. The demo: plan Wake-on-LAN on and power-on-after-power-loss "On"; the diff shows both.
  panel = await openDeviceTab(page, hub, dev, 'Firmware');
  await expect(panel.getByRole('note').filter({ hasText: 'changes are off' })).toHaveCount(0);
  const planForm = panel.getByRole('form', { name: 'Plan a change' });
  await planForm.getByRole('combobox', { name: 'Wake-on-LAN' }).selectOption('Enabled');
  await planForm.getByRole('combobox', { name: 'After a power cut' }).selectOption('On');
  await planForm.getByRole('button', { name: 'Plan the change' }).click();
  let current = panel.getByRole('region', { name: 'Current change' });
  const diff = current.getByRole('table', { name: 'What changes on desk-pc' });
  expect(await rowCells(diff, 'Wake-on-LAN')).toEqual(['Disabled', 'Enabled']);
  expect(await rowCells(diff, 'After a power cut')).toEqual(['Off', 'On']);
  await expect(diff.getByRole('row')).toHaveCount(3);
  await expect(current).toContainText('Planned');
  await expect(current).toContainText('Takes effect after the device restarts.');
  // A plan changes nothing on the machine.
  expect([dev.firmwareValue('wol'), dev.firmwareValue('powerOnAfterPowerLoss')]).toEqual([
    'Disabled',
    'Off',
  ]);
  await expectNoSeriousA11yIssues(page, 'device firmware tab: a planned change');

  //    Ask for approval: the card is Hub-only and says so; the Hub marks it `answerIn: 'hub'`.
  await current.getByRole('button', { name: 'Ask for approval' }).click();
  let card = current.getByRole('group', { name: 'Approve this firmware change on desk-pc' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(HUB_ONLY);
  const demo = (await history(page, dev))[0]!;
  expect(demo.status).toBe('awaiting_approval');
  const approval = await json<{ answerIn: string | null; status: string }>(
    await page.request.get(`${lan}/api/v1/approvals/${demo.approval!.id}`),
  );
  expect(approval).toMatchObject({ answerIn: 'hub', status: 'pending' });
  await expectNoSeriousA11yIssues(page, 'device firmware tab: the Hub-only approval card');
  //    The same card on the Approvals page.
  await card.getByRole('link', { name: 'Open in Approvals' }).click();
  const listed = page.locator(`[id="approval-${demo.approval!.id}"]`);
  await expect(listed).toBeVisible();
  await expect(listed).toContainText(HUB_ONLY);
  await expectNoSeriousA11yIssues(page, 'approvals: a firmware card');

  //    Allow it as the owner on the device's tab, then apply (without the restart).
  panel = await openDeviceTab(page, hub, dev, 'Firmware');
  current = panel.getByRole('region', { name: 'Current change' });
  card = current.getByRole('group', { name: 'Approve this firmware change on desk-pc' });
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(current.getByText('Approved. Nothing has changed yet')).toBeVisible();
  await current.getByRole('button', { name: 'Apply…' }).click();
  let apply = page.getByRole('dialog', { name: 'Apply this firmware change to desk-pc?' });
  await expect(apply.getByRole('list', { name: 'Changes to apply' })).toContainText(
    'Wake-on-LAN: Disabled → Enabled',
  );
  await expect(apply.getByRole('list', { name: 'Changes to apply' })).toContainText(
    'After a power cut: Off → On',
  );
  const restart = apply.getByRole('checkbox', { name: /Restart desk-pc now, with the watchdog/ });
  await expect(restart).toBeChecked();
  await expectNoSeriousA11yIssues(page, 'device firmware tab: apply a change');
  await restart.uncheck();
  await apply.getByRole('button', { name: 'Apply to desk-pc' }).click();
  await expect(toast(page, 'Applied to desk-pc.')).toBeVisible();

  //    The device's values changed: in the tab (read again from the device) and in its BIOS.
  expect([dev.firmwareValue('wol'), dev.firmwareValue('powerOnAfterPowerLoss')]).toEqual([
    'Enabled',
    'On',
  ]);
  await panel.getByRole('button', { name: 'Read again' }).click();
  await expect
    .poll(() => rowCells(settingsTable, 'Wake-on-LAN WakeOnLan'))
    .toEqual(expect.arrayContaining(['Enabled']));
  await expect
    .poll(() => rowCells(settingsTable, 'After a power cut AcPowerRecovery'))
    .toEqual(expect.arrayContaining(['On']));
  expect(dev.systemctlCalls()).toEqual([]);
  //    The history shows it with before and after.
  const changes = panel.getByRole('list', { name: 'Firmware changes' });
  const withChip = (text: string) =>
    changes.getByRole('article').filter({ has: page.getByText(text, { exact: true }) });
  const applied = withChip('Applied');
  await expect(applied).toBeVisible();
  const appliedDiff = applied.getByRole('table', { name: 'What changes on desk-pc' });
  expect(await rowCells(appliedDiff, 'Wake-on-LAN')).toEqual(['Disabled', 'Enabled']);
  expect(await rowCells(appliedDiff, 'After a power cut')).toEqual(['Off', 'On']);
  await expectNoSeriousA11yIssues(page, 'device firmware tab: the history');
  //    The audit has the plan, the approval and the apply, with before and after.
  const demoAudit = (await auditExport(page, hub)).filter(
    (l) => l.kind === 'device' && l.resource === dev.id,
  );
  for (const action of [
    'device.firmware.plan',
    'device.firmware.approval',
    'device.firmware.apply',
  ])
    expect(
      demoAudit.map((l) => l.action),
      action,
    ).toContain(action);
  const applyLine = demoAudit.find((l) => l.action === 'device.firmware.apply')!;
  expect(applyLine.detail).toMatchObject({
    before: { wol: 'Disabled', powerOnAfterPowerLoss: 'Off' },
    after: { wol: 'Enabled', powerOnAfterPowerLoss: 'On' },
    reboot: false,
  });
  //    Settings → Diagnostics → Audit log lists them, each change with before and after.
  await page.goto(`${lan}/settings/diagnostics`);
  const auditList = page.getByRole('list', { name: 'Audit entries' });
  for (const name of ['device: device.firmware.plan', 'device: device.firmware.approval'])
    await expect(auditList.getByRole('listitem', { name, exact: true }).first()).toBeVisible();
  const applyRow = auditList
    .getByRole('listitem', { name: 'device: device.firmware.apply', exact: true })
    .first();
  await expect(applyRow).toContainText(
    /\{"wol":"Disabled","powerOnAfterPowerLoss":"Off"\}.*changed to.*\{"wol":"Enabled","powerOnAfterPowerLoss":"On"\}/,
  );
  const toggleRow = auditList
    .getByRole('listitem')
    .filter({ hasText: 'On devices.firmware.allowChanges' });
  await expect(toggleRow).toHaveCount(1);
  await expect(toggleRow).toContainText(/off.*changed to\s*on/);
  await expect(toggleRow).toContainText('Confirmed');
  await expectNoSeriousA11yIssues(page, 'settings: diagnostics, the audit log');
  panel = await openDeviceTab(page, hub, dev, 'Firmware');

  // 4. Roll the snapshot back: its own approval, then the values are restored.
  await applied.getByRole('button', { name: /^Roll back the change applied/ }).click();
  const back = page.getByRole('dialog', { name: 'Roll back this firmware change on desk-pc?' });
  await expect(back.getByRole('list', { name: 'Settings to restore' })).toContainText(
    'Wake-on-LAN: back to Disabled',
  );
  await expectNoSeriousA11yIssues(page, 'device firmware tab: roll back?');
  await back.getByRole('button', { name: 'Plan the rollback' }).click();
  current = panel.getByRole('region', { name: 'Current change' });
  const restore = current.getByRole('table', { name: 'What the rollback restores on desk-pc' });
  expect(await rowCells(restore, 'Wake-on-LAN')).toEqual(['Enabled', 'Disabled']);
  expect(await rowCells(restore, 'After a power cut')).toEqual(['On', 'Off']);
  //    A rollback asks for its approval at once.
  card = current.getByRole('group', {
    name: 'Approve restoring the firmware settings of desk-pc',
  });
  await expect(card).toContainText(HUB_ONLY);
  const rollbackChange = (await history(page, dev))[0]!;
  expect(rollbackChange.kind).toBe('rollback');
  expect(rollbackChange.approval?.id).not.toBe(demo.approval!.id);
  await card.getByRole('button', { name: 'Allow once' }).click();
  await current.getByRole('button', { name: 'Apply the rollback…' }).click();
  apply = page.getByRole('dialog', { name: 'Roll back the firmware settings of desk-pc?' });
  await apply.getByRole('button', { name: 'Roll back desk-pc' }).click();
  await expect(toast(page, 'Rolled back on desk-pc.')).toBeVisible();
  expect([dev.firmwareValue('wol'), dev.firmwareValue('powerOnAfterPowerLoss')]).toEqual([
    'Disabled',
    'Off',
  ]);
  await expect(withChip('Rolled back')).toHaveCount(1);
  await expect(withChip('Applied')).toHaveCount(1);
  await expect(withChip('Applied')).toContainText('Rollback applied');
  const rollbackAudit = (await auditExport(page, hub)).find(
    (l) => l.action === 'device.firmware.rollback' && l.resource === dev.id && l.result === 'ok',
  );
  expect(rollbackAudit?.detail).toMatchObject({
    before: { wol: 'Enabled', powerOnAfterPowerLoss: 'On' },
    after: { wol: 'Disabled', powerOnAfterPowerLoss: 'Off' },
  });

  // 5. Secure Boot off weakens security: refused without the separate override, and said why.
  const plan2 = panel.getByRole('form', { name: 'Plan a change' });
  await plan2
    .getByRole('combobox', { name: 'Secure Boot' })
    .selectOption({ label: 'Disabled (weakens security)' });
  await expect(plan2.getByRole('note')).toContainText(
    'This weakens security: Secure Boot Disabled.',
  );
  await plan2.getByRole('button', { name: 'Plan the change' }).click();
  current = panel.getByRole('region', { name: 'Current change' });
  await expect(current.getByRole('table', { name: 'What changes on desk-pc' })).toContainText(
    'Weakens security',
  );
  await expect(current).toContainText(
    'This change weakens security, and “Allow changes that weaken security” is off.',
  );
  await current.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(current.getByRole('alert')).toContainText(
    'This change weakens security (Secure Boot), and changes like that are off.',
  );
  await expectNoSeriousA11yIssues(page, 'device firmware tab: a change that weakens security');
  const degrading = (await history(page, dev))[0]!;
  expect(degrading.diff).toEqual([
    expect.objectContaining({ key: 'secureBoot', to: 'Disabled', securityDegrading: true }),
  ]);
  expect(
    await refusal(
      await page.request.post(fw(`/changes/${degrading.id}/request-approval`), { data: {} }),
    ),
  ).toEqual({ status: 403, code: 'policy_denied', reason: 'security_degrading' });
  expect(dev.firmwareValue('secureBoot')).toBe('Enabled');

  // 6. The watchdog: Wake-on-LAN on with the restart. novad asks its power module to restart;
  //    the machine never comes back before the deadline (novad stopped, the deadline passes);
  //    when novad starts again its watchdog restores the snapshot and reports it.
  const plan3 = panel.getByRole('form', { name: 'Plan a change' });
  await plan3.getByRole('combobox', { name: 'Wake-on-LAN' }).selectOption('Enabled');
  await plan3.getByRole('button', { name: 'Plan the change' }).click();
  current = panel.getByRole('region', { name: 'Current change' });
  await expect(current.getByRole('table', { name: 'What changes on desk-pc' })).not.toContainText(
    'Secure Boot',
  );
  await current.getByRole('button', { name: 'Ask for approval' }).click();
  await current
    .getByRole('group', { name: 'Approve this firmware change on desk-pc' })
    .getByRole('button', { name: 'Allow once' })
    .click();
  await current.getByRole('button', { name: 'Apply…' }).click();
  apply = page.getByRole('dialog', { name: 'Apply this firmware change to desk-pc?' });
  await expect(
    apply.getByRole('checkbox', { name: /Restart desk-pc now, with the watchdog/ }),
  ).toBeChecked();
  await expect(apply).toContainText(
    'If desk-pc does not come back within 2 minutes, it restores the previous settings and restarts once.',
  );
  const appliedAt = Date.now();
  await apply.getByRole('button', { name: 'Apply to desk-pc' }).click();
  await expect(
    toast(page, 'Applied. desk-pc is restarting with the watchdog armed.'),
  ).toBeVisible();
  const guarded = changes
    .getByRole('article')
    .filter({ hasText: 'Restarting with the watchdog armed' });
  await expect(guarded).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'device firmware tab: the watchdog armed');
  expect(dev.firmwareValue('wol')).toBe('Enabled');
  await until('novad asks its power module to restart', () =>
    Promise.resolve(dev.systemctlCalls().includes('reboot')),
  );
  //    The device armed the 2-minute window the Hub sent (devices.firmware.watchdogSeconds), and
  //    the Hub shows the device's deadline.
  const marker = watchdogMarker(dev, 'firmware');
  expect(marker.deadlineMs - appliedAt).toBeGreaterThan(110_000);
  expect(marker.deadlineMs - appliedAt).toBeLessThanOrEqual(125_000);
  const armed = (await history(page, dev)).find((c) => c.watchdog?.state === 'pending')!;
  expect(Date.parse(armed.watchdog!.deadline!)).toBe(marker.deadlineMs);
  //    The machine goes down and is not back by the deadline: nothing reaches the Hub from it.
  await dev.stop();
  await until(
    'the watchdog deadline passes',
    () => Promise.resolve(Date.now() > marker.deadlineMs + 1_000),
    150_000,
  );
  dev.start();
  const reverted = withChip('Reverted by the watchdog');
  await expect(reverted).toBeVisible({ timeout: 45_000 });
  await expect(reverted).toContainText(
    'The device did not restart before the deadline: its watchdog restored the previous settings without a restart.',
  );
  expect(dev.firmwareValue('wol')).toBe('Disabled');
  expect(watchdogPending(dev, 'firmware')).toBe(false);
  await expect
    .poll(async () => rowCells(settingsTable, 'Wake-on-LAN WakeOnLan'), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(['Disabled']));
  await expectNoSeriousA11yIssues(page, 'device firmware tab: reverted by the watchdog');
  //    The owner is told what happened, in words that follow novad's reason.
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const bell = page.getByRole('dialog', { name: 'Notifications' });
  await expect(bell.getByRole('listitem', { name: 'Firmware change reverted' })).toContainText(
    'desk-pc did not restart before the watchdog deadline, so the watchdog restored the previous settings without a restart.',
  );
  await expectNoSeriousA11yIssues(page, 'notifications: the firmware watchdog notice');
  await page.keyboard.press('Escape');
  const watchdogAudit = (await auditExport(page, hub)).find(
    (l) => l.action === 'device.firmware.watchdog' && l.resource === dev.id,
  );
  expect(watchdogAudit).toMatchObject({
    actor: 'system',
    result: 'reverted',
    detail: expect.objectContaining({
      reason: 'not_restarted',
      before: { wol: 'Enabled' },
      after: { wol: 'Disabled' },
    }),
  });
});

test('J9.5: low-level boot is off by default; with consent, a trial whose machine never comes back is reverted by the watchdog', async ({
  page,
}, testInfo) => {
  hub = await setUpM75Hub(page, portFor(testInfo.parallelIndex));
  const { lan } = hub;
  device = await addNovadDevice(page, hub, 'lab-pc');
  const dev = device;

  // 7. The Boot tab: the device's entries; with low-level boot off (the default) the tab says so
  //    and a trial is refused, in the tab and by the Hub.
  let panel = await openDeviceTab(page, hub, dev, 'Boot');
  const entries = panel.getByRole('table', { name: 'Entries the device lists' });
  await expect(entries).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByLabel('Bootloader')).toContainText('Test bootloader (fake)');
  expect(await rowCells(entries, 'Nova Linux 6.8')).toEqual([
    'nova-6.8.conf',
    'Default, Booted now',
  ]);
  expect(await rowCells(entries, 'Nova Linux 6.12 (test kernel)')).toEqual([
    'nova-6.12-rc.conf',
    '',
  ]);
  await expect(
    panel.getByRole('note').filter({ hasText: 'Low-level boot changes are off.' }),
  ).toBeVisible();
  //    A profile for the test kernel's entry (creating one changes nothing on the device).
  const form = panel.getByRole('form', { name: 'New boot profile' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Test kernel');
  await form
    .getByRole('combobox', { name: 'Entry' })
    .selectOption({ label: 'Nova Linux 6.12 (test kernel)' });
  await form.getByRole('button', { name: 'Create profile' }).click();
  const profiles = panel.getByRole('list', { name: 'Boot profiles' });
  await expect(profiles.getByRole('listitem')).toContainText('Test kernel');
  const tryIt = profiles.getByRole('button', { name: 'Try Test kernel on next boot' });
  await expect(tryIt).toBeDisabled();
  await expect(panel.getByText('Needs low-level boot changes on.')).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'device boot tab: low-level boot off');
  const { profiles: made } = await json<{ profiles: { id: string; name: string }[] }>(
    await page.request.get(`${lan}/api/v1/devices/${dev.id}/boot`),
  );
  const profileId = made.find((p) => p.name === 'Test kernel')!.id;
  expect(
    await refusal(
      await page.request.post(`${lan}/api/v1/devices/${dev.id}/boot/profiles/${profileId}/try`, {
        data: { reboot: true },
      }),
    ),
  ).toEqual({ status: 403, code: 'policy_denied', reason: 'low_level_boot_off' });
  expect(dev.bootloader().oneshot).toBeNull();

  //    Turning it on asks first; the settings route refuses it without the confirmation.
  expect(
    await refusal(
      await page.request.patch(`${lan}/api/v1/settings`, {
        data: { key: 'devices.boot.allowLowLevel', value: true },
      }),
    ),
  ).toEqual({ status: 403, code: 'policy_denied', reason: 'consent_required' });
  const section = await openFirmwareBootSettings(page, hub);
  await consentSwitch(
    page,
    section,
    'Allow low-level boot changes',
    'Allow low-level boot changes on devices?',
    'Allow boot changes',
    'settings: allow low-level boot changes?',
  );
  expect(
    (await auditExport(page, hub)).filter((l) => l.resource === 'devices.boot.allowLowLevel'),
  ).toEqual([
    expect.objectContaining({
      kind: 'settings',
      action: 'setting.changed',
      actor: 'user',
      detail: expect.objectContaining({ before: false, after: true, confirmed: true }),
    }),
  ]);

  //    Try the profile with the shortest watchdog and a restart: approval first (Hub-only).
  panel = await openDeviceTab(page, hub, dev, 'Boot');
  await expect(
    panel.getByRole('note').filter({ hasText: 'Low-level boot changes are off.' }),
  ).toHaveCount(0);
  await panel.getByRole('button', { name: 'Try Test kernel on next boot' }).click();
  const ask = page.getByRole('dialog', { name: 'Try “Test kernel” on lab-pc?' });
  await ask.getByRole('combobox', { name: 'Watchdog' }).selectOption({ label: '2 minutes' });
  await expect(
    ask.getByRole('checkbox', { name: /Restart lab-pc as soon as you approve/ }),
  ).toBeChecked();
  await expectNoSeriousA11yIssues(page, 'device boot tab: try a profile?');
  await ask.getByRole('button', { name: 'Ask for approval' }).click();
  const requests = panel.getByRole('list', { name: 'Boot requests' });
  const card = requests.getByRole('group', {
    name: 'Approve booting lab-pc once into “Nova Linux 6.12 (test kernel)”',
  });
  await expect(card).toContainText(HUB_ONLY);
  expect(
    await rowCells(card.getByRole('table', { name: 'What changes on lab-pc' }), 'Next boot'),
  ).toEqual(['Nova Linux 6.8', 'Nova Linux 6.12 (test kernel), once']);
  expect(dev.bootloader().oneshot).toBeNull();
  await expectNoSeriousA11yIssues(page, 'device boot tab: the Hub-only approval card');
  await card.getByRole('button', { name: 'Allow once' }).click();

  //    Approved, it is sent at once: the device boots the entry once (a one-shot) and restarts.
  const pendingTrial = panel.getByRole('region', { name: 'Pending trial' });
  await expect(pendingTrial).toContainText('lab-pc boots “Nova Linux 6.12 (test kernel)” once');
  await until('the one-shot is set on the device', () =>
    Promise.resolve(dev.bootloader().oneshot === 'nova-6.12-rc.conf'),
  );
  expect(dev.bootloader().default).toBe('nova-6.8.conf');
  await until('novad asks its power module to restart', () =>
    Promise.resolve(dev.systemctlCalls().includes('reboot')),
  );
  const trials = panel.getByRole('list', { name: 'Boot trials' });
  await expect(trials.getByRole('listitem')).toContainText('Trying');
  await expect(trials.getByRole('listitem')).toContainText('watchdog 2 minutes, restarted at once');
  await expectNoSeriousA11yIssues(page, 'device boot tab: a pending trial');

  //    The entry "fails to come up": nothing is heard from the machine by the deadline. When it
  //    is back (on its default entry), novad's watchdog clears the one-shot and reports it.
  //    Its watchdog runs for the 2 minutes asked for.
  const bootMarker = watchdogMarker(dev, 'boot');
  expect(bootMarker.entryId).toBe('nova-6.12-rc.conf');
  const { attempts } = await json<{
    attempts: { id: string; deadline: string | null; watchdogSeconds: number }[];
  }>(await page.request.get(`${lan}/api/v1/devices/${dev.id}/boot`));
  expect(attempts[0]!.watchdogSeconds).toBe(120);
  expect(Math.abs(bootMarker.deadlineMs - Date.parse(attempts[0]!.deadline!))).toBeLessThan(5_000);
  await dev.stop();
  await until(
    'the boot watchdog deadline passes',
    () => Promise.resolve(Date.now() > bootMarker.deadlineMs + 1_000),
    150_000,
  );
  dev.start();
  const trial = trials.getByRole('listitem').filter({ hasText: 'Test kernel' });
  await expect(trial).toContainText('Back on the default', { timeout: 45_000 });
  //    What novad reported: the machine never restarted into the entry before the deadline.
  const ended = await json<{ attempts: { status: string; reason: string; detail: string }[] }>(
    await page.request.get(`${lan}/api/v1/devices/${dev.id}/boot`),
  );
  expect(ended.attempts[0]).toMatchObject({
    status: 'reverted',
    reason: 'reverted_by_device',
    detail: 'not_restarted',
  });
  expect(dev.bootloader()).toMatchObject({ default: 'nova-6.8.conf', oneshot: null });
  expect(watchdogPending(dev, 'boot')).toBe(false);
  await expect(pendingTrial).toHaveCount(0);
  await panel.getByRole('button', { name: 'Read again' }).click();
  await expect(panel).toContainText(
    'Last trial: Test kernel on “Nova Linux 6.12 (test kernel)”: returned to its default entry',
  );
  expect(await rowCells(entries, 'Nova Linux 6.8')).toEqual([
    'nova-6.8.conf',
    'Default, Booted now',
  ]);
  await expect(trial.getByRole('button', { name: 'Make default…' })).toHaveCount(0);
  await expectNoSeriousA11yIssues(page, 'device boot tab: reverted by the watchdog');
  const bootAudit = (await auditExport(page, hub)).filter(
    (l) => l.kind === 'device' && l.resource === dev.id && l.action.startsWith('device.boot.'),
  );
  expect(bootAudit.map((l) => l.action)).toEqual(
    expect.arrayContaining(['device.boot.request', 'device.boot.set', 'device.boot.watchdog']),
  );
});

test('J9.5: out-of-band management is off by default; with consent, a pinned Redfish BMC is power cycled after a Hub-only approval', async ({
  page,
}, testInfo) => {
  bmc = await startFakeRedfish();
  const fake = bmc;
  hub = await setUpM75Hub(page, portFor(testInfo.parallelIndex));
  const { lan } = hub;

  // 8. Devices: out-of-band management is off by default; its page says so and nothing reaches a
  //    BMC; the Hub refuses its actions, and turning it on without consent.
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('link', { name: 'Devices', exact: true })
    .click();
  const entry = page.getByRole('region', { name: 'Out-of-band management' });
  await expect(entry).toContainText('Off.');
  await expectNoSeriousA11yIssues(page, 'devices: the out-of-band entry');
  await entry.getByRole('link', { name: 'Open out-of-band management' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Out-of-band management' }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Off by default: a BMC controls the hardware below the operating system/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a BMC' })).toBeDisabled();
  await expectNoSeriousA11yIssues(page, 'out-of-band management: off');
  const endpointBody = {
    name: 'Rack BMC',
    kind: 'redfish',
    address: BMC_STAND_IN,
    port: fake.port,
    credentials: { username: fake.state.username, password: fake.state.password },
  };
  expect(
    await refusal(await page.request.post(`${lan}/api/v1/oob/endpoints`, { data: endpointBody })),
  ).toEqual({ status: 403, code: 'oob_disabled', reason: 'oob_disabled' });
  for (const res of [
    await page.request.post(`${lan}/api/v1/oob/enable`, { data: {} }),
    await page.request.patch(`${lan}/api/v1/settings`, {
      data: { key: 'devices.oob.enabled', value: true, confirm: true },
    }),
  ])
    expect(await refusal(res)).toEqual({
      status: 403,
      code: 'policy_denied',
      reason: 'consent_required',
    });
  expect(fake.requests).toEqual([]);

  //    Turn it on: the consent dialog says what it allows.
  await page.getByRole('button', { name: 'Turn on…' }).click();
  const consent = page.getByRole('dialog', { name: 'Turn on out-of-band management?' });
  await expect(consent).toContainText('Every change waits for your approval in Nova');
  await expectNoSeriousA11yIssues(page, 'out-of-band management: consent');
  await consent.getByRole('button', { name: 'Turn on out-of-band management' }).click();
  await expect(toast(page, 'Out-of-band management is on.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a BMC' })).toBeEnabled();

  //    Add the fake Redfish BMC. Its loopback address is refused (a BMC is another machine); the
  //    owner enters its network address.
  await page.getByRole('button', { name: 'Add a BMC' }).click();
  const add = page.getByRole('dialog', { name: 'Add a BMC' });
  await add.getByRole('textbox', { name: 'Name', exact: true }).fill('Rack BMC');
  await expect(add.getByRole('radio', { name: /^Redfish/ })).toBeChecked();
  await add.getByRole('textbox', { name: 'Address', exact: true }).fill('127.0.0.1');
  await add.getByRole('textbox', { name: 'Port', exact: true }).fill(String(fake.port));
  await add.getByRole('textbox', { name: 'User name' }).fill(fake.state.username);
  await add.getByLabel('Password', { exact: true }).fill(fake.state.password);
  await expectNoSeriousA11yIssues(page, 'out-of-band management: add a BMC');
  await add.getByRole('button', { name: 'Add BMC' }).click();
  await expect(add.getByRole('alert')).toContainText('Enter the BMC’s own address on the network.');
  await add.getByRole('textbox', { name: 'Address', exact: true }).fill(BMC_STAND_IN);
  await add.getByRole('button', { name: 'Add BMC' }).click();
  await expect(toast(page, 'Rack BMC added.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Rack BMC' })).toBeVisible();
  await expect(page).toHaveURL(/\/devices\/oob\/[^/?#]+$/);
  const endpointId = /\/devices\/oob\/([^/?#]+)$/.exec(page.url())![1]!;
  await expect(page.getByText(`${BMC_STAND_IN}:${fake.port}`)).toBeVisible();
  expect(fake.requests).toEqual([]);

  //    The first check reads the certificate without credentials; the owner compares and
  //    confirms its fingerprint; only then may the Hub send the credentials.
  await page.getByRole('button', { name: 'Check the connection' }).click();
  const confirmNote = page
    .getByRole('status')
    .filter({ hasText: 'Is this your BMC’s certificate?' });
  await expect(confirmNote).toBeVisible();
  const shown = (await confirmNote.locator('code').textContent())!.replace(/:/g, '').toLowerCase();
  expect(shown).toBe(fake.pin);
  expect(fake.requests.filter((r) => r.sentCredentials)).toEqual([]);
  await expect(page.getByText(/Power cycle…/)).toBeDisabled();
  await expectNoSeriousA11yIssues(page, 'out-of-band BMC: confirm its certificate');
  await confirmNote.getByRole('button', { name: 'Yes, it is my BMC’s…' }).click();
  const confirmPin = page.getByRole('dialog', { name: 'Is this the certificate of Rack BMC?' });
  await confirmPin.getByRole('button', { name: 'Confirm the fingerprint' }).click();
  await expect(
    toast(page, 'Certificate confirmed. The Hub may now send the BMC its credentials.'),
  ).toBeVisible();
  await expect(page.getByText(/^Confirmed/)).toBeVisible();

  //    Read the power state: a read runs at once, with no approval.
  await page.getByRole('button', { name: 'Read the power state' }).click();
  await expect(page.getByRole('region', { name: 'Power', exact: true })).toContainText('Power: On');
  const log = page.getByRole('list', { name: 'Action log' });
  const statusRow = log.getByRole('listitem', { name: 'Power status' });
  await expect(statusRow).toContainText('Done');
  await expect(statusRow).toContainText('A read: no approval needed');
  await expect(statusRow).toContainText('Power: on.');
  expect(fake.requests.some((r) => r.sentCredentials && r.authorized)).toBe(true);

  //    Power cycle: it says what it does, then waits for its Hub-only approval card.
  await page.getByRole('button', { name: 'Power cycle…' }).click();
  const cycle = page.getByRole('dialog', { name: 'Power cycle Rack BMC?' });
  await expect(cycle).toContainText('The BMC turns the machine off and on again at once.');
  await expectNoSeriousA11yIssues(page, 'out-of-band BMC: power cycle?');
  await cycle.getByRole('button', { name: 'Ask to power cycle' }).click();
  const waiting = page.getByRole('list', { name: 'Waiting for you' });
  const card = waiting.getByRole('group', { name: /Approval needed/ });
  await expect(card).toContainText(HUB_ONLY);
  const resets = () =>
    fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('ComputerSystem.Reset'));
  expect(resets()).toEqual([]);
  const { items: asked } = await json<{
    items: { id: string; action: string; status: string; approvalId: string | null }[];
  }>(await page.request.get(`${lan}/api/v1/oob/actions?endpointId=${endpointId}`));
  const pendingCycle = asked.find((a) => a.action === 'power.cycle')!;
  expect(pendingCycle.status).toBe('awaiting_approval');
  expect(
    await json<{ answerIn: string | null }>(
      await page.request.get(`${lan}/api/v1/approvals/${pendingCycle.approvalId}`),
    ),
  ).toMatchObject({ answerIn: 'hub' });
  await expectNoSeriousA11yIssues(page, 'out-of-band BMC: the Hub-only approval card');
  await card
    .getByRole('group', { name: 'Decision' })
    .getByRole('button', { name: 'Allow once' })
    .click();

  //    Allowed by the owner, it runs: the BMC got exactly one PowerCycle, and the log shows it.
  const cycleRow = log.getByRole('listitem', { name: 'Power cycle' });
  await expect(cycleRow).toContainText('Done', { timeout: 20_000 });
  await expect(cycleRow).toContainText('With your approval');
  expect(resets().map((r) => [r.authorized, r.body])).toEqual([
    [true, { ResetType: 'PowerCycle' }],
  ]);
  await expect(waiting).toHaveCount(0);
  await expectNoSeriousA11yIssues(page, 'out-of-band BMC: the action log');
  const lines = await auditExport(page, hub);
  //    Turning it on: one settings entry with the consent; the refused attempt is audited too.
  expect(lines.filter((l) => l.resource === 'devices.oob.enabled')).toEqual([
    expect.objectContaining({
      kind: 'settings',
      action: 'setting.changed',
      actor: 'user',
      detail: expect.objectContaining({ before: false, after: true, confirmed: true }),
    }),
  ]);
  const oobAudit = lines.filter((l) => l.action.startsWith('device.oob.'));
  expect(oobAudit.map((l) => l.action)).toEqual(
    expect.arrayContaining([
      'device.oob.refuse',
      'device.oob.endpoint.create',
      'device.oob.pin',
      'device.oob.power.status',
      'device.oob.power.cycle',
    ]),
  );
  expect(
    oobAudit.filter((l) => l.action === 'device.oob.power.cycle').map((l) => l.decision),
  ).toEqual(expect.arrayContaining(['requested', 'done']));
});
