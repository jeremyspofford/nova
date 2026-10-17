// Import from other assistants (FR-200, docs/08 §4.2, docs/04 §2.11, docs/12 §5). A preview scans
// folders on the Hub and lists every item with its target, SHA-256 duplicates, name conflicts and
// masked secrets; nothing is written. Applying writes only the selected items and one
// `import_record` per item. Secrets move to the vault and are replaced by `secret://`
// references before anything is stored; imported plugins and MCP servers stay disabled until
// their permissions are confirmed. Sources are never modified, and nothing is written into
// another application's files: skills, plugins and instructions go to Nova's data directory.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type ImportItemView,
  type ImportKind,
  type ImportPreview,
  type ImportRecordView,
  type ImportResult,
} from '@nova/shared';
import { defaultRedactor, resolveWithin, type Redactor } from '@nova/security';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../../events.ts';
import type { MemoryService } from '../../memory.ts';
import type { ProjectService } from '../../projects.ts';
import type { AuditSink } from '../../tools/types.ts';
import { renameSkill, slug, type McpServerPlan } from './formats.ts';
import {
  scanPaths,
  SCAN_LIMITS,
  type ImportPayload,
  type PluginServer,
  type ScannedItem,
} from './scan.ts';
import { findTextSecrets, maskSecret } from './secrets.ts';

const { importRecord, mcpServer, project } = schema;
type RecordRow = typeof importRecord.$inferSelect;
type SourceKind = RecordRow['sourceKind'];
type ItemKind = RecordRow['itemKind'];

const KIND_MAP: Record<ImportKind, { source: SourceKind; item: ItemKind }> = {
  instructions: { source: 'instruction_file', item: 'instruction' },
  skills: { source: 'skill_folder', item: 'skill' },
  commands: { source: 'command_file', item: 'skill' },
  plugins: { source: 'plugin', item: 'plugin' },
  mcp_servers: { source: 'mcp_config', item: 'mcp_server' },
  projects: { source: 'project', item: 'project' },
  memories: { source: 'memory_export', item: 'memory' },
  chats: { source: 'chat_export', item: 'thread' },
};
const SOURCE_TO_KIND = Object.fromEntries(
  Object.entries(KIND_MAP).map(([k, v]) => [v.source, k as ImportKind]),
) as Record<SourceKind, ImportKind>;

/** Projects come first (instructions may land in them); everything else in a fixed order. */
const APPLY_ORDER: readonly ImportKind[] = [
  'projects',
  'instructions',
  'skills',
  'commands',
  'plugins',
  'mcp_servers',
  'memories',
  'chats',
];

const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_PREVIEWS = 10;
const DEFAULT_SERVER_CONFIG = {
  startupTimeoutMs: 30_000,
  toolTimeoutMs: 60_000,
  enabledTools: null,
  disabledTools: [],
  defaultApproval: null,
};

/**
 * What applying needs from other areas. Each is optional: without one, items of that kind fail
 * with a clear reason (or, for project folders, the project is created without its folder).
 */
export interface ImportTargets {
  /** The skill index: copies a skill folder into the user folder as an import. */
  skills?: {
    importFolder(
      accountId: string,
      folder: string,
      opts: { name?: string; provenance?: Record<string, unknown> },
    ): Promise<{ id: string; name: string }>;
  };
  /** The plugins area: installs a plugin folder, disabled (its hooks need trust). */
  plugins?: {
    installDisabled(accountId: string, folder: string): Promise<{ id: string; name: string }>;
  };
  /** Project folders: indexed into the project's sources and a tool root for its chats. */
  folders?: {
    add(
      accountId: string,
      projectId: string,
      req: { path: string; access?: 'read' | 'write' },
    ): Promise<unknown>;
  };
}

export interface ImportServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  /** Nova's data directory: user skills, user instructions and staging copies live there. */
  dataDir: string;
  memory: Pick<MemoryService, 'import'>;
  projects: Pick<ProjectService, 'create' | 'update' | 'row'>;
  targets?: ImportTargets;
  audit?: AuditSink;
  log?: Logger;
  redactor?: Redactor;
  now?: () => Date;
  /** The user's home folder (instruction files in its config folders are user instructions). */
  home?: string;
  previewTtlMs?: number;
}

interface Entry {
  id: string;
  /** Names the vault references this item's secrets get (`secret://import/<ref>/…`). */
  ref: string;
  item: ScannedItem;
  status: ImportItemView['status'];
  /** The name it is imported under (a conflict gets a free one). */
  targetName: string;
  /** Pre-assigned id of an MCP server, so the preview can show its secret references. */
  serverId: string;
  applied: boolean;
}

