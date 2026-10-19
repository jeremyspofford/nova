// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// A fake Redfish BMC for the out-of-band tests (FR-147): HTTPS on 127.0.0.1 with a self-signed
// certificate made in the test with the repo's own X.509 builder (P-256), HTTP Basic credentials,
// a ComputerSystem with power and a one-time boot override, a Bios resource with a pending settings
// object, and a chassis with Thermal and Power. It records every request that reached HTTP, so a
// test can prove that nothing (no credentials) was sent on a connection with the wrong certificate.
// Plain node:https rather than Fastify: Fastify is not a dependency of @nova/core.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { buildCertificate, KEY_USAGE, OID } from '../../../src/trust/x509.ts';

export interface FakeBmcState {
  vendor: string;
  manufacturer: string;
  username: string;
  password: string;
  systems: string[];
  powerState: 'On' | 'Off';
  resetAllowed: string[] | null;
  boot: { enabled: string; target: string; mode: string; allowed: string[] | null };
  bios: boolean;
  attributes: Record<string, string>;
  pending: Record<string, string>;
  applyTimes: string[] | null;
  lastApplyTime: string | null;
  etag: number;
  /** Answer `GET /redfish/v1/Systems` with a redirect elsewhere. */
  redirectSystems: boolean;
  /** The system links its chassis (else only the Chassis collection names it). */
  linkChassis: boolean;
  /** The Bios resource names a pending settings object. */
  settingsObject: boolean;
  /** After a PATCH of the pending settings, reading them back fails (500). */
  failSettingsReadAfterPatch: boolean;
  /** PATCHes of the pending settings received. */
  settingsPatches: number;
  /** Hold every answer this long (timeouts). */
  delayMs: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorized: boolean;
  /** An Authorization header was present (credentials were sent). */
  sentCredentials: boolean;
  body: unknown;
}

export interface FakeBmc {
  host: string;
  port: number;
  /** SHA-256 of the current certificate's DER. */
  pin: string;
  state: FakeBmcState;
  requests: FakeRequest[];
  /** Serve a new self-signed certificate from now on; returns its pin. */
  rotateCertificate(): string;
  close(): Promise<void>;
}

function selfSigned(): { key: string; cert: string; pin: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const name = { commonName: 'fake-bmc', organization: 'Fake BMC' };
  const built = buildCertificate({
    subject: name,
    issuer: name,
    publicKey,
    signer: privateKey,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    keyUsage: KEY_USAGE.digitalSignature,
    extKeyUsage: [OID.serverAuth],
    altNames: { hosts: ['127.0.0.1'] },
  });
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: built.pem,
    pin: createHash('sha256').update(built.der).digest('hex'),
  };
}

export function defaultFakeState(over: Partial<FakeBmcState> = {}): FakeBmcState {
  return {
    vendor: 'Dell',
    manufacturer: 'Dell Inc.',
    username: 'root',
    password: 'calvin-secret-9',
    systems: ['System.Embedded.1'],
    powerState: 'On',
    resetAllowed: ['On', 'ForceOff', 'GracefulShutdown', 'ForceRestart', 'PowerCycle'],
    boot: {
      enabled: 'Disabled',
      target: 'None',
      mode: 'UEFI',
      allowed: ['None', 'Pxe', 'Hdd', 'Cd', 'BiosSetup'],
    },
    bios: true,
    attributes: {
      ProcVirtualization: 'Enabled',
      SecureBoot: 'Enabled',
      TpmSecurity: 'On',
      AcPwrRcvry: 'Last',
      SysPassword: '',
    },
    pending: {},
    applyTimes: ['OnReset'],
    lastApplyTime: null,
    etag: 1,
    redirectSystems: false,
    linkChassis: true,
    settingsObject: true,
    failSettingsReadAfterPatch: false,
    settingsPatches: 0,
    delayMs: 0,
    ...over,
  };
}

const json = (body: unknown) => JSON.stringify(body);

