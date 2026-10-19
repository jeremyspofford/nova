// Environment transports (FR-213, FR-062; docs/10 §2, §15). One way for the Code area to run Git
// and touch files wherever a session works, so change capture, review, commits, handoffs and
// merges run the same code on this Hub, over SSH, on a device or in the cloud:
//
// - `EnvironmentTransport` is the seam: run a program (argv, bytes in and out) and name Nova's own
//   state folder there. The cloud environment implements it on its runner (the cloudrun area) and
//   registers it with `CodeService.useEnvironmentTransport('cloud', ...)`.
// - `helperTransport` implements it over a `novad`-style helper connection (SSH, WSL, device):
//   each run is one helper process whose stdin, stdout and stderr travel base64-framed, so bytes
//   survive the helper's text channel; output above the inline limit is fetched in chunks.
// - `LocalTransport` runs programs on this Hub (tests use it as a stand-in for other machines).
//
// A `CodeWorkspace` is what the services use: hook-free Git (FR-211) with HookFreeGit's call shape
// and a small file API. On this Hub it is HookFreeGit and node:fs; elsewhere `TransportGit` and
// POSIX tools through the transport. Remote Git calls point `core.hooksPath` at /dev/null, drop
// inherited `GIT_*` variables and never prompt, like the Hub's own.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { NovaError } from '@nova/shared';
import { isWithin } from '@nova/security';
import type { EnvHelperConnection } from './environments.ts';
import { hookFreeArgs, type GitResult, type GitRunOptions, type HookFreeGit } from './git.ts';

// ---- the seam ----------------------------------------------------------------------------------

export interface TransportRunRequest {
  /** The program and its arguments; never interpreted by a shell on the Hub's side. */
  argv: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  /** Variables removed from the program's environment (`GIT_DIR`, …). */
  unset?: readonly string[];
  input?: Buffer | string;
  /** Default 120 s. */
  timeoutMs?: number;
  /** Bytes of stdout kept (default 64 MiB); more fails the call. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface TransportRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs programs in one environment (docs/10 §2): the cloud kind implements it on its runner. */
export interface EnvironmentTransport {
  /** What it reaches, for messages ("dev@build.example", a device's name, "the cloud runner"). */
  readonly label: string;
  run(req: TransportRunRequest): Promise<TransportRunResult>;
  /** Nova's own folder in the environment (shadow repositories, scratch), private to its user. */
  stateDir(): Promise<string>;
}

/** Files Nova reads and writes for its own bookkeeping in an environment. */
export interface WorkFs {
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'symlink' | 'other'; size: number } | null>;
  readFile(path: string, maxBytes?: number): Promise<Buffer>;
  /** Write a file (parent folders created), with the given mode (default 0644). */
  writeFile(path: string, data: Buffer | string, mode?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  /** Move a file or folder (the target must not exist). */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file inside `root` without following a symbolic link out of it. */
  removeWithin(root: string, rel: string): Promise<void>;
  /**
   * Write a file inside `root` (parent folders created) without following a symbolic link out of
   * it: a link in its place is replaced, a parent that resolves outside `root` is refused.
   */
  writeWithin(root: string, rel: string, data: Buffer | string, mode?: number): Promise<void>;
}

/** Where a session's Git and files are reached (this Hub or another machine). */
export interface CodeWorkspace {
  readonly label: string;
  /** Paths are this Hub's own (local and container environments). */
  readonly hubLocal: boolean;
  /** Hook-free Git with HookFreeGit's call shape (shadow.ts and commit.ts take it). */
  readonly git: HookFreeGit;
  readonly fs: WorkFs;
  stateDir(): Promise<string>;
  /** The transport of a workspace on another machine (absent on this Hub). */
  readonly transport?: EnvironmentTransport;
}

// ---- this Hub ----------------------------------------------------------------------------------

export const nodeWorkFs: WorkFs = {
  async stat(path) {
    try {
      const s = await lstat(path);
      return {
        kind: s.isSymbolicLink()
          ? 'symlink'
          : s.isDirectory()
            ? 'dir'
            : s.isFile()
              ? 'file'
              : 'other',
        size: s.size,
      };
    } catch {
      return null;
    }
  },
  async readFile(path, maxBytes = 64 * 1024 * 1024) {
    const s = await lstat(path);
    if (s.size > maxBytes) throw new NovaError('validation', `${basename(path)} is too large`);
    return readFile(path);
  },
  async writeFile(path, data, mode = 0o644) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode });
    await chmod(path, mode);
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async remove(path, recursive = false) {
    await rm(path, { recursive, force: true });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async removeWithin(root, rel) {
    const abs = join(root, rel);
    const realRoot = await realpath(root);
    const parent = await realpath(dirname(abs)).catch(() => null);
    if (!parent || !isWithin(realRoot, parent)) return;
    const target = join(parent, basename(abs));
    try {
      const s = await lstat(target);
      if (s.isDirectory()) return;
      await unlink(target);
    } catch {
      // Already gone.
    }
  },
  async writeWithin(root, rel, data, mode = 0o644) {
    const abs = join(root, rel);
    const realRoot = await realpath(root);
    // Create the parents one by one, so none of them is followed out of the root.
    let dir = realRoot;
    for (const part of relDirParts(rel)) {
      const next = join(dir, part);
      const st = await lstat(next).catch(() => null);
      if (!st) await mkdir(next);
      else if (!st.isDirectory() || st.isSymbolicLink()) throw outside(rel);
      dir = await realpath(next);
      if (!isWithin(realRoot, dir)) throw outside(rel);
    }
    const target = join(dir, basename(abs));
    const st = await lstat(target).catch(() => null);
    if (st?.isDirectory()) throw new NovaError('conflict', `${rel} is a folder`);
    if (st) await unlink(target);
    await writeFile(target, data, { mode, flag: 'wx' });
    await chmod(target, mode);
  },
};

