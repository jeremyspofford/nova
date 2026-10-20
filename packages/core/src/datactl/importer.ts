// Data import (FR-105, ADR-097 D5): an archive into an empty Hub (fresh setup, or after
// delete-all), all or nothing. Everything is checked before anything of the Hub's changes: the
// sealed archive's tag, the format, the schema version (an older export migrates forward, a newer
// one is refused), every table's and file's checksum and count. The rows are loaded into a staging
// database built by this build's migrations, so an archive can only fill tables and columns the
// Hub has; then one transaction replaces the Hub's rows and compares every table with the
// archive's checksum before it commits. Files and secrets placed before the commit are taken back
// if anything fails. What an archive cannot vouch for (secret references, paths, what runs code or
// holds trust) is vetted and turned off in staging first (vet.ts); there must be room on the disk
// for the staging copies before any is written.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  DATA_EXPORT_FORMAT,
  NovaError,
  exportManifestSchema,
  type DataImportCheckView,
  type ExportManifest,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import {
  loadMigrations,
  migrate,
  openDatabase,
  type Migration,
  type NovaDatabase,
} from '@nova/storage';
import { useBlobKey } from '../attachments.ts';
import { DATA_KEY_REF } from '../ops/datakey.ts';
import { hubOwnerId } from '../team/owner.ts';
import {
  dataTables,
  decodeLine,
  quoteIdent,
  rebuildSearch,
  storedTables,
  tableLines,
} from './codec.ts';
import { HUB_KEY_TABLES, workDir } from './exporter.ts';
import { safeRelativePath, writeResealed } from './files.ts';
import { isSealedFile, unsealFile } from './seal.ts';
import {
  restoreOff,
  rewriteDataDir,
  tableHashes,
  vetPaths,
  vetSecretRefs,
  type RestoredOff,
} from './vet.ts';
import { listZip, readZipEntry, type ZipEntry, type ZipReadLimits } from './zip.ts';

export const IMPORT_LIMITS: ZipReadLimits = {
  maxEntries: 5_000_000,
  maxTotalBytes: 512 * 1024 ** 3,
};
const MAX_MANIFEST = 256 * 1024 * 1024;
const MAX_SECRETS = 64 * 1024 * 1024;

/**
 * Tables a Hub fills on its own at setup and while it runs, with what they may hold for the Hub
 * to still count as empty. Anything else with a row is the owner's data and blocks an import.
 */
const HOUSEKEEPING: Record<string, string | null> = {
  // The owner (one account), their membership row and sign-in sessions.
  account: 'SELECT count(*) AS n FROM account HAVING count(*) > 1',
  team_member: "SELECT count(*) AS n FROM team_member WHERE role <> 'owner'",
  auth_token: "SELECT count(*) AS n FROM auth_token WHERE kind NOT IN ('setup', 'session')",
  // The offline Mock provider every new owner gets.
  provider_account: "SELECT count(*) AS n FROM provider_account WHERE provider <> 'mock'",
  provider_active: null,
  audit_event: null,
  audit_anchor: null,
  event: null,
  setting: null,
  feature_flag: null,
  sync_meta: null,
  sync_field: null,
  idempotency_key: null,
  trust_identity: null,
  trust_ca: null,
  trust_certificate: null,
  relay_registration: null,
  network_endpoint_check: null,
  network_transport_event: null,
  retention_sweep: null,
  notification: null,
};

/** Whether the Hub holds nothing but what setup and its own upkeep write. */
export function hubEmptiness(db: DatabaseSync): { empty: boolean; blocking: string[] } {
  const blocking: string[] = [];
  const { tables } = storedTables(db);
  for (const t of tables) {
    const q = quoteIdent(t);
    if (t in HOUSEKEEPING) {
      const check = HOUSEKEEPING[t];
      if (!check) continue;
      const row = db.prepare(check).get() as { n: number } | undefined;
      if (row && Number(row.n) > 0) blocking.push(t);
      continue;
    }
    if (db.prepare(`SELECT 1 AS x FROM ${q} LIMIT 1`).get()) blocking.push(t);
  }
  return { empty: blocking.length === 0, blocking };
}

