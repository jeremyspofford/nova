// Sites (FR-037): generate a static site from a space's pages or one artifact, keep every build as
// a version (a zip blob, encrypted at rest like other blobs), preview it sandboxed, connect JSON or
// CSV project sources as data, and publish a chosen version to a target. Publishing is explicit
// (the route demands `confirm`) and reversible: every publish is recorded, and unpublish reverts
// the live one so the previous publish is live again. M6 targets are a folder under the publish
// root and a zip download; remote hosting targets come later.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  NovaError,
  uuidv7,
  type SiteDataConnection,
  type SiteDataSourceView,
  type SitePublishView,
  type SiteSource,
  type SiteTarget,
  type SiteVersionView,
  type SiteView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { readAttachmentBlob, writeAttachmentBlob } from '../attachments.ts';
import type { EventSink } from '../events.ts';
import type { ArtifactService } from '../tools/artifacts.ts';
import { noopAudit, type AuditSink } from '../tools/types.ts';
import { dataFormatOf, parseData, type DataRow } from './data.ts';
import type { SpaceService } from './service.ts';
import { renderArtifactSite, renderSpaceSite, type RenderedSite } from './site-render.ts';

/** The marker a published folder carries, so Nova only ever replaces or removes its own. */
export const SITE_MARKER = '.nova-site';
const MAX_PAGES = 200;

export interface SiteServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  dataDir: string;
  spaces: SpaceService;
  artifacts: ArtifactService;
  audit?: AuditSink;
  now?: () => Date;
  /** The folder site folders go into (setting `sites.publishRoot`); null uses <dataDir>/sites. */
  publishRoot?: () => Promise<string | null>;
}

interface SiteRow {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  source_kind: 'space' | 'artifact';
  source_ref: string;
  data_json: string;
  latest_version: number | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  site_id: string;
  version: number;
  note: string | null;
  blob_path: string;
  sha256: string;
  size: number;
  files_json: string;
  preview_blob_path: string;
  scripts: number;
  created_at: string;
}

interface PublishRow {
  id: string;
  site_id: string;
  account_id: string;
  version: number;
  target_kind: 'folder' | 'zip';
  target_ref: string | null;
  reverted_at: string | null;
  created_at: string;
}

export interface SiteInput {
  name: string;
  description?: string | null | undefined;
  source: SiteSource;
  data?: SiteDataConnection[] | undefined;
}

export interface PublishOutcome {
  site: SiteView;
  publish: SitePublishView | null;
  /** The folder written for a folder target. */
  folderPath: string | null;
}

export class SiteService {
  readonly #o: SiteServiceOptions;
  #audit: AuditSink;
  readonly #now: () => Date;