function relDirParts(rel: string): string[] {
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw outside(rel);
  return parts.slice(0, -1);
}

function outside(rel: string): NovaError {
  return new NovaError('policy_denied', `${rel} is outside the session folder`, {
    details: { reason: 'outside_folder' },
  });
}

/** The Hub's own files and Git (local and container environments). */
export function localWorkspace(git: HookFreeGit, stateDir: string): CodeWorkspace {
  return {
    label: 'this Hub',
    hubLocal: true,
    git,
    fs: nodeWorkFs,
    stateDir: async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      return stateDir;
    },
  };
}

/** Runs programs on this Hub as a transport (a stand-in for another machine in tests). */
export class LocalTransport implements EnvironmentTransport {
  readonly label: string;
  readonly #state: string;

  constructor(opts: { label?: string; stateDir: string }) {
    this.label = opts.label ?? 'this Hub';
    this.#state = opts.stateDir;
  }

  async stateDir(): Promise<string> {
    await mkdir(this.#state, { recursive: true, mode: 0o700 });
    return this.#state;
  }

  run(req: TransportRunRequest): Promise<TransportRunResult> {
    const max = req.maxBytes ?? 64 * 1024 * 1024;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of req.unset ?? []) delete env[k];
    Object.assign(env, req.env);
    return new Promise((resolve, reject) => {
      const [bin, ...args] = req.argv;
      if (!bin) {
        reject(new NovaError('validation', 'nothing to run'));
        return;
      }
      const child = spawn(bin, args, {
        cwd: req.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(req.signal ? { signal: req.signal } : {}),
      });
      const out: Buffer[] = [];
      let bytes = 0;
      let err = '';
      let over = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), req.timeoutMs ?? 120_000);
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > max) {
          over = true;
          child.kill('SIGKILL');
          return;
        }
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        if (err.length < 64_000) err += b.toString('utf8');
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ENOENT') resolve({ code: 127, stdout: Buffer.alloc(0), stderr: e.message });
        else reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (over) reject(new NovaError('validation', 'the output is too large'));
        else resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(req.input ?? '');
    });
  }
}

// ---- a helper connection as a transport (SSH, WSL, device) -------------------------------------

/** The tag of the transport's own helper processes (left out of the environment's list). */
export const TRANSPORT_TAG = 'nova:transport';

