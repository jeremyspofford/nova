// Sites (FR-037): generate a static site from a space's pages or one artifact, keep every build as
// a version (a zip blob, encrypted at rest like other blobs), preview it sandboxed, connect JSON or
// CSV project sources as data, and publish a chosen version to a target. Publishing is explicit
// (the route demands `confirm`) and reversible: every publish is recorded, and unpublish reverts
// the live one so the previous publish is live again. M6 targets are a folder under the publish
// root and a zip download; M8 adds a folder on a remote hosting target (hosting.ts), shows what a
// publish will do before it happens (`plan`), and compares a build from another source with the
// latest version before the source changes (`previewSource`). A remote write happens before the
// publish is recorded, so a target that cannot be reached changes nothing.
import { join, resolve } from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  NovaError,
  uuidv7,
  type SiteDataConnection,
  type SiteDataSourceView,
  type SiteFileChange,
  type SiteFileView,
  type SitePublishPlanView,
  type SitePublishResult,
  type SitePublishView,
  type SiteRemoteRef,
  type SiteSource,
  type SiteSourcePreviewView,
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
import {
  HubFolderTarget,
  type HostedFile,
  type HostingTarget,
  type SiteTargetService,
} from './hosting.ts';
import type { SpaceService } from './service.ts';
import { renderArtifactSite, renderSpaceSite, type RenderedSite } from './site-render.ts';

export { SITE_MARKER } from './marker.ts';
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
  /** M8 remote hosting targets; without them a `remote` target is `capability_missing`. */
  targets?: SiteTargetService;
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
  target_kind: 'folder' | 'zip' | 'remote';
  target_ref: string | null;
  target_id: string | null;
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
  /** An earlier copy a remote target kept because it could not be reached (M8). */
  leftBehind: NonNullable<SitePublishResult['leftBehind']> | null;
}

/** Where a publish puts files: a target and the folder on it; a zip has none. */
interface Place {
  host: HostingTarget;
  folder: string;
}

export class SiteService {
  readonly #o: SiteServiceOptions;
  #audit: AuditSink;
  readonly #now: () => Date;
  readonly #hub: HubFolderTarget;
  #targets: SiteTargetService | null;

