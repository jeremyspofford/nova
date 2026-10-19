// Low-level boot on the Hub (FR-143, ADR-096 D2, D3, D5) against the D5 fake novad: the toggle,
// approval cards for exactly the change, D2 authorizations the fake checks on its own (signature,
// kind, body, window, replay), one-shot trials confirmed or reverted by the device's watchdog, the
// Hub's watchdog failing a trial that never came back (with the out-of-band power cycle link),
// commit, revert, profiles, and the audit with before/after values.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import { BOOT_SET_PATH, bootBodySha256, bootRevertText, bootStatusView } from '../src/index.ts';
import { ACCOUNT, bootEnv, type BootEnv } from './boot-env.ts';

let t: BootEnv;

beforeEach(async () => {
  t = await bootEnv();
});

afterEach(async () => {
  await t.close();
});

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return { code: err.code, reason: err.details?.reason };
    throw err;
  }
  throw new Error('expected a refusal');
}

async function profile(entryId = 'linux-next.conf', name = 'next kernel') {
  return t.boot.createProfile(ACCOUNT, t.deviceId, { name, entryId });
}

function approvalRow(id: string) {
  return t.env.db.raw.prepare('SELECT * FROM approval WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

/** Ask for a try, approve it, and return the started attempt id. */
async function tryAndApprove(entryId = 'linux-next.conf', input = { reboot: true }) {
  const p = await profile(entryId);
  const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, input);
  await t.decide(r.approvalId!);
  const sent = await t.boot.request(ACCOUNT, t.deviceId, r.id);
  expect(sent.status).toBe('sent');
  return { profile: p, request: sent, attemptId: sent.attemptId! };
}

describe('the low-level boot toggle', () => {
  it('refuses try and commit while it is off, and reports it for the heartbeat answer', async () => {
    const p = await profile();
    t.settings.allowLowLevel = false;
    expect(await t.boot.lowLevelBoot()).toBe(false);
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'policy_denied',
      reason: 'low_level_boot_off',
    });
    expect(
      await refusal(
        t.boot.requestCommit(ACCOUNT, t.deviceId, '01920000-0000-7000-8000-0000000000aa'),
      ),
    ).toEqual({ code: 'policy_denied', reason: 'low_level_boot_off' });
    t.settings.allowLowLevel = true;
    expect(await t.boot.lowLevelBoot()).toBe(true);
  });

  it('refuses a request approved after the toggle was turned off, before the device sees it', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    t.settings.allowLowLevel = false;
    await t.decide(r.approvalId!);
    const after = await t.boot.request(ACCOUNT, t.deviceId, r.id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatchObject({ code: 'policy_denied', reason: 'low_level_boot_off' });
    expect(t.fake.calls.filter((c) => c.path === BOOT_SET_PATH)).toEqual([]);
  });

  it('is enforced by the device too: a device whose policy is off refuses a signed set', async () => {
    t.fake.lowLevelBoot = false;
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    await t.decide(r.approvalId!);
    const after = await t.boot.request(ACCOUNT, t.deviceId, r.id);
    expect(after.error).toMatchObject({ code: 'policy_denied', reason: 'low_level_boot_off' });
    expect(t.notes.at(-1)).toMatchObject({ kind: 'error' });
  });
});

