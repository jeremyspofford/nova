// Catalog sources for the marketplace (FR-049; docs/08 §7, docs/14 §5): the built-in sample
// catalog shipped with Nova (read from disk, works offline), folders on the Hub, Git catalogs
// (cloned with hooks off, at a pinned commit when the catalog names one) and remote catalogs over
// HTTPS (size-capped, same-host redirects only). Every source yields the exact index bytes and
// its signature file, so the signature is checked over what was read, and fetches artifacts:
// folders and files inside the catalog, files next to a remote index, and folders of other Git
// repositories pinned to a commit.
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { NovaError, type MarketCatalogKind } from '@nova/shared';
import { catalogKind, type CatalogConfig, type PluginCatalogs } from '../plugins/catalog.ts';
import { realInside } from '../plugins/paths.ts';
import {
  artifactFormat,
  parseMarketIndex,
  type ArtifactFormat,
  type MarketIndex,
  type MarketIndexEntry,
} from './catalog-index.ts';
import { CATALOG_SIGNATURE_SUFFIX } from './signing.ts';

export const INDEX_MAX_BYTES = 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 16 * 1024;
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const INDEX_NAMES = ['catalog.json', 'nova-catalog.json'];

export interface MarketCatalogConfig extends CatalogConfig {
  /** The sample catalog shipped with Nova: read from disk, its key pinned in code. */
  builtin?: boolean;
}

/** A catalog as read now: the exact index bytes, its signature file and where items resolve. */
export interface CatalogRead {
  config: MarketCatalogConfig;
  kind: MarketCatalogKind;
  indexBytes: Uint8Array;
  signature: Uint8Array | null;
  index: MarketIndex;
  /** The Git commit the index was read at. */
  commit: string | null;
  /** Where relative paths resolve: a folder (built-in, local, Git) or the index URL. */
  base: { dir: string } | { url: string };
}

/** An artifact as fetched, before it is staged and checked. */
export type FetchedArtifact =
  | { format: ArtifactFormat; dir: string; commit: string | null }
  | { format: ArtifactFormat; bytes: Uint8Array; commit: string | null }
  | {
      format: 'registry';
      server: { transport: 'http' | 'sse'; url: string };
      commit: string | null;
    };

export function marketCatalogKind(c: MarketCatalogConfig): MarketCatalogKind {
  return c.builtin ? 'builtin' : catalogKind(c.location);
}

function folderOf(location: string): string {
  const dir = normalize(location);
  if (!isAbsolute(dir))
    throw new NovaError('validation', 'a catalog folder must be an absolute path');
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new NovaError('not_found', `catalog folder not found: ${location}`);
  return dir;
}

