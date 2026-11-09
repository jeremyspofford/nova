// Running a provider's command line: found on PATH or by path, started without a shell in the
// task's folder, its output read as lines, stopped (with everything it started) when the task is
// cancelled or runs out of time. Nothing here runs a command just to check it is there.
import { spawn } from 'node:child_process';
import { trackChild } from '../children.ts';
import { inheritedChildEnv } from '../child-env.ts';
import { accessSync, constants, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
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

// The same, without holding the event loop: a PATH lookup is a stat per folder, and a folder on a
// slow mount (WSL's /mnt/c, a network share) costs tens of milliseconds each. For lookups made while
// Nova serves requests (a health check), not just before a run.
export async function whichAsync(program: string, path = process.env.PATH ?? ''): Promise<string | null> {
  const ok = async (p: string) => {
    try { await access(p, constants.X_OK); return (await stat(p)).isFile(); } catch { return false; }
  };
  if (program.includes('/')) return isAbsolute(program) && await ok(program) ? program : null;
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const p = join(dir, program);
    if (await ok(p)) return p;
  }
  return null;
}

// The same, for a check made while Nova serves requests that can't wait for a lookup (a provider's
// health, which the health check asks every enabled provider for): the last answer for this program
// and PATH, undefined before the first, looked up again with whichAsync when it is a minute old. A
// path is one stat and is answered now; an empty name is on no PATH.
const known = new Map<string, { found: string | null; at: number }>();
const looking = new Set<string>();
export function whichKnown(program: string, path = process.env.PATH ?? ''): string | null | undefined {
  if (!program) return null;
  if (program.includes('/')) return which(program, path);
  const key = `${program}\u0000${path}`;
  const last = known.get(key);
  if (!looking.has(key) && (!last || Date.now() - last.at > 60_000)) {
    looking.add(key);
    void whichAsync(program, path).then((found) => {
      if (known.size >= 200) known.clear();
      known.set(key, { found, at: Date.now() });
    }, () => {}).finally(() => { looking.delete(key); });
  }
  return last ? last.found : undefined;
}

// Inheritance is finite and shared with Era 2. Explicit extras are a trusted caller contract,
// not another source of ambient parent data; no provider adapter currently supplies extras.
export function childEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...inheritedChildEnv(env), ...extra };
}

export interface Ran { code: number | null; signal: string | null; stderr: string; aborted: boolean; timedOut: boolean; ms: number }

// Starts `argv` in `cwd` in a process group of its own, writes `input` to its stdin, and hands each stdout line to `onLine`.
// Resolves when it exits; never rejects for a failing command (the caller reads `code`).
export function runLines(o: { argv: string[]; cwd: string; input?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; onLine: (line: string) => void; shell?: boolean }): Promise<Ran> {
  const started = performance.now();
  return new Promise((resolveRun, rejectRun) => {
    const [cmd, ...args] = o.shell ? ['/bin/sh', '-c', o.argv.join(' ')] : o.argv;
    const child = trackChild(spawn(cmd!, args, { cwd: o.cwd, env: o.env ?? childEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }), { group: true });
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
