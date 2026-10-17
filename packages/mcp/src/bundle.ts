// MCP bundles (FR-199; docs/08 §2.5; contracts/schemas/mcp-bundle-manifest.json): a zip with
// `manifest.json` at its root. Reading never runs anything: names are checked against path
// traversal, sizes and the file count are capped before anything is inflated, and the manifest is
// validated field by field with errors that name what is wrong. Installing extracts into a fresh
// folder and turns the manifest's `mcp_config` into a launch line (argv only, no shell).
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { NovaError } from '@nova/shared';

export const BUNDLE_MANIFEST_VERSIONS = ['0.2', '0.3', '0.4'] as const;
export const BUNDLE_SERVER_TYPES = ['node', 'python', 'uv', 'binary'] as const;
export const BUNDLE_CONFIG_TYPES = ['string', 'number', 'boolean', 'directory', 'file'] as const;
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

export type BundleServerType = (typeof BUNDLE_SERVER_TYPES)[number];
export type BundleConfigType = (typeof BUNDLE_CONFIG_TYPES)[number];
export type BundlePlatform = (typeof PLATFORMS)[number];

export interface BundleLimits {
  /** Entries in the archive, directories included. */
  maxFiles: number;
  /** Sum of the declared uncompressed sizes. */
  maxTotalBytes: number;
  /** One entry's declared uncompressed size. */
  maxFileBytes: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxFiles: 10_000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 200 * 1024 * 1024,
};

const MANIFEST = 'manifest.json';
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** Inflate at most this much per pass, so memory stays bounded for large bundles. */
const BATCH_BYTES = 64 * 1024 * 1024;

export interface BundleLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BundleConfigEntry {
  type: BundleConfigType;
  title: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
  multiple: boolean;
  default?: unknown;
  min?: number;
  max?: number;
}

/** The manifest fields Nova reads; the original JSON is kept as is (unknown fields preserved). */
export interface BundleManifest {
  manifestVersion: (typeof BUNDLE_MANIFEST_VERSIONS)[number];
  name: string;
  displayName: string | null;
  version: string;
  description: string;
  author: string | null;
  homepage: string | null;
  license: string | null;
  server: {
    type: BundleServerType;
    entryPoint: string;
    mcpConfig: BundleLaunchSpec & {
      platformOverrides: Partial<Record<BundlePlatform, Partial<BundleLaunchSpec>>>;
    };
  };
  userConfig: Record<string, BundleConfigEntry>;
  compatibility: { platforms: BundlePlatform[] | null; runtimes: Record<string, string> };
  tools: { name: string; description: string | null }[];
  prompts: string[];
  privacyPolicies: string[];
  /** The parsed manifest.json, unknown fields included. */
  raw: Record<string, unknown>;
}

export interface BundleEntry {
  name: string;
  dir: boolean;
  /** Declared uncompressed size. */
  size: number;
}

export interface ReadBundle {
  manifest: BundleManifest;
  entries: BundleEntry[];
  /** SHA-256 of the bytes as uploaded (signature included). */
  sha256: string;
  /** A signature block is present (verified or not). */
  signed: boolean;
  /** The archive itself, without a trailing signature block. */
  archive: Uint8Array;
}

const fail = (message: string, field?: string): never => {
  throw new NovaError('validation', message, field ? { details: { field } } : {});
};

// ---- signatures ---------------------------------------------------------------------------

const SIG_START = Buffer.from('MCPB_SIG_V1');
const SIG_END = Buffer.from('MCPB_SIG_END');

/** Split a trailing signature block off the archive (the open format appends one). */
export function splitSignature(bytes: Uint8Array): {
  archive: Uint8Array;
  signature: Uint8Array | null;
} {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < SIG_END.length || !buf.subarray(buf.length - SIG_END.length).equals(SIG_END))
    return { archive: bytes, signature: null };
  const start = buf.lastIndexOf(SIG_START);
  if (start < 0) return { archive: bytes, signature: null };
  return {
    archive: bytes.subarray(0, start),
    signature: bytes.subarray(start + SIG_START.length, buf.length - SIG_END.length),
  };
}

