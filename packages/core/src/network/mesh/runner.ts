// Running mesh, firewall and package CLIs for the Network Setup assistant (FR-136, docs/22 §6).
// Always an argument list through spawn (never a shell string), with a timeout, a small fixed
// environment and capped output. Secrets reach a CLI only through its environment or stdin,
// resolved from the vault at the last moment; they never appear in argv, logs or the database.
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';

/** A value that is resolved from the vault just before the command runs. */
export interface MeshSecretRef {
  secretRef: string;
}

export interface MeshCommand {
  /** The program by its usual name (`tailscale`, `headscale`, `ufw`, …); see `bins`. */
  bin: string;
  args: string[];
  env?: Record<string, string | MeshSecretRef>;
  stdin?: string | MeshSecretRef;
  timeoutMs?: number;
  /** Never keep stdout (it carries a secret, e.g. a pre-auth key or a private key). */
  secretOutput?: boolean;
}

export interface MeshCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `not_found` when the program is missing, else a spawn error message. */
  error: string | null;
}

/** A command with its secrets resolved; only a runner sees this. */
export interface ResolvedMeshCommand {
  argv: string[];
  env: Record<string, string>;
  stdin: string | null;
  timeoutMs: number;
}

export interface MeshCommandRunner {
  run(cmd: ResolvedMeshCommand): Promise<MeshCommandResult>;
}

export const DEFAULT_MESH_COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 1024 * 1024;
/** After the program exits, how long its output may still arrive before the call settles. */
const EXIT_GRACE_MS = 200;

// What a CLI may see of the Hub's environment: a home folder and a language, never the Hub's own
// credentials (provider keys and the like live in its environment) and never its PATH.
const PASS_ENV = ['HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'TMPDIR', 'SystemRoot'];

/**
 * Where mesh, firewall and package CLIs are looked up: the system folders only, never the
 * inherited PATH (which can hold `node_modules/.bin` or a user's folders ahead of the system).
 */
export function systemSearchPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? 'C:\\Windows';
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const dirs = [
      win32.join(root, 'System32'),
      win32.join(pf, 'Tailscale'),
      win32.join(pf, 'NetBird'),
      win32.join(pf, 'WireGuard'),
    ];
    // winget is an app-execution alias under the user's local app data.
    if (env.LOCALAPPDATA) dirs.push(win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
    return dirs;
  }
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  }
  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
}

