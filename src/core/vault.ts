// The vault (inventory row 58; Era 1's packages/secrets, ported and narrowed). Secrets live here
// and nowhere else: connectors hold names (`secret://connector/home-assistant/HA_TOKEN`), and the
// values are read for the moment a call needs them.
//
// At rest: one file, home/vault/secrets.json (0600), AES-256-GCM over the JSON map of name → value,
// with the vault's id as associated data. The 32-byte key lives in the OS keychain when there is one
// (Linux `secret-tool`, macOS `security`, Windows Credential Locker through PowerShell), otherwise in
// home/vault/key (0600), and then the person is told plainly that the key sits next to the vault.
// Values never go on a command line: each keychain CLI reads them from stdin.
//
// The vault is untracked in the home's git (home.js), not journalled as a file (mesh/sync.ts), and
// every value it holds is redacted from logs, problems and receipts (log.ts). A standby gets the
// ciphertext and the key inside the sync stream, which is sealed to the standby's own key, so
// connectors work again after a failover.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from './errors.ts';
import { addSecretValue } from './log.ts';

export const VAULT_DIR = 'vault';
export const VAULT_FILE = 'secrets.json';
export const KEY_FILE = 'key';
export const SECRET_SCHEME = 'secret://';
// connector/home-assistant/HA_TOKEN: lowercase path segments, then a name.
const NAME = /^[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;
const AAD = (id: string) => Buffer.from(`nova-vault-v1|${id}`, 'utf8');
const SERVICE = 'nova-vault';

export const isSecretName = (name: string) => typeof name === 'string' && name.length <= 200 && NAME.test(name);
export const secretRef = (name: string) => `${SECRET_SCHEME}${checkName(name)}`;
export function nameOf(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith(SECRET_SCHEME)) throw new CoreError('validation', 'That isn’t a secret:// reference.');
  return checkName(ref.slice(SECRET_SCHEME.length));
}
function checkName(name: string): string {
  if (!isSecretName(name)) throw new CoreError('validation', `“${String(name)}” isn’t a secret name Nova uses (letters, digits, dots, dashes, slashes).`);
  return name;
}

// ---- where the key lives ------------------------------------------------------------------------

export interface CommandResult { code: number | null; stdout: string; stderr: string; error: string | null }
export type Run = (cmd: string, args: string[], input?: string) => CommandResult;

// Without a shell, with a timeout: a locked keyring can open a prompt nobody will answer.
export const runCommand: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input: input ?? '', encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? r.error.message : null };
};

export interface KeyStore {
  kind: 'keychain' | 'file';
  // In plain words, for Settings and health: “the system keychain (secret-tool)”.
  name: string;
  available(): { ok: boolean; detail: string };
  read(): Buffer | null;
  write(key: Buffer): void;
  remove(): void;
}

function decodeKey(text: string): Buffer | null {
  const key = Buffer.from(text.trim(), 'base64');
  return key.length === 32 ? key : null;
}
const failure = (cli: string, what: string, r: CommandResult) =>
  new Error(`The system keychain couldn’t ${what} (${cli}: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)}).`);