  constructor(opts: SiteServiceOptions) {
    this.#o = opts;
    this.#audit = opts.audit ?? noopAudit;
    this.#now = opts.now ?? (() => new Date());
    this.#hub = new HubFolderTarget(() => this.publishRoot());
    this.#targets = opts.targets ?? null;
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /** The remote hosting targets (M8), when they are set up after this service. */
  useTargets(targets: SiteTargetService): void {
    this.#targets = targets;
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

  /**
   * What a build from another source (or other data) would make, file by file, against the latest
   * built version (M8): nothing is stored, the site keeps its source until it is changed.
   */
  async previewSource(
    accountId: string,
    id: string,
    input: { source?: SiteSource | undefined; data?: SiteDataConnection[] | undefined },
  ): Promise<SiteSourcePreviewView> {
    const row = this.#site(accountId, id);
    const source = input.source ?? sourceOf(row);
    await this.#checkSource(accountId, source);
    const data = input.data ?? parseConnections(row.data_json);
    this.#checkData(accountId, data);
    const next: SiteRow = {
      ...row,
      source_kind: source.kind,
      source_ref: refOf(source),
      data_json: JSON.stringify(data),
    };
    const rendered = await this.#render(accountId, next, this.#loadData(accountId, data));
    const latest =
      row.latest_version !== null
        ? this.#get<VersionRow>(
            'SELECT * FROM site_version WHERE site_id = ? AND version = ?',
            id,
            row.latest_version,
          )
        : undefined;
    const old = latest
      ? unzipSync(new Uint8Array(readAttachmentBlob(this.#o.dataDir, latest.blob_path)))
      : null;
    const files: (SiteFileView & { change: SiteFileChange })[] = [];
    let size = 0;
    for (const [path, bytes] of [...rendered.files].sort(([a], [b]) => a.localeCompare(b))) {
      const before = old?.[path];
      size += bytes.length;
      files.push({
        path,
        size: bytes.length,
        change: !before ? 'added' : Buffer.from(before).equals(bytes) ? 'same' : 'changed',
      });
    }
    for (const [path, bytes] of Object.entries(old ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      if (!path.endsWith('/') && !rendered.files.has(path))
        files.push({ path, size: bytes.length, change: 'removed' });
    return {
      siteId: id,
      current: {
        source: sourceOf(row),
        sourceLabel: this.#label(row.source_kind, row.source_ref),
        data: parseConnections(row.data_json),
      },
      next: { source, sourceLabel: this.#label(source.kind, refOf(source)), data },
      comparedWith: latest?.version ?? null,
      files,
      size,
      scripts: rendered.scripts,
    };
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
      ).map((r) => this.#publishView(r, live?.id === r.id));
    });
  }

  /**
   * What publishing a version to a target would do (M8), for the user to confirm: where the files
   * go, which files, what is live now and is replaced or taken down, whether unpublishing takes it
   * back, and whether the network policy lets Nova reach a remote target. Nothing is written.
   */
  async plan(
    accountId: string,
    id: string,
    input: { version: number; target: SiteTarget },
  ): Promise<SitePublishPlanView> {
    this.#site(accountId, id);
    const v = this.#version(id, input.version);
    const t = input.target;
    let location: string | null = null;
    let remote: SiteRemoteRef | null = null;
    let egress: SitePublishPlanView['egress'] = null;
    const place = await this.#place(accountId, t, 'write');
    if (place) location = await place.host.location(place.folder);
    if (t.kind === 'remote') {
      const targets = this.#needTargets();
      remote = targets.ref(t.targetId, t.folder);
      egress = await targets.egressFor(accountId, t.targetId);
    }
    const files = parseFiles(v.files_json);
    const prev = this.#live(id);
    return {
      siteId: id,
      version: input.version,
      target: t,
      remote,
      location,
      files,
      size: files.reduce((n, f) => n + f.size, 0),
      live: prev
        ? { version: prev.version, target: targetOf(prev), remote: this.#remoteRef(prev) }
        : null,
      takesDown:
        prev && prev.target_kind !== 'zip' && !samePlace(prev, t)
          ? { target: targetOf(prev), remote: this.#remoteRef(prev) }
          : null,
      reversible: t.kind !== 'zip',
      egress,
    };
  }

  /**
   * Publish a version to a target (an earlier version is a rollback). The caller has the user's
   * explicit confirmation. A folder is replaced in one swap and only when Nova made it; a remote
   * upload that fails leaves the publish unrecorded.
   */
  async publish(
    accountId: string,
    id: string,
    input: { version: number; target: SiteTarget },
  ): Promise<PublishOutcome> {
    const row = this.#site(accountId, id);
    const v = this.#version(id, input.version);
    const prev = this.#live(id);
    const place = await this.#place(accountId, input.target, 'write');
    let location: string | null = null;
    if (place) location = await place.host.put(id, place.folder, this.#files(v));
    // Moving to another place takes the site out of the old one (unpublish puts it back).
    const leftBehind =
      prev && !samePlace(prev, input.target) ? await this.#takeDown(accountId, id, prev) : null;
    const pid = uuidv7();
    const now = this.#stamp();
    const t = input.target;
    await this.#o.db.transaction(() => {
      this.#run(
        `INSERT INTO site_publish (id, site_id, account_id, version, target_kind, target_ref,
           target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        pid,
        id,
        accountId,
        input.version,
        t.kind,
        t.kind === 'zip' ? null : t.folder,
        t.kind === 'remote' ? t.targetId : null,
        now,
      );
      this.#run('UPDATE site SET updated_at = ? WHERE id = ?', now, id);
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.published',
      resource: location ?? `site:${id}`,
      decision: 'allow',
      result: 'ok',
      detail: {
        siteId: id,
        name: row.name,
        version: input.version,
        target: t.kind,
        ...(t.kind === 'remote' ? { targetId: t.targetId, folder: t.folder } : {}),
        previousVersion: prev?.version ?? null,
        ...(leftBehind ? { leftBehind: leftBehind.location } : {}),
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
      publish: publish ? this.#publishView(publish, true) : null,
      folderPath: t.kind === 'folder' ? location : null,
      leftBehind,
    };
  }

  /**
   * Undo the live publish: the previous publish is live again (its files put back first, so a
   * target that cannot be reached changes nothing), or nothing is published.
   */
  async unpublish(accountId: string, id: string): Promise<PublishOutcome> {
    const row = this.#site(accountId, id);
    const live = this.#live(id);
    if (!live)
      throw new NovaError('conflict', 'this site is not published', {
        details: { reason: 'not_published' },
      });
    const back = this.#live(id, live.id);
    let location: string | null = null;
    const backPlace = back ? await this.#place(accountId, targetOf(back), 'write') : null;
    if (back && backPlace)
      location = await backPlace.host.put(
        id,
        backPlace.folder,
        this.#files(this.#version(id, back.version)),
      );
    const leftBehind =
      back && samePlace(live, targetOf(back)) ? null : await this.#takeDown(accountId, id, live);
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run('UPDATE site_publish SET reverted_at = ? WHERE id = ?', now, live.id);
      this.#run('UPDATE site SET updated_at = ? WHERE id = ?', now, id);
    });
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
        ...(leftBehind ? { leftBehind: leftBehind.location } : {}),
      },
    });
    await this.#emit('site.unpublished', accountId, { siteId: id, version: back?.version ?? null });
    return {
      site: await this.get(accountId, id),
      publish: back ? this.#publishView(back, true) : null,
      folderPath: back?.target_kind === 'folder' ? location : null,
      leftBehind,
    };
  }

  /** Where folder targets are written. */
  async publishRoot(): Promise<string> {
    const configured = this.#o.publishRoot ? await this.#o.publishRoot() : null;
    return resolve(configured ?? join(this.#o.dataDir, 'sites'));
  }

  // ---- internals ---------------------------------------------------------------------------------

  #needTargets(): SiteTargetService {
    if (!this.#targets)
      throw new NovaError(
        'capability_missing',
        'remote hosting targets are not set up on this Hub',
      );
    return this.#targets;
  }

  /** The target and folder a publish writes to (or takes down); null for a zip. */
  async #place(
    accountId: string,
    t: SiteTarget,
    purpose: 'write' | 'remove',
  ): Promise<Place | null> {
    if (t.kind === 'zip') return null;
    if (t.kind === 'folder') return { host: this.#hub, folder: t.folder };
    return {
      host: await this.#needTargets().open(accountId, t.targetId, purpose),
      folder: t.folder,
    };
  }

  /**
   * Take a publish's files down. A remote target that cannot be reached (or the network policy
   * refuses) keeps its copy: the outcome says where, and the publish goes on.
   */
  async #takeDown(
    accountId: string,
    siteId: string,
    r: PublishRow,
  ): Promise<PublishOutcome['leftBehind']> {
    if (r.target_kind === 'zip' || !r.target_ref) return null;
    try {
      const place = await this.#place(accountId, targetOf(r), 'remove');
      if (place) await place.host.remove(siteId, place.folder);
      return null;
    } catch (err) {
      if (r.target_kind !== 'remote' || !(err instanceof NovaError)) throw err;
      return {
        target: targetOf(r),
        location: this.#remoteRef(r)?.location ?? null,
        reason: err.message,
      };
    }
  }

  /** A version's files from its zip, in path order. */
  #files(v: VersionRow): HostedFile[] {
    const files = unzipSync(new Uint8Array(readAttachmentBlob(this.#o.dataDir, v.blob_path)));
    return Object.entries(files)
      .filter(([path]) => !path.endsWith('/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({ path, bytes }));
  }

  #remoteRef(r: PublishRow): SiteRemoteRef | null {
    if (r.target_kind !== 'remote' || !r.target_id) return null;
    return this.#targets
      ? this.#targets.ref(r.target_id, r.target_ref)
      : { targetId: r.target_id, name: null, location: null, publicUrl: null };
  }

  #publishView(r: PublishRow, current: boolean): SitePublishView {
    return { ...publishView(r, current), remote: this.#remoteRef(r) };
  }

  #label(kind: SiteRow['source_kind'], ref: string): string | null {
    return kind === 'space'
      ? (this.#get<{ name: string }>(
          'SELECT name FROM space WHERE id = ? AND deleted_at IS NULL',
          ref,
        )?.name ?? null)
      : (this.#get<{ title: string | null }>('SELECT title FROM artifact WHERE id = ?', ref)
          ?.title ?? null);
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

  /** The live publish: the newest not reverted (other than `except`, for unpublish). */
  #live(siteId: string, except?: string): PublishRow | undefined {
    return this.#get<PublishRow>(
      `SELECT * FROM site_publish WHERE site_id = ? AND reverted_at IS NULL${except ? ' AND id <> ?' : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ...(except ? [siteId, except] : [siteId]),
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
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source: sourceOf(r),
      sourceLabel: this.#label(r.source_kind, r.source_ref),
      data: parseConnections(r.data_json),
      latestVersion: r.latest_version,
      publishedVersion: live?.version ?? null,
      publishedTarget: live ? targetOf(live) : null,
      publishedRemote: live ? this.#remoteRef(live) : null,
      publishedAt: live?.created_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  #versionView(r: VersionRow, live: PublishRow | undefined): SiteVersionView {
    return {
      siteId: r.site_id,
      version: r.version,
      note: r.note,
      files: parseFiles(r.files_json),
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
  if (r.target_kind === 'remote' && r.target_id && r.target_ref)
    return { kind: 'remote', targetId: r.target_id, folder: r.target_ref };
  return r.target_kind === 'folder' && r.target_ref
    ? { kind: 'folder', folder: r.target_ref }
    : { kind: 'zip' };
}

/** Whether a publish went to the same folder of the same target as `t`. */
function samePlace(r: PublishRow, t: SiteTarget): boolean {
  const a = targetOf(r);
  if (a.kind !== t.kind) return false;
  if (a.kind === 'zip' || t.kind === 'zip') return true;
  if (a.folder !== t.folder) return false;
  return a.kind !== 'remote' || (t.kind === 'remote' && a.targetId === t.targetId);
}

function sourceOf(r: Pick<SiteRow, 'source_kind' | 'source_ref'>): SiteSource {
  return r.source_kind === 'space'
    ? { kind: 'space', spaceId: r.source_ref }
    : { kind: 'artifact', artifactId: r.source_ref };
}

function refOf(s: SiteSource): string {
  return s.kind === 'space' ? s.spaceId : s.artifactId;
}

function parseFiles(json: string): SiteFileView[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as SiteFileView[]) : [];
  } catch {
    return [];
  }
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
