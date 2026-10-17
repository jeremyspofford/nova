// Lifecycle hooks (FR-197, ADR-068; docs/08 §4.1, docs/12 §2.3 step 7): discovery from every
// source, trust by content hash, and the dispatcher the chat loop and the policy gate call.
//
// Sources are re-read and re-hashed before every dispatch, so an edited hooks file or script is
// `needs_trust` before it could run again. Matching hooks run in parallel; their answers combine
// tighten-only: any block wins, any deny wins, an `allow` is reported only for an `ask` a user rule
// or tool default raised and only from a hook allowed to answer asks. The gate has the final say;
// this module reports what the hooks asked for.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, uuidv7, type HookEvent, type HookView } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { HookDispatcher, HookInput, HookOutcome } from '../extensions/types.ts';
import { auditInputHash } from '../ops/canonical.ts';
import type { AuditSink, Origin, SandboxClient, ToolGate } from '../tools/types.ts';
import type { ToolRuntimeOptions, ToolScope } from '../tools/runtime.ts';
import {
  HOOK_EVENT_EFFECTS,
  HOOK_SOURCE_ORDER,
  failsClosed,
  handlerTimeout,
  hookContentHash,
  hookMatches,
  parseHooksFile,
  type HookDefinition,
  type HookResult,
  type HookSource,
  type HookVars,
} from './config.ts';
import {
  HookTimeoutError,
  HookUnavailableError,
  commandPlacement,
  hookPrecondition,
  runCommandHook,
  runMcpHook,
  type HookHandlerRun,
  type HookMcpClient,
} from './handlers.ts';
import {
  HookStore,
  hookRef,
  hookStatus,
  hookView,
  type DiscoveredHook,
  type HookEffect,
  type HookRow,
  type PluginHookLimits,
  type HookTrustChange,
} from './store.ts';

/** Fields the loop may pass beyond the lead-owned `HookInput` seam. */
export interface HookInputExtras {
  /** The tool call a tool or permission event is about (events' `callId`). */
  callId?: string;
  runId?: string;
  /** The matcher subject of session.start (reason), compact.* (trigger), subagent.* (role). */
  subject?: string;
  /** The turn's working directory, passed on to the hook. */
  cwd?: string;
}

export type DispatchInput = HookInput & HookInputExtras;

/** A plugin's hooks as the plugins area registers them (docs/08 §3.1-§3.2). */
export interface PluginHooksInput {
  pluginId: string;
  /** The installed plugin folder (`${pluginRoot}`): command hooks run there. */
  root: string;
  /** The manifest's `hooks`: a path to a hooks file inside `root`, a hooks-file object or an array. */
  hooks: unknown;
  limits?: Partial<PluginHookLimits>;
  /** Whether the plugin is enabled; its hooks follow it. Default true. */
  enabled?: boolean;
  /** Hooks the user trusted on the install screen: preview id, hook id or row id, with its hash. */
  trust?: { id: string; contentHash: string }[];
  trustedBy?: string;
}

/** One plugin hook as the plugins area lists it (its hook source, docs/08 §3.2). */
export interface PluginHookFeedEntry {
  pluginId: string;
  /** As written in the plugin (hook-config.json#/$defs/hook); `${pluginRoot}` not expanded. */
  hook: unknown;
  /** The hash the install screen showed, re-read from disk by the plugins area. */
  contentHash: string;
  /** The installed plugin folder: command hooks run there. */
  root: string;
  pluginEnabled: boolean;
  /** `permissions.hooks.answersAsks`. */
  answersAsks: boolean;
  /** The plugin's network permission; its hooks stay within it. */
  network: string[];
}

export interface PluginHookFeedChange {
  accountId: string;
  pluginId: string;
  change: 'installed' | 'updated' | 'enabled' | 'disabled' | 'removed';
  /** Hooks the user trusted on the install screen (canonical id or hook id, with the hash). */
  trust: { id: string; contentHash: string }[];
}

/**
 * The plugins area's view of its hooks. When wired, it is the authority for plugin hooks: each
 * refresh takes the plugins' hooks and hashes from it (instead of `registerPluginHooks`).
 */
export interface PluginHookFeed {
  list(accountId: string): Promise<PluginHookFeedEntry[]>;
  onChange?(listener: (change: PluginHookFeedChange) => void | Promise<void>): () => void;
}

export interface HookServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit?: AuditSink;
  log?: Logger;
  /** The user hooks file, `<dataDir>/hooks.json`. */
  userFile: string;
  /** Managed hooks from the managed settings layer: a hooks-file object or an array. */
  managed?: () => unknown;
  sandbox?: SandboxClient | null;
  mcp?: HookMcpClient | null;
  gate?: ToolGate | null;
  /** The session's roots and profile (the tools' scope), for command hooks and gate checks. */
  scope?: ToolRuntimeOptions['scope'];
  /** Where context over the cap is written (the session's scratch folder); null truncates. */
  spillDir?: string | null;
  redactor?: Redactor;
  now?: () => Date;
}

/** Added context above this many tokens goes to a file (docs/08 §4.1 "Limits"). */
export const CONTEXT_SPILL_TOKENS = 2_500;
const CHARS_PER_TOKEN = 4;
const HOOKS_FILE_LIMIT = 1024 * 1024;
const CONTINUATIONS_REMEMBERED = 1_000;
/** How long a timed-out handler gets to stop its process before the run is reported. */
const STOP_GRACE_MS = 500;

