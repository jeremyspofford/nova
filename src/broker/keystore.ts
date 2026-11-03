// Where the broker's device unlock key lives (§10 "Unlock"): the OS key store when one answers,
// else a 0600 file in the broker's folder, with the plain notice. The CLIs are vault.ts's, ported
// (src/broker imports nothing from src/core): secret-tool on Linux, security on macOS, the
// Credential Locker through PowerShell on Windows (untested on real Windows). Values never go on a
// command line. The migrate launcher also reads the old vault's key through these (service
// nova-vault, account vault-<id>).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Trusted internal OS context only; never use this for a credentialed target's environment.
export function internalEnv(env: NodeJS.ProcessEnv, keychain = true): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TZ: 'UTC' };
  if (keychain) for (const name of ['HOME', 'PATH', 'DBUS_SESSION_BUS_ADDRESS', ...(process.platform === 'win32' ? ['SystemRoot', 'USERPROFILE', 'LOCALAPPDATA'] : [])]) {
    if (env[name]) out[name] = env[name];
  }
  return out;
}

export interface CommandResult { code: number | null; stdout: string; stderr: string; error: string | null }
export type Run = (cmd: string, args: string[], input?: string) => CommandResult;
export const runCommand: Run = (cmd, args, input) => {
  // env(1) also removes permission flags Node automatically adds to its children.
  const posix = process.platform !== 'win32';
  const r = spawnSync(posix ? '/usr/bin/env' : cmd, posix ? ['-u', 'NODE_OPTIONS', '--', cmd, ...args] : args, { env: internalEnv(process.env), input: input ?? '', encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? r.error.message : null };
};

export interface KeyStore {
  kind: 'keychain' | 'file';
  name: string;
  available(): { ok: boolean; detail: string };
  read(): Buffer | null;
  write(key: Buffer): void;
  remove(): void;
}

export const FILE_NOTICE = 'There is no system keychain the vault can use on this computer, so its device key is in a file in the broker’s folder (broker/device.key). Anyone who can read that folder as you can open the vault. Choose “ask me after a restart” to keep no key on disk.';

const decode = (t: string) => { const k = Buffer.from(t.trim(), 'base64'); return k.length === 32 ? k : null; };
const fail = (cli: string, r: CommandResult) => new Error(`The system keychain didn’t answer (${cli}: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)}).`);
const ACCOUNT = /^[a-z0-9-]{1,80}$/;

export function fileKeyStore(path: string): KeyStore {
  return {
    kind: 'file',
    name: `a key file (${path})`,
    available: () => ({ ok: true, detail: path }),
    read: () => {
      if (!existsSync(path)) return null;
      const k = readFileSync(path);
      if (k.length !== 32) throw new Error(`The key file ${path} is damaged.`);
      return k;
    },
    write: (key) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, key, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      chmodSync(path, 0o600);
    },
    remove: () => rmSync(path, { force: true }),
  };
}

