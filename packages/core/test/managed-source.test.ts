// Where managed policy comes from (FR-106, docs/12 §10, ADR-078, ADR-097 D4): the protected
// location per platform, the test-only override and how it is gated, the ownership and mode checks
// (a world-writable file and a file owned by the Hub's user are ignored with the reason), parsing,
// and the signed remote envelope (verify, tamper, wrong key) with its fetch rules.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANAGED_MAX_BYTES,
  checkProtectedFile,
  defaultManagedPath,
  fetchManagedEnvelope,
  managedPublicKey,
  parseManagedPolicy,
  resolveManagedPath,
  signManagedPolicy,
  verifyManagedEnvelope,
} from '../src/managed/index.ts';
import { FakeFs } from './managed-fs.ts';

const PATH = '/etc/nova/managed-settings.json';
const HUB = 1000;

describe('the local file location', () => {
  it('is the protected place of each platform', () => {
    expect(defaultManagedPath('linux', {})).toBe(PATH);
    expect(defaultManagedPath('freebsd', {})).toBe(PATH);
    expect(defaultManagedPath('darwin', {})).toBe(
      '/Library/Application Support/Nova/managed-settings.json',
    );
    expect(defaultManagedPath('win32', { ProgramData: 'D:\\PD' })).toMatch(
      /D:\\PD.Nova.managed-settings\.json$/,
    );
    expect(defaultManagedPath('win32', {})).toMatch(/ProgramData.Nova.managed-settings\.json$/);
  });

  it('takes NOVA_MANAGED_SETTINGS_FILE only in tests or with --allow-test-policy', () => {
    const env = { NOVA_MANAGED_SETTINGS_FILE: '/tmp/p.json' };
    expect(resolveManagedPath({ platform: 'linux', env: {}, argv: [] })).toEqual({
      path: PATH,
      testPath: null,
      overrideRefused: null,
    });
    // The test file is a layer over the protected one, never in its place.
    expect(resolveManagedPath({ platform: 'linux', env: { ...env, NODE_ENV: 'test' } })).toEqual({
      path: PATH,
      testPath: '/tmp/p.json',
      overrideRefused: null,
    });
    expect(
      resolveManagedPath({ platform: 'linux', env, argv: ['--allow-test-policy'] }).testPath,
    ).toBe('/tmp/p.json');
    expect(
      resolveManagedPath({ platform: 'linux', env, argv: [], allowTestPolicy: true }).testPath,
    ).toBe('/tmp/p.json');
    const refused = resolveManagedPath({ platform: 'linux', env, argv: [] });
    expect(refused.path).toBe(PATH);
    expect(refused.testPath).toBeNull();
    expect(refused.overrideRefused).toMatch(/only in tests/);
  });
});

