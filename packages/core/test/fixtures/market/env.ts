// Shared set-up for the marketplace tests (FR-049): a migrated database with an account, catalogs
// written into temp folders and signed with test keys, plugin, skill, theme and pet folders,
// `.novax` bundles in the D2 format, and a Marketplace wired to the real plugin installer and
// skill index with an in-memory theme store and a fake MCP installer.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketItemKind } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { MemoryEventSink } from '../../../src/events.ts';
import { writeZip } from '../../../src/documents/zip.ts';
import {
  Marketplace,
  MarketSources,
  PetMarketInstaller,
  PluginMarketInstaller,
  SkillMarketInstaller,
  ThemeMarketInstaller,
  folderDigest,
  mcpPermissionLines,
  signCatalogIndex,
  type MarketCatalogConfig,
  type MarketInstaller,
  type MarketPolicy,
  type TrustedPublisherKey,
} from '../../../src/market/index.ts';
import { sha256Hex } from '../../../src/market/signing.ts';
import { EXTENSION_SIGNATURE_FILE, extensionDigest } from '../../../src/sdk/bundle.ts';
import { EXTENSION_SIGNATURE_CONTEXT, publisherKeyOf, signDigest } from '../../../src/sdk/keys.ts';
import { PluginCatalogs, type GitRunner } from '../../../src/plugins/catalog.ts';
import { managedRestrictions } from '../../../src/managed/restrictions.ts';
import { PluginService } from '../../../src/plugins/service.ts';
import { SkillIndex } from '../../../src/plugins/skills.ts';
import { ExtensionService } from '../../../src/sdk/service.ts';
import type { AuditRecord } from '../../../src/tools/types.ts';

export const ACCOUNT = '01920000-0000-7000-8000-00000000a001';
export const SAMPLE_CATALOG = fileURLToPath(
  new URL('../../../../../examples/catalog/', import.meta.url),
);
export async function openMarketDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const ts = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, ts, ts);
  return db;
}

/** Write `catalog.json` (and its signature when a key is given) into `dir`. */
export function writeCatalog(
  dir: string,
  index: { name?: string; plugins?: unknown[]; items?: unknown[] },
  key?: KeyObject,
): Uint8Array {
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ...index }, null, 2));
  writeFileSync(join(dir, 'catalog.json'), bytes);
  if (key) writeFileSync(join(dir, 'catalog.json.sig'), signCatalogIndex(bytes, key));
  return bytes;
}

export interface PluginSpec {
  id?: string;
  version?: string;
  network?: string[];
  fs?: string[];
  tools?: Record<string, { action: string; default?: string }>;
  hooks?: boolean;
}

