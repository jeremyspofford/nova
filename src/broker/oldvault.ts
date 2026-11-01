// Today's vault (src/core/vault.ts), read and rewritten by broker code only: the migrate launcher
// (§10 "Moving from today's vault, with no value passing through core"). The format is vault.ts's:
// home/vault/secrets.json, AES-256-GCM over the JSON map with `nova-vault-v1|<id>` as associated
// data; the key in the keychain (nova-vault / vault-<id>) or home/vault/key. Nothing is imported
// from core: the format is small and fixed, and reimplemented here.
//
// After a migration, the names that moved are taken out: the file is rewritten without them under
// a new key (so an older backup's copy opens with no key that still exists), or deleted with its
// key when nothing is left. Nova's own keys (§9 row 15) stay in it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseStore, fileKeyStore, type KeyStore } from './keystore.ts';

// Nova's own keys (§9 row 15, Conflicts row 4): they stay in core's vault.ts and are never moved.
export const OWN_KEYS = [/^nova\//, /^capture\/hash-key$/, /^network\/[^/]+\/change\//, /^infra\/[^/]+\/run\//];

interface VaultFile { v: 1; id: string; alg: 'aes-256-gcm'; fp: string; nonce: string; tag: string; data: string }
const AAD = (id: string) => Buffer.from(`nova-vault-v1|${id}`, 'utf8');
const fp = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OldVault { id: string; map: Map<string, string>; key: Buffer; store: KeyStore }

function keyMode(env: NodeJS.ProcessEnv): 'auto' | 'file' | 'keychain' {
  const v = env.NOVA_VAULT_KEY;
  return v === 'file' || v === 'keychain' ? v : env.NODE_TEST_CONTEXT ? 'file' : 'auto';
}

export function readOldVault(home: string, o: { env?: NodeJS.ProcessEnv; store?: (id: string) => KeyStore } = {}): OldVault | null {
  const file = join(home, 'vault', 'secrets.json');
  if (!existsSync(file)) return null;
  const f = JSON.parse(readFileSync(file, 'utf8')) as VaultFile;
  if (f?.v !== 1 || f.alg !== 'aes-256-gcm' || !UUID.test(f.id)) throw new Error('The old vault isn’t one the broker knows.');
  const env = o.env ?? process.env;
  const disk = fileKeyStore(join(home, 'vault', 'key'));
  const kc = o.store ? o.store(f.id) : chooseStore('nova-vault', `vault-${f.id}`, join(home, 'vault', 'key'), { mode: keyMode(env), env });
  for (const s of [kc, disk]) {
    let key: Buffer | null = null;
    try { key = s.read(); } catch { key = null; }
    if (!key || fp(key) !== f.fp) continue;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
    d.setAAD(AAD(f.id));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
    return { id: f.id, map: new Map(Object.entries(JSON.parse(plain) as Record<string, string>)), key, store: s };
  }
  throw new Error('The old vault’s key isn’t where it should be, so nothing can be moved from it.');
}

// Takes `names` out of the old vault: a new key and file without them, written in vault.ts's order
// (new file beside the old, the key saved, then the file swapped in), or no file and no key.
export function removeFromOldVault(home: string, v: OldVault, names: string[]): string[] {
  const file = join(home, 'vault', 'secrets.json');
  const gone = names.filter((n) => v.map.delete(n));
  if (!v.map.size) {
    rmSync(file, { force: true });
    v.store.remove();
    rmSync(join(home, 'vault', 'key'), { force: true });
    return gone;
  }
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD(v.id));
  const data = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(v.map)), 'utf8'), c.final()]);
  const out: VaultFile = { v: 1, id: v.id, alg: 'aes-256-gcm', fp: fp(key), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  v.store.write(key);
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
  v.key.fill(0);
  v.key = key;
  return gone;
}

// Era 2's plaintext Gmail files (src/connectors/gmail.js), moved by the broker too.
export const GMAIL_FILES: Record<string, string> = { 'client.json': 'connector/gmail/GOOGLE_OAUTH_CLIENT', 'token.json': 'connector/gmail/GOOGLE_REFRESH_TOKEN', 'password.json': 'connector/gmail/GMAIL_APP_PASSWORD' };
export function readGmailFiles(home: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, name] of Object.entries(GMAIL_FILES)) {
    const p = join(home, 'connectors', 'gmail', file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (!text.trim()) continue;
    let v = text;
    try { v = JSON.stringify(JSON.parse(text)); } catch { /* kept as its text, as gmail.js does */ }
    out.set(name, v);
  }
  return out;
}
export function removeGmailFiles(home: string, names: string[]): void {
  for (const [file, name] of Object.entries(GMAIL_FILES)) if (names.includes(name)) rmSync(join(home, 'connectors', 'gmail', file), { force: true });
}
