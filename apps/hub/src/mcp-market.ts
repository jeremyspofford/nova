// MCP servers from the marketplace (FR-049 kind `mcp`, FR-042, FR-199; ADR-097 D2): a registry
// entry (a remote server's transport and URL) becomes an sse/http server, and an `.mcpb` bundle
// installs through the MCP area's own bundle installer, with the verdict the marketplace reached
// (its signed catalog and the bundle's checksum) as the bundle's signature status and `catalog` as
// its install record's source. An item is the MCP server whose name is the item id made a server
// name (`bundleServerName`), whatever added it, so an update shows a diff for a server added by
// hand too. Updates keep a bundle's earlier settings unless new ones are given; a failed install
// is rolled back to the earlier row and vault entries. Only the Hub's owner installs programs.
import { NovaError, type BundleConfigField, type MarketPermissionLine } from '@nova/shared';
import {
  mcpPermissionLines,
  ownerOnlyError,
  type MarketInspection,
  type MarketInstalledState,
  type MarketInstaller,
  type StagedArtifact,
} from '@nova/core';
import {
  bundleServerName,
  compatibilityProblems,
  manifestWarnings,
  parseManifest,
  readBundle,
  type BundleManifest,
  type LaunchEnvironment,
} from '@nova/mcp';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import type { McpServerRow } from './mcp.ts';

/** What the MCP area lends the installer (its own add, update, bundle install and removal). */
export interface McpMarketOps {
  db: NovaDatabase;
  secrets: Pick<SecretStore, 'list' | 'get' | 'put' | 'delete'>;
  launchEnv: LaunchEnvironment;
  byName(accountId: string, name: string): Promise<McpServerRow | null>;
  isOwner(accountId: string): boolean;
  assertPublicUrl(accountId: string, transport: string, url?: string | null): Promise<void>;
  createServer(
    accountId: string,
    body: { name: string; transport: 'http' | 'sse'; url: string; enabled: boolean },
  ): Promise<McpServerRow>;
  updateRemote(
    accountId: string,
    row: McpServerRow,
    change: { transport: 'http' | 'sse'; url: string; enabled: boolean; origin?: string },
  ): Promise<McpServerRow>;
  installBundle(
    accountId: string,
    input: {
      bytes: Uint8Array;
      userConfig: Record<string, unknown> | undefined;
      permissions: { network: string[]; fs: 'none' | 'read' | 'project' };
      confirmSideload: boolean;
      signature?: 'verified' | 'unverified';
      source?: 'file' | 'catalog';
      origin?: string;
      enabled?: boolean;
    },
  ): Promise<McpServerRow>;
  removeServer(accountId: string, row: McpServerRow): Promise<void>;
  restoreServer(row: McpServerRow): Promise<void>;
}

const serverName = (id: string) => bundleServerName(id);

function bundleLines(m: BundleManifest): MarketPermissionLine[] {
  return mcpPermissionLines({ program: m.server.type, tools: m.tools.map((t) => t.name) });
}

/** A bundle asks for folders or files: they are granted read-only (docs/08 §2.5). */
function wantsPaths(m: BundleManifest): boolean {
  return Object.values(m.userConfig).some((e) => e.type === 'directory' || e.type === 'file');
}

function storedManifest(row: McpServerRow): BundleManifest | null {
  if (row.source !== 'bundle' || !row.bundleManifestJson) return null;
  try {
    return parseManifest(JSON.parse(row.bundleManifestJson));
  } catch {
    return null;
  }
}

function rowLines(row: McpServerRow): MarketPermissionLine[] {
  const m = storedManifest(row);
  if (m) return bundleLines(m);
  if (row.url && (row.transport === 'http' || row.transport === 'sse'))
    return mcpPermissionLines({ transport: row.transport, url: row.url });
  return mcpPermissionLines({ program: row.command ?? 'a program' });
}

function taken(name: string): NovaError {
  return new NovaError(
    'conflict',
    `an MCP server named ${name} already exists; remove or rename it first`,
    { details: { reason: 'name_taken', server: name } },
  );
}

function bundleBytes(a: StagedArtifact): Uint8Array {
  if (a.format !== 'mcpb' || !a.bytes)
    throw new NovaError('validation', 'an MCP item must be a registry entry or an .mcpb bundle');
  return a.bytes;
}

