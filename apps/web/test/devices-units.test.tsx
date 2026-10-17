// Pure helpers of the Devices views (docs/23; FR-141..FR-150, FR-210): words, paths, quiet
// hours, unified diffs, previews, error messages, the override and policy drafts, update bundle
// files and what the device says about power and MCP servers.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { devicesApi } from '../src/devices/api.ts';
import { draftFrom, overridesFrom, reportedFacts } from '../src/devices/Capabilities.tsx';
import { heartbeatText, sortDevices } from '../src/devices/DevicesView.tsx';
import {
  capabilityBlocked,
  capabilityReason,
  capabilitySummary,
  decodeBase64,
  deviceErrorMessage,
  devicePath,
  formatBytes,
  granteeText,
  joinPath,
  parseQuietHours,
  parseUnifiedDiff,
  pathCrumbs,
  pathProblem,
  previewText,
  rolesText,
  tabFrom,
} from '../src/devices/format.ts';
import { mcpServers } from '../src/devices/Mcp.tsx';
import { serviceSuggestions } from '../src/devices/Modules.tsx';
import { policyDraft, policyFrom } from '../src/devices/Policy.tsx';
import { planStepText } from '../src/devices/Power.tsx';
import { parseBundleFile } from '../src/devices/Updates.tsx';
import { base64Text, bundle, deviceView } from './fakes-m6-devices.ts';

const apiErr = (status: number, code: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message: `raw ${code}`, retryable: false, details });

describe('paths and words', () => {
  it('builds device paths and reads the tab from the query', () => {
    expect(devicePath()).toBe('/devices');
    expect(devicePath('d 1')).toBe('/devices/d%201');
    expect(devicePath('d1', 'capabilities')).toBe('/devices/d1');
    expect(devicePath('d1', 'files')).toBe('/devices/d1?tab=files');
    expect(tabFrom('?tab=power')).toBe('power');
    expect(tabFrom('?tab=nope')).toBe('capabilities');
    expect(tabFrom('')).toBe('capabilities');
  });

  it('names roles, grantees and capabilities', () => {
    expect(rolesText(['client', 'wake-helper', 'other'])).toBe('Client, Wake helper, other');
    expect(rolesText([])).toBe('No role');
    expect(granteeText({ kind: 'user', id: 'a1' })).toBe('You');
    expect(granteeText({ kind: 'agent', id: 'ag1' }, () => 'Scout')).toBe('Agent Scout');
    expect(granteeText({ kind: 'agent', id: 'ag1' }, () => null)).toBe('Agent ag1');
    expect(granteeText({ kind: 'run', id: 'r9' })).toBe('Work run r9');
    const old = deviceView({ novadVersion: '0.6.0' });
    const cu = old.capabilities.find((c) => c.name === 'computer_use')!;
    expect(capabilityReason(cu)).toBe('Needs novad 0.7.0');
    const capture = old.capabilities.find((c) => c.name === 'capture')!;
    expect(capabilityReason(capture)).toBe('No capture module');
    expect(capabilitySummary(old)).toBe(
      'Files, Staged writes, Commands, Local MCP servers, Power, Services, Updates · 2 need an update',
    );
    const fenced = deviceView({ policy: { allowedModules: ['management'] } });
    expect(capabilityReason(fenced.capabilities.find((c) => c.name === 'files')!)).toBe(
      'Storage module not allowed by policy',
    );
  });

  it('says why a capability cannot be used now', () => {
    expect(capabilityBlocked(deviceView({ status: 'unreachable' }), 'files')).toBe(
      'The device is offline.',
    );
    expect(capabilityBlocked(deviceView({ status: 'pending' }), 'files')).toBe(
      'The device has not connected yet.',
    );
    expect(capabilityBlocked(deviceView({ status: 'revoked' }), 'files')).toBe(
      'This device was revoked.',
    );
    expect(capabilityBlocked(deviceView({ novadVersion: '0.6.1' }), 'browser')).toBe(
      'Needs novad 0.7.0; this device has 0.6.1.',
    );
    expect(capabilityBlocked(deviceView(), 'capture')).toBe('This device has no capture module.');
    expect(
      capabilityBlocked(deviceView({ policy: { allowedModules: ['storage'] } }), 'power'),
    ).toBe("The management module is not allowed by this device's policy.");
    expect(capabilityBlocked(deviceView(), 'files')).toBeNull();
  });

  it('sorts revoked devices last and words the heartbeat', () => {
    const a = deviceView({ name: 'A', status: 'revoked' });
    const b = deviceView({ name: 'B' });
    expect(sortDevices([a, b]).map((d) => d.name)).toEqual(['B', 'A']);
    const now = Date.parse('2026-10-01T12:05:00Z');
    expect(heartbeatText({ lastSeenAt: '2026-10-01T12:00:00Z' }, now)).toBe(
      'last heartbeat 5 min ago',
    );
    expect(heartbeatText({ lastSeenAt: null }, now)).toBe('no heartbeat yet');
  });

  it('formats sizes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
    expect(formatBytes(null)).toBe('unknown size');
  });
});