export interface StagedArchive {
  id: string;
  dir: string;
  manifest: ExportManifest;
  /** The decrypted vault entries of a sealed archive. */
  secrets: { ref: string; value: string }[];
  /** The staging database, migrated to this build's schema. */
  dbPath: string;
  /** Set when the archive was older and its rows were migrated forward. */
  migratedFrom: number | null;
  /** Every secret reference the rows hold (outside the key tables): none may resolve here. */
  refs: string[];
  /** What came back turned off (vet.ts). */
  restoredOff: RestoredOff;
  /** The staged tables after vetting, as an export would hash them: the import must match. */
  finalHashes: Map<string, { rows: number; sha256: string }>;
}

export interface StageOptions {
  dataDir: string;
  archivePath: string;
  passphrase?: string;
  /** This build's migrations (tests pass a subset to play an older or newer Hub). */
  migrations?: Migration[];
  limits?: ZipReadLimits;
  now?: () => Date;
  /** Free bytes on the disk holding a folder (tests replace it). */
  freeBytes?: (dir: string) => number;
}

const MARGIN = 64 * 1024 * 1024;

function diskFree(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Refuse before writing when the disk cannot hold what staging needs. */
function ensureRoom(opts: StageOptions, dir: string, bytes: number): void {
  const free = (opts.freeBytes ?? diskFree)(dir);
  if (free < bytes + MARGIN)
    throw refuse(
      `not enough free disk space to import: ${Math.ceil((bytes + MARGIN) / 1024 ** 2)} MiB needed, ${Math.floor(free / 1024 ** 2)} MiB free`,
      'disk_full',
      { neededBytes: bytes + MARGIN, freeBytes: free },
    );
}

const refuse = (message: string, reason: string, details: Record<string, unknown> = {}) =>
  new NovaError('validation', message, { details: { reason, ...details } });

const TABLE_ENTRY = /^tables\/([a-z][a-z0-9_]{0,99})\.jsonl$/;

/** Read and check an archive into a staging folder. Nothing of the Hub's is touched. */
export async function stageArchive(opts: StageOptions): Promise<StagedArchive> {
  const id = randomUUID();
  const dir = join(workDir(opts.dataDir), 'staging', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return await stageInto(id, dir, opts);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function stageInto(id: string, dir: string, opts: StageOptions): Promise<StagedArchive> {
  const migrations = opts.migrations ?? loadMigrations();
  const current = migrations.at(-1)?.version ?? 0;
  let zipPath = opts.archivePath;
  const sealed = isSealedFile(opts.archivePath);
  if (sealed) {
    if (!opts.passphrase)
      throw refuse('this archive is sealed: enter its passphrase', 'passphrase_required');
    ensureRoom(opts, dir, statSync(opts.archivePath).size);
    zipPath = join(dir, 'archive.zip');
    await unsealFile(opts.archivePath, zipPath, opts.passphrase);
  }
  const entries = listZip(zipPath, opts.limits ?? IMPORT_LIMITS);
  // Tables are written twice (their lines, then the staging database); files once.
  ensureRoom(
    opts,
    dir,
    entries.reduce((n, e) => n + (e.name.startsWith('tables/') ? 2 * e.size : e.size), 0),
  );
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) {
    if (byName.has(e.name)) throw refuse(`the archive lists ${e.name} twice`, 'archive_damaged');
    const known =
      e.name === 'manifest.json' ||
      e.name === 'secrets.json' ||
      TABLE_ENTRY.test(e.name) ||
      (e.name.startsWith('files/') && safeRelativePath(e.name.slice(6)));
    if (!known) throw refuse(`the archive holds an unexpected entry: ${e.name}`, 'archive_damaged');
    byName.set(e.name, e);
  }

  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw refuse('the archive has no manifest', 'archive_damaged');
  const manifestText = readSmall(zipPath, manifestEntry, MAX_MANIFEST).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw refuse('the archive manifest is not JSON', 'archive_damaged');
  }
  const format = (parsed as { format?: unknown } | null)?.format;
  if (format !== DATA_EXPORT_FORMAT)
    throw refuse(`this build reads format ${DATA_EXPORT_FORMAT} archives`, 'unsupported_format', {
      format,
    });
  const res = exportManifestSchema.safeParse(parsed);
  if (!res.success) throw refuse('the archive manifest is malformed', 'archive_damaged');
  const manifest = res.data;
  if (manifest.accountScope !== 'hub')
    throw refuse(
      "this archive holds one account's data, not a Hub's: it is kept, not imported",
      'account_scope',
    );
  if (manifest.schemaVersion > current)
    throw refuse(
      `the archive comes from a newer Nova (schema ${manifest.schemaVersion}; this Hub has ${current}): update this Hub first`,
      'newer_schema',
      { schemaVersion: manifest.schemaVersion, current },
    );
  if (manifest.encrypted !== sealed)
    throw refuse('the archive says it is sealed but is not, or the reverse', 'archive_damaged');

  // Every table and file the manifest lists is present, matches, and nothing else is there.
  const listed = new Set<string>(['manifest.json']);
  for (const t of manifest.tables) {
    const name = `tables/${t.name}.jsonl`;
    const entry = byName.get(name);
    if (!entry) throw refuse(`the archive lacks table ${t.name}`, 'archive_damaged');
    listed.add(name);
    const target = join(dir, 'tables', `${t.name}.jsonl`);
    const { sha256, lines } = extract(zipPath, entry, target, true);
    if (sha256 !== t.sha256 || lines !== t.rows)
      throw refuse(`table ${t.name} fails its checksum`, 'checksum_mismatch', { table: t.name });
  }
  for (const b of manifest.blobs) {
    if (!safeRelativePath(b.path))
      throw refuse(`the archive names an unsafe path: ${b.path}`, 'archive_damaged');
    const name = `files/${b.path}`;
    const entry = byName.get(name);
    if (!entry) throw refuse(`the archive lacks file ${b.path}`, 'archive_damaged');
    listed.add(name);
    const { sha256, size } = extract(zipPath, entry, join(dir, 'files', b.path), false);
    if (sha256 !== b.sha256 || size !== b.size)
      throw refuse(`file ${b.path} fails its checksum`, 'checksum_mismatch', { file: b.path });
  }
  let secrets: { ref: string; value: string }[] = [];
  const secretsEntry = byName.get('secrets.json');
  if (manifest.encrypted) {
    if (!secretsEntry || !manifest.secrets)
      throw refuse('the sealed archive has no secrets', 'archive_damaged');
    listed.add('secrets.json');
    const body = readSmall(zipPath, secretsEntry, MAX_SECRETS);
    if (createHash('sha256').update(body).digest('hex') !== manifest.secrets.sha256)
      throw refuse('the secrets fail their checksum', 'checksum_mismatch');
    secrets = parseSecrets(body);
    if (secrets.length !== manifest.secrets.count)
      throw refuse('the secrets fail their count', 'checksum_mismatch');
  } else if (secretsEntry) {
    throw refuse('an archive without a passphrase carries secrets', 'archive_damaged');
  }
  for (const name of byName.keys())
    if (!listed.has(name))
      throw refuse(`the archive holds an unlisted entry: ${name}`, 'archive_damaged');
  if (sealed) rmSync(zipPath, { force: true });

  // The staging database: this build's migrations up to the archive's version, its rows, then the
  // rest of the migrations (an older archive's rows migrate forward).
  const dbPath = join(dir, 'staging.db');
  const stage = openDatabase({ path: dbPath });
  try {
    await migrate(stage, {
      migrations: migrations.filter((m) => m.version <= manifest.schemaVersion),
    });
    loadTables(stage.raw, dir, manifest);
    const violations = stage.raw.prepare('PRAGMA foreign_key_check').all() as {
      table: string;
    }[];
    if (violations.length)
      throw refuse("the archive's rows refer to rows it does not hold", 'archive_inconsistent', {
        tables: [...new Set(violations.map((v) => v.table))].slice(0, 20),
      });
    if (manifest.schemaVersion < current)
      await migrate(stage, { migrations, backupDir: join(dir, 'backups') });
    // What an archive cannot vouch for (vet.ts), on the final schema.
    if (manifest.dataDir) rewriteDataDir(stage.raw, manifest.dataDir, opts.dataDir);
    vetPaths(stage.raw, opts.dataDir);
    const refs = vetSecretRefs(stage.raw, {
      encrypted: manifest.encrypted,
      toReEnter: manifest.toReEnter,
    });
    const restoredOff = restoreOff(stage.raw, (opts.now ?? (() => new Date()))().toISOString());
    return {
      id,
      dir,
      manifest,
      secrets,
      dbPath,
      migratedFrom: manifest.schemaVersion < current ? manifest.schemaVersion : null,
      refs,
      restoredOff,
      finalHashes: tableHashes(stage.raw),
    };
  } finally {
    stage.close();
  }
}

function readSmall(zipPath: string, entry: ZipEntry, max: number): Buffer {
  if (entry.size > max) throw refuse(`${entry.name} is too large`, 'archive_damaged');
  const parts: Uint8Array[] = [];
  readZipEntry(zipPath, entry, (c) => parts.push(Buffer.from(c)));
  return Buffer.concat(parts);
}

function extract(
  zipPath: string,
  entry: ZipEntry,
  target: string,
  countLines: boolean,
): { sha256: string; size: number; lines: number } {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const fd = openSync(target, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  let lines = 0;
  try {
    readZipEntry(zipPath, entry, (chunk) => {
      hash.update(chunk);
      size += chunk.length;
      if (countLines) for (const b of chunk) if (b === 0x0a) lines++;
      writeSync(fd, chunk);
    });
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size, lines };
}

function parseSecrets(body: Buffer): { ref: string; value: string }[] {
  let v: unknown;
  try {
    v = JSON.parse(body.toString('utf8'));
  } catch {
    throw refuse('the secrets are not JSON', 'archive_damaged');
  }
  const list = (v as { secrets?: unknown } | null)?.secrets;
  if (!Array.isArray(list)) throw refuse('the secrets are malformed', 'archive_damaged');
  return list.map((s) => {
    const o = s as { ref?: unknown; value?: unknown };
    if (typeof o.ref !== 'string' || !o.ref.startsWith('secret://') || typeof o.value !== 'string')
      throw refuse('the secrets are malformed', 'archive_damaged');
    return { ref: o.ref, value: o.value };
  });
}

/** Call `fn` with each line of a file (without its newline), reading in chunks. */
function forEachLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let nl = data.indexOf(0x0a);
      while (nl >= 0) {
        fn(data.toString('utf8', 0, nl));
        data = data.subarray(nl + 1);
        nl = data.indexOf(0x0a);
      }
      carry = Buffer.from(data);
    }
    if (carry.length) throw refuse(`${path} ends without a newline`, 'archive_damaged');
  } finally {
    closeSync(fd);
  }
}