/** A small plugin folder: one skill, optional network and hook. */
export function pluginFolder(root: string, spec: PluginSpec = {}): string {
  const id = spec.id ?? 'com.test.notes';
  mkdirSync(join(root, '.nova-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'take-notes'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'take-notes', 'SKILL.md'),
    '---\nname: take-notes\ndescription: Take short notes of what the user says.\n---\nWrite three bullets.\n',
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    name: 'Notes',
    version: spec.version ?? '1.0.0',
    description: 'Takes notes.',
    author: { name: 'Test publisher' },
    permissions: {
      ...(spec.network ? { network: spec.network } : {}),
      ...(spec.fs ? { fs: spec.fs } : {}),
      ...(spec.tools ? { tools: spec.tools } : {}),
    },
    skills: ['skills/take-notes'],
  };
  if (spec.hooks) {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: [
          {
            id: 'log-prompt',
            event: 'prompt.submit',
            handler: { type: 'command', command: ['node', 'hooks/log.mjs'] },
          },
        ],
      }),
    );
    writeFileSync(join(root, 'hooks', 'log.mjs'), 'process.exit(0);\n');
    manifest.hooks = 'hooks/hooks.json';
  }
  writeFileSync(join(root, '.nova-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  return root;
}

export function skillFolder(root: string, name: string, allowedTools: string[] = []): string {
  mkdirSync(root, { recursive: true });
  const tools = allowedTools.length ? `allowed_tools: [${allowedTools.join(', ')}]\n` : '';
  writeFileSync(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A test skill called ${name}.\n${tools}---\nDo the thing.\n`,
  );
  return root;
}

export function themeFile(file: string, id = 'com.test.dusk', accent = '#ff8800'): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Dusk',
      variant: 'dark',
      tokens: { '--u-bg': '#101010', '--u-accent': accent },
    }),
  );
  return file;
}

export function petFolder(root: string, id = 'com.test.owl', version = '1.0.0'): string {
  mkdirSync(join(root, 'frames'), { recursive: true });
  for (const f of ['idle-1.png', 'idle-2.png', 'thinking-1.webp'])
    writeFileSync(join(root, 'frames', f), Buffer.from(`frame ${f}`));
  writeFileSync(
    join(root, 'pet.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Owl',
      version,
      states: {
        idle: { frames: ['frames/idle-1.png', 'frames/idle-2.png'], fps: 4 },
        thinking: { frames: ['frames/thinking-1.webp'] },
      },
    }),
  );
  return root;
}

function filesOf(root: string): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([relative(root, full).split(sep).join('/'), readFileSync(full)]);
    }
  };
  walk(root);
  return out;
}

/** A zip of a folder (its files at the archive root, or under `prefix`). */
export function zipOf(root: string, prefix = ''): Uint8Array {
  return writeZip(
    filesOf(root).map(([p, b]) => [prefix + p, b]),
    new Date('2026-10-01T00:00:00Z'),
  );
}

/**
 * A `.novax` bundle of a plugin folder written by hand from the D2 format (so the SDK's reader is
 * checked against the format, not against itself): every file, plus `META-INF/nova-signature.json`
 * when a key is given. `tamper` adds a file after signing.
 */
export function makeNovax(
  root: string,
  key?: { privateKey: KeyObject; publicKey: string },
  tamper = false,
): Uint8Array {
  const parts = filesOf(root);
  if (key) {
    const digest = extensionDigest(parts);
    parts.push([
      EXTENSION_SIGNATURE_FILE,
      Buffer.from(
        JSON.stringify({
          v: 1,
          publisher: key.publicKey,
          digest,
          signature: signDigest(EXTENSION_SIGNATURE_CONTEXT, digest, key.privateKey),
        }),
      ),
    ]);
  }
  // A file added after signing is not covered by the digest.
  if (tamper) parts.push(['extra.txt', Buffer.from('added after signing')]);
  return writeZip(parts, new Date('2026-10-01T00:00:00Z'));
}

export { folderDigest, sha256Hex };

/** A publisher key pair for a test. */
export function testPublisher(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publisherKeyOf(privateKey) };
}

/** A fake MCP installer: what the Hub's MCP area provides through the same interface. */
export function fakeMcpInstaller(): MarketInstaller & { servers: Map<string, string> } {
  const servers = new Map<string, string>();
  return {
    kind: 'mcp',
    servers,
    inspect(_a, artifact, entry) {
      const permissions = artifact.server
        ? mcpPermissionLines(artifact.server)
        : mcpPermissionLines({ program: 'node' });
      return Promise.resolve({
        id: entry.id,
        version: null,
        name: entry.name,
        permissions,
        details: { form: artifact.server ? 'registry' : 'bundle' },
        warnings: [],
      });
    },
    installed: (_a, id) =>
      Promise.resolve(servers.has(id) ? { version: servers.get(id)!, permissions: [] } : null),
    list: () => Promise.resolve(new Map([...servers].map(([k, v]) => [k, v]))),
    snapshot: (_a, id) => {
      const had = servers.get(id);
      return Promise.resolve(() => {
        if (had === undefined) servers.delete(id);
        else servers.set(id, had);
        return Promise.resolve();
      });
    },
    install: (req) => {
      servers.set(req.entry.id, req.entry.version);
      return Promise.resolve();
    },
    remove: (_a, id) => {
      servers.delete(id);
      return Promise.resolve();
    },
  };
}

export interface MarketEnv {
  db: NovaDatabase;
  market: Marketplace;
  plugins: PluginService;
  skills: SkillIndex;
  themes: Record<string, unknown>[];
  pets: PetMarketInstaller;
  mcp: ReturnType<typeof fakeMcpInstaller>;
  events: MemoryEventSink;
  audit: AuditRecord[];
  catalogs: MarketCatalogConfig[];
  trusted: TrustedPublisherKey[];
  /**
   * `unverified: false` is managed policy's `restrict.unverifiedInstalls: false`, for the
   * marketplace and the plugin installer alike; `managedUnverified` sets the plugin installer's
   * alone (null: the same as `unverified`).
   */
  policy: {
    unverified: boolean;
    sideload: boolean;
    kinds: MarketItemKind[];
    managedUnverified: boolean | null;
  };
  clock: { now: number };
  installers: Record<MarketItemKind, MarketInstaller>;
  /** Every fetch and git call attempted without a fake (none should be). */
  network: string[];
  /** The extension installer, when `extensions: true`. */
  extensions: ExtensionService | null;
}

export function marketEnv(
  dir: string,
  db: NovaDatabase,
  opts: {
    fetch?: typeof fetch;
    git?: GitRunner;
    failThemeWrite?: () => boolean;
    /** Wire a real extension installer (workers stay off: `sdk.enabled` reads false). */
    extensions?: boolean;
  } = {},
): MarketEnv {
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const log = new Logger({ module: 'test', sinks: [] });
  const clock = { now: Date.parse('2026-10-19T09:00:00Z') };
  const network: string[] = [];
  const policy: MarketEnv['policy'] = {
    unverified: true,
    sideload: true,
    kinds: ['plugin', 'skill', 'theme', 'pet', 'mcp'],
    managedUnverified: null,
  };
  const catalogs = new PluginCatalogs({
    cacheDir: join(dir, 'data', 'cache', 'plugins'),
    fetch:
      opts.fetch ??
      ((url: string | URL | Request) => {
        network.push(url instanceof Request ? url.url : url.toString());
        return Promise.reject(new Error('no network in this test'));
      }),
    git:
      opts.git ??
      ((args) => {
        network.push(`git ${args.join(' ')}`);
        return Promise.reject(new Error('no git in this test'));
      }),
    now: () => clock.now,
  });
  const skills = new SkillIndex({ db, userDir: join(dir, 'data', 'skills'), events });
  const secrets = new MemorySecretStore();
  const plugins = new PluginService({
    db,
    secrets,
    dataDir: join(dir, 'data'),
    catalogs,
    catalogConfigs: () => Promise.resolve([]),
    skills,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    novaVersion: '0.8.0',
    log,
    now: () => new Date(clock.now),
    // Managed policy as the plugin installer reads it (FR-106): `policy.unverified = false` is
    // `restrict.unverifiedInstalls: false`.
    managed: () =>
      Promise.resolve(
        managedRestrictions({
          layers:
            (policy.managedUnverified ?? policy.unverified) ? [] : [{ unverifiedInstalls: false }],
          failClosed: null,
        }),
      ),
  });
  const backupsDir = join(dir, 'data', 'cache', 'market', 'backups');
  const themes: Record<string, unknown>[] = [];
  const pets = new PetMarketInstaller({ dir: join(dir, 'data', 'market', 'pets'), backupsDir });
  const mcp = fakeMcpInstaller();
  const trusted: TrustedPublisherKey[] = [];
  const pluginInstaller = new PluginMarketInstaller({
    service: plugins,
    db,
    backupsDir,
    novaVersion: '0.8.0',
  });
  const extensions = opts.extensions
    ? new ExtensionService({
        db,
        secrets,
        dataDir: join(dir, 'data'),
        plugins,
        // The same trusted publishers as the marketplace's; workers never start in these tests.
        settings: {
          enabled: () => Promise.resolve(false),
          trustedPublishers: () =>
            Promise.resolve(trusted.map((t) => ({ name: t.name ?? t.key, key: t.key }))),
        },
        events,
        audit: { append: (r) => (audit.push(r), Promise.resolve()) },
        novaVersion: '0.8.0',
      })
    : null;
  pluginInstaller.useExtensions(extensions);
  const installers: Record<MarketItemKind, MarketInstaller> = {
    plugin: pluginInstaller,
    skill: new SkillMarketInstaller({
      index: skills,
      userDir: join(dir, 'data', 'skills'),
      backupsDir,
    }),
    theme: new ThemeMarketInstaller({
      read: () => Promise.resolve(themes.map((t) => ({ ...t }))),
      write: (_a, next) => {
        if (opts.failThemeWrite?.()) return Promise.reject(new Error('the settings write failed'));
        themes.splice(0, themes.length, ...next);
        return Promise.resolve();
      },
    }),
    pet: pets,
    mcp,
  };
  const marketPolicy: MarketPolicy = {
    unverifiedAllowed: () => Promise.resolve(policy.unverified),
    sideloadEnabled: () => Promise.resolve(policy.sideload),
    allowedKinds: () => Promise.resolve(policy.kinds),
  };
  const catalogConfigs: MarketCatalogConfig[] = [];
  const market = new Marketplace({
    db,
    sources: new MarketSources({ catalogs, now: () => clock.now }),
    catalogConfigs: () => Promise.resolve(catalogConfigs),
    trustedPublishers: () => Promise.resolve(trusted),
    installers,
    workDir: join(dir, 'data', 'cache', 'market'),
    policy: marketPolicy,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    log,
    now: () => new Date(clock.now),
  });
  return {
    db,
    market,
    plugins,
    skills,
    themes,
    pets,
    mcp,
    events,
    audit,
    catalogs: catalogConfigs,
    trusted,
    policy,
    clock,
    installers,
    network,
    extensions,
  };
}
