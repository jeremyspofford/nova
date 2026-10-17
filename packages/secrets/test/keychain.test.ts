// The keychain backends run against fake `secret-tool` and `security` CLIs: small Node scripts
// that keep items in a JSON file and log their argument lists, so the tests can check that a
// value never reaches a command line.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from '@nova/security';
import {
  FileVault,
  KeychainStore,
  libsecretBackend,
  macosKeychainBackend,
  openSecretStore,
  platformKeychain,
  runCommand,
  type KeychainBackend,
} from '../src/index.ts';

const COMMON = `
const fs = require('node:fs');
const file = process.env.FAKE_KEYRING;
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const save = (m) => fs.writeFileSync(file, JSON.stringify(m));
const args = process.argv.slice(2);
fs.appendFileSync(file + '.argv', JSON.stringify(args) + '\\n');
const fail = process.env.FAKE_FAIL ?? '';
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
if (process.env.FAKE_HANG) setTimeout(() => {}, 60_000);
`;

const SECRET_TOOL = `${COMMON}
const attr = (k) => args[args.indexOf(k) + 1];
const key = attr('service') + '|' + attr('ref');
const m = load();
if (!process.env.FAKE_HANG) {
  if (fail === args[0]) { process.stderr.write('Cannot autolaunch D-Bus without X11\\n'); process.exit(1); }
  if (args[0] === 'lookup') { if (key in m) { process.stdout.write(m[key]); process.exit(0); } process.exit(1); }
  if (args[0] === 'store') { m[key] = stdin(); save(m); process.exit(0); }
  if (args[0] === 'clear') { delete m[key]; save(m); process.exit(0); }
  process.exit(2);
}
`;

const SECURITY = `${COMMON}
const flag = (a, k) => a[a.indexOf(k) + 1];
const m = load();
if (!process.env.FAKE_HANG) {
  if (fail === args[0]) { process.stderr.write('security: SecKeychain failure\\n'); process.exit(fail === '-i' ? 0 : 1); }
  if (args[0] === 'default-keychain') { process.stdout.write('    "/Users/me/login.keychain-db"\\n'); process.exit(0); }
  const key = (a) => flag(a, '-s') + '|' + flag(a, '-a');
  if (args[0] === 'find-generic-password') {
    if (key(args) in m) { process.stdout.write(m[key(args)] + '\\n'); process.exit(0); }
    process.stderr.write('The specified item could not be found in the keychain.\\n'); process.exit(44);
  }
  if (args[0] === 'delete-generic-password') {
    if (!(key(args) in m)) process.exit(44);
    delete m[key(args)]; save(m); process.exit(0);
  }
  if (args[0] === '-i') {
    for (const line of stdin().split('\\n').filter(Boolean)) {
      const a = line.split(' ');
      if (a[0] === 'add-generic-password') m[key(a)] = flag(a, '-w');
    }
    save(m); process.stdout.write('security> '); process.exit(0);
  }
  process.exit(2);
}
`;

let dir: string;
let keyring: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-keychain-'));
  keyring = join(dir, 'keyring.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    FAKE_KEYRING: keyring,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    ...extra,
  };
}

const argvLog = () =>
  existsSync(`${keyring}.argv`) ? readFileSync(`${keyring}.argv`, 'utf8') : '';
const REF = 'secret://provider/abc/api_key';
const VALUE = 'value with spaces\nand a newline';

describe('runCommand', () => {
  it('reports a missing command, a timeout and stdin input without rejecting', async () => {
    const missing = await runCommand(join(dir, 'nope'), []);
    expect(missing.code).toBeNull();
    expect(missing.error).toMatch(/ENOENT/);
    const hang = cli('hang', SECRET_TOOL);
    const slow = await runCommand(hang, ['lookup'], {
      env: env({ FAKE_HANG: '1' }),
      timeoutMs: 200,
    });
    expect(slow).toMatchObject({ code: null, error: `${hang} timed out` });
    const echo = cli('echo', 'process.stdin.pipe(process.stdout);');
    expect((await runCommand(echo, [], { input: 'hello' })).stdout).toBe('hello');
  });
});

describe.each([
  ['libsecret', () => libsecretBackend({ command: cli('secret-tool', SECRET_TOOL), env: env() })],
  ['macOS', () => macosKeychainBackend({ command: cli('security', SECURITY), env: env() })],
])('%s backend', (_name, make) => {
  it('stores, reads and removes values that never appear in an argument list', async () => {
    const b = make();
    expect(await b.available()).toEqual({ ok: true, detail: b.name });
    expect(await b.read(REF)).toBeNull();
    await b.write(REF, VALUE);
    expect(await b.read(REF)).toBe(VALUE);
    expect(await b.remove(REF)).toBe(true);
    expect(await b.remove(REF)).toBe(false);
    expect(await b.read(REF)).toBeNull();
    expect(argvLog()).not.toContain('value with spaces');
    expect(argvLog()).not.toContain(Buffer.from(VALUE).toString('base64'));
  });

  it('rejects items it did not write', async () => {
    const b = make();
    const key = `nova|${REF}`;
    writeFileSync(keyring, JSON.stringify({ [key]: 'not base64!' }));
    await expect(b.read(REF)).rejects.toThrow(/not in the format Nova writes/);
  });
});