/** Raw bytes a run prints inline (base64 grows them by a third; the helper keeps 1 MiB). */
const INLINE_BYTES = 512 * 1024;
/** Raw bytes per chunk when larger output is fetched afterwards. */
const CHUNK_BYTES = 192 * 1024;
/** Base64 characters per stdin write. */
const STDIN_CHUNK = 256 * 1024;

/**
 * Runs `$@` with its stdin decoded from base64, then prints a header line and (when small
 * enough) stdout and stderr in base64. Larger output stays in the scratch folder for chunked
 * reads. The variables named in NOVA_RUN_UNSET are removed first.
 */
const RUN_SCRIPT = [
  'for v in $NOVA_RUN_UNSET; do unset "$v"; done',
  'd=$(mktemp -d "${TMPDIR:-/tmp}/nova-run.XXXXXX") || { echo "@@NOVA-FAIL mktemp@@"; exit 0; }',
  'if [ "${NOVA_RUN_IN:-0}" = 1 ]; then base64 -d > "$d/i" 2>/dev/null || { rm -rf "$d"; echo "@@NOVA-FAIL stdin@@"; exit 0; }; else : > "$d/i"; fi',
  'inline=${NOVA_RUN_INLINE:-0}',
  'unset NOVA_RUN_UNSET NOVA_RUN_IN NOVA_RUN_INLINE',
  '"$@" < "$d/i" > "$d/o" 2> "$d/e"',
  'c=$?',
  'o=$(wc -c < "$d/o" | tr -d " ")',
  'e=$(wc -c < "$d/e" | tr -d " ")',
  'echo "@@NOVA-RUN $c $o $e $d@@"',
  'if [ $((o + e)) -le "$inline" ]; then base64 < "$d/o"; echo "@@NOVA-ERR@@"; base64 < "$d/e"; echo "@@NOVA-END@@"; rm -rf "$d"; fi',
].join('\n');

const CHUNK_SCRIPT =
  'case "$1" in */nova-run.*) ;; *) exit 3;; esac; dd if="$1" bs=$2 skip=$3 count=1 2>/dev/null | base64';

const STATE_SCRIPT = [
  'd="$HOME/.nova/remote/state"',
  'mkdir -p "$d" || exit 1',
  'chmod 700 "$HOME/.nova" "$HOME/.nova/remote" "$d" 2>/dev/null',
  'cd "$d" && pwd -P',
].join('\n');

/** POSIX single quotes for one shell word. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An EnvironmentTransport over a helper connection. Each run is one helper process; the helper
 * owns it, so a dropped connection is reconnected once and the output is read on from where it
 * stopped (FR-078).
 */
