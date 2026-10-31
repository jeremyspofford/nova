// Nova Computer (M10a): the interface every kind of workspace machine implements, so a VM or a
// remote hub can be added later without changing callers (ADR-8: adapters behind Nova's own thin
// contract). The first adapter is Docker on this machine (docker.ts). Also the folder's identity,
// and the copy and digest that checkpoints and resets are checked with.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, futimesSync, lstatSync, lutimesSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, symlinkSync, utimesSync, writeSync, fchmodSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import { CoreError } from '../errors.ts';
import type { EgressDecl } from './policy.ts';

// Which folder a workspace was made with, beyond its path: the device, inode and birth time it had
// when the person approved it. A path can be pointed somewhere else (a link, a folder put in its
// place); these can't, so every mount, copy, digest and reset checks them first. The birth time is
// there because a filesystem may give a new folder a freed inode number again (ext4 does): a folder
// made in another's place then has the same inode but not the same birth (where the filesystem
// records births; elsewhere it is 0, and only the device and inode are compared).
export interface FolderId { dev: string; ino: string; born: string }

// One workspace as the adapter needs it: where its project folder is (by its real path and
// identity), what it may reach, its machine (when one exists) and the image that machine is made
// from. `gitWritable`: the person chose to let commands inside change the project's .git.
export interface Machine { id: string; folder: string; folderId: FolderId; egress: EgressDecl; container: string | null; image: string; gitWritable?: boolean }

// A command, and for one that may reach outside, how its egress tunnel is opened (and closed when
// the command ends). The adapter opens it only once nothing but the machine's own processes runs.
export interface Tunnelled { close(): Promise<void> }
export interface ExecRequest {
  argv: string[]; timeoutS: number; maxBytes?: number;
  tunnel?: (attach: (argv: string[], user: string) => ChildProcess) => Promise<Tunnelled>;
  // Checked while the command runs; a reason stops it (a disk cap, say).
  watch?: { everyMs: number; check: () => Promise<string | null> };
}
// `stray`: processes the command left running, which were stopped when it ended. `stopped`: why
// the command was stopped part way (a cap), if it was.
export interface ExecResult { exit: number | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean; duration_ms: number; stray: number; stopped: string | null }

// A checkpoint's two halves: the machine's image, and a copy of the project folder with its digest.
export interface Saved { image: string; digest: string; files: number; bytes: number; skipped: string[] }

