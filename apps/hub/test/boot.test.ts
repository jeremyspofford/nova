// The boot area over HTTP (FR-143, ADR-096 D2, D3, D5) with the devices and policy areas and the
// D5 fake novad: the low-level toggle, profiles, a try approved on its card and sent with a signed
// authorization the fake checks itself, the device's watchdog reports (ok, reverted), the Hub's
// watchdog with the out-of-band link, commit and revert, revocation, and every route needing a
// session.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOT_SET_PATH } from '@nova/core';
import { byteRange } from '../src/boot.ts';
import { ACCOUNT, bootHub, until, type BootHub } from './boot-env.ts';

let h: BootHub;

beforeEach(async () => {
  h = await bootHub();
});

afterEach(async () => {
  await h.close();
});

const base = () => `/api/v1/devices/${h.deviceId}/boot`;

async function createProfile(entryId = 'linux-next.conf') {
  const r = await h.api('POST', `${base()}/profiles`, { name: 'next kernel', entryId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string };
}

/** Approve a card through the policy area and wait until the boot area sent its change. */
async function approve(request: Record<string, unknown>, decision = 'allow_once') {
  const d = await h.api('POST', '/api/v1/approvals', {
    approvalId: request.approvalId,
    decision,
  });
  expect(d.status, JSON.stringify(d.json)).toBe(200);
  return until(async () => {
    const r = await h.api('GET', `${base()}/requests/${request.id as string}`);
    return r.json.status !== 'awaiting_approval' ? r.json : null;
  });
}

async function tryProfile(body: Record<string, unknown> = {}) {
  const p = await createProfile();
  const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, body);
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  const sent = await approve(r.json);
  expect(sent.status, JSON.stringify(sent)).toBe('sent');
  return { profileId: p.id, attemptId: sent.attemptId as string, request: sent };
}

