// The real novad binary installing itself from this Hub's dist folder (FR-133, FR-132): the
// manifest is signed here with node:crypto (tagged) and verified in Rust against the pinned
// fingerprint, novad checks its own SHA-256 against it, runs Add Device v2 as kind novad against a
// stand-in for the add-device area (complete with a commitment, a signed reveal answered with the
// Hub-signed confirmation, signed status polls; the real area replaces it when the lead runs the
// end-to-end), then registers through the real devices area with the granted token and the same
// key. The code arrives on standard input. A wrong pin, a binary that is not the signed build, or
// a reveal not signed by the pinned key stops it before anything is written or shown. Runs when
// the binary is built (`node scripts/cargo.mjs build`; or NOVA_NOVAD_BIN).
import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupAgentDist, type AgentDistArea } from '../src/agent-dist.ts';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const BIN =
  process.env.NOVA_NOVAD_BIN ??
  resolve(import.meta.dirname, '../../../services/novad/target/debug/novad');
const runnable =
  existsSync(BIN) &&
  spawnSync(BIN, ['help'], { encoding: 'utf8' }).stdout.includes('--pairing') &&
  (process.platform === 'linux' || process.platform === 'darwin') &&
  (process.arch === 'x64' || process.arch === 'arm64');
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const PAIRING = 'pair-0001';
const CODE = 'ABCDEFGH';

const keys = generateKeyPairSync('ed25519');
const rawPublic = Buffer.from(
  (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
);
const FINGERPRINT = createHash('sha256').update(rawPublic).digest('base64url');

/** Add Device v2 (m65_protocol_v2): the confirmation both sides compute after commit-reveal. */
function confirmation(publicKey: string, deviceNonce: string, hubNonce: string): string {
  const digest = createHash('sha256')
    .update(
      `nova-add-device-v2|${FINGERPRINT}|${PAIRING}|${publicKey}|${CODE}|${deviceNonce}|${hubNonce}`,
    )
    .digest('hex');
  return (BigInt(`0x${digest}`) % 1_000_000n).toString().padStart(6, '0');
}

const commitmentOf = (publicKey: string, nonce: string) =>
  createHash('sha256')
    .update(`nova-add-device-commit-v1|${publicKey}|${nonce}`)
    .digest('base64url');

/** Signed device requests: the key over `<prefix>.<requestId>.<time>`, fresh. */
function signedBy(
  key: KeyObject,
  prefix: string,
  id: string,
  headers: Record<string, string | string[] | undefined>,
) {
  const header = (name: string) => {
    const v = headers[name];
    return typeof v === 'string' ? v : '';
  };
  const time = header('x-nova-device-time');
  const sig = Buffer.from(header('x-nova-device-signature'), 'base64url');
  return (
    Math.abs(Number(time) - Date.now() / 1000) <= 60 &&
    verify(null, Buffer.from(`${prefix}.${id}.${time}`), key, sig)
  );
}

/** Who signs the reveal answer: the Hub identity, or an impostor that relays everything else. */
let revealSigner: KeyObject = keys.privateKey;

interface AddRequest {
  publicKey: string;
  key: KeyObject;
  commitment: string;
  hubNonce: string;
  confirmation: string | null;
  decision: 'pending' | 'approved';
  granted: boolean;
  polls: number;
}

let db: NovaDatabase;
let app: FastifyInstance;
let devices: DevicesArea;
let dist: AgentDistArea;
let hubUrl: string;
let dir: string;
let distDir: string;
const requests = new Map<string, AddRequest>();

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** novad install, asynchronously (the Hub answering it runs in this process). */
function install(
  data: string,
  extra: string[] = [],
  onLine: (line: string) => void = () => undefined,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    void freePort().then((port) => {
      const p = spawn(
        BIN,
        [
          'install',
          '--hub',
          hubUrl,
          // The code comes on standard input, as the bootstrap command passes it.
          '--code',
          '-',
          '--pairing',
          PAIRING,
          '--role',
          'compute',
          '--name',
          'it-box',
          '--listen',
          `127.0.0.1:${port}`,
          '--no-service',
          '--data-dir',
          data,
          ...(extra.includes('--pin') ? [] : ['--pin', FINGERPRINT]),
          ...extra,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      p.stdin.end('abcd-efgh\n');
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (c: Buffer) => {
        const text = c.toString();
        stdout += text;
        for (const line of text.split('\n')) if (line) onLine(line);
      });
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      p.on('close', (status) => done({ status, stdout, stderr }));
    });
  });
}