describe('trying a profile', () => {
  it('asks for approval of exactly the change, then sets a one-shot with a watchdog', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    expect(r).toMatchObject({
      kind: 'try',
      status: 'awaiting_approval',
      entryId: 'linux-next.conf',
    });
    // Nothing reached the device yet but its status.
    expect(t.fake.calls.map((c) => c.path)).not.toContain(BOOT_SET_PATH);
    const card = approvalRow(r.approvalId!);
    const body = {
      profileId: p.id,
      entryId: 'linux-next.conf',
      watchdogSeconds: 600,
      reboot: true,
    };
    expect(card).toMatchObject({
      status: 'pending',
      risk: 'high',
      tier: 'confirm_at_action',
      tool_name: 'device.boot.try',
      args_hash: bootBodySha256(body),
      scope: `device:${t.deviceId}`,
    });
    const preview = JSON.parse(card.args_preview as string) as Record<string, unknown>;
    expect(preview).toMatchObject({
      from: { booted: 'linux.conf', default: 'linux.conf', pending: null },
      to: { nextBoot: 'linux-next.conf', title: 'Linux (next kernel)' },
      watchdogSeconds: 600,
    });
    expect(t.env.events.names()).toContain('approval.requested');
    expect(t.notes.at(-1)).toMatchObject({ kind: 'approval', href: `/approvals/${r.approvalId}` });

    await t.decide(r.approvalId!);
    const sent = await t.boot.request(ACCOUNT, t.deviceId, r.id);
    expect(sent.status).toBe('sent');
    expect(t.fake.oneShot).toBe('linux-next.conf');
    expect(t.fake.rebootsRequested).toBe(1);
    const call = t.fake.calls.find((c) => c.path === BOOT_SET_PATH)!;
    expect(call.body).toMatchObject(body);
    const authz = call.body.authorization as { payload: Record<string, unknown> };
    expect(authz.payload).toMatchObject({
      v: 1,
      kind: 'boot.set',
      deviceId: t.deviceId,
      changeId: sent.changeId,
      approvalId: r.approvalId,
      bodySha256: bootBodySha256(body),
    });
    const attempt = await t.boot.attempt(ACCOUNT, t.deviceId, sent.attemptId!);
    expect(attempt).toMatchObject({
      status: 'pending',
      entryId: 'linux-next.conf',
      watchdogSeconds: 600,
      deadline: new Date(t.env.clock.now + 600_000).toISOString(),
    });
    const set = t.env.audit.find((a) => a.action === 'device.boot.set')!;
    expect(set).toMatchObject({ kind: 'device', result: 'ok', resource: t.deviceId });
    expect(set.detail).toMatchObject({
      before: { pending: null, default: 'linux.conf' },
      after: { pending: { profileId: p.id, entryId: 'linux-next.conf' } },
    });
  });

  it('becomes ok when the device reports it came back on the entry, and can then be committed', async () => {
    const { attemptId, profile: p } = await tryAndApprove();
    t.fake.powerCycle();
    expect(t.fake.booted).toBe('linux-next.conf');
    t.advance(60_000);
    await t.heartbeat();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'ok',
      verified: true,
    });
    expect(t.notes.at(-1)).toMatchObject({ kind: 'completion' });
    const watchdog = t.env.audit.find((a) => a.action === 'device.boot.watchdog')!;
    expect(watchdog.detail).toMatchObject({
      before: { status: 'pending' },
      after: { status: 'ok' },
      source: 'device',
    });

    // One-shot: the next ordinary restart is back on the default until it is committed.
    t.fake.powerCycle();
    expect(t.fake.booted).toBe('linux.conf');

    const c = await t.boot.requestCommit(ACCOUNT, t.deviceId, attemptId);
    expect(c).toMatchObject({ kind: 'commit', status: 'awaiting_approval', profileId: p.id });
    expect(JSON.parse(approvalRow(c.approvalId!).args_preview as string)).toMatchObject({
      from: { default: 'linux.conf' },
      to: { default: 'linux-next.conf' },
    });
    await t.decide(c.approvalId!);
    expect((await t.boot.request(ACCOUNT, t.deviceId, c.id)).status).toBe('sent');
    expect(t.fake.defaultEntry).toBe('linux-next.conf');
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).committedAt).not.toBeNull();
    const commit = t.env.audit.find((a) => a.action === 'device.boot.commit')!;
    expect(commit.detail).toMatchObject({
      before: { default: 'linux.conf' },
      after: { default: 'linux-next.conf' },
    });
    // Twice is refused.
    expect(await refusal(t.boot.requestCommit(ACCOUNT, t.deviceId, attemptId))).toEqual({
      code: 'conflict',
      reason: 'already_default',
    });
  });

  it('cannot commit a trial the device has not confirmed', async () => {
    const { attemptId } = await tryAndApprove();
    expect(await refusal(t.boot.requestCommit(ACCOUNT, t.deviceId, attemptId))).toEqual({
      code: 'conflict',
      reason: 'not_confirmed',
    });
  });

  it('shows a GRUB trial as unverified and makes it the default only when confirmed', async () => {
    t.fake.grub = { defaultSaved: false };
    const { attemptId } = await tryAndApprove();
    t.fake.powerCycle();
    t.advance(60_000);
    await t.heartbeat();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'ok',
      verified: false,
    });
    expect(await refusal(t.boot.requestCommit(ACCOUNT, t.deviceId, attemptId))).toEqual({
      code: 'conflict',
      reason: 'unverified_trial',
    });
    const c = await t.boot.requestCommit(ACCOUNT, t.deviceId, attemptId, {
      confirmUnverified: true,
    });
    expect(JSON.parse(approvalRow(c.approvalId!).args_preview as string)).toMatchObject({
      verified: false,
    });
    expect(approvalRow(c.approvalId!).requested_action).toContain('could not verify');
    // GRUB without GRUB_DEFAULT=saved: the device refuses and the request says why.
    await t.decide(c.approvalId!);
    expect(await t.boot.request(ACCOUNT, t.deviceId, c.id)).toMatchObject({
      status: 'failed',
      error: { code: 'conflict', reason: 'grub_default_not_saved' },
    });
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).committedAt).toBeNull();
  });

  it('is reverted by the device when it was not back before the deadline', async () => {
    const { attemptId } = await tryAndApprove();
    t.advance(601_000);
    t.fake.powerCycle();
    // novad gave up on the entry and rebooted once into the default.
    expect(t.fake.booted).toBe('linux.conf');
    await t.heartbeat();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'reverted',
      reason: 'reverted_by_device',
      detail: 'deadline',
    });
    expect(t.notes.at(-1)).toMatchObject({ kind: 'attention' });
    expect(t.notes.at(-1)!.body).toContain('restarted into');
  });

  it("matches a device's report by the trial's change id, by profile only without one", async () => {
    const { profile: p, request, attemptId } = await tryAndApprove();
    const ev = (over: Record<string, unknown>) => ({
      kind: 'boot.watchdog.ok',
      profileId: p.id,
      entryId: 'linux-next.conf',
      detail: { booted: 'linux-next.conf' },
      ...over,
    });
    // Another trial's change id: the same profile does not make it this trial's report.
    await t.boot.heartbeatEvents(ACCOUNT, t.deviceId, [
      ev({ changeId: '01920000-0000-7000-8000-0000000000cc' }),
    ]);
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).status).toBe('pending');
    // The device's own report names the change id of the set that started the trial.
    t.fake.powerCycle();
    const events = t.fake.takeEvents();
    expect(events[0]).toMatchObject({ kind: 'boot.watchdog.ok', changeId: request.changeId });
    await t.boot.heartbeatEvents(ACCOUNT, t.deviceId, events);
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).status).toBe('ok');
  });

  it('falls back to the profile for a report without a change id (an older novad)', async () => {
    t.fake.omitChangeId = true;
    const { attemptId } = await tryAndApprove();
    t.fake.powerCycle();
    const events = t.fake.takeEvents();
    expect(events[0]).not.toHaveProperty('changeId');
    await t.boot.heartbeatEvents(ACCOUNT, t.deviceId, events);
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).status).toBe('ok');
  });

  it('fails a trial without a heartbeat by deadline + 120 s and links the out-of-band power cycle', async () => {
    t.boot.usePowerCycle(() => Promise.resolve({ endpointId: 'ep-1', endpointName: 'rack BMC' }));
    const { attemptId } = await tryAndApprove();
    // The machine hangs on the new entry: novad never starts.
    t.fake.powerCycle({ comesUp: false });
    t.advance(600_000 + 120_000);
    expect(await t.boot.sweep()).toEqual([]);
    t.advance(1_000);
    expect(await t.boot.sweep()).toEqual([attemptId]);
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'failed',
      reason: 'no_heartbeat',
    });
    const note = t.notes.at(-1)!;
    expect(note).toMatchObject({ kind: 'error', os: true });
    expect(note.href).toBe(`/devices/${t.deviceId}/oob/ep-1?action=power.cycle`);
    expect(note.body).toContain('rack BMC');
    expect(t.env.events.events.at(-1)?.payload).toMatchObject({
      kind: 'attempt',
      status: 'failed',
      reason: 'no_heartbeat',
    });
    // The owner power-cycles it: the one-shot was consumed, so it boots the default and novad
    // reports the revert, which corrects the Hub's record.
    t.fake.powerCycle();
    await t.heartbeat();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'reverted',
      reason: 'reverted_by_device',
    });
    // Swept once only.
    expect(await t.boot.sweep()).toEqual([]);
  });

  it('says the device is up but silent when it kept heartbeating without a report', async () => {
    // A failing out-of-band lookup only drops the link.
    t.boot.usePowerCycle(() => Promise.reject(new Error('lookup failed')));
    const { attemptId } = await tryAndApprove('linux-next.conf', { reboot: false });
    t.advance(600_000 + 60_000);
    await t.device.heartbeat();
    t.advance(61_000);
    await t.boot.sweep();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'failed',
      reason: 'no_watchdog_report',
    });
    expect(t.notes.at(-1)).toMatchObject({ kind: 'error', href: `/devices/${t.deviceId}/boot` });
  });

  it('refuses a second trial while one is pending, and a second request while one waits', async () => {
    const { profile: p } = await tryAndApprove();
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'conflict',
      reason: 'attempt_pending',
    });
    await t.boot.revert(ACCOUNT, t.deviceId);
    await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'conflict',
      reason: 'request_pending',
    });
  });

  it('closes a trial from the device status when a report was missed', async () => {
    const { attemptId } = await tryAndApprove();
    t.fake.powerCycle();
    t.fake.takeEvents(); // the heartbeat carrying the report was lost
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.status?.last).toMatchObject({ result: 'ok' });
    expect(v.attempts.find((a) => a.id === attemptId)?.status).toBe('ok');
    expect(t.env.audit.some((a) => a.action === 'device.boot.read')).toBe(true);
  });

  it('never closes a new trial with an older result of the same profile', async () => {
    const first = await tryAndApprove();
    t.fake.powerCycle();
    await t.heartbeat();
    t.advance(3_600_000);
    const again = await t.boot.requestTry(ACCOUNT, t.deviceId, first.profile.id, { reboot: true });
    await t.decide(again.approvalId!);
    const attemptId = (await t.boot.request(ACCOUNT, t.deviceId, again.id)).attemptId!;
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.attempts.find((a) => a.id === attemptId)?.status).toBe('pending');
  });
});