/** Whether a name exists in a folder at all (a link counts, wherever it points). */
function present(dir: string, name: string): boolean {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

function readCapped(file: string, max: number, what: string): Uint8Array {
  const st = statSync(file);
  if (!st.isFile()) throw new NovaError('validation', `${what} is not a file`);
  if (st.size > max) throw new NovaError('validation', `${what} is larger than ${max} bytes`);
  return readFileSync(file);
}

export class MarketSources {
  readonly #catalogs: PluginCatalogs;
  readonly #now: () => number;
  readonly #cacheMs: number;
  readonly #urlCache = new Map<string, { at: number; read: CatalogRead }>();

  constructor(opts: { catalogs: PluginCatalogs; now?: () => number; cacheMs?: number }) {
    this.#catalogs = opts.catalogs;
    this.#now = opts.now ?? Date.now;
    this.#cacheMs = opts.cacheMs ?? 5 * 60_000;
  }

  /** Read a catalog's index and signature; throws when it cannot be read. */
  async read(c: MarketCatalogConfig): Promise<CatalogRead> {
    const kind = marketCatalogKind(c);
    if (kind === 'builtin' || kind === 'local')
      return this.#readFolder(c, kind, folderOf(c.location), null);
    if (kind === 'git') {
      const clone = await this.#catalogs.catalogClone(c);
      return this.#readFolder(c, kind, clone.dir, clone.commit);
    }
    const url = /\.json(\?.*)?$/.test(c.location)
      ? c.location
      : `${c.location.replace(/\/+$/, '')}/catalog.json`;
    const key = `${c.id}\n${url}`;
    const hit = this.#urlCache.get(key);
    if (hit && this.#now() - hit.at < this.#cacheMs) return hit.read;
    const indexBytes = await this.#catalogs.download(url, INDEX_MAX_BYTES);
    const signature = await this.#catalogs.downloadOptional(signatureUrl(url), SIGNATURE_MAX_BYTES);
    const read: CatalogRead = {
      config: c,
      kind,
      indexBytes,
      signature,
      index: parseMarketIndex(indexBytes, url),
      commit: null,
      base: { url },
    };
    this.#urlCache.set(key, { at: this.#now(), read });
    return read;
  }

  /** Forget cached remote indexes (a catalog changed in settings). */
  forget(): void {
    this.#urlCache.clear();
  }

  #readFolder(
    c: MarketCatalogConfig,
    kind: MarketCatalogKind,
    dir: string,
    commit: string | null,
  ): CatalogRead {
    // The index and its signature are read only from inside the catalog's folder: a link that
    // leaves it (a Git checkout can hold one) is refused, never followed.
    for (const name of INDEX_NAMES) {
      if (!present(dir, name)) continue;
      const indexBytes = readCapped(realInside(dir, name, name), INDEX_MAX_BYTES, name);
      const sigName = name + CATALOG_SIGNATURE_SUFFIX;
      const signature = present(dir, sigName)
        ? readCapped(realInside(dir, sigName, sigName), SIGNATURE_MAX_BYTES, sigName)
        : null;
      return {
        config: c,
        kind,
        indexBytes,
        signature,
        index: parseMarketIndex(indexBytes, name),
        commit,
        base: { dir },
      };
    }
    throw new NovaError('not_found', `no catalog.json in ${c.location}`);
  }

  /** Fetch an entry's artifact (not yet staged or checked). */
  async artifact(read: CatalogRead, entry: MarketIndexEntry): Promise<FetchedArtifact> {
    const format = artifactFormat(entry);
    if (format === 'registry') {
      if (!entry.server) throw new NovaError('validation', `${entry.id} has no server`);
      if (!entry.server.url.startsWith('https://'))
        throw new NovaError('validation', 'a registry entry must connect over https');
      return { format, server: entry.server, commit: null };
    }
    // Another repository, pinned to a commit (docs/08 §7).
    if (entry.repo && entry.commit) {
      const clone = await this.#catalogs.cloneGitAt(entry.repo, entry.commit);
      const at = entry.path ? realInside(clone.dir, entry.path, 'catalog entry') : clone.dir;
      return this.#local(format, at, clone.commit);
    }
    if ('dir' in read.base) {
      if (entry.path) {
        const at = realInside(read.base.dir, entry.path, 'catalog entry');
        return this.#local(format, at, read.commit);
      }
      if (entry.url) {
        if (!entry.url.startsWith('https://'))
          throw new NovaError('validation', 'an item outside its catalog must be an https URL');
        return {
          format,
          bytes: await this.#catalogs.download(entry.url, ARTIFACT_MAX_BYTES),
          commit: read.commit,
        };
      }
      throw new NovaError('validation', `${entry.id} has no path`);
    }
    const href = this.#sameHost(read.base.url, entry.url ?? entry.path ?? '');
    return { format, bytes: await this.#catalogs.download(href, ARTIFACT_MAX_BYTES), commit: null };
  }

  /** A file the catalog lists (a screenshot), capped. */
  async file(read: CatalogRead, rel: string, max = SCREENSHOT_MAX_BYTES): Promise<Uint8Array> {
    if ('dir' in read.base)
      return readCapped(realInside(read.base.dir, rel, 'catalog file'), max, rel);
    return this.#catalogs.download(this.#sameHost(read.base.url, rel), max);
  }

  #local(format: ArtifactFormat, at: string, commit: string | null): FetchedArtifact {
    const st = statSync(at);
    if (format === 'folder') {
      if (!st.isDirectory()) throw new NovaError('validation', 'the catalog entry is not a folder');
      return { format, dir: at, commit };
    }
    return { format, bytes: readCapped(at, ARTIFACT_MAX_BYTES, 'the item'), commit };
  }

  /** A path next to a remote index: https and on the catalog's own host only. */
  #sameHost(indexUrl: string, rel: string): string {
    let u: URL;
    try {
      u = new URL(rel, indexUrl);
    } catch {
      throw new NovaError('validation', 'invalid item URL');
    }
    if (u.protocol !== 'https:' || u.host !== new URL(indexUrl).host)
      throw new NovaError(
        'validation',
        'a catalog item must be served from the catalog host over https',
      );
    return u.href;
  }
}

/** The signature file of an index URL: `<url>.sig` (before any query). */
export function signatureUrl(indexUrl: string): string {
  const u = new URL(indexUrl);
  u.pathname = u.pathname + CATALOG_SIGNATURE_SUFFIX;
  return u.href;
}