export interface Computer {
  readonly kind: string;
  // Whether this adapter can run workspaces here, and why not, in plain words.
  available(): Promise<{ ok: boolean; detail: string }>;
  create(m: Machine): Promise<{ container: string }>;
  exec(m: Machine, r: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  // `dir`: where the folder copy goes (made by the call).
  checkpoint(m: Machine, cp: { id: string; dir: string }): Promise<Saved>;
  // Back to a checkpoint: the machine made again from its image, the folder replaced by its copy.
  reset(m: Machine, to: { image: string; dir: string }): Promise<{ container: string }>;
  // `images`: the workspace's checkpoint images, removed with it.
  destroy(m: Machine, images: string[]): Promise<void>;
  // Removes checkpoint images of this workspace's that are no longer kept (never the machine's own).
  drop(m: Machine, images: string[]): Promise<void>;
  // What changed in the machine's own filesystem since its image, each with what it is now (for
  // checking a read): one line per path, `<A|C|D> <path>\t<signature>`.
  changes(m: Machine): Promise<string[]>;
  // How many bytes the machine's own filesystem holds beyond its image, or null if unknown.
  layerBytes(m: Machine): Promise<number | null>;
  // Whether the machine's own filesystem cap is enforced by the adapter itself (else Nova checks it
  // while commands run).
  layerQuota?(): Promise<boolean>;
  // A long-running process inside, for the egress relay (egress.ts), as `user`.
  attach(m: Machine, argv: string[], user: string): ChildProcess;
}

export const FOLDER_COPY = 'folder';

const notThatFolder = (folder: string, why: string) => new CoreError('conflict', `The project folder ${folder} isn’t the folder this workspace was made with (${why}), so Nova won’t mount, copy or reset it. If the project moved, make a new workspace on it.`);

// The identity of a folder as it is now: refused if it is a link or not a folder.
export function folderIdentity(path: string): FolderId {
  const st = lstatSync(path, { bigint: true });
  if (st.isSymbolicLink()) throw new CoreError('validation', `${path} is a link: name the folder it points to.`);
  if (!st.isDirectory()) throw new CoreError('validation', `${path} is not a folder.`);
  return { dev: String(st.dev), ino: String(st.ino), born: String(st.birthtimeNs) };
}

// Before every mount, copy, digest and reset: the folder is still the one the workspace was made
// with. Not a link, and no link on the way to it (its real path is its path), and the same device
// and inode.
export function checkFolderId(folder: string, id: FolderId | null | undefined): void {
  if (!id) throw notThatFolder(folder, 'Nova has no record of which folder it was');
  let st;
  try { st = lstatSync(folder, { bigint: true }); } catch { throw notThatFolder(folder, 'it isn’t there'); }
  if (st.isSymbolicLink()) throw notThatFolder(folder, 'it is a link now');
  if (!st.isDirectory()) throw notThatFolder(folder, 'it isn’t a folder now');
  let real: string;
  try { real = realpathSync(folder); } catch { throw notThatFolder(folder, 'its path doesn’t resolve'); }
  if (real !== folder) throw notThatFolder(folder, `its path leads to ${real} now`);
  if (String(st.dev) !== id.dev || String(st.ino) !== id.ino || String(st.birthtimeNs) !== id.born) throw notThatFolder(folder, 'a different folder is at that path now');
}

export interface Digest { digest: string; files: number; bytes: number }

const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK = 1 << 20;

// One walk for the digest, the copy and the size: entries in name order, never following a link,
// and never opening anything but a regular file (a FIFO, a socket or a device is noted and left
// alone; opening a FIFO would wait for a writer). A file is opened without following a link and
// checked to be the file that was listed, so one swapped for a link between the two is refused,
// not read through. `file` gets the open descriptor.
type Visit = {
  dir?: (rel: string, mode: number, st: Stats) => void;
  dirDone?: (rel: string, st: Stats) => void;
  file?: (rel: string, mode: number, fd: number, size: number, st: Stats) => void;
  link?: (rel: string, mode: number, target: string, st: Stats) => void;
  other?: (rel: string, mode: number, kind: string) => void;
  stop?: () => boolean;
};
function walk(root: string, v: Visit): void {
  const go = (rel: string) => {
    for (const n of readdirSync(rel ? join(root, rel) : root).sort()) {
      if (v.stop?.()) return;
      const r = rel ? `${rel}/${n}` : n;
      const p = join(root, r);
      const st = lstatSync(p);
      const mode = st.mode & 0o7777;
      if (st.isSymbolicLink()) v.link?.(r, mode, readlinkSync(p), st);
      else if (st.isDirectory()) { v.dir?.(r, mode, st); go(r); v.dirDone?.(r, st); }
      else if (st.isFile()) {
        if (!v.file) continue;
        let fd: number;
        try { fd = openSync(p, NOFOLLOW); } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ELOOP') throw new CoreError('conflict', `${r} changed into a link while Nova read the folder; nothing was read through it.`);
          throw new CoreError('conflict', `Nova couldn’t read ${r} in the project folder (${code ?? (e as Error).message}).`);
        }
        try {
          const now = fstatSync(fd);
          if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) throw new CoreError('conflict', `${r} changed while Nova read the folder; nothing was read through it.`);
          v.file(r, mode, fd, now.size, st);
        } finally { closeSync(fd); }
      } else v.other?.(r, mode, st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'device');
    }
  };
  go('');
}

const hashFd = (fd: number): string => {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; ;) {
    const n = readSync(fd, buf, 0, CHUNK, pos);
    if (!n) break;
    h.update(buf.subarray(0, n));
    pos += n;
  }
  return h.digest('hex');
};