/** A publisher whose signatures Nova accepts. The list is empty until a publisher program exists. */
export interface TrustedPublisher {
  id: string;
  /** Returns true when `signature` is a valid signature of `archive` by this publisher. */
  verify(archive: Uint8Array, signature: Uint8Array): boolean;
}

/**
 * A bundle is verified only when a trusted publisher's key validates its signature (docs/08
 * §2.5); unsigned bundles and bundles signed by an unknown key are unverified.
 */
export function bundleSignature(
  read: Pick<ReadBundle, 'archive'> & { signature: Uint8Array | null },
  trusted: readonly TrustedPublisher[],
): 'verified' | 'unverified' {
  const sig = read.signature;
  if (!sig || !sig.length) return 'unverified';
  for (const p of trusted) {
    try {
      if (p.verify(read.archive, sig)) return 'verified';
    } catch {
      // A verifier that throws does not verify.
    }
  }
  return 'unverified';
}

// ---- reading --------------------------------------------------------------------------------

/**
 * A safe relative path for an archive entry, or null. Absolute paths, drive letters,
 * backslashes, NUL bytes, `..` segments and over-long names are refused.
 */
export function safeEntryName(name: string): string | null {
  if (!name || name.length > 1024 || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  const dir = name.endsWith('/');
  const segs = (dir ? parts.slice(0, -1) : parts).filter((p) => p !== '.');
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === '' || s === '..' || s.length > 255) return null;
  }
  return segs.join('/') + (dir ? '/' : '');
}

function listEntries(archive: Uint8Array, limits: BundleLimits): Map<string, UnzipFileInfo> {
  const out = new Map<string, UnzipFileInfo>();
  let total = 0;
  try {
    unzipSync(archive, {
      filter: (f) => {
        if (out.size >= limits.maxFiles) fail(`the bundle has more than ${limits.maxFiles} files`);
        const name = safeEntryName(f.name);
        if (!name) fail(`the bundle contains an unsafe path: ${f.name.slice(0, 200)}`);
        const key = name!;
        if (out.has(key)) fail(`the bundle lists ${key} twice`);
        if (f.compression !== 0 && f.compression !== 8)
          fail(`${key} uses an unsupported compression method`);
        if (f.originalSize > limits.maxFileBytes)
          fail(`${key} is larger than ${Math.round(limits.maxFileBytes / 1048576)} MB`);
        if (f.compression === 0 && f.size !== f.originalSize) fail(`${key} is damaged`);
        total += f.originalSize;
        if (total > limits.maxTotalBytes)
          fail(`the bundle unpacks to more than ${Math.round(limits.maxTotalBytes / 1048576)} MB`);
        out.set(key, { ...f, name: key });
        return false;
      },
    });
  } catch (err) {
    if (err instanceof NovaError) throw err;
    fail('the file is not a valid zip archive');
  }
  return out;
}

/** Inflate the named entries (by their original names), checking each against its declared size. */
function inflate(archive: Uint8Array, wanted: Set<string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter: (f) => {
        const name = safeEntryName(f.name);
        if (!name || !wanted.has(name) || name.endsWith('/')) return false;
        sizes.set(f.name, f.originalSize);
        return true;
      },
    });
  } catch {
    return fail('the bundle is damaged and could not be unpacked');
  }
  for (const [raw, data] of Object.entries(files)) {
    if (data.length !== sizes.get(raw)) fail(`${safeEntryName(raw) ?? raw} is damaged`);
    out.set(safeEntryName(raw)!, data);
  }
  return out;
}