describe('approvals', () => {
  it('sends nothing when the card is denied', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    await t.decide(r.approvalId!, 'deny_continue');
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).status).toBe('denied');
    expect(t.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);
    expect(t.env.audit.some((a) => a.action === 'device.boot.denied')).toBe(true);
  });

  it('expires a request whose approval never came, and a late approval then sends nothing', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    t.advance(31 * 60_000);
    await t.boot.sweep();
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).status).toBe('expired');
    expect(approvalRow(r.approvalId!).status).toBe('expired');
    await t.boot.onApprovalDecided(ACCOUNT, r.approvalId!, 'allow_once');
    expect(t.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);
  });

  it('checks the approval record itself, not only the event (D2 c)', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    // An approval.decided event without the decision in the table.
    await t.boot.onApprovalDecided(ACCOUNT, r.approvalId!, 'allow_once');
    const after = await t.boot.request(ACCOUNT, t.deviceId, r.id);
    expect(after).toMatchObject({ status: 'failed', error: { reason: 'approval_missing' } });
    expect(t.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);
  });

  it('refuses to send without a loaded Hub identity', async () => {
    t.boot.useAuthorizer(null);
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    await t.decide(r.approvalId!);
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).error).toMatchObject({
      code: 'conflict',
      reason: 'identity_missing',
    });
  });

  it('fails a request a restart interrupted between approval and answer', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    t.env.db.raw
      .prepare('UPDATE boot_request SET decided_at = ? WHERE id = ?')
      .run(new Date(t.env.clock.now).toISOString(), r.id);
    expect(await t.boot.recover()).toBe(1);
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).error).toMatchObject({
      reason: 'interrupted',
    });
  });
});