export function helperTransport(
  connect: () => Promise<EnvHelperConnection>,
  label: string,
): EnvironmentTransport {
  let state: Promise<string> | null = null;
  const checked = new WeakSet<EnvHelperConnection>();

  /** Like the exec path: nothing runs through a helper whose integrity was not verified. */
  async function verified(conn: EnvHelperConnection): Promise<EnvHelperConnection> {
    if (checked.has(conn)) return conn;
    if (!(await conn.hello()).verified)
      throw new NovaError(
        'capability_missing',
        `the helper in ${label} failed its integrity check; nothing runs there`,
        { details: { reason: 'helper_unverified' } },
      );
    checked.add(conn);
    return conn;
  }

  async function exec(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    input: string | null,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let conn = await verified(await connect());
    const { id } = await conn.spawn({ cmd, cwd, env, tag: TRANSPORT_TAG });
    const retry = async <T>(fn: (c: EnvHelperConnection) => Promise<T>): Promise<T> => {
      try {
        return await fn(conn);
      } catch (err) {
        if (!conn.closed) throw err;
        conn = await verified(await connect());
        return fn(conn);
      }
    };
    if (input !== null) {
      for (let i = 0; i < input.length; i += STDIN_CHUNK)
        await retry((c) => c.write(id, { text: input.slice(i, i + STDIN_CHUNK) }));
      await retry((c) => c.write(id, { closeStdin: true }));
    }
    const end = Date.now() + timeoutMs;
    let out = '';
    let offset = 0;
    for (;;) {
      if (signal?.aborted || Date.now() > end) {
        await retry((c) => c.write(id, { signal: 'terminate' })).catch(() => undefined);
        throw signal?.aborted
          ? new NovaError('cancelled', 'the command was cancelled')
          : new NovaError('server_error', `the command did not finish in ${label}`);
      }
      const r = await retry((c) => c.read(id, offset, Math.min(1_000, end - Date.now())));
      if (r.dropped)
        throw new NovaError('server_error', `the helper in ${label} dropped output`, {
          details: { reason: 'output_dropped' },
        });
      out += r.data;
      offset = r.offset;
      if (!r.running) return out;
    }
  }

  async function chunks(
    path: string,
    total: number,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    const parts: Buffer[] = [];
    let got = 0;
    for (let i = 0; got < total; i++) {
      const text = await exec(
        ['sh', '-c', CHUNK_SCRIPT, 'nova-chunk', path, String(CHUNK_BYTES), String(i)]
          .map(shellQuote)
          .join(' '),
        cwd,
        {},
        null,
        timeoutMs,
        signal,
      );
      const b = Buffer.from(text, 'base64');
      if (!b.length) break;
      parts.push(b);
      got += b.length;
    }
    return Buffer.concat(parts).subarray(0, total);
  }

  return {
    label,
    stateDir() {
      state ??= (async () => {
        const out = await exec(
          ['sh', '-c', STATE_SCRIPT].map(shellQuote).join(' '),
          '/',
          {},
          null,
          30_000,
          undefined,
        );
        const dir = out.trim().split('\n').at(-1)?.trim() ?? '';
        if (!dir.startsWith('/'))
          throw new NovaError('capability_missing', `Nova has no state folder in ${label}`, {
            details: { reason: 'remote_state_unavailable' },
          });
        return dir;
      })();
      const p = state;
      p.catch(() => {
        if (state === p) state = null;
      });
      return p;
    },
    async run(req) {
      const timeoutMs = req.timeoutMs ?? 120_000;
      const max = req.maxBytes ?? 64 * 1024 * 1024;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.env ?? {}))
        if (ENV_NAME.test(k) && !k.startsWith('NOVA_RUN_')) env[k] = v;
      const unset = (req.unset ?? []).filter((k) => ENV_NAME.test(k) && !(k in env));
      if (unset.length) env.NOVA_RUN_UNSET = unset.join(' ');
      env.NOVA_RUN_INLINE = String(INLINE_BYTES);
      let input: string | null = null;
      if (req.input !== undefined && req.input.length) {
        env.NOVA_RUN_IN = '1';
        input = Buffer.from(req.input).toString('base64');
      }
      const cmd = ['sh', '-c', RUN_SCRIPT, 'nova-run', ...req.argv].map(shellQuote).join(' ');
      const text = await exec(cmd, req.cwd, env, input, timeoutMs, req.signal);
      const fail = /@@NOVA-FAIL (\w+)@@/.exec(text);
      if (fail)
        throw new NovaError('server_error', `the command could not start in ${label} (${fail[1]})`);
      const head = /@@NOVA-RUN (-?\d+) (\d+) (\d+) (\S+)@@\n?/.exec(text);
      if (!head) {
        // A missing working folder (or no shell) ends before the script prints anything.
        return { code: 127, stdout: Buffer.alloc(0), stderr: text.slice(-2000) };
      }
      const code = Number(head[1]);
      const outBytes = Number(head[2]);
      const errBytes = Number(head[3]);
      const dir = head[4]!;
      if (outBytes > max) {
        await exec(`rm -rf ${shellQuote(dir)}`, '/', {}, null, 30_000, undefined).catch(() => '');
        throw new NovaError('validation', 'the output is too large');
      }
      const rest = text.slice(head.index + head[0].length);
      const errAt = rest.indexOf('@@NOVA-ERR@@');
      const endAt = rest.indexOf('@@NOVA-END@@');
      if (errAt >= 0 && endAt > errAt) {
        return {
          code,
          stdout: Buffer.from(rest.slice(0, errAt), 'base64'),
          stderr: Buffer.from(rest.slice(errAt + 12, endAt), 'base64').toString('utf8'),
        };
      }
      try {
        const stdout = await chunks(`${dir}/o`, outBytes, '/', timeoutMs, req.signal);
        const stderr = await chunks(
          `${dir}/e`,
          Math.min(errBytes, 64_000),
          '/',
          timeoutMs,
          req.signal,
        );
        return { code, stdout, stderr: stderr.toString('utf8') };
      } finally {
        await exec(`rm -rf ${shellQuote(dir)}`, '/', {}, null, 30_000, undefined).catch(() => '');
      }
    },
  };
}

