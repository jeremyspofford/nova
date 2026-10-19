// The words of the Firmware and Boot tabs (FR-146, FR-143): every refusal of the firmware and
// boot areas reads as plain words (never a raw code), countdowns, watchdog outcomes, support
// reasons and the Hub's security-degrading rule as the client applies it.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { bootApi } from '../src/boot/api-m75.ts';
import { firmwareApi } from '../src/firmware/api-m75.ts';
import {
  ATTEMPT_STATUS,
  REQUEST_STATUS,
  attemptReasonText,
  bootloaderText,
  minutesText,
  watchdogOptions,
} from '../src/boot/format.ts';
import {
  CHANGE_STATUS,
  bootTabPath,
  changeErrorText,
  countdownText,
  firmwareErrorMessage,
  firmwareTabPath,
  keyLabel,
  methodText,
  sameValue,
  storedErrorText,
  supportReasonText,
  valueText,
  watchdogText,
  weakensSecurity,
} from '../src/firmware/format.ts';

const refusal = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new ApiError(status, { code, message: `raw ${code}`, retryable: false, details });

/** Every reason the firmware and boot areas (and novad through them) answer. */
const REASONS: [number, string, Record<string, unknown>][] = [
  [403, 'policy_denied', { reason: 'owner_only' }],
  [403, 'policy_denied', { reason: 'consent_required' }],
  [403, 'firmware_disabled', { reason: 'firmware_disabled' }],
  [403, 'policy_denied', { reason: 'low_level_boot_off' }],
  [409, 'conflict', { reason: 'unsupported_hardware', detail: 'legacy_bios' }],
  [403, 'policy_denied', { reason: 'security_degrading', keys: ['secureBoot'] }],
  [409, 'approval_required', { reason: 'approval_required', approvalId: 'a1' }],
  [409, 'approval_required', { reason: 'approval_required', approvalId: null }],
  [409, 'conflict', { reason: 'approval_expired' }],
  [403, 'policy_denied', { reason: 'approval_denied' }],
  [403, 'policy_denied', { reason: 'approval_mismatch' }],
  [403, 'policy_denied', { reason: 'approval_missing' }],
  [403, 'policy_denied', { reason: 'hub_only' }],
  [409, 'conflict', { reason: 'already_applied' }],
  [409, 'conflict', { reason: 'failed' }],
  [409, 'conflict', { reason: 'nothing_to_apply' }],
  [409, 'conflict', { reason: 'nothing_to_roll_back' }],
  [409, 'conflict', { reason: 'rolled_back' }],
  [409, 'conflict', { reason: 'bios_password_required' }],
  [403, 'policy_denied', { reason: 'admin_password_required' }],
  [409, 'conflict', { reason: 'identity_unavailable' }],
  [409, 'conflict', { reason: 'identity_missing' }],
  [409, 'conflict', { reason: 'firmware_busy' }],
  [409, 'conflict', { reason: 'snapshot_missing' }],
  [500, 'server_error', { reason: 'snapshot_unreadable' }],
  [500, 'server_error', { reason: 'snapshot_corrupt' }],
  [500, 'server_error', { reason: 'snapshot_mismatch' }],
  [409, 'conflict', { reason: 'snapshot_not_applicable' }],
  [500, 'server_error', { reason: 'unexpected_diff' }],
  [409, 'conflict', { reason: 'base_mismatch' }],
  [409, 'conflict', { reason: 'plan_mismatch' }],
  [500, 'server_error', { reason: 'apply_failed', restored: true }],
  [500, 'server_error', { reason: 'apply_failed', restored: false }],
  [500, 'server_error', { reason: 'rollback_failed' }],
  [400, 'validation', { reason: 'reboot_not_offered' }],
  [409, 'conflict', { reason: 'reboot_unavailable' }],
  [409, 'conflict', { reason: 'watchdog_pending' }],
  [409, 'conflict', { reason: 'boot_pending' }],
  [409, 'conflict', { reason: 'watchdog_already_used' }],
  [403, 'policy_denied', { reason: 'watchdog_unavailable', detail: 'admin_password_set' }],
  [403, 'policy_denied', { reason: 'tls_required' }],
  [403, 'policy_denied', { reason: 'no_client_certificate' }],
  [403, 'policy_denied', { reason: 'authorization_invalid' }],
  [403, 'policy_denied', { reason: 'authorization_mismatch' }],
  [403, 'policy_denied', { reason: 'authorization_expired' }],
  [409, 'conflict', { reason: 'replayed' }],
  [403, 'policy_denied', { reason: 'module_not_allowed', module: 'firmware' }],
  [400, 'capability_missing', { reason: 'kernel_args_not_supported' }],
  [409, 'conflict', { reason: 'name_taken' }],
  [409, 'conflict', { reason: 'attempt_pending' }],
  [409, 'conflict', { reason: 'request_pending' }],
  [409, 'conflict', { reason: 'not_confirmed' }],
  [409, 'conflict', { reason: 'unverified_trial' }],
  [409, 'conflict', { reason: 'grub_default_not_saved' }],
  [409, 'conflict', { reason: 'already_default' }],
  [400, 'validation', { reason: 'unknown_entry' }],
  [500, 'server_error', { reason: 'bad_answer' }],
  [500, 'server_error', { reason: 'interrupted' }],
  [409, 'conflict', { reason: 'revoked' }],
  [503, 'node_unavailable', { reason: 'unreachable' }],
];

