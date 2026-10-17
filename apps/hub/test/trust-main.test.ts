// The Hub process serving HTTPS from its trust mode (FR-134, docs/22 §5): with `trust.mode`
// `local-ca` and no NOVA_TLS_CERT the listener serves the Hub local CA's leaf, a client that
// trusts the CA connects and one that does not is refused, a renewal reaches the running
// listener, and an explicit certificate keeps precedence.
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCertificate, hubFingerprint, rawEd25519 } from '@nova/core';
import { migrate, openDatabase } from '@nova/storage';
import { loadConfig } from '../src/config.ts';
import { start, watchTrust } from '../src/main.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-trust-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A data folder whose database already says `trust.mode: local-ca`. */
async function seed(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase({ path: join(dataDir, 'nova.db') });
  await migrate(db, { backupDir: join(dataDir, 'backups') });
  db.raw
    .prepare(
      "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES ('trust.mode', 'global', '', '\"local-ca\"', ?)",
    )
    .run(new Date().toISOString());
  db.close();
}

interface Reply {
  status: number;
  body: string;
  cookies: string[];
  peer: X509Certificate | null;
}

function call(
  url: string,
  opts: {
    ca?: string;
    insecure?: boolean;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: opts.method ?? 'GET',
        agent: false,
        ...(opts.ca ? { ca: opts.ca } : {}),
        ...(opts.insecure ? { rejectUnauthorized: false } : {}),
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const peer = (res.socket as TLSSocket).getPeerX509Certificate() ?? null;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cookies: res.headers['set-cookie'] ?? [],
            peer,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function quietly<T>(fn: (out: string[]) => Promise<T>): Promise<T> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string) => (out.push(s), true);
  process.stderr.write = () => true;
  try {
    return await fn(out);
  } finally {
    process.stdout.write = write;
    process.stderr.write = errWrite;
  }
}