describe('libsecret failures', () => {
  const make = (fail: string, extra: Record<string, string> = {}) =>
    libsecretBackend({
      command: cli('secret-tool', SECRET_TOOL),
      env: env({ FAKE_FAIL: fail, ...extra }),
    });

  it('is unavailable without a session bus or when the service refuses', async () => {
    const noBus = libsecretBackend({ command: cli('secret-tool', SECRET_TOOL), env: { PATH: '' } });
    expect(await noBus.available()).toEqual({ ok: false, detail: 'no D-Bus session bus' });
    const refused = await make('lookup').available();
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/Cannot autolaunch D-Bus/);
    const missing = libsecretBackend({ command: join(dir, 'missing'), env: env() });
    expect((await missing.available()).detail).toMatch(/ENOENT/);
  });

  it('surfaces read, store and clear failures', async () => {
    await expect(make('lookup').read(REF)).rejects.toThrow(/could not read a secret/);
    await expect(make('store').write(REF, 'v')).rejects.toThrow(/could not store a secret/);
    await make('').write(REF, 'v');
    await expect(make('clear').remove(REF)).rejects.toThrow(/could not delete a secret/);
  });
});

describe('macOS failures', () => {
  const make = (fail: string) =>
    macosKeychainBackend({ command: cli('security', SECURITY), env: env({ FAKE_FAIL: fail }) });

  it('surfaces each failing command', async () => {
    expect((await make('default-keychain').available()).ok).toBe(false);
    await expect(make('find-generic-password').read(REF)).rejects.toThrow(/could not read/);
    // Interactive mode exits 0 even when a command fails; stderr tells.
    await expect(make('-i').write(REF, 'v')).rejects.toThrow(/could not store/);
    await expect(make('delete-generic-password').remove(REF)).rejects.toThrow(/could not delete/);
  });
});

describe('platformKeychain', () => {
  it('picks the CLI for the platform', () => {
    expect(platformKeychain('darwin', {})?.name).toMatch(/macOS/);
    expect(platformKeychain('linux', {})?.name).toMatch(/Secret Service/);
    expect(platformKeychain('win32', {})).toBeNull();
  });
});

/** An in-memory backend for the store logic. */
function memoryBackend(seed: Record<string, string> = {}): KeychainBackend & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(seed));
  return {
    name: 'test keychain',
    items,
    available: () => Promise.resolve({ ok: true, detail: 'test keychain' }),
    read: (a) => Promise.resolve(items.get(a) ?? null),
    write: (a, v) => Promise.resolve(void items.set(a, v)),
    remove: (a) => Promise.resolve(items.delete(a)),
  };
}

describe('KeychainStore', () => {
  it('implements the store contract with a reference index', async () => {
    const red = new Redactor([]);
    const backend = memoryBackend();
    const s = new KeychainStore(backend, red);
    expect(s.info).toEqual({ backend: 'keychain', detail: 'test keychain', warning: null });
    await s.put(REF, 'kc-secret-1');
    await s.put(REF, 'kc-secret-2');
    await s.put('secret://mcp/x/env/TOKEN', 'kc-secret-3');
    expect(await s.get(REF)).toBe('kc-secret-2');
    expect(await s.has(REF)).toBe(true);
    expect(await s.list()).toEqual(['secret://mcp/x/env/TOKEN', REF]);
    expect(await s.list('secret://mcp/')).toEqual(['secret://mcp/x/env/TOKEN']);
    expect(JSON.parse(backend.items.get('nova-index')!)).toEqual(['secret://mcp/x/env/TOKEN', REF]);
    expect(red.redactString('kc-secret-2')).toBe(REDACTED);
    expect(await s.delete(REF)).toBe(true);
    expect(await s.delete(REF)).toBe(false);
    expect(await s.get(REF)).toBeNull();
    expect(await s.has(REF)).toBe(false);
    expect(await new KeychainStore(backend).list()).toEqual(['secret://mcp/x/env/TOKEN']);
  });

  it('registers values it reads with the redactor', async () => {
    const red = new Redactor([]);
    await new KeychainStore(memoryBackend({ [REF]: 'read-later-value' }), red).get(REF);
    expect(red.redactString('read-later-value')).toBe(REDACTED);
  });

  it('rejects bad references and empty values', async () => {
    const s = new KeychainStore(memoryBackend());
    await expect(s.put('nope', 'x')).rejects.toThrow(/secret:\/\/ reference/);
    await expect(s.put(REF, '')).rejects.toThrow(/empty/);
    await expect(s.get('nope')).rejects.toThrow();
    await expect(s.has('nope')).rejects.toThrow();
    await expect(s.delete('nope')).rejects.toThrow();
  });

  it('survives a damaged index', async () => {
    expect(await new KeychainStore(memoryBackend({ 'nova-index': '{oops' })).list()).toEqual([]);
    expect(await new KeychainStore(memoryBackend({ 'nova-index': '{"a":1}' })).list()).toEqual([]);
    const s = new KeychainStore(memoryBackend({ 'nova-index': '[1, "secret://a/b"]' }));
    expect(await s.list()).toEqual(['secret://a/b']);
  });

  it('serializes concurrent writes so the index keeps every reference', async () => {
    const s = new KeychainStore(memoryBackend());
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.put(`secret://t/k${i}`, `v${i}`)));
    expect(await s.list('secret://t/')).toHaveLength(20);
  });
});