describe('firmware and boot refusals in plain words', () => {
  it.each(REASONS)('%i %s %o', (status, code, details) => {
    const text = firmwareErrorMessage(refusal(status, code, details), 'fallback');
    expect(text).not.toBe(`raw ${code}`);
    expect(text).not.toBe('fallback');
    // No raw lower-case code (`some_reason`) leaks into the words.
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });

  it('names the setting a security-degrading change touches and where to allow it', () => {
    const text = firmwareErrorMessage(
      refusal(403, 'policy_denied', { reason: 'security_degrading', keys: ['secureBoot', 'tpm'] }),
    );
    expect(text).toContain('(Secure Boot, TPM)');
    expect(text).toContain('Allow changes that weaken security');
  });

  it('tells a restored failed write from an unrestored one', () => {
    expect(
      firmwareErrorMessage(
        refusal(500, 'server_error', { reason: 'apply_failed', restored: true }),
      ),
    ).toContain('restored the previous settings');
    expect(
      firmwareErrorMessage(
        refusal(500, 'server_error', { reason: 'apply_failed', restored: false }),
      ),
    ).toContain('could not restore');
  });

  it('falls back to the devices words, then to the Hub message', () => {
    expect(firmwareErrorMessage(refusal(503, 'node_unavailable'))).toContain('offline');
    expect(
      firmwareErrorMessage(
        new ApiError(400, { code: 'validation', message: 'bad', retryable: false }),
      ),
    ).toBe('bad');
    expect(firmwareErrorMessage(new Error('Failed to fetch'))).toContain('Cannot reach the Hub');
  });

  it('reads a recorded change error and a recorded boot request error', () => {
    expect(changeErrorText(null)).toBeNull();
    expect(changeErrorText('conflict:base_mismatch')).toContain('changed since the plan');
    expect(changeErrorText('watchdog:reverted')).toBe(
      'The watchdog restored the previous settings.',
    );
    expect(changeErrorText('watchdog:deadline')).toContain('did not come back by the deadline');
    expect(changeErrorText('watchdog:not_restarted')).toContain('without a restart');
    expect(changeErrorText('watchdog:incomplete')).toContain('only some');
    expect(changeErrorText('watchdog:error')).toBe(
      'The watchdog could not restore the previous settings.',
    );
    expect(changeErrorText('watchdog:admin_password_required')).toContain('novad never keeps');
    expect(changeErrorText('watchdog:write_failed')).toContain('(write failed)');
    expect(changeErrorText('server_error')).toBe('The device did not make the change.');
    expect(storedErrorText(null)).toBeNull();
    expect(
      storedErrorText({ code: 'policy_denied', reason: 'low_level_boot_off', message: 'raw' }),
    ).toContain('Low-level boot changes are off');
    expect(
      storedErrorText({ code: 'server_error', reason: null, message: 'the device said no' }),
    ).toBe('the device said no');
  });
});

