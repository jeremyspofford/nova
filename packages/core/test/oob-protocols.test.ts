// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// Out-of-band protocol pieces (FR-147, ADR-096 D6): BMC address parsing, the pinned Redfish
// transport and client against a fake BMC on 127.0.0.1 (pin on first use, a different certificate
// refused before any HTTP byte, redirects refused, timeouts, credentials), the IPMI adapter
// against a fake ipmitool (password only through the environment), and the BIOS matrix and plans.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNovaError, type NovaError } from '@nova/shared';
import { ProcessMeshRunner } from '../src/network/mesh/runner.ts';
import {
  bmcIpProblem,
  classifyIp,
  hostPort,
  hubOwnAddresses,
  parseOobAddress,
  resolveBmcAddress,
} from '../src/oob/address.ts';
import { biosSettings, biosVendorFor, planBios, OOB_REDFISH_BIOS_MATRIX } from '../src/oob/bios.ts';
import { IpmiAdapter, ipmiFields, parseSdrList } from '../src/oob/ipmi.ts';
import {
  OobTransportError,
  RedfishClient,
  peerPin,
  pinnedRequest,
  redfishPath,
  redfishServiceRoot,
  tlsRedfishTransport,
} from '../src/oob/redfish.ts';
import { startFakeRedfish, type FakeBmc } from './fixtures/oob/fake-redfish.ts';
import { fakeIpmi } from './fixtures/oob/ipmi.ts';