describe('openSecretStore', () => {
  const vaultPath = () => join(dir, 'secrets.vault');
  const vaultKey = () => ({ kind: 'keyfile' as const, path: join(dir, 'vault.key') });

  it('uses the vault by default', async () => {
    const opened = await openSecretStore({
      mode: 'vault',
      vaultPath: vaultPath(),
      vaultKey: vaultKey(),
    });
    expect(opened.store).toBeInstanceOf(FileVault);
    expect(opened.store.info).toMatchObject({ backend: 'vault', warning: null });
    expect(opened.warning).toBeNull();
  });

  it('falls back to the vault with a warning when no keychain is reachable', async () => {
    const none = await openSecretStore({
      mode: 'keychain',
      vaultPath: vaultPath(),
      vaultKey: vaultKey(),
      keychain: null,
    });
    expect(none.store).toBeInstanceOf(FileVault);
    expect(none.warning).toMatch(/unavailable \(none on this platform\)/);
    expect(none.store.info?.warning).toBe(none.warning);
    const down = await openSecretStore({
      mode: 'keychain',
      vaultPath: vaultPath(),
      vaultKey: vaultKey(),
      keychain: libsecretBackend({ command: cli('secret-tool', SECRET_TOOL), env: { PATH: '' } }),
    });
    expect(down.warning).toMatch(/no D-Bus session bus/);
  });

  it('moves vault secrets into the keychain once it is reachable', async () => {
    const vault = new FileVault(vaultPath(), vaultKey());
    await vault.put(REF, 'moved-value-1');
    await vault.put('secret://devices/n1/job-token', 'moved-value-2');
    const backend = memoryBackend();
    const opened = await openSecretStore({
      mode: 'keychain',
      vaultPath: vaultPath(),
      vaultKey: vaultKey(),
      keychain: backend,
    });
    expect(opened.store).toBeInstanceOf(KeychainStore);
    expect(opened.migrated).toBe(2);
    expect(await opened.store.get(REF)).toBe('moved-value-1');
    expect(await new FileVault(vaultPath(), vaultKey()).list()).toEqual([]);
    const again = await openSecretStore({
      mode: 'keychain',
      vaultPath: join(dir, 'absent.vault'),
      vaultKey: vaultKey(),
      keychain: backend,
    });
    expect(again.migrated).toBe(0);
  });

  it('keeps the keychain and warns when the vault cannot be moved', async () => {
    await new FileVault(vaultPath(), vaultKey()).put(REF, 'stays-in-vault');
    writeFileSync(vaultPath(), 'corrupt');
    const opened = await openSecretStore({
      mode: 'keychain',
      vaultPath: vaultPath(),
      vaultKey: vaultKey(),
      keychain: memoryBackend(),
    });
    expect(opened.store).toBeInstanceOf(KeychainStore);
    expect(opened.warning).toMatch(/could not be moved.*corrupt/);

    await new FileVault(join(dir, 'b.vault'), vaultKey()).put(REF, 'lossy');
    const lossy = memoryBackend();
    lossy.write = () => Promise.resolve();
    const failed = await openSecretStore({
      mode: 'keychain',
      vaultPath: join(dir, 'b.vault'),
      vaultKey: vaultKey(),
      keychain: lossy,
    });
    expect(failed.warning).toMatch(/did not read back/);
    expect(await new FileVault(join(dir, 'b.vault'), vaultKey()).get(REF)).toBe('lossy');
  });
});

describe('store info', () => {
  it('describes the vault and the in-memory store', async () => {
    const { MemorySecretStore } = await import('../src/index.ts');
    expect(new MemorySecretStore().info.backend).toBe('memory');
    expect(new MemorySecretStore().info.warning).toMatch(/memory only/);
    const portable = new FileVault(join(dir, 'p.vault'), { kind: 'passphrase', passphrase: 'p' });
    expect(portable.info.detail).toMatch(/passphrase/);
    expect(portable.exists()).toBe(false);
  });
});
