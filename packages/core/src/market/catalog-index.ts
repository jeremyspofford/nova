// The marketplace's catalog index (FR-049; docs/08 §7, docs/14 §5): the M4 `catalog.json` (or
// `nova-catalog.json`) with its `plugins` list, plus `items` of every kind and the card fields
// (author, publisher, categories, screenshots, changelog, declared permissions and components).
// An entry's artifact is a folder or file inside the catalog (`path`), a file next to a remote
// index (`url`), or a folder of another Git repository pinned to a commit (`repo` + `commit`).
// `sha256` is the SHA-256 of a file artifact's bytes; `digest` is a folder artifact's D2 digest
// (SHA-256 over its sorted `"<path>\n<sha256>\n"` lines). They are separate fields because the
// M4 reader already gives `sha256` the meaning of an archive checksum.
import { z } from 'zod';
import { NovaError, MARKET_KINDS, type MarketItemKind } from '@nova/shared';
import { publisherKeySchema } from './signing.ts';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REL = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !p.includes('\0'), 'invalid path');

export const ARTIFACT_FORMATS = ['folder', 'zip', 'novax', 'json', 'mcpb', 'registry'] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

const permissionsSchema = z
  .object({
    network: z.array(z.string().max(300)).max(100).optional(),
    fs: z.array(z.string().max(300)).max(100).optional(),
    secrets: z.array(z.string().max(300)).max(100).optional(),
    tools: z
      .record(
        z.string().max(300),
        z.object({ action: z.string().max(20), default: z.string().max(10).optional() }),
      )
      .optional(),
    actionDefaults: z.record(z.string().max(20), z.string().max(10)).optional(),
    hooks: z.object({ answersAsks: z.boolean().optional() }).optional(),
    browserExtensions: z.array(z.string().max(100)).max(20).optional(),
    ui: z
      .object({
        connectDomains: z.array(z.string().max(300)).max(50).optional(),
        resourceDomains: z.array(z.string().max(300)).max(50).optional(),
        frameDomains: z.array(z.string().max(300)).max(50).optional(),
      })
      .optional(),
  })
  .loose();

const entryFields = {
  id: z.string().regex(ITEM_ID),
  name: z.string().min(1).max(100),
  version: z.string().regex(SEMVER),
  description: z.string().max(500).optional(),
  author: z.string().max(100).optional(),
  /** The key that signs the item's bundle (`.novax`); its name for display. */
  publisher: z
    .object({ name: z.string().max(100).optional(), key: publisherKeySchema.optional() })
    .optional(),
  categories: z.array(z.string().min(1).max(40)).max(10).optional(),
  homepage: z.url().max(500).optional(),
  screenshots: z.array(REL).max(8).optional(),
  changelog: z
    .array(
      z.object({
        version: z.string().regex(SEMVER),
        date: z.string().max(40).optional(),
        notes: z.string().max(4000),
      }),
    )
    .max(50)
    .optional(),
  permissions: permissionsSchema.optional(),
  components: z
    .object({
      hooks: z
        .array(z.object({ id: z.string().max(100), event: z.string().max(50) }))
        .max(50)
        .optional(),
      roles: z.array(z.string().max(100)).max(50).optional(),
      browserExtensions: z.array(z.string().max(100)).max(20).optional(),
      uiEntryPoints: z
        .array(z.object({ kind: z.string().max(20), title: z.string().max(100).optional() }))
        .max(20)
        .optional(),
    })
    .optional(),
  format: z.enum(ARTIFACT_FORMATS).optional(),
  path: REL.optional(),
  url: z.string().min(1).max(2000).optional(),
  repo: z.string().min(1).max(1000).optional(),
  commit: z.string().regex(COMMIT).optional(),
  sha256: z.string().regex(SHA256).optional(),
  digest: z.string().regex(SHA256).optional(),
  /** An MCP registry entry: a remote server (docs/14 §5). */
  server: z.object({ transport: z.enum(['http', 'sse']), url: z.url().max(2000) }).optional(),
  compat: z.object({ nova: z.string().max(50).optional() }).optional(),
};

function located(e: {
  path?: string;
  url?: string;
  repo?: string;
  commit?: string;
  server?: unknown;
}) {
  if (e.repo !== undefined) return e.commit !== undefined;
  return e.path !== undefined || e.url !== undefined || e.server !== undefined;
}

const pluginEntrySchema = z
  .object(entryFields)
  .refine(located, 'an entry needs path, url, server, or repo with commit');
const itemEntrySchema = z
  .object({ kind: z.enum(MARKET_KINDS), ...entryFields })
  .refine(located, 'an entry needs path, url, server, or repo with commit');

export const marketIndexSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  name: z.string().max(100).optional(),
  plugins: z.array(pluginEntrySchema).max(1000).default([]),
  items: z.array(itemEntrySchema).max(5000).default([]),
});

export type MarketIndexEntry = z.infer<typeof itemEntrySchema>;

export interface MarketIndex {
  name: string | null;
  entries: MarketIndexEntry[];
}

/** Parse index bytes; `plugins` entries become `kind: 'plugin'` items. */
export function parseMarketIndex(bytes: Uint8Array, where: string): MarketIndex {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new NovaError('validation', `${where}: the catalog index is not valid JSON`);
  }
  const r = marketIndexSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new NovaError(
      'validation',
      `${where}: ${i?.path.join('.') || 'index'} ${i?.message ?? 'invalid'}`,
    );
  }
  return {
    name: r.data.name ?? null,
    entries: [...r.data.plugins.map((p) => ({ kind: 'plugin' as const, ...p })), ...r.data.items],
  };
}

/** The checksum the index lists for an entry's artifact: a folder's digest or a file's SHA-256. */
export function expectedChecksum(e: MarketIndexEntry): string | null {
  return (artifactFormat(e) === 'folder' ? e.digest : e.sha256) ?? null;
}

/** The artifact format of an entry: as declared, else from its location. */
export function artifactFormat(e: MarketIndexEntry): ArtifactFormat {
  if (e.format) return e.format;
  if (e.server && !e.path && !e.url) return 'registry';
  const loc = (e.url ?? e.path ?? '').toLowerCase().replace(/[?#].*$/, '');
  if (loc.endsWith('.novax')) return 'novax';
  if (loc.endsWith('.mcpb')) return 'mcpb';
  if (loc.endsWith('.zip')) return 'zip';
  if (loc.endsWith('.json')) return 'json';
  // A remote entry is always a file; a local or Git one without an extension is a folder.
  return e.url ? 'zip' : 'folder';
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  // A release sorts after its pre-releases.
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1);
}

/** The entry for an item: the requested version, or the highest one. */
export function pickMarketEntry(
  entries: readonly MarketIndexEntry[],
  kind: MarketItemKind,
  id: string,
  version?: string,
): MarketIndexEntry | null {
  const all = entries.filter((e) => e.kind === kind && e.id === id);
  if (version) return all.find((e) => e.version === version) ?? null;
  return [...all].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}