describe('ownership and mode checks', () => {
  const check = (fs: FakeFs, opts: { ownerUid?: number; hubUid?: number | null } = {}) =>
    checkProtectedFile(PATH, { fs, platform: 'linux', hubUid: HUB, ...opts });

  it('accepts a root-owned file nobody else may write', async () => {
    const r = await check(new FakeFs().file(PATH, '{}'));
    expect(r).toEqual({ status: 'ok', realPath: PATH, note: null });
  });

  it('reports a missing file as absent and an unreadable one as ignored', async () => {
    expect(await check(new FakeFs())).toEqual({ status: 'absent' });
    const fs = new FakeFs();
    fs.failing.set(PATH, 'EACCES');
    expect(await check(fs)).toEqual({
      status: 'ignored',
      problem: 'the file cannot be read (EACCES)',
    });
  });

  it('ignores a world-writable or group-writable file', async () => {
    const r = await check(new FakeFs().file(PATH, '{}', 0, 0o666));
    expect(r).toEqual({
      status: 'ignored',
      problem: 'it is writable by its group or by other users',
    });
    expect((await check(new FakeFs().file(PATH, '{}', 0, 0o664))).status).toBe('ignored');
  });

  it("ignores a file owned by the Hub's user or by anyone but root", async () => {
    expect(await check(new FakeFs().file(PATH, '{}', HUB, 0o600))).toEqual({
      status: 'ignored',
      problem: 'it is owned by the user the Hub runs as, who must not be able to change it',
    });
    expect(await check(new FakeFs().file(PATH, '{}', 4242, 0o644))).toEqual({
      status: 'ignored',
      problem: 'it is owned by user 4242, not root',
    });
  });

  it('checks every folder above the file', async () => {
    const owned = new FakeFs().file(PATH, '{}').dir('/etc/nova', 4242);
    expect((await check(owned)).status).toBe('ignored');
    const open = new FakeFs().file(PATH, '{}').dir('/etc/nova', 0, 0o777);
    expect(await check(open)).toEqual({
      status: 'ignored',
      problem: 'the folder /etc/nova is writable by its group or by other users',
    });
    const sticky = new FakeFs().file(PATH, '{}').dir('/etc/nova', 0, 0o1777);
    expect((await check(sticky)).status).toBe('ok');
    const unreadable = new FakeFs().file(PATH, '{}');
    unreadable.failing.set('/etc/nova', 'EACCES');
    expect((await check(unreadable)).status).toBe('ignored');
  });

  it('follows a symlink and checks the folders on both paths', async () => {
    const fs = new FakeFs().file('/opt/corp/policy.json', '{}').link(PATH, '/opt/corp/policy.json');
    expect(await check(fs)).toEqual({
      status: 'ok',
      realPath: '/opt/corp/policy.json',
      note: null,
    });
    fs.dir('/opt/corp', HUB, 0o755);
    expect((await check(fs)).status).toBe('ignored');
    const broken = new FakeFs().file(PATH, '{}');
    broken.failing.set(`realpath:${PATH}`, 'ENOENT');
    expect((await check(broken)).status).toBe('ignored');
  });

  it('refuses a folder in place of a file', async () => {
    const fs = new FakeFs().dir(PATH).file(`${PATH}/x`, '{}');
    expect(await check(fs)).toEqual({ status: 'ignored', problem: 'it is not a regular file' });
  });

  it('notes a Hub that runs as root, and expects the Hub user under the test override', async () => {
    const asRoot = await check(new FakeFs().file(PATH, '{}'), { hubUid: 0 });
    expect(asRoot.status === 'ok' && asRoot.note).toMatch(/runs as root/);
    const test = await check(new FakeFs().file(PATH, '{}', HUB, 0o600).dir('/etc/nova', HUB), {
      ownerUid: HUB,
    });
    expect(test.status).toBe('ok');
  });

  it('does not trust the Windows file until ACLs can be checked', async () => {
    const r = await checkProtectedFile('C:\\ProgramData\\Nova\\managed-settings.json', {
      fs: new FakeFs().file('C:\\ProgramData\\Nova\\managed-settings.json', '{}'),
      platform: 'win32',
    });
    expect(r.status === 'ignored' && r.problem).toMatch(/Windows/);
  });

  describe('on the real file system (the test override)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'nova-managed-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it.skipIf(process.platform === 'win32')('accepts 0600 and ignores 0666', async () => {
      const file = join(dir, 'policy.json');
      writeFileSync(file, '{"version":1}', { mode: 0o600 });
      chmodSync(file, 0o600);
      const uid = process.getuid!();
      expect((await checkProtectedFile(file, { ownerUid: uid, hubUid: uid })).status).toBe('ok');
      chmodSync(file, 0o666);
      expect(await checkProtectedFile(file, { ownerUid: uid, hubUid: uid })).toEqual({
        status: 'ignored',
        problem: 'it is writable by its group or by other users',
      });
      // Without the override the owner must be root.
      chmodSync(file, 0o600);
      expect((await checkProtectedFile(file, { hubUid: uid })).status).toBe('ignored');
    });
  });
});