/** Insert one table's JSON lines into `db` (statements cached by the columns a row names). */
function insertLines(db: DatabaseSync, table: string, file: string, columns: string[]): number {
  const allowed = new Set(columns);
  const stmts = new Map<string, StatementSync>();
  let n = 0;
  forEachLine(file, (line) => {
    const row = decodeLine(line, table, allowed);
    const cols = [...row.keys()];
    const key = cols.join('\0');
    let stmt = stmts.get(key);
    if (!stmt) {
      stmt = db.prepare(
        `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols
          .map(() => '?')
          .join(', ')})`,
      );
      stmts.set(key, stmt);
    }
    stmt.run(...([...row.values()] as SQLInputValue[]));
    n++;
  });
  return n;
}

function loadTables(db: DatabaseSync, dir: string, manifest: ExportManifest): void {
  const known = new Map(dataTables(db).map((t) => [t.name, t]));
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const t of manifest.tables) {
      const info = known.get(t.name);
      if (!info)
        throw refuse(
          `the archive holds a table this Hub does not know: ${t.name}`,
          'unknown_table',
          {
            table: t.name,
          },
        );
      insertLines(db, t.name, join(dir, 'tables', `${t.name}.jsonl`), info.columns);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** What a staged archive holds, for the check route. */
export function checkView(
  staged: StagedArchive,
  hub: { empty: boolean; blocking: string[] },
): DataImportCheckView {
  const m = staged.manifest;
  return {
    format: m.format,
    hubVersion: m.hubVersion,
    schemaVersion: m.schemaVersion,
    migratesFrom: staged.migratedFrom,
    createdAt: m.createdAt,
    encrypted: m.encrypted,
    tables: m.tables.map((t) => ({ name: t.name, rows: t.rows })),
    rows: m.tables.reduce((n, t) => n + t.rows, 0),
    files: { count: m.blobs.length, bytes: m.blobs.reduce((n, b) => n + b.size, 0) },
    secrets: { included: m.encrypted, count: m.secrets?.count ?? 0 },
    toReEnter: m.toReEnter,
    omitted: m.omitted,
    hubEmpty: hub.empty,
    blockingTables: hub.blocking,
  };
}

export interface ApplyOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  /** The importing owner's session (an `auth_token` id): it stays signed in, as the new owner. */
  keepSessionId?: string | null;
}

