// The broker's launcher (§3 "The launcher", §10 "Moving from today's vault"). Broker code that runs
// as a separate process, so a program can be given a credential, and the old vault read, without
// the value passing through core or the supervisor. The caller starts it with a ticket on fd 3
// (one line), never on argv or in the environment.
//
//   node src/broker/launch.ts run <socket> <program> [args are the ticket's]
//     Hashes <program> itself, redeems the ticket (the broker checks the path and SHA-256 against
//     the binding, and refuses a ticket redeemed twice), then starts the program with the value in
//     its environment, or in a 0600 file in a 0700 folder named by that variable and removed on
//     exit. It stays the program's parent: it scrubs stdout and stderr of the value (and its
//     encodings) before passing them on, forwards signals, and exits with the program's code.
//   node src/broker/launch.ts migrate <socket> <home>
//     Reads the old vault (vault.ts's file and key) and Era 2's Gmail files itself and streams the
//     items to the broker, which stages them. Nova's own keys are not sent.
//   node src/broker/launch.ts migrate-finish <socket> <home>
//     After the broker's read-back: takes what moved out of the old vault (new key, or no file and
//     no key) and removes Era 2's files. Prints names only.
//
// A stated limit: a program is hashed, then started by path, so a binary swapped between the two
// would run with the credential. Its folder should be one only an administrator writes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWN_KEYS, readGmailFiles, readOldVault, removeFromOldVault, removeGmailFiles } from './oldvault.ts';
import { fileSha256 } from './origin.ts';
import { Scrubber, StreamScrubber } from './scrub.ts';

function readTicket(): Promise<string> {
  return new Promise((ok, fail) => {
    let s = '';
    const r = new Socket({ fd: 3, readable: true, writable: false });
    r.setEncoding('utf8');
    r.on('data', (c: string) => { s += c; if (s.includes('\n')) { r.destroy(); ok(s.split('\n')[0]!.trim()); } });
    r.on('end', () => ok(s.trim()));
    r.on('error', fail);
  });
}

// One request at a time over the broker's socket.
function channel(path: string) {
  const sock = connect(path);
  sock.setEncoding('utf8');
  let buf = '';
  const waiting: ((a: Record<string, unknown>) => void)[] = [];
  sock.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()?.(JSON.parse(line)); }
  });
  let n = 0;
  return {
    ask: (m: string, f: Record<string, unknown>) => new Promise<Record<string, unknown>>((ok, fail) => {
      waiting.push(ok);
      sock.once('error', fail);
      sock.write(`${JSON.stringify({ id: ++n, m, ...f })}\n`);
    }),
    close: () => sock.end(),
  };
}

const fail = (words: string, code = 1): never => { process.stderr.write(`nova broker launcher: ${words}\n`); process.exit(code); };

async function run(socket: string, program: string) {
  const ticket = await readTicket();
  const sha256 = fileSha256(program);
  const ch = channel(socket);
  const a = await ch.ask('redeem', { ticket, path: program, sha256 });
  ch.close();
  if (!a.ok) fail(String(a.words ?? a.refused ?? 'the ticket was refused'), 126);
  const g = a.grant as { path: string; argv: string[]; inject: { how: 'env' | 'file'; env: string }; value: string };
  const scrub = new Scrubber([g.value]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  let dir: string | null = null;
  if (g.inject.how === 'file') {
    dir = mkdtempSync(join(tmpdir(), 'nova-cred-'));
    const file = join(dir, 'credential');
    writeFileSync(file, g.value, { mode: 0o600 });
    env[g.inject.env] = file;
  } else env[g.inject.env] = g.value;
  g.value = '';
  a.grant = null;
  const child = spawn(g.path, g.argv, { env, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
  delete env[g.inject.env];
  const out = new StreamScrubber(scrub);
  const err = new StreamScrubber(scrub);
  child.stdout!.setEncoding('utf8').on('data', (c: string) => process.stdout.write(out.push(c)));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => process.stderr.write(err.push(c)));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => child.kill(s));
  child.on('error', (e) => { if (dir) rmSync(dir, { recursive: true, force: true }); fail(`couldn’t start the program: ${scrub.text(e.message)}`, 127); });
  child.on('close', (code, signal) => {
    process.stdout.write(out.end());
    process.stderr.write(err.end());
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.exitCode = code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1);
  });
}

async function migrate(socket: string, home: string) {
  const ticket = await readTicket();
  const old = readOldVault(home);
  const items = new Map<string, string>([...readGmailFiles(home)]);
  // The vault's copy wins over an Era 2 file (the file is then a leftover), as gmail.js does.
  for (const [k, v] of old?.map ?? []) items.set(k, v);
  const ch = channel(socket);
  let sent = 0;
  for (const [name, value] of items) {
    if (OWN_KEYS.some((r) => r.test(name))) continue;
    const a = await ch.ask('migrate_item', { ticket, name, value });
    if (!a.ok) fail(`the broker refused ${name}: ${String(a.words)}`);
    sent++;
  }
  const done = await ch.ask('migrate_item', { ticket, done: true });
  ch.close();
  if (!done.ok) fail(String(done.words));
  process.stdout.write(`${JSON.stringify({ staged: sent })}\n`);
}

async function finish(socket: string, home: string) {
  const ticket = await readTicket();
  const ch = channel(socket);
  const a = await ch.ask('redeem', { ticket });
  ch.close();
  if (!a.ok) fail(String(a.words ?? 'the ticket was refused'));
  const names = a.migrated as string[];
  const old = readOldVault(home);
  const removed = old ? removeFromOldVault(home, old, names) : [];
  removeGmailFiles(home, names);
  process.stdout.write(`${JSON.stringify({ removed: removed.length, kept: old?.map.size ?? 0 })}\n`);
}

const [mode, socket, arg] = process.argv.slice(2);
if (!socket || !arg) fail('usage: launch.ts run|migrate|migrate-finish <socket> <program|home>', 2);
else if (mode === 'run') run(socket, arg).catch((e) => fail((e as Error).message));
else if (mode === 'migrate') migrate(socket, arg).catch((e) => fail((e as Error).message));
else if (mode === 'migrate-finish') finish(socket, arg).catch((e) => fail((e as Error).message));
else fail('usage: launch.ts run|migrate|migrate-finish <socket> <program|home>', 2);