describe("the device's authorization check", () => {
  it('refuses a replayed authorization', async () => {
    await tryAndApprove();
    const call = t.fake.calls.find((c) => c.path === BOOT_SET_PATH)!;
    t.fake.marker = null; // as if the first trial were over
    const replay = t.fake.handle(BOOT_SET_PATH, call.body, t.device.managementToken);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      error: { code: 'conflict', details: { reason: 'replayed' } },
    });
  });

  it('refuses a body changed after signing, another kind, and another device', async () => {
    await tryAndApprove();
    const call = t.fake.calls.find((c) => c.path === BOOT_SET_PATH)!;
    t.fake.marker = null;
    const changed = t.fake.handle(
      BOOT_SET_PATH,
      { ...call.body, entryId: 'linux.conf' },
      t.device.managementToken,
    );
    expect(changed.body).toMatchObject({
      error: { details: { reason: 'authorization_mismatch' } },
    });
    const asCommit = t.fake.handle('/agent/v1/boot/commit', call.body, t.device.managementToken);
    expect(asCommit.body).toMatchObject({
      error: { details: { reason: 'authorization_mismatch' } },
    });
    const forged = t.fake.handle(
      BOOT_SET_PATH,
      {
        ...call.body,
        authorization: {
          ...(call.body.authorization as Record<string, unknown>),
          payload: {
            ...(call.body.authorization as { payload: Record<string, unknown> }).payload,
            deviceId: 'another-device',
          },
        },
      },
      t.device.managementToken,
    );
    expect(forged.body).toMatchObject({ error: { details: { reason: 'authorization_invalid' } } });
  });

  it('refuses an expired authorization: the request fails and the owner is told', async () => {
    // The device's clock is 15 minutes ahead: the 5-minute authorization is past its window.
    t.skew.ms = 15 * 60_000;
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    await t.decide(r.approvalId!);
    const after = await t.boot.request(ACCOUNT, t.deviceId, r.id);
    expect(after).toMatchObject({
      status: 'failed',
      error: { code: 'policy_denied', reason: 'authorization_expired' },
    });
    expect(t.fake.refusals.at(-1)).toMatchObject({ reason: 'authorization_expired' });
    expect(t.fake.oneShot).toBeNull();
    expect(t.env.audit.find((a) => a.action === 'device.boot.set')).toMatchObject({
      result: 'failed',
    });
  });
});

