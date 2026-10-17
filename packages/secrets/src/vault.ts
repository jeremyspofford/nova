// Secrets (FR-101, docs/12 §5, ADR-008). Callers hold only `secret://…` references; values live
// in a backend and are resolved for the duration of a call. The file vault is the fallback when
// no OS keychain is available, which is the normal case for a headless Hub.
//
// Vault file format (JSON): { v: 1, kdf, salt?, nonce, data, tag } where `data` is the
// ChaCha20-Poly1305 encryption of the JSON map ref -> value. The key is 32 random bytes in a 0600
// key file, or Argon2id(passphrase) for portable mode (docs/15 §5).
import { argon2Sync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NovaError } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';

export const SECRET_SCHEME = 'secret://';
const REF = /^secret:\/\/[a-z0-9][a-z0-9_.-]*(\/[A-Za-z0-9_.:-]+)+$/;

export function isSecretRef(value: string): boolean {
  return REF.test(value);
}

/** Build a reference from path segments, e.g. secretRef('provider', id, 'api_key'). */
export function secretRef(...segments: string[]): string {
  const ref = SECRET_SCHEME + segments.join('/');
  if (!isSecretRef(ref)) throw new NovaError('validation', `invalid secret reference: ${ref}`);
  return ref;
}

/** What Diagnostics shows about the store in use (FR-101, FR-118). */
export interface SecretStoreInfo {
  backend: 'keychain' | 'vault' | 'memory';
  detail: string;
  /** Set when the store is a fallback or is not durable, e.g. the keychain was unavailable. */
  warning: string | null;
}

export interface SecretStore {
  readonly kind: string;
  readonly info?: SecretStoreInfo;
  put(ref: string, value: string): Promise<void>;
  /** Resolve a value. Every value read is registered with the redactor so it never leaks. */
  get(ref: string): Promise<string | null>;
  has(ref: string): Promise<boolean>;
  delete(ref: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
}

interface VaultFile {
  v: 1;
  kdf: 'keyfile' | 'argon2id';
  salt?: string;
  nonce: string;
  data: string;
  tag: string;
}

export type VaultKey =
  { kind: 'keyfile'; path: string } | { kind: 'passphrase'; passphrase: string };

// Argon2id parameters (docs/12 §5): 64 MiB, 3 passes, 4 lanes.
const ARGON = { memory: 64 * 1024, passes: 3, parallelism: 4, tagLength: 32 } as const;

export interface FileVaultOptions {
  /** Shown in Diagnostics, e.g. why the OS keychain was not used. */
  warning?: string | null;
}

export class FileVault implements SecretStore {
  readonly kind = 'file-vault';
  readonly info: SecretStoreInfo;
  readonly #path: string;
  readonly #keySpec: VaultKey;
  readonly #redactor: Redactor;
  #key: Buffer | null = null;
  #salt: Buffer | null = null;
  #cache: Map<string, string> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    path: string,
    key: VaultKey,
    redactor: Redactor = defaultRedactor,
    opts: FileVaultOptions = {},
  ) {
    this.#path = path;
    this.#keySpec = key;
    this.#redactor = redactor;
    this.info = {
      backend: 'vault',
      detail:
        key.kind === 'keyfile'
          ? 'Encrypted file vault (ChaCha20-Poly1305, key file)'
          : 'Encrypted file vault (ChaCha20-Poly1305, passphrase)',
      warning: opts.warning ?? null,
    };
  }