/** Read and validate a bundle without extracting it (preview). */
export function readBundle(
  bytes: Uint8Array,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): ReadBundle & { signature: Uint8Array | null } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { archive, signature } = splitSignature(bytes);
  const listed = listEntries(archive, limits);
  const info = listed.get(MANIFEST);
  if (!info || info.name.endsWith('/')) fail('the bundle has no manifest.json at its root');
  if (info!.originalSize > MANIFEST_MAX_BYTES) fail('manifest.json is too large');
  const data = inflate(archive, new Set([MANIFEST])).get(MANIFEST);
  if (!data) return fail('manifest.json could not be read');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return fail('manifest.json is not valid JSON');
  }
  const manifest = parseManifest(json);
  const entries = [...listed.values()].map((f) => ({
    name: f.name,
    dir: f.name.endsWith('/'),
    size: f.originalSize,
  }));
  if (!entries.some((e) => !e.dir && e.name === normalEntry(manifest.server.entryPoint)))
    fail(
      `the entry point ${manifest.server.entryPoint} is not in the bundle`,
      'server.entry_point',
    );
  return { manifest, entries, sha256, signed: signature !== null, signature, archive };
}

function normalEntry(p: string): string {
  return safeEntryName(p.replace(/^\.\//, '')) ?? '';
}

/**
 * Extract every entry under `dest`, which must not exist yet or be empty. Each path is checked
 * again against `dest` after resolution; nothing outside it is ever written.
 */
export function extractBundle(read: Pick<ReadBundle, 'archive' | 'entries'>, dest: string): number {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const inside = (name: string) => {
    const p = resolve(root, name);
    const rel = relative(root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`unsafe path ${name}`);
    return p;
  };
  for (const e of read.entries) {
    if (!e.dir) continue;
    try {
      mkdirSync(inside(e.name), { recursive: true, mode: 0o700 });
    } catch {
      fail(`${e.name} could not be unpacked`);
    }
  }
  const files = read.entries.filter((e) => !e.dir);
  let written = 0;
  let batch = new Set<string>();
  let batchBytes = 0;
  const flush = () => {
    if (!batch.size) return;
    for (const [name, data] of inflate(read.archive, batch)) {
      const p = inside(name);
      try {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        // `wx`: never overwrite (a name that clashes with a folder or an earlier file fails).
        writeFileSync(p, data, { mode: 0o600, flag: 'wx' });
      } catch {
        fail(`${name} could not be unpacked`);
      }
      written++;
    }
    batch = new Set();
    batchBytes = 0;
  };
  for (const f of files) {
    if (batchBytes + f.size > BATCH_BYTES) flush();
    batch.add(f.name);
    batchBytes += f.size;
  }
  flush();
  if (written !== files.length) fail('the bundle is damaged: some files could not be unpacked');
  return written;
}

// ---- manifest -------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, field: string, max = 10_000): string => {
  if (typeof v !== 'string') return fail(`manifest ${field} must be a string`, field);
  if (v.length > max) return fail(`manifest ${field} is too long`, field);
  return v;
};
const optStr = (v: unknown, field: string, max = 10_000): string | null =>
  v === undefined || v === null ? null : str(v, field, max);
const strList = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    return fail(`manifest ${field} must be a list of strings`, field);
  return v as string[];
};
const strMap = (v: unknown, field: string): Record<string, string> => {
  if (v === undefined) return {};
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== 'string'))
    return fail(`manifest ${field} must map names to strings`, field);
  return { ...(v as Record<string, string>) };
};

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function launchSpec(v: unknown, field: string, partial: boolean): Partial<BundleLaunchSpec> {
  if (!isObj(v)) return fail(`manifest ${field} must be an object`, field);
  const out: Partial<BundleLaunchSpec> = {};
  if (v.command !== undefined || !partial) out.command = str(v.command, `${field}.command`, 1000);
  if (v.args !== undefined) out.args = strList(v.args, `${field}.args`);
  if (v.env !== undefined) out.env = strMap(v.env, `${field}.env`);
  return out;
}

