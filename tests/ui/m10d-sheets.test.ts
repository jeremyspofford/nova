// Infrastructure and networking through chat (M10d), in Chromium against the real server: the apply
// sheet shows OpenTofu's plan in full, each change with its monthly price and where the month would
// stand against the budget, and keeps Apply disabled until the box is ticked; "Don't apply" applies
// nothing; confirmed in the sheet, it applies. The network sheet shows the diff against the snapshot
// (the Wi-Fi key masked) and the dead-man's switch before the confirmation. Stand-ins only: the
// stand-in tofu on a PATH of the test's own, the loopback stand-in target, a phone paired over the
// mesh listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';
import { PRICES, fakeToken, makeProject, tofuCalls, tofuOnPath } from '../support/infra.ts';
import { Joiner } from '../core/mesh-support.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';

test('M10d: the apply sheet shows the plan in full and the budget, the network sheet the diff and the switch; Apply waits for the box', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m10d-');
  const { path } = tofuOnPath();
  const token = fakeToken();
  const net = await startNetconfig({ file: join(mkdtempSync(join(tmpdir(), 'nova-ui-net-')), 'router.json'), token, initial: { firewall: { allow: ['mesh', 'web'] }, wifi: { ssid: 'example-net', psk: 'example-wifi-key-placeholder' } } });
  const nova = await m.start({ NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network', PATH: `${path}:${process.env.PATH ?? ''}` });
  const shots = shotsDir();
  const api = (p: string) => `/api/v1${p}`;
  const task = (id: string) => m.get(api(`/tasks/${id}`));
  const settle = (id: string) => until<any>(() => task(id), (x) => ['waiting', 'done', 'failed', 'cancelled'].includes(x.state), 800);
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 1000 });
    const proj = makeProject();
    const p = (await m.send('POST', api('/infra/projects'), { name: 'Example', folder: proj.folder, budget_usd_month: 6, prices: PRICES, secrets: ['STANDIN_TOKEN'], egress: 'local' })).body;
    await m.send('PUT', api(`/infra/projects/${p.id}/secrets/STANDIN_TOKEN`), { value: fakeToken() });
    const open = async (id: string, cls: string) => {
      await page.goto(`${m.base}/tasks`);
      await ready(page);
      await page.locator(`[data-action="open-task"][data-task="${id}"]`).first().click();
      const sheet = page.locator(`.${cls}[data-task="${id}"]`);
      await sheet.waitFor();
      return sheet;
    };
    const applyOf = async (run: string) => settle((await until<any>(() => m.get(api(`/infra/runs/${run}`)), (x) => x.tasks.some((y: { step: string }) => y.step === 'apply'), 800)).tasks.find((y: { step: string }) => y.step === 'apply').id);

    // The apply sheet: the plan in full, priced, against the budget; Apply waits for the box.
    const run = (await m.send('POST', api('/infra/runs'), { project: p.id })).body.run.id;
    const apply = await applyOf(run);
    assert.equal(apply.approval_tier, 3);
    const sheet = await open(apply.id, 'infra-sheet');
    const said = (await sheet.textContent()) ?? '';
    assert.match(said, /Nova planned “Example” with OpenTofu\. No infrastructure has changed yet\./);
    assert.match(said, /Planning changes no infrastructure, but OpenTofu runs the project’s providers and data sources/);
    assert.match(said, /standin_server\.web · add · \+\$5\.00 a month/);
    assert.match(said, /After it: \$5\.00 a month of the \$6\.00 budget \(83 %\)\. That is past 80 % of the budget\./);
    assert.ok(await sheet.locator('.infra-plan[open] pre').isVisible(), 'the plan is open in front of the person');
    assert.match((await sheet.locator('.infra-plan pre').textContent()) ?? '', /# standin_server\.web will be created[\s\S]*Plan: 2 to add, 0 to change, 0 to destroy\./);
    const applyBtn = sheet.locator('[data-action="approve"]');
    assert.equal(await applyBtn.isDisabled(), true, 'Apply waits for the box');
    await sheet.locator('input[name="confirm"]').check();
    assert.equal(await applyBtn.isDisabled(), false);
    if (shots) await shoot(page, join(shots, 'm10d-apply.png'));
    // Don't apply: nothing applied.
    await sheet.locator('[data-action="decline-change"]').click();
    await page.locator('.toast', { hasText: 'Not applied' }).waitFor();
    assert.equal((await task(apply.id)).state, 'cancelled');
    assert.equal((await m.get(api(`/infra/runs/${run}`))).state, 'declined');
    assert.equal(existsSync(join(proj.folder, 'terraform.tfstate')), false);
    assert.ok(!tofuCalls(proj.folder).some((c) => c.args[0] === 'apply'));
    // A second run, confirmed in the sheet: applied.
    const run2 = (await m.send('POST', api('/infra/runs'), { project: p.id })).body.run.id;
    const apply2 = await applyOf(run2);
    const sheet2 = await open(apply2.id, 'infra-sheet');
    await sheet2.locator('input[name="confirm"]').check();
    await sheet2.locator('[data-action="approve"]').click();
    await page.locator('.toast', { hasText: 'Approved' }).waitFor();
    const applied = await until<any>(() => task(apply2.id), (x) => ['done', 'failed'].includes(x.state), 800);
    assert.equal(applied.state, 'done', applied.reason);
    assert.equal(existsSync(join(proj.folder, 'terraform.tfstate')), true);

    // The network sheet: a phone paired over the mesh, then a change with its diff and the switch.
    const code = (await m.send('POST', api('/mesh/pairings'))).body.code;
    const phone = new Joiner(nova.mesh!, () => Math.floor(Date.now() / 1000), { name: 'Example phone', kind: 'phone' });
    await phone.join(code);
    await phone.reveal();
    await m.send('POST', api(`/mesh/requests/${phone.requestId}/approve`), { confirm: true });
    await phone.poll();
    assert.equal((await phone.session()).status, 200);
    const target = (await m.send('POST', api('/network/targets'), { name: 'Example router', kind: 'router', url: net.url })).body;
    await m.send('PUT', api(`/network/targets/${target.id}/token`), { value: token });
    const change = (await m.send('POST', api('/network/changes'), { target: target.id, patch: { firewall: { allow: ['mesh', 'web', 'vpn'] } }, title: 'Let the VPN in' })).body.change;
    const napply = await settle((await until<any>(() => m.get(api(`/network/changes/${change.id}`)), (x) => x.tasks.some((y: { step: string }) => y.step === 'apply'), 800)).tasks.find((y: { step: string }) => y.step === 'apply').id);
    const nsheet = await open(napply.id, 'network-sheet');
    const nsaid = (await nsheet.textContent()) ?? '';
    assert.match(nsaid, /Nova took a snapshot of Example router and worked out this change\. Nothing has changed yet\./);
    assert.match(nsaid, /After the change, if Nova can’t hear from one of your devices within 5 minutes, it puts the snapshot back by itself\./);
    assert.match((await nsheet.locator('.network-diff pre').textContent()) ?? '', /\+\s+"vpn"/);
    assert.ok(!nsaid.includes('example-wifi-key-placeholder'), 'the Wi-Fi key is masked');
    assert.match(nsaid, /Keeps the changeA request from Example phone, not from this computer/);
    assert.equal(await nsheet.locator('[data-action="approve"]').isDisabled(), true);
    await nsheet.locator('input[name="confirm"]').check();
    assert.equal(await nsheet.locator('[data-action="approve"]').isDisabled(), false);
    if (shots) await shoot(page, join(shots, 'm10d-network.png'));
    await nsheet.locator('[data-action="decline-change"]').click();
    await page.locator('.toast', { hasText: 'Not applied' }).waitFor();
    assert.equal((await m.get(api(`/network/changes/${change.id}`))).state, 'declined');
    assert.deepEqual(net.config().firewall.allow, ['mesh', 'web'], 'nothing changed on the target');
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await stop(nova);
    await net.close();
    await b.close();
  }
});
