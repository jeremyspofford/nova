// The hook table (migration 0012_hooks; docs/06 `hook`): one row per hook found in a source, with
// its trust record. Rows are kept in step with the hooks files by `sync`; trust is stored here,
// never in a hooks file (hook-config.json#/$defs/trustRecord). Raw statements keep this module
// independent of the Drizzle schema file.
import { NovaError, uuidv7, type HookEvent, type HookView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { matcherList, type HookDefinition, type HookSource } from './config.ts';

export type HookTrustState = 'needs_trust' | 'trusted' | 'revoked';
export type HookEffect = NonNullable<HookView['lastRun']>['effect'];

/** What a plugin allowed its hooks at install (contracts/schemas/plugin-manifest.json). */
export interface PluginHookLimits {
  /** Hosts the plugin may reach; a plugin hook's declared hosts are cut down to these. */
  network: string[];
  /** The plugin's `fs` permissions include `${project}`: its hooks see the session's roots. */
  fsProject: boolean;
  /** `permissions.hooks.answersAsks` (docs/08 §3.1). */
  answersAsks: boolean;
}

export interface HookRow {
  id: string;
  accountId: string;
  key: string;
  event: HookEvent;
  source: HookSource;
  pluginId: string | null;
  projectId: string | null;
  definition: HookDefinition;
  baseDir: string | null;
  limits: PluginHookLimits | null;
  contentHash: string;
  trustedHash: string | null;
  trustState: HookTrustState;
  trustedBy: string | null;
  trustedAt: string | null;
  timeoutMs: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastEffect: HookEffect | null;
  createdAt: string;
  updatedAt: string;
}

/** A hook as a source currently defines it. */
export interface DiscoveredHook {
  source: HookSource;
  pluginId: string | null;
  projectId: string | null;
  definition: HookDefinition;
  baseDir: string | null;
  limits: PluginHookLimits | null;
  contentHash: string;
  timeoutMs: number;
}

/** Which rows a sync replaces: everything of these sources (and plugin or projects). */
export interface HookSyncScope {
  source: HookSource;
  /** Plugin hooks: only this plugin's rows. */
  pluginId?: string;
  /** Project hooks: only these projects' rows. */
  projectIds?: string[];
}

export interface HookTrustChange {
  hookId: string;
  status: HookView['status'];
}

interface RawRow {
  id: string;
  account_id: string;
  hook_key: string;
  event: string;
  source: string;
  plugin_id: string | null;
  project_id: string | null;
  definition_json: string;
  base_dir: string | null;
  limits_json: string | null;
  content_hash: string;
  trusted_hash: string | null;
  trust_state: string;
  trusted_by: string | null;
  trusted_at: string | null;
  timeout_ms: number;
  enabled: number;
  last_run_at: string | null;
  last_effect: string | null;
  created_at: string;
  updated_at: string;
}

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function fromRaw(r: RawRow): HookRow {
  return {
    id: r.id,
    accountId: r.account_id,
    key: r.hook_key,
    event: r.event as HookEvent,
    source: r.source as HookSource,
    pluginId: r.plugin_id,
    projectId: r.project_id,
    definition: parse<HookDefinition>(r.definition_json, {
      id: r.hook_key,
      event: r.event as HookEvent,
      handler: { type: 'command', command: ['false'] },
    }),
    baseDir: r.base_dir,
    limits: parse<PluginHookLimits | null>(r.limits_json, null),
    contentHash: r.content_hash,
    trustedHash: r.trusted_hash,
    trustState: r.trust_state as HookTrustState,
    trustedBy: r.trusted_by,
    trustedAt: r.trusted_at,
    timeoutMs: r.timeout_ms,
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at,
    lastEffect: r.last_effect as HookEffect | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The status the Settings list shows; only `trusted` runs (docs/06 §6 invariant 13). */
export function hookStatus(row: HookRow): HookView['status'] {
  if (!row.enabled || row.definition.enabled === false) return 'disabled';
  if (row.source === 'managed') return 'trusted';
  if (row.trustState === 'revoked') return 'revoked';
  if (row.trustState === 'trusted' && row.trustedHash === row.contentHash) return 'trusted';
  return 'needs_trust';
}

/**
 * A hook's canonical id, its name in the trust list, events and audit (docs/08 §8):
 * `hook:<origin>.<hookId>` with origin `managed`, `user`, a plugin id or an extension id. Project
 * hooks carry their project (`hook:project:<projectId>.<hookId>`): two projects may use one id.
 */
export function hookRef(r: {
  source: HookSource;
  pluginId: string | null;
  projectId: string | null;
  key: string;
}): string {
  if (r.source === 'plugin' || r.source === 'extension')
    return `hook:${r.pluginId ?? r.source}.${r.key}`;
  if (r.source === 'project') return `hook:project:${r.projectId ?? ''}.${r.key}`;
  return `hook:${r.source}.${r.key}`;
}

export function hookView(row: HookRow): HookView {
  const def = row.definition;
  const globs = matcherList(def);
  return {
    id: hookRef(row),
    source: row.source,
    pluginId: row.pluginId,
    event: row.event,
    matcher: globs.length ? globs.join(', ') : null,
    handler:
      def.handler.type === 'command'
        ? { type: 'command', command: [...def.handler.command] }
        : { type: 'mcp_tool', tool: def.handler.tool },
    timeoutMs: row.timeoutMs,
    contentHash: row.contentHash,
    status: hookStatus(row),
    enabled: row.enabled && def.enabled !== false,
    lastRun: row.lastRunAt ? { at: row.lastRunAt, effect: row.lastEffect ?? 'none' } : null,
    projectId: row.projectId,
    changedSinceTrust: row.trustedHash !== null && row.trustedHash !== row.contentHash,
  };
}

function sameIdentity(
  r: HookRow,
  d: { source: HookSource; pluginId: string | null; projectId: string | null; key: string },
) {
  return (
    r.source === d.source &&
    r.pluginId === d.pluginId &&
    r.projectId === d.projectId &&
    r.key === d.key
  );
}

function definitionJson(def: HookDefinition): string {
  const { enabled: _enabled, ...rest } = def;
  return JSON.stringify(def.enabled === false ? { ...rest, enabled: false } : rest);
}

export class HookStore {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;

  constructor(db: NovaDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /** Whether migration 0012 is applied (the area degrades to no hooks without it). */
  available(): boolean {
    const row = this.#db.raw
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'hook'")
      .get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  list(accountId: string): HookRow[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM hook WHERE account_id = ? ORDER BY source, hook_key, id')
      .all(accountId) as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /** A hook by its canonical id (`hookRef`) or its row id. */
  get(accountId: string, ref: string): HookRow {
    const row = this.#db.raw
      .prepare('SELECT * FROM hook WHERE account_id = ? AND id = ?')
      .get(accountId, ref) as unknown as RawRow | undefined;
    const found = row ? fromRaw(row) : this.list(accountId).find((r) => hookRef(r) === ref);
    if (!found) throw new NovaError('not_found', 'hook not found');
    return found;
  }

  #inScope(accountId: string, scope: HookSyncScope): HookRow[] {
    return this.list(accountId).filter((r) => {
      if (r.source !== scope.source) return false;
      if (scope.pluginId !== undefined && r.pluginId !== scope.pluginId) return false;
      if (scope.projectIds !== undefined && !scope.projectIds.includes(r.projectId ?? ''))
        return false;
      return true;
    });
  }

  /**
   * Make the rows of `scope` match what the source defines now: new hooks are added as
   * `needs_trust` (managed ones as trusted by policy), a changed content hash puts a trusted hook
   * back to `needs_trust`, and hooks that are gone are removed. `trust` names hooks (by preview
   * id or key) the user trusted while installing, with the hash they saw. Returns the trust
   * changes to announce.
   */
  async sync(
    accountId: string,
    scope: HookSyncScope,
    found: DiscoveredHook[],
    trust: { key: string; contentHash: string; by: string }[] = [],
  ): Promise<HookTrustChange[]> {
    return this.#db.transaction(() => {
      const now = this.#now().toISOString();
      const existing = this.#inScope(accountId, scope);
      const changes: HookTrustChange[] = [];
      const kept = new Set<string>();
      for (const d of found) {
        const key = d.definition.id;
        const row = existing.find((r) => sameIdentity(r, { ...d, key }));
        const managed = d.source === 'managed';
        const t = trust.find((x) => x.key === key && x.contentHash === d.contentHash);
        if (!row) {
          const id = uuidv7();
          const state: HookTrustState = managed || t ? 'trusted' : 'needs_trust';
          this.#db.raw
            .prepare(
              `INSERT INTO hook (id, account_id, hook_key, event, matcher_json, handler_kind,
                 handler_json, fail_closed, source, plugin_id, project_id, definition_json,
                 base_dir, limits_json, content_hash, trusted_hash, trust_state, trusted_by,
                 trusted_at, timeout_ms, enabled, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              id,
              accountId,
              key,
              d.definition.event,
              d.definition.matcher === undefined ? null : JSON.stringify(matcherList(d.definition)),
              d.definition.handler.type,
              JSON.stringify(d.definition.handler),
              d.definition.failClosed ? 1 : 0,
              d.source,
              d.pluginId,
              d.projectId,
              definitionJson(d.definition),
              d.baseDir,
              d.limits ? JSON.stringify(d.limits) : null,
              d.contentHash,
              state === 'trusted' ? d.contentHash : null,
              state,
              managed ? 'managed' : (t?.by ?? null),
              state === 'trusted' ? now : null,
              d.timeoutMs,
              now,
              now,
            );
          kept.add(id);
          if (!managed)
            changes.push({
              hookId: hookRef({ ...d, key }),
              status: state === 'trusted' ? 'trusted' : 'needs_trust',
            });
          continue;
        }
        kept.add(row.id);
        const defJson = definitionJson(d.definition);
        const limitsJson = d.limits ? JSON.stringify(d.limits) : null;
        const same =
          row.contentHash === d.contentHash &&
          definitionJson(row.definition) === defJson &&
          row.baseDir === d.baseDir &&
          (row.limits ? JSON.stringify(row.limits) : null) === limitsJson &&
          row.timeoutMs === d.timeoutMs;
        if (same && !managed && !t) continue;
        let state = row.trustState;
        let trustedHash = row.trustedHash;
        let trustedBy = row.trustedBy;
        let trustedAt = row.trustedAt;
        if (managed) {
          state = 'trusted';
          trustedHash = d.contentHash;
          trustedBy = 'managed';
          trustedAt ??= now;
        } else if (t) {
          state = 'trusted';
          trustedHash = d.contentHash;
          trustedBy = t.by;
          trustedAt = now;
        } else if (row.contentHash !== d.contentHash && state === 'trusted') {
          // A changed hook stops until it is trusted again (FR-197).
          state = 'needs_trust';
        }
        if (same && state === row.trustState && trustedHash === row.trustedHash) continue;
        this.#db.raw
          .prepare(
            `UPDATE hook SET event = ?, matcher_json = ?, handler_kind = ?, handler_json = ?,
               fail_closed = ?, definition_json = ?, base_dir = ?, limits_json = ?,
               content_hash = ?, trusted_hash = ?, trust_state = ?, trusted_by = ?, trusted_at = ?,
               timeout_ms = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            d.definition.event,
            d.definition.matcher === undefined ? null : JSON.stringify(matcherList(d.definition)),
            d.definition.handler.type,
            JSON.stringify(d.definition.handler),
            d.definition.failClosed ? 1 : 0,
            defJson,
            d.baseDir,
            limitsJson,
            d.contentHash,
            trustedHash,
            state,
            trustedBy,
            trustedAt,
            d.timeoutMs,
            now,
            row.id,
          );
        const before = hookStatus(row);
        const after = hookStatus({
          ...row,
          definition: d.definition,
          contentHash: d.contentHash,
          trustedHash,
          trustState: state,
        });
        if (!managed && before !== after && after !== 'disabled')
          changes.push({ hookId: hookRef(row), status: after });
      }
      for (const r of existing) {
        if (!kept.has(r.id)) this.#db.raw.prepare('DELETE FROM hook WHERE id = ?').run(r.id);
      }
      return Promise.resolve(changes);
    });
  }

  async setTrust(
    accountId: string,
    id: string,
    state: 'trusted' | 'revoked',
    contentHash: string | null,
    by: string,
  ): Promise<HookRow> {
    await this.#db.transaction(() => {
      const now = this.#now().toISOString();
      if (state === 'trusted')
        this.#db.raw
          .prepare(
            `UPDATE hook SET trust_state = 'trusted', trusted_hash = ?, trusted_by = ?,
               trusted_at = ?, updated_at = ? WHERE account_id = ? AND id = ?`,
          )
          .run(contentHash, by, now, now, accountId, id);
      else
        this.#db.raw
          .prepare(
            `UPDATE hook SET trust_state = 'revoked', updated_at = ? WHERE account_id = ? AND id = ?`,
          )
          .run(now, accountId, id);
      return Promise.resolve();
    });
    return this.get(accountId, id);
  }

  async setEnabled(accountId: string, ids: string[], enabled: boolean): Promise<void> {
    if (!ids.length) return;
    await this.#db.transaction(() => {
      const now = this.#now().toISOString();
      const stmt = this.#db.raw.prepare(
        'UPDATE hook SET enabled = ?, updated_at = ? WHERE account_id = ? AND id = ?',
      );
      for (const id of ids) stmt.run(enabled ? 1 : 0, now, accountId, id);
      return Promise.resolve();
    });
  }

  async remove(accountId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.#db.transaction(() => {
      const stmt = this.#db.raw.prepare('DELETE FROM hook WHERE account_id = ? AND id = ?');
      for (const id of ids) stmt.run(accountId, id);
      return Promise.resolve();
    });
  }

  async recordRun(id: string, effect: HookEffect): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE hook SET last_run_at = ?, last_effect = ? WHERE id = ?')
        .run(this.#now().toISOString(), effect, id);
      return Promise.resolve();
    });
  }

  /** Accounts that have hook rows (startup refresh). */
  accounts(): string[] {
    const rows = this.#db.raw.prepare('SELECT DISTINCT account_id AS a FROM hook').all() as {
      a: string;
    }[];
    return rows.map((r) => r.a);
  }
}