describe('the boot routes', () => {
  it('refuses try and commit with the low-level toggle off', async () => {
    const p = await createProfile();
    h.settings['devices.boot.allowLowLevel'] = false;
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'low_level_boot_off' },
    });
    const c = await h.api('POST', `${base()}/attempts/${p.id}/commit`, {});
    expect(c.json.error).toMatchObject({ details: { reason: 'low_level_boot_off' } });
    expect(await h.boot.lowLevelBoot()).toBe(false);
    // Reading works whatever the toggle.
    const v = await h.api('GET', base());
    expect(v.json).toMatchObject({ lowLevelBoot: false, pxeEnabled: false, watchdogSeconds: 600 });
    expect(v.json.status).toMatchObject({ bootloader: 'systemd-boot', booted: 'linux.conf' });
  });

  it('commits an unverified (GRUB) trial only with confirmUnverified', async () => {
    h.fake.grub = { defaultSaved: true };
    const p = await createProfile();
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, { watchdogSeconds: 300 });
    const sent = await approve(r.json);
    h.fake.powerCycle();
    await h.heartbeat();
    const path = `${base()}/attempts/${sent.attemptId as string}`;
    expect((await h.api('GET', path)).json).toMatchObject({ status: 'ok', verified: false });
    const plain = await h.api('POST', `${path}/commit`, {});
    expect(plain.status).toBe(409);
    expect((plain.json as { error: { details: unknown } }).error.details).toEqual({
      reason: 'unverified_trial',
    });
    expect((await h.api('POST', `${path}/commit`, { other: 1 })).status).toBe(400);
    const c = await h.api('POST', `${path}/commit`, { confirmUnverified: true });
    expect(c.status).toBe(202);
    expect(await approve(c.json)).toMatchObject({ status: 'sent', kind: 'commit' });
    expect(h.fake.defaultEntry).toBe('linux-next.conf');
  });

  it('tries a profile after its card is approved, then commits it once the device confirmed it', async () => {
    const p = await createProfile();
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, { watchdogSeconds: 300 });
    expect(r.json).toMatchObject({ kind: 'try', status: 'awaiting_approval' });
    const card = await h.api('GET', `/api/v1/approvals/${r.json.approvalId as string}`);
    expect(card.json).toMatchObject({ status: 'pending', risk: 'high', tier: 'confirm_at_action' });
    expect(h.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);

    const sent = await approve(r.json);
    expect(sent).toMatchObject({ status: 'sent' });
    expect(h.fake.oneShot).toBe('linux-next.conf');
    const set = h.fake.calls.find((c) => c.path === BOOT_SET_PATH)!;
    expect(set.body).toMatchObject({ watchdogSeconds: 300, reboot: true });
    expect((set.body.authorization as { payload: unknown }).payload).toMatchObject({
      kind: 'boot.set',
      deviceId: h.deviceId,
      approvalId: r.json.approvalId,
    });

    h.fake.powerCycle();
    await h.heartbeat();
    const attempt = await h.api('GET', `${base()}/attempts/${sent.attemptId as string}`);
    expect(attempt.json).toMatchObject({ status: 'ok', entryId: 'linux-next.conf' });

    const c = await h.api('POST', `${base()}/attempts/${sent.attemptId as string}/commit`, {});
    expect(c.status).toBe(202);
    expect(await approve(c.json)).toMatchObject({ status: 'sent', kind: 'commit' });
    expect(h.fake.defaultEntry).toBe('linux-next.conf');
    const v = await h.api('GET', base());
    expect(v.json.status).toMatchObject({
      entries: expect.arrayContaining([
        { id: 'linux-next.conf', title: 'Linux (next kernel)', isDefault: true },
      ]),
    });
    expect(h.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'device.boot.profile.create',
        'device.boot.request',
        'device.boot.set',
        'device.boot.watchdog',
        'device.boot.commit',
        'device.boot.read',
      ]),
    );
  });

  it('sends nothing when the card is denied', async () => {
    const p = await createProfile();
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, {});
    expect(await approve(r.json, 'deny_continue')).toMatchObject({ status: 'denied' });
    expect(h.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);
  });

  it('fails a trial with no heartbeat and offers the out-of-band power cycle', async () => {
    h.boot.usePowerCycle(() => Promise.resolve({ endpointId: 'ep-1', endpointName: 'rack BMC' }));
    const { attemptId } = await tryProfile();
    h.fake.powerCycle({ comesUp: false });
    h.clock.now += 600_000 + 120_001;
    expect(await h.boot.service.sweep()).toEqual([attemptId]);
    expect((await h.api('GET', `${base()}/attempts/${attemptId}`)).json).toMatchObject({
      status: 'failed',
      reason: 'no_heartbeat',
    });
    expect(h.notes.at(-1)).toMatchObject({
      kind: 'error',
      href: `/devices/${h.deviceId}/oob/ep-1?action=power.cycle`,
    });
    // Power-cycled by the owner: the one-shot is gone, the default boots, novad reports it.
    h.fake.powerCycle();
    await h.heartbeat();
    expect((await h.api('GET', `${base()}/attempts/${attemptId}`)).json).toMatchObject({
      status: 'reverted',
    });
  });

  it('records a revert the device made on its own', async () => {
    const { attemptId } = await tryProfile();
    h.clock.now += 601_000;
    h.fake.powerCycle();
    await h.heartbeat();
    expect((await h.api('GET', `${base()}/attempts/${attemptId}`)).json).toMatchObject({
      status: 'reverted',
      reason: 'reverted_by_device',
    });
  });

  it('reverts a pending one-shot at once, and reports a device that cannot be reached', async () => {
    const { attemptId } = await tryProfile();
    h.settings['devices.boot.allowLowLevel'] = false;
    const r = await h.api('POST', `${base()}/revert`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ kind: 'revert', status: 'sent', attemptId });
    expect(h.fake.oneShot).toBeNull();
    h.fake.up = false;
    const down = await h.api('POST', `${base()}/revert`, {});
    expect(down.status).toBe(503);
    expect(down.json.error).toMatchObject({ code: 'node_unavailable' });
    const v = await h.api('GET', base());
    expect(v.json.status).toBeNull();
    expect(v.json.statusError).toMatchObject({ code: 'node_unavailable' });
  });

  it("is refused by the device's verifier when replayed", async () => {
    await tryProfile();
    const set = h.fake.calls.find((c) => c.path === BOOT_SET_PATH)!;
    h.fake.marker = null;
    const replay = h.fake.handle(BOOT_SET_PATH, set.body, h.device.managementToken);
    expect(replay.body).toMatchObject({
      error: { code: 'conflict', details: { reason: 'replayed' } },
    });
  });

  it("is refused by the device's verifier when its authorization has expired", async () => {
    // The device's clock runs 20 minutes ahead: the 5-minute authorization is outside its window.
    h.skew.ms = 20 * 60_000;
    const p = await createProfile();
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, {});
    const failed = await approve(r.json);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'policy_denied', reason: 'authorization_expired' },
    });
    expect(h.fake.oneShot).toBeNull();
    expect(h.notes.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('refuses kernel arguments, unknown entries and bodies that do not fit', async () => {
    const k = await h.api('POST', `${base()}/profiles`, {
      name: 'x',
      entryId: 'linux.conf',
      kernelArgs: 'init=/bin/sh',
    });
    expect(k.status).toBe(400);
    expect(k.json.error).toMatchObject({
      code: 'capability_missing',
      details: { reason: 'kernel_args_not_supported' },
    });
    const u = await h.api('POST', `${base()}/profiles`, { name: 'x', entryId: 'nope.conf' });
    expect(u.json.error).toMatchObject({
      code: 'validation',
      details: { reason: 'unknown_entry' },
    });
    const p = await createProfile();
    const w = await h.api('POST', `${base()}/profiles/${p.id}/try`, { watchdogSeconds: 30 });
    expect(w.status).toBe(400);
    const extra = await h.api('POST', `${base()}/revert`, { force: true });
    expect(extra.status).toBe(400);
    expect(
      (await h.api('PATCH', `${base()}/profiles/${p.id}`, { name: 'renamed' })).json,
    ).toMatchObject({
      name: 'renamed',
    });
    expect((await h.api('GET', `${base()}/profiles`)).json.items).toHaveLength(1);
    expect((await h.api('DELETE', `${base()}/profiles/${p.id}`)).json).toEqual({ ok: true });
    expect((await h.api('GET', `${base()}/profiles`)).json.items).toEqual([]);
  });

  it('fails open requests of a device that is revoked and stops its boot token', async () => {
    const p = await createProfile();
    const r = await h.api('POST', `${base()}/profiles/${p.id}/try`, {});
    const token = (await h.api('POST', `${base()}/pxe/token`, {})).json.token as string;
    h.settings['devices.pxe.enabled'] = true;
    expect((await h.api('GET', `/boot/ipxe/${token}`, undefined, {})).status).toBe(200);
    await h.devices.service.revoke(ACCOUNT, h.deviceId);
    const after = await h.api('GET', `${base()}/requests/${r.json.id as string}`);
    expect(after.json).toMatchObject({ status: 'failed', error: { reason: 'revoked' } });
    expect((await h.api('GET', `/boot/ipxe/${token}`, undefined, {})).status).toBe(404);
  });

  it('needs a session on every owner route and adds its diagnostics', async () => {
    const id = h.deviceId;
    const x = '01920000-0000-7000-8000-0000000000ff';
    const routes: [string, string][] = [
      ['GET', `/api/v1/devices/${id}/boot`],
      ['GET', `/api/v1/devices/${id}/boot/profiles`],
      ['POST', `/api/v1/devices/${id}/boot/profiles`],
      ['PATCH', `/api/v1/devices/${id}/boot/profiles/${x}`],
      ['DELETE', `/api/v1/devices/${id}/boot/profiles/${x}`],
      ['POST', `/api/v1/devices/${id}/boot/profiles/${x}/try`],
      ['GET', `/api/v1/devices/${id}/boot/attempts/${x}`],
      ['POST', `/api/v1/devices/${id}/boot/attempts/${x}/commit`],
      ['POST', `/api/v1/devices/${id}/boot/revert`],
      ['GET', `/api/v1/devices/${id}/boot/requests/${x}`],
      ['GET', '/api/v1/devices/boot-images'],
      ['POST', `/api/v1/devices/${id}/boot/pxe/token`],
      ['DELETE', `/api/v1/devices/${id}/boot/pxe/token`],
    ];
    for (const [method, path] of routes) {
      const r = await h.api(method, path, ['POST', 'PATCH'].includes(method) ? {} : undefined, {});
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    await tryProfile();
    expect(await h.diagnostics.collect()).toMatchObject({
      boot: { attempts: { pending: 1 }, pxeTokens: 0 },
    });
  });
});

describe('byteRange', () => {
  it('reads one range and refuses unsatisfiable ones', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(byteRange('items=0-1', 100)).toBeNull();
    for (const bad of ['bytes=100-', 'bytes=5-1', 'bytes=-', 'bytes=-0'])
      expect(byteRange(bad, 100), bad).toBe('invalid');
  });
});
