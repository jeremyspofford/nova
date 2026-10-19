// Where `nova keys` keeps the publisher's private key (ADR-097 D1): one Ed25519 key in a PKCS#8
// PEM file, mode 0600 in a 0700 folder under the user's configuration folder, never in a
// repository. NOVA_PUBLISHER_KEY or `--key` name another file.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The default key file: `$XDG_CONFIG_HOME/nova/publisher-key` (or `%APPDATA%\Nova\…`). */
export function defaultKeyFile(env: NodeJS.ProcessEnv, platform = process.platform): string {
  if (env.NOVA_PUBLISHER_KEY) return resolve(env.NOVA_PUBLISHER_KEY);
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'Nova', 'publisher-key');
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'nova', 'publisher-key');
}

/** The repository a path is inside (a folder with `.git` above it), or null. */
export function repositoryOf(path: string): string | null {
  let dir = resolve(dirname(path));
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Write a new key file (0600 in a 0700 folder); refuses to overwrite or to write into a repo. */
export function writeKeyFile(file: string, pem: string, opts: { force?: boolean } = {}): void {
  if (existsSync(file) && !opts.force)
    throw new Error(`${file} already exists; use --force to replace it (the old key is lost)`);
  const repo = repositoryOf(file);
  if (repo)
    throw new Error(
      `${file} is inside the repository ${repo}; a private key never goes in a repository`,
    );
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, pem, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Read a key file; `warning` says when others may read it. */
export function readKeyFile(file: string): { pem: string; warning: string | null } {
  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no publisher key at ${file}: run \`nova keys generate\``);
  }
  let warning: string | null = null;
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0)
    warning = `${file} can be read by other users; run chmod 600 on it`;
  return { pem, warning };
}
