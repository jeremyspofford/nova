// The data folder's files in an export, a delete-all and an import (FR-105, ADR-097 D5; layout in
// docs/06 §3). An export carries what is the user's: blobs, plugins, skills, themes, MCP bundles
// and servers' folders, hooks and instructions, firmware snapshots, sites, members' and agents'
// folders, browser profiles and downloads, Code sessions' shadow repositories and the workspace.
// It never carries keys or what the Hub rebuilds: the vault and its key file, the egress CA,
// mesh configuration, logs, backups, caches and staging folders.
//
// Files sealed with the Hub's data key (docs/12 §5) are opened with the label they were sealed
// with and travel decrypted; the importing Hub seals them again with its own key. A sealed file
// whose label is unknown travels still sealed in a sealed archive (whose secrets carry the key),
// and is left out of an archive without a passphrase. Credentials (the agent browsers' cookie
// jars) travel only in a sealed archive.
import { closeSync, lstatSync, openSync, readdirSync, readSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NovaError } from '@nova/shared';
import { readSealedFile, writeAttachmentBlob, writeSealedFile } from '../attachments.ts';

/** What an export carries, relative to the data folder. */
export const EXPORT_ROOTS: readonly string[] = [
  'blobs',
  'plugins',
  'plugins-drafts',
  'skills',
  'themes',
  'mcp',
  'hooks.json',
  'instructions.md',
  'firmware',
  'sites',
  'members',
  'computers',
  'browser',
  'code',
  'workspace',
  // M8: extensions' bundles and data folders, and marketplace items such as pets.
  'extensions',
  'market',
];

/** What delete-all removes besides those: Nova's working folders, keys, backups and caches. */
export const WIPE_ROOTS: readonly string[] = [
  ...EXPORT_ROOTS,
  'backups',
  'egress',
  'network',
  'cache',
  'import',
  'datactl',
  'crash',
  'cloud-mock',
  'boot-images',
];

/**
 * Kept by delete-all and never exported: the database (emptied in place), the vault (emptied)
 * and its key file, the logs (emptied), and the managed policy cache, which is the organization's
 * (the last verified remote policy; deleting it would loosen the policy until the next fetch).
 */
export const KEEP_ENTRIES: readonly string[] = [
  'nova.db',
  'nova.db-wal',
  'nova.db-shm',
  'nova.db-journal',
  'secrets.vault',
  'vault.key',
  'logs',
  'managed',
];

/** Folders a write in progress leaves (plugin and extension installs): never exported. */
const TRANSIENT = /(^|\/)\.(staging|previous)(-[^/]*)?(\/|$)/;

/** Seal labels of credentials: they travel only in an archive sealed with a passphrase. */
export const CREDENTIAL_LABEL_PREFIXES: readonly string[] = ['browser-state:'];

/** Credential files by place, whether or not they are sealed (a Hub without a data key). */
const CREDENTIAL_PATHS: readonly RegExp[] = [
  /^browser\/(profiles|fallback)\/.*state\.json$/,
  /^computers\/[^/]+\/browser\/state\.json$/,
];

/** Whether a file holds credentials (by its seal label or its place). */
export function isCredentialFile(path: string, label: string | null): boolean {
  if (label && CREDENTIAL_LABEL_PREFIXES.some((p) => label.startsWith(p))) return true;
  return CREDENTIAL_PATHS.some((r) => r.test(path));
}

/** The sealed-blob header (attachments.ts): a NUL byte, "NVB", version 1. */
const SEAL_MAGIC = Buffer.from([0x00, 0x4e, 0x56, 0x42, 0x01]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface DataFile {
  /** Relative to the data folder, with forward slashes. */
  path: string;
  abs: string;
  size: number;
}

/** Every regular file under the export roots, in path order. Links are never followed. */
export function listDataFiles(dataDir: string): DataFile[] {
  const out: DataFile[] = [];
  const visit = (abs: string, st: Stats) => {
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const child = join(abs, name);
        let cst: Stats;
        try {
          cst = lstatSync(child);
        } catch {
          continue;
        }
        visit(child, cst);
      }
      return;
    }
    if (!st.isFile()) return;
    const path = relative(dataDir, abs).split(sep).join('/');
    if (TRANSIENT.test(path)) return;
    out.push({ path, abs, size: st.size });
  };
  for (const root of EXPORT_ROOTS) {
    const abs = join(dataDir, root);
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    visit(abs, st);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Whether a file starts with the sealed-blob header. */
export function isSealedBlob(abs: string): boolean {
  const fd = openSync(abs, 'r');
  try {
    const head = Buffer.alloc(SEAL_MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SEAL_MAGIC);
  } finally {
    closeSync(fd);
  }
}

/** The labels a sealed file may have been sealed with, most likely first. */
export function sealLabels(path: string, snapshot: DatabaseSync | null): string[] {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  const out: string[] = [];
  // Content-addressed blobs are sealed under their own name (attachments.ts).
  if (SHA256_HEX.test(base)) out.push(base);
  let m = /^firmware\/snapshots\/([^/]+)\.json$/.exec(path);
  if (m) out.push(`firmware-snapshot:${m[1]}`);
  m = /^browser\/profiles\/([^/]+)\/([^/]+)\/state\.json$/.exec(path);
  if (m) out.push(`browser-state:${m[1]}:${m[2]}`);
  m = /^computers\/([^/]+)\/browser\/state\.json$/.exec(path);
  if (m && snapshot) {
    const row = snapshot.prepare('SELECT account_id FROM computer WHERE id = ?').get(m[1]!) as
      { account_id: string } | undefined;
    if (row) out.push(`browser-state:${row.account_id}:${m[1]}`);
  }
  // Screenshots and other sealed files use their path in the data folder.
  out.push(path);
  return out;
}

/** Open a sealed file with the first label that fits; null when none does. */
export function openSealed(
  dataDir: string,
  file: DataFile,
  snapshot: DatabaseSync | null,
): { label: string; bytes: Buffer } | null {
  for (const label of sealLabels(file.path, snapshot)) {
    try {
      return { label, bytes: readSealedFile(dataDir, file.abs, label) };
    } catch {
      // not this label (or not this Hub's key)
    }
  }
  return null;
}

/** Write a file the archive carried decrypted, sealed again with this Hub's data key. */
export function writeResealed(dataDir: string, path: string, label: string, bytes: Buffer): void {
  const abs = join(dataDir, path);
  if (SHA256_HEX.test(label)) {
    // A content-addressed blob is written where its content puts it.
    if (path !== `blobs/attachments/${label}`)
      throw new NovaError('validation', `the archive puts a blob in the wrong place: ${path}`, {
        details: { reason: 'archive_damaged' },
      });
    writeAttachmentBlob(dataDir, bytes);
    return;
  }
  writeSealedFile(dataDir, abs, label, bytes);
}

/** A relative path from an archive that is safe to create under a folder. */
export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 1024 || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const root = parts[0]!;
  return EXPORT_ROOTS.includes(root);
}