describe('error messages', () => {
  it('turns device reasons into plain words', () => {
    expect(deviceErrorMessage(apiErr(503, 'node_unavailable', { reason: 'unreachable' }))).toBe(
      'The device is offline. Try again when it reconnects.',
    );
    expect(
      deviceErrorMessage(
        apiErr(400, 'capability_missing', {
          reason: 'update_required',
          minVersion: '0.7.0',
          novadVersion: '0.6.0',
        }),
      ),
    ).toBe('This device needs novad 0.7.0 for that (it has 0.6.0).');
    expect(
      deviceErrorMessage(apiErr(429, 'rate_limited', { reason: 'wake_rate_limited', limit: 6 })),
    ).toBe('This device was woken 6 times in the last hour, the most allowed. Try again later.');
    expect(deviceErrorMessage(apiErr(403, 'policy_denied', { reason: 'protected_path' }))).toBe(
      'That path is protected and is never shared or written.',
    );
    expect(
      deviceErrorMessage(
        apiErr(403, 'policy_denied', { reason: 'module_not_allowed', module: 'screen' }),
      ),
    ).toBe("The screen module is not allowed by this device's policy.");
    expect(deviceErrorMessage(apiErr(409, 'conflict'))).toBe('raw conflict');
    expect(deviceErrorMessage(new Error('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
    expect(deviceErrorMessage('x', 'Fallback')).toBe('Fallback');
  });
});

describe('quiet hours, paths and previews', () => {
  it('parses quiet hours', () => {
    expect(parseQuietHours('22:00-07:00, 12:00 - 13:00\n')).toEqual({
      ranges: ['22:00-07:00', '12:00-13:00'],
    });
    expect(parseQuietHours('')).toEqual({ ranges: [] });
    expect(parseQuietHours('22:00-07:00, 25:00-01:00')).toEqual({ bad: '25:00-01:00' });
  });

  it('checks and joins device paths', () => {
    expect(pathProblem('')).toBe('Enter a folder path.');
    expect(pathProblem('notes')).toMatch(/full path/);
    expect(pathProblem('/home/../etc')).toMatch(/\. or \.\./);
    expect(pathProblem('/home/sam')).toBeNull();
    expect(pathProblem('C:\\Users\\sam')).toBeNull();
    expect(joinPath('/home/sam', 'a.txt')).toBe('/home/sam/a.txt');
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(joinPath('C:\\Users', 'sam')).toBe('C:\\Users\\sam');
    expect(pathCrumbs('/home/sam/notes', '/home/sam/notes/a/b')).toEqual([
      { label: '/home/sam/notes', path: '/home/sam/notes' },
      { label: 'a', path: '/home/sam/notes/a' },
      { label: 'b', path: '/home/sam/notes/a/b' },
    ]);
    expect(pathCrumbs('/home/sam/', '/home/sam')).toEqual([
      { label: '/home/sam', path: '/home/sam' },
    ]);
    expect(pathCrumbs('C:\\Work', 'C:\\Work\\x')).toEqual([
      { label: 'C:\\Work', path: 'C:\\Work' },
      { label: 'x', path: 'C:\\Work\\x' },
    ]);
  });

  it('previews text and refuses binary', () => {
    expect(previewText(decodeBase64(base64Text('héllo\nworld')))).toBe('héllo\nworld');
    expect(previewText(decodeBase64(base64Text('a\u0000b')))).toBeNull();
  });

  it('parses unified diffs', () => {
    expect(
      parseUnifiedDiff(
        '--- a/x\n+++ b/x\n@@ -1 +1 @@\n keep\n-old\n+new\n\\ No newline at end of file\n',
      ),
    ).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'same', text: 'keep' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'meta', text: 'No newline at end of file' },
    ]);
  });
});