interface StoredPreview {
  accountId: string;
  at: number;
  entries: Entry[];
}

interface Applied {
  targetRef: string | null;
  target: string;
  disabled: boolean;
  secrets: number;
}

interface ApplyContext {
  accountId: string;
  importId: string;
  /** Projects created in this apply, by folder, so instruction files can join them. */
  projectsByFolder: Map<string, { id: string; name: string }>;
}

export class ImportService {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #memory: ImportServiceOptions['memory'];
  readonly #projects: ImportServiceOptions['projects'];
  readonly #targets: ImportTargets;
  readonly #audit: AuditSink | undefined;
  readonly #log: Logger;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #home: string | undefined;
  readonly #ttl: number;
  readonly #previews = new Map<string, StoredPreview>();
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(opts: ImportServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#memory = opts.memory;
    this.#projects = opts.projects;
    this.#targets = opts.targets ?? {};
    this.#audit = opts.audit;
    this.#log = opts.log ?? new Logger({ module: 'core.import', sinks: [] });
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#now = opts.now ?? (() => new Date());
    this.#home = opts.home;
    this.#ttl = opts.previewTtlMs ?? PREVIEW_TTL_MS;
  }

  /** Where imported user instructions are kept (`<dataDir>/instructions.md`). */
  get userInstructionsPath(): string {
    return join(this.#dataDir, 'instructions.md');
  }

  /** Where user skills live (`<dataDir>/skills/<name>/SKILL.md`). */
  get skillsDir(): string {
    return join(this.#dataDir, 'skills');
  }

  // ---- preview --------------------------------------------------------------------------------

  async preview(
    accountId: string,
    req: { paths: readonly string[]; kinds: readonly ImportKind[] },
  ): Promise<ImportPreview> {
    this.#expire();
    const { items, truncated } = await scanPaths(req.paths, req.kinds, {
      ...(this.#home ? { home: this.#home } : {}),
    });
    const known = await this.#knownHashes(accountId, items);
    const claimed = {
      skills: new Set<string>(),
      servers: new Set<string>(),
      projects: new Set<string>(),
    };
    const takenServers = new Set(
      (
        await this.#db.orm
          .select({ name: mcpServer.name })
          .from(mcpServer)
          .where(eq(mcpServer.accountId, accountId))
      ).map((r) => r.name),
    );
    const takenProjects = new Set(
      (
        await this.#db.orm
          .select({ name: project.name })
          .from(project)
          .where(and(eq(project.accountId, accountId), isNull(project.deletedAt)))
      ).map((r) => r.name.toLowerCase()),
    );
    const firstByHash = new Map<string, string>();
    const entries: Entry[] = [];
    for (const [i, item] of items.entries()) {
      const key = `${KIND_MAP[item.kind].item}\0${item.sha256}`;
      const notes = [...item.notes];
      let status: Entry['status'] = 'new';
      let targetName = baseName(item);
      if (item.unsupported) {
        status = 'unsupported';
        notes.unshift(item.unsupported);
      } else if (known.has(key)) {
        status = 'duplicate';
        notes.unshift('already imported');
      } else if (firstByHash.has(key)) {
        status = 'duplicate';
        notes.unshift(`same as ${firstByHash.get(key)}`);
      } else {
        const free = this.#freeName(item, targetName, claimed, takenServers, takenProjects);
        if (free !== targetName) {
          status = 'conflict';
          notes.unshift(`the name ${targetName} is taken; it is imported as ${free}`);
          targetName = free;
        }
        claimName(item, targetName, claimed);
      }
      if (!firstByHash.has(key)) firstByHash.set(key, item.sourcePath);
      entries.push({
        id: `i${i + 1}`,
        ref: randomUUID().replace(/-/g, '').slice(0, 20),
        item: { ...item, notes },
        status,
        targetName,
        serverId: uuidv7(),
        applied: false,
      });
    }
    // Instruction files join the project item of their folder when the preview has one.
    const projectFolders = new Map(
      entries.flatMap((e) =>
        e.item.payload.kind === 'projects' && e.item.payload.folder
          ? [[e.item.payload.folder, e.targetName] as const]
          : [],
      ),
    );
    const previewId = uuidv7();
    this.#previews.set(previewId, { accountId, at: Date.now(), entries });
    while (this.#previews.size > MAX_PREVIEWS) {
      const oldest = this.#previews.keys().next().value;
      if (oldest === undefined) break;
      this.#previews.delete(oldest);
    }
    const views = entries.map((e) => this.#view(e, projectFolders));
    if (truncated && views.length)
      views[views.length - 1]!.note = joinNotes([
        views.at(-1)!.note,
        'the scan stopped at its size limit; scan a smaller folder for the rest',
      ]);
    return { previewId, items: views };
  }

  #view(e: Entry, projectFolders: ReadonlyMap<string, string>): ImportItemView {
    const p = e.item.payload;
    return {
      id: e.id,
      kind: e.item.kind,
      name: e.item.name,
      sourcePath: e.item.sourcePath,
      target: targetLabel(p, e.targetName, projectFolders),
      sha256: e.item.sha256,
      status: e.status,
      maskedSecrets: this.#maskedSecrets(e),
      note: joinNotes(e.item.notes),
    };
  }

  #maskedSecrets(e: Entry): string[] {
    const p = e.item.payload;
    switch (p.kind) {
      case 'mcp_servers':
        return p.plan.secrets.map(
          (s) =>
            `${s.where}: ${maskSecret(p.plan.env[s.name] ?? '')} → ${secretRef('mcp', e.serverId, 'env', s.name)}`,
        );
      case 'plugins':
        return p.servers.flatMap((srv) =>
          srv.plan.secrets.map(
            (s) =>
              `MCP server ${srv.key}, ${s.where}: ${maskSecret(srv.plan.env[s.name] ?? '')} → ${pluginSecretRef(p.pluginId, srv, s.name)}`,
          ),
        );
      case 'instructions':
        return findTextSecrets(p.text).map(
          (v, n) => `a token in the text: ${maskSecret(v)} → ${textSecretRef(e.ref, n)}`,
        );
      case 'projects':
        return findTextSecrets(p.instructions ?? '').map(
          (v, n) => `a token in the instructions: ${maskSecret(v)} → ${textSecretRef(e.ref, n)}`,
        );
      default:
        return [];
    }
  }

  async #knownHashes(accountId: string, items: ScannedItem[]): Promise<Set<string>> {
    const out = new Set<string>();
    const hashes = [...new Set(items.map((i) => i.sha256))];
    for (let i = 0; i < hashes.length; i += 500) {
      const rows = await this.#db.orm
        .select({ itemKind: importRecord.itemKind, sha256: importRecord.sha256 })
        .from(importRecord)
        .where(
          and(
            eq(importRecord.accountId, accountId),
            ne(importRecord.status, 'failed'),
            inArray(importRecord.sha256, hashes.slice(i, i + 500)),
          ),
        );
      for (const r of rows) out.add(`${r.itemKind}\0${r.sha256}`);
    }
    return out;
  }

  #freeName(
    item: ScannedItem,
    name: string,
    claimed: { skills: Set<string>; servers: Set<string>; projects: Set<string> },
    takenServers: ReadonlySet<string>,
    takenProjects: ReadonlySet<string>,
  ): string {
    switch (item.kind) {
      case 'skills':
      case 'commands':
        return nextFree(
          name,
          (n) => claimed.skills.has(n) || existsSync(join(this.skillsDir, n)),
          64,
        );
      case 'mcp_servers':
        return nextFree(name, (n) => claimed.servers.has(n) || takenServers.has(n), 40);
      case 'projects':
        return nextFreeTitle(name, (n) => {
          const k = n.toLowerCase();
          return claimed.projects.has(k) || takenProjects.has(k);
        });
      default:
        return name;
    }
  }