describe('parsing', () => {
  it('accepts a policy and names what is wrong otherwise', () => {
    const ok = parseManagedPolicy(Buffer.from('{"version":1,"settings":{"a":1}}'));
    expect(ok.ok && ok.doc.settings).toEqual({ a: 1 });
    const json = parseManagedPolicy(Buffer.from('{nope'));
    expect(!json.ok && json.problem).toMatch(/not valid JSON/);
    const shape = parseManagedPolicy(
      Buffer.from('{"version":2,"restrict":{"tools":{"deny":"x"}},"extra":1}'),
    );
    expect(!shape.ok && shape.problem).toMatch(/version/);
    const unknownPart = parseManagedPolicy(Buffer.from('{"version":1,"restrict":{"bogus":true}}'));
    expect(unknownPart.ok).toBe(false);
    const big = parseManagedPolicy(Buffer.alloc(MANAGED_MAX_BYTES + 1, 32));
    expect(!big.ok && big.problem).toMatch(/1 MB/);
  });
});

describe('the signed remote envelope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const pin = managedPublicKey(publicKey);
  const body = Buffer.from('{"version":1}');

  it('verifies against the pinned key', () => {
    const env = signManagedPolicy(body, privateKey);
    const r = verifyManagedEnvelope(env, pin);
    expect(r.ok && r.bytes.toString()).toBe('{"version":1}');
  });

  it('refuses a tampered policy, another key, a bad pin and a malformed envelope', () => {
    const env = signManagedPolicy(body, privateKey);
    const tampered = { ...env, policy: Buffer.from('{"version":1,"x":1}').toString('base64') };
    expect(verifyManagedEnvelope(tampered, pin)).toEqual({
      ok: false,
      problem: 'the signature does not match the pinned key',
    });
    expect(verifyManagedEnvelope(env, managedPublicKey(other.publicKey)).ok).toBe(false);
    expect(verifyManagedEnvelope(env, 'A'.repeat(43))).toMatchObject({ ok: false });
    expect(verifyManagedEnvelope({ v: 2 }, pin)).toEqual({
      ok: false,
      problem: 'not a signed policy envelope',
    });
  });

  it('exports only Ed25519 public keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => managedPublicKey(rsa.publicKey)).toThrow(/Ed25519/);
  });
});

describe('fetching the remote policy', () => {
  const ok = (body: unknown, init: ResponseInit = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init }));

  it('fetches https without redirects', async () => {
    let seen: RequestInit | null = null;
    const r = await fetchManagedEnvelope(
      { url: 'https://policy.corp.example/nova.json' },
      {
        fetch: (_u, init) => {
          seen = init;
          return ok({ v: 1 });
        },
      },
    );
    expect(r).toEqual({ ok: true, body: { v: 1 } });
    expect(seen!.redirect).toBe('error');
  });

  it('refuses plain http unless allowed, and reports failures', async () => {
    const http = { url: 'http://127.0.0.1:9/p.json' };
    expect(await fetchManagedEnvelope(http, { fetch: () => ok({}) })).toEqual({
      ok: false,
      problem: 'the remote policy URL must use https',
    });
    expect(
      (await fetchManagedEnvelope(http, { fetch: () => ok({}), allowInsecure: true })).ok,
    ).toBe(true);
    expect((await fetchManagedEnvelope({ url: 'nope' })).ok).toBe(false);
    const https = { url: 'https://p.example/' };
    expect(
      await fetchManagedEnvelope(https, {
        fetch: () => Promise.resolve(new Response('x', { status: 503 })),
      }),
    ).toEqual({ ok: false, problem: 'the server answered HTTP 503' });
    expect(
      await fetchManagedEnvelope(https, {
        fetch: () => Promise.resolve(new Response('not json')),
      }),
    ).toEqual({ ok: false, problem: 'the response is not JSON' });
    expect(
      (
        await fetchManagedEnvelope(https, {
          fetch: () =>
            Promise.resolve(
              new Response('{}', { headers: { 'content-length': String(MANAGED_MAX_BYTES * 3) } }),
            ),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await fetchManagedEnvelope(https, {
          fetch: () => Promise.resolve(new Response('x'.repeat(MANAGED_MAX_BYTES * 2 + 1))),
        })
      ).ok,
    ).toBe(false);
    const thrown = await fetchManagedEnvelope(https, {
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(!thrown.ok && thrown.problem).toMatch(/offline/);
  });
});
