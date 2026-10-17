// Local project folders (FR-035). A project binds folders on the Hub; each is indexed in the
// background into the project's sources (the M2 source index, FR-040), so the project's chats
// retrieve passages from its files, and it becomes a tool root for those chats (roots.ts).
// Indexing walks the folder without following symlinks, skips version-control, dependency and
// build folders, the top-level `.gitignore` patterns, protected and credential paths (docs/12
// §7.2), binaries and files over 20 MB, and stops at 5,000 files. Each indexed file is a
// file-backed source: its chunks are in `source_chunk`, its bytes stay in the folder. A re-index
// re-reads only files whose size or modification time changed.
import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type ProjectFolderView,
  type addProjectFolderSchema,
} from '@nova/shared';
import { isWithin, realpathLenient } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { chunkText } from '../sources.ts';
import { isCredentialPath, isCredentialRel, isProtectedRel } from '../tools/roots.ts';
import { BINARY_EXTENSIONS, IGNORED_DIRS, IgnoreRules, decodeText, mimeOf } from './common.ts';
import { sha256 } from '../tools/text.ts';

export type AddProjectFolderRequest = z.input<typeof addProjectFolderSchema>;

export const FOLDER_LIMITS = {
  /** Larger files are not indexed (the source size limit, FR-040). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Files indexed per folder; the walk stops after this many. */
  maxFiles: 5_000,
  maxFoldersPerProject: 20,
} as const;

export interface ProjectFolderServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  /** The Hub data directory: never a project folder, nor inside or around one. */
  dataDir: string;
  /** The Hub user's home directory (`~` expansion; never a project folder itself). */
  home?: string | null;
  limits?: Partial<{ maxFileBytes: number; maxFiles: number; maxFoldersPerProject: number }>;
  log?: Logger;
  now?: () => Date;
}

interface FolderRow {
  id: string;
  projectId: string;
  accountId: string;
  path: string;
  access: 'read' | 'write';
  indexStatus: 'pending' | 'indexing' | 'ready' | 'error';
  fileCount: number;
  error: string | null;
  lastIndexedAt: string | null;
}

interface WalkFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

interface IndexedFile {
  sourceId: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  status: string;
}

const FOLDER_COLUMNS = `f.id AS id, f.project_id AS projectId, p.account_id AS accountId,
  f.path AS path, f.access AS access, f.index_status AS indexStatus, f.file_count AS fileCount,
  f.error AS error, f.last_indexed_at AS lastIndexedAt`;