describe('reverting', () => {
  it('clears a pending one-shot with the toggle off, approved by the request itself', async () => {
    const { attemptId } = await tryAndApprove();
    t.settings.allowLowLevel = false;
    const r = await t.boot.revert(ACCOUNT, t.deviceId);
    expect(r).toMatchObject({ kind: 'revert', status: 'sent', attemptId });
    expect(approvalRow(r.approvalId!)).toMatchObject({
      status: 'decided',
      decision: 'allow_once',
      decided_by: 'user',
    });
    expect(t.fake.oneShot).toBeNull();
    expect(t.fake.marker).toBeNull();
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'reverted',
      reason: 'revert',
    });
    const audit = t.env.audit.find((a) => a.action === 'device.boot.revert')!;
    expect(audit.detail).toMatchObject({
      before: { pending: { entryId: 'linux-next.conf' } },
      after: { pending: null },
    });
    // The machine now restarts into its default.
    t.fake.powerCycle();
    expect(t.fake.booted).toBe('linux.conf');
  });
});

describe('profiles and refusals', () => {
  it('creates, renames and deletes profiles with before/after in the audit', async () => {
    const p = await profile();
    expect(await refusal(profile('linux.conf', 'next kernel'))).toEqual({
      code: 'conflict',
      reason: 'name_taken',
    });
    const u = await t.boot.updateProfile(ACCOUNT, t.deviceId, p.id, { name: 'testing' });
    expect(u).toMatchObject({ name: 'testing', entryId: 'linux-next.conf' });
    await t.boot.deleteProfile(ACCOUNT, t.deviceId, p.id);
    expect(await t.boot.profiles(ACCOUNT, t.deviceId)).toEqual([]);
    expect(
      t.env.audit.filter((a) => a.action.startsWith('device.boot.profile')).map((a) => a.detail),
    ).toEqual([
      expect.objectContaining({
        before: null,
        after: { name: 'next kernel', entryId: 'linux-next.conf' },
      }),
      expect.objectContaining({
        before: { name: 'next kernel', entryId: 'linux-next.conf' },
        after: { name: 'testing', entryId: 'linux-next.conf' },
      }),
      expect.objectContaining({ after: null }),
    ]);
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'not_found',
      reason: undefined,
    });
  });

  it('refuses an entry the device does not list', async () => {
    expect(await refusal(profile('nope.conf'))).toEqual({
      code: 'validation',
      reason: 'unknown_entry',
    });
  });

  it('accepts a profile for an unreachable device, then checks it when asked to try', async () => {
    t.fake.up = false;
    const p = await profile('whatever.conf');
    t.fake.up = true;
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'validation',
      reason: 'unknown_entry',
    });
  });

  it('refuses a device whose bootloader it cannot manage', async () => {
    await t.close();
    t = await bootEnv({ fake: { unsupported: 'no supported bootloader (BIOS boot)' } });
    expect(await refusal(profile())).toEqual({ code: 'conflict', reason: 'unsupported_hardware' });
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.status).toMatchObject({ supported: false, bootloader: 'none' });
  });

  it('reports an unreachable device in the view instead of failing it', async () => {
    t.fake.up = false;
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.status).toBeNull();
    expect(v.statusError).toMatchObject({ code: 'node_unavailable' });
    expect(v).toMatchObject({ lowLevelBoot: true, watchdogSeconds: 600 });
  });

  it('fails open requests and pending trials of a revoked device', async () => {
    const { attemptId, profile: p } = await tryAndApprove();
    await t.boot.revert(ACCOUNT, t.deviceId);
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    t.env.db.raw
      .prepare("UPDATE boot_attempt SET status = 'pending', reason = NULL WHERE id = ?")
      .run(attemptId);
    await t.env.svc.revoke(ACCOUNT, t.deviceId);
    await t.boot.onDeviceRevoked(ACCOUNT, t.deviceId);
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).error).toMatchObject({
      reason: 'revoked',
    });
    expect(approvalRow(r.approvalId!).status).toBe('cancelled');
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).status).toBe('failed');
    expect(await refusal(t.boot.revert(ACCOUNT, t.deviceId))).toEqual({
      code: 'conflict',
      reason: 'revoked',
    });
    expect((await t.boot.view(ACCOUNT, t.deviceId)).statusError).toMatchObject({
      reason: 'revoked',
    });
  });

  it("ignores heartbeat events that are not boot reports or not this account's device", async () => {
    const { attemptId } = await tryAndApprove();
    await t.boot.heartbeatEvents('01920000-0000-7000-8000-000000000002', t.deviceId, [
      { kind: 'boot.watchdog.ok', profileId: 'x' },
    ]);
    await t.boot.heartbeatEvents(ACCOUNT, t.deviceId, [
      { module: 'storage', kind: 'crashed' },
      { kind: 'boot.watchdog.ok', profileId: 'not-this-profile' },
      'junk',
    ]);
    expect((await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).status).toBe('pending');
  });
});