  /** Whether the vault file exists yet. */
  exists(): boolean {
    return existsSync(this.#path);
  }

  #deriveKey(file: VaultFile | null): Buffer {
    if (this.#keySpec.kind === 'keyfile') {
      if (file && file.kdf !== 'keyfile')
        throw new NovaError('auth_missing', 'vault needs its passphrase');
      return this.#keyFile(this.#keySpec.path);
    }
    if (file && file.kdf !== 'argon2id')
      throw new NovaError('auth_missing', 'vault uses a key file');
    this.#salt = file?.salt ? Buffer.from(file.salt, 'base64') : randomBytes(16);
    return argon2Sync('argon2id', {
      message: Buffer.from(this.#keySpec.passphrase, 'utf8'),
      nonce: this.#salt,
      ...ARGON,
    });
  }

  #keyFile(path: string): Buffer {
    if (existsSync(path)) {
      const key = readFileSync(path);
      if (key.length !== 32) throw new NovaError('validation', 'vault key file is corrupt');
      return key;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
    return key;
  }

  #load(): Map<string, string> {
    if (this.#cache) return this.#cache;
    if (!existsSync(this.#path)) {
      this.#key = this.#deriveKey(null);
      this.#cache = new Map();
      return this.#cache;
    }
    let file: VaultFile;
    try {
      file = JSON.parse(readFileSync(this.#path, 'utf8')) as VaultFile;
    } catch {
      throw new NovaError('validation', 'vault file is corrupt');
    }
    if (file.v !== 1)
      throw new NovaError('validation', `unsupported vault version ${String(file.v)}`);
    this.#key = this.#deriveKey(file);
    let plain: string;
    try {
      const d = createDecipheriv(
        'chacha20-poly1305',
        this.#key,
        Buffer.from(file.nonce, 'base64'),
        {
          authTagLength: 16,
        },
      );
      d.setAuthTag(Buffer.from(file.tag, 'base64'));
      plain = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]).toString(
        'utf8',
      );
    } catch {
      // Wrong key or tampered file: refuse rather than guess (fail closed).
      throw new NovaError('auth_missing', 'vault cannot be opened: wrong key or tampered file');
    }
    this.#cache = new Map(Object.entries(JSON.parse(plain) as Record<string, string>));
    for (const v of this.#cache.values()) this.#redactor.addLiteral(v);
    return this.#cache;
  }

  #save(map: Map<string, string>): void {
    const key = this.#key ?? this.#deriveKey(null);
    const nonce = randomBytes(12);
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    const data = Buffer.concat([
      c.update(JSON.stringify(Object.fromEntries(map)), 'utf8'),
      c.final(),
    ]);
    const file: VaultFile = {
      v: 1,
      kdf: this.#keySpec.kind === 'keyfile' ? 'keyfile' : 'argon2id',
      nonce: nonce.toString('base64'),
      data: data.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
    };
    if (this.#salt) file.salt = this.#salt.toString('base64');
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.#path);
    chmodSync(this.#path, 0o600);
  }

  #serial<T>(fn: () => T): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  put(ref: string, value: string): Promise<void> {
    return this.#serial(() => {
      assertRef(ref);
      if (value.length === 0) throw new NovaError('validation', 'secret value is empty');
      const map = this.#load();
      map.set(ref, value);
      this.#redactor.addLiteral(value);
      this.#save(map);
    });
  }

  get(ref: string): Promise<string | null> {
    return this.#serial(() => {
      assertRef(ref);
      const v = this.#load().get(ref) ?? null;
      if (v) this.#redactor.addLiteral(v);
      return v;
    });
  }

  has(ref: string): Promise<boolean> {
    return this.#serial(() => {
      assertRef(ref);
      return this.#load().has(ref);
    });
  }

  delete(ref: string): Promise<boolean> {
    return this.#serial(() => {
      assertRef(ref);
      const map = this.#load();
      const existed = map.delete(ref);
      if (existed) this.#save(map);
      return existed;
    });
  }

  list(prefix = SECRET_SCHEME): Promise<string[]> {
    return this.#serial(() => [...this.#load().keys()].filter((k) => k.startsWith(prefix)).sort());
  }
}

/** In-memory store for tests and ephemeral profiles. */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  readonly info: SecretStoreInfo = {
    backend: 'memory',
    detail: 'In-memory store',
    warning:
      'Secrets are kept in memory only: they are not encrypted at rest and are lost when the Hub stops.',
  };
  readonly #map = new Map<string, string>();
  readonly #redactor: Redactor;
  constructor(redactor: Redactor = defaultRedactor) {
    this.#redactor = redactor;
  }
  put(ref: string, value: string): Promise<void> {
    return attempt(() => {
      assertRef(ref);
      this.#map.set(ref, value);
      this.#redactor.addLiteral(value);
    });
  }
  get(ref: string): Promise<string | null> {
    return attempt(() => {
      assertRef(ref);
      return this.#map.get(ref) ?? null;
    });
  }
  has(ref: string): Promise<boolean> {
    return attempt(() => {
      assertRef(ref);
      return this.#map.has(ref);
    });
  }
  delete(ref: string): Promise<boolean> {
    return attempt(() => {
      assertRef(ref);
      return this.#map.delete(ref);
    });
  }
  list(prefix = SECRET_SCHEME): Promise<string[]> {
    return attempt(() => [...this.#map.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
}

/** Run synchronously-throwing code so errors surface as rejections, like the async stores. */
function attempt<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}

/** Throws `validation` unless `ref` is a well-formed `secret://` reference. */
export function assertSecretRef(ref: string): void {
  if (!isSecretRef(ref)) throw new NovaError('validation', 'not a secret:// reference');
}

const assertRef = assertSecretRef;
