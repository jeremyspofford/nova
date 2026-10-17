import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor, REDACTED } from '@nova/security';
import { FileVault, MemorySecretStore, isSecretRef, secretRef } from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REF = 'secret://provider/abc/api_key';

describe('secret references', () => {
  it('accepts well-formed references only', () => {
    expect(isSecretRef(REF)).toBe(true);
    expect(isSecretRef('secret://provider')).toBe(false);
    expect(isSecretRef('http://x/y')).toBe(false);
    expect(isSecretRef('secret://a/../b')).toBe(true); // segments are opaque labels, never paths
    expect(secretRef('connector', 'linear', 'token')).toBe('secret://connector/linear/token');
    expect(() => secretRef('bad space', 'x')).toThrow(/invalid secret reference/);
  });
});

describe('FileVault (key file)', () => {
  const vault = (r = new Redactor()) =>
    new FileVault(join(dir, 'secrets.vault'), { kind: 'keyfile', path: join(dir, 'vault.key') }, r);

  it('stores, reads, lists and deletes secrets across instances', async () => {
    const a = vault();
    await a.put(REF, 'sk-live-123456');
    await a.put('secret://provider/def/api_key', 'other');
    const b = vault();
    expect(await b.get(REF)).toBe('sk-live-123456');
    expect(await b.has(REF)).toBe(true);
    expect(await b.list('secret://provider/')).toEqual([
      'secret://provider/abc/api_key',
      'secret://provider/def/api_key',
    ]);
    expect(await b.delete(REF)).toBe(true);
    expect(await b.delete(REF)).toBe(false);
    expect(await vault().get(REF)).toBeNull();
    expect(await vault().list()).toEqual(['secret://provider/def/api_key']);
  });

  it('never writes the value in plain text and keeps files private', async () => {
    // secret-scan: fake
    await vault().put(REF, 'sk-live-very-secret-value');
    const raw = readFileSync(join(dir, 'secrets.vault'), 'utf8');
    expect(raw).not.toContain('sk-live-very-secret-value'); // secret-scan: fake
    expect(raw).not.toContain('provider/abc');
    expect(statSync(join(dir, 'secrets.vault')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'vault.key')).mode & 0o777).toBe(0o600);
  });

  it('registers values with the redactor so they never reach logs', async () => {
    const red = new Redactor([]);
    await vault(red).put(REF, 'plain-looking-value');
    expect(red.redactString('got plain-looking-value')).toBe(`got ${REDACTED}`);
    const fresh = new Redactor([]);
    await vault(fresh).get(REF);
    expect(fresh.redactString('plain-looking-value')).toBe(REDACTED);
  });

  it('fails closed on a tampered file, a wrong key or a corrupt file', async () => {
    await vault().put(REF, 'value-1');
    const path = join(dir, 'secrets.vault');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { data: string };
    const bytes = Buffer.from(file.data, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(path, JSON.stringify({ ...file, data: bytes.toString('base64') }));
    await expect(vault().get(REF)).rejects.toThrow(/wrong key or tampered/);

    writeFileSync(join(dir, 'vault.key'), Buffer.alloc(32, 7));
    await expect(vault().get(REF)).rejects.toThrow(/wrong key or tampered/);

    writeFileSync(path, 'not json');
    await expect(vault().get(REF)).rejects.toThrow(/corrupt/);

    writeFileSync(path, JSON.stringify({ v: 9 }));
    await expect(vault().get(REF)).rejects.toThrow(/unsupported vault version/);

    rmSync(path);
    writeFileSync(join(dir, 'vault.key'), Buffer.alloc(5));
    await expect(vault().get(REF)).rejects.toThrow(/key file is corrupt/);
  });

  it('rejects bad references and empty values', async () => {
    await expect(vault().put('nope', 'x')).rejects.toThrow(/secret:\/\/ reference/);
    await expect(vault().put(REF, '')).rejects.toThrow(/empty/);
    await expect(vault().get('nope')).rejects.toThrow();
    await expect(vault().has('nope')).rejects.toThrow();
    await expect(vault().delete('nope')).rejects.toThrow();
  });

  it('serializes concurrent writes', async () => {
    const v = vault();
    await Promise.all(Array.from({ length: 20 }, (_, i) => v.put(`secret://t/k${i}`, `v${i}`)));
    expect(await vault().list('secret://t/')).toHaveLength(20);
  });
});

describe('FileVault (passphrase, portable mode)', () => {
  const path = () => join(dir, 'portable.vault');

  it('round-trips with the right passphrase and refuses the wrong one', async () => {
    await new FileVault(path(), { kind: 'passphrase', passphrase: 'correct horse' }).put(REF, 'v');
    expect(
      await new FileVault(path(), { kind: 'passphrase', passphrase: 'correct horse' }).get(REF),
    ).toBe('v');
    await expect(
      new FileVault(path(), { kind: 'passphrase', passphrase: 'wrong' }).get(REF),
    ).rejects.toThrow(/wrong key or tampered/);
    const file = JSON.parse(readFileSync(path(), 'utf8')) as { kdf: string; salt: string };
    expect(file.kdf).toBe('argon2id');
    expect(file.salt).toBeTruthy();
  });

  it('will not open a key-file vault with a passphrase, or the reverse', async () => {
    await new FileVault(path(), { kind: 'passphrase', passphrase: 'p' }).put(REF, 'v');
    await expect(
      new FileVault(path(), { kind: 'keyfile', path: join(dir, 'k') }).get(REF),
    ).rejects.toThrow(/passphrase/);
    const kf = join(dir, 'kf.vault');
    await new FileVault(kf, { kind: 'keyfile', path: join(dir, 'k2') }).put(REF, 'v');
    await expect(
      new FileVault(kf, { kind: 'passphrase', passphrase: 'p' }).get(REF),
    ).rejects.toThrow(/key file/);
  });
});

describe('MemorySecretStore', () => {
  it('implements the store contract', async () => {
    const red = new Redactor([]);
    const s = new MemorySecretStore(red);
    await s.put(REF, 'mem-secret');
    expect(await s.get(REF)).toBe('mem-secret');
    expect(await s.has(REF)).toBe(true);
    expect(await s.list()).toEqual([REF]);
    expect(red.redactString('mem-secret')).toBe(REDACTED);
    expect(await s.delete(REF)).toBe(true);
    expect(await s.get(REF)).toBeNull();
    await expect(s.put('bad', 'x')).rejects.toThrow();
    await expect(s.get('bad')).rejects.toThrow();
  });
});
