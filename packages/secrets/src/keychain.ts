// OS keychain backends behind the SecretStore interface (FR-101, docs/12 §5, ADR-008). Linux
// uses the Secret Service (libsecret) through the `secret-tool` CLI when a D-Bus session bus is
// present; macOS uses the `security` CLI. Values never appear in a process argument list:
// `secret-tool store` reads stdin, and `security` runs in interactive mode fed through stdin.
// Values are stored base64-encoded so newlines and binary-looking text round-trip exactly.
// Neither CLI can list items portably, so the store keeps an index of its references (names
// only, never values) in one extra keychain item.
import { spawn } from 'node:child_process';
import { NovaError } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import { SECRET_SCHEME, assertSecretRef, type SecretStore, type SecretStoreInfo } from './vault.ts';

export interface CommandResult {
  /** Exit code, or null when the command could not run (see `error`). */
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface RunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Run a command without a shell; never rejects. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: 'pipe', shell: false });
    // A locked keyring can open a prompt nobody will answer on a headless Hub.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout, stderr, error: `${cmd} timed out` });
    }, opts.timeoutMs ?? 10_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => undefined); // the command may exit before reading its input
    child.on('error', (err) => done({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => done({ code, stdout, stderr, error: null }));
    child.stdin.end(opts.input ?? '');
  });
}

export interface KeychainBackend {
  /** Human-readable, for Diagnostics. */
  readonly name: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
  remove(account: string): Promise<boolean>;
}

