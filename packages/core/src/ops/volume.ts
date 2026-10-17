// Best-effort check whether the data directory sits on an encrypted volume (FR-149 baseline,
// Diagnostics). Full-database encryption is out of scope for M3, so the database is only as
// protected as the volume under it; Diagnostics warns when that volume looks unencrypted.
// Linux: the mount holding the path (/proc/self/mountinfo), then the block device chain in
// /sys for a dm-crypt (LUKS) layer, or a stacked encrypting filesystem. macOS: `diskutil info`
// for the volume's FileVault state. Anything else, or anything unclear, is `unknown`.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isWithin } from '@nova/security';

export type VolumeEncryption = 'encrypted' | 'unencrypted' | 'unknown';

export interface VolumeProbeOptions {
  platform?: NodeJS.Platform;
  /** Prefix for /proc and /sys (tests point it at a fixture tree). */
  root?: string;
  /** Runs a command (macOS); never rejects. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;
}

const ENCRYPTED_FS = new Set([
  'ecryptfs',
  'fuse.gocryptfs',
  'fuse.encfs',
  'fuse.cryfs',
  'fuse.securefs',
]);

function defaultRun(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

export async function detectVolumeEncryption(
  path: string,
  opts: VolumeProbeOptions = {},
): Promise<VolumeEncryption> {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === 'linux') return linux(path, opts.root ?? '/');
    if (platform === 'darwin') return await macos(path, opts.run ?? defaultRun);
  } catch {
    // fall through: a probe never fails Diagnostics
  }
  return 'unknown';
}

/** mountinfo escapes spaces and other bytes as octal (`\040`). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

function linux(path: string, root: string): VolumeEncryption {
  const mountinfo = readFileSync(join(root, 'proc/self/mountinfo'), 'utf8');
  let best: { mount: string; dev: string; fstype: string; source: string } | null = null;
  for (const line of mountinfo.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const [fstype = '', source = ''] = line.slice(sep + 3).split(' ');
    const mount = unescapeMount(left[4] ?? '');
    if (!mount.startsWith('/') || !isWithin(mount, path)) continue;
    if (!best || mount.length >= best.mount.length) {
      best = { mount, dev: left[2] ?? '', fstype, source: unescapeMount(source) };
    }
  }
  if (!best) return 'unknown';
  if (ENCRYPTED_FS.has(best.fstype)) return 'encrypted';
  let dev: string | null = null;
  if (/^[1-9]\d*:\d+$/.test(best.dev)) dev = join(root, 'sys/dev/block', best.dev);
  else if (best.source.startsWith('/dev/')) {
    // Filesystems such as btrfs report an anonymous device number; follow the source instead.
    const node = realpathSync(join(root, best.source));
    dev = join(root, 'sys/class/block', basename(node));
  }
  if (!dev || !existsSync(dev)) return 'unknown';
  if (cryptLayer(dev, 0)) return 'encrypted';
  // A loop device's backing file lives on another volume; do not guess.
  return basename(realpathSync(dev)).startsWith('loop') ? 'unknown' : 'unencrypted';
}

/** Whether a dm-crypt device appears anywhere below this block device. */
function cryptLayer(dir: string, depth: number): boolean {
  if (depth > 8) return false;
  const real = realpathSync(dir);
  const uuidFile = join(real, 'dm', 'uuid');
  if (existsSync(uuidFile) && readFileSync(uuidFile, 'utf8').startsWith('CRYPT-')) return true;
  const slaves = join(real, 'slaves');
  if (existsSync(slaves)) {
    for (const s of readdirSync(slaves)) if (cryptLayer(join(slaves, s), depth + 1)) return true;
  }
  // A partition: look at the device it is part of.
  if (existsSync(join(real, 'partition'))) return cryptLayer(dirname(real), depth + 1);
  return false;
}

async function macos(
  path: string,
  run: NonNullable<VolumeProbeOptions['run']>,
): Promise<VolumeEncryption> {
  const df = await run('df', ['-P', path]);
  const line = df.stdout.trim().split('\n')[1];
  if (df.code !== 0 || !line) return 'unknown';
  const mount = line.split(/\s+/).slice(5).join(' ');
  const info = await run('diskutil', ['info', mount]);
  if (info.code !== 0) return 'unknown';
  const state = /^\s*(?:FileVault|Encrypted):\s*(Yes|No)\b/m.exec(info.stdout)?.[1];
  if (state === 'Yes') return 'encrypted';
  if (state === 'No') return 'unencrypted';
  return 'unknown';
}
