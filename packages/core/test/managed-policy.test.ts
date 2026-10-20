// The managed policy service (FR-106, docs/12 §10, ADR-097 D4; J10 step 2): a policy that locks
// Bypass mode and network becomes locked settings with source `managed` and restrictions; a file
// that fails its ownership or mode check is ignored and reported; a value that would loosen a
// security setting is ignored for that key and reported; an invalid trusted file fails closed with
// the last good policy kept; the signed remote policy (a bad signature and a rollback refused, the
// cached copy kept across a restart); the more restrictive of two sources; change events.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSetting, type ManagedPolicyDocument } from '@nova/shared';
import {
  ManagedPolicy,
  managedPublicKey,
  managedRestrictions,
  signManagedPolicy,
  type ManagedFetch,
  type ManagedPolicyOptions,
} from '../src/managed/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import { FakeFs } from './managed-fs.ts';

const PATH = '/etc/nova/managed-settings.json';
const URL_ = 'https://policy.corp.example/nova.json';
const keys = generateKeyPairSync('ed25519');
const PIN = managedPublicKey(keys.publicKey);

const LOCK_BYPASS_AND_NETWORK: ManagedPolicyDocument = {
  version: 1,
  settings: { 'appearance.theme': 'dark' },
  restrict: { permissionModes: { deny: ['bypass'] }, egress: { mode: 'off' } },
};

let cacheDir: string;
let fs: FakeFs;
let events: MemoryEventSink;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'nova-managed-cache-'));
  fs = new FakeFs();
  events = new MemoryEventSink();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(cacheDir, { recursive: true, force: true });
});

function policy(extra: Partial<ManagedPolicyOptions> = {}): ManagedPolicy {
  return new ManagedPolicy({
    path: PATH,
    cacheDir,
    fs,
    platform: 'linux',
    hubUid: 1000,
    home: '/home/me',
    events,
    ...extra,
  });
}

function envelope(doc: object): unknown {
  return signManagedPolicy(Buffer.from(JSON.stringify(doc)), keys.privateKey);
}

/** A fetch that answers with whatever `next` holds. */
function remoteServer(): { fetch: ManagedFetch; next: { body: unknown; status: number } } {
  const next = { body: {} as unknown, status: 200 };
  return {
    next,
    fetch: () =>
      next.status === 0
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status })),
  };
}

