// The Hub's identity key (FR-134, docs/22 §5): an Ed25519 key in the vault, created on the first
// start. Its fingerprint is what devices pin: the Add Device QR and `GET /api/v1/hello` carry it,
// `novad install --pin` checks it, and the agent-dist area signs the novad manifest with it
// (FR-133).
//
// The public half is kept in the database (`trust_identity`). When the database says a key
// exists and the vault does not have it (a keychain the service cannot reach, a restored data
// folder without its vault) or has a different one, the identity refuses to load: a new key
// would silently break every pin, so the Hub never makes one then. Rotation is not built.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { NovaError } from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';

export const HUB_IDENTITY_REF = 'secret://hub/identity';

/** base64url(SHA-256(raw 32-byte Ed25519 public key)): 43 characters. */
export function hubFingerprint(rawPublicKey: Uint8Array): string {
  return createHash('sha256').update(rawPublicKey).digest('base64url');
}

/** The raw 32 bytes of an Ed25519 public key. */
export function rawEd25519(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('not an Ed25519 key');
  return Buffer.from(jwk.x, 'base64url');
}

/** An Ed25519 public key from base64url of its raw 32 bytes (how devices send theirs). */
export function ed25519FromRaw(base64url: string): KeyObject {
  const raw = Buffer.from(base64url, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== base64url)
    throw new Error('expected base64url of a raw 32-byte Ed25519 key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url }, format: 'jwk' });
}

/** What other areas get: the pin, the public key and signing; never the private key. */
export interface HubIdentityHandle {
  readonly fingerprint: string;
  /** base64url of the raw 32-byte public key. */
  readonly publicKey: string;
  sign(bytes: Uint8Array | string): Buffer;
}

/** Why the identity did not load: its key is gone, replaced, or the vault failed. */
export type HubIdentityFailure = 'identity_missing' | 'identity_mismatch' | 'identity_unavailable';

interface IdentityRow {
  public_key: string;
  fingerprint: string;
  key_ref: string;
}

export interface HubIdentityOptions {
  secrets: SecretStore;
  db: NovaDatabase;
  now?: () => Date;
}

export class HubIdentity implements HubIdentityHandle {
  readonly #secrets: SecretStore;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  #key: KeyObject | null = null;
  #public: KeyObject | null = null;
  #loading: Promise<void> | null = null;
  #failure: { reason: HubIdentityFailure; message: string } | null = null;

  constructor(opts: HubIdentityOptions) {
    this.#secrets = opts.secrets;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * Read the key from the vault; on the very first start (no key recorded, none in the vault)
   * create it. Refuses, with a `conflict` error naming the reason, when the recorded key is
   * missing or different. Safe to call more than once; a failure is retried on the next call.
   */
  load(): Promise<void> {
    this.#loading ??= this.#load().catch((err: unknown) => {
      this.#loading = null;
      throw err;
    });
    return this.#loading;
  }

  #fail(reason: HubIdentityFailure, message: string): never {
    this.#failure = { reason, message };
    throw new NovaError('conflict', message, { details: { reason } });
  }

  async #load(): Promise<void> {
    const row =
      (this.#db.raw
        .prepare("SELECT public_key, fingerprint, key_ref FROM trust_identity WHERE id = 'hub'")
        .get() as IdentityRow | undefined) ?? null;
    const ref = row?.key_ref ?? HUB_IDENTITY_REF;
    let pem: string | null;
    try {
      pem = await this.#secrets.get(ref);
    } catch (err) {
      this.#fail(
        'identity_unavailable',
        `The Hub identity key could not be read from the vault: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (row && !pem)
      this.#fail(
        'identity_missing',
        `The Hub identity key ${row.fingerprint} is missing from the vault. Restore the vault (or reach the keychain it was in) and restart; the Hub will not make a new identity, which every paired device would reject.`,
      );
    if (!pem) {
      // The very first start: nothing recorded, nothing in the vault.
      const { privateKey } = generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      await this.#secrets.put(ref, pem);
    }
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      this.#fail('identity_mismatch', `${ref} does not hold a readable key`);
    }
    if (key.asymmetricKeyType !== 'ed25519')
      this.#fail('identity_mismatch', `${ref} is not an Ed25519 key`);
    const pub = createPublicKey(key);
    const raw = rawEd25519(pub).toString('base64url');
    if (row && row.public_key !== raw)
      this.#fail(
        'identity_mismatch',
        `The vault holds a different Hub identity key than the one devices pinned (${row.fingerprint}); restore the original key.`,
      );
    if (!row) {
      // Record the public half so a lost or swapped key is noticed from now on.
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `INSERT INTO trust_identity (id, public_key, fingerprint, key_ref, created_at)
             VALUES ('hub', ?, ?, ?, ?)`,
          )
          .run(raw, hubFingerprint(Buffer.from(raw, 'base64url')), ref, this.#now().toISOString());
      });
    }
    this.#key = key;
    this.#public = pub;
    this.#failure = null;
  }

  get loaded(): boolean {
    return this.#key !== null;
  }

  /** Why the last load failed (for trust problems), or null. */
  get failure(): { reason: HubIdentityFailure; message: string } | null {
    return this.#failure;
  }

  #need(): { key: KeyObject; pub: KeyObject } {
    if (!this.#key || !this.#public) throw new Error('the Hub identity is not loaded');
    return { key: this.#key, pub: this.#public };
  }

  get publicKey(): string {
    return rawEd25519(this.#need().pub).toString('base64url');
  }

  get fingerprint(): string {
    return hubFingerprint(rawEd25519(this.#need().pub));
  }

  /** An Ed25519 signature over the exact bytes (strings as UTF-8). */
  sign(bytes: Uint8Array | string): Buffer {
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    return sign(null, data, this.#need().key);
  }

  verify(bytes: Uint8Array | string, signature: Uint8Array): boolean {
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    return verify(null, data, this.#need().pub, signature);
  }

  /** The two fields `GET /api/v1/hello` adds (public; no secrets). */
  helloFields(): { hubFingerprint: string; hubPublicKey: string } {
    return { hubFingerprint: this.fingerprint, hubPublicKey: this.publicKey };
  }
}
