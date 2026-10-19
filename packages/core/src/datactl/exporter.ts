// Data export (FR-105, ADR-097 D5): the whole Hub as one `.novaexport` stream. The database is
// copied first (`VACUUM INTO`, a consistent snapshot taken between transactions), then read table
// by table from the copy while the Hub keeps working; files are read one chunk at a time. Nothing
// holds the whole database or a whole archive in memory, and the caller pulls bytes as fast as it
// can send them.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DATA_EXPORT_FORMAT,
  NovaError,
  type ExportBlob,
  type ExportManifest,
  type ExportOmission,
  type ExportTable,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { hubOwnerId } from '../team/owner.ts';
import { LOG_TABLES, SECRET_REF_PATTERN, dataTables, tableLines } from './codec.ts';
import { isCredentialFile, isSealedBlob, listDataFiles, openSealed } from './files.ts';
import { createSealer, type ScryptParams } from './seal.ts';
import { ZipWriter } from './zip.ts';

/**
 * Tables holding the Hub's own keys (its identity, local CA and certificates, Relay key). Their
 * private halves are vault secrets, so an archive without a passphrase leaves them out and the
 * importing Hub keeps its own (paired devices are added again).
 */
export const HUB_KEY_TABLES: readonly string[] = [
  'trust_identity',
  'trust_ca',
  'trust_certificate',
  'relay_registration',
];

/**
 * Rows that need the Hub's keys: left out with them and not kept either (Relay clients pair again,
 * browsers subscribe to push again: their subscription secrets are `secret://push/<id>/auth`).
 */
export const HUB_KEY_DEPENDENTS: readonly string[] = ['relay_client', 'push_subscription'];

/** Secrets the Hub makes itself (keys, tokens it generated): never "to re-enter". */
export const HUB_SECRET_PREFIXES: readonly string[] = [
  'secret://hub/',
  'secret://push/',
  'secret://relay/',
];

/** The Relay registration token is one the owner pastes in, not one the Hub makes. */
const USER_RELAY_PREFIX = 'secret://relay/registration/';

export function hubMadeSecret(ref: string): boolean {
  return !ref.startsWith(USER_RELAY_PREFIX) && HUB_SECRET_PREFIXES.some((p) => ref.startsWith(p));
}

const CREDENTIALS_SEALED = 'credentials travel only in an archive sealed with a passphrase';

export interface ExportOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  hubVersion: string;
  /** Seals the archive and includes the vault's secrets. */
  passphrase?: string;
  scrypt?: ScryptParams;
  now?: () => Date;
  /** Called once the last byte was produced. */
  onComplete?: (manifest: ExportManifest, bytes: number) => void;
}

/** The working folder of the data controls (snapshots, uploads, staging); never exported. */
export function workDir(dataDir: string): string {
  return join(dataDir, 'datactl');
}

/** Run `fn` at a moment no transaction is open on the connection (VACUUM cannot run in one). */
export async function whenIdle<T>(db: NovaDatabase, fn: () => T): Promise<T> {
  for (let i = 0; i < 10_000; i++) {
    await db.transaction(() => undefined);
    if (!db.raw.isTransaction) return fn();
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new NovaError('conflict', 'the database stayed busy; try again', {
    details: { reason: 'busy' },
  });
}

/** A consistent copy of the database in the work folder; the caller removes it. */
export async function snapshotDatabase(db: NovaDatabase, dataDir: string): Promise<string> {
  const dir = join(workDir(dataDir), 'tmp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `snapshot-${randomUUID()}.db`);
  await whenIdle(db, () => db.backupTo(path));
  return path;
}

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | bigint | null } | undefined;
  return Number(row?.v ?? 0);
}

const CHUNK = 256 * 1024;
const FILE_CHUNK = 1024 * 1024;

