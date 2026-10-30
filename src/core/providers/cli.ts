// Running a provider's command line: found on PATH or by path, started without a shell in the
// task's folder, its output read as lines, stopped (with everything it started) when the task is
// cancelled or runs out of time. Nothing here runs a command just to check it is there.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// The words of a command as a person writes it in a setting: spaces separate, quotes group.
export function words(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let any = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

// Where a program is, without running it: a path that is an executable file, or the first match on
// PATH. Null when it isn't on this computer.
export function which(program: string, path = process.env.PATH ?? ''): string | null {
  const ok = (p: string) => {
    try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  };
  if (program.includes('/')) return isAbsolute(program) && ok(program) ? program : null;
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const p = join(dir, program);
    if (ok(p)) return p;
  }
  return null;
}

// What a provider's command is never handed: Nova's own settings and secrets, and the variables
// through which a Claude Code session Nova may itself be running in would leak into the child.
// NODE_TEST_CONTEXT: set when Nova itself runs under `node --test`; a brief's own `node --test`
// would otherwise report to Nova's test runner instead of exiting with its result.
const LEAKY = /^(NOVA_|NODE_TEST_CONTEXT$|CLAUDE\w*(MEMORY|ADDITIONAL_DIRECTORIES|CLAUDE_MD|USER_EMAIL))/;
export function childEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !LEAKY.test(k)) out[k] = v;
  return { ...out, ...extra };
}

export interface Ran { code: number | null; signal: string | null; stderr: string; aborted: boolean; timedOut: boolean; ms: number }

// Starts `argv` in `cwd` in a process group of its own, writes `input` to its stdin, and hands each stdout line to `onLine`.
// Resolves when it exits; never rejects for a failing command (the caller reads `code`).
export function runLines(o: { argv: string[]; cwd: string; input?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; onLine: (line: string) => void; shell?: boolean }): Promise<Ran> {
  const started = performance.now();
  return new Promise((resolveRun, rejectRun) => {
    const [cmd, ...args] = o.shell ? ['/bin/sh', '-c', o.argv.join(' ')] : o.argv;
    const child = spawn(cmd!, args, { cwd: o.cwd, env: o.env ?? childEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } };
    // Once it exits, whatever it left running in its process group goes too: nothing a provider or
    // a test started outlives it. (A process that left the group on purpose, with setsid, escapes
    // this; docs/LEDGER.md.)
    child.on('exit', () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* nothing left */ } });
    const stop = () => { aborted = true; kill(); };
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : null;
    timer?.unref();
    if (o.signal?.aborted) stop();
    o.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { o.onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-8000); });
    child.stdin.on('error', () => { /* it may exit before reading everything */ });
    child.stdin.end(o.input ?? '');
    child.on('error', (e) => { if (timer) clearTimeout(timer); o.signal?.removeEventListener('abort', stop); rejectRun(e); });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      if (buf) o.onLine(buf);
      resolveRun({ code, signal: sig, stderr, aborted, timedOut, ms: performance.now() - started });
    });
  });
}

// The last few lines of some output, for a reason shown to a person.
export const tail = (text: string, lines = 12, chars = 2000) => text.trimEnd().split('\n').slice(-lines).join('\n').slice(-chars);
