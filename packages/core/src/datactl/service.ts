// Data controls (FR-105, ADR-097 D5): export, delete-all and import of the whole Hub, owner-only and
// audited. Delete-all and import run one at a time and replace everything, so the Hub restarts its
// services afterwards (the caller's job); an export can run alongside the Hub's work.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  NovaError,
  type DataDeleteResultView,
  type DataImportCheckView,
  type DataImportResultView,
  type DataImportUploadView,
  type DataOverviewView,
  type ExportManifest,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { Migration, NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { useBlobKey } from '../attachments.ts';
import type { EventSink } from '../events.ts';
import { loadDataKey } from '../ops/datakey.ts';
import { hubOwnerId, isHubOwner } from '../team/owner.ts';
import type { AuditSink } from '../tools/types.ts';
import { dataTables, quoteIdent } from './codec.ts';
import { exportArchive, hubMadeSecret, schemaVersionOf, workDir } from './exporter.ts';
import { listDataFiles } from './files.ts';
import { applyStaged, checkView, hubEmptiness, stageArchive } from './importer.ts';
import { isSealedFile, type ScryptParams } from './seal.ts';
import { wipeHub } from './wipe.ts';

const UPLOAD_TTL_MS = 60 * 60_000;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DataControlsOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  dataDir: string;
  hubVersion: string;
  /** What delete-all asks the owner to type. */
  hubName: () => Promise<string>;
  audit?: AuditSink;
  events?: EventSink;
  log?: Logger;
  now?: () => Date;
  /** Stop background work before rows are replaced (the Hub restarts its services after). */
  quiesce?: () => Promise<void>;
  /** Tests: cheaper key derivation, a migration set, a smaller upload cap. */
  scrypt?: ScryptParams;
  migrations?: Migration[];
  maxUploadBytes?: number;
}

export class DataControls {
  readonly #o: DataControlsOptions;
  #busy: string | null = null;

