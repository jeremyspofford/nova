// The agent distribution area (FR-133, docs/22 §4.3): the signed novad manifest and its
// signature, the public dist route serving only listed builds, and the one-line bootstrap
// command (hashes from the manifest, hostile input refused or inert, and the command itself run
// in sh against this Hub with a stand-in novad).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpStatusFor, isNovaError } from '@nova/shared';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  hubOrigin,
  manifestSignedBytes,
  normalizeCode,
  parseBuildName,
  psQuote,
  setupAgentDist,
  shQuote,
  type AgentDistArea,
  type AgentDistDeps,
  type HubSigner,
} from '../src/agent-dist.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const keys = generateKeyPairSync('ed25519');
const rawPublic = Buffer.from(
  (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
);
const FINGERPRINT = createHash('sha256').update(rawPublic).digest('base64url');
const identity: HubSigner = {
  fingerprint: FINGERPRINT,
  publicKey: rawPublic.toString('base64url'),
  sign: (bytes) => sign(null, bytes, keys.privateKey),
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let dir: string;
let dist: string;
let app: FastifyInstance;
let area: AgentDistArea;
let diagnostics: DiagnosticsRegistry;
let clock: number;

function makeArea(deps: AgentDistDeps = {}): AgentDistArea {
  diagnostics = new DiagnosticsRegistry();
  const ctx = {
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
  } as unknown as HubContext;
  return setupAgentDist(ctx, { distDir: dist, now: () => new Date(clock), ...deps });
}

async function serve(a: AgentDistArea): Promise<FastifyInstance> {
  const f = Fastify();
  f.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  a.register(f);
  await f.ready();
  return f;
}

const BUILDS: Record<string, string> = {
  'novad-linux-amd64': 'linux amd64 build',
  'novad-linux-arm64': 'linux arm64 build',
  'novad-darwin-arm64': 'darwin arm64 build',
  'novad-windows-amd64.exe': 'windows amd64 build',
};

beforeEach(async () => {
  clock = Date.parse('2026-10-17T15:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'nova-agent-dist-'));
  dist = join(dir, 'dist');
  mkdirSync(dist);
  for (const [name, body] of Object.entries(BUILDS)) writeFileSync(join(dist, name), body);
  // Not builds: wrong arch, Windows without .exe, .exe on Linux, other files, a directory.
  writeFileSync(join(dist, 'novad-linux-386'), 'x');
  writeFileSync(join(dist, 'novad-windows-arm64'), 'x');
  writeFileSync(join(dist, 'novad-linux-amd64.exe'), 'x');
  writeFileSync(join(dist, 'README'), 'x');
  writeFileSync(join(dist, 'novad-linux-amd64.sha256'), 'x');
  mkdirSync(join(dist, 'novad-darwin-amd64'));
  writeFileSync(join(dist, 'VERSION'), '0.6.5\n');
  writeFileSync(join(dir, 'secret.txt'), 'outside the dist folder');
  area = makeArea();
  area.useHubIdentity(() => identity);
  app = await serve(area);
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the signed manifest', () => {
  it('lists the builds and is signed by the Hub identity', async () => {
    const { manifest, bytes, signature } = await area.manifest();
    expect(manifest).toEqual({
      version: '0.6.5',
      files: [
        {
          name: 'novad-darwin-arm64',
          os: 'darwin',
          arch: 'arm64',
          sha256: sha(BUILDS['novad-darwin-arm64']!),
          size: 18,
        },
        {
          name: 'novad-linux-amd64',
          os: 'linux',
          arch: 'amd64',
          sha256: sha(BUILDS['novad-linux-amd64']!),
          size: 17,
        },
        {
          name: 'novad-linux-arm64',
          os: 'linux',
          arch: 'arm64',
          sha256: sha(BUILDS['novad-linux-arm64']!),
          size: 17,
        },
        {
          name: 'novad-windows-amd64.exe',
          os: 'windows',
          arch: 'amd64',
          sha256: sha(BUILDS['novad-windows-amd64.exe']!),
          size: 19,
        },
      ],
      hubFingerprint: FINGERPRINT,
      signedAt: '2026-10-17T15:00:00.000Z',
    });
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(manifest);
    expect(
      verify(null, manifestSignedBytes(bytes), keys.publicKey, Buffer.from(signature!, 'base64')),
    ).toBe(true);
    // Domain-separated: the signature does not cover the bare bytes.
    expect(verify(null, bytes, keys.publicKey, Buffer.from(signature!, 'base64'))).toBe(false);
    expect(manifestSignedBytes(bytes).subarray(0, 23).toString()).toBe('nova-novad-manifest-v1\n');
    // The public key the trust area publishes verifies it too (what novad does).
    const fromRaw = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey },
      format: 'jwk',
    });
    expect(
      verify(null, manifestSignedBytes(bytes), fromRaw, Buffer.from(signature!, 'base64')),
    ).toBe(true);
    const tampered = Buffer.from(bytes.toString('utf8').replace('0.6.5', '0.6.6'));
    expect(
      verify(
        null,
        manifestSignedBytes(tampered),
        keys.publicKey,
        Buffer.from(signature!, 'base64'),
      ),
    ).toBe(false);
  });

  it('is stable until the builds change, then rescanned and re-signed', async () => {
    const first = await area.manifest();
    clock += 60_000;
    const again = await area.manifest();
    expect(again.bytes.equals(first.bytes)).toBe(true);
    expect(again.signature).toBe(first.signature);
    writeFileSync(join(dist, 'novad-darwin-amd64.tmp'), 'ignored');
    rmSync(join(dist, 'novad-darwin-amd64'), { recursive: true });
    writeFileSync(join(dist, 'novad-darwin-amd64'), 'darwin amd64 build');
    const changed = await area.manifest();
    expect(changed.manifest.files.map((f) => f.name)).toContain('novad-darwin-amd64');
    expect(changed.manifest.signedAt).toBe('2026-10-17T15:01:00.000Z');
    expect(
      verify(
        null,
        manifestSignedBytes(changed.bytes),
        keys.publicKey,
        Buffer.from(changed.signature!, 'base64'),
      ),
    ).toBe(true);
    // Concurrent callers share one scan.
    const [a, b] = await Promise.all([area.manifest(), area.manifest()]);
    expect(a).toBe(b);
  });

  it('accepts a signature returned as base64url text', async () => {
    const a = makeArea();
    a.useHubIdentity(() =>
      Promise.resolve({
        ...identity,
        sign: (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64url'),
      }),
    );
    const m = await a.manifest();
    expect(
      verify(
        null,
        manifestSignedBytes(m.bytes),
        keys.publicKey,
        Buffer.from(m.signature!, 'base64'),
      ),
    ).toBe(true);
    const bad = makeArea();
    bad.useHubIdentity(() => ({ ...identity, sign: () => new Uint8Array(10) }));
    expect((await bad.manifest()).signature).toBeNull();
    // An identity that is not loaded yet (its getters throw), then one that cannot sign once.
    let loaded = false;
    let failures = 1;
    const lazy = makeArea();
    lazy.useHubIdentity(() => ({
      get fingerprint(): string {
        if (!loaded) throw new Error('the Hub identity is not loaded yet');
        return identity.fingerprint;
      },
      publicKey: identity.publicKey,
      sign: (bytes: Uint8Array) => {
        if (failures-- > 0) throw new Error('vault locked');
        return sign(null, bytes, keys.privateKey);
      },
    }));
    expect((await lazy.manifest()).manifest.hubFingerprint).toBeNull();
    loaded = true;
    const first = await lazy.manifest();
    expect(first.manifest.hubFingerprint).toBe(FINGERPRINT);
    expect(first.signature).toBeNull();
    const retried = await lazy.manifest();
    expect(
      verify(
        null,
        manifestSignedBytes(retried.bytes),
        keys.publicKey,
        Buffer.from(retried.signature!, 'base64'),
      ),
    ).toBe(true);
  });

  it('is empty without builds and unsigned without an identity', async () => {
    const none = makeArea({ distDir: null });
    none.useHubIdentity(() => identity);
    expect((await none.manifest()).manifest.files).toEqual([]);
    expect((await none.manifest()).signature).not.toBeNull();
    const missing = makeArea({ distDir: join(dir, 'nope') });
    expect((await missing.manifest()).manifest).toMatchObject({
      files: [],
      version: null,
      hubFingerprint: null,
    });
    const unsigned = makeArea();
    const m = await unsigned.manifest();
    expect(m.signature).toBeNull();
    expect(m.manifest.hubFingerprint).toBeNull();
    const f = await serve(unsigned);
    expect((await f.inject({ url: `/api/v1/agent/dist/${SIGNATURE_FILE}` })).statusCode).toBe(404);
    expect((await f.inject({ url: `/api/v1/agent/dist/${MANIFEST_FILE}` })).statusCode).toBe(200);
    await f.close();
    const probe = (await diagnostics.collect()).agentDist as Record<string, unknown>;
    expect(probe).toMatchObject({ configured: true, signed: false, version: '0.6.5' });
  });

  it('names only real build files', () => {
    expect(parseBuildName('novad-linux-amd64')).toEqual({ os: 'linux', arch: 'amd64' });
    expect(parseBuildName('novad-windows-arm64.exe')).toEqual({ os: 'windows', arch: 'arm64' });
    for (const bad of [
      'novad-windows-arm64',
      'novad-linux-amd64.exe',
      'novad-linux-386',
      'novad-freebsd-amd64',
      '../novad-linux-amd64',
      'novad-linux-amd64/',
      'xnovad-linux-amd64',
    ])
      expect(parseBuildName(bad)).toBeNull();
  });
});

describe('GET /api/v1/agent/dist/:file', () => {
  it('serves the manifest, its signature and listed builds', async () => {
    const m = await app.inject({ url: `/api/v1/agent/dist/${MANIFEST_FILE}` });
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toContain('application/json');
    expect(m.headers['cache-control']).toBe('no-store');
    const s = await app.inject({ url: `/api/v1/agent/dist/${SIGNATURE_FILE}` });
    expect(s.statusCode).toBe(200);
    expect(
      verify(
        null,
        manifestSignedBytes(m.rawPayload),
        keys.publicKey,
        Buffer.from(s.body, 'base64'),
      ),
    ).toBe(true);
    const b = await app.inject({ url: '/api/v1/agent/dist/novad-linux-arm64' });
    expect(b.statusCode).toBe(200);
    expect(b.body).toBe(BUILDS['novad-linux-arm64']);
    expect(b.headers['content-length']).toBe('17');
    expect(b.headers['content-type']).toBe('application/octet-stream');
    expect(b.headers['content-disposition']).toBe('attachment; filename="novad-linux-arm64"');
    expect(b.headers['cache-control']).toBe('no-store');
    expect(sha(b.rawPayload)).toBe(
      JSON.parse(m.body).files.find((f: { name: string }) => f.name === 'novad-linux-arm64').sha256,
    );
    const exe = await app.inject({ url: '/api/v1/agent/dist/novad-windows-amd64.exe' });
    expect(exe.body).toBe(BUILDS['novad-windows-amd64.exe']);
    const head = await app.inject({ method: 'HEAD', url: '/api/v1/agent/dist/novad-linux-amd64' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('17');
    expect(head.body).toBe('');
  });

  it('refuses everything else, including traversal', async () => {
    symlinkSync(join(dir, 'secret.txt'), join(dist, 'novad-linux-386-link'));
    for (const name of [
      'novad-linux-386',
      'novad-windows-arm64',
      'novad-linux-amd64.exe',
      'novad-darwin-amd64',
      'novad-linux-386-link',
      'README',
      'VERSION',
      'novad-linux-amd64.sha256',
      '..%2Fsecret.txt',
      '..%2F..%2Fdist%2Fnovad-linux-amd64',
      '%2e%2e',
      'novad-linux-amd64%00',
      'novad-linux-amd64%2F',
      encodeURIComponent(join(dist, 'novad-linux-amd64')),
      'x'.repeat(100),
    ]) {
      const r = await app.inject({ url: `/api/v1/agent/dist/${name}` });
      expect(r.statusCode, name).toBe(404);
      expect(r.body).not.toContain('outside the dist folder');
    }
    // Past the router's parameter limit.
    expect((await app.inject({ url: `/api/v1/agent/dist/${'x'.repeat(200)}` })).statusCode).toBe(
      414,
    );
    expect((await app.inject({ url: '/api/v1/agent/dist/../secret.txt' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/agent/dist/' })).statusCode).toBe(404);
  });

  it('limits requests per client address', async () => {
    const limited = makeArea({ rateLimit: { limit: 3, windowMs: 60_000 } });
    limited.useHubIdentity(() => identity);
    const f = await serve(limited);
    const get = (url: string, remoteAddress = '192.168.1.20') =>
      f.inject({ url: `/api/v1/agent/dist/${url}`, remoteAddress });
    for (let i = 0; i < 3; i++) expect((await get(MANIFEST_FILE)).statusCode).toBe(200);
    const over = await get('novad-linux-amd64');
    expect(over.statusCode).toBe(429);
    expect(over.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'address_rate_limited',
    );
    expect((await get('no-such-file')).statusCode).toBe(429);
    // Another address has its own budget; the window slides.
    expect((await get(MANIFEST_FILE, '192.168.1.21')).statusCode).toBe(200);
    clock += 60_001;
    expect((await get('novad-linux-amd64')).statusCode).toBe(200);
    await f.close();
  });

  it('stops serving a build that disappears', async () => {
    rmSync(join(dist, 'novad-linux-amd64'));
    expect((await app.inject({ url: '/api/v1/agent/dist/novad-linux-amd64' })).statusCode).toBe(
      404,
    );
    const m = await app.inject({ url: `/api/v1/agent/dist/${MANIFEST_FILE}` });
    expect(m.body).not.toContain('novad-linux-amd64');
  });
});

describe('the bootstrap command', () => {
  const PAIRING = '0192abcd-0000-7000-8000-000000000001';

  it('downloads the right build, checks its hash and runs novad install', async () => {
    const out = await area.bootstrap(
      'compute',
      'abcd-efgh',
      'http://hub.lan:7419/',
      FINGERPRINT,
      PAIRING,
    );
    expect(out.why).toBeNull();
    const cmd = out.command!;
    for (const name of ['novad-linux-amd64', 'novad-linux-arm64', 'novad-darwin-arm64'])
      expect(cmd).toContain(`h=${sha(BUILDS[name]!)};;`);
    expect(cmd).toContain('Linux-x86_64|Linux-amd64) a=linux-amd64;');
    expect(cmd).toContain('Darwin-arm64) a=darwin-arm64;');
    expect(cmd).not.toContain('Darwin-x86_64');
    expect(cmd).not.toContain(sha(BUILDS['novad-windows-amd64.exe']!));
    expect(cmd).toContain(`'http://hub.lan:7419/api/v1/agent/dist/novad-'"$a"`);
    expect(cmd).not.toContain(' -c -');
    // The code is piped to novad by the shell's printf builtin, never an argument.
    expect(cmd).toContain(
      `printf '%s\\n' 'ABCD-EFGH' | $s "$d/novad" install --code - --hub 'http://hub.lan:7419' --pairing '${PAIRING}' --pin '${FINGERPRINT}' --role 'compute'`,
    );
    expect(cmd).not.toContain('--code ABCD');
    expect(cmd).not.toContain(`--code 'ABCD`);
    expect(cmd).not.toContain('\n');
    const ps = out.powershell!;
    expect(ps).toContain(`'amd64' = '${sha(BUILDS['novad-windows-amd64.exe']!)}'`);
    expect(ps).toContain(`$env:NOVA_ADD_CODE = 'ABCD-EFGH'`);
    expect(ps).toContain(
      `& $f install --hub 'http://hub.lan:7419' --pairing '${PAIRING}' --pin '${FINGERPRINT}' --role 'compute'`,
    );
    expect(ps).not.toContain('--code');
    expect(ps).toContain('Remove-Item Env:NOVA_ADD_CODE');
    expect(ps).toContain('Get-FileHash -Algorithm SHA256');
  });

  it('pins the identity that signed the manifest and always names the pairing', async () => {
    // Without an explicit fingerprint the pin is the identity that signed the manifest.
    const out = await area.bootstrap(
      'client',
      'ABCD-EFGH',
      'http://192.168.1.10:7419',
      undefined,
      PAIRING,
    );
    expect(out.command).toContain(
      `install --code - --hub 'http://192.168.1.10:7419' --pairing '${PAIRING}' --pin '${FINGERPRINT}' --role 'client'`,
    );
    // No pairing id, no command (review finding 4: the code alone must not find a pairing).
    const without = await area.bootstrap('client', 'ABCD-EFGH', 'http://192.168.1.10:7419');
    expect(without.command).toBeNull();
    expect(without.why).toContain('pairing id');
    const unsigned = makeArea();
    expect(
      (await unsigned.bootstrap('client', 'ABCD-EFGH', 'http://hub.lan', undefined, PAIRING)).why,
    ).toContain('no identity');
  });

  it('builds the command for an https Hub, checking the hash instead of the certificate', async () => {
    const r = await area.bootstrap(
      'compute',
      'ABCD-EFGH',
      'https://hub.lan:7443',
      FINGERPRINT,
      PAIRING,
    );
    expect(r.why).toBeNull();
    // novad gets the https Hub to verify by its pin; the download skips only the certificate check.
    expect(r.command).toContain("'https://hub.lan:7443/api/v1/agent/dist/novad-'");
    expect(r.command).toContain('curl -fsSLk');
    expect(r.command).toContain('wget --no-check-certificate -qO');
    expect(r.command).toContain('the download is not the Hub');
    expect(r.command).toContain('--hub');
    // A plain http Hub keeps the certificate checks off the table entirely (nothing to skip).
    const plain = await area.bootstrap(
      'compute',
      'ABCD-EFGH',
      'http://hub.lan',
      FINGERPRINT,
      PAIRING,
    );
    expect(plain.command).not.toContain('-fsSLk');
    expect(plain.powershell ?? '').not.toContain('ServerCertificateValidationCallback');
  });

  it('puts PowerShell 5.1’s certificate callback back after the https download', async () => {
    const r = await area.bootstrap(
      'compute',
      'ABCD-EFGH',
      'https://hub.lan:7443',
      FINGERPRINT,
      PAIRING,
    );
    const ps = r.powershell!;
    const at = (s: string) => {
      const i = ps.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Saved first, switched off only inside try, around the download, restored in finally.
    const save = at('$cb = [Net.ServicePointManager]::ServerCertificateValidationCallback');
    const tryAt = at(
      'try { if ($set) { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }',
    );
    const download = at('Invoke-WebRequest @k');
    const restore = at(
      'finally { if ($set) { [Net.ServicePointManager]::ServerCertificateValidationCallback = $cb } }',
    );
    expect(save < tryAt && tryAt < download && download < restore).toBe(true);
    // Nowhere else is it set, and the hash check comes after the restore.
    expect(ps.split('ServerCertificateValidationCallback = { $true }')).toHaveLength(2);
    expect(at('Get-FileHash -Algorithm SHA256')).toBeGreaterThan(restore);
    expect(ps).toContain('SkipCertificateCheck = $true');
  });

  it('is null with the reason when it cannot work', async () => {
    const why = async (...a: Parameters<AgentDistArea['bootstrap']>) => {
      const r = await area.bootstrap(...a);
      expect(r.command).toBeNull();
      expect(r.powershell).toBeNull();
      return r.why ?? '';
    };
    expect(await why('compute', 'ABCD-EFGH', 'ftp://hub.lan', FINGERPRINT, PAIRING)).toContain(
      'https://',
    );
    expect(
      await why('compute', 'ABCD-EFGH', 'http://127.0.0.1:7419', FINGERPRINT, PAIRING),
    ).toContain('loopback');
    expect(
      await why('compute', 'ABCD-EFGH', 'http://localhost:7419', FINGERPRINT, PAIRING),
    ).toContain('loopback');
    expect(await why('compute', 'ABCD-EFGH', 'http://[::1]:7419', FINGERPRINT, PAIRING)).toContain(
      'loopback',
    );
    expect(await why('compute', 'ABCD-EFGH', 'http://hub.lan', null, PAIRING)).toContain(
      'no identity',
    );
    expect(await why('compute', 'ABCD-EFGH', 'http://hub.lan', 'x'.repeat(43), PAIRING)).toContain(
      'not signed',
    );
    expect(await why('hub', 'ABCD-EFGH', 'http://hub.lan', FINGERPRINT, PAIRING)).toContain('role');
    const none = makeArea({ distDir: null });
    none.useHubIdentity(() => identity);
    expect(
      (await none.bootstrap('client', 'ABCD-EFGH', 'http://hub.lan', FINGERPRINT, PAIRING)).why,
    ).toContain('no novad builds');
    const unsigned = makeArea();
    expect(
      (await unsigned.bootstrap('client', 'ABCD-EFGH', 'http://hub.lan', FINGERPRINT, PAIRING)).why,
    ).toContain('not signed');
    // Only Windows builds: the PowerShell command alone.
    for (const name of Object.keys(BUILDS)) if (!name.endsWith('.exe')) rmSync(join(dist, name));
    const win = await area.bootstrap('client', 'ABCD-EFGH', 'http://hub.lan', FINGERPRINT, PAIRING);
    expect(win.command).toBeNull();
    expect(win.powershell).toContain('novad-windows-');
    expect(win.why).toContain('Windows');
  });

  it('refuses hostile input instead of quoting it into a command', async () => {
    const hostile: [string, string, string, string][] = [
      ["ABCD'$(touch /tmp/x)", 'http://hub.lan', FINGERPRINT, PAIRING],
      ['ABCD-EFG$', 'http://hub.lan', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', "http://hub.lan'$(id)", FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'http://hub.lan/$(id)', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'http://hub.lan:7419/?x=`id`', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'http://user:pw@hub.lan', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'http://hub.lan"; rm -rf ~; "', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'file:///etc/passwd', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'not a url', FINGERPRINT, PAIRING],
      ['ABCD-EFGH', 'http://hub.lan', `${FINGERPRINT.slice(0, 40)}'$(`, PAIRING],
      ['ABCD-EFGH', 'http://hub.lan', FINGERPRINT, "p'; reboot; '"],
      ['ABCD-EFGH', 'http://hub.lan', FINGERPRINT, ''],
    ];
    for (const [code, url, fp, pairing] of hostile) {
      const r = await area.bootstrap('client', code, url, fp, pairing);
      expect(r.command, `${code} ${url} ${fp} ${pairing}`).toBeNull();
      expect(r.why).toBeTruthy();
    }
    expect(normalizeCode('abcd efgh')).toBe('ABCDEFGH');
    expect(normalizeCode('abcd-oil0')).toBe('ABCD0110');
    expect(normalizeCode('ABCDUFGH')).toBeNull();
    expect(hubOrigin('http://Hub.LAN:7419')).toEqual({ origin: 'http://hub.lan:7419' });
    expect(hubOrigin('http://[fd00::1]:7419')).toEqual({ origin: 'http://[fd00::1]:7419' });
  });

  it('quotes so the shell reads every value literally', () => {
    for (const value of [
      "it's",
      '$(id)',
      '`id`',
      '"; rm -rf ~; "',
      "a'\\''b",
      '\\',
      'line\nbreak',
      '$HOME ~ * ?',
    ]) {
      const r = spawnSync('sh', ['-c', `printf '%s' ${shQuote(value)}`], { encoding: 'utf8' });
      expect(r.stdout).toBe(value);
    }
    expect(psQuote("it's")).toBe("'it''s'");
  });

  describe.skipIf(
    process.platform === 'win32' ||
      spawnSync('sh', [
        '-c',
        '(command -v curl || command -v wget) && (command -v sha256sum || command -v shasum)',
      ]).status !== 0,
  )('run in sh against this Hub', () => {
    let hub: FastifyInstance;
    let bin: string;
    let argsOut: string;

    beforeEach(async () => {
      // A stand-in novad that records its arguments, under every POSIX build name; a sudo that
      // just runs the command, in case the test is not root.
      const script =
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NOVAD_ARGS_OUT"\nread -r code; printf \'%s\' "$code" > "$NOVAD_ARGS_OUT.code"\n';
      for (const name of readdirSync(dist)) rmSync(join(dist, name), { recursive: true });
      for (const name of [
        'novad-linux-amd64',
        'novad-linux-arm64',
        'novad-darwin-amd64',
        'novad-darwin-arm64',
      ])
        writeFileSync(join(dist, name), script);
      bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
      chmodSync(join(bin, 'sudo'), 0o755);
      argsOut = join(dir, 'args.txt');
      const a = makeArea({ allowLoopbackHub: true });
      a.useHubIdentity(() => identity);
      area = a;
      hub = await serve(a);
      await hub.listen({ port: 0, host: '127.0.0.1' });
    });

    afterEach(async () => {
      await hub.close();
    });

    // Asynchronously: the Hub answering the download runs in this process.
    async function run(command: string, path = bin) {
      const tmp = join(dir, 'tmp');
      mkdirSync(tmp, { recursive: true });
      const p = spawn('sh', ['-c', command], {
        env: {
          PATH: `${path}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          NOVAD_ARGS_OUT: argsOut,
          TMPDIR: tmp,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      p.stdout.resume();
      const status = await new Promise<number | null>((done) => p.on('close', done));
      return { status, stderr, leftovers: readdirSync(tmp) };
    }

    it('installs with the arguments intact and cleans up', async () => {
      const { port } = hub.server.address() as { port: number };
      const out = await area.bootstrap(
        'wake-helper',
        'abcd-efgh',
        `http://127.0.0.1:${port}`,
        FINGERPRINT,
        'pair-1',
      );
      const r = await run(out.command!);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(argsOut, 'utf8').split('\n')).toEqual([
        'install',
        '--code',
        '-',
        '--hub',
        `http://127.0.0.1:${port}`,
        '--pairing',
        'pair-1',
        '--pin',
        FINGERPRINT,
        '--role',
        'wake-helper',
        '',
      ]);
      // The code arrived on standard input.
      expect(readFileSync(`${argsOut}.code`, 'utf8')).toBe('ABCD-EFGH');
      expect(r.leftovers).toEqual([]);
    });

    it('refuses a download that is not the signed build', async () => {
      const { port } = hub.server.address() as { port: number };
      const out = await area.bootstrap(
        'client',
        'ABCD-EFGH',
        `http://127.0.0.1:${port}`,
        FINGERPRINT,
        'pair-1',
      );
      // The builds change after the command was shown: its hash no longer matches.
      for (const name of readdirSync(dist))
        writeFileSync(join(dist, name), '#!/bin/sh\ntouch "$NOVAD_ARGS_OUT"\n');
      const r = await run(out.command!);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("not the Hub's signed build");
      expect(existsSync(argsOut)).toBe(false);
      expect(r.leftovers).toEqual([]);
    });

    it('never falls back to a second checksum tool on input the first one used up', async () => {
      // A sha256sum that fails after reading its input, and a shasum whose check mode passes on
      // empty input (as permissive implementations do). Checking with `-c` through a pipe would
      // let a tampered download run; the command computes the hash itself instead.
      const tools = join(dir, 'tools');
      mkdirSync(tools);
      writeFileSync(join(tools, 'sudo'), '#!/bin/sh\nexec "$@"\n');
      writeFileSync(join(tools, 'sha256sum'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
      const realShasum = spawnSync('sh', ['-c', 'command -v shasum'], {
        encoding: 'utf8',
      }).stdout.trim();
      writeFileSync(
        join(tools, 'shasum'),
        `#!/bin/sh\ncase " $* " in *" -c "*) cat >/dev/null; exit 0;; esac\n${realShasum ? `exec ${realShasum} "$@"` : 'exit 1'}\n`,
      );
      for (const t of ['sudo', 'sha256sum', 'shasum']) chmodSync(join(tools, t), 0o755);
      const { port } = hub.server.address() as { port: number };
      const out = await area.bootstrap(
        'client',
        'ABCD-EFGH',
        `http://127.0.0.1:${port}`,
        FINGERPRINT,
        'pair-1',
      );
      for (const name of readdirSync(dist))
        writeFileSync(join(dist, name), '#!/bin/sh\ntouch "$NOVAD_ARGS_OUT"\n');
      const r = await run(out.command!, tools);
      expect(r.status).not.toBe(0);
      expect(existsSync(argsOut)).toBe(false);
      // The same tools with the genuine build: the fallback computes the right hash and runs it.
      if (realShasum) {
        const ok = await area.bootstrap(
          'client',
          'ABCD-EFGH',
          `http://127.0.0.1:${port}`,
          FINGERPRINT,
          'pair-1',
        );
        const r2 = await run(ok.command!, tools);
        expect(r2.status, r2.stderr).toBe(0);
        expect(existsSync(argsOut)).toBe(true);
      }
    });
  });
});
