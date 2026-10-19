// The SSH transport of Code environments (FR-062, FR-078; docs/10 §2, M7). The Hub reaches the
// host with this machine's OpenSSH client and runs Nova's helper there:
//
// - The key or password comes from the vault for each connection and is written only to a 0600
//   file (a key) or handed to `SSH_ASKPASS` (a password or passphrase) in a 0700 folder under the
//   data folder that is removed when the connection closes. The user's own SSH configuration,
//   agent and known hosts are never used (`-F /dev/null`, `IdentitiesOnly`, no agent forwarding).
// - Host keys are pinned on first use and checked after: with no pinned key the first connection
//   accepts the key the host presents (`StrictHostKeyChecking=accept-new` into a private
//   known_hosts) and reports it so the environment stores it; from then on only that key is
//   accepted (`StrictHostKeyChecking=yes`), and a different one fails with `host_key_mismatch`.
// - The helper is a small POSIX shell program (`SSH_HELPER`) the Hub uploads to
//   `~/.nova/remote/helper.sh` and checks by SHA-256 on the host before every start, replacing
//   it when it differs; an unverified helper never runs. It starts each command detached
//   (nohup, its own process group) with its output in a file, so commands keep running and their
//   output stays buffered while the Hub is away, and a new connection reads on from any offset.
//
// Commands reach the helper only as a session's sandbox (EnvHelperSandbox): every exec tool call
// has passed the policy gate before it gets here. Off by default (`code.ssh.enabled`).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NovaError, type WslDistroView } from '@nova/shared';
import { Logger } from '@nova/telemetry';
import type {
  EnvHelperConnection,
  EnvHelperHello,
  EnvHelperProcess,
  EnvHelperRead,
  EnvHelperSpawn,
  EnvSshTarget,
  EnvSshTransport,
} from './environments.ts';
import { managedDenied } from '../managed/restrictions.ts';
import { shellQuote } from './transport.ts';

/** The helper's version, reported in `hello`. */
export const SSH_HELPER_VERSION = 'sh-1';

/** Nova's helper on SSH hosts (installed under ~/.nova/remote; checked by SHA-256). */
export const SSH_HELPER = `#!/bin/sh
# Nova's SSH helper (docs/10 §2): runs a Code session's commands on this host for the Hub and
# keeps their output while the Hub is away. The Hub installs it and checks its SHA-256 before
# every start.
set -u
P="$HOME/.nova/remote/procs"
mkdir -p "$P" && chmod 700 "$HOME/.nova" "$HOME/.nova/remote" "$P" 2>/dev/null
op="\${1:-}"
[ $# -gt 0 ] && shift
case "$op" in
stat)
  if [ -L "$1" ]; then echo other; elif [ -d "$1" ]; then echo dir; elif [ -f "$1" ]; then echo file; elif [ -e "$1" ]; then echo other; else echo none; fi ;;
spawn)
  # $1 the folder, $2 the tag, $3 the command line shown in listings; stdin: the script.
  find "$P" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec sh -c '[ -f "$1/exit" ] && rm -rf "$1"' nova {} \\; 2>/dev/null
  id="p$(date +%s)$$$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' ')"
  d="$P/$id"
  mkdir "$d" || exit 1
  chmod 700 "$d"
  cat > "$d/cmd"
  printf '%s' "$1" > "$d/cwd"
  printf '%s' "$2" > "$d/tag"
  printf '%s' "$3" > "$d/line"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$d/started"
  : > "$d/out"
  mkfifo "$d/in" || exit 1
  nohup sh -c '
    d=$1
    ( exec 9>"$d/in"; exec sleep 2147483647 ) &
    echo $! > "$d/holder"
    if ! cd "$2" 2>/dev/null; then
      echo "no such folder: $2" >> "$d/out"
      kill "$(cat "$d/holder")" 2>/dev/null
      echo 127 > "$d/exit"
      exit 0
    fi
    if command -v setsid >/dev/null 2>&1; then
      setsid sh "$d/cmd" < "$d/in" >> "$d/out" 2>&1 &
    else
      set -m
      sh "$d/cmd" < "$d/in" >> "$d/out" 2>&1 &
    fi
    echo $! > "$d/pid"
    wait $!
    echo $? > "$d/exit.tmp"
    mv "$d/exit.tmp" "$d/exit"
    kill "$(cat "$d/holder")" 2>/dev/null
  ' nova-run "$d" "$1" > /dev/null 2>&1 < /dev/null &
  echo "$id" ;;
read)
  # $1 the id, $2 the byte offset, $3 the wait in tenths of a second.
  d="$P/$1"
  [ -d "$d" ] || { echo "@@NOVA-NONE@@"; exit 0; }
  n=0
  while [ ! -f "$d/exit" ] && [ "$(wc -c < "$d/out" | tr -d ' ')" -le "$2" ] && [ "$n" -lt "$3" ]; do sleep 0.2; n=$((n + 2)); done
  size=$(wc -c < "$d/out" | tr -d ' ')
  if [ -f "$d/exit" ]; then echo "@@NOVA-READ $size 0 $(cat "$d/exit")@@"; else echo "@@NOVA-READ $size 1 -@@"; fi
  tail -c +$(($2 + 1)) "$d/out" | head -c 262144 ;;
write)
  # $1 the id, $2 text|close|interrupt|terminate; stdin: the text.
  d="$P/$1"
  [ -d "$d" ] || exit 4
  case "$2" in
  text) [ -f "$d/exit" ] && exit 5; cat >> "$d/in" ;;
  close) kill "$(cat "$d/holder" 2>/dev/null)" 2>/dev/null; exit 0 ;;
  interrupt) p=$(cat "$d/pid" 2>/dev/null) && { kill -INT -- "-$p" 2>/dev/null || kill -INT "$p" 2>/dev/null; }; exit 0 ;;
  terminate) p=$(cat "$d/pid" 2>/dev/null) && { kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; }; exit 0 ;;
  esac ;;
list)
  for d in "$P"/*; do
    [ -d "$d" ] || continue
    if [ -f "$d/exit" ]; then r=0; x=$(cat "$d/exit"); else r=1; x=-; fi
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${d##*/}" "$r" "$x" "$(wc -c < "$d/out" | tr -d ' ')" "$(cat "$d/started")" "$(tr '\\t\\n' '  ' < "$d/tag")" "$(tr '\\t\\n' '  ' < "$d/cwd")" "$(head -c 300 "$d/line" | tr '\\t\\n' '  ')"
  done ;;
*)
  echo "nova helper: unknown operation" >&2
  exit 2 ;;
esac
`;