  // ---- apply ----------------------------------------------------------------------------------

  /**
   * Import the selected items of a preview. Duplicates (including items applied before) are
   * counted and skipped; an item that fails is recorded as failed and the rest continue.
   */
  async apply(
    accountId: string,
    req: { previewId: string; items: readonly string[] },
  ): Promise<ImportResult> {
    this.#expire();
    const preview = this.#previews.get(req.previewId);
    if (!preview || preview.accountId !== accountId)
      throw new NovaError('not_found', 'the import preview has expired; scan again', {
        details: { reason: 'preview_expired' },
      });
    const byId = new Map(preview.entries.map((e) => [e.id, e]));
    const unknown = req.items.filter((id) => !byId.has(id));
    if (unknown.length)
      throw new NovaError('validation', `unknown import items: ${unknown.slice(0, 5).join(', ')}`, {
        details: { field: 'items' },
      });
    const wanted = new Set(req.items);
    return this.#serial(accountId, () =>
      this.#applyAll(
        accountId,
        preview.entries.filter((e) => wanted.has(e.id)),
      ),
    );
  }

  async #applyAll(accountId: string, entries: Entry[]): Promise<ImportResult> {
    const importId = uuidv7();
    const result: ImportResult = {
      importId,
      imported: 0,
      duplicates: 0,
      disabled: 0,
      secretsMigrated: 0,
    };
    let failed = 0;
    const kinds = new Set<ImportKind>();
    const ctx: ApplyContext = { accountId, importId, projectsByFolder: new Map() };
    for (const kind of APPLY_ORDER) {
      for (const e of entries.filter((x) => x.item.kind === kind)) {
        if (e.status === 'unsupported') continue;
        const map = KIND_MAP[kind];
        if (e.applied || (await this.#isKnown(accountId, map.item, e.item.sha256))) {
          result.duplicates++;
          continue;
        }
        const at = this.#now().toISOString();
        let out: Applied;
        try {
          out = await this.#applyOne(ctx, e);
        } catch (err) {
          failed++;
          const reason = this.#redactor.redactString(
            err instanceof Error ? err.message : String(err),
          );
          this.#log.warn('import item failed', { kind, sourcePath: e.item.sourcePath, reason });
          await this.#record(accountId, importId, e, at, {
            status: 'failed',
            targetRef: null,
            target: `not imported: ${reason}`.slice(0, 500),
            secrets: 0,
          });
          continue;
        }
        e.applied = true;
        kinds.add(kind);
        result.imported++;
        if (out.disabled) result.disabled++;
        result.secretsMigrated += out.secrets;
        await this.#record(accountId, importId, e, at, {
          status: out.disabled ? 'disabled_pending_permissions' : 'imported',
          targetRef: out.targetRef,
          target: out.target,
          secrets: out.secrets,
        });
      }
    }
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'import.applied',
      resource: `import:${importId}`,
      detail: { ...result, failed, kinds: [...kinds].sort() },
    });
    await this.#events.emit({
      name: 'import.completed',
      actor: 'user',
      accountId,
      payload: { ...result },
    });
    return result;
  }

  async #isKnown(accountId: string, itemKind: ItemKind, sha256: string): Promise<boolean> {
    const rows = await this.#db.orm
      .select({ id: importRecord.id })
      .from(importRecord)
      .where(
        and(
          eq(importRecord.accountId, accountId),
          eq(importRecord.itemKind, itemKind),
          eq(importRecord.sha256, sha256),
          ne(importRecord.status, 'failed'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async #record(
    accountId: string,
    importId: string,
    e: Entry,
    at: string,
    r: { status: RecordRow['status']; targetRef: string | null; target: string; secrets: number },
  ): Promise<void> {
    const map = KIND_MAP[e.item.kind];
    await this.#db.transaction(() =>
      this.#db.orm.insert(importRecord).values({
        id: uuidv7(),
        accountId,
        importId,
        sourceKind: map.source,
        sourcePath: e.item.sourcePath.slice(0, 2000),
        sha256: e.item.sha256,
        itemKind: map.item,
        targetRef: r.targetRef,
        target: r.target,
        status: r.status,
        secretsMigrated: r.secrets,
        importedAt: at,
      }),
    );
  }

  #applyOne(ctx: ApplyContext, e: Entry): Promise<Applied> {
    const p = e.item.payload;
    switch (p.kind) {
      case 'projects':
        return this.#applyProject(ctx, e, p);
      case 'instructions':
        return this.#applyInstructions(ctx, e, p);
      case 'skills':
        return this.#applySkill(
          ctx,
          e,
          p.name,
          p.files.map((rel) => ({ rel, from: join(p.dir, rel) })),
          p.skillMd,
        );
      case 'commands':
        return this.#applySkill(ctx, e, p.name, [], p.skillMd, ' (from a command)');
      case 'plugins':
        return this.#applyPlugin(ctx, e, p);
      case 'mcp_servers':
        return this.#applyServer(ctx, e, p.plan);
      case 'memories':
        return this.#applyMemories(ctx, p);
      case 'chats':
        return this.#applyChat(ctx, e, p);
    }
  }

  /** Move token-shaped values in free text to the vault and put their references in place. */
  async #moveTextSecrets(
    ctx: ApplyContext,
    e: Entry,
    text: string,
  ): Promise<{ text: string; moved: number }> {
    const found = findTextSecrets(text);
    let out = text;
    for (const [n, value] of found.entries()) {
      const ref = textSecretRef(e.ref, n);
      await this.#secrets.put(ref, value);
      out = out.split(value).join(ref);
      await this.#auditSecret(ctx, ref, e.item.kind);
    }
    return { text: out, moved: found.length };
  }

  async #auditSecret(ctx: ApplyContext, ref: string, kind: ImportKind): Promise<void> {
    await this.#audit?.append({
      accountId: ctx.accountId,
      actor: 'user',
      kind: 'secret',
      action: 'import.secret.moved',
      resource: ref,
      detail: { importId: ctx.importId, itemKind: kind },
    });
  }

  async #applyProject(
    ctx: ApplyContext,
    e: Entry,
    p: Extract<ImportPayload, { kind: 'projects' }>,
  ): Promise<Applied> {
    // A folder that already belongs to a project is not imported as a second one.
    const existing = p.folder ? this.#projectWithFolder(ctx.accountId, p.folder) : null;
    if (existing && p.folder) {
      const row = await this.#projects.row(ctx.accountId, existing);
      ctx.projectsByFolder.set(p.folder, { id: row.id, name: row.name });
      return {
        targetRef: row.id,
        target: `project ${row.name} (it already has this folder)`,
        disabled: false,
        secrets: 0,
      };
    }
    const moved = p.instructions ? await this.#moveTextSecrets(ctx, e, p.instructions) : null;
    const created = await this.#createProject(ctx, e.targetName, p.folder, moved?.text ?? null);
    return {
      targetRef: created.id,
      target: created.label,
      disabled: false,
      secrets: moved?.moved ?? 0,
    };
  }

  async #createProject(
    ctx: ApplyContext,
    name: string,
    folder: string | null,
    instructions: string | null,
  ): Promise<{ id: string; name: string; label: string }> {
    const free = await this.#freeProjectName(ctx.accountId, name);
    const view = await this.#projects.create(ctx.accountId, {
      name: free,
      ...(instructions
        ? { instructions: instructions.slice(0, SCAN_LIMITS.maxInstructionChars) }
        : {}),
    });
    let label = `project ${free}`;
    if (folder) {
      ctx.projectsByFolder.set(folder, { id: view.id, name: free });
      const folders = this.#targets.folders;
      if (!folders) label += ' (folder not attached: project folders are unavailable)';
      else {
        try {
          await folders.add(ctx.accountId, view.id, { path: folder, access: 'read' });
          label += ` with folder ${folder}`;
        } catch (err) {
          const why = this.#redactor.redactString(err instanceof Error ? err.message : String(err));
          label += ` (folder not attached: ${why})`;
        }
      }
    }
    return { id: view.id, name: free, label };
  }

  async #freeProjectName(accountId: string, name: string): Promise<string> {
    const taken = new Set(
      (
        await this.#db.orm
          .select({ name: project.name })
          .from(project)
          .where(and(eq(project.accountId, accountId), isNull(project.deletedAt)))
      ).map((r) => r.name.toLowerCase()),
    );
    return nextFreeTitle(name, (n) => taken.has(n.toLowerCase()));
  }

  /** The project an instruction file's folder belongs to: made in this import, earlier, or now. */
  async #projectFor(ctx: ApplyContext, folder: string): Promise<{ id: string; name: string }> {
    const now = ctx.projectsByFolder.get(folder);
    if (now) return now;
    const rows = await this.#db.orm
      .select({ targetRef: importRecord.targetRef })
      .from(importRecord)
      .where(
        and(
          eq(importRecord.accountId, ctx.accountId),
          eq(importRecord.itemKind, 'project'),
          eq(importRecord.sourcePath, folder),
          ne(importRecord.status, 'failed'),
        ),
      )
      .orderBy(desc(importRecord.importedAt))
      .limit(1);
    const ref = rows[0]?.targetRef ?? this.#projectWithFolder(ctx.accountId, folder);
    if (ref) {
      try {
        const row = await this.#projects.row(ctx.accountId, ref);
        return { id: row.id, name: row.name };
      } catch {
        // the project was deleted since: make a new one
      }
    }
    const created = await this.#createProject(ctx, basename(folder) || folder, folder, null);
    return { id: created.id, name: created.name };
  }

  /** A live project that already has this folder (the workspace area's `project_folder`). */
  #projectWithFolder(accountId: string, folder: string): string | null {
    try {
      const row = this.#db.raw
        .prepare(
          `SELECT p.id AS id FROM project_folder f JOIN project p ON p.id = f.project_id
           WHERE p.account_id = ? AND p.deleted_at IS NULL AND f.path = ?
           ORDER BY p.created_at LIMIT 1`,
        )
        .get(accountId, folder) as { id: string } | undefined;
      return row?.id ?? null;
    } catch {
      // No project folders on this Hub.
      return null;
    }
  }

  async #applyInstructions(
    ctx: ApplyContext,
    e: Entry,
    p: Extract<ImportPayload, { kind: 'instructions' }>,
  ): Promise<Applied> {
    const { text, moved } = await this.#moveTextSecrets(ctx, e, p.text);
    if (p.scope === 'user') {
      const path = this.userInstructionsPath;
      const current = existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : '';
      const block = `<!-- Imported from ${e.item.sourcePath} -->\n${text}\n`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeAtomic(path, current ? `${current}\n\n${block}` : block);
      return {
        targetRef: 'user-instructions',
        target: 'user instructions',
        disabled: false,
        secrets: moved,
      };
    }
    const target = await this.#projectFor(ctx, p.dir);
    const row = await this.#projects.row(ctx.accountId, target.id);
    const merged = row.instructions ? `${row.instructions.trimEnd()}\n\n${text}` : text;
    await this.#projects.update(ctx.accountId, target.id, {
      instructions: merged.slice(0, SCAN_LIMITS.maxInstructionChars),
    });
    return {
      targetRef: target.id,
      target: `instructions of project ${target.name}`,
      disabled: false,
      secrets: moved,
    };
  }

  /**
   * A skill (or a command turned into one) goes in through the skill index, from a staging copy
   * in Nova's data directory so a renamed skill carries its new name in SKILL.md.
   */
  async #applySkill(
    ctx: ApplyContext,
    e: Entry,
    original: string,
    files: { rel: string; from: string }[],
    skillMd: string,
    suffix = '',
  ): Promise<Applied> {
    const skills = this.#targets.skills;
    if (!skills) throw new NovaError('capability_missing', 'skills cannot be imported on this Hub');
    // The name may have been taken since the preview.
    const name = nextFree(e.targetName, (n) => existsSync(join(this.skillsDir, n)), 64);
    const staging = join(this.#dataDir, 'import', ctx.importId, 'skills', name);
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const f of files) {
        if (f.rel === 'SKILL.md') continue;
        const to = resolveWithin([staging], f.rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(f.from));
      }
      writeFileSync(
        join(staging, 'SKILL.md'),
        name === original ? skillMd : renameSkill(skillMd, name),
      );
      const view = await skills.importFolder(ctx.accountId, staging, {
        name,
        provenance: this.#provenance(ctx, e),
      });
      return {
        targetRef: view.id,
        target: `skill ${view.name}${suffix}`,
        disabled: false,
        secrets: 0,
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  #provenance(ctx: ApplyContext, e: Entry): Record<string, unknown> {
    return { importId: ctx.importId, sourcePath: e.item.sourcePath, sha256: e.item.sha256 };
  }

  async #applyPlugin(
    ctx: ApplyContext,
    e: Entry,
    p: Extract<ImportPayload, { kind: 'plugins' }>,
  ): Promise<Applied> {
    const plugins = this.#targets.plugins;
    if (!plugins)
      throw new NovaError('capability_missing', 'plugins cannot be installed on this Hub');
    const staging = join(this.#dataDir, 'import', ctx.importId, 'plugins', slug(p.name) || e.ref);
    const refs: string[] = [];
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const rel of p.files) {
        const to = resolveWithin([staging], rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(join(p.dir, rel)));
      }
      // Secrets in the plugin's servers move to the vault before its manifest is stored; the
      // manifest keeps only references under the plugin's own namespace.
      const servers: Record<string, Record<string, unknown>> = {};
      for (const srv of p.servers) {
        const secretNames = new Set(srv.plan.secrets.map((s) => s.name));
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(srv.plan.env)) {
          if (!secretNames.has(k)) {
            values[k] = v;
            continue;
          }
          const ref = pluginSecretRef(p.pluginId, srv, k);
          await this.#secrets.put(ref, v);
          refs.push(ref);
          values[k] = ref;
          await this.#auditSecret(ctx, ref, 'plugins');
        }
        servers[srv.key] = serverEntry(srv, values, p.generated);
      }
      const manifest: Record<string, unknown> = { ...p.manifest };
      if (Object.keys(servers).length) manifest.mcpServers = servers;
      else delete manifest.mcpServers;
      mkdirSync(join(staging, '.nova-plugin'), { recursive: true });
      writeFileSync(
        join(staging, '.nova-plugin', 'plugin.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const installed = await plugins.installDisabled(ctx.accountId, staging);
      return {
        targetRef: installed.id,
        target: `plugin ${installed.name} (disabled)`,
        disabled: true,
        secrets: refs.length,
      };
    } catch (err) {
      for (const ref of refs) await this.#secrets.delete(ref).catch(() => false);
      throw err;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async #applyServer(ctx: ApplyContext, e: Entry, plan: McpServerPlan): Promise<Applied> {
    const taken = new Set(
      (
        await this.#db.orm
          .select({ name: mcpServer.name })
          .from(mcpServer)
          .where(eq(mcpServer.accountId, ctx.accountId))
      ).map((r) => r.name),
    );
    const name = nextFree(e.targetName, (n) => taken.has(n), 40);
    const id = e.serverId;
    const env: Record<string, string> = {};
    const secretNames = new Set(plan.secrets.map((s) => s.name));
    try {
      // Every value goes to the vault, as the MCP area stores a server's environment (FR-101).
      for (const [k, v] of Object.entries(plan.env)) {
        const ref = secretRef('mcp', id, 'env', k);
        await this.#secrets.put(ref, v);
        env[k] = ref;
        if (secretNames.has(k)) await this.#auditSecret(ctx, ref, 'mcp_servers');
      }
      const now = this.#now().toISOString();
      await this.#db.transaction(() =>
        this.#db.orm.insert(mcpServer).values({
          id,
          accountId: ctx.accountId,
          name,
          transport: plan.transport,
          command: plan.transport === 'stdio' ? plan.command : null,
          argsJson: JSON.stringify(plan.args),
          url: plan.transport === 'stdio' ? null : plan.url,
          envRefJson: JSON.stringify(env),
          configJson: JSON.stringify(DEFAULT_SERVER_CONFIG),
          source: 'import',
          pluginId: null,
          deviceId: null,
          bundleManifestJson: null,
          signatureStatus: null,
          bundleSha256: null,
          installRecordJson: null,
          // Disabled until its permissions are declared and confirmed (FR-200).
          enabled: false,
          lastStatus: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (err) {
      for (const ref of Object.values(env)) await this.#secrets.delete(ref).catch(() => false);
      throw err;
    }
    await this.#audit?.append({
      accountId: ctx.accountId,
      actor: 'user',
      kind: 'mcp',
      action: 'add',
      resource: `mcp_server:${id}`,
      detail: {
        name,
        transport: plan.transport,
        source: 'import',
        enabled: false,
        envKeys: Object.keys(env).sort(),
        importId: ctx.importId,
      },
    });
    return {
      targetRef: id,
      target: `MCP server ${name} (disabled)`,
      disabled: true,
      secrets: plan.secrets.length,
    };
  }

  async #applyMemories(
    ctx: ApplyContext,
    p: Extract<ImportPayload, { kind: 'memories' }>,
  ): Promise<Applied> {
    const r = await this.#memory.import(ctx.accountId, {
      format: 'json',
      data: JSON.stringify(p.facts),
      scopeKind: 'global',
    });
    return {
      targetRef: null,
      target: `${r.imported} memory item${r.imported === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already known or invalid)` : ''}`,
      disabled: false,
      secrets: 0,
    };
  }

  async #applyChat(
    ctx: ApplyContext,
    e: Entry,
    p: Extract<ImportPayload, { kind: 'chats' }>,
  ): Promise<Applied> {
    const chat = p.chat;
    const id = uuidv7();
    const now = this.#now();
    // Original times are kept; they only ever move forward within a chat.
    let last = Date.parse(chat.createdAt ?? '') || now.getTime();
    const rows = chat.messages.map((m) => {
      const t = Math.max(Date.parse(m.createdAt ?? '') || last, last);
      last = t + 1;
      return { id: uuidv7(), role: m.role, text: m.text, at: new Date(t).toISOString() };
    });
    const createdAt = new Date(
      Date.parse(chat.createdAt ?? '') || Date.parse(rows[0]!.at),
    ).toISOString();
    const updatedAt = rows.at(-1)!.at;
    const metadata = JSON.stringify({
      imported: { importId: ctx.importId, source: e.item.sourcePath },
    });
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      raw
        .prepare(
          `INSERT INTO thread (id, account_id, mode, title, metadata, created_at, updated_at)
           VALUES (?, ?, 'chat', ?, ?, ?, ?)`,
        )
        .run(id, ctx.accountId, chat.title, metadata, createdAt, updatedAt);
      const msg = raw.prepare(
        `INSERT INTO message (id, thread_id, role, provenance, status, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'import', 'complete', ?, ?, ?)`,
      );
      const part = raw.prepare(
        `INSERT INTO message_part (id, message_id, idx, type, content, created_at)
         VALUES (?, ?, 0, 'text', ?, ?)`,
      );
      let parent: string | null = null;
      for (const r of rows) {
        msg.run(r.id, id, r.role, parent, r.at, r.at);
        part.run(uuidv7(), r.id, r.text, r.at);
        parent = r.id;
      }
      raw.prepare('UPDATE thread SET active_leaf_id = ? WHERE id = ?').run(parent, id);
    });
    const title = chat.title ?? 'Untitled chat';
    return {
      targetRef: id,
      target: `chat ${title} (${rows.length} message${rows.length === 1 ? '' : 's'})`,
      disabled: false,
      secrets: 0,
    };
  }

  // ---- ledger ---------------------------------------------------------------------------------

  async records(accountId: string, limit = 1000): Promise<ImportRecordView[]> {
    const rows = await this.#db.orm
      .select()
      .from(importRecord)
      .where(eq(importRecord.accountId, accountId))
      .orderBy(desc(importRecord.importedAt), desc(importRecord.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      kind: SOURCE_TO_KIND[r.sourceKind],
      sourcePath: r.sourcePath,
      sha256: r.sha256,
      target: r.target ?? r.targetRef ?? '',
      createdAt: r.importedAt,
    }));
  }

  // ---- helpers --------------------------------------------------------------------------------

  #expire(): void {
    const cutoff = Date.now() - this.#ttl;
    for (const [id, p] of this.#previews) if (p.at < cutoff) this.#previews.delete(id);
  }

  /** One apply per account at a time, so dedupe checks and writes never interleave. */
  #serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(accountId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#chains.set(accountId, tail);
    void tail.then(() => {
      if (this.#chains.get(accountId) === tail) this.#chains.delete(accountId);
    });
    return run;
  }
}

// ---- pure helpers ---------------------------------------------------------------------------------

function baseName(item: ScannedItem): string {
  const p = item.payload;
  switch (p.kind) {
    case 'skills':
    case 'commands':
      return p.name;
    case 'mcp_servers':
      return p.plan.name;
    case 'projects':
      return p.name;
    default:
      return item.name;
  }
}

function claimName(
  item: ScannedItem,
  name: string,
  claimed: { skills: Set<string>; servers: Set<string>; projects: Set<string> },
): void {
  if (item.kind === 'skills' || item.kind === 'commands') claimed.skills.add(name);
  if (item.kind === 'mcp_servers') claimed.servers.add(name);
  if (item.kind === 'projects') claimed.projects.add(name.toLowerCase());
}

/** `name`, else `name-2`, `name-3`, … within `max` characters. */
function nextFree(name: string, taken: (n: string) => boolean, max: number): string {
  if (!taken(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new NovaError('conflict', `no free name for ${name}`);
}

/** `Name`, else `Name (2)`, `Name (3)`, … */
function nextFreeTitle(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name.slice(0, 190)} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  throw new NovaError('conflict', `no free name for ${name}`);
}

function targetLabel(
  p: ImportPayload,
  name: string,
  projectFolders: ReadonlyMap<string, string>,
): string {
  switch (p.kind) {
    case 'instructions':
      if (p.scope === 'user') return 'user instructions';
      return `instructions of project ${projectFolders.get(p.dir) ?? basename(p.dir)}${
        projectFolders.has(p.dir) ? '' : ' (created for its folder if needed)'
      }`;
    case 'skills':
      return `skill ${name}`;
    case 'commands':
      return `skill ${name} (from a command)`;
    case 'plugins':
      return `plugin ${p.name} (disabled)`;
    case 'mcp_servers':
      return `MCP server ${name} (disabled)`;
    case 'projects':
      return p.folder ? `project ${name} with folder ${p.folder}` : `project ${name}`;
    case 'memories':
      return `${p.facts.length} memory item${p.facts.length === 1 ? '' : 's'}`;
    case 'chats':
      return `chat ${p.chat.title ?? 'Untitled chat'} (${p.chat.messages.length} messages)`;
  }
}

function joinNotes(notes: (string | null | undefined)[]): string | null {
  const list = notes.filter((n): n is string => !!n);
  return list.length ? list.join('; ') : null;
}

function textSecretRef(ref: string, n: number): string {
  return secretRef('import', ref, 'text', `secret_${n + 1}`);
}

/** A reference under the plugin's own namespace, the only one its manifest may name. */
function pluginSecretRef(pluginId: string, srv: PluginServer, name: string): string {
  const seg = (v: string) => v.replace(/[^A-Za-z0-9_.:-]+/g, '-') || 'x';
  return secretRef('plugin', seg(pluginId), seg(srv.key), name);
}

/**
 * A plugin manifest server entry (mcp-config.json). Nova's own entries keep everything they say
 * except the values that moved; generated ones are built from the plan. For sse/http the plan's
 * names are headers (`X_Api_Key` → `X-Api-Key`).
 */
function serverEntry(
  srv: PluginServer,
  values: Record<string, string>,
  generated: boolean,
): Record<string, unknown> {
  const plan = srv.plan;
  const base: Record<string, unknown> = generated ? {} : { ...srv.original };
  delete base.env;
  delete base.headers;
  if (plan.transport === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: plan.command,
      ...(plan.args.length ? { args: plan.args } : {}),
      ...(Object.keys(values).length ? { env: values } : {}),
    };
  }
  delete base.args;
  const headers = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.replace(/_/g, '-'), v]),
  );
  return {
    ...base,
    transport: plan.transport,
    url: plan.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