export function keychainStore(service: string, account: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Run } = {}): KeyStore | null {
  if (!ACCOUNT.test(account) || !ACCOUNT.test(service)) throw new Error('not a keychain account the broker uses');
  const run = o.run ?? runCommand;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    return {
      kind: 'keychain', name: 'the macOS keychain',
      available: () => { const r = run('security', ['default-keychain']); return { ok: r.code === 0, detail: r.code === 0 ? 'security' : (r.error ?? r.stderr.trim()) }; },
      read: () => { const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']); if (r.code === 0) return decode(r.stdout); if (r.code === 44) return null; throw fail('security', r); },
      write: (k) => { const r = run('security', ['-i'], `add-generic-password -U -s ${service} -a ${account} -l "Nova broker key" -w ${k.toString('base64')}\n`); if (r.code !== 0 || r.stderr.trim()) throw fail('security', r); },
      remove: () => { const r = run('security', ['delete-generic-password', '-s', service, '-a', account]); if (r.code !== 0 && r.code !== 44) throw fail('security', r); },
    };
  }
  if (platform === 'win32') {
    const v = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;`;
    const find = `try { $c = $v.Retrieve('${service}', '${account}') } catch { exit 44 };`;
    const ps = (s: string, input?: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${v} ${s} }`], input);
    return {
      kind: 'keychain', name: 'Windows Credential Manager',
      available: () => { const r = ps('exit 0'); return { ok: r.code === 0, detail: r.code === 0 ? 'PasswordVault' : (r.error ?? r.stderr.trim()) }; },
      read: () => { const r = ps(`${find} $c.RetrievePassword(); [Console]::Out.Write($c.Password)`); if (r.code === 0) return decode(r.stdout); if (r.code === 44) return null; throw fail('PowerShell', r); },
      write: (k) => { const r = ps(`$p = [Console]::In.ReadToEnd().Trim(); $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${service}', '${account}', $p)))`, k.toString('base64')); if (r.code !== 0) throw fail('PowerShell', r); },
      remove: () => { const r = ps(`try { foreach ($c in $v.RetrieveAll()) { if ($c.Resource -ceq '${service}' -and $c.UserName -ceq '${account}') { $v.Remove($c) } } } catch { exit 1 }`); if (r.code !== 0) throw fail('PowerShell', r); },
    };
  }
  if (platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd') return null;
  const attrs = ['service', service, 'account', account];
  return {
    kind: 'keychain', name: 'the system keychain (secret-tool)',
    available: () => {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return { ok: false, detail: 'no desktop session to reach the keychain through' };
      const r = run('secret-tool', ['lookup', 'service', service, 'account', 'nova-probe']);
      return (r.code === 0 || (r.code === 1 && !r.stderr.trim())) ? { ok: true, detail: 'secret-tool' } : { ok: false, detail: r.error ?? r.stderr.trim() };
    },
    read: () => { const r = run('secret-tool', ['lookup', ...attrs]); if (r.code === 0) return decode(r.stdout); if (r.code === 1 && !r.stderr.trim()) return null; throw fail('secret-tool', r); },
    write: (k) => { const r = run('secret-tool', ['store', `--label=Nova broker key (${account})`, ...attrs], k.toString('base64')); if (r.code !== 0) throw fail('secret-tool', r); },
    remove: () => { const r = run('secret-tool', ['clear', ...attrs]); if (r.code !== 0 && !(r.code === 1 && !r.stderr.trim())) throw fail('secret-tool', r); },
  };
}

// File stores for the broker's two device keys, by account: device-<id> (X25519, the unlock key)
// and sign-<id> (Ed25519, which signs the outbox).
export const fileStores = (dir: string) => (account: string) => fileKeyStore(`${dir}/${account.startsWith('sign-') ? 'sign' : 'device'}.key`);

// The keychain when it answers, else the file. Under the test runner, always the file: tests never
// touch a real keychain (the hard limits).
export function chooseStore(service: string, account: string, file: string, o: { mode?: 'auto' | 'file' | 'keychain'; env?: NodeJS.ProcessEnv; run?: Run; platform?: NodeJS.Platform } = {}): KeyStore {
  const env = o.env ?? process.env;
  const mode = o.mode ?? (env.NODE_TEST_CONTEXT ? 'file' : 'auto');
  if (mode === 'file') return fileKeyStore(file);
  const kc = keychainStore(service, account, o);
  const up = kc?.available();
  if (kc && up?.ok) return kc;
  if (mode === 'keychain') throw new Error(`The broker is set to keep its key in the system keychain, but none answers${up ? `: ${up.detail}` : ''}.`);
  return fileKeyStore(file);
}

// Trusted parent-only reset: fixed broker directory, no key reads and no caller-supplied accounts.
// Keep device.json until the authenticated home reset completes, so interruption is retryable.
export function removeDeviceKeys(dir: string, store: (account: string) => KeyStore): void {
  if (!lstatSync(dir).isDirectory()) throw new Error('The broker directory is not owned storage.');
  for (const [part, allowed] of [['run', ['broker.sock', 'programs']], ['run/programs', []]] as const) {
    const p = join(dir, part);
    if (existsSync(p) && (!lstatSync(p).isDirectory() || readdirSync(p).some((n) => !(allowed as readonly string[]).includes(n)))) throw new Error('Owned program cleanup needs operator recovery.');
  }
  const file = join(dir, 'device.json');
  if (!existsSync(file)) {
    if (readdirSync(dir).some((name) => name !== 'run')) throw new Error('Missing broker device record; operator recovery is required.');
    return;
  }
  if (!lstatSync(file).isFile()) throw new Error('Invalid broker device record.');
  const d = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown };
  if (typeof d.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id)) throw new Error('Invalid broker device record.');
  for (const prefix of ['device', 'sign']) store(`${prefix}-${d.id}`).remove();
}
