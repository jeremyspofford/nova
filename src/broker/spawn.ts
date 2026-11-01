// Starting the broker (for the supervisor; §3 "Start and supervision", "Hardening"). Its command
// follows the runtime agent's (device/boot.ts): Node's permission model with reads narrowed to the
// broker's own code and folder and writes to its folder, no inspector, --disable-sigusr1,
// diagnostics confined to its folder, and an empty environment (no NODE_OPTIONS, no proxy
// variables). Network access stays allowed, because `use` needs it, and so do child processes:
// the broker starts its own launcher (programs, the old vault) and, with a keychain, its CLIs.
// A stated limit: Node's permission model doesn't follow a child, so the file-system narrowing is
// defence in depth against a bug in the broker, not a wall against code that runs as it.
//
// The supervisor makes the two 256-bit tokens and hands each child its own: the broker gets both
// over this IPC channel, and core gets its own the same way from the supervisor.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tokens } from './server.ts';

export const BROKER_SRC = dirname(fileURLToPath(import.meta.url));

export function brokerCommand(dir: string): string[] {
  return [
    '--permission', `--allow-fs-read=${BROKER_SRC}/`, `--allow-fs-read=${dir}/`, `--allow-fs-write=${dir}/`, '--allow-net', '--allow-child-process',
    '--no-experimental-sqlite', '--no-experimental-webstorage', '--disable-sigusr1', `--diagnostic-dir=${dir}`,
    '--disable-warning=ExperimentalWarning', join(BROKER_SRC, 'main.ts'), dir,
  ];
}

export interface Started { child: ChildProcess; socket: string; tokens: Tokens; locked: boolean }

export function startBroker(dir: string, o: { keyMode?: 'auto' | 'file' | 'keychain'; env?: NodeJS.ProcessEnv; timeoutMs?: number; pipe?: boolean } = {}): Promise<Started> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keychain = o.keyMode !== 'file';
  const env = o.env ?? process.env;
  // Only what the keychain CLIs need to reach a desktop session; nothing else of the parent's.
  const childEnv: NodeJS.ProcessEnv = { TZ: env.TZ ?? 'UTC', ...(keychain && env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(keychain && env.PATH ? { PATH: env.PATH } : {}) };
  const tokens: Tokens = { core: randomBytes(32).toString('hex'), supervisor: randomBytes(32).toString('hex') };
  const child = spawn(process.execPath, brokerCommand(dir), { cwd: dir, env: childEnv, stdio: ['ignore', o.pipe ? 'pipe' : 'inherit', o.pipe ? 'pipe' : 'inherit', 'ipc'] });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('The broker didn’t start in time.')); }, o.timeoutMs ?? 20_000);
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`The broker exited at start (code ${code}).`)); });
    child.once('message', (m: { ready?: boolean; socket?: string; problem?: string; locked?: boolean }) => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      if (!m.ready) return fail(new Error(`The broker couldn’t start: ${m.problem}`));
      ok({ child, socket: m.socket!, tokens, locked: !!m.locked });
    });
    child.send({ tokens, ...(o.keyMode ? { key_mode: o.keyMode } : {}) });
  });
}
