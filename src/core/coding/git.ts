// Nova's own git (M10c, docs/plans/M10c.md "Nova's git"). Git runs what a repository's config and
// hooks say (a hook on commit, an fsmonitor on a plain status, a helper for a URL), so every call
// Nova makes turns those off, reads no system or personal config, and may reach only local paths:
// nothing is fetched from, or sent to, a network. Arguments are argv, never a shell string.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { CoreError } from '../errors.ts';
import { trackChild } from '../children.ts';

// Overrides on every call. Command-line config outranks the repository's own.
export const SAFE_CONFIG: readonly string[] = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  // Local paths only: `file` covers a path as well as a file:// URL; ssh, git, http(s) and ext are off.
  'protocol.allow=never',
  'protocol.file.allow=always',
  'credential.helper=',
  'core.sshCommand=false',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.pager=cat',
  'color.ui=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'advice.detachedHead=false',
  'init.defaultBranch=main',
  'user.name=Nova',
  'user.email=nova@localhost',
].flatMap((kv) => ['-c', kv]));

export interface GitRun { code: number; out: string; buf: Buffer; err: string }
export interface GitOptions { cwd?: string; input?: string | Buffer; allow?: number[]; maxBytes?: number; timeoutMs?: number }

// What git is handed: a PATH, a home of Nova's own (no ~/.gitconfig of the person's), the C locale
// (so its words are always the same), and nothing else of Nova's environment, no GIT_* variable
// above all (GIT_DIR would point it at another repository).
export function gitEnv(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // A read never takes the index lock or refreshes the index: reading the person's repository
    // writes nothing there.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
  };
}

const words = (err: string) => err.trim().split('\n').filter(Boolean).slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 400) || 'no reason given';

export class Git {
  readonly home: string;
  #timeoutMs: number;

  constructor(o: { home: string; timeoutMs?: number }) {
    this.home = o.home;
    this.#timeoutMs = o.timeoutMs ?? 120_000;
  }

  #prep(args: string[], o: GitOptions) {
    mkdirSync(this.home, { recursive: true });
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new CoreError('validation', 'A git argument must be plain text.');
    return { argv: [...SAFE_CONFIG, ...args], opts: { cwd: o.cwd ?? this.home, env: gitEnv(this.home), maxBuffer: o.maxBytes ?? 64 * 1024 * 1024, timeout: o.timeoutMs ?? this.#timeoutMs, encoding: 'buffer' as const, windowsHide: true } };
  }

  // Runs git; a non-zero exit not in `allow` throws with git's own last words.
  run(args: string[], o: GitOptions = {}): Promise<GitRun> {
    const { argv, opts } = this.#prep(args, o);
    return new Promise((resolve, reject) => {
      const child = execFile('git', argv, opts, (e, stdout, stderr) => {
        const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0;
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        if (code !== 0 && !(o.allow ?? []).includes(code)) {
          reject(new CoreError('conflict', `git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${words(err || (e as Error)?.message || '')}`));
          return;
        }
        resolve({ code, out: buf.toString('utf8'), buf, err });
      });
      trackChild(child);
      if (o.input !== undefined) child.stdin?.end(o.input);
      else child.stdin?.end();
    });
  }

  // The same, waiting: for a checker, which answers at once.
  runSync(args: string[], o: GitOptions = {}): GitRun {
    const { argv, opts } = this.#prep(args, o);
    try {
      const buf = execFileSync('git', argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], ...(o.input !== undefined ? { input: o.input } : {}) });
      return { code: 0, out: buf.toString('utf8'), buf, err: '' };
    } catch (e) {
      const x = e as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
      const code = typeof x.status === 'number' ? x.status : -1;
      const err = x.stderr?.toString('utf8') ?? '';
      if (!(o.allow ?? []).includes(code)) throw new CoreError('conflict', `git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${words(err || x.message || '')}`);
      return { code, out: x.stdout?.toString('utf8') ?? '', buf: x.stdout ?? Buffer.alloc(0), err };
    }
  }
}

// A commit or object id as git prints it.
export const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A branch name Nova accepts from a person: git's own rules, a little narrower (no leading dash, no
// "..", no control characters, no @{, nothing git would read as an option or a range).
export function checkBranch(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new CoreError('validation', 'branch is the name of a branch, like main.');
  const b = name.trim();
  if (b.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock') || b.includes('..') || b.includes('//') || b.includes('@{') || b.split('/').some((p) => p.startsWith('.'))) {
    throw new CoreError('validation', `“${b.slice(0, 80)}” isn’t a branch name Nova takes: letters, digits, dots, dashes, underscores and slashes.`);
  }
  return b;
}