describe('the local file (J10 step 2)', () => {
  it('locks Bypass and network: locked settings with source managed and restrictions', async () => {
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    const p = policy();
    const view = await p.load();
    expect(view.active).toBe(true);
    expect(view.sources).toEqual([
      expect.objectContaining({ channel: 'local', status: 'active', inForce: true }),
    ]);
    const layer = p.settingsLayer({ 'code.allowBypass': true, 'network.egressMode': 'allowlist' });
    const managed = { global: { 'code.allowBypass': true }, managed: layer };
    expect(resolveSetting('code.allowBypass', managed)).toEqual({
      key: 'code.allowBypass',
      value: false,
      source: 'managed',
      locked: true,
    });
    expect(resolveSetting('network.egressMode', { managed: layer })).toMatchObject({
      value: 'off',
      source: 'managed',
      locked: true,
    });
    // Chats never run without asking: the user's never_ask comes down to review (Auto's).
    expect(resolveSetting('tools.approvalPolicy', { managed: layer }).value).toBe('defaults');
    const chats = p.settingsLayer({ 'tools.approvalPolicy': 'never_ask' });
    expect(resolveSetting('tools.approvalPolicy', { managed: chats }).value).toBe('review');
    expect(resolveSetting('appearance.theme', { managed: layer })).toMatchObject({
      value: 'dark',
      locked: true,
    });
    const restrict = resolveSetting('managed.restrict', { managed: layer });
    expect(restrict.locked).toBe(true);
    const checks = managedRestrictions(restrict.value);
    expect(checks.permissionMode('bypass')).toMatch(/Bypass/);
    expect(checks.egressOff()).toBe(true);
    expect(p.restrictions().permissionMode('bypass')).toMatch(/Bypass/);
    expect(view.settings.find((s) => s.key === 'code.allowBypass')).toEqual({
      key: 'code.allowBypass',
      value: false,
      channel: 'local',
      derivedFrom: 'restrict.permissionModes',
    });
  });

  it('without a file applies nothing but still carries the (empty) restrictions', async () => {
    const p = policy();
    const view = await p.load();
    expect(view.active).toBe(false);
    expect(view.sources[0]).toMatchObject({ status: 'absent', inForce: false });
    expect(p.settingsLayer()).toEqual({ 'managed.restrict': { layers: [], failClosed: null } });
  });

  it('ignores a world-writable file and reports why', async () => {
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK, 0, 0o666);
    const p = policy();
    const view = await p.load();
    expect(view.active).toBe(false);
    expect(view.sources[0]).toMatchObject({
      status: 'ignored',
      problem: 'it is writable by its group or by other users',
      inForce: false,
    });
    expect(p.settingsLayer()['code.allowBypass']).toBeUndefined();
  });

  it("ignores a file owned by the Hub's user and keeps the last good policy", async () => {
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    const p = policy();
    await p.load();
    fs.file(PATH, { version: 1 }, 1000, 0o600);
    const view = await p.reload();
    expect(view.sources[0]).toMatchObject({
      status: 'ignored',
      problem: 'it is owned by the user the Hub runs as, who must not be able to change it',
      inForce: true,
    });
    expect(p.settingsLayer()['code.allowBypass']).toBe(false);
  });

  it('ignores and reports a value that would loosen a security setting, key by key', async () => {
    fs.file(PATH, {
      version: 1,
      settings: {
        'code.allowBypass': true,
        'privacy.telemetry': true,
        'triggers.ratePerHour': 5,
        'relay.url': 'wss://relay.example',
        'routing.allowCloud': 'no',
        'nope.key': 1,
        'managed.restrict': { layers: [], failClosed: null },
        'appearance.theme': 'light',
      },
    });
    const p = policy();
    const view = await p.load();
    const reasons = Object.fromEntries(view.ignored.map((i) => [i.key, i.reason]));
    expect(reasons).toEqual({
      'code.allowBypass': 'loosens',
      'privacy.telemetry': 'loosens',
      'relay.url': 'unordered',
      'routing.allowCloud': 'invalid_value',
      'nope.key': 'unknown_key',
      'managed.restrict': 'unknown_key',
    });
    const layer = p.settingsLayer({ 'triggers.ratePerHour': 3 });
    expect(layer['code.allowBypass']).toBeUndefined();
    expect(layer['privacy.telemetry']).toBeUndefined();
    // A tighter user value stays: the policy only tightens.
    expect(layer['triggers.ratePerHour']).toBe(3);
    expect(p.settingsLayer()['triggers.ratePerHour']).toBe(5);
    expect(layer['appearance.theme']).toBe('light');
  });

  it('locks app registration, the crash report address and the purge days, ignoring bad values', async () => {
    fs.file(PATH, {
      version: 1,
      settings: {
        'apps.openRegistration': false,
        'privacy.crashReportEndpoint': '',
        'team.removedMemberPurgeDays': 7,
      },
    });
    const p = policy();
    await p.load();
    const user = {
      'apps.openRegistration': true,
      'privacy.crashReportEndpoint': 'https://mine.example/crash',
      'team.removedMemberPurgeDays': 365,
    };
    const layer = p.settingsLayer(user);
    for (const [key, value] of [
      ['apps.openRegistration', false],
      ['privacy.crashReportEndpoint', ''],
      ['team.removedMemberPurgeDays', 7],
    ] as const)
      expect(resolveSetting(key, { global: user, managed: layer }), key).toMatchObject({
        value,
        source: 'managed',
        locked: true,
      });
    // A value that would loosen (crash reports to a plain-http address elsewhere) or that the
    // setting refuses is ignored for that key and reported; the user's value stays, unlocked.
    fs.file(PATH, {
      version: 1,
      settings: {
        'privacy.crashReportEndpoint': 'http://collector.example/crash',
        'team.removedMemberPurgeDays': -1,
        'apps.openRegistration': 'yes',
      },
    });
    const view = await p.reload();
    expect(view.ignored.map((i) => [i.key, i.reason])).toEqual([
      ['privacy.crashReportEndpoint', 'invalid_value'],
      ['team.removedMemberPurgeDays', 'invalid_value'],
      ['apps.openRegistration', 'invalid_value'],
    ]);
    const after = p.settingsLayer(user);
    expect(
      resolveSetting('privacy.crashReportEndpoint', { global: user, managed: after }),
    ).toMatchObject({ value: 'https://mine.example/crash', locked: false });
  });

  it('meets security values with the user value and reports Manual mode', async () => {
    fs.file(PATH, {
      version: 1,
      settings: { 'network.egressAllow': ['a.example', 'b.example'] },
      restrict: {
        permissionModes: { allow: ['plan'] },
        egress: { mode: 'limited', deny: ['x.example'] },
        telemetryExport: false,
        routing: { allowCloud: false },
        sessions: { ssh: false },
        apps: false,
        unverifiedInstalls: false,
      },
    });
    const p = policy();
    const view = await p.load();
    expect(view.ignored).toEqual([expect.objectContaining({ reason: 'manual_mode' })]);
    const layer = p.settingsLayer({
      'network.egressMode': 'off',
      'network.egressAllow': ['b.example', 'c.example'],
      'network.egressDeny': ['y.example'],
    });
    expect(layer['network.egressMode']).toBe('off');
    // The allow list is a ceiling, never a locked value: the owner's hosts within it apply.
    expect(layer['network.egressAllow']).toBeUndefined();
    expect(
      managedRestrictions(layer['managed.restrict']).egressAllow(['b.example', 'c.example']),
    ).toEqual(['b.example']);
    expect(layer['network.egressDeny']).toEqual(['x.example', 'y.example']);
    expect(layer['tools.approvalPolicy']).toBe('defaults');
    expect(layer['telemetry.otlp.enabled']).toBe(false);
    expect(layer['routing.allowCloud']).toBe(false);
    expect(layer['code.ssh.enabled']).toBe(false);
    expect(layer['apps.enabled']).toBe(false);
    expect(layer['mcpServer.enabled']).toBe(false);
    expect(layer['market.allowSideload']).toBe(false);
    // Any egress restriction takes away the cloud runner's unrestricted network.
    expect(
      p.settingsLayer({ 'cloud.runner.unrestrictedNetwork': true })[
        'cloud.runner.unrestrictedNetwork'
      ],
    ).toBe(false);
  });

  it("treats the egress allow list as a ceiling over the owner's own list (ADR-097)", async () => {
    fs.file(PATH, {
      version: 1,
      restrict: { egress: { mode: 'allowlist', allow: ['api.example.com'] } },
    });
    const p = policy();
    await p.load();
    const inForce = (own?: string[]) => {
      const global = own === undefined ? {} : { 'network.egressAllow': own };
      return {
        restrict: p.settingsLayer(global)['managed.restrict'] as { egressAllow?: string[] },
        view: p.view(global).egress,
      };
    };
    // The owner never set a list: the policy's hosts apply.
    expect(inForce().restrict.egressAllow).toEqual(['api.example.com']);
    expect(inForce([]).view).toEqual({
      ceilings: [['api.example.com']],
      own: [],
      effective: ['api.example.com'],
      note: null,
    });
    expect(p.settingsLayer({})['network.egressAllow']).toBeUndefined();
    // The owner's list: their hosts within the ceiling.
    const both = inForce(['a.example', 'api.example.com']);
    expect(both.restrict.egressAllow).toEqual(['api.example.com']);
    expect(both.view?.note).toMatch(
      /outside your organization's policy and do not apply: a\.example/,
    );
    // None of the owner's hosts is within it: nothing, said plainly.
    const none = inForce(['a.example']);
    expect(none.restrict.egressAllow).toEqual([]);
    expect(none.view?.note).toMatch(/None of the hosts on your own allow list/);
    // A policy's explicit setting joins its source's list: both apply.
    fs.file(PATH, {
      version: 1,
      settings: { 'network.egressAllow': ['*.example.com'] },
      restrict: { egress: { allow: ['api.example.com', 'other.example'] } },
    });
    await p.reload();
    expect(p.view().restrict[0]!.restrict.egress?.allow).toEqual(['api.example.com']);
    expect(p.view().settings.map((s) => s.key)).not.toContain('network.egressAllow');
    fs.file(PATH, { version: 1, settings: { 'network.egressAllow': ['api.example.com'] } });
    await p.reload();
    expect(p.view().restrict).toEqual([
      { channel: 'local', restrict: { egress: { allow: ['api.example.com'] } } },
    ]);
    expect(p.view().egress?.effective).toEqual(['api.example.com']);
    fs.file(PATH, { version: 1 });
    await p.reload();
    expect(p.view().egress).toBeNull();
  });

  it('trusts only pinned publishers while unverified installs are refused', async () => {
    const corp = { name: 'Corp', key: 'C'.repeat(43) };
    const mine = { name: 'Mine', key: 'M'.repeat(43) };
    fs.file(PATH, { version: 1, settings: { 'plugins.trustedPublishers': [corp] } });
    const p = policy();
    await p.load();
    // Otherwise the lists intersect: the policy only narrows the user's.
    expect(
      p.settingsLayer({ 'plugins.trustedPublishers': [corp, mine] })['plugins.trustedPublishers'],
    ).toEqual([corp]);
    expect(
      p.settingsLayer({ 'plugins.trustedPublishers': [mine] })['plugins.trustedPublishers'],
    ).toEqual([]);
    fs.file(PATH, {
      version: 1,
      settings: { 'plugins.trustedPublishers': [corp] },
      restrict: { unverifiedInstalls: false },
    });
    await p.reload();
    expect(
      p.settingsLayer({ 'plugins.trustedPublishers': [mine] })['plugins.trustedPublishers'],
    ).toEqual([corp]);
    fs.file(PATH, { version: 1, restrict: { unverifiedInstalls: false } });
    await p.reload();
    expect(
      p.settingsLayer({ 'plugins.trustedPublishers': [mine] })['plugins.trustedPublishers'],
    ).toEqual([]);
  });

  it('filters tool roots by the folder rules and passes managed hooks through', async () => {
    fs.file(PATH, {
      version: 1,
      settings: { hooks: { hooks: [] } },
      restrict: { folders: { allow: ['~/src'] } },
    });
    const p = policy();
    await p.load();
    const layer = p.settingsLayer({
      'tools.roots': [
        { path: '/home/me/src/app', access: 'write' },
        { path: '/etc', access: 'read' },
      ],
    });
    expect(layer['tools.roots']).toEqual([{ path: '/home/me/src/app', access: 'write' }]);
    expect(layer.hooks).toEqual({ hooks: [] });
    expect(p.view().settings).toEqual([]);
    expect(p.settingsLayer({ 'tools.roots': 'bad' })['tools.roots']).toEqual([]);
  });

  it('fails closed on an invalid trusted file and keeps the last good policy', async () => {
    fs.file(PATH, '{not json');
    const p = policy();
    const first = await p.load();
    expect(first.failClosed).toMatch(
      /policy file \/etc\/nova\/managed-settings.json is invalid: not valid JSON/,
    );
    expect(first.sources[0]).toMatchObject({ status: 'invalid', inForce: false });
    expect(p.restrictions().tool({ name: 'fs.read', source: 'builtin' })).toMatch(
      /could not be read/,
    );
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    expect((await p.reload()).failClosed).toBeNull();
    fs.file(PATH, { version: 1, restrict: { nonsense: true } });
    const broken = await p.reload();
    expect(broken.failClosed).toMatch(/restrict/);
    expect(broken.sources[0]).toMatchObject({ status: 'invalid', inForce: true });
    expect(p.settingsLayer()['code.allowBypass']).toBe(false);
    fs.failing.set(`read:${PATH}`, 'EIO');
    expect((await p.reload()).failClosed).toMatch(/cannot be read/);
  });

  it('drops the policy when the administrator removes the file', async () => {
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    const p = policy({ overrideRefused: 'override ignored' });
    await p.load();
    fs.entries.delete(PATH);
    const view = await p.reload();
    expect(view.active).toBe(false);
    expect(view.sources[0]).toMatchObject({ status: 'absent', problem: 'override ignored' });
  });

  it('layers the test file over the protected one, which it never replaces', async () => {
    const TEST = '/home/me/test-policy.json';
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    // The test file (the Hub's user's) tries to drop the administrator's restrictions.
    fs.file(TEST, { version: 1, restrict: { apps: false } }, 1000, 0o600).dir('/home/me', 1000);
    const p = policy({ testPath: TEST });
    const view = await p.load();
    expect(view.sources.map((s) => [s.channel, s.status, s.testOverride ?? false])).toEqual([
      ['local', 'active', false],
      ['test', 'active', true],
    ]);
    const checks = p.restrictions();
    expect(checks.permissionMode('bypass')).toMatch(/Bypass/);
    expect(checks.egressOff()).toBe(true);
    expect(checks.apps()).toMatch(/apps/);
    // A test file owned by root-only rules still has to pass its own checks.
    fs.file(TEST, { version: 1 }, 1000, 0o666);
    const ignored = await p.reload();
    expect(ignored.sources[1]).toMatchObject({ channel: 'test', status: 'ignored', inForce: true });
  });
});

