// Plugin catalogs (FR-045, FR-049 stub; docs/08 §7, docs/14 §5): a local folder, an https URL or a
// Git repository whose `catalog.json` (or `nova-catalog.json`) lists plugins with their versions
// and where they are. URL fetches are size-capped and never follow a redirect to another host;
// Git catalogs need the `git` command and are cloned shallow, read-only, with hooks disabled.
// Signatures arrive with the marketplace (M8): every entry is unverified until then.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { NovaError, uuidv7, type CatalogView } from '@nova/shared';
import { realInside, resolveInside } from './paths.ts';

export interface CatalogConfig {
  id: string;
  name: string;
  /** A folder on the Hub, an https URL or a Git URL. */
  location: string;
}

export type CatalogKind = CatalogView['kind'];

const PLUGIN_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/;

const indexSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  name: z.string().max(100).optional(),
  plugins: z
    .array(
      z
        .object({
          id: z.string().regex(PLUGIN_ID),
          name: z.string().min(1).max(100),
          version: z.string().regex(SEMVER),
          description: z.string().max(500).optional(),
          /** Folder of the plugin, relative to the catalog (folder and Git catalogs). */
          path: z.string().min(1).max(1000).optional(),
          /** Zip archive of the plugin, relative to the index URL (URL catalogs). */
          url: z.string().min(1).max(2000).optional(),
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .refine((e) => e.path !== undefined || e.url !== undefined, 'an entry needs path or url'),
    )
    .max(1000),
});

export type CatalogIndex = z.infer<typeof indexSchema>;
export type CatalogIndexEntry = CatalogIndex['plugins'][number];

