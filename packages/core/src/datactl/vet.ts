// What an import cannot take on trust (FR-105, ADR-097 D5; the M8 data review #1, #2 and its
// hardening notes). An archive is checked for its integrity, not for who made it: an archive
// without a passphrase is not authenticated at all, and a sealed one only by a passphrase. So,
// on the staging database and before anything of the Hub's changes:
// - every `secret://` reference a row holds is found (any text column of any table, settings and
//   JSON included). One that names a key the Hub makes itself (`hub/`, `push/`, `relay/` but the
//   owner's Relay registration token) is refused outside the Hub's key tables, except a push
//   subscription's own derived reference; an archive without a passphrase may name only the
//   secrets its manifest lists to re-enter; and at apply time no reference may resolve to a secret
//   this Hub holds that the archive does not carry (it would hand that secret to the archive's
//   rows, such as a provider's address).
// - every path a row holds that the Hub reads, writes or deletes is where install or upload puts
//   it: plugin installs (`plugins/<id>/<version>` under this data folder, the manifest valid and
//   naming the same id and version), extension ids, ids that name folders, and blob paths (inside
//   the data folder's exported roots). Absolute paths under the exporting Hub's data folder are
//   first moved under this one.
// - what runs code or holds trust comes back off: stdio MCP servers, plugins (and the extensions
//   they carry) and external agent programs disabled, hooks untrusted, and every sign-in session
//   revoked (the importing one is put back by the import).
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NovaError } from '@nova/shared';
import { validatePluginManifest } from '../plugins/manifest.ts';
import { parseExtensionManifest } from '../sdk/manifest.ts';
import { LOG_TABLES, SECRET_REF_PATTERN, dataTables, quoteIdent, tableLines } from './codec.ts';
import { HUB_KEY_TABLES, hubMadeSecret } from './exporter.ts';
import { safeRelativePath } from './files.ts';

/** contracts/schemas/plugin-manifest.json `id` and `version`. */
export const PLUGIN_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const PLUGIN_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Ids the Hub uses as folder names under the data folder. */
const PATH_IDS: readonly (readonly [table: string, column: string])[] = [
  ['account', 'id'],
  ['computer', 'id'],
  ['code_session', 'id'],
  ['mcp_server', 'id'],
  ['session_handoff', 'id'],
  ['firmware_snapshot', 'id'],
];

/** Columns holding a path relative to the data folder (blobs, patches, snapshots, avatars). */
const BLOB_PATH_COLUMN = /(^|_)(blob_path|avatar_path|blob)$/;

const refuse = (message: string, reason: string, details: Record<string, unknown> = {}) =>
  new NovaError('validation', message, { details: { reason, ...details } });

function columns(db: DatabaseSync, table: string): { name: string; type: string }[] {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as {
    name: string;
    type: string;
  }[];
}

function textColumns(db: DatabaseSync, table: string): string[] {
  return columns(db, table)
    .filter((c) => /CHAR|CLOB|TEXT/i.test(c.type))
    .map((c) => c.name);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return columns(db, table).some((c) => c.name === column);
}

/** Move absolute paths under the exporting Hub's data folder to this one. Returns the cells changed. */
export function rewriteDataDir(db: DatabaseSync, from: string, to: string): number {
  const a = resolve(from);
  const b = resolve(to);
  if (a === b) return 0;
  let changed = 0;
  for (const t of dataTables(db)) {
    if (LOG_TABLES.includes(t.name)) continue;
    for (const c of textColumns(db, t.name)) {
      const q = `${quoteIdent(t.name)}`;
      const col = quoteIdent(c);
      changed += Number(
        db
          .prepare(`UPDATE ${q} SET ${col} = replace(${col}, ?, ?) WHERE instr(${col}, ?) > 0`)
          .run(`${a}/`, `${b}/`, `${a}/`).changes,
      );
      changed += Number(
        db.prepare(`UPDATE ${q} SET ${col} = ? WHERE ${col} = ?`).run(b, a).changes,
      );
    }
  }
  return changed;
}