/** The absolute path of `program` in the system folders, or null. */
export function resolveProgram(
  program: string,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  if (paths.isAbsolute(program)) return program;
  // A relative path with a separator is never looked up (it would resolve against the cwd).
  if (/[\\/]/.test(program)) return null;
  const names = platform === 'win32' && !/\.\w+$/.test(program) ? [`${program}.exe`] : [program];
  for (const dir of dirs) {
    for (const name of names) {
      const full = paths.join(dir, name);
      try {
        accessSync(full, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface ProcessMeshRunnerOptions {
  /** Argv prefix per program, e.g. `{tailscale: ['/usr/bin/tailscale']}` (tests: a fake CLI). */
  bins?: Record<string, string[]>;
  /** Extra environment for every command (tests: where the fake keeps its state). */
  baseEnv?: Record<string, string>;
  /** Where programs are looked up (default `systemSearchPath()`). */
  searchPath?: string[];
  platform?: NodeJS.Platform;
}

/**
 * The real runner: spawn with an argument list, no shell, the program resolved in the system
 * folders. The program runs in its own process group so a timeout kills everything it started,
 * and the call settles when the program exits (or on the timer), never waiting for a leftover
 * process that still holds its output pipes.
 */
export class ProcessMeshRunner implements MeshCommandRunner {
  readonly #bins: Record<string, string[]>;
  readonly #baseEnv: Record<string, string>;
  readonly #searchPath: string[];
  readonly #platform: NodeJS.Platform;

  constructor(opts: ProcessMeshRunnerOptions = {}) {
    this.#bins = opts.bins ?? {};
    this.#baseEnv = opts.baseEnv ?? {};
    this.#platform = opts.platform ?? process.platform;
    this.#searchPath = opts.searchPath ?? systemSearchPath(this.#platform);
  }

  run(cmd: ResolvedMeshCommand): Promise<MeshCommandResult> {
    const [program, ...rest] = cmd.argv;
    if (!program) return Promise.resolve(failed('empty command'));
    const prefix = this.#bins[program] ?? [program];
    const [name, ...pre] = prefix;
    if (!name) return Promise.resolve(failed('empty command'));
    const file = resolveProgram(name, this.#searchPath, this.#platform);
    if (!file) return Promise.resolve(failed('not_found'));
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    env.PATH = this.#searchPath.join(this.#platform === 'win32' ? ';' : ':');
    Object.assign(env, this.#baseEnv, cmd.env);
    const group = this.#platform !== 'win32';
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const child = spawn(file, [...pre, ...rest], {
        env,
        shell: false,
        windowsHide: true,
        detached: group,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const killAll = () => {
        try {
          if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // already gone
        }
      };
      const done = (r: MeshCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        // Stop reading: a leftover process holding the pipes must not keep the Hub waiting.
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killAll();
        done({ code: null, stdout, stderr, timedOut, error: 'timed out' });
      }, cmd.timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += b.toString('utf8');
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        done({
          code: null,
          stdout,
          stderr,
          timedOut,
          error: err.code === 'ENOENT' ? 'not_found' : err.message,
        });
      });
      // `close` waits for every holder of the pipes; `exit` is the program itself. Settle on
      // whichever comes first after a short grace for the last of the output.
      const finish = (code: number | null) =>
        done({ code, stdout, stderr, timedOut, error: timedOut ? 'timed out' : null });
      child.on('close', (code) => finish(code));
      child.on('exit', (code) => {
        grace = setTimeout(() => finish(code), EXIT_GRACE_MS);
      });
      // A CLI that never reads stdin must not fail the command with EPIPE.
      child.stdin.on('error', () => undefined);
      child.stdin.end(cmd.stdin ?? '');
    });
  }
}

function failed(error: string): MeshCommandResult {
  return { code: null, stdout: '', stderr: '', timedOut: false, error };
}

/** How a command is shown to the owner and stored: its argv, secrets never part of it. */
export function previewCommand(cmd: MeshCommand): string[] {
  const out = [cmd.bin, ...cmd.args];
  if (cmd.stdin !== undefined && typeof cmd.stdin !== 'string') out.push('<secret on stdin>');
  for (const [k, v] of Object.entries(cmd.env ?? {})) {
    if (typeof v !== 'string') out.unshift(`${k}=<secret>`);
  }
  return out;
}

export interface MeshExecRecord {
  argv: string[];
  code: number | null;
  error: string | null;
}

/**
 * Runs `MeshCommand`s for one step: resolves vault refs, keeps a record of what ran (argv only)
 * and redacts output (every value read from the vault is registered with the redactor).
 */
export class MeshExec {
  readonly records: MeshExecRecord[] = [];
  readonly #runner: MeshCommandRunner;
  readonly #secrets: SecretStore;

  constructor(runner: MeshCommandRunner, secrets: SecretStore) {
    this.#runner = runner;
    this.#secrets = secrets;
  }

  async run(cmd: MeshCommand): Promise<MeshCommandResult> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cmd.env ?? {})) {
      env[k] = typeof v === 'string' ? v : await this.#secret(v.secretRef);
    }
    const stdin =
      cmd.stdin === undefined
        ? null
        : typeof cmd.stdin === 'string'
          ? cmd.stdin
          : await this.#secret(cmd.stdin.secretRef);
    const argv = [cmd.bin, ...cmd.args];
    const r = await this.#runner.run({
      argv,
      env,
      stdin,
      timeoutMs: cmd.timeoutMs ?? DEFAULT_MESH_COMMAND_TIMEOUT_MS,
    });
    this.records.push({ argv, code: r.code, error: r.error });
    return {
      ...r,
      stdout: cmd.secretOutput ? r.stdout : defaultRedactor.redactString(r.stdout),
      stderr: defaultRedactor.redactString(r.stderr),
    };
  }

  /** Run and require exit 0; the error names the command and a redacted line of its output. */
  async must(cmd: MeshCommand): Promise<MeshCommandResult> {
    const r = await this.run(cmd);
    if (r.code !== 0) throw new MeshCommandError(cmd, r);
    return r;
  }

  async #secret(ref: string): Promise<string> {
    const v = await this.#secrets.get(ref);
    if (v === null)
      throw new Error(
        `a secret this step needs is missing from the vault (${ref}); typed-in keys are removed once used or rolled back: plan again with a new one`,
      );
    defaultRedactor.addLiteral(v);
    return v;
  }
}

export class MeshCommandError extends Error {
  readonly result: MeshCommandResult;
  constructor(cmd: MeshCommand, r: MeshCommandResult) {
    const why =
      r.error === 'not_found'
        ? `${cmd.bin} is not installed`
        : r.timedOut
          ? 'it timed out'
          : `exit ${r.code ?? '?'}${tail(r.stderr || (cmd.secretOutput ? '' : r.stdout))}`;
    super(`${[cmd.bin, ...cmd.args.slice(0, 2)].join(' ')} failed: ${why}`);
    this.name = 'MeshCommandError';
    this.result = r;
  }
}

function tail(text: string): string {
  const line = text.trim().split('\n').filter(Boolean).at(-1);
  return line ? `: ${defaultRedactor.redactString(line).slice(0, 300)}` : '';
}