describe('words', () => {
  it('says why a machine is not supported', () => {
    expect(supportReasonText('os_not_supported')).toContain('only on Linux');
    expect(supportReasonText('legacy_bios')).toContain('legacy BIOS');
    expect(supportReasonText('unknown_platform')).toContain('maker and model');
    expect(supportReasonText(null)).toContain('support matrix');
    expect(supportReasonText('ASUS boards offer no interface')).toBe(
      'ASUS boards offer no interface.',
    );
    expect(supportReasonText('Use out-of-band management.')).toBe('Use out-of-band management.');
  });

  it('names settings and values', () => {
    expect(keyLabel('powerOnAfterPowerLoss')).toBe('After a power cut');
    expect(keyLabel('other')).toBe('other');
    expect(valueText(null)).toBe('Not reported');
    expect(valueText(['a', 'b'])).toBe('a, b');
    expect(valueText([])).toBe('Empty');
    expect(valueText(3)).toBe('3');
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(firmwareTabPath('d 1')).toBe('/devices/d%201?tab=firmware');
    expect(bootTabPath('d1')).toBe('/devices/d1?tab=boot');
    expect(CHANGE_STATUS.awaiting_approval.text).toBe('Waiting for your approval');
    expect(CHANGE_STATUS.revert_failed.text).toBe('Not reverted: check it');
  });

  it('applies the Hub’s security-degrading rule whatever the device flags', () => {
    expect(weakensSecurity('secureBoot', 'Disabled')).toBe(true);
    expect(weakensSecurity('tpm', 'off')).toBe(true);
    expect(weakensSecurity('tpm', 0)).toBe(true);
    expect(weakensSecurity('secureBoot', 'Enabled')).toBe(false);
    expect(weakensSecurity('wol', 'Disabled')).toBe(false);
    expect(weakensSecurity('fanProfile', 'Loud', ['Loud'])).toBe(true);
    expect(weakensSecurity('bootOrder', ['a'])).toBe(false);
  });

  it('counts down to a deadline', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(countdownText(null, now)).toBe('');
    expect(countdownText('nonsense', now)).toBe('');
    expect(countdownText('2026-10-01T11:59:00Z', now)).toBe('Past the deadline');
    expect(countdownText('2026-10-01T12:00:30Z', now)).toBe('30 s left');
    expect(countdownText('2026-10-01T12:09:05Z', now)).toBe('9 min 5 s left');
    expect(countdownText('2026-10-01T13:02:00Z', now)).toBe('1 h 2 min left');
  });

  it('says what the firmware watchdog did', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(watchdogText(null, now)).toBeNull();
    expect(watchdogText({ state: 'pending', deadline: '2026-10-01T12:10:00Z' }, now)).toContain(
      '10 min 0 s left',
    );
    expect(watchdogText({ state: 'pending', deadline: null }, now)).toContain('must come back');
    expect(watchdogText({ state: 'ok', deadline: null }, now)).toContain('kept the new settings');
    expect(watchdogText({ state: 'reverted', deadline: null }, now)).toContain('restored');
    // Worded from novad's reason (J9.5): never a restart that did not happen.
    expect(watchdogText({ state: 'reverted', deadline: null, reason: 'not_restarted' }, now)).toBe(
      'The device did not restart before the deadline: its watchdog restored the previous settings without a restart.',
    );
    expect(watchdogText({ state: 'reverted', deadline: null, reason: 'deadline' }, now)).toContain(
      'restarted into the change but was not back in time',
    );
    expect(
      watchdogText({ state: 'revert_failed', deadline: null, reason: 'not_restarted' }, now),
    ).toMatch(/^The device did not restart before the deadline, and its watchdog could not/);
    expect(
      watchdogText({ state: 'revert_failed', deadline: null, reason: 'deadline' }, now),
    ).toContain('was not back in time, and its watchdog could not');
    expect(watchdogText({ state: 'missed', deadline: null }, now)).toContain('has not reported');
    expect(watchdogText({ state: 'revert_failed', deadline: null }, now)).toContain(
      'could not restore',
    );
  });

  it('names boot trial and request outcomes and the watchdog choices', () => {
    expect(ATTEMPT_STATUS.failed.text).toBe('Did not come back');
    expect(REQUEST_STATUS.failed.text).toBe('Not made');
    expect(attemptReasonText(null)).toBeNull();
    expect(attemptReasonText('reverted_by_device')).toContain('default entry');
    // Worded from novad's reason in the attempt's detail (J9.5).
    expect(attemptReasonText('reverted_by_device', 'not_restarted')).toBe(
      'It did not restart before the watchdog deadline, so the one-shot boot was cleared and it stays on its default entry.',
    );
    expect(attemptReasonText('reverted_by_device', 'deadline')).toContain(
      'restarted into the entry but was not back in time',
    );
    expect(attemptReasonText('reverted_by_device', 'not_booted: wrong entry')).toContain(
      'booted another one',
    );
    expect(attemptReasonText('reverted_by_device', 'not_restarted')).not.toContain('come up');
    expect(attemptReasonText('revert')).toContain('cleared');
    expect(attemptReasonText('no_heartbeat')).toContain('not been heard from');
    expect(attemptReasonText('no_watchdog_report')).toContain('never confirmed');
    expect(attemptReasonText('revoked')).toContain('revoked');
    expect(attemptReasonText('other')).toBe('other');
    expect(minutesText(600)).toBe('10 minutes');
    expect(minutesText(60)).toBe('1 minute');
    expect(minutesText(150)).toBe('150 seconds');
    expect(watchdogOptions(600).map((o) => o.value)).toContain('600');
    expect(watchdogOptions(150)[0]).toEqual({ value: '120', label: '2 minutes' });
    expect(watchdogOptions(150)[1]).toEqual({ value: '150', label: '150 seconds' });
  });
});