describe('the signed remote policy', () => {
  const local = (extra: object = {}): ManagedPolicyDocument => ({
    version: 1,
    restrict: { tools: { deny: ['screen.*'] } },
    remote: { url: URL_, publicKey: PIN, ...extra },
  });

  it('applies a verified remote policy on top of the local one, the stricter value winning', async () => {
    fs.file(PATH, {
      ...local(),
      settings: { 'appearance.theme': 'light', 'triggers.ratePerHour': 10 },
    });
    const server = remoteServer();
    server.next.body = envelope({
      version: 1,
      serial: 3,
      settings: { 'appearance.theme': 'dark', 'triggers.ratePerHour': 20 },
      restrict: { tools: { deny: ['exec.*'] } },
    });
    const p = policy({ fetch: server.fetch });
    const view = await p.load();
    expect(view.sources.map((s) => [s.channel, s.status, s.serial])).toEqual([
      ['remote', 'active', 3],
      ['local', 'active', null],
    ]);
    const layer = p.settingsLayer();
    expect(layer['appearance.theme']).toBe('dark');
    expect(layer['triggers.ratePerHour']).toBe(10);
    expect(view.settings.find((s) => s.key === 'triggers.ratePerHour')?.channel).toBe('both');
    const checks = p.restrictions();
    expect(checks.tool({ name: 'screen.capture', source: 'builtin' })).toMatch(/not allowed/);
    expect(checks.tool({ name: 'exec.run', source: 'builtin' })).toMatch(/not allowed/);
    expect(view.restrict.map((r) => r.channel)).toEqual(['remote', 'local']);
  });

  it('refuses a bad signature and keeps the cached copy, also across a restart', async () => {
    fs.file(PATH, local());
    const server = remoteServer();
    server.next.body = envelope({ version: 1, serial: 1, restrict: { apps: false } });
    const p = policy({ fetch: server.fetch });
    await p.load();
    expect(p.restrictions().apps()).toMatch(/apps/);
    // Signed by a key the local file does not pin.
    server.next.body = signManagedPolicy(
      Buffer.from('{"version":1,"serial":2}'),
      generateKeyPairSync('ed25519').privateKey,
    );
    const refused = await p.reload();
    expect(refused.sources[0]).toMatchObject({
      channel: 'remote',
      status: 'refused',
      problem: 'the signature does not match the pinned key',
      inForce: true,
      serial: 1,
    });
    expect(p.restrictions().apps()).toMatch(/apps/);
    // A restart with the policy server down: the cached copy is in force, checked again.
    server.next.status = 0;
    const again = policy({ fetch: server.fetch });
    const view = await again.load();
    expect(view.sources[0]).toMatchObject({
      status: 'unreachable',
      inForce: true,
      cached: true,
      serial: 1,
    });
    expect(again.restrictions().apps()).toMatch(/apps/);
  });

  it('refuses a rollback to an older serial', async () => {
    fs.file(PATH, local());
    const server = remoteServer();
    server.next.body = envelope({ version: 1, serial: 5 });
    const p = policy({ fetch: server.fetch });
    await p.load();
    server.next.body = envelope({
      version: 1,
      serial: 4,
      settings: { 'appearance.theme': 'dark' },
    });
    const view = await p.refreshRemote();
    expect(view.sources[0]).toMatchObject({ status: 'refused', serial: 5 });
    expect(view.sources[0]!.problem).toMatch(/serial 4 is older/);
    expect(p.settingsLayer()['appearance.theme']).toBeUndefined();
  });

  it('fails closed on a signed policy that does not validate, or that names another remote', async () => {
    fs.file(PATH, local());
    const server = remoteServer();
    server.next.body = envelope({ version: 1, restrict: { bogus: 1 } });
    const p = policy({ fetch: server.fetch });
    const view = await p.load();
    expect(view.failClosed).toMatch(/remote policy is invalid/);
    expect(view.sources[0]).toMatchObject({ status: 'invalid', inForce: false });
    server.next.body = envelope({ version: 1, remote: { url: URL_, publicKey: PIN } });
    expect((await p.reload()).failClosed).toMatch(/cannot name another remote/);
  });

  it('ignores a cache made for another key or a tampered cache', async () => {
    fs.file(PATH, local());
    const server = remoteServer();
    server.next.body = envelope({ version: 1, serial: 1, restrict: { apps: false } });
    await policy({ fetch: server.fetch }).load();
    server.next.status = 0;
    const otherPin = managedPublicKey(generateKeyPairSync('ed25519').publicKey);
    fs.file(PATH, local({ publicKey: otherPin }));
    const view = await policy({ fetch: server.fetch }).load();
    expect(view.sources[0]).toMatchObject({ status: 'unreachable', inForce: false });
    const { writeFileSync, readFileSync } = await import('node:fs');
    const file = join(cacheDir, 'remote-policy.json');
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { envelope: { policy: string } };
    cached.envelope.policy = Buffer.from('{"version":1}').toString('base64');
    writeFileSync(file, JSON.stringify(cached));
    fs.file(PATH, local());
    expect((await policy({ fetch: server.fetch }).load()).sources[0]).toMatchObject({
      inForce: false,
    });
  });

  it('refetches on its timer', async () => {
    vi.useFakeTimers();
    fs.file(PATH, local({ refreshMinutes: 5 }));
    const server = remoteServer();
    server.next.body = envelope({ version: 1, serial: 1 });
    const p = policy({ fetch: server.fetch });
    await p.load();
    p.start();
    server.next.body = envelope({ version: 1, serial: 2, restrict: { apps: false } });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    await vi.waitFor(() => expect(p.restrictions().apps()).toMatch(/apps/));
    p.stop();
  });
});