// ---- Git and files through a transport ---------------------------------------------------------

/** `GIT_*` variables a remote shell may carry that would redirect Nova's Git calls. */
const GIT_UNSET = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_TRACE',
];

/**
 * Hook-free Git through a transport (FR-211), with HookFreeGit's call shape so the shadow
 * repository and the commit helpers run unchanged. Hooks point at /dev/null (no hook can be
 * found there); prompts, pagers and editors are off; `isolated` ignores the system and global
 * config.
 */
export class TransportGit {
  readonly emptyHooksDir = '/dev/null';
  readonly bin = 'git';
  readonly #t: EnvironmentTransport;

  constructor(transport: EnvironmentTransport) {
    this.#t = transport;
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.run(['--version'], { cwd: '/', allowFail: true });
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
    } catch {
      return null;
    }
  }

  async run(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_ASKPASS: 'true',
      SSH_ASKPASS: 'true',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    };
    if (opts.isolated) {
      env.GIT_CONFIG_NOSYSTEM = '1';
      env.GIT_CONFIG_GLOBAL = '/dev/null';
      env.GIT_ATTR_NOSYSTEM = '1';
    }
    if (opts.gitDir) env.GIT_DIR = opts.gitDir;
    if (opts.workTree) env.GIT_WORK_TREE = opts.workTree;
    if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
    Object.assign(env, opts.env);
    const r = await this.#t.run({
      argv: ['git', ...hookFreeArgs(this.emptyHooksDir), ...args],
      cwd: opts.cwd,
      env,
      unset: [...GIT_UNSET, 'PAGER', 'EDITOR', 'VISUAL'].filter((k) => !(k in env)),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (r.code === 127 && !r.stdout.length && /not found|No such file/i.test(r.stderr))
      throw new NovaError('capability_missing', `Git could not run in ${this.#t.label}`, {
        action: `Install Git in ${this.#t.label}`,
        details: { reason: 'git_missing' },
      });
    if (r.code !== 0 && !opts.allowFail)
      throw new NovaError('server_error', `git ${args[0] ?? ''} failed: ${firstLine(r.stderr)}`, {
        details: { reason: 'git_failed', command: args[0] ?? '', stderr: r.stderr.slice(0, 2000) },
      });
    return r;
  }

  async text(args: readonly string[], opts: GitRunOptions): Promise<string> {
    return (await this.run(args, opts)).stdout.toString('utf8').trim();
  }
}