export interface CatalogListing {
  catalog: CatalogConfig;
  entries: CatalogIndexEntry[];
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git` with fixed arguments (no shell); tests replace it. */
export type GitRunner = (args: string[], opts: { timeoutMs: number }) => Promise<GitResult>;

export interface PluginCatalogsOptions {
  /** Clones and downloads go under here (`<dataDir>/cache/plugins`). */
  cacheDir: string;
  fetch?: typeof fetch;
  git?: GitRunner;
  /** The `git` executable for the default runner. */
  gitCommand?: string;
  maxIndexBytes?: number;
  maxArchiveBytes?: number;
  /** How long a fetched URL index or a Git clone is reused. */
  cacheMs?: number;
  now?: () => number;
}

/** Whether a location is a folder, an https URL or a Git URL. */
export function catalogKind(location: string): CatalogKind {
  const l = location.trim();
  if (/^git@[^:]+:/.test(l) || /^(ssh|git):\/\//.test(l) || /^git\+https:\/\//.test(l))
    return 'git';
  if (/^https:\/\//.test(l)) return /\.git(#.*)?$/.test(l) ? 'git' : 'url';
  return 'local';
}

/** A `git` runner spawning the command with a timeout, a clean environment and no prompts. */
export function spawnGit(command = 'git'): GitRunner {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on(
        'data',
        (b: Buffer) => (stdout = (stdout + b.toString('utf8')).slice(-65536)),
      );
      child.stderr.on(
        'data',
        (b: Buffer) => (stderr = (stderr + b.toString('utf8')).slice(-65536)),
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

function parseIndex(text: string, where: string): CatalogIndex {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NovaError('validation', `${where}: the catalog index is not valid JSON`);
  }
  const r = indexSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new NovaError(
      'validation',
      `${where}: ${i?.path.join('.') || 'index'} ${i?.message ?? 'invalid'}`,
    );
  }
  return r.data;
}

function readFolderIndex(dir: string): CatalogIndex {
  for (const name of ['catalog.json', 'nova-catalog.json']) {
    const file = join(dir, name);
    if (existsSync(file)) {
      if (statSync(file).size > 1024 * 1024)
        throw new NovaError('validation', `${name} is larger than 1 MB`);
      return parseIndex(readFileSync(file, 'utf8'), name);
    }
  }
  throw new NovaError('not_found', `no catalog.json in ${dir}`);
}

/** Pick an entry: the requested version, or the highest one. */
export function pickEntry(
  entries: readonly CatalogIndexEntry[],
  pluginId: string,
  version?: string,
): CatalogIndexEntry | null {
  const all = entries.filter((e) => e.id === pluginId);
  if (version) return all.find((e) => e.version === version) ?? null;
  return all.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  // A release sorts after its pre-releases.
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1);
}

export class PluginCatalogs {
  readonly #opts: PluginCatalogsOptions;
  readonly #fetch: typeof fetch;
  readonly #git: GitRunner;
  readonly #urlCache = new Map<string, { at: number; index: CatalogIndex }>();
  readonly #gitCache = new Map<string, { at: number; dir: string; commit: string }>();

  constructor(opts: PluginCatalogsOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.#git = opts.git ?? spawnGit(opts.gitCommand);
  }

  view(c: CatalogConfig): CatalogView {
    return { id: c.id, name: c.name, location: c.location, kind: catalogKind(c.location) };
  }

  /** A catalog's entries; throws when it cannot be read. */
  async listing(c: CatalogConfig): Promise<CatalogListing> {
    const kind = catalogKind(c.location);
    if (kind === 'local')
      return { catalog: c, entries: readFolderIndex(this.#folder(c.location)).plugins };
    if (kind === 'url')
      return { catalog: c, entries: (await this.#urlIndex(c.location)).index.plugins };
    const clone = await this.cloneGit(c.location);
    return { catalog: c, entries: readFolderIndex(clone.dir).plugins };
  }

  /**
   * The folder of one catalog entry, ready for the plugin loader, and a description of where it
   * came from (recorded with the install).
   */
  async resolve(
    c: CatalogConfig,
    pluginId: string,
    version?: string,
  ): Promise<{ root: string; origin: string; entry: CatalogIndexEntry }> {
    const kind = catalogKind(c.location);
    if (kind === 'local') {
      const dir = this.#folder(c.location);
      const entry = this.#entry(readFolderIndex(dir).plugins, c, pluginId, version);
      if (!entry.path) throw new NovaError('validation', `${pluginId} in ${c.name} has no path`);
      return {
        root: realInside(dir, entry.path, 'catalog entry'),
        origin: `${c.id}/${pluginId}@${entry.version}`,
        entry,
      };
    }
    if (kind === 'git') {
      const clone = await this.cloneGit(c.location);
      const entry = this.#entry(readFolderIndex(clone.dir).plugins, c, pluginId, version);
      if (!entry.path) throw new NovaError('validation', `${pluginId} in ${c.name} has no path`);
      return {
        root: realInside(clone.dir, entry.path, 'catalog entry'),
        origin: `${c.id}/${pluginId}@${entry.version}#${clone.commit}`,
        entry,
      };
    }
    const { url, index } = await this.#urlIndex(c.location);
    const entry = this.#entry(index.plugins, c, pluginId, version);
    if (!entry.url)
      throw new NovaError('validation', `${pluginId} in ${c.name} has no archive url`);
    const archive = new URL(entry.url, url);
    if (archive.protocol !== 'https:' || archive.host !== new URL(url).host)
      throw new NovaError(
        'validation',
        'a catalog archive must be served from the catalog host over https',
      );
    const bytes = await this.#download(
      archive.href,
      this.#opts.maxArchiveBytes ?? 50 * 1024 * 1024,
    );
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256 && entry.sha256 !== sha)
      throw new NovaError(
        'validation',
        `${pluginId}: the archive checksum does not match the catalog`,
      );
    const root = this.#unzip(bytes, sha);
    return { root, origin: `${c.id}/${pluginId}@${entry.version}`, entry };
  }

  /** Clone a Git URL (shallow, hooks off) into the cache; reused for `cacheMs`. */
  async cloneGit(location: string, ref?: string): Promise<{ dir: string; commit: string }> {
    let url = location.trim().replace(/^git\+/, '');
    const hash = url.indexOf('#');
    if (hash >= 0) {
      ref ??= url.slice(hash + 1) || undefined;
      url = url.slice(0, hash);
    }
    if (url.startsWith('-') || !/^(https:\/\/|ssh:\/\/|git:\/\/|git@[^:]+:)/.test(url))
      throw new NovaError('validation', 'a Git URL must use https, ssh or git');
    if (ref !== undefined && (!GIT_REF.test(ref) || ref.startsWith('-') || ref.includes('..')))
      throw new NovaError('validation', 'invalid Git ref');
    const key = createHash('sha256')
      .update(`${url}#${ref ?? ''}`)
      .digest('hex')
      .slice(0, 32);
    const now = this.#opts.now?.() ?? Date.now();
    const hit = this.#gitCache.get(key);
    if (hit && now - hit.at < (this.#opts.cacheMs ?? 10 * 60_000) && existsSync(hit.dir))
      return hit;
    await this.#requireGit();
    const parent = join(this.#opts.cacheDir, 'git');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = join(parent, key);
    const tmp = join(parent, `.tmp-${uuidv7()}`);
    const args = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.file.allow=never',
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
      ...(ref ? ['--branch', ref] : []),
      '--',
      url,
      tmp,
    ];
    const r = await this.#git(args, { timeoutMs: 120_000 });
    if (r.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new NovaError(
        'validation',
        `git clone failed: ${r.stderr.trim().split('\n').at(-1) ?? 'error'}`,
      );
    }
    const head = await this.#git(['-C', tmp, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 });
    const commit = head.code === 0 ? head.stdout.trim() : 'unknown';
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    const entry = { at: now, dir, commit };
    this.#gitCache.set(key, entry);
    return entry;
  }

  async #requireGit(): Promise<void> {
    let r: GitResult;
    try {
      r = await this.#git(['--version'], { timeoutMs: 10_000 });
    } catch {
      r = { code: -1, stdout: '', stderr: '' };
    }
    if (r.code !== 0)
      throw new NovaError(
        'capability_missing',
        'Git catalogs need the git command on the Hub, and it was not found',
        {
          action: 'Install git on the Hub, or add the catalog as a folder',
        },
      );
  }

  #entry(
    entries: CatalogIndexEntry[],
    c: CatalogConfig,
    pluginId: string,
    version?: string,
  ): CatalogIndexEntry {
    const e = pickEntry(entries, pluginId, version);
    if (!e)
      throw new NovaError(
        'not_found',
        `${pluginId}${version ? `@${version}` : ''} is not in ${c.name}`,
      );
    return e;
  }

  #folder(location: string): string {
    const dir = normalize(location);
    if (!isAbsolute(dir))
      throw new NovaError('validation', 'a catalog folder must be an absolute path');
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new NovaError('not_found', `catalog folder not found: ${location}`);
    return dir;
  }

  async #urlIndex(location: string): Promise<{ url: string; index: CatalogIndex }> {
    const url = /\.json(\?.*)?$/.test(location)
      ? location
      : `${location.replace(/\/+$/, '')}/catalog.json`;
    const now = this.#opts.now?.() ?? Date.now();
    const hit = this.#urlCache.get(url);
    if (hit && now - hit.at < (this.#opts.cacheMs ?? 5 * 60_000)) return { url, index: hit.index };
    const bytes = await this.#download(url, this.#opts.maxIndexBytes ?? 1024 * 1024);
    const index = parseIndex(Buffer.from(bytes).toString('utf8'), url);
    this.#urlCache.set(url, { at: now, index });
    return { url, index };
  }

  /** GET with a size cap; redirects are followed only on the same host (at most 3). */
  async #download(start: string, max: number): Promise<Uint8Array> {
    let url = new URL(start);
    if (url.protocol !== 'https:') throw new NovaError('validation', 'catalog URLs must use https');
    const host = url.host;
    for (let hop = 0; hop < 4; hop++) {
      let res: Response;
      try {
        res = await this.#fetch(url.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new NovaError(
          'validation',
          `could not reach ${url.host}: ${err instanceof Error ? err.message : 'error'}`,
        );
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc)
          throw new NovaError('validation', `${url.host} answered a redirect without a location`);
        const next = new URL(loc, url);
        if (next.host !== host || next.protocol !== 'https:')
          throw new NovaError(
            'validation',
            `the catalog redirected to another host (${next.host}); refused`,
          );
        url = next;
        continue;
      }
      if (!res.ok) throw new NovaError('validation', `${url.host} answered ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > max)
        throw new NovaError('validation', `the catalog file is larger than ${max} bytes`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) {
            await reader.cancel();
            throw new NovaError('validation', `the catalog file is larger than ${max} bytes`);
          }
          chunks.push(value);
        }
      }
      return Buffer.concat(chunks);
    }
    throw new NovaError('validation', 'too many redirects');
  }

  /** Unpack a plugin archive into the cache; the plugin root is where `.nova-plugin/` is. */
  #unzip(bytes: Uint8Array, sha: string): string {
    const parent = join(this.#opts.cacheDir, 'archives');
    const dir = join(parent, sha.slice(0, 32));
    if (!existsSync(dir)) {
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(bytes);
      } catch {
        throw new NovaError('validation', 'the plugin archive is not a valid zip file');
      }
      const tmp = join(parent, `.tmp-${uuidv7()}`);
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      let total = 0;
      try {
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith('/')) continue;
          total += data.byteLength;
          if (total > 100 * 1024 * 1024)
            throw new NovaError('validation', 'the plugin archive unpacks to more than 100 MB');
          const to = resolveInside(tmp, name, 'archive entry');
          mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
          writeFileSync(to, data, { mode: 0o600 });
        }
        renameSync(tmp, dir);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        throw err;
      }
    }
    if (existsSync(join(dir, '.nova-plugin'))) return dir;
    // A single top-level folder holding the plugin.
    for (const t of readdirSync(dir))
      if (existsSync(join(dir, t, '.nova-plugin'))) return join(dir, t);
    throw new NovaError('validation', 'the plugin archive has no .nova-plugin/plugin.json');
  }
}