describe('failing closed', () => {
  it('refuses an approval whose card covered another body or was denied', async () => {
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    // The stored body no longer matches what the card showed (its args hash).
    t.env.db.raw.prepare('UPDATE boot_request SET body_json = ? WHERE id = ?').run(
      JSON.stringify({
        entryId: 'linux.conf',
        profileId: p.id,
        reboot: true,
        watchdogSeconds: 600,
      }),
      r.id,
    );
    await t.decide(r.approvalId!);
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).error).toMatchObject({
      reason: 'approval_missing',
    });
    await t.boot.revert(ACCOUNT, t.deviceId);
    const r2 = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    // The card says deny, an event says allow: the table wins.
    t.env.db.raw
      .prepare("UPDATE approval SET status = 'decided', decision = 'deny_stop' WHERE id = ?")
      .run(r2.approvalId);
    await t.boot.onApprovalDecided(ACCOUNT, r2.approvalId!, 'allow_once');
    expect((await t.boot.request(ACCOUNT, t.deviceId, r2.id)).error).toMatchObject({
      reason: 'approval_missing',
    });
    expect(t.fake.calls.some((c) => c.path === BOOT_SET_PATH)).toBe(false);
  });

  it('records an unexpected signer failure without details', async () => {
    t.boot.useAuthorizer(() => Promise.reject(new Error('disk on fire')));
    const p = await profile();
    const r = await t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true });
    await t.decide(r.approvalId!);
    expect((await t.boot.request(ACCOUNT, t.deviceId, r.id)).error).toEqual({
      code: 'server_error',
      reason: null,
      message: 'the boot change failed',
    });
  });

  it('refuses a boot status it cannot read', async () => {
    const p = await profile();
    t.fake.handle = () => ({ status: 200, body: { supported: 'yes' } });
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.statusError).toMatchObject({ code: 'server_error', reason: 'bad_answer' });
    expect(await refusal(t.boot.requestTry(ACCOUNT, t.deviceId, p.id, { reboot: true }))).toEqual({
      code: 'server_error',
      reason: 'bad_answer',
    });
  });

  it('answers not_found for requests, attempts and profiles of another device', async () => {
    const x = '01920000-0000-7000-8000-0000000000ee';
    expect(await refusal(t.boot.request(ACCOUNT, t.deviceId, x))).toMatchObject({
      code: 'not_found',
    });
    expect(await refusal(t.boot.attempt(ACCOUNT, t.deviceId, x))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await refusal(t.boot.updateProfile(ACCOUNT, t.deviceId, x, { name: 'n' })),
    ).toMatchObject({ code: 'not_found' });
    expect(await refusal(t.boot.view(ACCOUNT, x))).toMatchObject({ code: 'not_found' });
  });

  it('runs its watchdog on a timer and recovers nothing when nothing was interrupted', async () => {
    expect(await t.boot.recover()).toBe(0);
    t.boot.start();
    t.boot.start();
    t.boot.stop();
    t.boot.stop();
  });
});