describe('the client calls match the Hub routes', () => {
  it('calls the firmware routes', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const api = firmwareApi(call as never);
    await api.getFirmwarePolicy();
    await api.setFirmwarePolicy({ allowChanges: true, confirm: true });
    await api.getFirmwareSupport();
    await api.readFirmware('d 1');
    await api.readFirmware('d1', { fresh: true });
    await api.planFirmware('d1', [{ key: 'wol', value: 'LanOnly' }]);
    await api.getFirmwareChange('d1', 'c1');
    await api.requestFirmwareApproval('d1', 'c1');
    await api.requestFirmwareApproval('d1', 'c1', 'demo');
    await api.applyFirmwareChange('d1', 'c1', { reboot: true });
    await api.applyFirmwareChange('d1', 'c1');
    await api.rollbackFirmwareSnapshot('d1', 's1');
    await api.rollbackFirmwareSnapshot('d1', 's1', 'undo');
    await api.getFirmwareHistory('d1');
    await api.getFirmwareHistory('d1', 10);
    await api.setBiosPassword('d1', 'pw');
    await api.clearBiosPassword('d1');
    expect(call.mock.calls).toEqual([
      ['GET', '/api/v1/devices/firmware/policy'],
      ['PUT', '/api/v1/devices/firmware/policy', { allowChanges: true, confirm: true }],
      ['GET', '/api/v1/devices/firmware/support'],
      ['GET', '/api/v1/devices/d%201/firmware'],
      ['GET', '/api/v1/devices/d1/firmware?fresh=1'],
      ['POST', '/api/v1/devices/d1/firmware/plan', { changes: [{ key: 'wol', value: 'LanOnly' }] }],
      ['GET', '/api/v1/devices/d1/firmware/changes/c1'],
      ['POST', '/api/v1/devices/d1/firmware/changes/c1/request-approval', {}],
      ['POST', '/api/v1/devices/d1/firmware/changes/c1/request-approval', { note: 'demo' }],
      ['POST', '/api/v1/devices/d1/firmware/changes/c1/apply', { reboot: true }],
      ['POST', '/api/v1/devices/d1/firmware/changes/c1/apply', { reboot: false }],
      ['POST', '/api/v1/devices/d1/firmware/snapshots/s1/rollback', {}],
      ['POST', '/api/v1/devices/d1/firmware/snapshots/s1/rollback', { note: 'undo' }],
      ['GET', '/api/v1/devices/d1/firmware/history'],
      ['GET', '/api/v1/devices/d1/firmware/history?limit=10'],
      ['PUT', '/api/v1/devices/d1/firmware/admin-password', { password: 'pw' }],
      ['DELETE', '/api/v1/devices/d1/firmware/admin-password'],
    ]);
  });

  it('calls the boot routes', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const api = bootApi(call as never);
    await api.getDeviceBoot('d1');
    await api.listBootProfiles('d1');
    await api.createBootProfile('d1', { name: 'A', entryId: 'e' });
    await api.updateBootProfile('d1', 'p1', { name: 'B' });
    await api.deleteBootProfile('d1', 'p1');
    await api.tryBootProfile('d1', 'p1', { watchdogSeconds: 300, reboot: false });
    await api.tryBootProfile('d1', 'p1');
    await api.getBootAttempt('d1', 'a1');
    await api.commitBootAttempt('d1', 'a1');
    await api.commitBootAttempt('d1', 'a1', { confirmUnverified: true });
    await api.revertBoot('d1');
    await api.getBootRequest('d1', 'r1');
    await api.listBootImages();
    await api.createPxeToken('d1');
    await api.revokePxeToken('d1');
    expect(call.mock.calls).toEqual([
      ['GET', '/api/v1/devices/d1/boot'],
      ['GET', '/api/v1/devices/d1/boot/profiles'],
      ['POST', '/api/v1/devices/d1/boot/profiles', { name: 'A', entryId: 'e' }],
      ['PATCH', '/api/v1/devices/d1/boot/profiles/p1', { name: 'B' }],
      ['DELETE', '/api/v1/devices/d1/boot/profiles/p1'],
      ['POST', '/api/v1/devices/d1/boot/profiles/p1/try', { watchdogSeconds: 300, reboot: false }],
      ['POST', '/api/v1/devices/d1/boot/profiles/p1/try', {}],
      ['GET', '/api/v1/devices/d1/boot/attempts/a1'],
      ['POST', '/api/v1/devices/d1/boot/attempts/a1/commit', {}],
      ['POST', '/api/v1/devices/d1/boot/attempts/a1/commit', { confirmUnverified: true }],
      ['POST', '/api/v1/devices/d1/boot/revert', {}],
      ['GET', '/api/v1/devices/d1/boot/requests/r1'],
      ['GET', '/api/v1/devices/boot-images'],
      ['POST', '/api/v1/devices/d1/boot/pxe/token', {}],
      ['DELETE', '/api/v1/devices/d1/boot/pxe/token'],
    ]);
  });
});

describe('names a newer novad may send (J9.5 bug 1)', () => {
  it("reads novad's test backends and shows an unknown name as sent", () => {
    expect(bootloaderText('fake')).toBe('Test bootloader (fake)');
    expect(bootloaderText('grub')).toBe('GRUB');
    expect(bootloaderText('limine')).toBe('unknown (limine)');
    expect(methodText('fake')).toBe('Test backend (no real firmware)');
    expect(methodText('quantum-bios')).toBe('unknown (quantum-bios)');
    expect(methodText(null)).toBe('Nothing');
  });
});