async function failure(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('BMC addresses', () => {
  it('accepts host names, IP literals, ports and a bare https URL for Redfish', () => {
    expect(parseOobAddress('bmc1.lab.example', 'redfish')).toEqual({
      host: 'bmc1.lab.example',
      port: null,
    });
    expect(parseOobAddress('BMC-2:8443', 'redfish')).toEqual({ host: 'bmc-2', port: 8443 });
    expect(parseOobAddress('10.0.0.5', 'ipmi')).toEqual({ host: '10.0.0.5', port: null });
    expect(parseOobAddress('fd00::5', 'ipmi')).toEqual({ host: 'fd00::5', port: null });
    expect(parseOobAddress('[fd00::5]:623', 'ipmi')).toEqual({ host: 'fd00::5', port: 623 });
    expect(parseOobAddress('https://10.0.0.9/', 'redfish')).toEqual({
      host: '10.0.0.9',
      port: null,
    });
    expect(parseOobAddress('https://[fd00::9]:8443/redfish/v1', 'redfish')).toEqual({
      host: 'fd00::9',
      port: 8443,
    });
    expect(hostPort('fd00::9', 443)).toBe('[fd00::9]:443');
    expect(hostPort('bmc', 443)).toBe('bmc:443');
  });

  it.each([
    ['https://root:calvin@10.0.0.9', 'redfish', 'credentials_in_address'],
    ['root@10.0.0.9', 'ipmi', 'credentials_in_address'],
    ['http://10.0.0.9', 'redfish', 'bad_address'],
    ['https://10.0.0.9', 'ipmi', 'bad_address'],
    ['https://10.0.0.9/admin', 'redfish', 'bad_address'],
    ['https://10.0.0.9/?x=1', 'redfish', 'bad_address'],
    ['10.0.0.9/redfish', 'redfish', 'bad_address'],
    ['bmc lab', 'redfish', 'bad_address'],
    ['0.0.0.0', 'ipmi', 'address_not_allowed'],
    ['239.1.1.1', 'ipmi', 'address_not_allowed'],
    ['ff02::1', 'ipmi', 'address_not_allowed'],
    ['::', 'ipmi', 'address_not_allowed'],
    ['127.0.0.1', 'ipmi', 'address_not_allowed'],
    ['127.8.9.10:623', 'ipmi', 'address_not_allowed'],
    ['::1', 'ipmi', 'address_not_allowed'],
    ['[::ffff:127.0.0.1]:443', 'redfish', 'address_not_allowed'],
    ['::ffff:7f00:1', 'redfish', 'address_not_allowed'],
    ['64:ff9b::7f00:1', 'redfish', 'address_not_allowed'],
    ['169.254.169.254', 'redfish', 'address_not_allowed'],
    ['fe80::1', 'ipmi', 'address_not_allowed'],
    ['localhost', 'ipmi', 'address_not_allowed'],
    ['bmc.localhost', 'ipmi', 'address_not_allowed'],
    ['https://0x7f000001/', 'redfish', 'address_not_allowed'],
    ['https://2130706433', 'redfish', 'address_not_allowed'],
    ['https://0177.0.0.1', 'redfish', 'address_not_allowed'],
    ['0x7f000001', 'ipmi', 'bad_address'],
    ['2130706433', 'ipmi', 'bad_address'],
    ['0177.0.0.1', 'ipmi', 'bad_address'],
    ['bmc.0x1', 'ipmi', 'bad_address'],
    ['bmc.12', 'ipmi', 'bad_address'],
    ['bmc:0', 'ipmi', 'bad_address'],
    ['bmc:70000', 'ipmi', 'bad_address'],
    ['bmc_1', 'ipmi', 'bad_address'],
    ['1.2.3', 'ipmi', 'bad_address'],
    ['[10.0.0.1]:623', 'ipmi', 'bad_address'],
    ['fd00::zz', 'ipmi', 'bad_address'],
    ['ftp://bmc', 'redfish', 'bad_address'],
    ['https://', 'redfish', 'bad_address'],
  ] as const)('refuses %s (%s)', (raw, kind, reason) => {
    let err: unknown;
    try {
      parseOobAddress(raw, kind);
    } catch (e) {
      err = e;
    }
    expect(isNovaError(err) && err.code === 'validation' && err.details?.reason).toBe(reason);
  });
});

describe('BMC addresses: the Hub itself and resolution', () => {
  const own = () => ({ addresses: new Set(['10.9.9.9', 'fd00::9']), names: new Set(['hubhost']) });

  it('refuses the Hub own addresses and name; tests may let loopback through', () => {
    for (const raw of ['10.9.9.9', '[fd00::9]:443', 'hubhost', 'HUBHOST:443']) {
      let err: unknown;
      try {
        parseOobAddress(raw, 'redfish', { own });
      } catch (e) {
        err = e;
      }
      expect(isNovaError(err) && err.details).toMatchObject({
        reason: 'address_not_allowed',
        kind: 'hub',
      });
    }
    expect(parseOobAddress('10.9.9.8', 'redfish', { own }).host).toBe('10.9.9.8');
    expect(parseOobAddress('127.0.0.1', 'ipmi', { own, allowLoopback: true }).host).toBe(
      '127.0.0.1',
    );
    expect(bmcIpProblem('::1', { own, allowLoopback: true })).toBeNull();
    expect(bmcIpProblem('169.254.1.1', { own, allowLoopback: true })).toBe('link_local');
    expect(classifyIp('10.0.0.1')).toBe('ok');
    expect(classifyIp('2001:db8::1')).toBe('ok');
    expect(classifyIp('::0.0.0.7')).toBe('unspecified');
    expect(classifyIp('fe80::1%eth0')).toBe('link_local');
    expect(classifyIp('not-an-ip')).toBe('unspecified');
    // The default reads this machine's interfaces: its loopback is among them.
    expect(hubOwnAddresses().addresses.has('127.0.0.1')).toBe(true);
  });

  it('checks every address a name resolves to, at connect time', async () => {
    const resolve = (map: Record<string, string[]>) => (h: string) =>
      map[h] ? Promise.resolve(map[h]) : Promise.reject(new Error('ENOTFOUND'));
    const r = resolve({
      'bmc.lab': ['10.1.1.1', 'fd00::1'],
      'evil.lab': ['10.1.1.1', '127.0.0.1'],
      'self.lab': ['10.9.9.9'],
      'empty.lab': [],
    });
    expect(await resolveBmcAddress('bmc.lab', { own }, r)).toBe('10.1.1.1');
    expect(await resolveBmcAddress('10.2.2.2', { own }, r)).toBe('10.2.2.2');
    expect((await failure(resolveBmcAddress('evil.lab', { own }, r))).details).toMatchObject({
      reason: 'address_not_allowed',
      kind: 'loopback',
    });
    expect((await failure(resolveBmcAddress('self.lab', { own }, r))).details?.kind).toBe('hub');
    expect((await failure(resolveBmcAddress('10.9.9.9', { own }, r))).code).toBe('policy_denied');
    for (const h of ['empty.lab', 'gone.lab'])
      expect((await failure(resolveBmcAddress(h, { own }, r))).details?.reason).toBe(
        'bmc_unreachable',
      );
  });
});

describe('the pinned Redfish transport', () => {
  let bmc: FakeBmc;
  beforeEach(async () => {
    bmc = await startFakeRedfish();
  });
  afterEach(async () => {
    await bmc.close();
  });

  it('reads the certificate pin with a handshake only', async () => {
    expect(await peerPin(bmc.host, bmc.port, 5000)).toBe(bmc.pin);
    expect(bmc.requests).toEqual([]);
  });

  it('sends a request only on a connection with the pinned certificate', async () => {
    const root = await redfishServiceRoot(tlsRedfishTransport, {
      host: bmc.host,
      port: bmc.port,
      pin: bmc.pin,
    });
    expect(root.Vendor).toBe('Dell');
    const old = bmc.pin;
    bmc.rotateCertificate();
    const err = await pinnedRequest({
      host: bmc.host,
      port: bmc.port,
      pin: old,
      method: 'GET',
      path: '/redfish/v1/Systems',
      headers: { authorization: 'Basic c2VjcmV0' },
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OobTransportError);
    expect((err as OobTransportError).failure).toBe('tls_pin_mismatch');
    expect((err as OobTransportError).presented).toBe(bmc.pin);
    // Only the first (service root) request ever reached HTTP; the credentials never left.
    expect(bmc.requests.map((r) => r.path)).toEqual(['/redfish/v1']);
  });

  it('maps a refused connection, a timeout and an oversized answer', async () => {
    const closed = await startFakeRedfish();
    const port = closed.port;
    await closed.close();
    await expect(peerPin('127.0.0.1', port, 2000)).rejects.toMatchObject({
      failure: 'unreachable',
    });
    bmc.state.delayMs = 1500;
    await expect(
      pinnedRequest({
        host: bmc.host,
        port: bmc.port,
        pin: bmc.pin,
        method: 'GET',
        path: '/redfish/v1',
        headers: {},
        timeoutMs: 200,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ failure: 'timeout' });
    bmc.state.delayMs = 0;
    await expect(
      pinnedRequest({
        host: bmc.host,
        port: bmc.port,
        pin: bmc.pin,
        method: 'GET',
        path: '/redfish/v1',
        headers: {},
        timeoutMs: 2000,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ failure: 'too_large' });
    await expect(peerPin('127.0.0.1', bmc.port, 1)).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('the client sends Basic credentials, refuses redirects and maps BMC errors', async () => {
    const client = new RedfishClient({
      host: bmc.host,
      port: bmc.port,
      pin: bmc.pin,
      credentials: { username: 'root', password: 'calvin-secret-9' },
    });
    const sys = await client.get('/redfish/v1/Systems/System.Embedded.1');
    expect(sys.json.PowerState).toBe('On');
    expect(sys.etag).toBe('W/"1"');
    bmc.state.redirectSystems = true;
    const redirect = await failure(client.get('/redfish/v1/Systems'));
    expect(redirect.details?.reason).toBe('redirect_refused');
    expect((await failure(client.get('/redfish/v1/Nope'))).details?.reason).toBe('bmc_not_found');
    expect(
      (await failure(client.patch('/redfish/v1/Systems/System.Embedded.1', {}, 'W/"99"'))).details
        ?.reason,
    ).toBe('bmc_precondition_failed');
    expect(
      (
        await failure(
          client.post('/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset', {
            ResetType: 'Nope',
          }),
        )
      ).details?.reason,
    ).toBe('bmc_refused');
    const wrong = new RedfishClient({
      host: bmc.host,
      port: bmc.port,
      pin: bmc.pin,
      credentials: { username: 'root', password: 'wrong' },
    });
    expect((await failure(wrong.get('/redfish/v1/Systems'))).details?.reason).toBe(
      'bmc_auth_failed',
    );
    const pinned = new RedfishClient({
      host: bmc.host,
      port: bmc.port,
      pin: '0'.repeat(64),
      credentials: { username: 'root', password: 'calvin-secret-9' },
    });
    const mismatch = await failure(pinned.get('/redfish/v1/Systems'));
    expect(mismatch.code).toBe('policy_denied');
    expect(mismatch.details).toMatchObject({ reason: 'tls_pin_mismatch', presented: bmc.pin });
    expect(
      bmc.requests.filter((r) => r.sentCredentials && !r.authorized).map((r) => r.path),
    ).toEqual(['/redfish/v1/Systems']);
  });

  it('accepts only Redfish paths on the same BMC', () => {
    expect(redfishPath('/redfish/v1/Systems/1/Bios/Settings')).toBe(
      '/redfish/v1/Systems/1/Bios/Settings',
    );
    for (const bad of [
      'https://evil/redfish/v1',
      '/other',
      '/redfish/v1/../x',
      '/redfish/v1//x',
      7,
    ])
      expect(() => redfishPath(bad)).toThrow();
  });

  it('refuses a service root that is not Redfish', async () => {
    bmc.state.delayMs = 0;
    const transport = {
      ...tlsRedfishTransport,
      request: () => Promise.resolve({ status: 200, headers: {}, text: '[1]' }),
    };
    expect(
      (await failure(redfishServiceRoot(transport, { host: 'h', port: 1, pin: 'x' }))).details
        ?.reason,
    ).toBe('not_redfish');
    const notFound = {
      ...tlsRedfishTransport,
      request: () => Promise.resolve({ status: 404, headers: {}, text: '' }),
    };
    expect(
      (await failure(redfishServiceRoot(notFound, { host: 'h', port: 1, pin: 'x' }))).details
        ?.reason,
    ).toBe('not_redfish');
  });
});

describe('the IPMI adapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-oob-ipmi-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const target = (password = 'ipmi-secret-7') => ({
    host: '127.0.0.1',
    port: null,
    credentials: { username: 'admin', password },
  });

  it('reads the chassis, powers, reads sensors and sets a one-time boot device', async () => {
    const fake = fakeIpmi(dir);
    const ipmi = new IpmiAdapter({ runner: fake.runner });
    expect((await ipmi.chassisStatus(target())).powerState).toBe('on');
    await ipmi.power(target(), 'off');
    expect(await ipmi.powerStatus(target())).toBe('off');
    const sensors = await ipmi.sensors(target());
    expect(sensors).toEqual([
      { name: 'CPU Temp', kind: 'temperature', reading: 45, unit: 'degrees C', health: 'ok' },
      { name: 'FAN1', kind: 'fan', reading: 3600, unit: 'RPM', health: 'ok' },
      { name: '12V', kind: 'voltage', reading: 12.1, unit: 'Volts', health: 'warning' },
      { name: 'PS1 Status', kind: 'other', reading: null, unit: null, health: 'unknown' },
    ]);
    await ipmi.bootNext(target(), 'pxe', 'uefi');
    expect(fake.state().bootOptions).toEqual(['options=efiboot']);
    expect(await ipmi.bootFlags(target())).toBe('Force PXE');
    await expect(ipmi.bootNext(target(), 'usb')).rejects.toMatchObject({
      code: 'capability_missing',
    });
    // The password went through the environment every time, never on the command line.
    const calls = fake.state().calls;
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.passwordFromEnv).toBe(true);
      expect(c.argv).not.toContain('ipmi-secret-7');
      expect(c.argv.slice(0, 6)).toEqual(['-I', 'lanplus', '-H', '127.0.0.1', '-p', '623']);
      expect(c.argv).toContain('-E');
    }
  });

  it('maps a refused session, a hang and a missing program', async () => {
    const fake = fakeIpmi(dir);
    const ipmi = new IpmiAdapter({ runner: fake.runner, timeoutMs: 1500 });
    expect((await failure(ipmi.powerStatus(target('wrong')))).details?.reason).toBe(
      'bmc_session_failed',
    );
    fake.set({ hang: true });
    expect((await failure(ipmi.powerStatus(target()))).details?.reason).toBe('bmc_timeout');
    const missing = new IpmiAdapter({
      runner: new ProcessMeshRunner({ searchPath: [join(dir, 'nothing-here')] }),
    });
    const err = await failure(missing.powerStatus(target()));
    expect(err.code).toBe('capability_missing');
    expect(err.details?.reason).toBe('ipmitool_missing');
  });

  it('parses ipmitool output', () => {
    expect(ipmiFields(' - Boot Device Selector : Force PXE\nSystem Power : off\nnoise')).toEqual({
      'Boot Device Selector': 'Force PXE',
      'System Power': 'off',
    });
    expect(parseSdrList('bad line\n| x | y\nFan | 10 RPM | cr\n')).toEqual([
      { name: 'Fan', kind: 'fan', reading: 10, unit: 'RPM', health: 'critical' },
    ]);
  });
});

describe('the Redfish BIOS matrix', () => {
  const dell = OOB_REDFISH_BIOS_MATRIX.find((v) => v.vendor === 'dell')!;
  const attrs = { ProcVirtualization: 'Enabled', SecureBoot: 'Enabled', AcPwrRcvry: 'Last' };

  it('finds supported vendors and refuses the rest with the reason', () => {
    expect(biosVendorFor([null, 'Dell Inc.'])).toEqual({ entry: dell });
    expect(biosVendorFor(['HPE'])).toMatchObject({ entry: { vendor: 'hpe' } });
    expect(biosVendorFor(['Supermicro'])).toMatchObject({
      entry: null,
      reason: expect.stringContaining('Supermicro'),
    });
    expect(biosVendorFor(['Contoso'])).toMatchObject({
      entry: null,
      reason: expect.stringContaining('not in the BIOS support matrix'),
    });
    expect(biosVendorFor([undefined, ''])).toMatchObject({
      entry: null,
      reason: 'the BMC does not name its vendor',
    });
  });

  it('lists only allowlisted settings the BMC has', () => {
    const s = biosSettings(dell, { ...attrs, SysPassword: 'x' }, { AcPwrRcvry: 'On' });
    expect(s.map((x) => x.key)).toEqual(['virtualization', 'secureBoot', 'powerOnAfterPowerLoss']);
    expect(s.find((x) => x.key === 'powerOnAfterPowerLoss')).toMatchObject({
      value: 'Last',
      pending: 'On',
    });
    expect(JSON.stringify(s)).not.toContain('SysPassword');
  });

  it('plans: unsupported, not allowed, unchanged and security-degrading changes are refused', () => {
    const p = planBios(
      dell,
      attrs,
      [
        { key: 'virtualization', value: 'Disabled' },
        { key: 'wol', value: 'Enabled' },
        { key: 'tpm', value: 'Off' },
        { key: 'powerOnAfterPowerLoss', value: 'Sometimes' },
        { key: 'secureBoot', value: 'Disabled' },
      ],
      false,
    );
    expect(p.diff).toEqual([
      {
        key: 'virtualization',
        vendorKey: 'ProcVirtualization',
        from: 'Enabled',
        to: 'Disabled',
        securityDegrading: false,
      },
    ]);
    expect(p.refused).toEqual([
      { key: 'wol', reason: 'unsupported' },
      { key: 'tpm', reason: 'unsupported' },
      { key: 'powerOnAfterPowerLoss', reason: 'not_allowed_value' },
      { key: 'secureBoot', reason: 'security_degrading' },
    ]);
    const allowed = planBios(
      dell,
      attrs,
      [
        { key: 'secureBoot', value: 'Disabled' },
        { key: 'virtualization', value: 'Enabled' },
      ],
      true,
    );
    expect(allowed.diff).toEqual([
      {
        key: 'secureBoot',
        vendorKey: 'SecureBoot',
        from: 'Enabled',
        to: 'Disabled',
        securityDegrading: true,
      },
    ]);
    expect(allowed.refused).toEqual([{ key: 'virtualization', reason: 'unchanged' }]);
    expect(allowed.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(planBios(dell, { ...attrs }, [], false).snapshot.sha256).toBe(allowed.snapshot.sha256);
  });
});

describe('failure mapping', () => {
  it('a server that does not speak TLS is a TLS failure, not a pin question', async () => {
    const plain = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const port = (plain.address() as AddressInfo).port;
    try {
      await expect(peerPin('127.0.0.1', port, 2000)).rejects.toMatchObject({
        failure: 'tls_failed',
      });
      const err = await failure(
        redfishServiceRoot(tlsRedfishTransport, { host: '127.0.0.1', port, pin: 'x' }, 2000),
      );
      expect(err.details?.reason).toBe('bmc_tls_failed');
    } finally {
      plain.closeAllConnections();
      await new Promise((r) => plain.close(r));
    }
  });

  it('maps every answer the client can get', async () => {
    const answer = (status: number, text: string, headers = {}) => ({
      ...tlsRedfishTransport,
      request: () => Promise.resolve({ status, headers, text }),
    });
    const client = (t: ReturnType<typeof answer>) =>
      new RedfishClient({
        host: 'h',
        port: 1,
        pin: 'p',
        credentials: { username: 'u', password: 'secret-pass-1' },
        transport: t,
      });
    const reasonOf = async (p: Promise<unknown>) => (await failure(p)).details?.reason;
    expect(
      await reasonOf(client(answer(500, '{"error":{"message":"boom"}}')).get('/redfish/v1/X')),
    ).toBe('bmc_error');
    expect(await reasonOf(client(answer(400, 'plain words')).post('/redfish/v1/X', {}))).toBe(
      'bmc_refused',
    );
    expect(await reasonOf(client(answer(200, 'not json')).get('/redfish/v1/X'))).toBe(
      'bad_response',
    );
    expect(await reasonOf(client(answer(200, '[1]')).get('/redfish/v1/X'))).toBe('bad_response');
    const odata = await client(answer(200, '{"@odata.etag":"W/\\"7\\""}')).get('/redfish/v1/X');
    expect(odata.etag).toBe('W/"7"');
    expect((await client(answer(204, '')).get('/redfish/v1/X')).json).toEqual({});
    const refused = await failure(
      client(
        answer(400, '{"error":{"@Message.ExtendedInfo":[{"Message":"bad value secret-pass-1"}]}}'),
      ).post('/redfish/v1/X', {}),
    );
    expect(refused.message).toContain('bad value');
    expect(refused.message).not.toContain('secret-pass-1');
    const throwing = (e: unknown) => ({
      ...tlsRedfishTransport,
      request: () => Promise.reject(e instanceof Error ? e : new Error(String(e))),
    });
    expect(
      await reasonOf(client(throwing(new OobTransportError('timeout', 't'))).get('/redfish/v1/X')),
    ).toBe('bmc_timeout');
    expect(
      await reasonOf(
        redfishServiceRoot(throwing(new OobTransportError('tls_pin_mismatch', 'm', 'abc')), {
          host: 'h',
          port: 1,
          pin: 'p',
        }),
      ),
    ).toBe('tls_pin_mismatch');
    expect(
      await reasonOf(
        redfishServiceRoot(throwing(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })), {
          host: 'h',
          port: 1,
          pin: 'p',
        }),
      ),
    ).toBe('bmc_unreachable');
    expect(
      await reasonOf(redfishServiceRoot(answer(301, ''), { host: 'h', port: 1, pin: 'p' })),
    ).toBe('redirect_refused');
    expect(
      await reasonOf(redfishServiceRoot(answer(200, 'nope'), { host: 'h', port: 1, pin: 'p' })),
    ).toBe('not_redfish');
  });

  it('maps ipmitool failures', async () => {
    const runner = (
      r: Partial<{
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        error: string | null;
      }>,
    ) => ({
      run: () =>
        Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...r }),
    });
    const t = { host: 'h', port: 6230, credentials: { username: 'u', password: 'secret-pass-2' } };
    const reasonOf = async (a: IpmiAdapter) => (await failure(a.powerStatus(t))).details?.reason;
    expect(await reasonOf(new IpmiAdapter({ runner: runner({ error: 'spawn EACCES' }) }))).toBe(
      'bmc_error',
    );
    const other = await failure(
      new IpmiAdapter({
        runner: runner({ code: 1, stderr: 'Invalid command secret-pass-2' }),
      }).powerStatus(t),
    );
    expect(other.details?.reason).toBe('bmc_error');
    expect(other.message).not.toContain('secret-pass-2');
    expect(
      (await failure(new IpmiAdapter({ runner: runner({ code: 2 }) }).powerStatus(t))).message,
    ).toContain('exit 2');
    expect(parseSdrList('PSU | 120 Watts | ok\nX | 3 Amps | ok')).toMatchObject([
      { kind: 'power' },
      { kind: 'other' },
    ]);
    expect(
      parseSdrList(Array.from({ length: 250 }, (_, i) => `S${i} | 1 RPM | ok`).join('\n')),
    ).toHaveLength(200);
  });
});