export const SSH_HELPER_SHA256 = createHash('sha256').update(SSH_HELPER).digest('hex');

const HELLO_SCRIPT = [
  'f="$HOME/.nova/remote/helper.sh"',
  'printf "%s\\t%s\\t%s\\n" "$(uname -s)" "$(uname -m)" "$HOME"',
  'if [ -f "$f" ]; then (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null || openssl dgst -sha256 -r "$f" 2>/dev/null) | cut -c1-64; else echo none; fi',
].join('; ');

const INSTALL_SCRIPT =
  'mkdir -p "$HOME/.nova/remote" && chmod 700 "$HOME/.nova" "$HOME/.nova/remote" && cat > "$HOME/.nova/remote/helper.sh.new" && chmod 700 "$HOME/.nova/remote/helper.sh.new" && mv "$HOME/.nova/remote/helper.sh.new" "$HOME/.nova/remote/helper.sh"';

const PLATFORMS: Record<string, string> = { Linux: 'linux', Darwin: 'darwin' };

export interface OpenSshOptions {
  /** Where each connection's key file, known_hosts and control socket live (0700). */
  runDir: string;
  /** The ssh client (default `ssh` on PATH). */
  sshBin?: string;
  /** Whether SSH environments may connect (`code.ssh.enabled`); off when it says no. */
  enabled?: () => Promise<boolean>;
  /** Why managed policy refuses SSH to this host, or null (FR-106, `ManagedRestrictions.sshHost`). */
  managedHost?: (host: string) => Promise<string | null>;
  connectTimeoutSeconds?: number;
  /** Reuse one SSH connection for every call (default true). */
  multiplex?: boolean;
  /** Extra environment for the ssh client (tests point a stand-in client at a fake host). */
  env?: Record<string, string>;
  log?: Logger;
}