  constructor(opts: SiteServiceOptions) {
    this.#o = opts;
    this.#audit = opts.audit ?? noopAudit;
    this.#now = opts.now ?? (() => new Date());
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  list(accountId: string): Promise<SiteView[]> {
    return this.#sync(() => {
      const rows = this.#all<SiteRow>(
        'SELECT * FROM site WHERE account_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id',
        accountId,
      );
      return rows.map((r) => this.#view(r));
    });
  }

  /** JSON and CSV sources of the account's projects, which a site can connect. */
  dataSources(accountId: string): Promise<SiteDataSourceView[]> {
    return this.#sync(() => {
      const rows = this.#all<{
        id: string;
        name: string;
        mime: string;
        size: number;
        project_id: string;
        project_name: string;
      }>(
        `SELECT s.id, s.name, s.mime, s.size, s.project_id, p.name AS project_name FROM source s
         JOIN project p ON p.id = s.project_id
         WHERE s.account_id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.name, s.name`,
        accountId,
      );
      return rows
        .filter((r) => dataFormatOf(r.name, r.mime) !== null)
        .map((r) => ({
          id: r.id,
          name: r.name,
          mime: r.mime,
          size: r.size,
          projectId: r.project_id,
          projectName: r.project_name,
        }));
    });
  }

  async create(accountId: string, input: SiteInput): Promise<SiteView> {
    await this.#checkSource(accountId, input.source);
    const data = input.data ?? [];
    this.#checkData(accountId, data);
    const id = uuidv7();
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        `INSERT INTO site (id, account_id, name, description, source_kind, source_ref, data_json,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        accountId,
        input.name.trim(),
        input.description ?? null,
        input.source.kind,
        input.source.kind === 'space' ? input.source.spaceId : input.source.artifactId,
        JSON.stringify(data),
        now,
        now,
      );
    });
    await this.#emit('site.created', accountId, { siteId: id });
    return this.get(accountId, id);
  }

  get(accountId: string, id: string): Promise<SiteView> {
    return this.#sync(() => {
      return this.#view(this.#site(accountId, id));
    });
  }

  async update(accountId: string, id: string, patch: Partial<SiteInput>): Promise<SiteView> {
    const row = this.#site(accountId, id);
    if (patch.source) await this.#checkSource(accountId, patch.source);
    if (patch.data) this.#checkData(accountId, patch.data);
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        `UPDATE site SET name = ?, description = ?, source_kind = ?, source_ref = ?, data_json = ?,
           updated_at = ? WHERE id = ?`,
        patch.name?.trim() ?? row.name,
        patch.description === undefined ? row.description : patch.description,
        patch.source?.kind ?? row.source_kind,
        patch.source
          ? patch.source.kind === 'space'
            ? patch.source.spaceId
            : patch.source.artifactId
          : row.source_ref,
        patch.data ? JSON.stringify(patch.data) : row.data_json,
        now,
        id,
      );
    });
    await this.#emit('site.updated', accountId, { siteId: id });
    return this.get(accountId, id);
  }

  /** Delete a site that is not published (unpublish first, so nothing is left behind). */
  async delete(accountId: string, id: string): Promise<void> {
    const row = this.#site(accountId, id);
    if (this.#live(id))
      throw new NovaError('conflict', 'unpublish this site before deleting it', {
        details: { reason: 'published' },
      });
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run('UPDATE site SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.deleted',
      resource: `site:${id}`,
      result: 'ok',
      detail: { name: row.name },
    });
    await this.#emit('site.deleted', accountId, { siteId: id });
  }

  // ---- versions ----------------------------------------------------------------------------------

  /** Generate a new version from the source as it is now. */
  async build(
    accountId: string,
    id: string,
    input: { note?: string | undefined } = {},
  ): Promise<SiteVersionView> {
    const row = this.#site(accountId, id);
    const data = this.#loadData(accountId, parseConnections(row.data_json));
    const rendered = await this.#render(accountId, row, data);
    const zippable: Zippable = {};
    const files: { path: string; size: number }[] = [];
    for (const [path, bytes] of [...rendered.files].sort(([a], [b]) => a.localeCompare(b))) {
      zippable[path] = new Uint8Array(bytes);
      files.push({ path, size: bytes.length });
    }
    // A fixed timestamp keeps the zip of the same content byte-identical.
    const zip = Buffer.from(
      zipSync(zippable, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }),
    );
    const blob = writeAttachmentBlob(this.#o.dataDir, zip);
    const preview = writeAttachmentBlob(this.#o.dataDir, Buffer.from(strToU8(rendered.preview)));
    const now = this.#stamp();
    const version = await this.#o.db.transaction(() => {
      const cur = this.#get<{ v: number | null }>(
        'SELECT max(version) AS v FROM site_version WHERE site_id = ?',
        id,
      );
      const v = (cur?.v ?? 0) + 1;
      this.#run(
        `INSERT INTO site_version (site_id, version, note, blob_path, sha256, size, files_json,
           preview_blob_path, scripts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        v,
        input.note?.trim() || null,
        blob.blobPath,
        blob.sha256,
        zip.length,
        JSON.stringify(files),
        preview.blobPath,
        rendered.scripts ? 1 : 0,
        now,
      );
      this.#run('UPDATE site SET latest_version = ?, updated_at = ? WHERE id = ?', v, now, id);
      return v;
    });
    await this.#emit('site.version.created', accountId, { siteId: id, version });
    return this.#versionView(this.#version(id, version), this.#live(id));
  }

  versions(accountId: string, id: string): Promise<SiteVersionView[]> {
    return this.#sync(() => {
      this.#site(accountId, id);
      const live = this.#live(id);
      return this.#all<VersionRow>(
        'SELECT * FROM site_version WHERE site_id = ? ORDER BY version DESC',
        id,
      ).map((r) => this.#versionView(r, live));
    });
  }

  /** A version's one-document preview, and whether it may run its own scripts. */
  preview(
    accountId: string,
    id: string,
    version: number,
  ): Promise<{ html: Buffer; scripts: boolean }> {
    return this.#sync(() => {
      this.#site(accountId, id);
      const v = this.#version(id, version);
      return {
        html: readAttachmentBlob(this.#o.dataDir, v.preview_blob_path),
        scripts: v.scripts === 1,
      };
    });
  }

  /** A version's files as a zip, and a file name for the download. */
  zip(accountId: string, id: string, version: number): Promise<{ bytes: Buffer; name: string }> {
    return this.#sync(() => {
      const row = this.#site(accountId, id);
      const v = this.#version(id, version);
      return {
        bytes: readAttachmentBlob(this.#o.dataDir, v.blob_path),
        name: `${fileSafe(row.name)}-v${version}.zip`,
      };
    });
  }

  // ---- publishing --------------------------------------------------------------------------------

  publishes(accountId: string, id: string): Promise<SitePublishView[]> {
    return this.#sync(() => {
      this.#site(accountId, id);
      const live = this.#live(id);
      return this.#all<PublishRow>(
        'SELECT * FROM site_publish WHERE site_id = ? ORDER BY created_at DESC, rowid DESC',
        id,
      ).map((r) => publishView(r, live?.id === r.id));
    });
  }

  /**
   * Publish a version to a target (an earlier version is a rollback). The caller has the user's
   * explicit confirmation. A folder is replaced atomically and only when Nova made it.
   */
  async publish(
    accountId: string,
    id: string,
    input: { version: number; target: SiteTarget },
  ): Promise<PublishOutcome> {
    const row = this.#site(accountId, id);
    const v = this.#version(id, input.version);
    const prev = this.#live(id);
    let folderPath: string | null = null;
    if (input.target.kind === 'folder') {
      folderPath = await this.#writeFolder(id, input.target.folder, v);
    }
    // Moving to another folder takes the site out of the old one (unpublish puts it back).
    if (
      prev?.target_kind === 'folder' &&
      prev.target_ref &&
      !(input.target.kind === 'folder' && input.target.folder === prev.target_ref)
    )
      await this.#removeFolder(id, prev.target_ref);
    const pid = uuidv7();
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        `INSERT INTO site_publish (id, site_id, account_id, version, target_kind, target_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        pid,
        id,
        accountId,
        input.version,
        input.target.kind,
        input.target.kind === 'folder' ? input.target.folder : null,
        now,
      );
      this.#run('UPDATE site SET updated_at = ? WHERE id = ?', now, id);
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.published',
      resource: folderPath ?? `site:${id}`,
      decision: 'allow',
      result: 'ok',
      detail: {
        siteId: id,
        name: row.name,
        version: input.version,
        target: input.target.kind,
        previousVersion: prev?.version ?? null,
      },
    });
    await this.#emit('site.published', accountId, {
      siteId: id,
      version: input.version,
      target: input.target,
    });
    const publish = this.#get<PublishRow>('SELECT * FROM site_publish WHERE id = ?', pid);
    return {
      site: await this.get(accountId, id),
      publish: publish ? publishView(publish, true) : null,
      folderPath,
    };
  }

  /** Undo the live publish: the previous publish is live again, or nothing is published. */
  async unpublish(accountId: string, id: string): Promise<PublishOutcome> {
    const row = this.#site(accountId, id);
    const live = this.#live(id);
    if (!live)
      throw new NovaError('conflict', 'this site is not published', {
        details: { reason: 'not_published' },
      });
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run('UPDATE site_publish SET reverted_at = ? WHERE id = ?', now, live.id);
      this.#run('UPDATE site SET updated_at = ? WHERE id = ?', now, id);
    });
    const back = this.#live(id);
    let folderPath: string | null = null;
    if (
      live.target_kind === 'folder' &&
      live.target_ref &&
      !(back?.target_kind === 'folder' && back.target_ref === live.target_ref)
    )
      await this.#removeFolder(id, live.target_ref);
    if (back?.target_kind === 'folder' && back.target_ref)
      folderPath = await this.#writeFolder(id, back.target_ref, this.#version(id, back.version));
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.unpublished',
      resource: `site:${id}`,
      decision: 'allow',
      result: 'ok',
      detail: {
        siteId: id,
        name: row.name,
        version: live.version,
        restoredVersion: back?.version ?? null,
      },
    });
    await this.#emit('site.unpublished', accountId, { siteId: id, version: back?.version ?? null });
    return {
      site: await this.get(accountId, id),
      publish: back ? publishView(back, true) : null,
      folderPath,
    };
  }

  /** Where folder targets are written. */
  async publishRoot(): Promise<string> {
    const configured = this.#o.publishRoot ? await this.#o.publishRoot() : null;
    return resolve(configured ?? join(this.#o.dataDir, 'sites'));
  }

  // ---- internals ---------------------------------------------------------------------------------

  async #folder(folder: string): Promise<{ root: string; dir: string }> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(folder))
      throw new NovaError('validation', 'not a folder name');
    const root = await this.publishRoot();
    const dir = resolve(root, folder);
    if (!dir.startsWith(root + sep)) throw new NovaError('validation', 'not a folder name');
    return { root, dir };
  }

  /** Whether `dir` is free or Nova's folder for this site; anything else is refused. */
  #claim(siteId: string, dir: string): boolean {
    if (!existsSync(dir)) return false;
    const st = lstatSync(dir);
    const mine =
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      existsSync(join(dir, SITE_MARKER)) &&
      readFileSync(join(dir, SITE_MARKER), 'utf8').trim() === siteId;
    if (!mine)
      throw new NovaError(
        'conflict',
        'that folder already holds something Nova did not publish there',
        {
          details: { reason: 'folder_in_use' },
        },
      );
    return true;
  }

  async #writeFolder(siteId: string, folder: string, v: VersionRow): Promise<string> {
    const { root, dir } = await this.#folder(folder);
    mkdirSync(root, { recursive: true });
    const exists = this.#claim(siteId, dir);
    const files = unzipSync(new Uint8Array(readAttachmentBlob(this.#o.dataDir, v.blob_path)));
    const tmp = join(root, `.${folder}.tmp-${randomUUID()}`);
    try {
      mkdirSync(tmp, { recursive: true });
      for (const [path, bytes] of Object.entries(files)) {
        const target = resolve(tmp, path);
        // Paths come from Nova's own zip; still, nothing may land outside the folder.
        if (!target.startsWith(tmp + sep) || path.endsWith('/')) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      writeFileSync(join(tmp, SITE_MARKER), `${siteId}\n`);
      // Swap: the old folder moves aside, the new one takes its name, the old one goes.
      const old = join(root, `.${folder}.old-${randomUUID()}`);
      if (exists) renameSync(dir, old);
      renameSync(tmp, dir);
      if (exists) rmSync(old, { recursive: true, force: true });
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    return dir;
  }

  async #removeFolder(siteId: string, folder: string): Promise<void> {
    const { dir } = await this.#folder(folder);
    try {
      if (this.#claim(siteId, dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Someone else's folder by now: leave it alone.
      if (!(err instanceof NovaError)) throw err;
    }
  }

  async #render(
    accountId: string,
    row: SiteRow,
    data: Record<string, DataRow[]>,
  ): Promise<RenderedSite> {
    if (row.source_kind === 'space') {
      const space = await this.#o.spaces.getSpace(accountId, row.source_ref).catch(() => {
        throw new NovaError('not_found', 'the space this site is built from is gone', {
          details: { reason: 'source_missing' },
        });
      });
      const list = (await this.#o.spaces.listPages(accountId, space.id)).slice(0, MAX_PAGES);
      const pages = await Promise.all(
        list.map((p) => this.#o.spaces.getPage(accountId, space.id, p.id)),
      );
      return renderSpaceSite({
        name: row.name,
        description: row.description,
        pages: pages.map((p) => ({ slug: p.slug, title: p.title, content: p.content })),
        data,
      });
    }
    const art = await this.#artifact(accountId, row.source_ref);
    return renderArtifactSite({
      name: row.name,
      description: row.description,
      kind: art.kind,
      content: art.text,
      data,
    });
  }

  async #artifact(
    accountId: string,
    artifactId: string,
  ): Promise<{ kind: 'html' | 'markdown'; text: string; title: string | null }> {
    let got: Awaited<ReturnType<ArtifactService['content']>>;
    try {
      got = await this.#o.artifacts.content(accountId, artifactId);
    } catch {
      throw new NovaError('not_found', 'the artifact this site is built from is gone', {
        details: { reason: 'source_missing' },
      });
    }
    const kind = got.view.kind;
    if (kind !== 'html' && kind !== 'markdown')
      throw new NovaError('validation', 'a site can be built from an HTML or Markdown artifact', {
        details: { reason: 'source_kind' },
      });
    return { kind, text: got.bytes.toString('utf8'), title: got.view.title };
  }

  async #checkSource(accountId: string, source: SiteSource): Promise<void> {
    if (source.kind === 'space') await this.#o.spaces.getSpace(accountId, source.spaceId);
    else await this.#artifact(accountId, source.artifactId);
  }

  #checkData(accountId: string, data: SiteDataConnection[]): void {
    for (const d of data) {
      const s = this.#get<{ name: string; mime: string }>(
        'SELECT name, mime FROM source WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        d.sourceId,
        accountId,
      );
      if (!s) throw new NovaError('not_found', `data source ${d.name} not found`);
      if (!dataFormatOf(s.name, s.mime))
        throw new NovaError('validation', `${s.name} is not JSON or CSV`, {
          details: { reason: 'data_format' },
        });
    }
  }

  #loadData(accountId: string, data: SiteDataConnection[]): Record<string, DataRow[]> {
    const out: Record<string, DataRow[]> = {};
    for (const d of data) {
      const s = this.#get<{ name: string; mime: string; blob_path: string }>(
        'SELECT name, mime, blob_path FROM source WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        d.sourceId,
        accountId,
      );
      if (!s)
        throw new NovaError(
          'not_found',
          `the data source ${d.name} is gone; remove it from the site`,
          {
            details: { reason: 'data_missing', name: d.name },
          },
        );
      const format = dataFormatOf(s.name, s.mime);
      if (!format)
        throw new NovaError('validation', `${s.name} is not JSON or CSV`, {
          details: { reason: 'data_format' },
        });
      out[d.name] = parseData(readAttachmentBlob(this.#o.dataDir, s.blob_path), format);
    }
    return out;
  }

  #live(siteId: string): PublishRow | undefined {
    return this.#get<PublishRow>(
      'SELECT * FROM site_publish WHERE site_id = ? AND reverted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
      siteId,
    );
  }

  #site(accountId: string, id: string): SiteRow {
    const r = this.#get<SiteRow>(
      'SELECT * FROM site WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
      id,
      accountId,
    );
    if (!r) throw new NovaError('not_found', 'site not found');
    return r;
  }

  #version(siteId: string, version: number): VersionRow {
    const r = this.#get<VersionRow>(
      'SELECT * FROM site_version WHERE site_id = ? AND version = ?',
      siteId,
      version,
    );
    if (!r) throw new NovaError('not_found', `version ${version} does not exist`);
    return r;
  }

  #view(r: SiteRow): SiteView {
    const live = this.#live(r.id);
    const sourceLabel =
      r.source_kind === 'space'
        ? (this.#get<{ name: string }>(
            'SELECT name FROM space WHERE id = ? AND deleted_at IS NULL',
            r.source_ref,
          )?.name ?? null)
        : (this.#get<{ title: string | null }>(
            'SELECT title FROM artifact WHERE id = ?',
            r.source_ref,
          )?.title ?? null);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source:
        r.source_kind === 'space'
          ? { kind: 'space', spaceId: r.source_ref }
          : { kind: 'artifact', artifactId: r.source_ref },
      sourceLabel,
      data: parseConnections(r.data_json),
      latestVersion: r.latest_version,
      publishedVersion: live?.version ?? null,
      publishedTarget: live ? targetOf(live) : null,
      publishedAt: live?.created_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  #versionView(r: VersionRow, live: PublishRow | undefined): SiteVersionView {
    let files: { path: string; size: number }[] = [];
    try {
      files = JSON.parse(r.files_json) as { path: string; size: number }[];
    } catch {
      // keep empty
    }
    return {
      siteId: r.site_id,
      version: r.version,
      note: r.note,
      files,
      size: r.size,
      sha256: r.sha256,
      scripts: r.scripts === 1,
      published: live?.version === r.version,
      createdAt: r.created_at,
    };
  }

  async #emit(name: string, accountId: string, payload: Record<string, unknown>): Promise<void> {
    await this.#o.events.emit({ name, accountId, actor: 'user', payload });
  }

  /** Run a synchronous read as a promise, so a throw becomes a rejection. */
  #sync<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.#o.db.raw.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.#o.db.raw.prepare(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: (string | number | null)[]): void {
    this.#o.db.raw.prepare(sql).run(...params);
  }
}

function targetOf(r: PublishRow): SiteTarget {
  return r.target_kind === 'folder' && r.target_ref
    ? { kind: 'folder', folder: r.target_ref }
    : { kind: 'zip' };
}

function publishView(r: PublishRow, current: boolean): SitePublishView {
  return {
    id: r.id,
    siteId: r.site_id,
    version: r.version,
    target: targetOf(r),
    current,
    revertedAt: r.reverted_at,
    createdAt: r.created_at,
  };
}

function parseConnections(json: string): SiteDataConnection[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter(
          (d): d is SiteDataConnection =>
            typeof d === 'object' &&
            d !== null &&
            typeof (d as SiteDataConnection).sourceId === 'string' &&
            typeof (d as SiteDataConnection).name === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function fileSafe(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'site'
  );
}