  constructor(opts: DataControlsOptions) {
    this.#o = opts;
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))();
  }

  /** Only the Hub's owner exports, deletes or imports the whole Hub (fail closed). */
  assertOwner(accountId: string): void {
    if (!isHubOwner(this.#o.db, accountId))
      throw new NovaError('policy_denied', "only the owner of this Hub can manage the Hub's data", {
        details: { reason: 'owner_only' },
      });
  }

  async #exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.#busy)
      throw new NovaError('conflict', `the Hub's data is busy: ${this.#busy} is running`, {
        details: { reason: 'busy' },
      });
    this.#busy = what;
    try {
      return await fn();
    } finally {
      this.#busy = null;
    }
  }

  async #audit(
    accountId: string,
    action: string,
    result: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#o.audit?.append({
        accountId,
        actor: 'user',
        kind: 'settings',
        action,
        resource: 'hub',
        result,
        detail,
      });
    } catch (err) {
      this.#o.log?.warn('data controls audit failed', { action, err });
    }
  }

  async #emit(accountId: string, name: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.#o.events?.emit({ name, actor: 'user', accountId, payload });
    } catch (err) {
      this.#o.log?.warn('data controls event failed', { name, err });
    }
  }

  // ---- overview -----------------------------------------------------------------------------

  async overview(): Promise<DataOverviewView> {
    const raw = this.#o.db.raw;
    let rows = 0;
    const tables = dataTables(raw);
    for (const t of tables)
      rows += Number(
        (raw.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n: number }).n,
      );
    const files = listDataFiles(this.#o.dataDir);
    const refs = await this.#o.secrets.list();
    const emptiness = hubEmptiness(raw);
    return {
      hubName: await this.#o.hubName(),
      hubVersion: this.#o.hubVersion,
      schemaVersion: schemaVersionOf(raw),
      tables: tables.length,
      rows,
      files: { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
      secrets: { count: refs.filter((r) => !hubMadeSecret(r)).length },
      empty: emptiness.empty,
      blockingTables: emptiness.blocking,
    };
  }

  // ---- export -------------------------------------------------------------------------------

  /**
   * A sealed export carries every vault secret: the owner types the Hub's name, from a session of
   * the Hub itself, never a paired device's (M8 data review).
   */
  async assertSealedExport(
    accountId: string,
    confirm: string | undefined,
    from: { deviceSession?: boolean } = {},
  ): Promise<void> {
    this.assertOwner(accountId);
    if (from.deviceSession)
      throw new NovaError(
        'policy_denied',
        'a sealed export carries every secret: start it on the Hub itself, not from a paired device',
        { details: { reason: 'hub_only' } },
      );
    const name = await this.#o.hubName();
    if ((confirm ?? '').trim().toLowerCase() !== name.trim().toLowerCase())
      throw new NovaError(
        'validation',
        `a sealed export carries every secret: type the Hub's name (${name}) to confirm`,
        { details: { reason: 'confirmation_mismatch', field: 'confirm' } },
      );
  }

  /** The archive as a stream; audited when it completes or fails. */
  async export(
    accountId: string,
    req: { passphrase?: string; confirm?: string },
    from: { deviceSession?: boolean } = {},
  ): Promise<AsyncGenerator<Buffer>> {
    this.assertOwner(accountId);
    if (req.passphrase !== undefined) await this.assertSealedExport(accountId, req.confirm, from);
    const encrypted = req.passphrase !== undefined;
    let done = false;
    const inner = exportArchive({
      db: this.#o.db,
      secrets: this.#o.secrets,
      dataDir: this.#o.dataDir,
      hubVersion: this.#o.hubVersion,
      ...(req.passphrase !== undefined ? { passphrase: req.passphrase } : {}),
      ...(this.#o.scrypt ? { scrypt: this.#o.scrypt } : {}),
      ...(this.#o.now ? { now: this.#o.now } : {}),
      onComplete: (manifest: ExportManifest, bytes: number) => {
        done = true;
        void this.#audit(accountId, 'data.export', 'ok', {
          encrypted,
          bytes,
          tables: manifest.tables.length,
          rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
          files: manifest.blobs.length,
          secretsIncluded: manifest.secrets?.count ?? 0,
          toReEnter: manifest.toReEnter.length,
          schemaVersion: manifest.schemaVersion,
        });
        void this.#emit(accountId, 'data.exported', {
          encrypted,
          bytes,
          tables: manifest.tables.length,
          files: manifest.blobs.length,
        });
      },
    });
    const failed = () => this.#audit(accountId, 'data.export', 'failed', { encrypted });
    return (async function* () {
      try {
        yield* inner;
      } finally {
        if (!done) await failed();
      }
    })();
  }

  // ---- delete-all ---------------------------------------------------------------------------

  async deleteAll(
    accountId: string,
    sessionId: string | null,
    confirm: string,
  ): Promise<DataDeleteResultView> {
    this.assertOwner(accountId);
    const name = await this.#o.hubName();
    if (confirm.trim().toLowerCase() !== name.trim().toLowerCase())
      throw new NovaError('validation', `type the Hub's name (${name}) to delete everything`, {
        details: { reason: 'confirmation_mismatch', field: 'confirm' },
      });
    return this.#exclusive('delete-all', async () => {
      await this.#o.quiesce?.();
      const r = await wipeHub({
        db: this.#o.db,
        secrets: this.#o.secrets,
        dataDir: this.#o.dataDir,
        ownerAccountId: accountId,
        keepSessionId: sessionId,
      });
      // A fresh data key for whatever is written before the restart (the old one is gone).
      useBlobKey(this.#o.dataDir, await loadDataKey(this.#o.secrets));
      const deletedAt = this.#now().toISOString();
      // The deletion's own entry: the first of the new audit log.
      await this.#audit(accountId, 'data.delete_all', 'ok', {
        tables: r.tables,
        rows: r.rows,
        files: r.files,
        secrets: r.secrets,
      });
      await this.#emit(accountId, 'data.deleted', {
        tables: r.tables,
        rows: r.rows,
        files: r.files,
        secrets: r.secrets,
      });
      return {
        deletedAt,
        tables: r.tables,
        rows: r.rows,
        files: r.files,
        secrets: r.secrets,
        keptPaths: r.keptPaths,
        restartRequired: true,
      };
    });
  }

  // ---- import -------------------------------------------------------------------------------

  #uploads(): string {
    return join(workDir(this.#o.dataDir), 'uploads');
  }

  #uploadPath(id: string): string {
    if (!UPLOAD_ID.test(id)) throw new NovaError('not_found', 'no such upload');
    const p = join(this.#uploads(), `${id}.novaexport`);
    if (!existsSync(p)) throw new NovaError('not_found', 'no such upload (it may have expired)');
    return p;
  }

  /** Store an archive the owner sends, for a check and an import within the hour. */
  async upload(accountId: string, body: AsyncIterable<Uint8Array>): Promise<DataImportUploadView> {
    this.assertOwner(accountId);
    this.sweepUploads();
    const max = this.#o.maxUploadBytes ?? 512 * 1024 ** 3;
    const dir = this.#uploads();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const part = join(dir, `${id}.part`);
    const fd = openSync(part, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > max)
          throw new NovaError('validation', 'the archive is too large', {
            details: { reason: 'too_large' },
          });
        writeSync(fd, chunk);
      }
    } catch (err) {
      closeSync(fd);
      rmSync(part, { force: true });
      throw err;
    }
    closeSync(fd);
    if (!bytes) {
      rmSync(part, { force: true });
      throw new NovaError('validation', 'the archive is empty', { details: { reason: 'empty' } });
    }
    const path = join(dir, `${id}.novaexport`);
    renameSync(part, path);
    return {
      uploadId: id,
      bytes,
      encrypted: isSealedFile(path),
      expiresAt: new Date(this.#now().getTime() + UPLOAD_TTL_MS).toISOString(),
    };
  }

  removeUpload(accountId: string, id: string): void {
    this.assertOwner(accountId);
    rmSync(this.#uploadPath(id), { force: true });
  }

  /** Remove uploads and staging folders older than an hour. */
  sweepUploads(): number {
    let removed = 0;
    const cutoff = this.#now().getTime() - UPLOAD_TTL_MS;
    for (const dir of [this.#uploads(), join(workDir(this.#o.dataDir), 'staging')]) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const p = join(dir, n);
        try {
          if (statSync(p).mtimeMs < cutoff) {
            rmSync(p, { recursive: true, force: true });
            removed++;
          }
        } catch {
          // gone already
        }
      }
    }
    return removed;
  }

  /** Check an uploaded archive: what it holds and whether this Hub can take it. Writes nothing. */
  async check(
    accountId: string,
    uploadId: string,
    passphrase?: string,
  ): Promise<DataImportCheckView> {
    this.assertOwner(accountId);
    const staged = await stageArchive({
      dataDir: this.#o.dataDir,
      archivePath: this.#uploadPath(uploadId),
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(this.#o.migrations ? { migrations: this.#o.migrations } : {}),
    });
    try {
      return checkView(staged, hubEmptiness(this.#o.db.raw));
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  }

  /** Import an uploaded archive into this (empty) Hub, all or nothing. */
  async import(
    accountId: string,
    sessionId: string | null,
    uploadId: string,
    passphrase?: string,
  ): Promise<DataImportResultView> {
    this.assertOwner(accountId);
    const archivePath = this.#uploadPath(uploadId);
    return this.#exclusive('import', async () => {
      const emptiness = hubEmptiness(this.#o.db.raw);
      if (!emptiness.empty)
        throw new NovaError(
          'conflict',
          'this Hub already holds data: an import goes into an empty Hub (delete all data first)',
          { details: { reason: 'hub_not_empty', tables: emptiness.blocking } },
        );
      let staged;
      try {
        staged = await stageArchive({
          dataDir: this.#o.dataDir,
          archivePath,
          ...(passphrase !== undefined ? { passphrase } : {}),
          ...(this.#o.migrations ? { migrations: this.#o.migrations } : {}),
        });
      } catch (err) {
        await this.#audit(accountId, 'data.import', 'refused', {
          reason: (err as NovaError).details?.reason ?? 'error',
        });
        throw err;
      }
      try {
        await this.#o.quiesce?.();
        const r = await applyStaged(staged, {
          db: this.#o.db,
          secrets: this.#o.secrets,
          dataDir: this.#o.dataDir,
          keepSessionId: sessionId,
        });
        const owner = r.ownerAccountId ?? accountId;
        const m = staged.manifest;
        await this.#audit(owner, 'data.import', 'ok', {
          encrypted: m.encrypted,
          exportedAt: m.createdAt,
          schemaVersion: m.schemaVersion,
          migratedFrom: staged.migratedFrom,
          tables: r.tables,
          rows: r.rows,
          files: r.files,
          secrets: r.secrets,
          keptTables: r.keptTables,
          restoredOff: staged.restoredOff,
          // What this Hub's log held before (its setup or the deletion): the chain is the archive's now.
          previousLog: r.previousAudit,
        });
        await this.#emit(owner, 'data.imported', {
          tables: r.tables,
          rows: r.rows,
          files: r.files,
          secrets: r.secrets,
        });
        rmSync(archivePath, { force: true });
        return {
          importedAt: this.#now().toISOString(),
          tables: r.tables,
          rows: r.rows,
          files: r.files,
          secrets: r.secrets,
          verified: true,
          toReEnter: m.toReEnter,
          keptTables: r.keptTables,
          restoredOff: staged.restoredOff,
          restartRequired: true,
        };
      } catch (err) {
        await this.#audit(accountId, 'data.import', 'failed', {
          reason: (err as NovaError).details?.reason ?? 'error',
        });
        throw err;
      } finally {
        rmSync(staged.dir, { recursive: true, force: true });
      }
    });
  }

  /** The Hub owner (for routes that answer before an owner exists). */
  owner(): string | null {
    return hubOwnerId(this.#o.db);
  }
}