describe('a remote policy that has not verified', () => {
  const pinned = (extra: object = {}): ManagedPolicyDocument => ({
    version: 1,
    remote: { url: URL_, publicKey: PIN, ...extra },
  });

  it('fails closed until the pinned remote policy verifies once', async () => {
    fs.file(PATH, pinned());
    const server = remoteServer();
    server.next.status = 0;
    const p = policy({ fetch: server.fetch });
    const view = await p.load();
    expect(view.failClosed).toMatch(/has not been verified yet/);
    expect(p.restrictions().tool({ name: 'fs.read', source: 'builtin' })).toMatch(
      /could not be read/,
    );
    server.next.status = 200;
    server.next.body = envelope({ version: 1, serial: 1 });
    expect((await p.refreshRemote()).failClosed).toBeNull();
    // Unreachable again: the verified copy stays in force, nothing fails closed.
    server.next.status = 0;
    expect((await p.refreshRemote()).failClosed).toBeNull();
  });

  it('refuses a cached copy or a fetched policy older than minSerial', async () => {
    fs.file(PATH, pinned());
    const server = remoteServer();
    server.next.body = envelope({ version: 1, serial: 3, restrict: { apps: false } });
    await policy({ fetch: server.fetch }).load();
    // The administrator raises the floor: the cached serial 3 no longer counts.
    fs.file(PATH, pinned({ minSerial: 4 }));
    server.next.status = 0;
    const offline = await policy({ fetch: server.fetch }).load();
    expect(offline.sources[0]).toMatchObject({ channel: 'remote', inForce: false });
    expect(offline.failClosed).toMatch(/not been verified/);
    server.next.status = 200;
    const stale = await policy({ fetch: server.fetch }).load();
    expect(stale.sources[0]).toMatchObject({ status: 'refused' });
    expect(stale.sources[0]!.problem).toMatch(/older than 4/);
    server.next.body = envelope({ version: 1, serial: 4 });
    expect((await policy({ fetch: server.fetch }).load()).sources[0]).toMatchObject({
      status: 'active',
      serial: 4,
    });
  });
});

