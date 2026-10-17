// Minimum novad version per capability (FR-148): numeric version order, a setting that can only
// raise the table, and capability gating with the reason the Devices page shows.
import { describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  MIN_NOVAD_VERSIONS,
  compareNovadVersions,
  deviceCapabilityStatuses,
  minimumNovadVersions,
  requireDeviceCapabilities,
} from '../src/index.ts';

describe('compareNovadVersions', () => {
  it('orders numerically with pre-releases first', () => {
    expect(compareNovadVersions('0.10.0', '0.9.3')).toBe(1);
    expect(compareNovadVersions('0.6', '0.6.0')).toBe(0);
    expect(compareNovadVersions('0.6.0-beta.1', '0.6.0')).toBe(-1);
    expect(compareNovadVersions('0.6.0', '0.6.0-beta.1')).toBe(1);
    expect(compareNovadVersions('0.6.0-beta.1', '0.6.0-beta.2')).toBe(-1);
    expect(compareNovadVersions('1.0.0', '0.99.99')).toBe(1);
  });
});

describe('minimum table', () => {
  it('raises entries from the setting but never lowers them', () => {
    const t = minimumNovadVersions({ files: '0.9.0', exec: '0.1.0', unknown: '9.9.9' });
    expect(t.files).toBe('0.9.0');
    expect(t.exec).toBe(MIN_NOVAD_VERSIONS.exec);
    expect(Object.keys(t)).not.toContain('unknown');
  });

  it('gates each capability by module, policy and version', () => {
    const minimums = minimumNovadVersions();
    const s = deviceCapabilityStatuses({
      novadVersion: '0.6.0',
      modules: ['storage', 'management', 'screen'],
      allowedModules: ['storage', 'screen'],
      minimums,
    });
    const by = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(by.files).toMatchObject({ available: true, reason: null, module: 'storage' });
    expect(by.power).toMatchObject({ available: false, reason: 'module_not_allowed' });
    expect(by.computer_use).toMatchObject({ available: false, reason: 'update_required' });
    expect(by.browser).toMatchObject({ available: false, reason: 'module_missing' });
    expect(() => requireDeviceCapabilities(s, ['files', 'exec'], '0.6.0')).not.toThrow();
    let err: unknown;
    try {
      requireDeviceCapabilities(s, ['files', 'computer_use'], '0.6.0');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NovaError);
    expect((err as NovaError).code).toBe('capability_missing');
    expect((err as NovaError).details).toMatchObject({
      reason: 'update_required',
      capability: 'computer_use',
      minVersion: '0.7.0',
      novadVersion: '0.6.0',
    });
    expect(() => requireDeviceCapabilities(s, ['power'], '0.6.0')).toThrow(/not allowed/);
    expect(() => requireDeviceCapabilities(s, ['browser'], '0.6.0')).toThrow(/no browser module/);
  });

  it('refuses everything from a device with no or an old version', () => {
    const s = deviceCapabilityStatuses({
      novadVersion: null,
      modules: ['storage'],
      allowedModules: null,
      minimums: minimumNovadVersions(),
    });
    expect(s.find((x) => x.name === 'files')?.reason).toBe('update_required');
    const old = deviceCapabilityStatuses({
      novadVersion: '0.0.0',
      modules: ['storage'],
      allowedModules: null,
      minimums: minimumNovadVersions(),
    });
    expect(() => requireDeviceCapabilities(old, ['staged_writes'], '0.0.0')).toThrow(
      /needs novad 0.6.0 or newer/,
    );
  });
});
