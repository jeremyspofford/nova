// This node's own keys: Ed25519 to sign (rosters, the reveal), X25519 to seal. They live in
// home/mesh/identity.json, mode 0600, and nowhere else: never in the database, logs, receipts or
// sync. The private halves stay inside this module; callers get sign, seal and open.
import { randomUUID, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportDeviceKeys, generateDeviceKeys, importDeviceKeys, keyFingerprint, open, seal, signMessage, type DeviceKeysJson } from './wire.ts';

interface IdentityFile extends DeviceKeysJson { version: 1; id: string; created_at: string }

export interface MeshIdentity {
  // This node's device id in the registry.
  readonly id: string;
  readonly publicKey: string;
  readonly x25519PublicKey: string;
  readonly fingerprint: string;
  readonly file: string;
  sign(message: Uint8Array): string;
  seal(toX25519Pub: string, bytes: Uint8Array, aad?: Uint8Array): Buffer;
  open(fromX25519Pub: string, sealed: Uint8Array, aad?: Uint8Array): Buffer;
  // Signs with the identity key; for signRoster and the like, without handing the key out.
  signer(): KeyObject;
}

// Loads the identity, making one on first start. A file that others can read is tightened to 0600
// and reported through `warn`, since the keys in it may already have been seen.
export function loadIdentity(home: string, o: { now?: () => Date; warn?: (msg: string) => void } = {}): MeshIdentity {
  const dir = join(home, 'mesh');
  const file = join(dir, 'identity.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let data: IdentityFile;
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      chmodSync(file, 0o600);
      o.warn?.(`The hub's identity file could be read by other users (mode ${mode.toString(8)}); it is 0600 now. If others share this machine, consider making a new identity.`);
    }
    data = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
    if (data.version !== 1 || typeof data.id !== 'string') throw new Error(`${file} isn't an identity file Nova knows.`);
  } else {
    data = { version: 1, id: randomUUID(), created_at: (o.now?.() ?? new Date()).toISOString(), ...exportDeviceKeys(generateDeviceKeys()) };
    // Written whole, then moved into place, so a crash never leaves half a key file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  const keys = importDeviceKeys(data);
  const id = data.id;
  const identity: MeshIdentity = {
    id,
    publicKey: keys.ed25519.publicKey,
    x25519PublicKey: keys.x25519.publicKey,
    fingerprint: keyFingerprint(keys.ed25519.publicKey),
    file,
    sign: (m) => signMessage(keys.ed25519.privateKey, m),
    seal: (to, bytes, aad) => seal(to, keys.x25519.privateKey, bytes, aad),
    open: (from, sealed, aad) => open(from, keys.x25519.privateKey, sealed, aad),
    signer: () => keys.ed25519.privateKey,
  };
  // If the identity is ever logged or serialized, only the public parts go.
  Object.defineProperty(identity, 'toJSON', { value: () => ({ id, publicKey: identity.publicKey, x25519PublicKey: identity.x25519PublicKey, fingerprint: identity.fingerprint }) });
  return identity;
}