describe("reading novad's boot status", () => {
  const status = (bootloader: unknown) => ({
    supported: true,
    bootloader,
    entries: [{ id: 'a.conf', title: 'A', isDefault: true }],
    booted: 'a.conf',
    pending: null,
    last: {
      profileId: 'p',
      entryId: 'a.conf',
      result: 'ok',
      at: '2026-10-19T12:00:00Z',
      verified: true,
    },
  });

  it("reads novad's test bootloader and keeps an unknown one, never refusing the answer", () => {
    expect(bootStatusView(status('fake')).bootloader).toBe('fake');
    expect(bootStatusView(status('limine')).bootloader).toBe('limine');
    expect(bootStatusView(status('<b>x</b>')).bootloader).toBe('unreadable');
    const { bootloader: _b, ...without } = status('fake');
    void _b;
    expect(bootStatusView(without).bootloader).toBe('unreadable');
    expect(bootStatusView(status('grub')).entries).toHaveLength(1);
  });

  it('serves the Boot tab of a device on the fake bootloader', async () => {
    await t.close();
    t = await bootEnv({ fake: { bootloader: 'fake' } });
    const v = await t.boot.view(ACCOUNT, t.deviceId);
    expect(v.status).toMatchObject({ supported: true, bootloader: 'fake' });
    // A profile on it is created, not refused as an unreadable answer (J9.5 bug 1).
    expect((await profile()).entryId).toBe('linux-next.conf');
  });
});

describe("the boot revert notice, worded from novad's reason (J9.5)", () => {
  it('says what happened for each reason', () => {
    expect(bootRevertText('Test image', 'deadline')).toBe(
      'The device restarted into Test image but was not back in time, so it returned to its default entry.',
    );
    expect(bootRevertText('Test image', 'not_booted: another entry')).toContain(
      'did not start Test image',
    );
    expect(bootRevertText('Test image', 'not_restarted')).toBe(
      'The device did not restart before the watchdog deadline, so the one-shot boot of Test image was cleared and it stays on its default entry.',
    );
    expect(bootRevertText('Test image', null)).toBe(
      'The trial of Test image ended and the device is on its default entry.',
    );
  });

  it('a trial the machine never restarted for is not "did not come up"', async () => {
    const { request, attemptId } = await tryAndApprove('linux-next.conf', { reboot: false });
    await t.boot.heartbeatEvents(ACCOUNT, t.deviceId, [
      {
        kind: 'boot.watchdog.reverted',
        changeId: request.changeId,
        detail: { reason: 'not_restarted', rebooted: false, error: null },
      },
    ]);
    expect(await t.boot.attempt(ACCOUNT, t.deviceId, attemptId)).toMatchObject({
      status: 'reverted',
      reason: 'reverted_by_device',
      detail: 'not_restarted',
    });
    const note = t.notes.at(-1)!;
    expect(note.body).toContain('did not restart before the watchdog deadline');
    expect(note.body).not.toContain('come up');
  });
});