/** Calls made inside a hook (its gate check, its MCP tool) never fire hooks (docs/08 §4.1). */
const insideHook = new AsyncLocalStorage<true>();

type RunResult =
  { row: HookRow; ok: true; result: HookResult } | { row: HookRow; ok: false; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function subjectOf(event: HookEvent, input: DispatchInput): string | undefined {
  if (event === 'tool.pre' || event === 'tool.post' || event === 'permission.request')
    return input.tool?.name;
  return input.subject;
}

function order(a: HookRow, b: HookRow): number {
  const s = HOOK_SOURCE_ORDER.indexOf(a.source) - HOOK_SOURCE_ORDER.indexOf(b.source);
  if (s) return s;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1;
}

/** Only managed and user hooks, and plugin hooks whose manifest says so, answer asks (ADR-083). */
function mayAnswerAsks(row: HookRow): boolean {
  if (row.source === 'managed' || row.source === 'user') return true;
  return row.source === 'plugin' && row.limits?.answersAsks === true;
}

/**
 * An `ask` a user rule, a per-tool default or plugin permissions raised: the only kind a hook may
 * answer (FR-197). The policy engine checks again (`applyHookAnswer`), so this only saves a run.
 */
function answerableAsk(d: HookInput['decision']): boolean {
  return (
    d?.effect === 'ask' &&
    (d.source === 'rule' || d.source === 'tool_default' || d.source === 'plugin')
  );
}

function limitsOf(l: Partial<PluginHookLimits> | undefined): PluginHookLimits {
  return {
    network: [...(l?.network ?? [])],
    fsProject: l?.fsProject === true,
    answersAsks: l?.answersAsks === true,
  };
}

export class HookService implements HookDispatcher {
  readonly store: HookStore;
  readonly #o: HookServiceOptions;
  readonly #redactor: Redactor;
  #sandbox: SandboxClient | null;
  #mcp: HookMcpClient | null;
  #gate: ToolGate | null;
  #scope: ToolRuntimeOptions['scope'] | null;
  readonly #chains = new Map<string, Promise<unknown>>();
  /** Hooks files that could not be read, by `source` or `project:<id>`, with the reason. */
  readonly #broken = new Map<string, string>();
  readonly #continued = new Set<string>();
  #feed: PluginHookFeed | null = null;
  #unfeed: (() => void) | null = null;
  /** Install-screen trust waiting for the next refresh, by `<accountId> <pluginId>`. */
  readonly #pendingTrust = new Map<string, { key: string; contentHash: string; by: string }[]>();

  constructor(opts: HookServiceOptions) {
    this.#o = opts;
    this.store = new HookStore(opts.db, opts.now);
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#sandbox = opts.sandbox ?? null;
    this.#mcp = opts.mcp ?? null;
    this.#gate = opts.gate ?? null;
    this.#scope = opts.scope ?? null;
  }

  useSandbox(sandbox: SandboxClient | null): void {
    this.#sandbox = sandbox;
  }

  useMcp(mcp: HookMcpClient | null): void {
    this.#mcp = mcp;
  }

  useGate(gate: ToolGate | null): void {
    this.#gate = gate;
  }

  useScope(scope: ToolRuntimeOptions['scope'] | null): void {
    this.#scope = scope;
  }

  /** Take plugin hooks from the plugins area; its changes (with install-screen trust) apply. */
  usePluginHooks(feed: PluginHookFeed | null): void {
    this.#unfeed?.();
    this.#unfeed = null;
    this.#feed = feed;
    if (!feed?.onChange) return;
    this.#unfeed = feed.onChange(async (c) => {
      const trust = c.trust.map((t) => ({
        key: keyOf(c.pluginId, t.id),
        contentHash: t.contentHash,
        by: 'user',
      }));
      if (trust.length) this.#pendingTrust.set(`${c.accountId} ${c.pluginId}`, trust);
      try {
        await this.refresh(c.accountId, { only: null });
      } catch (err) {
        this.#o.log?.warn('plugin hooks not refreshed', { pluginId: c.pluginId, err });
      }
    });
  }

  /** Stop listening to the plugins area. */
  close(): void {
    this.#unfeed?.();
    this.#unfeed = null;
  }

  /** How many of a plugin's hooks are waiting for trust (for its status); null without hooks. */
  async untrustedPluginHooks(accountId: string, pluginId: string): Promise<number | null> {
    if (!this.store.available()) return null;
    await this.refresh(accountId, { only: null });
    return this.store
      .list(accountId)
      .filter((r) => r.source === 'plugin' && r.pluginId === pluginId)
      .filter((r) => {
        const s = hookStatus(r);
        return s === 'needs_trust' || s === 'revoked';
      }).length;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  /** One refresh or change at a time per account, so two dispatches never insert one hook twice. */
  #serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(accountId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#chains.set(accountId, tail);
    void tail.then(() => {
      if (this.#chains.get(accountId) === tail) this.#chains.delete(accountId);
    });
    return next;
  }

  // ---- discovery ------------------------------------------------------------------------------

  #readFile(path: string): { data: unknown } | { error: string } | null {
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return { error: `${path} is not a file` };
      size = st.size;
    } catch {
      return null;
    }
    if (size > HOOKS_FILE_LIMIT) return { error: `${path} is larger than 1 MiB` };
    try {
      return { data: JSON.parse(readFileSync(path, 'utf8')) as unknown };
    } catch (err) {
      return { error: `${path} is not valid JSON: ${errorMessage(err)}` };
    }
  }

  #discover(
    defs: HookDefinition[],
    base: Omit<DiscoveredHook, 'definition' | 'contentHash' | 'timeoutMs'>,
  ): DiscoveredHook[] {
    const vars: HookVars =
      base.source === 'plugin' && base.baseDir ? { pluginRoot: base.baseDir } : {};
    return defs.map((definition) => ({
      ...base,
      definition,
      contentHash: hookContentHash(definition, base.baseDir, vars),
      timeoutMs: handlerTimeout(definition.handler),
    }));
  }

  #fileErrors(key: string, errors: string[]): void {
    for (const e of errors) this.#o.log?.warn('hook left out', { source: key, error: e });
  }

  /** Project folders of an account (the workspace's `project_folder` table, when it exists). */
  #projectFolders(
    accountId: string,
    projectId: string | null,
  ): { projectId: string; path: string }[] {
    const has = this.#o.db.raw
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'project_folder'")
      .get() as { ok: number } | undefined;
    if (!has) return [];
    try {
      const sql = `SELECT pf.project_id AS projectId, pf.path AS path FROM project_folder pf
        JOIN project p ON p.id = pf.project_id
        WHERE p.account_id = ? AND p.deleted_at IS NULL${projectId ? ' AND pf.project_id = ?' : ''}
        ORDER BY pf.rowid`;
      const args = projectId ? [accountId, projectId] : [accountId];
      return this.#o.db.raw.prepare(sql).all(...args) as { projectId: string; path: string }[];
    } catch (err) {
      this.#o.log?.warn('project folders unreadable for hooks', { err });
      return [];
    }
  }

  /**
   * Re-read every source of an account and bring the hook rows in step: managed policy, the user
   * file, project folders (one project, or `all`), and the plugin rows re-hashed against their
   * folders. Trust changes are announced as `hook.trust.changed`.
   */
  refresh(accountId: string, projects: 'all' | { only: string | null } = 'all'): Promise<void> {
    // One project (a dispatch for its chat), none (a chat outside projects) or all (listing).
    const project = projects === 'all' ? 'all' : projects.only;
    if (!this.store.available()) return Promise.resolve();
    return this.#serial(accountId, async () => {
      const changes: HookTrustChange[] = [];
      // Managed policy (trusted by policy, never by the user), then the user file. A source that
      // cannot be read keeps its rows, and their trust, but runs none of them (fail closed).
      const managedValue = this.#o.managed?.();
      const sources: [HookSource, { data: unknown } | { error: string } | null][] = [
        [
          'managed',
          managedValue === undefined || managedValue === null ? null : { data: managedValue },
        ],
        ['user', this.#readFile(this.#o.userFile)],
      ];
      for (const [source, file] of sources) {
        const parsed = file && 'data' in file ? parseHooksFile(file.data) : null;
        const error = file && 'error' in file ? file.error : parsed?.fileError;
        if (error) {
          this.#broken.set(source, error);
          continue;
        }
        this.#broken.delete(source);
        if (parsed) this.#fileErrors(source, parsed.errors);
        const found = this.#discover(parsed?.hooks ?? [], {
          source,
          pluginId: null,
          projectId: null,
          baseDir: null,
          limits: null,
        });
        changes.push(...(await this.store.sync(accountId, { source }, found)));
      }
      // Project folders' .nova/hooks.json. An unreadable file keeps that project's rows.
      if (project !== null) {
        const folders = this.#projectFolders(accountId, project === 'all' ? null : project);
        const byProject = new Map<string, string[]>();
        if (project !== 'all') byProject.set(project, []);
        for (const f of folders)
          byProject.set(f.projectId, [...(byProject.get(f.projectId) ?? []), f.path]);
        for (const [projectId, paths] of byProject) {
          const key = `project:${projectId}`;
          this.#broken.delete(key);
          const found: DiscoveredHook[] = [];
          for (const path of paths) {
            const file = this.#readFile(join(path, '.nova', 'hooks.json'));
            if (!file) continue;
            if ('error' in file) {
              this.#broken.set(key, file.error);
              continue;
            }
            const parsed = parseHooksFile(file.data);
            if (parsed.fileError) {
              this.#broken.set(key, `${path}: ${parsed.fileError}`);
              continue;
            }
            this.#fileErrors(key, parsed.errors);
            const fresh = parsed.hooks.filter((h) => {
              if (!found.some((d) => d.definition.id === h.id)) return true;
              this.#fileErrors(key, [`hook ${h.id} in ${path} repeats an id from another folder`]);
              return false;
            });
            found.push(
              ...this.#discover(fresh, {
                source: 'project',
                pluginId: null,
                projectId,
                baseDir: path,
                limits: null,
              }),
            );
          }
          if (this.#broken.has(key)) continue;
          changes.push(
            ...(await this.store.sync(
              accountId,
              { source: 'project', projectIds: [projectId] },
              found,
            )),
          );
        }
        if (project === 'all') {
          // Projects whose folders are gone lose their hooks.
          const stale = new Set(
            this.store
              .list(accountId)
              .filter((r) => r.source === 'project' && r.projectId && !byProject.has(r.projectId))
              .map((r) => r.projectId ?? ''),
          );
          for (const id of stale)
            changes.push(
              ...(await this.store.sync(accountId, { source: 'project', projectIds: [id] }, [])),
            );
        }
      }
      changes.push(...(await this.#refreshPlugins(accountId)));
      await this.#announce(accountId, changes);
    });
  }

  /**
   * Plugin hooks: from the plugins area when its feed is wired, else the registered rows with
   * their scripts re-hashed in place.
   */
  async #refreshPlugins(accountId: string): Promise<HookTrustChange[]> {
    const changes: HookTrustChange[] = [];
    const existing = new Map<string, HookRow[]>();
    for (const r of this.store.list(accountId))
      if (r.source === 'plugin' && r.pluginId)
        existing.set(r.pluginId, [...(existing.get(r.pluginId) ?? []), r]);
    if (!this.#feed) {
      for (const [pluginId, rows] of existing) {
        const found = rows.flatMap((r) =>
          this.#discover([r.definition], {
            source: 'plugin',
            pluginId,
            projectId: null,
            baseDir: r.baseDir,
            limits: r.limits,
          }),
        );
        if (found.some((d, i) => d.contentHash !== rows[i]!.contentHash))
          changes.push(
            ...(await this.store.sync(accountId, { source: 'plugin', pluginId }, found)),
          );
      }
      return changes;
    }
    let entries: PluginHookFeedEntry[];
    try {
      entries = await this.#feed.list(accountId);
    } catch (err) {
      // Keep the rows as they are rather than dropping every plugin hook on a read error.
      this.#o.log?.warn('plugin hooks unavailable', { err });
      return changes;
    }
    const byPlugin = new Map<string, PluginHookFeedEntry[]>();
    for (const e of entries) byPlugin.set(e.pluginId, [...(byPlugin.get(e.pluginId) ?? []), e]);
    for (const pluginId of new Set([...existing.keys(), ...byPlugin.keys()])) {
      const list = byPlugin.get(pluginId) ?? [];
      const found: DiscoveredHook[] = [];
      for (const e of list) {
        const parsed = parseHooksFile([e.hook]);
        this.#fileErrors(`plugin:${pluginId}`, parsed.errors);
        const definition = parsed.hooks[0];
        if (!definition) continue;
        found.push({
          source: 'plugin',
          pluginId,
          projectId: null,
          definition,
          baseDir: e.root,
          limits: limitsOf({ network: e.network, answersAsks: e.answersAsks }),
          contentHash: e.contentHash,
          timeoutMs: handlerTimeout(definition.handler),
        });
      }
      const pending = `${accountId} ${pluginId}`;
      const trust = this.#pendingTrust.get(pending) ?? [];
      this.#pendingTrust.delete(pending);
      changes.push(
        ...(await this.store.sync(accountId, { source: 'plugin', pluginId }, found, trust)),
      );
      const enabled = list[0]?.pluginEnabled ?? true;
      const rows = this.store
        .list(accountId)
        .filter((r) => r.source === 'plugin' && r.pluginId === pluginId && r.enabled !== enabled);
      await this.store.setEnabled(
        accountId,
        rows.map((r) => r.id),
        enabled,
      );
    }
    return changes;
  }

  async #announce(accountId: string, changes: HookTrustChange[]): Promise<void> {
    for (const c of changes) {
      await this.#o.events.emit({
        name: 'hook.trust.changed',
        actor: 'system',
        accountId,
        payload: { hookId: c.hookId, status: c.status },
      });
    }
  }

  // ---- the Settings list and trust (routes) --------------------------------------------------

  async list(accountId: string): Promise<HookView[]> {
    if (!this.store.available()) return [];
    await this.refresh(accountId, 'all');
    return this.store.list(accountId).sort(order).map(hookView);
  }

  async get(accountId: string, id: string): Promise<HookView> {
    await this.refresh(accountId, 'all');
    return hookView(this.store.get(accountId, id));
  }

  /** Trust a hook at the hash the user saw; a different current hash is a conflict (FR-197). */
  async trust(accountId: string, id: string, contentHash: string, by = 'user'): Promise<HookView> {
    await this.refresh(accountId, 'all');
    return this.#serial(accountId, async () => {
      const row = this.store.get(accountId, id);
      if (row.source === 'managed') return hookView(row);
      if (row.contentHash !== contentHash)
        throw new NovaError('conflict', 'the hook changed since you reviewed it; review it again', {
          details: { contentHash: row.contentHash },
        });
      const next = await this.store.setTrust(accountId, row.id, 'trusted', contentHash, by);
      await this.#trustChanged(next, 'hook.trust', by);
      return hookView(next);
    });
  }

  /** Revoke trust: the hook stops at once (its next dispatch skips it). */
  async untrust(accountId: string, id: string, by = 'user'): Promise<HookView> {
    return this.#serial(accountId, async () => {
      const row = this.store.get(accountId, id);
      if (row.source === 'managed')
        throw new NovaError('policy_denied', 'managed hooks are trusted by your organization');
      const next = await this.store.setTrust(accountId, row.id, 'revoked', null, by);
      await this.#trustChanged(next, 'hook.untrust', by);
      return hookView(next);
    });
  }

  async #trustChanged(row: HookRow, action: string, by: string): Promise<void> {
    const status = hookStatus(row);
    await this.#o.events.emit({
      name: 'hook.trust.changed',
      actor: by,
      accountId: row.accountId,
      payload: { hookId: hookRef(row), status },
    });
    await this.#o.audit?.append({
      accountId: row.accountId,
      actor: by,
      kind: 'settings',
      action,
      resource: hookRef(row),
      decision: status,
      detail: { key: row.key, source: row.source, contentHash: row.contentHash },
    });
  }

  #userOnly(row: HookRow): void {
    if (row.source !== 'user')
      throw new NovaError(
        'policy_denied',
        row.source === 'plugin'
          ? 'plugin hooks follow their plugin; enable or disable the plugin instead'
          : 'only your own hooks can be changed here; revoke trust to stop this one',
      );
  }

  /** Turn a user hook off or on (PATCH /hooks/:id). */
  async setEnabled(accountId: string, id: string, enabled: boolean): Promise<HookView> {
    return this.#serial(accountId, async () => {
      const row = this.store.get(accountId, id);
      this.#userOnly(row);
      await this.store.setEnabled(accountId, [row.id], enabled);
      return hookView(this.store.get(accountId, row.id));
    });
  }

  /** Delete a user hook: it is removed from the user hooks file too, or it would come back. */
  async remove(accountId: string, id: string): Promise<void> {
    await this.#serial(accountId, async () => {
      const row = this.store.get(accountId, id);
      this.#userOnly(row);
      const file = this.#readFile(this.#o.userFile);
      if (file && 'error' in file)
        throw new NovaError('conflict', `the user hooks file cannot be edited: ${file.error}`);
      if (file) {
        const data = file.data;
        const list = Array.isArray(data)
          ? data
          : typeof data === 'object' &&
              data !== null &&
              Array.isArray((data as { hooks?: unknown }).hooks)
            ? (data as { hooks: unknown[] }).hooks
            : [];
        const kept = list.filter(
          (h) => !(typeof h === 'object' && h !== null && (h as { id?: unknown }).id === row.key),
        );
        const next = Array.isArray(data)
          ? kept
          : { ...(data as Record<string, unknown>), hooks: kept };
        writeFileSync(this.#o.userFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      }
      await this.store.remove(accountId, [row.id]);
      await this.#o.audit?.append({
        accountId,
        actor: 'user',
        kind: 'settings',
        action: 'hook.delete',
        resource: hookRef(row),
        detail: { hookId: hookRef(row), key: row.key },
      });
    });
  }

  // ---- plugins (docs/08 §3.2) -----------------------------------------------------------------

  #pluginDefs(input: PluginHooksInput): { hooks: HookDefinition[]; errors: string[] } {
    let value = input.hooks;
    if (value === undefined || value === null) return { hooks: [], errors: [] };
    if (typeof value === 'string') {
      const path = join(input.root, value);
      const file = this.#readFile(path);
      if (!file) return { hooks: [], errors: [`the hooks file ${value} does not exist`] };
      if ('error' in file) return { hooks: [], errors: [file.error] };
      value = file.data;
    }
    return parseHooksFile(value);
  }

  /** The hooks a plugin would add, with their hashes, before anything is installed. */
  previewPluginHooks(input: PluginHooksInput): { items: HookView[]; errors: string[] } {
    const { hooks, errors } = this.#pluginDefs(input);
    const now = this.#now().toISOString();
    const found = this.#discover(hooks, {
      source: 'plugin',
      pluginId: input.pluginId,
      projectId: null,
      baseDir: input.root,
      limits: limitsOf(input.limits),
    });
    const items = found.map((d) =>
      hookView({
        id: pluginPreviewId(input.pluginId, d.definition.id),
        accountId: '',
        key: d.definition.id,
        event: d.definition.event,
        source: 'plugin',
        pluginId: input.pluginId,
        projectId: null,
        definition: d.definition,
        baseDir: d.baseDir,
        limits: d.limits,
        contentHash: d.contentHash,
        trustedHash: null,
        trustState: 'needs_trust',
        trustedBy: null,
        trustedAt: null,
        timeoutMs: d.timeoutMs,
        enabled: input.enabled ?? true,
        lastRunAt: null,
        lastEffect: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { items, errors };
  }

  /**
   * Install or update a plugin's hooks: new ones arrive `needs_trust` unless trusted on the
   * install screen at the hash shown; a changed hash needs trust again; removed ones go.
   */
  async registerPluginHooks(
    accountId: string,
    input: PluginHooksInput,
  ): Promise<{ items: HookView[]; errors: string[] }> {
    if (!this.store.available()) return { items: [], errors: ['hooks are not available'] };
    const { hooks, errors } = this.#pluginDefs(input);
    const found = this.#discover(hooks, {
      source: 'plugin',
      pluginId: input.pluginId,
      projectId: null,
      baseDir: input.root,
      limits: limitsOf(input.limits),
    });
    return this.#serial(accountId, async () => {
      const existing = this.store
        .list(accountId)
        .filter((r) => r.source === 'plugin' && r.pluginId === input.pluginId);
      const by = input.trustedBy ?? 'user';
      const trust = (input.trust ?? []).map((t) => ({
        key: existing.find((r) => r.id === t.id)?.key ?? keyOf(input.pluginId, t.id),
        contentHash: t.contentHash,
        by,
      }));
      const changes = await this.store.sync(
        accountId,
        { source: 'plugin', pluginId: input.pluginId },
        found,
        trust,
      );
      const rows = this.store
        .list(accountId)
        .filter((r) => r.source === 'plugin' && r.pluginId === input.pluginId);
      const enabled = input.enabled ?? true;
      await this.store.setEnabled(
        accountId,
        rows.filter((r) => r.enabled !== enabled).map((r) => r.id),
        enabled,
      );
      await this.#announce(accountId, changes);
      const items = this.store
        .list(accountId)
        .filter((r) => r.source === 'plugin' && r.pluginId === input.pluginId)
        .sort(order)
        .map(hookView);
      return { items, errors };
    });
  }

  /** Uninstall: the plugin's hooks are removed. */
  async removePluginHooks(accountId: string, pluginId: string): Promise<void> {
    if (!this.store.available()) return;
    await this.#serial(accountId, async () => {
      await this.store.sync(accountId, { source: 'plugin', pluginId }, []);
    });
  }

  /** A disabled plugin's hooks stop; enabling it brings them back with their trust. */
  async setPluginHooksEnabled(
    accountId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<void> {
    if (!this.store.available()) return;
    await this.#serial(accountId, async () => {
      const ids = this.store
        .list(accountId)
        .filter((r) => r.source === 'plugin' && r.pluginId === pluginId)
        .map((r) => r.id);
      await this.store.setEnabled(accountId, ids, enabled);
    });
  }

  /** For GET /diagnostics: unreadable hooks files and how many hooks are in each state. */
  diagnostics(): { available: boolean; sandbox: boolean; unreadable: Record<string, string> } {
    return {
      available: this.store.available(),
      sandbox: this.#sandbox !== null,
      unreadable: Object.fromEntries(this.#broken),
    };
  }

  // ---- dispatch --------------------------------------------------------------------------------

  async dispatch(
    event: HookEvent,
    input: DispatchInput,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    // Hooks never fire hooks: a hook's own gate check or MCP call lands here and does nothing.
    if (insideHook.getStore()) return { context: [] };
    if (!this.store.available()) return { context: [] };
    try {
      await this.refresh(input.accountId, { only: input.projectId });
    } catch (err) {
      // The stored rows still run (with their last known hashes) rather than none at all.
      this.#o.log?.warn('hook refresh failed', { err });
    }
    const subject = subjectOf(event, input);
    const rows = this.store
      .list(input.accountId)
      .filter(
        (r) =>
          r.event === event &&
          (r.source !== 'project' || r.projectId === input.projectId) &&
          hookMatches(r.definition, subject),
      )
      .sort(order);
    if (!rows.length) return { context: [] };
    const scope = await this.#sessionScope(input);
    const runs = await Promise.all(
      rows.map(async (row): Promise<RunResult | null> => {
        const status = hookStatus(row);
        if (status !== 'trusted') {
          await this.#emit('hook.skipped', input, { hookId: hookRef(row), event, reason: status });
          return null;
        }
        return this.#runOne(event, row, input, scope, signal);
      }),
    );
    return this.#combine(
      event,
      input,
      runs.filter((r): r is RunResult => r !== null),
    );
  }

  async #sessionScope(input: DispatchInput): Promise<ToolScope | null> {
    if (!this.#scope) return null;
    try {
      return await this.#scope({
        accountId: input.accountId,
        threadId: input.threadId || null,
        projectId: input.projectId,
      });
    } catch (err) {
      this.#o.log?.warn('hook scope unavailable', { err });
      return null;
    }
  }

  #payload(event: HookEvent, row: HookRow, input: DispatchInput, scope: ToolScope | null) {
    const p: Record<string, unknown> = {
      event,
      hookId: row.key,
      sessionId: input.threadId,
      threadId: input.threadId,
      turnId: input.turnId,
      projectId: input.projectId,
    };
    if (input.runId) p.runId = input.runId;
    if (input.callId) p.callId = input.callId;
    const cwd =
      input.cwd ??
      (row.definition.handler.type === 'command' ? commandPlacement(row, scope).cwd : undefined);
    if (cwd) p.cwd = cwd;
    if (input.tool) p.tool = input.tool.name;
    if (input.args !== undefined) p.arguments = input.args;
    if (input.result !== undefined) p.result = input.result;
    if (input.decision) p.decision = { ...input.decision };
    if (input.prompt !== undefined) p.prompt = input.prompt;
    if (input.reply !== undefined) p.reply = input.reply;
    if (input.subject !== undefined) {
      const name = event.startsWith('compact.')
        ? 'trigger'
        : event.startsWith('subagent.')
          ? 'role'
          : 'reason';
      p[name] = input.subject;
    }
    return this.#redactor.redact(p);
  }

  async #emit(name: string, input: DispatchInput, payload: Record<string, unknown>): Promise<void> {
    const correlation: { threadId?: string; turnId?: string; callId?: string } = {};
    if (input.threadId) correlation.threadId = input.threadId;
    if (input.turnId) correlation.turnId = input.turnId;
    if (input.callId) correlation.callId = input.callId;
    const body = input.callId ? { ...payload, callId: input.callId } : payload;
    try {
      await this.#o.events.emit({
        name,
        actor: 'system',
        accountId: input.accountId,
        correlation,
        payload: body,
      });
    } catch (err) {
      this.#o.log?.warn('hook event not recorded', { name, err });
    }
  }

  async #runOne(
    event: HookEvent,
    row: HookRow,
    input: DispatchInput,
    scope: ToolScope | null,
    turnSignal: AbortSignal,
  ): Promise<RunResult> {
    const started = Date.now();
    const timeoutMs = row.timeoutMs;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    const signal = AbortSignal.any([turnSignal, timer.signal]);
    const payload = this.#payload(event, row, input, scope);
    const taint: Origin[] = [];
    if (input.args !== undefined || input.result !== undefined) taint.push('tool');
    if (row.source === 'plugin') taint.push('plugin');
    const run: HookHandlerRun = {
      row,
      accountId: input.accountId,
      threadId: input.threadId,
      turnId: input.turnId,
      projectId: input.projectId,
      payload,
      taint,
      scope,
      signal,
      deadline: started + timeoutMs,
      now: () => Date.now(),
    };
    try {
      // A hook that cannot start is skipped (and, where it guards, blocks): never silently
      // dropped (docs/21 §4).
      try {
        const broken = this.#brokenSource(row);
        if (broken) throw new HookUnavailableError(`its hooks file cannot be read: ${broken}`);
        await hookPrecondition(
          row,
          { sandbox: this.#sandbox, mcp: this.#mcp, gate: this.#gate },
          input.accountId,
        );
      } catch (err) {
        await this.#emit('hook.skipped', input, { hookId: hookRef(row), event, reason: 'error' });
        const message = this.#redactor.redactString(errorMessage(err));
        return await this.#finish(event, row, input, payload, { row, ok: false, message }, started);
      }
      await this.#emit('hook.started', input, { hookId: hookRef(row), event });
      const pending = insideHook.run(true, () =>
        row.definition.handler.type === 'command'
          ? runCommandHook(this.#sandbox, run)
          : runMcpHook(this.#mcp, this.#gate, run),
      );
      try {
        const result = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            const fail = () => reject(new Error('the turn ended'));
            if (signal.aborted) fail();
            signal.addEventListener('abort', fail, { once: true });
          }),
        ]);
        return await this.#finish(event, row, input, payload, { row, ok: true, result }, started);
      } catch (err) {
        // Give the handler a moment to stop what it started (it sees the same signal).
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          pending.catch(() => undefined),
          new Promise((r) => (grace = setTimeout(r, STOP_GRACE_MS))),
        ]);
        clearTimeout(grace);
        const timedOut = timer.signal.aborted || err instanceof HookTimeoutError;
        const message = timedOut
          ? `the hook did not answer within ${Math.round(timeoutMs / 1000)} s`
          : this.#redactor.redactString(errorMessage(err));
        return await this.#finish(
          event,
          row,
          input,
          payload,
          { row, ok: false, message },
          started,
          timedOut ? 'timeout' : 'error',
        );
      }
    } finally {
      clearTimeout(t);
    }
  }

  #brokenSource(row: HookRow): string | undefined {
    if (row.source === 'user' || row.source === 'managed') return this.#broken.get(row.source);
    if (row.source === 'project') return this.#broken.get(`project:${row.projectId ?? ''}`);
    return undefined;
  }

  /** Events, audit and the last-run record for one hook run. */
  async #finish(
    event: HookEvent,
    row: HookRow,
    input: DispatchInput,
    payload: Record<string, unknown>,
    r: RunResult,
    started: number,
    /** Set when the hook started and then failed; a run that never started has no failure kind. */
    failure?: 'timeout' | 'error',
  ): Promise<RunResult> {
    const durationMs = Date.now() - started;
    const e = HOOK_EVENT_EFFECTS[event];
    let effect: HookEffect;
    let blockReason: string | null = null;
    if (!r.ok) {
      effect = 'error';
      if (failsClosed(row.definition)) {
        blockReason = `hook ${row.key} failed, so this is blocked: ${r.message}`;
        await this.#emit('hook.blocked', input, {
          hookId: hookRef(row),
          event,
          reason: blockReason,
          failClosed: true,
        });
      } else if (failure) {
        await this.#emit('hook.skipped', input, { hookId: hookRef(row), event, reason: failure });
      }
    } else {
      const res = r.result;
      if (e.block && res.block) {
        effect = 'blocked';
        blockReason = this.#redactor.redactString(res.block.reason);
        await this.#emit('hook.blocked', input, {
          hookId: hookRef(row),
          event,
          reason: blockReason,
          failClosed: false,
        });
      } else {
        effect =
          e.decision && res.decision
            ? 'decision'
            : e.continue && res.continue
              ? 'continue'
              : e.context && res.context
                ? 'context'
                : 'none';
        await this.#emit('hook.completed', input, {
          hookId: hookRef(row),
          event,
          effect,
          durationMs,
        });
      }
    }
    try {
      await this.store.recordRun(row.id, effect);
    } catch (err) {
      this.#o.log?.warn('hook last run not recorded', { err });
    }
    await this.#o.audit
      ?.append({
        accountId: input.accountId,
        actor: hookRef(row),
        kind: 'policy',
        action: `hook.${event}`,
        resource: input.tool?.name ?? null,
        inputHash: auditInputHash(payload),
        decision: effect,
        result: r.ok ? 'ok' : (failure ?? 'not_started'),
        threadId: input.threadId || null,
        turnId: input.turnId,
        detail: {
          hookId: hookRef(row),
          key: row.key,
          source: row.source,
          pluginId: row.pluginId,
          contentHash: row.contentHash,
          durationMs,
          ...(input.callId ? { callId: input.callId } : {}),
          ...(blockReason ? { reason: blockReason } : {}),
          ...(r.ok ? {} : { error: r.message, failClosed: failsClosed(row.definition) }),
        },
      })
      .catch((err: unknown) => this.#o.log?.warn('hook audit failed', { err }));
    return r;
  }

  #combine(event: HookEvent, input: DispatchInput, runs: RunResult[]): HookOutcome {
    const e = HOOK_EVENT_EFFECTS[event];
    const out: HookOutcome = { context: [] };
    // Decisions and blocks also say where the hook came from (`source`, `pluginId`), so the gate
    // can check who may answer an ask without parsing the id.
    type Verdict = { reason: string; hookId: string; source: HookSource; pluginId: string | null };
    const verdict = (row: HookRow, reason: string): Verdict => ({
      reason,
      hookId: hookRef(row),
      source: row.source,
      pluginId: row.pluginId,
    });
    let block: Verdict | null = null;
    let deny: Verdict | null = null;
    let allow: Verdict | null = null;
    for (const r of runs) {
      const { row } = r;
      if (!r.ok) {
        if (!failsClosed(row.definition)) continue;
        const reason = `hook ${row.key} failed, so this is blocked: ${r.message}`;
        if (e.block) block ??= verdict(row, reason);
        if (e.decision) deny ??= verdict(row, reason);
        continue;
      }
      const res = r.result;
      if (e.block && res.block)
        block ??= verdict(row, this.#redactor.redactString(res.block.reason));
      if (e.decision && res.decision === 'deny')
        deny ??= verdict(row, `hook ${row.key} denied this call`);
      if (e.decision && res.decision === 'allow' && mayAnswerAsks(row))
        allow ??= verdict(row, `hook ${row.key} allowed this call`);
      // Hook output reaches the model: secrets are redacted like any other untrusted text.
      if (e.context && res.context)
        out.context.push({
          text: this.#spill(input, row, this.#redactor.redactString(res.context)),
          hookId: hookRef(row),
        });
      if (e.continue && res.continue && !out.continueWith)
        out.continueWith = {
          prompt: this.#redactor.redactString(res.continue),
          hookId: hookRef(row),
        };
    }
    if (block) out.block = block;
    // Any deny wins; an allow only answers an `ask` from a user rule or tool default.
    if (deny) out.decision = { effect: 'deny', ...deny };
    else if (allow && answerableAsk(input.decision)) out.decision = { effect: 'allow', ...allow };
    // One continuation per turn (FR-197): a second stop of the same turn gets none.
    if (out.continueWith && input.turnId) {
      if (this.#continued.has(input.turnId)) delete out.continueWith;
      else {
        this.#continued.add(input.turnId);
        if (this.#continued.size > CONTINUATIONS_REMEMBERED)
          this.#continued.delete(this.#continued.values().next().value!);
      }
    }
    return out;
  }

  /** Context over 2,500 tokens: the first part, plus the path of a file holding all of it. */
  #spill(input: DispatchInput, row: HookRow, text: string): string {
    const limit = CONTEXT_SPILL_TOKENS * CHARS_PER_TOKEN;
    if (text.length <= limit) return text;
    const head = text.slice(0, Math.floor(limit * 0.8));
    const dir = this.#o.spillDir;
    if (!dir) return `${head}\n[the hook added ${text.length} characters; the rest was left out]`;
    try {
      const folder = join(dir, input.threadId.replace(/[^A-Za-z0-9-]/g, '_') || 'hooks');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${row.key}-${uuidv7()}.txt`);
      writeFileSync(path, text, { mode: 0o600 });
      return `${head}\n[the hook added more context than fits here; read all of it with fs.read at ${path}]`;
    } catch (err) {
      this.#o.log?.warn('hook context not written', { err });
      return `${head}\n[the hook added ${text.length} characters; the rest was left out]`;
    }
  }
}

/** A plugin hook's key from its canonical id (`hook:<pluginId>.<hookId>`) or the key itself. */
function keyOf(pluginId: string, id: string): string {
  const prefix = pluginPreviewId(pluginId, '');
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** A plugin hook's canonical id (`hook:<pluginId>.<hookId>`), also on the install screen. */
export function pluginPreviewId(pluginId: string, key: string): string {
  return hookRef({ source: 'plugin', pluginId, projectId: null, key });
}

export type { HookSource };