export interface ApplyResult {
  tables: number;
  rows: number;
  files: number;
  secrets: number;
  keptTables: string[];
  /** The audit entries this Hub had before the import (summarized in the import's entry). */
  previousAudit: { action: string; createdAt: string }[];
  ownerAccountId: string | null;
}

interface Placed {
  path: string;
  /** Where the file it replaced was moved, to put it back on failure. */
  aside: string | null;
}

/**
 * Replace this Hub's data with a staged archive, all or nothing. The Hub must be empty
 * (`hubEmptiness`); the caller checks, restarts the Hub's services afterwards, and audits.
 */
export async function applyStaged(staged: StagedArchive, opts: ApplyOptions): Promise<ApplyResult> {
  const { db, dataDir } = opts;
  const m = staged.manifest;
  const kept = m.encrypted ? [] : HUB_KEY_TABLES.filter((t) => tableExists(db.raw, t));
  const stage = new DatabaseSync(staged.dbPath, { readOnly: true });
  const putSecrets: { ref: string; previous: string | null }[] = [];
  const placed: Placed[] = [];
  let previousKey: Buffer | null = null;
  try {
    // 0. No row may resolve to a secret this Hub holds that the archive does not carry.
    const carried = new Set(staged.secrets.map((s) => s.ref));
    for (const ref of staged.refs)
      if (!carried.has(ref) && (await opts.secrets.has(ref)))
        throw refuse(
          'the archive names a secret this Hub holds and the archive does not carry',
          'foreign_secret',
        );
    // 1. Secrets (a sealed archive): the archive's data key becomes this Hub's, so the files sealed
    //    again below and the ones carried still sealed are readable with one key.
    for (const s of staged.secrets) {
      const previous = await opts.secrets.get(s.ref);
      await opts.secrets.put(s.ref, s.value);
      putSecrets.push({ ref: s.ref, previous });
      if (s.ref === DATA_KEY_REF) {
        if (previous) previousKey = Buffer.from(previous, 'base64');
        useBlobKey(dataDir, Buffer.from(s.value, 'base64'));
      }
    }
    // 2. Files, sealed again where they were sealed.
    const asideRoot = join(staged.dir, 'replaced');
    for (const b of m.blobs) {
      const target = join(dataDir, b.path);
      const source = join(staged.dir, 'files', b.path);
      let aside: string | null = null;
      if (existsSync(target)) {
        aside = join(asideRoot, b.path);
        mkdirSync(dirname(aside), { recursive: true, mode: 0o700 });
        renameSync(target, aside);
      }
      placed.push({ path: target, aside });
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (b.seal) writeResealed(dataDir, b.path, b.seal, readFileSync(source));
      else renameSync(source, target);
    }
    // 3. The rows, in one transaction that checks itself before it commits.
    const result = await db.transaction(() => replaceRows(db.raw, stage, staged, kept, opts));
    // 4. Vault entries the archive does not hold were this Hub's own (a sealed archive replaces
    //    them all): remove them now that nothing refers to them.
    if (m.encrypted) {
      const keep = new Set(staged.secrets.map((s) => s.ref));
      for (const ref of await opts.secrets.list())
        if (!keep.has(ref)) await opts.secrets.delete(ref).catch(() => false);
    }
    return { ...result, files: m.blobs.length, secrets: staged.secrets.length, keptTables: kept };
  } catch (err) {
    // Take back everything placed before the failure: nothing of the archive stays.
    for (const p of placed.reverse()) {
      rmSync(p.path, { force: true });
      if (p.aside) renameSync(p.aside, p.path);
    }
    for (const s of putSecrets.reverse()) {
      if (s.previous === null) await opts.secrets.delete(s.ref).catch(() => false);
      else await opts.secrets.put(s.ref, s.previous).catch(() => undefined);
    }
    if (putSecrets.some((s) => s.ref === DATA_KEY_REF)) useBlobKey(dataDir, previousKey);
    throw err;
  } finally {
    stage.close();
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

/** Triggers that refuse deletes on a table (the append-only audit log), dropped while it is replaced. */
function guardTriggers(db: DatabaseSync, table: string): { name: string; sql: string }[] {
  return db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%RAISE(%'",
    )
    .all(table) as { name: string; sql: string }[];
}

/** Delete every row of `table`, past its append-only guards (put back before returning). */
export function clearTable(db: DatabaseSync, table: string): number {
  const guards = guardTriggers(db, table);
  for (const g of guards) db.exec(`DROP TRIGGER ${quoteIdent(g.name)}`);
  try {
    return Number(db.prepare(`DELETE FROM ${quoteIdent(table)}`).run().changes);
  } finally {
    for (const g of guards) db.exec(g.sql);
  }
}

function replaceRows(
  main: DatabaseSync,
  stage: DatabaseSync,
  staged: StagedArchive,
  kept: readonly string[],
  opts: ApplyOptions,
): Omit<ApplyResult, 'files' | 'secrets' | 'keptTables'> {
  main.exec('PRAGMA defer_foreign_keys = ON');
  let session: Record<string, SQLInputValue> | undefined;
  if (opts.keepSessionId) {
    const read = main.prepare('SELECT * FROM auth_token WHERE id = ?');
    read.setReadBigInts(true);
    session = read.get(opts.keepSessionId);
  }
  const previousAudit = (
    main
      .prepare('SELECT action, created_at AS createdAt FROM audit_event ORDER BY seq LIMIT 50')
      .all() as {
      action: string;
      createdAt: string;
    }[]
  ).map((r) => ({ action: r.action, createdAt: r.createdAt }));

  const { tables, virtual } = storedTables(main);
  for (const t of tables) if (!kept.includes(t)) clearTable(main, t);

  const mainTables = new Map(dataTables(main).map((t) => [t.name, t]));
  let rows = 0;
  let copied = 0;
  for (const t of dataTables(stage)) {
    if (kept.includes(t.name)) continue;
    const target = mainTables.get(t.name);
    if (!target) continue;
    const cols = target.columns.filter((c) => t.columns.includes(c));
    const insert = main.prepare(
      `INSERT INTO ${quoteIdent(t.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`,
    );
    const read = stage.prepare(
      `SELECT ${cols.map(quoteIdent).join(', ')} FROM ${quoteIdent(t.name)} ORDER BY ${t.orderBy}`,
    );
    read.setReadBigInts(true);
    let n = 0;
    for (const r of read.iterate()) {
      const row = r as Record<string, SQLInputValue>;
      insert.run(...cols.map((c) => row[c] ?? null));
      n++;
    }
    rows += n;
    if (n) copied++;
  }
  rebuildSearch(main, virtual);

  // Verify: every table now hashes exactly as the staged archive did (checked against the
  // archive's checksums, migrated forward when older, then vetted), table by table.
  for (const [name, want] of staged.finalHashes) {
    if (kept.includes(name)) continue;
    const info = mainTables.get(name);
    if (!info) throw refuse(`table ${name} did not import`, 'verify_failed', { table: name });
    const hash = createHash('sha256');
    let n = 0;
    for (const line of tableLines(main, info)) {
      hash.update(line);
      n++;
    }
    if (n !== want.rows || hash.digest('hex') !== want.sha256)
      throw refuse(`table ${name} does not match the archive after import`, 'verify_failed', {
        table: name,
      });
  }

  const ownerAccountId = hubOwnerId({ raw: main } as unknown as NovaDatabase);
  // The importing owner stays signed in, now as the archive's owner.
  if (session && ownerAccountId) {
    const cols = Object.keys(session).filter((c) => c !== 'id');
    const values = cols.map((c) => (c === 'account_id' ? ownerAccountId : (session[c] ?? null)));
    // Updated in place when the archive has it (its place in the table stays), else added.
    const updated = main
      .prepare(
        `UPDATE auth_token SET ${cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`,
      )
      .run(...values, session.id ?? null).changes;
    if (!Number(updated))
      main
        .prepare(
          `INSERT INTO auth_token (id, ${cols.map(quoteIdent).join(', ')}) VALUES (?, ${cols
            .map(() => '?')
            .join(', ')})`,
        )
        .run(session.id ?? null, ...values);
  }
  return { tables: copied, rows, previousAudit, ownerAccountId };
}