export class ProjectFolderService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #home: string | null;
  readonly #limits: { maxFileBytes: number; maxFiles: number; maxFoldersPerProject: number };
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #queue: string[] = [];
  #worker: Promise<void> | null = null;
  #stopped = false;

  constructor(opts: ProjectFolderServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#home = opts.home === undefined ? homedir() : opts.home;
    this.#limits = { ...FOLDER_LIMITS, ...opts.limits };
    this.#log = opts.log ?? new Logger({ module: 'core.folders', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
  }

  list(accountId: string, projectId: string): Promise<ProjectFolderView[]> {
    return attempt(() => {
      this.#assertProject(accountId, projectId);
      const rows = this.#db.raw
        .prepare(
          `SELECT ${FOLDER_COLUMNS} FROM project_folder f JOIN project p ON p.id = f.project_id
           WHERE f.project_id = ? ORDER BY f.created_at, f.id`,
        )
        .all(projectId) as unknown as FolderRow[];
      return rows.map(toFolderView);
    });
  }

  get(accountId: string, projectId: string, folderId: string): Promise<ProjectFolderView> {
    return attempt(() => toFolderView(this.#row(accountId, projectId, folderId)));
  }

  /** Bind a folder and start indexing it; the view comes back as `indexing`. */
  async add(
    accountId: string,
    projectId: string,
    req: AddProjectFolderRequest,
  ): Promise<ProjectFolderView> {
    this.#assertProject(accountId, projectId);
    const path = await this.#checkPath(req.path);
    const now = this.#now().toISOString();
    const id = uuidv7();
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      const count = raw
        .prepare('SELECT count(*) AS n FROM project_folder WHERE project_id = ?')
        .get(projectId) as { n: number };
      if (count.n >= this.#limits.maxFoldersPerProject)
        throw new NovaError(
          'validation',
          `a project can have at most ${this.#limits.maxFoldersPerProject} folders`,
          { details: { reason: 'too_many_folders' } },
        );
      if (
        raw
          .prepare('SELECT 1 AS x FROM project_folder WHERE project_id = ? AND path = ?')
          .get(projectId, path)
      )
        throw new NovaError('conflict', 'this folder is already part of the project', {
          details: { reason: 'duplicate' },
        });
      raw
        .prepare(
          `INSERT INTO project_folder (id, project_id, path, access, index_status, file_count,
             created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(id, projectId, path, req.access ?? 'read', now, now);
      raw.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(now, projectId);
    });
    this.#enqueue(id);
    return toFolderView(this.#row(accountId, projectId, id));
  }

  /** Index the folder again (new, changed and removed files). */
  async reindex(
    accountId: string,
    projectId: string,
    folderId: string,
  ): Promise<ProjectFolderView> {
    this.#row(accountId, projectId, folderId);
    const now = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare("UPDATE project_folder SET index_status = 'pending', updated_at = ? WHERE id = ?")
        .run(now, folderId),
    );
    this.#enqueue(folderId);
    return toFolderView(this.#row(accountId, projectId, folderId));
  }

  /** Unbind a folder: its sources leave retrieval at once; the files on disk are untouched. */
  async remove(accountId: string, projectId: string, folderId: string): Promise<void> {
    this.#row(accountId, projectId, folderId);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      raw
        .prepare(
          `DELETE FROM source_chunk WHERE source_id IN
             (SELECT source_id FROM project_folder_file WHERE folder_id = ?)`,
        )
        .run(folderId);
      raw
        .prepare(
          `UPDATE source SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND id IN
             (SELECT source_id FROM project_folder_file WHERE folder_id = ?)`,
        )
        .run(now, now, folderId);
      raw.prepare('DELETE FROM project_folder_file WHERE folder_id = ?').run(folderId);
      raw.prepare('DELETE FROM project_folder WHERE id = ?').run(folderId);
      raw.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(now, projectId);
    });
  }

  /** Re-queue folders left pending or indexing by a restart. */
  async recover(): Promise<number> {
    const rows = await this.#db.transaction(() => {
      const ids = this.#db.raw
        .prepare(
          `SELECT f.id AS id FROM project_folder f JOIN project p ON p.id = f.project_id
           WHERE f.index_status IN ('pending', 'indexing') AND p.deleted_at IS NULL
           ORDER BY f.created_at, f.id`,
        )
        .all() as { id: string }[];
      this.#db.raw
        .prepare(
          "UPDATE project_folder SET index_status = 'pending' WHERE index_status = 'indexing'",
        )
        .run();
      return ids;
    });
    for (const r of rows) this.#enqueue(r.id);
    return rows.length;
  }

  /** Wait until the indexing queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  /** Stop taking work; the folder being indexed stops at its next file. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queue.length = 0;
    await this.idle();
  }

  // ---- adding -------------------------------------------------------------------------------

  /**
   * The canonical path of a folder that may be bound: it exists, is a folder, and is not the
   * filesystem root, the home folder or one of its ancestors, the Nova data folder (or inside
   * or around it), or a credential location (docs/12 §7.2).
   */
  async #checkPath(input: string): Promise<string> {
    let p = input.trim();
    if (this.#home && (p === '~' || p.startsWith('~/'))) p = `${this.#home}${p.slice(1)}`;
    if (!isAbsolute(p))
      throw new NovaError('validation', 'use the full path of a folder on the Hub');
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      throw new NovaError('validation', `no folder at ${p}`, { details: { reason: 'missing' } });
    }
    if (!(await stat(real)).isDirectory())
      throw new NovaError('validation', `${p} is not a folder`, {
        details: { reason: 'not_a_folder' },
      });
    const refuse = (message: string) =>
      new NovaError('policy_denied', message, { details: { reason: 'protected_folder' } });
    if (dirname(real) === real) throw refuse('the whole filesystem cannot be a project folder');
    const data = realpathLenient(this.#dataDir);
    if (isWithin(data, real) || isWithin(real, data))
      throw refuse('the Nova data folder, or a folder containing it, cannot be a project folder');
    if (this.#home && isWithin(real, realpathLenient(this.#home)))
      throw refuse('your home folder cannot be a project folder; add a folder inside it');
    if (isCredentialPath(real)) throw refuse('credential folders cannot be project folders');
    return real;
  }

  // ---- indexing -----------------------------------------------------------------------------

  #enqueue(id: string): void {
    if (this.#stopped) return;
    if (!this.#queue.includes(id)) this.#queue.push(id);
    if (this.#worker) return;
    this.#worker = this.#drain().finally(() => {
      this.#worker = null;
    });
  }

  async #drain(): Promise<void> {
    for (let id = this.#queue.shift(); id; id = this.#queue.shift()) {
      try {
        await this.#index(id);
      } catch (err) {
        this.#log.warn('folder indexing failed', { err, folderId: id });
        await this.#finish(id, null, null, 'Indexing failed').catch(() => undefined);
      }
    }
  }

  async #index(id: string): Promise<void> {
    const stamp = this.#now().toISOString();
    const claimed = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare(
            `UPDATE project_folder SET index_status = 'indexing', updated_at = ?
             WHERE id = ? AND index_status = 'pending'`,
          )
          .run(stamp, id).changes,
    );
    if (!claimed) return;
    const folder = this.#db.raw
      .prepare(
        `SELECT ${FOLDER_COLUMNS} FROM project_folder f JOIN project p ON p.id = f.project_id
         WHERE f.id = ? AND p.deleted_at IS NULL`,
      )
      .get(id) as unknown as FolderRow | undefined;
    if (!folder) return;

    let walked: Awaited<ReturnType<ProjectFolderService['walk']>>;
    try {
      if (!(await stat(folder.path)).isDirectory()) throw new Error('not a folder');
      walked = await this.walk(folder.path);
    } catch {
      await this.#finish(id, stamp, null, 'The folder is missing or cannot be read');
      return;
    }
    const known = new Map(
      (
        this.#db.raw
          .prepare(
            `SELECT f.rel_path AS rel, f.source_id AS sourceId, f.size AS size, f.mtime_ms AS mtimeMs,
               f.sha256 AS sha256, s.status AS status
             FROM project_folder_file f JOIN source s ON s.id = f.source_id WHERE f.folder_id = ?`,
          )
          .all(id) as unknown as (IndexedFile & { rel: string })[]
      ).map((r) => [r.rel, r]),
    );
    const label = basename(folder.path) || folder.path;
    const indexed = new Set<string>();
    for (const file of walked.files) {
      if (this.#stopped) return;
      const r = await this.#indexFile(folder, label, file, known.get(file.rel));
      if (r === 'gone') return;
      if (r === 'indexed') indexed.add(file.rel);
    }
    const stale = [...known.entries()].filter(([rel]) => !indexed.has(rel));
    if (stale.length) {
      const now = this.#now().toISOString();
      const ok = await this.#db.transaction(() => {
        if (!this.#exists(id)) return false;
        for (const [rel, f] of stale) this.#dropFile(id, rel, f.sourceId, now);
        return true;
      });
      if (!ok) return;
    }
    const notes: string[] = [];
    if (walked.capped)
      notes.push(
        `Only the first ${this.#limits.maxFiles.toLocaleString('en-US')} files were indexed`,
      );
    if (walked.tooLarge)
      notes.push(
        `${walked.tooLarge} file${walked.tooLarge === 1 ? ' is' : 's are'} larger than ${sizeLabel(this.#limits.maxFileBytes)} and not indexed`,
      );
    await this.#finish(id, stamp, indexed.size, null, notes.length ? `${notes.join('; ')}.` : null);
  }

  /**
   * The files a folder index covers, in a stable order (exposed for tests). Symlinks are never
   * followed, so every file is inside the folder.
   */
  async walk(root: string): Promise<{ files: WalkFile[]; capped: boolean; tooLarge: number }> {
    let rules = new IgnoreRules('');
    try {
      rules = new IgnoreRules(await readFile(join(root, '.gitignore'), 'utf8'));
    } catch {
      // no .gitignore
    }
    const data = realpathLenient(this.#dataDir);
    const files: WalkFile[] = [];
    let tooLarge = 0;
    const stack: string[] = [''];
    while (stack.length) {
      const dirRel = stack.pop()!;
      const dirAbs = dirRel ? join(root, dirRel) : root;
      let entries;
      try {
        entries = await readdir(dirAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs: string[] = [];
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        const parts = rel.split('/');
        if (e.isSymbolicLink()) continue;
        if (isCredentialRel(parts) || isProtectedRel(parts)) continue;
        const abs = join(dirAbs, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || rules.ignores(rel, true) || isWithin(data, abs)) continue;
          subdirs.push(rel);
          continue;
        }
        if (!e.isFile() || rules.ignores(rel, false)) continue;
        if (BINARY_EXTENSIONS.has(extname(e.name).toLowerCase())) continue;
        let st;
        try {
          st = await stat(abs);
        } catch {
          continue;
        }
        if (st.size > this.#limits.maxFileBytes) {
          tooLarge++;
          continue;
        }
        files.push({ rel, abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        if (files.length >= this.#limits.maxFiles) return { files, capped: true, tooLarge };
      }
      // Depth first, in name order.
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
    }
    return { files, capped: false, tooLarge };
  }

  async #indexFile(
    folder: FolderRow,
    label: string,
    file: WalkFile,
    prev: IndexedFile | undefined,
  ): Promise<'indexed' | 'skipped' | 'gone'> {
    if (prev && prev.status === 'ready' && prev.size === file.size && prev.mtimeMs === file.mtimeMs)
      return 'indexed';
    let bytes: Buffer;
    try {
      bytes = await readFile(file.abs);
    } catch {
      return 'skipped';
    }
    const text = decodeText(bytes);
    if (text === null) return 'skipped';
    const hash = sha256(bytes);
    const now = this.#now().toISOString();
    const raw = this.#db.raw;
    const ok = await this.#db.transaction(() => {
      if (!this.#exists(folder.id)) return false;
      if (prev && prev.status === 'ready' && prev.sha256 === hash) {
        raw
          .prepare(
            'UPDATE project_folder_file SET size = ?, mtime_ms = ? WHERE folder_id = ? AND rel_path = ?',
          )
          .run(bytes.length, file.mtimeMs, folder.id, file.rel);
        return true;
      }
      const chunks = chunkText(text);
      const mime = mimeOf(file.rel, true);
      let sourceId = prev?.sourceId;
      if (sourceId) {
        raw.prepare('DELETE FROM source_chunk WHERE source_id = ?').run(sourceId);
        raw
          .prepare(
            `UPDATE source SET mime = ?, size = ?, sha256 = ?, status = 'ready', error = NULL,
               chunk_count = ?, indexed_at = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`,
          )
          .run(mime, bytes.length, hash, chunks.length, now, now, sourceId);
        raw
          .prepare(
            `UPDATE project_folder_file SET size = ?, mtime_ms = ?, sha256 = ?
             WHERE folder_id = ? AND rel_path = ?`,
          )
          .run(bytes.length, file.mtimeMs, hash, folder.id, file.rel);
      } else {
        sourceId = uuidv7();
        // A file-backed source: its bytes stay in the folder, so `blob_path` names the file
        // rather than a blob (it never matches a blob path, docs/06 §3).
        raw
          .prepare(
            `INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path,
               status, error, chunk_count, indexed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?)`,
          )
          .run(
            sourceId,
            folder.accountId,
            folder.projectId,
            `${label}/${file.rel}`,
            mime,
            bytes.length,
            hash,
            `folder:${folder.id}/${file.rel}`,
            chunks.length,
            now,
            now,
            now,
          );
        raw
          .prepare(
            `INSERT INTO project_folder_file (folder_id, rel_path, source_id, size, mtime_ms, sha256)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(folder.id, file.rel, sourceId, bytes.length, file.mtimeMs, hash);
      }
      const insert = raw.prepare(
        'INSERT INTO source_chunk (source_id, idx, text, created_at) VALUES (?, ?, ?, ?)',
      );
      chunks.forEach((c, i) => insert.run(sourceId, i, c, now));
      return true;
    });
    return ok ? 'indexed' : 'gone';
  }

  #dropFile(folderId: string, rel: string, sourceId: string, now: string): void {
    const raw = this.#db.raw;
    raw.prepare('DELETE FROM source_chunk WHERE source_id = ?').run(sourceId);
    raw
      .prepare(
        'UPDATE source SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
      .run(now, now, sourceId);
    raw
      .prepare('DELETE FROM project_folder_file WHERE folder_id = ? AND rel_path = ?')
      .run(folderId, rel);
  }

  /**
   * Record the result unless a re-index restarted the work meanwhile; then announce it. A null
   * `count` counts the files still indexed (a failed run keeps the previous index).
   */
  async #finish(
    id: string,
    stamp: string | null,
    count: number | null,
    error: string | null,
    note: string | null = null,
  ): Promise<void> {
    const now = this.#now().toISOString();
    const status = error ? 'error' : 'ready';
    const fileCount =
      count ??
      (
        this.#db.raw
          .prepare('SELECT count(*) AS n FROM project_folder_file WHERE folder_id = ?')
          .get(id) as { n: number }
      ).n;
    const applied = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare(
            `UPDATE project_folder SET index_status = ?, file_count = ?, error = ?,
               last_indexed_at = CASE WHEN ? = 'ready' THEN ? ELSE last_indexed_at END, updated_at = ?
             WHERE id = ? AND index_status = 'indexing' AND (? IS NULL OR updated_at = ?)`,
          )
          .run(status, fileCount, error ?? note, status, now, now, id, stamp, stamp).changes,
    );
    if (!applied) return;
    const row = this.#db.raw
      .prepare(
        `SELECT f.project_id AS projectId, p.account_id AS accountId FROM project_folder f
         JOIN project p ON p.id = f.project_id WHERE f.id = ?`,
      )
      .get(id) as { projectId: string; accountId: string } | undefined;
    if (!row) return;
    const payload: Record<string, unknown> = {
      projectId: row.projectId,
      folderId: id,
      fileCount,
      status,
    };
    if (error) payload.error = error;
    await this.#events.emit({ name: 'project.folder.indexed', accountId: row.accountId, payload });
  }

  #exists(folderId: string): boolean {
    return !!this.#db.raw.prepare('SELECT 1 AS x FROM project_folder WHERE id = ?').get(folderId);
  }

  #assertProject(accountId: string, projectId: string): void {
    const row = this.#db.raw
      .prepare('SELECT 1 AS x FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(projectId, accountId);
    if (!row) throw new NovaError('not_found', 'project not found');
  }

  #row(accountId: string, projectId: string, folderId: string): FolderRow {
    this.#assertProject(accountId, projectId);
    const row = this.#db.raw
      .prepare(
        `SELECT ${FOLDER_COLUMNS} FROM project_folder f JOIN project p ON p.id = f.project_id
         WHERE f.id = ? AND f.project_id = ?`,
      )
      .get(folderId, projectId) as unknown as FolderRow | undefined;
    if (!row) throw new NovaError('not_found', 'folder not found');
    return row;
  }
}

/** Run synchronous work as a promise, so a throw becomes a rejection. */
function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function toFolderView(r: FolderRow): ProjectFolderView {
  return {
    id: r.id,
    projectId: r.projectId,
    path: r.path,
    access: r.access,
    status: r.indexStatus === 'ready' ? 'ready' : r.indexStatus === 'error' ? 'error' : 'indexing',
    fileCount: r.fileCount,
    error: r.error,
    indexedAt: r.lastIndexedAt,
  };
}