/** A host key line as stored (`<type> <base64>`), comments and host names dropped. */
export function normalizeHostKey(line: string): string {
  const parts = line.trim().split(/\s+/);
  const at = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
  if (at < 0 || !parts[at + 1]) return line.trim();
  return `${parts[at]} ${parts[at + 1]}`;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** `novad`-style helper connections to SSH hosts through the system's OpenSSH client. */
export class OpenSshTransport implements EnvSshTransport {
  readonly #o: OpenSshOptions;
  readonly #log: Logger;

  constructor(opts: OpenSshOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.code.ssh', sinks: [] });
    // Connection folders a crashed Hub left behind hold copies of private keys: none is in use
    // yet, so they all go.
    try {
      for (const name of readdirSync(opts.runDir))
        if (name.startsWith('c-'))
          rmSync(join(opts.runDir, name), { recursive: true, force: true });
    } catch {
      // No folder yet.
    }
  }

  async connect(target: EnvSshTarget, signal: AbortSignal): Promise<SshHelperConnection> {
    // Managed policy first: its refusal is the organization's, not a setting the user can change.
    const managed = this.#o.managedHost ? await this.#o.managedHost(target.host) : null;
    if (managed) throw managedDenied(managed, { host: target.host });
    if (this.#o.enabled && !(await this.#o.enabled()))
      throw new NovaError(
        'capability_missing',
        'SSH environments are off on this Hub; turn on code.ssh.enabled',
        { details: { reason: 'ssh_disabled' } },
      );
    // A leading hyphen would reach the ssh client as an option (`-E`, `-G`, `-J`).
    if (/^-/.test(target.host) || /^-/.test(target.user) || !/^[^\s"']+$/.test(target.host))
      throw new NovaError('validation', 'not a valid SSH host or user', {
        details: { reason: 'invalid_target' },
      });
    // Option values are quoted for the client, which also expands `%` tokens in some of them.
    if (/["\n%]/.test(this.#o.runDir))
      throw new NovaError('validation', 'the SSH run folder cannot contain quotes or %');
    if (!target.credential.privateKey && !target.credential.password)
      throw new NovaError('validation', 'the SSH credential is missing', {
        details: { reason: 'credential_missing' },
      });
    await mkdir(this.#o.runDir, { recursive: true, mode: 0o700 });
    const dir = join(this.#o.runDir, `c-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { mode: 0o700 });
    try {
      const conn = new SshHelperConnection(this.#o, target, dir, this.#log);
      await conn.open(signal);
      return conn;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }
}

/** One SSH connection to a host's helper. Processes belong to the helper, not to it (FR-078). */
export class SshHelperConnection implements EnvHelperConnection {
  #closed = false;
  /** The host key the host presented (pinned on first use). */
  hostKey: string | null = null;
  readonly #o: OpenSshOptions;
  readonly #t: EnvSshTarget;
  readonly #dir: string;
  readonly #log: Logger;
  readonly #alias: string;
  #hello: EnvHelperHello | null = null;
  /** The helper's absolute path on the host (the one its SHA-256 was checked at). */
  #helper = '';

  constructor(o: OpenSshOptions, target: EnvSshTarget, dir: string, log: Logger) {
    this.#o = o;
    this.#t = target;
    this.#dir = dir;
    this.#log = log;
    // Keys are stored per environment: the alias keeps the entry independent of host and port.
    this.#alias = `nova-${createHash('sha256').update(`${target.host}:${target.port}`).digest('hex').slice(0, 16)}`;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Write the private files, connect once (pinning or checking the host key), install the helper. */
  async open(signal: AbortSignal): Promise<void> {
    const c = this.#t.credential;
    if (c.privateKey) {
      const key = c.privateKey.endsWith('\n') ? c.privateKey : `${c.privateKey}\n`;
      await writeFile(join(this.#dir, 'id'), key, { mode: 0o600 });
    }
    await writeFile(
      join(this.#dir, 'askpass'),
      '#!/bin/sh\nprintf \'%s\\n\' "$NOVA_SSH_SECRET"\n',
      {
        mode: 0o700,
      },
    );
    await chmod(join(this.#dir, 'askpass'), 0o700);
    await writeFile(
      join(this.#dir, 'known_hosts'),
      this.#t.hostKey ? `${this.#alias} ${normalizeHostKey(this.#t.hostKey)}\n` : '',
      { mode: 0o600 },
    );
    const r = await this.#ssh(['sh', '-c', shellQuote(HELLO_SCRIPT)], {
      signal,
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw this.#failure(r);
    const [line, hash] = r.stdout.toString('utf8').trim().split('\n');
    const [sys, arch, home] = (line ?? '').split('\t');
    this.hostKey = this.#t.hostKey ? normalizeHostKey(this.#t.hostKey) : await this.#seenKey();
    let verified = hash?.trim() === SSH_HELPER_SHA256;
    if (!verified) {
      const up = await this.#ssh(['sh', '-c', shellQuote(INSTALL_SCRIPT)], {
        input: SSH_HELPER,
        signal,
      });
      if (up.code !== 0)
        throw new NovaError(
          'server_error',
          `the helper could not be installed: ${firstLine(up.stderr)}`,
        );
      const again = await this.#ssh(['sh', '-c', shellQuote(HELLO_SCRIPT)], { signal });
      verified = again.stdout.toString('utf8').trim().split('\n')[1]?.trim() === SSH_HELPER_SHA256;
    }
    const homeDir = home?.trim() ?? '';
    // Every operation runs the helper by the absolute path its SHA-256 was checked at.
    if (!homeDir.startsWith('/')) verified = false;
    this.#helper = `${homeDir}/.nova/remote/helper.sh`;
    this.#hello = {
      version: SSH_HELPER_VERSION,
      platform: PLATFORMS[sys ?? ''] ?? (sys ?? 'unknown').toLowerCase(),
      arch: arch?.trim() || null,
      verified,
      home: homeDir || null,
    };
  }

  hello(): Promise<EnvHelperHello> {
    this.#live();
    return Promise.resolve({ ...this.#hello! });
  }

  async stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other' } | null> {
    const out = (await this.#op(['stat', path])).stdout.toString('utf8').trim();
    if (out === 'dir' || out === 'file' || out === 'other') return { kind: out };
    return null;
  }

  async spawn(spec: EnvHelperSpawn): Promise<{ id: string }> {
    const exports = Object.entries(spec.env ?? {})
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`);
    const script = [...exports, `exec sh -c ${shellQuote(spec.cmd)}`, ''].join('\n');
    const r = await this.#op(['spawn', spec.cwd, spec.tag ?? '', spec.cmd.slice(0, 300)], script);
    const id = r.stdout.toString('utf8').trim().split('\n').at(-1) ?? '';
    if (!/^p\d+$/.test(id))
      throw new NovaError('server_error', 'the helper did not start the command', {
        details: { stderr: r.stderr.slice(0, 500) },
      });
    return { id };
  }

  async read(id: string, offset: number, waitMs: number): Promise<EnvHelperRead> {
    const r = await this.#op(['read', id, String(offset), String(Math.round(waitMs / 100))]);
    const nl = r.stdout.indexOf(10);
    const head = r.stdout.subarray(0, nl < 0 ? r.stdout.length : nl).toString('utf8');
    if (head.includes('@@NOVA-NONE@@')) throw new NovaError('not_found', 'no such process');
    const m = /@@NOVA-READ (\d+) ([01]) (-|-?\d+)@@/.exec(head);
    if (!m) throw new NovaError('server_error', 'the helper answered in an unknown form');
    const size = Number(m[1]);
    const data = nl < 0 ? Buffer.alloc(0) : r.stdout.subarray(nl + 1);
    const next = offset + data.length;
    // Finished only once everything it wrote was read.
    const running = m[2] === '1' || next < size;
    return {
      data: data.toString('utf8'),
      offset: next,
      dropped: 0,
      running,
      exitCode: running || m[3] === '-' ? null : Number(m[3]),
    };
  }

  async write(
    id: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    if (input.text !== undefined && input.text.length) {
      const r = await this.#op(['write', id, 'text'], input.text);
      if (r.code === 5) throw new NovaError('conflict', 'the process has ended');
    }
    if (input.closeStdin) await this.#op(['write', id, 'close']);
    if (input.signal) await this.#op(['write', id, input.signal]);
  }

  async processes(): Promise<EnvHelperProcess[]> {
    const out = (await this.#op(['list'])).stdout.toString('utf8');
    return out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const [id, running, exit, bytes, startedAt, tag, cwd, line] = l.split('\t');
        return {
          id: id ?? '',
          cmd: line ?? '',
          cwd: cwd ?? '',
          tag: tag || null,
          running: running === '1',
          exitCode: running === '1' || !exit || exit === '-' ? null : Number(exit),
          outputBytes: Number(bytes ?? 0) || 0,
          startedAt: startedAt ?? '',
        };
      });
  }

  wslDistros(): Promise<WslDistroView[]> {
    return Promise.reject(
      new NovaError('capability_missing', 'WSL is available only on Windows devices', {
        details: { reason: 'not_windows' },
      }),
    );
  }

  wsl(): Promise<EnvHelperConnection> {
    return this.wslDistros() as never;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#o.multiplex !== false)
      await this.#ssh(['-O', 'exit'], { control: true, timeoutMs: 10_000 }).catch(() => undefined);
    await rm(this.#dir, { recursive: true, force: true });
  }

  // ---- internals -----------------------------------------------------------------------------

  #live(): void {
    if (this.#closed) throw new Error('the SSH connection was closed');
  }

  /** One helper operation; a connection failure marks the connection closed (reconnect). */
  async #op(args: string[], input?: string): Promise<RunResult> {
    this.#live();
    if (!this.#hello?.verified)
      throw new NovaError(
        'capability_missing',
        "the helper's integrity is not verified; nothing runs",
        {
          details: { reason: 'helper_unverified' },
        },
      );
    const r = await this.#ssh(['sh', shellQuote(this.#helper), ...args.map(shellQuote)], {
      ...(input !== undefined ? { input } : {}),
    });
    if (r.code === 255) {
      this.#closed = true;
      throw this.#failure(r);
    }
    return r;
  }

  /** The key the host presented on the first connection (accept-new wrote it). */
  async #seenKey(): Promise<string | null> {
    try {
      const text = await readFile(join(this.#dir, 'known_hosts'), 'utf8');
      const line = text.split('\n').find((l) => l.startsWith(`${this.#alias} `));
      return line ? normalizeHostKey(line.slice(this.#alias.length + 1)) : null;
    } catch {
      return null;
    }
  }

  #args(control = false): string[] {
    const c = this.#t.credential;
    const args = [
      '-F',
      '/dev/null',
      '-o',
      `UserKnownHostsFile=${optionValue(join(this.#dir, 'known_hosts'))}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `HostKeyAlias=${this.#alias}`,
      '-o',
      `StrictHostKeyChecking=${this.#t.hostKey ? 'yes' : 'accept-new'}`,
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'CheckHostIP=no',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      `ConnectTimeout=${this.#o.connectTimeoutSeconds ?? 15}`,
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'NumberOfPasswordPrompts=1',
    ];
    if (c.privateKey)
      args.push(
        '-o',
        `IdentityFile=${optionValue(join(this.#dir, 'id'))}`,
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'KbdInteractiveAuthentication=no',
      );
    else
      args.push(
        '-o',
        'PreferredAuthentications=password,keyboard-interactive',
        '-o',
        'PubkeyAuthentication=no',
      );
    if (this.#o.multiplex !== false || control)
      args.push(
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath=${optionValue(join(this.#dir, 'cm'))}`,
        '-o',
        'ControlPersist=120',
      );
    args.push('-p', String(this.#t.port), '-l', this.#t.user);
    return args;
  }

  #ssh(
    remote: string[],
    o: { input?: string; signal?: AbortSignal; timeoutMs?: number; control?: boolean } = {},
  ): Promise<RunResult> {
    const c = this.#t.credential;
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.#o.env };
    delete env.SSH_AUTH_SOCK;
    env.SSH_ASKPASS = join(this.#dir, 'askpass');
    env.SSH_ASKPASS_REQUIRE = 'force';
    // Only for this one child: the passphrase of the key, or the password.
    env.NOVA_SSH_SECRET = c.privateKey ? (c.passphrase ?? '') : (c.password ?? '');
    const args = o.control
      ? [...this.#args(true), ...remote, '--', this.#t.host]
      : [...this.#args(), '--', this.#t.host, ...remote];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#o.sshBin ?? 'ssh', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const out: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 120_000);
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => {
        if (err.length < 64_000) err += b.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(
          new NovaError('capability_missing', `the ssh client could not run: ${e.message}`, {
            action: 'Install the OpenSSH client on the Hub',
            details: { reason: 'no_ssh_client' },
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 255, stdout: Buffer.concat(out), stderr: err });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.input ?? '');
    });
  }

  #failure(r: RunResult): NovaError {
    const text = r.stderr;
    this.#log.debug('ssh failed', { code: r.code, stderr: text.slice(0, 300) });
    if (
      /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(
        text,
      )
    )
      return new NovaError(
        'policy_denied',
        `the host key of ${this.#t.host} does not match the pinned key; nothing was sent`,
        { details: { reason: 'host_key_mismatch' } },
      );
    if (/permission denied|authentication failed|too many authentication failures/i.test(text))
      return new NovaError(
        'validation',
        `${this.#t.user}@${this.#t.host} refused the sign-in: ${firstLine(text)}`,
        {
          details: { reason: 'ssh_auth_failed' },
        },
      );
    return new NovaError(
      'capability_missing',
      `${this.#t.host} cannot be reached over SSH: ${firstLine(text) || `exit ${r.code}`}`,
      { details: { reason: 'ssh_unreachable' } },
    );
  }
}

/** An `-o` value quoted for the ssh client (paths with spaces; quotes are refused earlier). */
function optionValue(v: string): string {
  return `"${v}"`;
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 300) ?? ''
  );
}