// A folder's digest: every entry's path, type and permission bits, a file's bytes, a link's target
// (never what it points at), and a FIFO, socket or device by its kind alone (never opened).
export function treeDigest(dir: string): Digest {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  walk(dir, {
    link: (r, mode, target) => h.update(`l ${mode.toString(8)} ${r} -> ${target}\n`),
    dir: (r, mode) => h.update(`d ${mode.toString(8)} ${r}\n`),
    file: (r, mode, fd, size) => { files++; bytes += size; h.update(`f ${mode.toString(8)} ${r} ${size} ${hashFd(fd)}\n`); },
    other: (r, mode) => h.update(`o ${mode.toString(8)} ${r}\n`),
  });
  return { digest: h.digest('hex'), files, bytes };
}

// A stamp of a file or folder that changes whenever anything in it changes, from metadata alone
// (nothing opened or followed): each entry's path, type, mode, size, modification time and ctime.
// A process can set a file's modification time back, never its ctime, so a change can't hide; and
// it is cheap enough for a large .git.
export function treeStamp(path: string): string {
  const h = createHash('sha256');
  const line = (r: string, st: import('node:fs').BigIntStats) => h.update(`${r} ${st.mode.toString(8)} ${st.size} ${st.mtimeNs} ${st.ctimeNs}\n`);
  const top = lstatSync(path, { bigint: true });
  line('.', top);
  const go = (rel: string) => {
    for (const n of readdirSync(join(path, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(path, r), { bigint: true });
      line(r, st);
      if (st.isDirectory()) go(r);
    }
  };
  if (top.isDirectory()) go('');
  return h.digest('hex');
}

// The bytes of the regular files under a folder, stopping once past `limit` (lstat only, nothing
// opened or followed).
export function treeSize(dir: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  const go = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (bytes > limit) return;
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) bytes += lstatSync(p).size;
    }
  };
  go(dir);
  return bytes;
}

// Copies what is inside `from` into the folder `to`, from the walk above: nothing outside `from` is
// ever read, links stay links (their target as written), permission bits and modification times
// are kept, and FIFOs, sockets and devices are left out (returned).
function copyEntries(from: string, to: string): string[] {
  const skipped: string[] = [];
  const buf = Buffer.allocUnsafe(CHUNK);
  const times = (st: Stats) => [st.atime, st.mtime] as const;
  walk(from, {
    dir: (r) => mkdirSync(join(to, r), { mode: 0o700 }),
    // A folder's own bits and times go on after what is in it, so a read-only one can be filled.
    dirDone: (r, st) => { chmodSync(join(to, r), st.mode & 0o7777); utimesSync(join(to, r), ...times(st)); },
    file: (r, mode, fd, _size, st) => {
      const out = openSync(join(to, r), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (let pos = 0; ;) {
          const n = readSync(fd, buf, 0, CHUNK, pos);
          if (!n) break;
          for (let w = 0; w < n;) w += writeSync(out, buf, w, n - w);
          pos += n;
        }
        fchmodSync(out, mode);
        futimesSync(out, ...times(st));
      } finally { closeSync(out); }
    },
    link: (r, _mode, target, st) => { symlinkSync(target, join(to, r)); lutimesSync(join(to, r), ...times(st)); },
    other: (r, _mode, kind) => skipped.push(`${r} (${kind})`),
  });
  return skipped;
}

// A copy of a folder as a new folder `to` (its parent made if need be).
export function copyTree(from: string, to: string): string[] {
  mkdirSync(dirname(to), { recursive: true });
  mkdirSync(to, { mode: 0o700 });
  const skipped = copyEntries(from, to);
  const st = lstatSync(from);
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
  return skipped;
}

// Replaces everything inside `folder` with the contents of `copy` (the folder itself stays, since
// it is what is mounted). The caller has checked the folder is the workspace's own (checkFolderId);
// removing never follows a link.
export function replaceContents(folder: string, copy: string): void {
  for (const n of readdirSync(folder)) rmSync(join(folder, n), { recursive: true, force: true });
  copyEntries(copy, folder);
}