describe.skipIf(!runnable)('novad install from the signed dist folder', () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-novad-install-')));
    distDir = join(dir, 'dist');
    mkdirSync(distDir);
    copyFileSync(BIN, join(distDir, `novad-${OS}-${ARCH}`));
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const iso = new Date().toISOString();
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(ACCOUNT, iso, iso);
    const settings: Partial<Record<SettingKey, unknown>> = {
      'devices.minNovadVersions': {},
      'devices.wakesPerHour': 6,
    };
    const ctx = {
      db,
      secrets: new MemorySecretStore(),
      events: new EventStore(db),
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      diagnostics: new DiagnosticsRegistry(),
      setting: (key: SettingKey) => Promise.resolve(settings[key]),
      accountOf: () => Promise.resolve(ACCOUNT),
    } as unknown as HubContext;
    devices = await setupDevices(ctx, { heartbeatIntervalMs: 1_000 });
    dist = setupAgentDist(ctx, { distDir, allowLoopbackHub: true });
    dist.useHubIdentity(() => ({
      fingerprint: FINGERPRINT,
      publicKey: rawPublic.toString('base64url'),
      sign: (bytes) => sign(null, bytes, keys.privateKey),
    }));
    app = Fastify({ bodyLimit: 1024 * 1024 });
    app.setErrorHandler((err, _req, reply) => {
      if (isNovaError(err))
        return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
      return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
    });
    devices.register(app);
    dist.register(app);

    // What the trust area adds to hello, and a stand-in for the add-device area's public routes.
    app.get('/api/v1/hello', () => ({
      name: 'nova-hub',
      hubFingerprint: FINGERPRINT,
      hubPublicKey: rawPublic.toString('base64url'),
    }));
    const completeBody = z.object({
      pairingId: z.string().optional(),
      code: z.string(),
      publicKey: z.string(),
      name: z.string(),
      platform: z.string(),
      kind: z.literal('novad'),
      commitment: z.string().length(43),
    });
    app.post('/api/v1/devices/add/complete', async (req, reply) => {
      const b = completeBody.parse(req.body);
      // Without a pairing id (the bootstrap command has none) the code finds its pairing.
      if (
        (b.pairingId !== undefined && b.pairingId !== PAIRING) ||
        b.code.replace('-', '') !== CODE
      )
        throw new NovaError('auth_missing', 'wrong code');
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: b.publicKey },
        format: 'jwk',
      });
      const requestId = `req-${requests.size + 1}`;
      const hubNonce = randomBytes(32).toString('base64url');
      requests.set(requestId, {
        publicKey: b.publicKey,
        key,
        commitment: b.commitment,
        hubNonce,
        confirmation: null,
        decision: 'pending',
        granted: false,
        polls: 0,
      });
      void reply.status(202);
      return {
        requestId,
        pairingId: PAIRING,
        hubNonce,
        status: 'committed',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    });
    app.post('/api/v1/devices/add/reveal', (req) => {
      const b = z.object({ requestId: z.string(), nonce: z.string() }).parse(req.body);
      const r = requests.get(b.requestId);
      if (!r || !signedBy(r.key, 'nova-add-device-reveal-v1', b.requestId, req.headers))
        throw new NovaError('token_required', 'bad device signature');
      if (r.confirmation) throw new NovaError('conflict', 'already revealed');
      if (commitmentOf(r.publicKey, b.nonce) !== r.commitment)
        throw new NovaError('policy_denied', 'the nonce does not open the commitment');
      const c = confirmation(r.publicKey, b.nonce, r.hubNonce);
      r.confirmation = c;
      const statement = `nova-add-device-reveal-v1|${b.requestId}|${PAIRING}|${r.publicKey}|${c}`;
      return {
        requestId: b.requestId,
        confirmation: c,
        status: 'pending',
        hubSignature: sign(null, Buffer.from(statement), revealSigner).toString('base64url'),
      };
    });
    app.get('/api/v1/devices/add/status/:id', async (req) => {
      const id = (req.params as { id: string }).id;
      const r = requests.get(id);
      if (!r?.confirmation) throw new NovaError('not_found', 'no such request');
      if (!signedBy(r.key, 'nova-add-device-status-v1', id, req.headers))
        throw new NovaError('token_required', 'bad device signature');
      r.polls += 1;
      // The owner takes a moment: the first poll is always still pending.
      if (r.decision === 'pending' || r.polls < 2) return { status: 'pending' };
      if (r.granted) return { status: 'approved' };
      r.granted = true;
      const t = await devices.service.createEnrollToken(ACCOUNT, ['compute'], hubUrl);
      return { status: 'approved', grant: { type: 'novad', enrollToken: t.token } };
    });
    hubUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await devices?.close();
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('verifies the Hub and itself, waits for approval and registers with the same key', async () => {
    const data = join(dir, 'novad-ok');
    let shown = '';
    const run = install(data, [], (line) => {
      const m = /^Confirm this code on the Hub: (\d{3} \d{3})$/.exec(line);
      if (!m) return;
      shown = m[1]!.replace(' ', '');
      // The owner compares the two screens, then approves.
      for (const r of requests.values()) if (r.confirmation === shown) r.decision = 'approved';
    });
    const out = await run;
    expect(out.status, out.stderr + out.stdout).toBe(0);
    expect(out.stdout).toContain(`Hub identity verified: ${FINGERPRINT}`);
    expect(out.stdout).toContain(`This binary is the Hub's signed novad-${OS}-${ARCH}`);
    const req = [...requests.values()].find((r) => r.confirmation === shown)!;
    expect(req.polls).toBeGreaterThanOrEqual(2);
    const list = await devices.service.list(ACCOUNT);
    const box = list.find((d) => d.name === 'it-box');
    expect(box).toBeDefined();
    expect(box!.roles).toContain('compute');
    // The key the owner approved is the one novad stored and registered with.
    const seed = readFileSync(join(data, 'key.seed'));
    expect(seed.length).toBe(32);
    const device = JSON.parse(readFileSync(join(data, 'device.json'), 'utf8')) as {
      deviceId: string;
      credential: string;
    };
    expect(device.deviceId).toBe(box!.id);
    expect(device.credential.startsWith('nvc_')).toBe(true);
    const row = db.raw.prepare('SELECT public_key FROM device WHERE id = ?').get(box!.id) as {
      public_key: string;
    };
    expect(row.public_key).toBe(req.publicKey);
  }, 60_000);

  it('stops at the reveal, before showing a code, when the pinned key did not sign it', async () => {
    // Everything else answers as the Hub; the reveal answer is signed by another key.
    revealSigner = generateKeyPairSync('ed25519').privateKey;
    const data = join(dir, 'novad-impostor');
    let shown = false;
    try {
      const out = await install(data, [], (line) => {
        if (line.startsWith('Confirm this code')) shown = true;
      });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain('This is not your Hub');
      expect(shown).toBe(false);
      expect(existsSync(data)).toBe(false);
    } finally {
      revealSigner = keys.privateKey;
    }
  }, 30_000);

  it('stops before writing anything when the pin is wrong', async () => {
    const data = join(dir, 'novad-pin');
    const other = createHash('sha256').update('another hub').digest('base64url');
    const out = await install(data, ['--pin', other]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('does not match the pinned fingerprint');
    expect(existsSync(data)).toBe(false);
  }, 30_000);

  it('stops before writing anything when it is not the signed build', async () => {
    const data = join(dir, 'novad-tampered');
    // The Hub now serves (and signs) a different build than the binary that runs.
    appendFileSync(join(distDir, `novad-${OS}-${ARCH}`), Buffer.from([0]));
    const before = requests.size;
    const out = await install(data);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("is not the Hub's signed build");
    expect(existsSync(data)).toBe(false);
    expect(requests.size).toBe(before);
  }, 30_000);
});
