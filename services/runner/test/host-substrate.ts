// A test double of a sandbox substrate: runs programs directly on this machine, with the sandbox's
// mount targets (/workspace, /cache/<name>, /nova) rewritten to their host folders in the working
// folder, the arguments and the environment's values. It isolates nothing; tests use it where bubblewrap is missing, so the
// runner's HTTP surface and the Hub's client are still exercised end to end.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { SandboxProcess, SandboxSpec, Substrate } from '../src/index.ts';

export class HostSubstrate implements Substrate {
  readonly kind = 'container' as const;
  readonly meter = 'stderr' as const;
  readonly processRlimit = false;
  readonly supportsImage = false;

  available(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: 'host (test double, no isolation)' });
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    // One pass, whole path components only, so a host path is never rewritten again.
    const hosts = new Map(spec.mounts.map((m) => [m.target, m.host]));
    const targets = [...hosts.keys()].sort((a, b) => b.length - a.length);
    const re = new RegExp(
      `(?<![\\w.-])(${targets.map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?![\\w.-])`,
      'g',
    );
    const map = (s: string) => s.replace(re, (t) => hosts.get(t) ?? t);
    const [bin, ...args] = spec.argv;
    const child = spawn(bin!, args.map(map), {
      cwd: spec.cwd === '/' ? '/' : map(spec.cwd),
      // Paths in variables too (the Hub's Git sets GIT_DIR and GIT_WORK_TREE to sandbox paths).
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: tmpdir(),
        LANG: 'C.UTF-8',
        ...Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, map(v)])),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    for (const st of child.stdio) st?.on('error', () => undefined);
    const signal = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // gone
      }
    };
    return {
      child,
      treePid: null,
      meter: null,
      kill: () => {
        signal('SIGKILL');
        return Promise.resolve();
      },
      interrupt: () => {
        signal('SIGINT');
        return Promise.resolve();
      },
    };
  }
}