/** Stream a `.novaexport` archive of the whole Hub. */
export async function* exportArchive(opts: ExportOptions): AsyncGenerator<Buffer> {
  const now = (opts.now ?? (() => new Date()))();
  const encrypted = opts.passphrase !== undefined;
  const sealer = encrypted ? await createSealer(opts.passphrase!, opts.scrypt) : null;
  const snapPath = await snapshotDatabase(opts.db, opts.dataDir);
  let snap: DatabaseSync | null = null;
  try {
    snap = new DatabaseSync(snapPath, { readOnly: true });
    const zip = new ZipWriter(now);
    let bytes = 0;
    const out = (bufs: Buffer[]): Buffer[] => {
      const res: Buffer[] = [];
      for (const b of bufs) {
        if (!b.length) continue;
        const piece = sealer ? sealer.update(b) : b;
        bytes += piece.length;
        if (piece.length) res.push(piece);
      }
      return res;
    };
    if (sealer) {
      bytes += sealer.head.length;
      yield sealer.head;
    }

    const tables: ExportTable[] = [];
    const omitted: ExportOmission[] = [];
    // Every secret reference a row holds: the ones without their secret are to re-enter.
    const rowRefs = new Set<string>();
    for (const t of dataTables(snap)) {
      if (!encrypted && (HUB_KEY_TABLES.includes(t.name) || HUB_KEY_DEPENDENTS.includes(t.name))) {
        omitted.push({
          kind: 'table',
          ref: t.name,
          reason: "the Hub's own keys travel only in an archive sealed with a passphrase",
        });
        continue;
      }
      const entry = zip.begin(`tables/${t.name}.jsonl`, 6);
      yield* out([entry.header]);
      const hash = createHash('sha256');
      let rows = 0;
      let pending = '';
      const scan = !LOG_TABLES.includes(t.name);
      for (const line of tableLines(snap, t)) {
        rows++;
        hash.update(line);
        if (scan && line.includes('secret://'))
          for (const m of line.matchAll(SECRET_REF_PATTERN)) rowRefs.add(m[0]);
        pending += line;
        if (pending.length >= CHUNK) {
          yield* out(entry.push(Buffer.from(pending, 'utf8')));
          pending = '';
        }
      }
      if (pending) yield* out(entry.push(Buffer.from(pending, 'utf8')));
      yield* out(entry.finish());
      tables.push({ name: t.name, rows, sha256: hash.digest('hex') });
    }

    const blobs: ExportBlob[] = [];
    for (const f of listDataFiles(opts.dataDir)) {
      let sealed: boolean;
      try {
        sealed = isSealedBlob(f.abs);
      } catch {
        continue; // removed while exporting
      }
      if (sealed) {
        const opened = openSealed(opts.dataDir, f, snap);
        if (opened && !encrypted && isCredentialFile(f.path, opened.label)) {
          omitted.push({ kind: 'file', ref: f.path, reason: CREDENTIALS_SEALED });
          continue;
        }
        if (opened) {
          const entry = zip.begin(`files/${f.path}`, 1);
          yield* out([entry.header]);
          for (let at = 0; at < opened.bytes.length; at += FILE_CHUNK)
            yield* out(entry.push(opened.bytes.subarray(at, at + FILE_CHUNK)));
          yield* out(entry.finish());
          blobs.push({
            path: f.path,
            sha256: createHash('sha256').update(opened.bytes).digest('hex'),
            size: opened.bytes.length,
            seal: opened.label,
          });
          continue;
        }
        if (!encrypted) {
          omitted.push({
            kind: 'file',
            ref: f.path,
            reason:
              "sealed with the Hub's data key, which only an archive with a passphrase carries",
          });
          continue;
        }
      } else if (!encrypted && isCredentialFile(f.path, null)) {
        omitted.push({ kind: 'file', ref: f.path, reason: CREDENTIALS_SEALED });
        continue;
      }
      const entry = zip.begin(`files/${f.path}`, 1);
      yield* out([entry.header]);
      const hash = createHash('sha256');
      let size = 0;
      let fd: number;
      try {
        fd = openSync(f.abs, 'r');
      } catch {
        // Removed while exporting: an empty entry would not match, so record what was read.
        fd = -1;
      }
      try {
        for (;;) {
          if (fd < 0) break;
          const buf = Buffer.alloc(FILE_CHUNK);
          const n = readSync(fd, buf, 0, FILE_CHUNK, size);
          if (n === 0) break;
          size += n;
          const chunk = buf.subarray(0, n);
          hash.update(chunk);
          yield* out(entry.push(chunk));
        }
      } finally {
        if (fd >= 0) closeSync(fd);
      }
      yield* out(entry.finish());
      blobs.push({
        path: f.path,
        sha256: hash.digest('hex'),
        size,
        ...(sealed ? { raw: true as const } : {}),
      });
    }

    const refs = await opts.secrets.list();
    let secrets: ExportManifest['secrets'] = null;
    const toReEnter: string[] = [];
    if (encrypted) {
      const entries: { ref: string; value: string }[] = [];
      for (const ref of refs) {
        const value = await opts.secrets.get(ref);
        if (value !== null) entries.push({ ref, value });
      }
      const body = Buffer.from(JSON.stringify({ v: 1, secrets: entries }), 'utf8');
      const entry = zip.begin('secrets.json', 6);
      yield* out([entry.header]);
      yield* out(entry.push(body));
      yield* out(entry.finish());
      secrets = { count: entries.length, sha256: createHash('sha256').update(body).digest('hex') };
    } else {
      for (const ref of [...new Set([...refs, ...rowRefs])].sort()) {
        if (hubMadeSecret(ref)) continue;
        toReEnter.push(ref);
        omitted.push({ kind: 'secret', ref, reason: 'secrets travel only with a passphrase' });
      }
    }

    const manifest: ExportManifest = {
      format: DATA_EXPORT_FORMAT,
      hubVersion: opts.hubVersion,
      schemaVersion: schemaVersionOf(snap),
      createdAt: now.toISOString(),
      accountScope: 'hub',
      ownerAccountId: ownerOf(snap),
      dataDir: resolve(opts.dataDir),
      encrypted,
      tables,
      blobs,
      secrets,
      toReEnter,
      omitted,
    };
    const entry = zip.begin('manifest.json', 6);
    yield* out([entry.header]);
    yield* out(entry.push(Buffer.from(JSON.stringify(manifest, null, 1), 'utf8')));
    yield* out(entry.finish());
    yield* out(zip.end());
    if (sealer) {
      const last = sealer.final();
      bytes += last.length;
      yield last;
    }
    opts.onComplete?.(manifest, bytes);
  } finally {
    snap?.close();
    rmSync(snapPath, { force: true });
  }
}

/** The owner recorded in a snapshot (the same lookup the Hub uses). */
function ownerOf(snap: DatabaseSync): string | null {
  try {
    return hubOwnerId({ raw: snap } as unknown as NovaDatabase);
  } catch {
    return null;
  }
}