/** Refuse rows whose paths would reach outside where the Hub keeps them. */
export function vetPaths(db: DatabaseSync, dataDir: string): void {
  const tables = new Set(dataTables(db).map((t) => t.name));
  for (const [table, column] of PATH_IDS) {
    if (!tables.has(table) || !hasColumn(db, table, column)) continue;
    const bad = db
      .prepare(
        `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)}
         WHERE typeof(${quoteIdent(column)}) <> 'text' OR ${quoteIdent(column)} IN ('', '.', '..')
           OR instr(${quoteIdent(column)}, '/') > 0 OR instr(${quoteIdent(column)}, char(92)) > 0
           OR instr(${quoteIdent(column)}, char(0)) > 0 OR length(${quoteIdent(column)}) > 200
         LIMIT 1`,
      )
      .get() as { v: unknown } | undefined;
    if (bad)
      throw refuse(`the archive's ${table} rows name an unsafe folder`, 'unsafe_path', {
        table,
        column,
      });
  }
  // Blob paths stay inside the data folder's exported roots, relative.
  for (const table of tables) {
    for (const column of columns(db, table)
      .map((c) => c.name)
      .filter((c) => BLOB_PATH_COLUMN.test(c))) {
      const rows = db
        .prepare(
          `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
        )
        .iterate() as Iterable<{ v: unknown }>;
      for (const r of rows)
        if (typeof r.v !== 'string' || !safeRelativePath(r.v))
          throw refuse(`the archive's ${table} rows name an unsafe file`, 'unsafe_path', {
            table,
            column,
          });
    }
  }
  // Plugins exactly as install leaves them: a valid manifest naming the row's id and version, in
  // `plugins/<id>/<version>` under this data folder.
  const pluginsDir = resolve(dataDir, 'plugins');
  if (tables.has('plugin_install'))
    for (const r of db
      .prepare('SELECT plugin_id, version, manifest_json, install_path FROM plugin_install')
      .all() as {
      plugin_id: string;
      version: string;
      manifest_json: string;
      install_path: string;
    }[]) {
      const where = { table: 'plugin_install', plugin: String(r.plugin_id).slice(0, 100) };
      if (!PLUGIN_ID.test(r.plugin_id) || !PLUGIN_VERSION.test(r.version))
        throw refuse('the archive names a plugin with an unsafe id', 'unsafe_path', where);
      let manifest: { id: string; version: string };
      try {
        manifest = validatePluginManifest(JSON.parse(r.manifest_json) as unknown);
      } catch {
        throw refuse('the archive holds a plugin with an invalid manifest', 'unsafe_path', where);
      }
      if (manifest.id !== r.plugin_id || manifest.version !== r.version)
        throw refuse("a plugin's manifest does not match its row", 'unsafe_path', where);
      if (resolve(r.install_path) !== join(pluginsDir, r.plugin_id, r.version))
        throw refuse('the archive puts a plugin outside the plugins folder', 'unsafe_path', where);
    }
  if (tables.has('extension_install'))
    for (const r of db.prepare('SELECT plugin_id, manifest_json FROM extension_install').all() as {
      plugin_id: string;
      manifest_json: string;
    }[]) {
      const where = { table: 'extension_install', plugin: String(r.plugin_id).slice(0, 100) };
      if (!PLUGIN_ID.test(r.plugin_id))
        throw refuse('the archive names an extension with an unsafe id', 'unsafe_path', where);
      try {
        parseExtensionManifest(JSON.parse(r.manifest_json) as unknown);
      } catch {
        throw refuse(
          'the archive holds an extension with an invalid manifest',
          'unsafe_path',
          where,
        );
      }
    }
}

/** A push subscription's own secret (the one row that may name a `push/` reference). */
function ownDerivedRef(table: string, row: Record<string, unknown>, ref: string): boolean {
  return table === 'push_subscription' && ref === `secret://push/${String(row.id)}/auth`;
}

/**
 * Every secret reference the rows hold outside the Hub's key tables; refuses the ones an archive
 * may not name (see the file comment). `toReEnter` is checked for an archive without a passphrase.
 */
export function vetSecretRefs(
  db: DatabaseSync,
  opts: { encrypted: boolean; toReEnter: readonly string[] },
): string[] {
  const listed = new Set(opts.toReEnter);
  const found = new Set<string>();
  for (const t of dataTables(db)) {
    if (HUB_KEY_TABLES.includes(t.name) || LOG_TABLES.includes(t.name)) continue;
    const cols = textColumns(db, t.name);
    if (!cols.length) continue;
    const where = cols.map((c) => `instr(${quoteIdent(c)}, 'secret://') > 0`).join(' OR ');
    for (const row of db
      .prepare(`SELECT * FROM ${quoteIdent(t.name)} WHERE ${where}`)
      .iterate() as Iterable<Record<string, unknown>>) {
      for (const c of cols) {
        const v = row[c];
        if (typeof v !== 'string' || !v.includes('secret://')) continue;
        for (const m of v.matchAll(SECRET_REF_PATTERN)) {
          const ref = m[0];
          if (hubMadeSecret(ref) && !ownDerivedRef(t.name, row, ref))
            throw refuse(
              `the archive's ${t.name} rows name one of the Hub's own keys`,
              'foreign_secret',
              { table: t.name },
            );
          if (!opts.encrypted && !listed.has(ref))
            throw refuse(
              `the archive's ${t.name} rows name a secret it does not list`,
              'foreign_secret',
              { table: t.name },
            );
          found.add(ref);
        }
      }
    }
  }
  return [...found].sort();
}

export interface RestoredOff {
  mcpServers: number;
  plugins: number;
  agentAdapters: number;
  hooks: number;
  sessions: number;
}

/** Turn off what runs code or holds trust, and revoke the sign-in sessions. */
export function restoreOff(db: DatabaseSync, now: string): RestoredOff {
  const tables = new Set(dataTables(db).map((t) => t.name));
  const run = (table: string, sql: string, ...args: string[]) =>
    tables.has(table) ? Number(db.prepare(sql).run(...args).changes) : 0;
  return {
    mcpServers: run(
      'mcp_server',
      "UPDATE mcp_server SET enabled = 0 WHERE transport = 'stdio' AND enabled <> 0",
    ),
    plugins: run('plugin_install', 'UPDATE plugin_install SET enabled = 0 WHERE enabled <> 0'),
    agentAdapters: run('agent_adapter', 'UPDATE agent_adapter SET enabled = 0 WHERE enabled <> 0'),
    hooks: run(
      'hook',
      `UPDATE hook SET trust_state = 'needs_trust', trusted_hash = NULL, trusted_by = NULL,
         trusted_at = NULL WHERE trust_state <> 'needs_trust' OR trusted_hash IS NOT NULL`,
    ),
    sessions: run(
      'auth_token',
      "UPDATE auth_token SET revoked_at = ? WHERE kind = 'session' AND revoked_at IS NULL",
      now,
    ),
  };
}

/** Every table's rows and SHA-256 as an export would write them. */
export function tableHashes(db: DatabaseSync): Map<string, { rows: number; sha256: string }> {
  const out = new Map<string, { rows: number; sha256: string }>();
  for (const t of dataTables(db)) {
    const hash = createHash('sha256');
    let rows = 0;
    for (const line of tableLines(db, t)) {
      hash.update(line);
      rows++;
    }
    out.set(t.name, { rows, sha256: hash.digest('hex') });
  }
  return out;
}