/** Files through a transport with POSIX tools (`sh`, `cat`, `mkdir`, `rm`, `wc`). */
export function transportWorkFs(t: EnvironmentTransport): WorkFs {
  const sh = async (script: string, args: string[], input?: Buffer | string) => {
    const r = await t.run({
      argv: ['sh', '-c', script, 'nova-fs', ...args],
      cwd: '/',
      ...(input !== undefined ? { input } : {}),
    });
    return r;
  };
  return {
    async stat(path) {
      const r = await sh(
        'if [ -L "$1" ]; then echo "symlink 0"; elif [ -d "$1" ]; then echo "dir 0"; elif [ -f "$1" ]; then echo "file $(wc -c < "$1" | tr -d " ")"; elif [ -e "$1" ]; then echo "other 0"; else echo none; fi',
        [path],
      );
      const [kind, size] = r.stdout.toString('utf8').trim().split(' ');
      if (r.code !== 0 || !kind || kind === 'none') return null;
      return {
        kind: kind as 'file' | 'dir' | 'symlink' | 'other',
        size: Number(size ?? 0) || 0,
      };
    },
    async readFile(path, maxBytes = 64 * 1024 * 1024) {
      const r = await t.run({ argv: ['cat', '--', path], cwd: '/', maxBytes });
      if (r.code !== 0)
        throw new NovaError('not_found', `${basename(path)} could not be read in ${t.label}`);
      return r.stdout;
    },
    async writeFile(path, data, mode = 0o644) {
      const r = await sh(
        'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"',
        [path, (mode & 0o777).toString(8)],
        data,
      );
      if (r.code !== 0)
        throw new NovaError(
          'server_error',
          `${basename(path)} could not be written in ${t.label}`,
          {
            details: { stderr: r.stderr.slice(0, 500) },
          },
        );
    },
    async mkdir(path) {
      const r = await sh('mkdir -p "$1" && chmod 700 "$1"', [path]);
      if (r.code !== 0)
        throw new NovaError('server_error', `a folder could not be made in ${t.label}`);
    },
    async remove(path, recursive = false) {
      await sh(recursive ? 'rm -rf -- "$1"' : 'rm -f -- "$1"', [path]);
    },
    async rename(from, to) {
      const r = await sh('[ ! -e "$2" ] && mv -- "$1" "$2"', [from, to]);
      if (r.code !== 0)
        throw new NovaError('server_error', `${basename(from)} could not be moved in ${t.label}`);
    },
    async removeWithin(root, rel) {
      // The parent folder, resolved, must still be inside the (resolved) root; links are removed,
      // never followed.
      await sh(
        'r=$(cd "$1" 2>/dev/null && pwd -P) || exit 0; p=$(cd "$1" && cd "$(dirname "$2")" 2>/dev/null && pwd -P) || exit 0; case "$p/" in "$r"/*) f="$p/$(basename "$2")"; if [ -L "$f" ] || [ -f "$f" ]; then rm -f -- "$f"; fi;; esac',
        [root, rel],
      );
    },
    async writeWithin(root, rel, data, mode = 0o644) {
      const parts = relDirParts(rel);
      const name = basename(rel);
      if (!name || name === '.' || name === '..') throw outside(rel);
      // Parent by parent, like the Hub's own: a link is never followed, and each folder must
      // resolve inside the root before anything is created under it.
      const r = await sh(
        [
          'r=$(cd "$1" 2>/dev/null && pwd -P) || exit 3',
          'mode=$2; name=$3; shift 3; cur=$r',
          'for part in "$@"; do',
          '  n="$cur/$part"',
          '  [ -L "$n" ] && exit 4',
          '  [ -e "$n" ] || mkdir -- "$n" || exit 3',
          '  [ -d "$n" ] || exit 4',
          '  cur=$(cd "$n" && pwd -P) || exit 3',
          '  case "$cur/" in "$r"/*) ;; *) exit 4;; esac',
          'done',
          'f="$cur/$name"',
          '[ -d "$f" ] && [ ! -L "$f" ] && exit 5',
          'rm -f -- "$f"',
          'cat > "$f" && chmod "$mode" "$f"',
        ].join('\n'),
        [root, (mode & 0o777).toString(8), name, ...parts],
        data,
      );
      if (r.code === 4) throw outside(rel);
      if (r.code !== 0)
        throw new NovaError('server_error', `${basename(rel)} could not be written in ${t.label}`);
    },
  };
}

/** A workspace on another machine, through its transport. */
export function transportWorkspace(t: EnvironmentTransport): CodeWorkspace {
  // TransportGit has HookFreeGit's members, so every Git helper takes it as it is.
  const git: HookFreeGit = new TransportGit(t);
  return {
    label: t.label,
    hubLocal: false,
    git,
    fs: transportWorkFs(t),
    stateDir: () => t.stateDir(),
    transport: t,
  };
}

/** A short random name for scratch files. */
export function scratchName(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? 'unknown error'
  );
}