describe('the Hub listener with the local CA (FR-134)', () => {
  it('serves HTTPS a client trusting the CA accepts, and swaps in a renewed leaf', async () => {
    const dataDir = join(dir, 'data');
    await seed(dataDir);
    const cfg = loadConfig(
      { NOVA_DATA_DIR: dataDir, NOVA_WEB_DIR: join(dir, 'web'), NOVA_PORT: '0' },
      [],
    );
    await quietly(async (out) => {
      const running = await start(cfg);
      try {
        expect(running.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
        // The setup link is HTTPS too.
        expect(out.join('')).toContain(`${running.url}/#setup=nvs_`);
        // A device fetches the root first (public), then trusts only it.
        const root = await call(`${running.url}/api/v1/trust/ca.pem`, { insecure: true });
        expect(root.status).toBe(200);
        const ca = root.body;
        const hello = await call(`${running.url}/api/v1/hello`, { ca });
        expect(hello.status).toBe(200);
        expect(hello.peer!.checkIssued(new X509Certificate(ca))).toBe(true);
        expect(hello.peer!.subjectAltName).toContain('IP Address:127.0.0.1');
        await expect(call(`${running.url}/api/v1/hello`)).rejects.toThrow(
          /self[- ]signed|unable to (get|verify)/i,
        );
        // Sign in over HTTPS; the cookie is Secure.
        const code = /#setup=(nvs_[A-Za-z0-9_-]+)/.exec(out.join(''))![1]!;
        const setup = await call(`${running.url}/api/v1/auth/setup`, {
          ca,
          method: 'POST',
          body: { code },
        });
        expect(setup.status).toBe(200);
        expect(setup.cookies[0]).toMatch(/Secure/i);
        const session = /nova_session=([^;]+)/.exec(setup.cookies[0]!)![1]!;
        const auth = { authorization: `Bearer ${session}` };
        const view = JSON.parse(
          (await call(`${running.url}/api/v1/trust`, { ca, headers: auth })).body,
        ) as {
          serving: unknown;
          restartRequired: boolean;
          leaf: { serial: string };
        };
        expect(view.serving).toEqual({ scheme: 'https', source: 'trust', fallbackReason: null });
        expect(view.restartRequired).toBe(false);
        expect(hello.peer!.serialNumber.toLowerCase()).toBe(view.leaf.serial);
        // A renewal reaches the running listener: the next connection sees the new leaf.
        const renewed = await call(`${running.url}/api/v1/trust/renew`, {
          ca,
          method: 'POST',
          body: { target: 'leaf' },
          headers: auth,
        });
        expect(renewed.status).toBe(200);
        const serial = (JSON.parse(renewed.body) as { leaf: { serial: string } }).leaf.serial;
        expect(serial).not.toBe(view.leaf.serial);
        await vi.waitFor(async () => {
          const again = await call(`${running.url}/api/v1/health`, { ca });
          expect(again.peer!.serialNumber.toLowerCase()).toBe(serial);
        });
      } finally {
        await running.close();
      }
    });
  });

  it('keeps an explicit NOVA_TLS_CERT ahead of the trust mode', async () => {
    const dataDir = join(dir, 'data');
    await seed(dataDir);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const explicit = buildCertificate({
      subject: { commonName: 'localhost' },
      issuer: { commonName: 'localhost' },
      publicKey,
      signer: privateKey,
      notBefore: new Date(Date.now() - 3_600_000),
      notAfter: new Date(Date.now() + 86_400_000),
      keyUsage: 0x80,
      extKeyUsage: ['1.3.6.1.5.5.7.3.1'],
      altNames: { hosts: ['localhost', '127.0.0.1'] },
    });
    writeFileSync(join(dir, 'cert.pem'), explicit.pem);
    writeFileSync(join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const cfg = loadConfig(
      {
        NOVA_DATA_DIR: dataDir,
        NOVA_WEB_DIR: join(dir, 'web'),
        NOVA_PORT: '0',
        NOVA_TLS_CERT: join(dir, 'cert.pem'),
        NOVA_TLS_KEY: join(dir, 'key.pem'),
      },
      [],
    );
    await quietly(async () => {
      const running = await start(cfg);
      try {
        const hello = await call(`${running.url}/api/v1/hello`, { ca: explicit.pem });
        expect(hello.status).toBe(200);
        expect(hello.peer!.serialNumber.toLowerCase()).toBe(explicit.serial);
      } finally {
        await running.close();
      }
    });
  });

  it('stays plain HTTP while the trust mode is none', async () => {
    const cfg = loadConfig(
      { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'web'), NOVA_PORT: '0' },
      [],
    );
    await quietly(async () => {
      const running = await start(cfg);
      try {
        expect(running.url).toMatch(/^http:\/\//);
        expect((await fetch(`${running.url}/api/v1/trust/ca.pem`)).status).toBe(404);
      } finally {
        await running.close();
      }
    });
  });
});

/** A non-loopback IPv4 address of this machine, if it has one. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

describe('when the trust certificates cannot be read at start (findings 2 and 15)', () => {
  it('serves plain HTTP on loopback only, with null hello fields and a problem saying why', async () => {
    const dataDir = join(dir, 'data');
    await seed(dataDir);
    // The database records an identity whose key is not in this (fresh) vault.
    const db = openDatabase({ path: join(dataDir, 'nova.db') });
    const pinned = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    db.raw
      .prepare(
        "INSERT INTO trust_identity (id, public_key, fingerprint, key_ref, created_at) VALUES ('hub', ?, ?, 'secret://hub/identity', ?)",
      )
      .run(pinned, hubFingerprint(Buffer.from(pinned, 'base64url')), new Date().toISOString());
    db.close();
    const cfg = loadConfig(
      {
        NOVA_DATA_DIR: dataDir,
        NOVA_WEB_DIR: join(dir, 'web'),
        NOVA_PORT: '0',
        NOVA_HOST: '0.0.0.0',
      },
      [],
    );
    await quietly(async (out) => {
      const running = await start(cfg);
      try {
        // Not every interface, although NOVA_HOST asked for it.
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const port = Number(new URL(running.url).port);
        const lan = lanAddress();
        if (lan) await expect(fetch(`http://${lan}:${port}/api/v1/health`)).rejects.toThrow();
        const hello = (await (await fetch(`${running.url}/api/v1/hello`)).json()) as Record<
          string,
          unknown
        >;
        expect(hello.hubFingerprint).toBeNull();
        const code = /#setup=(nvs_[A-Za-z0-9_-]+)/.exec(out.join(''))![1]!;
        const setup = await fetch(`${running.url}/api/v1/auth/setup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const session = /nova_session=([^;]+)/.exec(setup.headers.get('set-cookie') ?? '')![1]!;
        const view = (await (
          await fetch(`${running.url}/api/v1/trust`, {
            headers: { authorization: `Bearer ${session}` },
          })
        ).json()) as { problems: string[]; hubFingerprint: string | null; serving: unknown };
        expect(view.hubFingerprint).toBeNull();
        expect(view.serving).toMatchObject({ scheme: 'http', source: 'none' });
        const problems = view.problems.join(' ');
        expect(problems).toContain('loopback only');
        expect(problems).toContain(
          `Hub identity key ${hubFingerprint(Buffer.from(pinned, 'base64url'))} is missing`,
        );
      } finally {
        await running.close();
      }
      // No new identity was made: the recorded key is unchanged.
      const after = openDatabase({ path: join(dataDir, 'nova.db') });
      expect(after.raw.prepare('SELECT public_key FROM trust_identity').all()).toEqual([
        { public_key: pinned },
      ]);
      after.close();
    });
  });
});

describe('applying renewed certificates', () => {
  it('logs a failure and keeps the current certificates, never an unhandled rejection', async () => {
    let fire: () => void = () => undefined;
    const errors: string[] = [];
    const updates: unknown[] = [];
    let material: () => Promise<{ cert: string; key: string; sni: [] } | null> = () =>
      Promise.resolve({ cert: 'not a certificate', key: 'not a key', sni: [] });
    const off = watchTrust(
      {
        material: () => material(),
        onChange: (l) => ((fire = l), () => undefined),
      },
      {
        update: (m) => {
          updates.push(m);
          throw new Error('the TLS stack refused the key');
        },
      },
      { error: (msg: string) => void errors.push(msg) },
    );
    fire();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    material = () => Promise.reject(new Error('vault locked'));
    fire();
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    material = () => Promise.resolve(null);
    fire();
    await new Promise((r) => setTimeout(r, 20));
    expect(updates).toHaveLength(1);
    expect(errors[0]).toContain('keeping the current ones');
    off();
  });
});
