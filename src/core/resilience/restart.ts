// Restarting Nova in place (M7 amendment §1, §2), so a restore or a factory reset never asks the
// person to restart anything. One function, `restartInPlace(why)`:
//
//  - Under the supervisor: it asks the supervisor (`restart` with `staged: true`), which stops the
//    server and starts it again. With a staged marker on disk, that restart doesn't count toward
//    safe mode and isn't held to one a minute.
//  - Without it (`node src/server.js`, as the preview runs): the server attached a `release` hook
//    at start. Shortly after the reply to whoever asked has gone out, the hook stops the listeners
//    and closes the core (the database included), and the process replaces itself with a fresh
//    start of the same program (process.execve: same pid, same terminal, same ports, the same
//    environment with the ports it was given filled in). Where execve doesn't exist, a replacement
//    is started detached and this process exits.
//
// Either way the next start runs `finishStaged` before the database opens, so whatever was staged
// (a restore's swap, a reset's wipe) is applied then, and again after a crash part-way.
//
// Nothing else restarts Nova: it is not a route, and it never runs without something staged by a
// tier-3 action on the hub's own screen (its callers check that).
import { spawn } from 'node:child_process';
import { CoreError } from '../errors.ts';
import type { Log } from '../log.ts';
import type { SupervisorLink } from './link.ts';

export type Release = () => Promise<Record<string, string>>;
export interface RestartResult { how: 'supervisor' | 'in-place'; said: string }

export class Restarter {
  #supervisor: SupervisorLink | null;
  #log: Log;
  #release: Release | null = null;
  #exec: (env: Record<string, string>) => void;
  #pending = false;

  constructor(o: { supervisor: SupervisorLink | null; log: Log; exec?: (env: Record<string, string>) => void }) {
    this.#supervisor = o.supervisor;
    this.#log = o.log;
    this.#exec = o.exec ?? execSelf;
  }

  // The server's part: stop listening and close everything, then say which environment the fresh
  // start needs (the ports it is listening on now, so the new process binds the same ones).
  attach(release: Release): void {
    this.#release = release;
  }

  get available(): boolean {
    return !!this.#supervisor || !!this.#release;
  }

  // Restarts this Nova, soon: the caller's reply goes out first. Throws when nothing can restart it
  // (a core in a test, with no server around it).
  async restartInPlace(why: string): Promise<RestartResult> {
    if (this.#supervisor) {
      const r = await this.#supervisor.request('restart', { staged: true });
      if (!r.ok) throw new CoreError('conflict', `The supervisor didn’t restart Nova: ${r.said}`);
      return { how: 'supervisor', said: r.said };
    }
    const release = this.#release;
    if (!release) throw new CoreError('conflict', 'This Nova can’t restart itself here. Stop it and start it again; what was staged is applied as it starts.');
    if (this.#pending) return { how: 'in-place', said: 'Nova is already restarting.' };
    this.#pending = true;
    this.#log.info('resilience', 'Nova restarts in place.', { why });
    setTimeout(() => {
      void release().then((env) => this.#exec(env), (e) => {
        this.#pending = false;
        this.#log.problem('resilience', 'Nova couldn’t restart itself. Stop it and start it again; what was staged is applied as it starts.', { detail: (e as Error)?.stack ?? String(e) });
      });
    }, 150).unref?.();
    return { how: 'in-place', said: 'Nova restarts in a moment, on the same address.' };
  }
}

// The same program again, in this process: execve where the platform has it, else a detached
// replacement and an exit.
function execSelf(env: Record<string, string>): void {
  const merged = { ...process.env, ...env } as Record<string, string>;
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const p = process as unknown as { execve?: (file: string, args: string[], env: Record<string, string>) => never };
  if (typeof p.execve === 'function') {
    try { p.execve(process.execPath, [process.execPath, ...args], merged); } catch { /* below */ }
  }
  spawn(process.execPath, args, { env: merged, stdio: 'inherit', detached: true }).unref();
  process.exit(0);
}