describe('the remote policy going away', () => {
  it('drops the remote policy and its timer when the local file stops naming it', async () => {
    vi.useFakeTimers();
    fs.file(PATH, { version: 1, remote: { url: URL_, publicKey: PIN } });
    const server = remoteServer();
    server.next.body = envelope({ version: 1, restrict: { apps: false } });
    // The cache cannot be written (its folder is a file): the policy still applies.
    const { writeFileSync } = await import('node:fs');
    const blocked = join(cacheDir, 'blocked');
    writeFileSync(blocked, 'x');
    const p = policy({ fetch: server.fetch, cacheDir: blocked, events: undefined });
    p.start();
    await p.load();
    expect(p.restrictions().apps()).toMatch(/apps/);
    fs.file(PATH, { version: 1 });
    const view = await p.reload();
    expect(view.sources.map((s) => s.channel)).toEqual(['local']);
    expect(p.restrictions().apps()).toBeNull();
    p.stop();
  });
});

describe('change events', () => {
  it('announces changes after the first load, with before and after', async () => {
    fs.file(PATH, LOCK_BYPASS_AND_NETWORK);
    const p = policy();
    const seen: number[] = [];
    p.onChange(() => seen.push(1));
    p.onChange(() => {
      throw new Error('a listener that fails');
    });
    await p.load();
    expect(events.names()).toEqual([]);
    fs.file(PATH, { version: 1, settings: { 'appearance.theme': 'light' } });
    await p.reload();
    await vi.waitFor(() =>
      expect(
        events.events.some(
          (e) => e.name === 'settings.changed' && e.payload.key === 'managed.restrict',
        ),
      ).toBe(true),
    );
    expect(events.names()[0]).toBe('managed.policy.changed');
    expect(seen).toEqual([1]);
    const changed = events.events.filter((e) => e.name === 'settings.changed');
    const byKey = Object.fromEntries(changed.map((e) => [e.payload.key, e.payload]));
    expect(byKey['appearance.theme']).toEqual({
      key: 'appearance.theme',
      scope: 'managed',
      before: 'dark',
      after: 'light',
    });
    expect(byKey['code.allowBypass']).toMatchObject({ before: false, after: null });
    expect(byKey['managed.restrict']).toBeDefined();
    // Nothing changed: nothing announced.
    const count = events.events.length;
    await p.reload();
    expect(events.events.length).toBe(count);
  });
});