/** Validate manifest.json against mcp-bundle-manifest.json, with errors that name the field. */
export function parseManifest(json: unknown): BundleManifest {
  if (!isObj(json)) return fail('manifest.json must be a JSON object');
  const mv = json.manifest_version;
  if (typeof mv !== 'string' || !(BUNDLE_MANIFEST_VERSIONS as readonly string[]).includes(mv))
    fail(
      `manifest version ${String(mv)} is not supported (Nova reads ${BUNDLE_MANIFEST_VERSIONS.join(', ')})`,
      'manifest_version',
    );
  for (const k of ['name', 'version', 'description', 'author', 'server'])
    if (json[k] === undefined) fail(`manifest is missing ${k}`, k);
  const name = str(json.name, 'name', 100);
  if (!name.trim()) fail('manifest name is empty', 'name');
  const version = str(json.version, 'version', 100);
  if (!VERSION.test(version))
    fail(`manifest version ${version} is not a semantic version`, 'version');
  const description = str(json.description, 'description', 2000);
  if (!isObj(json.author)) return fail('manifest author must be an object with a name', 'author');
  const author = str(json.author.name, 'author.name', 200);
  const server = json.server;
  if (!isObj(server)) return fail('manifest server must be an object', 'server');
  const type = server.type;
  if (typeof type !== 'string' || !(BUNDLE_SERVER_TYPES as readonly string[]).includes(type))
    fail(`server type ${String(type)} is not supported`, 'server.type');
  if (type === 'uv' && mv !== '0.4')
    fail('server type uv needs manifest version 0.4', 'server.type');
  const entryPoint = str(server.entry_point, 'server.entry_point', 1000);
  if (!normalEntry(entryPoint)) fail('the entry point is not a safe path', 'server.entry_point');
  const cfg = server.mcp_config;
  if (!isObj(cfg)) return fail('manifest server.mcp_config must be an object', 'server.mcp_config');
  const base = launchSpec(cfg, 'server.mcp_config', false) as BundleLaunchSpec;
  const overrides: Partial<Record<BundlePlatform, Partial<BundleLaunchSpec>>> = {};
  if (cfg.platform_overrides !== undefined) {
    if (!isObj(cfg.platform_overrides))
      fail('platform_overrides must be an object', 'server.mcp_config.platform_overrides');
    for (const [p, spec] of Object.entries(cfg.platform_overrides as Record<string, unknown>)) {
      if (!(PLATFORMS as readonly string[]).includes(p))
        fail(`unknown platform ${p} in platform_overrides`, 'server.mcp_config.platform_overrides');
      overrides[p as BundlePlatform] = launchSpec(spec, `platform_overrides.${p}`, true);
    }
  }
  const userConfig: Record<string, BundleConfigEntry> = {};
  if (json.user_config !== undefined) {
    if (!isObj(json.user_config)) fail('user_config must be an object', 'user_config');
    for (const [key, e] of Object.entries(json.user_config as Record<string, unknown>)) {
      const field = `user_config.${key}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) fail(`user_config key ${key} is not allowed`, field);
      if (!isObj(e)) return fail(`${field} must be an object`, field);
      const t = e.type;
      if (typeof t !== 'string' || !(BUNDLE_CONFIG_TYPES as readonly string[]).includes(t))
        fail(`${field} has an unknown type ${String(t)}`, field);
      const entry: BundleConfigEntry = {
        type: t as BundleConfigType,
        title: str(e.title, `${field}.title`, 200),
        required: e.required === true,
        sensitive: e.sensitive === true,
        multiple: e.multiple === true,
      };
      const desc = optStr(e.description, `${field}.description`, 2000);
      if (desc !== null) entry.description = desc;
      if (e.default !== undefined) entry.default = e.default;
      if (typeof e.min === 'number') entry.min = e.min;
      if (typeof e.max === 'number') entry.max = e.max;
      userConfig[key] = entry;
    }
  }
  const compat = isObj(json.compatibility) ? json.compatibility : {};
  let platforms: BundlePlatform[] | null = null;
  if (compat.platforms !== undefined) {
    const list = strList(compat.platforms, 'compatibility.platforms');
    for (const p of list)
      if (!(PLATFORMS as readonly string[]).includes(p))
        fail(`unknown platform ${p} in compatibility`, 'compatibility.platforms');
    platforms = list as BundlePlatform[];
  }
  const tools: BundleManifest['tools'] = [];
  if (Array.isArray(json.tools)) {
    for (const t of json.tools) {
      if (!isObj(t) || typeof t.name !== 'string') fail('each manifest tool needs a name', 'tools');
      const tool = t as { name: string; description?: unknown };
      tools.push({
        name: tool.name.slice(0, 200),
        description: typeof tool.description === 'string' ? tool.description.slice(0, 2000) : null,
      });
    }
  }
  return {
    manifestVersion: mv as BundleManifest['manifestVersion'],
    name,
    displayName: optStr(json.display_name, 'display_name', 100),
    version,
    description,
    author,
    homepage: optStr(json.homepage, 'homepage', 2000),
    license: optStr(json.license, 'license', 200),
    server: {
      type: type as BundleServerType,
      entryPoint,
      mcpConfig: { ...base, platformOverrides: overrides },
    },
    userConfig,
    compatibility: {
      platforms,
      runtimes: isObj(compat.runtimes) ? strMap(compat.runtimes, 'compatibility.runtimes') : {},
    },
    tools,
    prompts: Array.isArray(json.prompts)
      ? json.prompts.flatMap((p) => (isObj(p) && typeof p.name === 'string' ? [p.name] : []))
      : [],
    privacyPolicies: strList(json.privacy_policies, 'privacy_policies'),
    raw: json,
  };
}

/** A bundle name as an MCP server name (`^[a-z0-9-]{1,40}$`) and a safe folder name. */
export function bundleServerName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'bundle';
}

// ---- user config, templates and the launch line --------------------------------------------

export type BundleConfigValue = string | number | boolean | string[];

/**
 * Check user-entered values against `user_config` (types, required, min/max, `multiple`) and fill
 * defaults. Paths must be absolute. Unknown keys are refused.
 */
export function resolveUserConfig(
  manifest: Pick<BundleManifest, 'userConfig'>,
  input: Record<string, unknown>,
): Record<string, BundleConfigValue> {
  const out: Record<string, BundleConfigValue> = {};
  for (const key of Object.keys(input))
    if (!(key in manifest.userConfig)) fail(`unknown setting ${key}`, `userConfig.${key}`);
  for (const [key, e] of Object.entries(manifest.userConfig)) {
    const field = `userConfig.${key}`;
    let v = input[key];
    if (v === undefined || v === null || v === '') v = e.default;
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
      if (e.required) fail(`${e.title} is required`, field);
      continue;
    }
    switch (e.type) {
      case 'boolean':
        if (typeof v !== 'boolean') fail(`${e.title} must be true or false`, field);
        out[key] = v as boolean;
        break;
      case 'number': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n))
          return fail(`${e.title} must be a number`, field);
        if (e.min !== undefined && n < e.min) fail(`${e.title} must be at least ${e.min}`, field);
        if (e.max !== undefined && n > e.max) fail(`${e.title} must be at most ${e.max}`, field);
        out[key] = n;
        break;
      }
      case 'string':
      case 'directory':
      case 'file': {
        const list = Array.isArray(v) ? v : [v];
        if (list.length > 1 && !e.multiple) fail(`${e.title} takes one value`, field);
        if (list.some((x) => typeof x !== 'string' || x.length > 4000 || x.includes('\0')))
          fail(`${e.title} must be text`, field);
        const strs = list as string[];
        if (e.type !== 'string' && strs.some((p) => !isAbsolute(p)))
          fail(`${e.title} must be an absolute path`, field);
        out[key] = e.multiple ? strs : strs[0]!;
        break;
      }
    }
  }
  return out;
}

export interface TemplateContext {
  dir: string;
  home: string;
  values: Record<string, BundleConfigValue>;
}

const VAR = /\$\{([^}]+)\}/g;
const KNOWN = new Set([
  '__dirname',
  'HOME',
  'DESKTOP',
  'DOCUMENTS',
  'DOWNLOADS',
  'pathSeparator',
  '/',
]);

/** Variables a string uses that Nova does not know (shown as a preview warning). */
export function unknownVariables(text: string, keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR)) {
    const v = m[1]!;
    if (KNOWN.has(v)) continue;
    if (v.startsWith('user_config.') && keys.has(v.slice(12))) continue;
    out.push(v);
  }
  return out;
}

/** The user_config keys a string uses. */
export function configKeysIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR))
    if (m[1]!.startsWith('user_config.')) out.push(m[1]!.slice(12));
  return out;
}

function variable(name: string, ctx: TemplateContext): BundleConfigValue | undefined {
  switch (name) {
    case '__dirname':
      return ctx.dir;
    case 'HOME':
      return ctx.home;
    case 'DESKTOP':
      return join(ctx.home, 'Desktop');
    case 'DOCUMENTS':
      return join(ctx.home, 'Documents');
    case 'DOWNLOADS':
      return join(ctx.home, 'Downloads');
    case 'pathSeparator':
    case '/':
      return sep;
  }
  if (name.startsWith('user_config.')) return ctx.values[name.slice(12)];
  return undefined;
}

/**
 * Expand one template string into argv elements. An element that is exactly one multi-valued
 * variable becomes one element per value; one that is exactly an unset variable is dropped.
 * Unknown variables stay as written.
 */
export function expandTemplate(text: string, ctx: TemplateContext): string[] {
  const whole = /^\$\{([^}]+)\}$/.exec(text);
  if (whole) {
    const v = variable(whole[1]!, ctx);
    if (v === undefined)
      return KNOWN.has(whole[1]!) || whole[1]!.startsWith('user_config.') ? [] : [text];
    return Array.isArray(v) ? [...v] : [String(v)];
  }
  return [
    text.replace(VAR, (m: string, name: string) => {
      const v = variable(name, ctx);
      if (v === undefined) return name.startsWith('user_config.') ? '' : m;
      return Array.isArray(v) ? v.join(' ') : String(v);
    }),
  ];
}

export interface BundleLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Indexes of `args` whose value holds a sensitive setting (kept in the vault). */
  secretArgs: number[];
  /** Names in `env` whose value holds a sensitive setting (kept in the vault). */
  secretEnv: string[];
}

export interface LaunchEnvironment {
  platform: NodeJS.Platform;
  home: string;
  /** The Node runtime Nova ships (node bundles run on it). */
  nodePath: string;
  /** Find a program on PATH; null when missing. */
  which: (program: string) => string | null;
}

/** `which` over PATH (executable files only). */
export function whichOnPath(program: string, path = process.env.PATH ?? ''): string | null {
  if (program.includes('/') || program.includes('\\'))
    return isAbsolute(program) && executable(program) ? program : null;
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = join(d, program + ext);
      if (executable(p)) return p;
    }
  }
  return null;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Problems that stop a bundle from running on this Hub (shown in the preview, enforced at install). */
export function compatibilityProblems(manifest: BundleManifest, env: LaunchEnvironment): string[] {
  const out: string[] = [];
  const platforms = manifest.compatibility.platforms;
  if (platforms && !platforms.includes(env.platform as BundlePlatform))
    out.push(
      `this bundle does not support ${env.platform} (it lists ${platforms.join(', ') || 'no platforms'})`,
    );
  const spec = launchFor(manifest, env.platform);
  if (manifest.server.type === 'uv' && !env.which('uv'))
    out.push('this bundle needs the uv tool, which is not installed on the Hub');
  if (manifest.server.type === 'python') {
    const cmd = spec.command;
    if (!cmd.includes('${') && !cmd.includes('/') && !env.which(cmd))
      out.push(`this bundle needs ${cmd}, which is not installed on the Hub`);
  }
  const nodeReq = manifest.compatibility.runtimes.node;
  if (manifest.server.type === 'node' && nodeReq) {
    const min = /^>=\s*v?(\d+)(?:\.(\d+))?/.exec(nodeReq.trim());
    const [maj = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (min && (maj < Number(min[1]) || (maj === Number(min[1]) && minor < Number(min[2] ?? 0))))
      out.push(`this bundle needs Node ${nodeReq}; the Hub runs ${process.versions.node}`);
  }
  return out;
}

function launchFor(manifest: BundleManifest, platform: NodeJS.Platform): BundleLaunchSpec {
  const base = manifest.server.mcpConfig;
  const o = base.platformOverrides[platform as BundlePlatform] ?? {};
  return {
    command: o.command ?? base.command,
    args: o.args ?? base.args ?? [],
    env: { ...(base.env ?? {}), ...(o.env ?? {}) },
  };
}

/**
 * The launch line for an installed bundle: templates expanded into argv elements (no shell), the
 * platform override applied, `node` mapped to the Hub's own runtime and a program inside the
 * bundle made executable. Throws when the bundle cannot run here.
 */
export function bundleLaunch(
  manifest: BundleManifest,
  dir: string,
  values: Record<string, BundleConfigValue>,
  env: LaunchEnvironment,
): BundleLaunch {
  const problems = compatibilityProblems(manifest, env);
  if (problems.length) fail(problems.join('; '));
  const sensitive = new Set(
    Object.entries(manifest.userConfig)
      .filter(([, e]) => e.sensitive)
      .map(([k]) => k),
  );
  const ctx: TemplateContext = { dir, home: env.home, values };
  const spec = launchFor(manifest, env.platform);
  const [command = ''] = expandTemplate(spec.command, ctx);
  if (!command) fail('the bundle has no command to run', 'server.mcp_config.command');
  const args: string[] = [];
  const secretArgs: number[] = [];
  for (const a of spec.args ?? []) {
    const secret = configKeysIn(a).some((k) => sensitive.has(k));
    for (const x of expandTemplate(a, ctx)) {
      if (secret) secretArgs.push(args.length);
      args.push(x);
    }
  }
  const outEnv: Record<string, string> = {};
  const secretEnv: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`environment variable ${k} is not a valid name`);
    outEnv[k] = expandTemplate(v, ctx).join(' ');
    if (configKeysIn(v).some((key) => sensitive.has(key))) secretEnv.push(k);
  }
  let resolved = command;
  if (manifest.server.type === 'node' && (command === 'node' || command === 'node.exe'))
    resolved = env.nodePath;
  else if (manifest.server.type === 'uv' && command === 'uv') resolved = env.which('uv') ?? command;
  else if (!command.includes('/') && !command.includes('\\'))
    resolved = env.which(command) ?? command;
  // A program shipped in the bundle (binary servers) is made executable after extraction.
  const abs = resolve(dir, resolved);
  const rel = relative(resolve(dir), abs);
  if (isAbsolute(resolved) && rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try {
      chmodSync(abs, 0o755);
    } catch {
      fail(`the program ${relative(dir, abs)} is not in the bundle`);
    }
  }
  return { command: resolved, args, env: outEnv, secretArgs, secretEnv };
}

/** Preview warnings about the manifest (sensitive values in args, unknown variables, …). */
export function manifestWarnings(manifest: BundleManifest): string[] {
  const out: string[] = [];
  const keys = new Set(Object.keys(manifest.userConfig));
  const sensitive = new Set(
    Object.entries(manifest.userConfig)
      .filter(([, e]) => e.sensitive)
      .map(([k]) => k),
  );
  const specs = [
    manifest.server.mcpConfig,
    ...Object.values(manifest.server.mcpConfig.platformOverrides),
  ];
  const leaked = new Set<string>();
  const unknown = new Set<string>();
  for (const s of specs) {
    for (const a of [s.command ?? '', ...(s.args ?? [])]) {
      for (const k of configKeysIn(a)) if (sensitive.has(k)) leaked.add(k);
      for (const v of unknownVariables(a, keys)) unknown.add(v);
    }
    for (const v of Object.values(s.env ?? {}))
      for (const u of unknownVariables(v, keys)) unknown.add(u);
  }
  for (const k of leaked)
    out.push(
      `${manifest.userConfig[k]!.title} is passed on the command line, where other programs on the Hub can see it`,
    );
  for (const v of unknown) out.push(`the launch line uses an unknown variable \${${v}}`);
  return out;
}