describe('capabilities, policy and updates', () => {
  it('round-trips Hub overrides and reports bad fields', () => {
    const draft = draftFrom({
      models: { cacheQuotaBytes: 2 * 1024 ** 3, storagePaths: ['/mnt/a', '/mnt/b'] },
      scheduling: { quietHours: ['22:00-07:00'] },
    });
    expect(draft['models.cacheQuotaBytes']).toBe('2');
    expect(draft['models.storagePaths']).toBe('/mnt/a\n/mnt/b');
    expect(draft['scheduling.quietHours']).toBe('22:00-07:00');
    expect(overridesFrom(draft)).toEqual({
      ok: true,
      value: {
        models: { cacheQuotaBytes: 2 * 1024 ** 3, storagePaths: ['/mnt/a', '/mnt/b'] },
        scheduling: { quietHours: ['22:00-07:00'] },
      },
    });
    const bad = overridesFrom({
      ...draft,
      'computePolicy.maxConcurrentJobs': '1.5',
      'power.thermalLimitC': '200',
      'models.storagePaths': 'relative/path',
      'scheduling.quietHours': 'late',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(Object.keys(bad.errors).sort()).toEqual([
        'computePolicy.maxConcurrentJobs',
        'models.storagePaths',
        'power.thermalLimitC',
        'scheduling.quietHours',
      ]);
    expect(overridesFrom({})).toEqual({ ok: true, value: {} });
  });

  it('reads the detected facts', () => {
    const facts = Object.fromEntries(reportedFacts(deviceView().capability));
    expect(facts.Processor).toBe('x86_64, 8 cores');
    expect(facts.Memory).toBe('16 GB');
    expect(facts.GPUs).toBe('RTX 4070 (12 GB)');
    expect(facts.Sandbox).toBe('bubblewrap');
    expect(facts['Time zone']).toBe('Europe/Lisbon');
    expect(reportedFacts(null)).toEqual([]);
    expect(Object.fromEntries(reportedFacts({ os: { sandbox: {} } })).Sandbox).toMatch(/refused/);
  });

  it('round-trips the policy and checks its limits', () => {
    const d = policyDraft({
      routingEligible: false,
      allowedModules: ['management'],
      quietHours: ['22:00-07:00'],
      resourceCaps: { memoryBytes: 512 * 1024 * 1024 },
    });
    expect(d).toMatchObject({ routingEligible: false, memoryMiB: '512', cpuSeconds: '' });
    expect(policyFrom(d)).toEqual({
      ok: true,
      value: {
        routingEligible: false,
        allowedModules: ['management'],
        quietHours: ['22:00-07:00'],
        resourceCaps: { memoryBytes: 512 * 1024 * 1024 },
      },
    });
    const bad = policyFrom({ ...d, memoryMiB: '10', openFiles: 'many', quietHours: '9-5' });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(Object.keys(bad.errors).sort()).toEqual(['memoryMiB', 'openFiles', 'quietHours']);
  });

  it('reads update bundle files', () => {
    expect(parseBundleFile(JSON.stringify(bundle('novad', '0.8.0')))).toHaveLength(1);
    expect(
      parseBundleFile(
        JSON.stringify({ bundles: [bundle('storage', '0.8.0'), bundle('novad', '0.8.0')] }),
      ),
    ).toHaveLength(2);
    expect(() => parseBundleFile('not json')).toThrow(/not JSON/);
    expect(() => parseBundleFile(JSON.stringify({ manifest: {} }))).toThrow(/not a signed update/);
  });

  it('reads what the device says about power, services and MCP servers', () => {
    expect(planStepText({ kind: 'command', argv: ['ethtool', '-s', 'eth0', 'wol', 'g'] })).toBe(
      'ethtool -s eth0 wol g',
    );
    expect(planStepText('Enable WoL in the firmware')).toBe('Enable WoL in the firmware');
    expect(planStepText({ description: 'Reboot' })).toBe('Reboot');
    expect(planStepText(null)).toBe('');
    expect(serviceSuggestions(deviceView())).toEqual(['compute', 'llama.cpp']);
    expect(serviceSuggestions(deviceView({ capability: null }))).toEqual(['compute']);
    expect(
      mcpServers([
        { name: 'notes', tools: [{ name: 'search', description: 'Find notes' }, { bad: 1 }, 7] },
        { name: '' },
        { tools: [] },
      ]),
    ).toEqual([{ name: 'notes', tools: [{ name: 'search', description: 'Find notes' }] }]);
  });
});

describe('the Hub client calls (apps/hub/src/devices.ts)', () => {
  it('maps every call onto its route', async () => {
    const calls: [string, string, unknown][] = [];
    const call = <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push([method, path, body]);
      return Promise.resolve({} as T);
    };
    const api = devicesApi(call);
    await api.listNovadDevices();
    await api.enrollNovadDevice({ roles: ['client'] });
    await api.getNovadDevice('d 1');
    await api.updateNovadDevice('d1', { name: 'X' });
    await api.revokeNovadDevice('d1');
    await api.getDeviceCapabilities('d1');
    await api.deviceModuleAction('d1', 'storage', 'rollback');
    await api.deviceServiceAction('d1', 'llama.cpp', 'status');
    await api.getDevicePower('d1');
    await api.devicePowerAction('d1', { action: 'wol-plan' });
    await api.wakeDevice('d1');
    await api.listDeviceUpdates('d1');
    await api.pushDeviceUpdates('d1', { bundles: [] });
    await api.listDeviceFiles('d1', '/home/sam notes');
    await api.readDeviceFile('d1', '/a.txt', 1024);
    await api.readDeviceFile('d1', '/a.txt');
    await api.listDeviceGrants('d1');
    await api.createDeviceGrant('d1', {
      kind: 'mcp',
      grantee: { kind: 'agent', id: 'ag1' },
      server: 'notes',
    });
    await api.revokeDeviceGrant('d1', 'g1');
    await api.requestDeviceAccess('d1', { path: '/x' });
    await api.listStagedWrites('d1', { status: 'staged' });
    await api.listStagedWrites('d1');
    await api.getStagedWrite('d1', 's1');
    await api.commitStagedWrite('d1', 's1');
    await api.discardStagedWrite('d1', 's1');
    await api.listDeviceMcp('d1');
    await api.listDeviceConnections({ deviceId: 'd1' });
    await api.connectDevice({ agentId: 'ag1', deviceId: 'd1' });
    await api.disconnectDevice('c1');
    await api.listDeviceAgentChoices();
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/v1/devices/novad',
      'POST /api/v1/devices/novad/enroll',
      'GET /api/v1/devices/d%201',
      'PATCH /api/v1/devices/d1',
      'POST /api/v1/devices/d1/revoke',
      'GET /api/v1/devices/d1/capabilities',
      'POST /api/v1/devices/d1/modules/storage/rollback',
      'POST /api/v1/devices/d1/services/llama.cpp/status',
      'GET /api/v1/devices/d1/power',
      'POST /api/v1/devices/d1/power',
      'POST /api/v1/devices/d1/wake',
      'GET /api/v1/devices/d1/updates',
      'POST /api/v1/devices/d1/updates',
      'GET /api/v1/devices/d1/files?path=%2Fhome%2Fsam+notes',
      'GET /api/v1/devices/d1/files/content?path=%2Fa.txt&maxBytes=1024',
      'GET /api/v1/devices/d1/files/content?path=%2Fa.txt',
      'GET /api/v1/devices/d1/grants',
      'POST /api/v1/devices/d1/grants',
      'DELETE /api/v1/devices/d1/grants/g1',
      'POST /api/v1/devices/d1/access-requests',
      'GET /api/v1/devices/d1/staged?status=staged',
      'GET /api/v1/devices/d1/staged',
      'GET /api/v1/devices/d1/staged/s1',
      'POST /api/v1/devices/d1/staged/s1/commit',
      'POST /api/v1/devices/d1/staged/s1/discard',
      'GET /api/v1/devices/d1/mcp',
      'GET /api/v1/devices/connections?deviceId=d1',
      'POST /api/v1/devices/connections',
      'DELETE /api/v1/devices/connections/c1',
      'GET /api/v1/agents',
    ]);
    expect(calls[1]![2]).toEqual({ roles: ['client'] });
    expect(calls[9]![2]).toEqual({ action: 'wol-plan' });
  });
});
