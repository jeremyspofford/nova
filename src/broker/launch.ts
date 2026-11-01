// The broker's launcher (§3 "The launcher", §10 "Moving from today's vault"). Broker code that the
// broker itself starts as its own child, outside Node's permission model, for the two jobs the
// broker's narrowed process can't do: run a program with a credential, and read the old vault in
// the home. It talks to the broker over its pipes only: never the socket, never a ticket. Core
// never starts it and never holds anything that would let another process act as it.
//
//   launch.ts run              fd 3: { path, sha256, argv, cwd, env, inject, tmp, value, stdin }
//     Hashes the program itself and refuses one that isn't the bound binary, then starts it with
//     the value in its environment, or in a 0600 file in a 0700 folder named by that variable and
//     removed on exit. It scrubs stdout and stderr of the value (and its encodings), passes on
//     signals, and exits with the program's code.
//   launch.ts migrate <home>   stdout: { vault_id, revision }, then { name, value } per credential
//     Reads vault.ts's file and key and Era 2's Gmail files. Nova's own keys aren't sent.
//   launch.ts finish <home>    fd 3: { vault_id, revision, names }
//     Takes the names that moved out of the old vault (a new key, or no file and no key) and removes
//     Era 2's files for them; prints counts only.
//
// Stated limits: a program is hashed, then started by path, so a binary swapped between the two
// would run with the credential; and a program can do what it likes with its own credential,
// including what its arguments, working folder and project files (core's) steer it to.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWN_KEYS, removeFromOldVault, removeGmailFiles, withOldVaultLock, migrationSnapshot } from './oldvault.ts';
import { fileSha256 } from './origin.ts';
import { Scrubber, StreamScrubber } from './scrub.ts';

function fromParent(): Promise<Record<string, any>> {
  return new Promise((ok, fail) => {
    let s = '';
    const r = new Socket({ fd: 3, readable: true, writable: false });
    r.setEncoding('utf8');
    r.on('data', (c: string) => { s += c; });
    r.on('end', () => { try { ok(JSON.parse(s)); } catch { fail(new Error('not a request from the broker')); } });
    r.on('error', fail);
  });
}
const fail = (words: string, code = 1): never => { process.stderr.write(`nova broker launcher: ${words}\n`); process.exit(code); };
const line = (x: unknown) => process.stdout.write(`${JSON.stringify(x)}\n`);

async function run() {
  const g = await fromParent();
  let sha = '';
  try { sha = fileSha256(g.path); } catch { fail('the bound program isn’t there', 126); }
  if (sha !== g.sha256) fail('the program isn’t the one this credential is bound to (its SHA-256 differs)', 126);
  const scrub = new Scrubber([String(g.value)]);
  const home = mkdtempSync(join(typeof g.tmp === 'string' ? g.tmp : tmpdir(), 'nova-run-'));
  const env: NodeJS.ProcessEnv = { ...g.env, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home };
  if (g.inject.how === 'file') {
    const file = join(home, 'credential');
    writeFileSync(file, String(g.value), { mode: 0o600 });
    env[g.inject.env] = file;
  } else env[g.inject.env] = String(g.value);
  g.value = '';
  // Node writes the broker's permission flags into every child's NODE_OPTIONS, whatever env it is
  // given; env(1) takes them out, so the program runs as itself and sees nothing of the broker's.
  const viaEnv = process.platform !== 'win32';
  const child = spawn(viaEnv ? '/usr/bin/env' : g.path, viaEnv ? ['-u', 'NODE_OPTIONS', '--', g.path, ...g.argv] : g.argv, { env, cwd: g.cwd ?? home, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  delete env[g.inject.env];
  child.stdin!.on('error', () => { /* the program didn't read it */ });
  child.stdin!.end(typeof g.stdin === 'string' ? g.stdin : '');
  const out = new StreamScrubber(scrub);
  const err = new StreamScrubber(scrub);
  child.stdout!.setEncoding('utf8').on('data', (c: string) => process.stdout.write(out.push(c)));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => process.stderr.write(err.push(c)));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => child.kill(s));
  child.on('error', () => { rmSync(home, { recursive: true, force: true }); fail('couldn’t start the program', 127); });
  child.on('close', (code, signal) => {
    process.stdout.write(out.end());
    process.stderr.write(err.end());
    rmSync(home, { recursive: true, force: true });
    process.exitCode = code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1);
  });
}

function migrate(home: string) {
  return withOldVaultLock(home, () => {
    const { old, gmail, revision } = migrationSnapshot(home);
    const items = new Map<string, string>(gmail);
    for (const [k, v] of old?.map ?? []) items.set(k, v);
    line({ vault_id: old?.id ?? null, revision });
    for (const [name, value] of items) if (!OWN_KEYS.some((r) => r.test(name))) line({ name, value });
    old?.key.fill(0);
  });
}

async function finish(home: string) {
  const f = await fromParent();
  withOldVaultLock(home, () => {
    const names = Array.isArray(f.names) ? (f.names as unknown[]).filter((n): n is string => typeof n === 'string') : [];
    const { old, revision } = migrationSnapshot(home);
    try {
      // A newer value was never read back. Keep all entries on any staged revision mismatch.
      if (revision !== f.revision || (old && old.id !== f.vault_id)) { line({ removed: 0 }); return; }
      const removed = old ? removeFromOldVault(home, old, names) : [];
      removeGmailFiles(home, names);
      line({ removed: removed.length, kept: old?.map.size ?? 0 });
    } finally { old?.key.fill(0); }
  });
}

const [mode, home] = process.argv.slice(2);
const go = mode === 'run' ? run() : mode === 'migrate' && home ? Promise.resolve(migrate(home)) : mode === 'finish' && home ? finish(home) : Promise.reject(new Error('usage: launch.ts run | migrate <home> | finish <home>'));
go.catch((e) => fail(e instanceof SyntaxError ? 'a file couldn’t be read' : (e as Error).message));
