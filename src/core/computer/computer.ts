// Nova Computer (M10a): the interface every kind of workspace machine implements, so a VM or a
// remote hub can be added later without changing callers (ADR-8: adapters behind Nova's own thin
// contract). The first adapter is Docker on this machine (docker.ts). Also the folder digest and
// copy that checkpoints and resets are checked with.
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { EgressDecl } from './policy.ts';

// One workspace as the adapter needs it: where its project folder is, what it may reach, its
// machine (when one exists) and the image that machine is made from.
export interface Machine { id: string; folder: string; egress: EgressDecl; container: string | null; image: string }

export interface ExecRequest { argv: string[]; timeoutS: number; maxBytes?: number }
export interface ExecResult { exit: number | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean; duration_ms: number }

// A checkpoint's two halves: the machine's image, and a copy of the project folder with its digest.
export interface Saved { image: string; digest: string; files: number; bytes: number }

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
  // What changed in the machine's own filesystem since its image (for checking a read).
  changes(m: Machine): Promise<string[]>;
  // A long-running process inside, for the egress relay (egress.ts), as `user`.
  attach(m: Machine, argv: string[], user: string): ChildProcess;
}

export const FOLDER_COPY = 'folder';

export interface Digest { digest: string; files: number; bytes: number }

// A folder's digest: every entry's path, type and permission bits, and a file's bytes or a link's
// target. `content: false` uses size and modification time instead of the bytes (fast, for
// noticing a change); true is the byte-for-byte comparison a reset is checked with.
export function treeDigest(dir: string, o: { content: boolean } = { content: true }): Digest {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    const names = readdirSync(join(dir, rel)).sort();
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const p = join(dir, r);
      const st = lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) h.update(`l ${mode} ${r} -> ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) { h.update(`d ${mode} ${r}\n`); walk(r); }
      else if (st.isFile()) {
        files++;
        bytes += st.size;
        h.update(`f ${mode} ${r} ${st.size} ${o.content ? createHash('sha256').update(readFileSync(p)).digest('hex') : st.mtimeMs}\n`);
      } else h.update(`o ${mode} ${r}\n`);
    }
  };
  walk('');
  return { digest: h.digest('hex'), files, bytes };
}

// A copy that keeps permission bits and modification times, and links as links.
export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
}

// Replaces everything inside `folder` with the contents of `copy` (the folder itself stays, since
// it is what is mounted).
export function replaceContents(folder: string, copy: string): void {
  for (const n of readdirSync(folder)) rmSync(join(folder, n), { recursive: true, force: true });
  for (const n of readdirSync(copy)) copyTree(join(copy, n), join(folder, n));
}