export function mcpMarketInstaller(ops: McpMarketOps): MarketInstaller {
  /** A bundle's settings as the last install saved them (sensitive ones from the vault). */
  async function previousConfig(row: McpServerRow): Promise<Record<string, unknown>> {
    const m = storedManifest(row);
    let saved: Record<string, unknown> = {};
    try {
      const rec = JSON.parse(row.installRecordJson ?? '{}') as { userConfig?: unknown };
      if (rec.userConfig && typeof rec.userConfig === 'object')
        saved = rec.userConfig as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(saved)) {
      // Only the server's own vault entries are read back (never another reference).
      if (typeof v === 'string' && v.startsWith(`secret://mcp/${row.id}/config/`)) {
        const value = await ops.secrets.get(v);
        if (value === null) continue;
        if (m?.userConfig[k]?.multiple) {
          try {
            out[k] = JSON.parse(value) as unknown;
          } catch {
            out[k] = value;
          }
        } else out[k] = value;
      } else if (typeof v !== 'string' || !v.startsWith('secret://')) out[k] = v;
    }
    return out;
  }

  const versionOf = (row: McpServerRow) => storedManifest(row)?.version ?? null;

  return {
    kind: 'mcp',

    async inspect(accountId, artifact, entry): Promise<MarketInspection> {
      const name = serverName(entry.id);
      const existing = await ops.byName(accountId, name);
      if (artifact.server) {
        await ops.assertPublicUrl(accountId, artifact.server.transport, artifact.server.url);
        const clash = existing && (existing.source !== 'user' || existing.transport === 'stdio');
        return {
          id: entry.id,
          version: null,
          name: entry.name,
          permissions: mcpPermissionLines(artifact.server),
          details: {
            form: 'registry',
            serverName: name,
            transport: artifact.server.transport,
            url: artifact.server.url,
          },
          warnings: clash ? [taken(name).message] : [],
        };
      }
      const m = readBundle(Buffer.from(bundleBytes(artifact))).manifest;
      const fields: BundleConfigField[] = Object.entries(m.userConfig).map(([key, e]) => ({
        key,
        type: e.type,
        title: e.title,
        description: e.description ?? null,
        required: e.required,
        sensitive: e.sensitive,
        multiple: e.multiple,
        default: e.default ?? null,
      }));
      const warnings = [...compatibilityProblems(m, ops.launchEnv), ...manifestWarnings(m)];
      if (existing && storedManifest(existing)?.name !== m.name) warnings.push(taken(name).message);
      return {
        id: m.name,
        version: m.version,
        name: m.displayName ?? m.name,
        permissions: bundleLines(m),
        details: {
          form: 'bundle',
          serverName: bundleServerName(m.name),
          serverType: m.server.type,
          description: m.description,
          author: m.author,
          tools: m.tools,
          userConfig: fields,
          // What the install grants: no network, the chosen folders and files read-only.
          grants: { network: [], fs: wantsPaths(m) ? 'read' : 'none' },
        },
        warnings,
      };
    },

    async installed(accountId, id): Promise<MarketInstalledState | null> {
      const row = await ops.byName(accountId, serverName(id));
      if (!row || row.source === 'plugin') return null;
      return { version: versionOf(row), permissions: rowLines(row) };
    },

    list(accountId) {
      const rows = ops.db.raw
        .prepare(
          `SELECT name, source, bundle_manifest_json FROM mcp_server
           WHERE account_id = ? AND source <> 'plugin'`,
        )
        .all(accountId) as {
        name: string;
        source: McpServerRow['source'];
        bundle_manifest_json: string | null;
      }[];
      const byName = new Map<string, string | null>();
      for (const r of rows)
        byName.set(
          r.name,
          versionOf({
            source: r.source,
            bundleManifestJson: r.bundle_manifest_json,
          } as McpServerRow),
        );
      const out = new Map(byName);
      // Item ids that are not server names themselves: the marketplace's own records name them.
      const hasRecords =
        ops.db.raw
          .prepare(
            "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'market_install'",
          )
          .get() !== undefined;
      if (hasRecords)
        for (const r of ops.db.raw
          .prepare("SELECT item_id FROM market_install WHERE account_id = ? AND kind = 'mcp'")
          .all(accountId) as { item_id: string }[]) {
          const n = serverName(r.item_id);
          if (byName.has(n)) out.set(r.item_id, byName.get(n) ?? null);
        }
      return Promise.resolve(out);
    },

    async snapshot(accountId, id) {
      const name = serverName(id);
      const row = await ops.byName(accountId, name);
      // A plugin's server is never replaced (the install refuses), so there is nothing to undo.
      if (row?.source === 'plugin') return () => Promise.resolve();
      if (!row)
        return async () => {
          const now = await ops.byName(accountId, name);
          if (now && now.source !== 'plugin') await ops.removeServer(accountId, now);
        };
      const prefix = `secret://mcp/${row.id}/`;
      const saved = new Map<string, string>();
      for (const ref of await ops.secrets.list(prefix)) {
        const v = await ops.secrets.get(ref);
        if (v !== null) saved.set(ref, v);
      }
      return async () => {
        for (const ref of await ops.secrets.list(prefix))
          if (!saved.has(ref)) await ops.secrets.delete(ref);
        for (const [ref, v] of saved) await ops.secrets.put(ref, v);
        await ops.restoreServer(row);
      };
    },

    async install(req) {
      const { accountId, artifact, entry } = req;
      const name = serverName(entry.id);
      const existing = await ops.byName(accountId, name);
      if (artifact.server) {
        if (!existing) {
          await ops.createServer(accountId, {
            name,
            transport: artifact.server.transport,
            url: artifact.server.url,
            enabled: req.enable,
          });
          return;
        }
        if (existing.source !== 'user' || existing.transport === 'stdio') throw taken(name);
        await ops.updateRemote(accountId, existing, {
          transport: artifact.server.transport,
          url: artifact.server.url,
          enabled: req.enable,
          origin: req.origin,
        });
        return;
      }
      // A bundle is a program on the Hub machine: the owner's only (decision 5).
      if (!ops.isOwner(accountId)) throw ownerOnlyError('programs on the Hub machine');
      const bytes = bundleBytes(artifact);
      const m = readBundle(Buffer.from(bytes)).manifest;
      const userConfig =
        req.userConfig ??
        (existing?.source === 'bundle' ? await previousConfig(existing) : undefined);
      await ops.installBundle(accountId, {
        bytes,
        userConfig,
        permissions: { network: [], fs: wantsPaths(m) ? 'read' : 'none' },
        // The marketplace asked for the sideload confirmation of an unverified item already.
        confirmSideload: true,
        signature: req.verified ? 'verified' : 'unverified',
        source: 'catalog',
        origin: req.origin,
        enabled: req.enable,
      });
    },

    async remove(accountId, id) {
      const row = await ops.byName(accountId, serverName(id));
      if (!row) throw new NovaError('not_found', `${id} is not installed`);
      await ops.removeServer(accountId, row);
    },
  };
}