export interface CliBackendOptions {
  /** The CLI to run (a path in tests). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Service name the items are filed under (default `nova`). */
  service?: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decode(raw: string): string {
  const text = raw.trim();
  if (!BASE64.test(text))
    throw new NovaError('server_error', 'a keychain item is not in the format Nova writes');
  return Buffer.from(text, 'base64').toString('utf8');
}

function failure(cli: string, action: string, r: CommandResult): NovaError {
  const why = r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${String(r.code)}`);
  // The message names the reference at most; values are never on the command line or in stderr.
  return new NovaError('server_error', `the OS keychain could not ${action} (${cli}: ${why})`);
}

const PROBE = 'nova-probe';

/** Linux Secret Service through `secret-tool` (libsecret). */
export function libsecretBackend(opts: CliBackendOptions = {}): KeychainBackend {
  const cmd = opts.command ?? 'secret-tool';
  const service = opts.service ?? 'nova';
  const env = opts.env ?? process.env;
  const attrs = (account: string) => ['service', service, 'ref', account];
  const run = (args: string[], input?: string) =>
    runCommand(cmd, args, { env, timeoutMs: opts.timeoutMs, ...(input ? { input } : {}) });
  const read = async (account: string): Promise<string | null> => {
    const r = await run(['lookup', ...attrs(account)]);
    if (r.code === 0) return decode(r.stdout);
    // Exit 1 with nothing on stderr is "no such item"; anything else is a real failure.
    if (r.code === 1 && r.stderr.trim() === '') return null;
    throw failure('secret-tool', 'read a secret', r);
  };
  return {
    name: 'Secret Service (secret-tool)',
    async available() {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return { ok: false, detail: 'no D-Bus session bus' };
      const r = await run(['lookup', ...attrs(PROBE)]);
      if (r.code === 0 || (r.code === 1 && r.stderr.trim() === ''))
        return { ok: true, detail: 'Secret Service (secret-tool)' };
      return { ok: false, detail: failure('secret-tool', 'be reached', r).message };
    },
    read,
    async write(account, value) {
      const r = await run(['store', `--label=Nova ${account}`, ...attrs(account)], encode(value));
      if (r.code !== 0) throw failure('secret-tool', 'store a secret', r);
    },
    async remove(account) {
      const existed = (await read(account)) !== null;
      if (!existed) return false;
      const r = await run(['clear', ...attrs(account)]);
      if (r.code !== 0) throw failure('secret-tool', 'delete a secret', r);
      return true;
    },
  };
}

/** The macOS login keychain through `security`. */
export function macosKeychainBackend(opts: CliBackendOptions = {}): KeychainBackend {
  const cmd = opts.command ?? 'security';
  const service = opts.service ?? 'nova';
  const run = (args: string[], input?: string) =>
    runCommand(cmd, args, {
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      ...(input ? { input } : {}),
    });
  // `security` exits 44 when the item does not exist.
  const NOT_FOUND = 44;
  return {
    name: 'macOS Keychain (security)',
    async available() {
      const r = await run(['default-keychain']);
      if (r.code === 0) return { ok: true, detail: 'macOS Keychain (security)' };
      return { ok: false, detail: failure('security', 'be reached', r).message };
    },
    async read(account) {
      const r = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (r.code === 0) return decode(r.stdout);
      if (r.code === NOT_FOUND) return null;
      throw failure('security', 'read a secret', r);
    },
    async write(account, value) {
      // Interactive mode reads the command from stdin, so the value stays off the argument list.
      // References and base64 contain no spaces or quotes, so no escaping is needed.
      const line = `add-generic-password -U -s ${service} -a ${account} -l Nova -w ${encode(value)}\n`;
      const r = await run(['-i'], line);
      if (r.code !== 0 || r.stderr.trim() !== '') throw failure('security', 'store a secret', r);
    },
    async remove(account) {
      const r = await run(['delete-generic-password', '-s', service, '-a', account]);
      if (r.code === 0) return true;
      if (r.code === NOT_FOUND) return false;
      throw failure('security', 'delete a secret', r);
    },
  };
}

/** The keychain this platform offers, or null (Windows and others until a backend exists). */
export function platformKeychain(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): KeychainBackend | null {
  if (platform === 'darwin') return macosKeychainBackend({ env });
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd')
    return libsecretBackend({ env });
  return null;
}

const INDEX = 'nova-index';

/** A SecretStore over an OS keychain backend. */
export class KeychainStore implements SecretStore {
  readonly kind = 'keychain';
  readonly info: SecretStoreInfo;
  readonly #backend: KeychainBackend;
  readonly #redactor: Redactor;
  #index: Set<string> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(backend: KeychainBackend, redactor: Redactor = defaultRedactor) {
    this.#backend = backend;
    this.#redactor = redactor;
    this.info = { backend: 'keychain', detail: backend.name, warning: null };
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #loadIndex(): Promise<Set<string>> {
    if (this.#index) return this.#index;
    const raw = await this.#backend.read(INDEX);
    let refs: unknown = [];
    try {
      refs = raw ? JSON.parse(raw) : [];
    } catch {
      // A damaged index only affects listing; it is rebuilt by the next write.
    }
    this.#index = new Set(Array.isArray(refs) ? refs.filter((r) => typeof r === 'string') : []);
    return this.#index;
  }

  async #updateIndex(change: (index: Set<string>) => boolean): Promise<void> {
    const index = await this.#loadIndex();
    if (change(index)) await this.#backend.write(INDEX, JSON.stringify([...index].sort()));
  }

  put(ref: string, value: string): Promise<void> {
    return this.#serial(async () => {
      assertSecretRef(ref);
      if (value.length === 0) throw new NovaError('validation', 'secret value is empty');
      this.#redactor.addLiteral(value);
      await this.#backend.write(ref, value);
      await this.#updateIndex((i) => !i.has(ref) && !!i.add(ref));
    });
  }

  get(ref: string): Promise<string | null> {
    return this.#serial(async () => {
      assertSecretRef(ref);
      const value = await this.#backend.read(ref);
      if (value) this.#redactor.addLiteral(value);
      return value;
    });
  }

  has(ref: string): Promise<boolean> {
    return this.#serial(async () => {
      assertSecretRef(ref);
      return (await this.#backend.read(ref)) !== null;
    });
  }

  delete(ref: string): Promise<boolean> {
    return this.#serial(async () => {
      assertSecretRef(ref);
      const existed = await this.#backend.remove(ref);
      await this.#updateIndex((i) => i.delete(ref));
      return existed;
    });
  }

  list(prefix = SECRET_SCHEME): Promise<string[]> {
    return this.#serial(async () =>
      [...(await this.#loadIndex())].filter((r) => r.startsWith(prefix)).sort(),
    );
  }
}