export function fileKeyStore(home: string): KeyStore {
  const path = join(home, VAULT_DIR, KEY_FILE);
  return {
    kind: 'file',
    name: `a key file next to the vault (${path})`,
    available: () => ({ ok: true, detail: path }),
    read: () => {
      if (!existsSync(path)) return null;
      const key = readFileSync(path);
      if (key.length !== 32) throw new CoreError('conflict', `The vault’s key file (${path}) is damaged: it should be 32 bytes.`);
      return key;
    },
    write: (key) => {
      mkdirSync(join(home, VAULT_DIR), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, key, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      chmodSync(path, 0o600);
    },
    remove: () => rmSync(path, { force: true }),
  };
}

// Linux: the Secret Service, through libsecret's CLI. Exit 1 with nothing on stderr is “no such item”.
export function secretToolKeyStore(account: string, o: { run?: Run; env?: NodeJS.ProcessEnv; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const env = o.env ?? process.env;
  const cmd = o.command ?? 'secret-tool';
  const attrs = ['service', SERVICE, 'account', account];
  const lookup = (acct: string) => run(cmd, ['lookup', 'service', SERVICE, 'account', acct]);
  return {
    kind: 'keychain',
    name: 'the system keychain (secret-tool)',
    available: () => {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return { ok: false, detail: 'no desktop session to reach the keychain through' };
      const r = lookup('nova-probe');
      if (r.code === 0 || (r.code === 1 && !r.stderr.trim())) return { ok: true, detail: 'secret-tool' };
      return { ok: false, detail: r.error ?? r.stderr.trim().split('\n')[0] ?? `exit code ${r.code}` };
    },
    read: () => {
      const r = lookup(account);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 1 && !r.stderr.trim()) return null;
      throw failure('secret-tool', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = run(cmd, ['store', `--label=Nova vault key (${account})`, ...attrs], key.toString('base64'));
      if (r.code !== 0) throw failure('secret-tool', 'store the vault’s key', r);
    },
    remove: () => { run(cmd, ['clear', ...attrs]); },
  };
}

// macOS: the login keychain. Interactive mode reads the command from stdin, so the key stays off
// the argument list. Exit 44 is “no such item”.
export function macKeyStore(account: string, o: { run?: Run; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const cmd = o.command ?? 'security';
  return {
    kind: 'keychain',
    name: 'the macOS keychain',
    available: () => {
      const r = run(cmd, ['default-keychain']);
      return r.code === 0 ? { ok: true, detail: 'security' } : { ok: false, detail: r.error ?? (r.stderr.trim() || `exit code ${r.code}`) };
    },
    read: () => {
      const r = run(cmd, ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 44) return null;
      throw failure('security', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = run(cmd, ['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -l "Nova vault key" -w ${key.toString('base64')}\n`);
      if (r.code !== 0 || r.stderr.trim()) throw failure('security', 'store the vault’s key', r);
    },
    remove: () => { run(cmd, ['delete-generic-password', '-s', SERVICE, '-a', account]); },
  };
}

// Windows: the Credential Locker (it shows in Credential Manager), through PowerShell's WinRT
// binding. The key comes in on stdin. Not exercised on a real Windows machine yet (docs/LEDGER.md).
export function windowsKeyStore(account: string, o: { run?: Run; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const cmd = o.command ?? 'powershell.exe';
  const vault = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;`;
  const find = `try { $c = $v.Retrieve('${SERVICE}', '${account}') } catch { exit 44 };`;
  const ps = (script: string, input?: string) => run(cmd, ['-NoProfile', '-NonInteractive', '-Command', `& { ${vault} ${script} }`], input);
  return {
    kind: 'keychain',
    name: 'Windows Credential Manager',
    available: () => {
      const r = ps('exit 0');
      return r.code === 0 ? { ok: true, detail: 'PasswordVault' } : { ok: false, detail: r.error ?? (r.stderr.trim() || `exit code ${r.code}`) };
    },
    read: () => {
      const r = ps(`${find} $c.RetrievePassword(); [Console]::Out.Write($c.Password)`);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 44) return null;
      throw failure('PowerShell', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = ps(`$p = [Console]::In.ReadToEnd().Trim(); $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', '${account}', $p)))`, key.toString('base64'));
      if (r.code !== 0) throw failure('PowerShell', 'store the vault’s key', r);
    },
    remove: () => { ps(`${find} $v.Remove($c)`); },
  };
}

export function platformKeyStore(account: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Run } = {}): KeyStore | null {
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') return macKeyStore(account, o);
  if (platform === 'win32') return windowsKeyStore(account, o);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return secretToolKeyStore(account, o);
  return null;
}

// file: always the key file. keychain: the OS keychain or nothing. auto: the keychain when one
// answers, else the file. Under the test runner, auto means file: tests never touch a real keychain.
export type KeyMode = 'auto' | 'keychain' | 'file';
export function keyMode(env: NodeJS.ProcessEnv = process.env): KeyMode {
  const v = env.NOVA_VAULT_KEY;
  if (v === 'file' || v === 'keychain') return v;
  return env.NODE_TEST_CONTEXT ? 'file' : 'auto';
}

// ---- the vault ----------------------------------------------------------------------------------

interface VaultFile { v: 1; id: string; alg: 'aes-256-gcm'; fp: string; nonce: string; tag: string; data: string }

export interface VaultOptions {
  home: string;
  mode?: KeyMode;
  // The keychain to use for a vault id (tests inject one); defaults to this platform's.
  keychain?: ((account: string) => KeyStore | null) | null;
}

export interface VaultStatus {
  ok: boolean;
  secrets: number;
  // Where the key is, once there is one: keychain or file.
  key: 'keychain' | 'file' | null;
  where: string | null;
  // Said plainly when the key sits next to the vault on disk.
  notice: string | null;
  problem: string | null;
}

export const FILE_KEY_NOTICE = 'Nova keeps your connection secrets encrypted, but on this computer there is no system keychain it can use, so the key is in a file next to them (vault/key in Nova’s home). Anyone who can read Nova’s home folder can open them. Nova moves the key into the keychain by itself once one is available.';

const fp = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export class Vault extends EventEmitter {
  readonly dir: string;
  readonly file: string;
  #home: string;
  #mode: KeyMode;
  #keychainFor: (account: string) => KeyStore | null;
  #key: Buffer | null = null;
  #store: KeyStore | null = null;
  #id: string | null = null;
  #map: Map<string, string> | null = null;
  #problem: string | null = null;

  constructor(o: VaultOptions) {
    super();
    this.#home = o.home;
    this.dir = join(o.home, VAULT_DIR);
    this.file = join(this.dir, VAULT_FILE);
    this.#mode = o.mode ?? keyMode();
    this.#keychainFor = o.keychain === null ? () => null : (o.keychain ?? ((account) => platformKeyStore(account)));
  }

  // ---- reading and writing ------------------------------------------------------------------

  has(name: string): boolean {
    return this.#open().has(checkName(name));
  }

  get(name: string): string | null {
    return this.#open().get(checkName(name)) ?? null;
  }

  resolve(ref: string): string | null {
    return this.get(nameOf(ref));
  }

  put(name: string, value: string): string {
    checkName(name);
    if (typeof value !== 'string' || !value.length) throw new CoreError('validation', 'A secret can’t be empty.');
    const map = this.#open();
    map.set(name, value);
    addSecretValue(value);
    this.#save(map);
    return secretRef(name);
  }

  delete(name: string): boolean {
    const map = this.#open();
    if (!map.delete(checkName(name))) return false;
    this.#save(map);
    return true;
  }

  // Everything under a prefix (`connector/gmail/`), for revoking an extension's secrets at once.
  deletePrefix(prefix: string): string[] {
    const map = this.#open();
    const gone = [...map.keys()].filter((k) => k.startsWith(prefix));
    if (!gone.length) return [];
    for (const k of gone) map.delete(k);
    this.#save(map);
    return gone;
  }

  list(prefix = ''): string[] {
    return [...this.#open().keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  status(): VaultStatus {
    try {
      const n = this.#open().size;
      const store = this.#key ? this.#store : null;
      return { ok: true, secrets: n, key: store?.kind ?? null, where: store?.name ?? null, notice: store?.kind === 'file' && n > 0 ? FILE_KEY_NOTICE : null, problem: null };
    } catch (e) {
      return { ok: false, secrets: 0, key: null, where: null, notice: null, problem: (e as Error).message };
    }
  }

  // ---- the standby's copy (mesh/sync.ts) ------------------------------------------------------

  // The encrypted file as it is on disk, for the sync log. Never the key.
  sealedFile(): string | null {
    try { return readFileSync(this.file, 'utf8'); } catch { return null; }
  }

  // The key, for the sync stream only: it travels inside a batch sealed to the standby's own key.
  keyForStandby(): string | null {
    if (!existsSync(this.file)) return null;
    this.#open();
    return this.#key?.toString('base64') ?? null;
  }

  // On the standby: the hub's vault, and its key, which goes into this node's own key store.
  adopt(fileText: string, keyB64: string): void {
    const key = Buffer.from(String(keyB64), 'base64');
    if (key.length !== 32) throw new CoreError('validation', 'The hub sent a vault key Nova can’t use.');
    const file = parseFile(fileText);
    const map = decrypt(file, key);
    const store = this.#choose(file.id);
    store.write(key);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.file, fileText);
    this.#id = file.id;
    this.#key = key;
    this.#store = store;
    this.#map = map;
    this.#problem = null;
    for (const v of map.values()) addSecretValue(v);
    this.emit('change', { secrets: map.size });
  }

  // On the standby: the hub's vault is gone (its last secret was removed).
  clear(): void {
    rmSync(this.file, { force: true });
    this.#map = new Map();
    this.emit('change', { secrets: 0 });
  }

  // ---- inside -------------------------------------------------------------------------------

  // The keychain when the mode allows one and it answers, else the key file.
  #choose(id = this.#id ?? 'new'): KeyStore {
    const file = fileKeyStore(this.#home);
    if (this.#mode === 'file') return file;
    const kc = this.#keychainFor(`vault-${id}`);
    const up = kc ? kc.available() : { ok: false, detail: 'none on this platform' };
    if (kc && up.ok) return kc;
    if (this.#mode === 'keychain') throw new CoreError('conflict', `Nova is set to keep the vault’s key in the system keychain (NOVA_VAULT_KEY=keychain), but none answers: ${up.detail}.`);
    return file;
  }

  #open(): Map<string, string> {
    if (this.#map) return this.#map;
    if (this.#problem) throw new CoreError('conflict', this.#problem);
    if (!existsSync(this.file)) {
      this.#map = new Map();
      return this.#map;
    }
    let file: VaultFile;
    try {
      file = parseFile(readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.#problem = `The vault (${this.file}) is damaged and can’t be read: ${(e as Error).message}`;
      throw new CoreError('conflict', this.#problem);
    }
    this.#id = file.id;
    const { key, store } = this.#findKey(file);
    this.#map = decrypt(file, key);
    this.#key = key;
    this.#store = store;
    for (const v of this.#map.values()) addSecretValue(v);
    return this.#map;
  }

  // The key for this vault, wherever it is. A key found in the file while a keychain answers is
  // moved into the keychain (written, read back, and only then removed from disk).
  #findKey(file: VaultFile): { key: Buffer; store: KeyStore } {
    const disk = fileKeyStore(this.#home);
    const kc = this.#mode === 'file' ? null : this.#keychainFor(`vault-${file.id}`);
    const kcUp = kc ? kc.available() : null;
    const fromKc = kc && kcUp?.ok ? kc.read() : null;
    const fromDisk = disk.read();
    const fits = (k: Buffer | null) => !!k && fp(k) === file.fp;
    if (fits(fromKc)) {
      if (fromDisk && fits(fromDisk)) disk.remove();
      return { key: fromKc!, store: kc! };
    }
    if (fits(fromDisk)) {
      if (kc && kcUp?.ok) {
        try {
          kc.write(fromDisk!);
          if (fits(kc.read())) { disk.remove(); return { key: fromDisk!, store: kc }; }
        } catch { /* the keychain refused: the file stays where it is */ }
      }
      return { key: fromDisk!, store: disk };
    }
    const where = kc && !kcUp?.ok ? ` It may be in the system keychain, which isn’t answering (${kcUp?.detail}).` : '';
    this.#problem = `Nova can’t find the key to its vault, so connections that need a secret can’t sign in.${where} Reconnect them to start a new vault.`;
    throw new CoreError('conflict', this.#problem);
  }

  #save(map: Map<string, string>): void {
    if (!this.#key) {
      this.#id ??= randomUUID();
      const store = this.#choose(this.#id);
      const key = randomBytes(32);
      store.write(key);
      this.#key = key;
      this.#store = store;
    }
    if (!map.size) {
      rmSync(this.file, { force: true });
      this.emit('change', { secrets: 0 });
      return;
    }
    const id = this.#id!;
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, nonce);
    c.setAAD(AAD(id));
    const data = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(map)), 'utf8'), c.final()]);
    const out: VaultFile = { v: 1, id, alg: 'aes-256-gcm', fp: fp(this.#key), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.file, `${JSON.stringify(out)}\n`);
    this.emit('change', { secrets: map.size });
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function parseFile(text: string): VaultFile {
  const f = JSON.parse(text) as VaultFile;
  if (f?.v !== 1 || f.alg !== 'aes-256-gcm' || typeof f.id !== 'string' || typeof f.data !== 'string' || typeof f.fp !== 'string') throw new Error('not a vault Nova knows');
  return f;
}

// Wrong key or a tampered file: refused, never guessed at.
function decrypt(f: VaultFile, key: Buffer): Map<string, string> {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
    d.setAAD(AAD(f.id));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
    return new Map(Object.entries(JSON.parse(plain) as Record<string, string>));
  } catch {
    throw new CoreError('conflict', 'The vault doesn’t open with its key: the key is wrong or the file was changed.');
  }
}