export async function startFakeRedfish(over: Partial<FakeBmcState> = {}): Promise<FakeBmc> {
  const state = defaultFakeState(over);
  const requests: FakeRequest[] = [];
  let tls = selfSigned();
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = text;
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const auth = req.headers.authorization ?? '';
      const expected = `Basic ${Buffer.from(`${state.username}:${state.password}`).toString('base64')}`;
      const authorized = auth === expected;
      requests.push({ method: req.method ?? '', path, authorized, sentCredentials: !!auth, body });
      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        const out = () => {
          res.writeHead(status, {
            ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
          });
          res.end(payload !== undefined ? json(payload) : undefined);
        };
        if (state.delayMs) setTimeout(out, state.delayMs);
        else out();
      };
      handle(state, req.method ?? 'GET', path, authorized, body, req.headers['if-match'], send);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const bmc: FakeBmc = {
    host: '127.0.0.1',
    port,
    pin: tls.pin,
    state,
    requests,
    rotateCertificate() {
      tls = selfSigned();
      server.setSecureContext({ key: tls.key, cert: tls.cert });
      bmc.pin = tls.pin;
      return tls.pin;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return bmc;
}

type Send = (status: number, payload?: unknown, headers?: Record<string, string>) => void;

function handle(
  s: FakeBmcState,
  method: string,
  path: string,
  authorized: boolean,
  body: unknown,
  ifMatch: string | undefined,
  send: Send,
): void {
  const etag = () => `W/"${s.etag}"`;
  if (method === 'GET' && (path === '/redfish/v1' || path === '/redfish/v1/')) {
    send(200, {
      '@odata.id': '/redfish/v1',
      RedfishVersion: '1.11.0',
      Vendor: s.vendor,
      Product: 'Fake BMC',
      Systems: { '@odata.id': '/redfish/v1/Systems' },
      Chassis: { '@odata.id': '/redfish/v1/Chassis' },
    });
    return;
  }
  if (!authorized) {
    send(401, { error: { code: 'Base.1.0.NoValidSession', message: 'unauthorized' } });
    return;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (path === '/redfish/v1/Systems' && method === 'GET') {
    if (s.redirectSystems) {
      send(302, undefined, { location: 'https://elsewhere.invalid/redfish/v1/Systems' });
      return;
    }
    send(200, { Members: s.systems.map((id) => ({ '@odata.id': `/redfish/v1/Systems/${id}` })) });
    return;
  }
  const sys = /^\/redfish\/v1\/Systems\/([^/]+)(\/.*)?$/.exec(path);
  if (sys && s.systems.includes(sys[1] ?? '')) {
    const base = `/redfish/v1/Systems/${sys[1]}`;
    const rest = sys[2] ?? '';
    if (rest === '' && method === 'GET') {
      send(
        200,
        {
          '@odata.id': base,
          Id: sys[1],
          Manufacturer: s.manufacturer,
          PowerState: s.powerState,
          Boot: {
            BootSourceOverrideEnabled: s.boot.enabled,
            BootSourceOverrideTarget: s.boot.target,
            BootSourceOverrideMode: s.boot.mode,
            ...(s.boot.allowed
              ? { 'BootSourceOverrideTarget@Redfish.AllowableValues': s.boot.allowed }
              : {}),
          },
          ...(s.bios ? { Bios: { '@odata.id': `${base}/Bios` } } : {}),
          ...(s.linkChassis
            ? { Links: { Chassis: [{ '@odata.id': '/redfish/v1/Chassis/1' }] } }
            : {}),
          Actions: {
            '#ComputerSystem.Reset': {
              target: `${base}/Actions/ComputerSystem.Reset`,
              ...(s.resetAllowed ? { 'ResetType@Redfish.AllowableValues': s.resetAllowed } : {}),
            },
          },
        },
        { etag: etag() },
      );
      return;
    }
    if (rest === '' && method === 'PATCH') {
      if (ifMatch && ifMatch !== etag()) {
        send(412, { error: { message: 'etag mismatch' } });
        return;
      }
      const boot = (b.Boot ?? {}) as Record<string, string>;
      if (
        boot.BootSourceOverrideTarget &&
        s.boot.allowed &&
        !s.boot.allowed.includes(boot.BootSourceOverrideTarget)
      ) {
        send(400, { error: { message: 'bad target' } });
        return;
      }
      s.boot = {
        ...s.boot,
        enabled: boot.BootSourceOverrideEnabled ?? s.boot.enabled,
        target: boot.BootSourceOverrideTarget ?? s.boot.target,
        mode: boot.BootSourceOverrideMode ?? s.boot.mode,
      };
      s.etag += 1;
      send(204);
      return;
    }
    if (rest === '/Actions/ComputerSystem.Reset' && method === 'POST') {
      const type = typeof b.ResetType === 'string' ? b.ResetType : '';
      if (s.resetAllowed && !s.resetAllowed.includes(type)) {
        send(400, { error: { message: `bad ResetType ${type}` } });
        return;
      }
      s.powerState = type === 'ForceOff' || type === 'GracefulShutdown' ? 'Off' : 'On';
      send(204);
      return;
    }
    if (rest === '/Bios' && method === 'GET' && s.bios) {
      send(200, {
        '@odata.id': `${base}/Bios`,
        Attributes: s.attributes,
        ...(s.settingsObject
          ? {
              '@Redfish.Settings': {
                SettingsObject: { '@odata.id': `${base}/Bios/Settings` },
                ...(s.applyTimes ? { SupportedApplyTimes: s.applyTimes } : {}),
              },
            }
          : {}),
      });
      return;
    }
    if (rest === '/Bios/Settings' && method === 'GET' && s.bios) {
      if (s.failSettingsReadAfterPatch && s.settingsPatches > 0) {
        send(500, { error: { message: 'internal error' } });
        return;
      }
      send(200, { Attributes: s.pending }, { etag: etag() });
      return;
    }
    if (rest === '/Bios/Settings' && method === 'PATCH' && s.bios) {
      if (ifMatch && ifMatch !== etag()) {
        send(412, { error: { message: 'etag mismatch' } });
        return;
      }
      const attrs = (b.Attributes ?? {}) as Record<string, string>;
      s.pending = { ...s.pending, ...attrs };
      const at = b['@Redfish.SettingsApplyTime'] as { ApplyTime?: string } | undefined;
      s.lastApplyTime = at?.ApplyTime ?? null;
      s.settingsPatches += 1;
      s.etag += 1;
      send(204);
      return;
    }
  }
  if (path === '/redfish/v1/Chassis' && method === 'GET') {
    send(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] });
    return;
  }
  if (path === '/redfish/v1/Chassis/1' && method === 'GET') {
    send(200, {
      Thermal: { '@odata.id': '/redfish/v1/Chassis/1/Thermal' },
      Power: { '@odata.id': '/redfish/v1/Chassis/1/Power' },
    });
    return;
  }
  if (path === '/redfish/v1/Chassis/1/Thermal' && method === 'GET') {
    send(200, {
      Temperatures: [
        { Name: 'CPU1 Temp', ReadingCelsius: 47, Status: { Health: 'OK' } },
        { Name: 'Inlet Temp', ReadingCelsius: 24, Status: { Health: 'OK' } },
      ],
      Fans: [{ Name: 'Fan1', Reading: 5400, ReadingUnits: 'RPM', Status: { Health: 'Warning' } }],
    });
    return;
  }
  if (path === '/redfish/v1/Chassis/1/Power' && method === 'GET') {
    send(200, {
      Voltages: [{ Name: 'PS1 Voltage', ReadingVolts: 230, Status: { Health: 'OK' } }],
      PowerControl: [{ Name: 'System Power', PowerConsumedWatts: 182, Status: { Health: 'OK' } }],
    });
    return;
  }
  send(404, { error: { message: `no ${path}` } });
}
