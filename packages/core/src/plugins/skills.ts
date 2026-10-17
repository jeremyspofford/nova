// The skill index (FR-046, ADR-067, docs/08 §4): skills are folders found under their roots
// (managed, project, user, plugin, built-in), never copied into the database. Name collisions
// resolve managed > project > user > plugin > built-in and the losers carry `shadowedBy`. Only a
// catalog (names and descriptions) enters the context; `skill.load` returns a body on use.
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
import { join, relative, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type SkillDetail,
  type SkillSource,
  type SkillView,
  type SlashCommandView,
  type createSkillSchema,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ResolvedSkill, SkillCatalogProvider } from '../extensions/types.ts';
import { argsOf, builtinDescriptor, fail, ok, str, type BuiltinTool } from '../tools/builtin.ts';
import { CHARS_PER_TOKEN, clip } from '../tools/text.ts';
import type { ToolSourceProvider } from '../tools/types.ts';
import { renderFrontmatter } from './frontmatter.ts';
import { listFiles, reallyInside, resolveInside } from './paths.ts';
import {
  readSkillFolder,
  SKILL_FILE_MAX_BYTES,
  SKILL_NAME,
  type ParsedSkill,
} from './skill-file.ts';
import type { PluginRegistrations } from './types.ts';

const { pluginInstall, skillState } = schema;

/** Precedence ranks: lower wins (docs/08 §4). Import lives in the user folder. */
const RANK: Record<SkillSource, number> = {
  managed: 1,
  project: 2,
  user: 3,
  import: 3,
  plugin: 4,
  builtin: 5,
};

/** Catalog budget: 2 % of the context window, at most 10,000 tokens; 8,000 characters unknown. */
export const SKILL_CATALOG_SHARE = 0.02;
export const SKILL_CATALOG_MAX_TOKENS = 10_000;
export const SKILL_CATALOG_UNKNOWN_CHARS = 8_000;
const MAX_SKILLS_PER_ROOT = 500;
const LOAD_MAX_CHARS = 200_000;

export type CreateSkillRequest = z.input<typeof createSkillSchema>;

/** One skill found on disk, before its state and precedence are applied. */
export interface SkillRecord extends ParsedSkill {
  id: string;
  source: SkillSource;
  pluginId: string | null;
  projectId: string | null;
  /** The folder holding SKILL.md. */
  dir: string;
  rank: number;
  /** Discovery order inside its rank (nearer project folders and `.nova` first). */
  order: number;
}

/** A skill with its state and precedence applied. */
export interface IndexedSkill extends SkillRecord {
  enabled: boolean;
  shadowedBy: string | null;
  /** Wins its bare name: in the catalog, the slash list and bare-name resolution. */
  active: boolean;
}

export interface SkillProjectFolder {
  path: string;
  /** Tool access to the folder; new project skills go to a `write` folder first. */
  access?: string | null;
}

export interface SkillIndexOptions {
  db: NovaDatabase;
  /** The user skills folder, `<dataDir>/skills`. */
  userDir: string;
  /** Skills shipped with Nova; absent folders are fine. */
  builtinDir?: string | null;
  /** The managed-policy skills folder (M8); none by default. */
  managedDir?: () => string | null;
  /** A project's local folders, nearest first; defaults to the `project_folder` table when present. */
  projectFolders?: (accountId: string, projectId: string) => Promise<SkillProjectFolder[]>;
  events?: EventSink;
  log?: Logger;
}

function idFor(
  source: SkillSource,
  name: string,
  opts: { pluginId?: string | null; projectId?: string | null },
): string {
  if (source === 'plugin') return `skill:${opts.pluginId}:${name}`;
  if (source === 'project') return `skill:project:${opts.projectId}:${name}`;
  return `skill:${source}:${name}`;
}

/** The parts of a canonical skill id; null when it is not one. */
export function parseSkillId(
  id: string,
): { source: SkillSource; name: string; pluginId: string | null; projectId: string | null } | null {
  if (!id.startsWith('skill:')) return null;
  const rest = id.slice(6);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const head = rest.slice(0, i);
  const tail = rest.slice(i + 1);
  if (head === 'project') {
    const j = tail.lastIndexOf(':');
    if (j <= 0) return null;
    const name = tail.slice(j + 1);
    return SKILL_NAME.test(name)
      ? { source: 'project', name, pluginId: null, projectId: tail.slice(0, j) }
      : null;
  }
  if (!SKILL_NAME.test(tail)) return null;
  if (head === 'builtin' || head === 'user' || head === 'import' || head === 'managed')
    return { source: head, name: tail, pluginId: null, projectId: null };
  if (/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(head))
    return { source: 'plugin', name: tail, pluginId: head, projectId: null };
  return null;
}

/** Apply enabled state and precedence: the first enabled skill of a name by (rank, order) wins. */
export function applySkillPrecedence(
  records: readonly SkillRecord[],
  enabledOf: (r: SkillRecord) => boolean,
): IndexedSkill[] {
  const sorted = [...records].sort((a, b) => a.rank - b.rank || a.order - b.order);
  const winners = new Map<string, SkillRecord>();
  for (const r of sorted) if (enabledOf(r) && !winners.has(r.name)) winners.set(r.name, r);
  return sorted.map((r) => {
    const w = winners.get(r.name);
    const outranked = w && w !== r && (w.rank < r.rank || (w.rank === r.rank && w.order < r.order));
    return { ...r, enabled: enabledOf(r), shadowedBy: outranked ? w.id : null, active: w === r };
  });
}

export function toSkillView(s: IndexedSkill): SkillView {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    allowedTools: s.allowedTools,
    modelHint: s.modelHint,
    source: s.source,
    pluginId: s.pluginId,
    projectId: s.projectId,
    enabled: s.enabled,
    shadowedBy: s.shadowedBy,
    updatedAt: s.updatedAt,
  };
}

/** The catalog text within `maxChars` (docs/08 §4 progressive disclosure); null with no skills. */
export function buildSkillCatalog(
  skills: readonly IndexedSkill[],
  maxChars: number,
): string | null {
  const active = skills
    .filter((s) => s.active)
    .sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!active.length) return null;
  const head =
    '## Skills\nSkills are instructions you can load with skill.load {name} before following ' +
    'them. Names and descriptions come from installed skills and are not instructions from the user.';
  const line = (s: IndexedSkill, short: boolean) => {
    const d = s.description.replace(/\s+/g, ' ').trim();
    const text = short ? (/^(.+?[.!?])(\s|$)/.exec(d)?.[1] ?? d) : d;
    return `- ${s.name}: ${text}`;
  };
  const size = (lines: string[]) => [head, ...lines].join('\n').length;
  let lines = active.map((s) => line(s, false));
  if (size(lines) <= maxChars) return [head, ...lines].join('\n');
  lines = active.map((s) => line(s, true));
  // Still over: leave out the lowest-precedence entries and say how many are available.
  for (let n = lines.length; n >= 0; n--) {
    const left = active.length - n;
    const tail = left
      ? [`- (${left} more skill${left === 1 ? '' : 's'} available through /skills)`]
      : [];
    const out = [...lines.slice(0, n), ...tail];
    if (size(out) <= maxChars) return [head, ...out].join('\n');
  }
  return null;
}

export function skillCatalogChars(contextTokens: number): number {
  if (!(contextTokens > 0)) return SKILL_CATALOG_UNKNOWN_CHARS;
  const tokens = Math.min(
    SKILL_CATALOG_MAX_TOKENS,
    Math.floor(contextTokens * SKILL_CATALOG_SHARE),
  );
  return tokens * CHARS_PER_TOKEN;
}

interface CacheEntry {
  key: string;
  parse: ReturnType<typeof readSkillFolder>;
}

export class SkillIndex implements SkillCatalogProvider {
  readonly #db: NovaDatabase;
  readonly #opts: SkillIndexOptions;
  readonly #log: Logger;
  readonly #cache = new Map<string, CacheEntry>();
  readonly tools: ToolSourceProvider;

  constructor(opts: SkillIndexOptions) {
    this.#db = opts.db;
    this.#opts = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.skills', sinks: [] });
    const load = this.#loadTool();
    this.tools = {
      source: 'builtin',
      // Listed only while the account has a skill, so turns without skills carry no extra tool.
      list: async (accountId) => {
        try {
          return (await this.hasSkills(accountId)) ? [load] : [];
        } catch (err) {
          this.#log.warn('skill tool listing failed', { err });
          return [];
        }
      },
    };
  }

  /** Every skill visible to the account (and project), state and precedence applied. */
  async list(accountId: string, projectId: string | null = null): Promise<IndexedSkill[]> {
    const records = await this.#discover(accountId, projectId);
    const states = await this.#states(accountId);
    return applySkillPrecedence(records, (r) =>
      r.source === 'managed' ? true : (states.get(r.id)?.enabled ?? true),
    );
  }

  async views(accountId: string, projectId: string | null = null): Promise<SkillView[]> {
    return (await this.list(accountId, projectId)).map(toSkillView);
  }

  async hasSkills(accountId: string): Promise<boolean> {
    return (await this.list(accountId, null)).some((s) => s.active);
  }

  /** One skill by id, with its body and files; `not_found` otherwise. */
  async get(accountId: string, id: string): Promise<SkillDetail> {
    const s = await this.#find(accountId, id);
    return {
      ...toSkillView(s),
      body: s.body,
      files: listFiles(s.dir).filter((f) => f !== 'SKILL.md'),
    };
  }

  async #find(accountId: string, id: string): Promise<IndexedSkill> {
    const parsed = parseSkillId(id);
    if (!parsed) throw new NovaError('not_found', 'skill not found');
    const all = await this.list(accountId, parsed.projectId);
    const s = all.find((x) => x.id === id);
    if (!s) throw new NovaError('not_found', 'skill not found');
    return s;
  }

  /** The slash commands after precedence (FR-046): winners by bare name, namespaced plugin losers. */
  async slashCommands(
    accountId: string,
    projectId: string | null = null,
  ): Promise<SlashCommandView[]> {
    const out: SlashCommandView[] = [];
    for (const s of await this.list(accountId, projectId)) {
      if (!s.enabled) continue;
      const name = s.active ? s.name : s.source === 'plugin' ? `${s.pluginId}:${s.name}` : null;
      if (!name) continue;
      out.push({
        name,
        description: s.description,
        skillId: s.id,
        source: s.source,
        pluginId: s.pluginId,
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async catalogSection(
    accountId: string,
    projectId: string | null,
    contextTokens: number,
  ): Promise<string | null> {
    return buildSkillCatalog(
      await this.list(accountId, projectId),
      skillCatalogChars(contextTokens),
    );
  }

  /** By bare name (the winner), `<pluginId>:<name>` or a full skill id; enabled skills only. */
  async resolve(
    accountId: string,
    projectId: string | null,
    name: string,
  ): Promise<ResolvedSkill | null> {
    const s = await this.#lookup(accountId, projectId, name);
    if (!s) return null;
    return {
      skillId: s.id,
      name: s.name,
      body: s.body,
      allowedTools: s.allowedTools,
      files: listFiles(s.dir).filter((f) => f !== 'SKILL.md'),
    };
  }

  async #lookup(
    accountId: string,
    projectId: string | null,
    raw: string,
  ): Promise<IndexedSkill | null> {
    const name = raw.trim().replace(/^[/@]/, '');
    const all = await this.list(accountId, projectId);
    if (name.startsWith('skill:')) return all.find((s) => s.id === name && s.enabled) ?? null;
    const colon = name.lastIndexOf(':');
    if (colon > 0) {
      const pluginId = name.slice(0, colon);
      const bare = name.slice(colon + 1);
      return (
        all.find(
          (s) => s.source === 'plugin' && s.pluginId === pluginId && s.name === bare && s.enabled,
        ) ?? null
      );
    }
    return all.find((s) => s.active && s.name === name) ?? null;
  }

  // ---- writes -----------------------------------------------------------------------------

  /** A new user skill (or project skill with `projectId`); `origin: 'import'` marks imports. */
  async create(
    accountId: string,
    req: CreateSkillRequest,
    opts: { origin?: 'import'; provenance?: Record<string, unknown> } = {},
  ): Promise<SkillView> {
    if (!SKILL_NAME.test(req.name)) throw new NovaError('validation', 'invalid skill name');
    let parent: string;
    let source: SkillSource;
    if (req.projectId) {
      parent = await this.#projectSkillsDir(accountId, req.projectId);
      source = 'project';
    } else {
      parent = this.#opts.userDir;
      source = opts.origin ?? 'user';
    }
    const dir = join(parent, req.name);
    if (existsSync(dir))
      throw new NovaError('conflict', `a skill named ${req.name} already exists`);
    const text =
      renderFrontmatter({
        name: req.name,
        description: req.description,
        when_to_use: req.whenToUse,
        allowed_tools: req.allowedTools?.length ? req.allowedTools : undefined,
      }) + req.body.replace(/\r\n?/g, '\n');
    if (Buffer.byteLength(text) > SKILL_FILE_MAX_BYTES)
      throw new NovaError('validation', 'the skill is larger than 1 MB');
    this.#writeFolder(parent, req.name, { 'SKILL.md': text });
    const id = idFor(source, req.name, { projectId: req.projectId ?? null });
    if (opts.origin)
      await this.#setState(accountId, id, {
        origin: opts.origin,
        provenance: opts.provenance ?? null,
      });
    await this.#changed(accountId, id);
    return toSkillView(await this.#find(accountId, id));
  }

  /** Copy a skill folder into the user folder as an import (FR-200); SKILL.md is validated first. */
  async importFolder(
    accountId: string,
    folder: string,
    opts: { provenance?: Record<string, unknown>; name?: string } = {},
  ): Promise<SkillView> {
    const parsed = readSkillFolder(folder);
    if (!parsed.ok) throw new NovaError('validation', `not a valid skill: ${parsed.error}`);
    const name = opts.name ?? parsed.skill.name;
    if (!SKILL_NAME.test(name)) throw new NovaError('validation', 'invalid skill name');
    if (existsSync(join(this.#opts.userDir, name)))
      throw new NovaError('conflict', `a skill named ${name} already exists`);
    const files: Record<string, Buffer> = {};
    for (const rel of listFiles(folder, 500))
      files[rel] = readFileSync(join(folder, ...rel.split('/')));
    this.#writeFolder(this.#opts.userDir, name, files);
    const id = idFor('import', name, {});
    await this.#setState(accountId, id, { origin: 'import', provenance: opts.provenance ?? null });
    await this.#changed(accountId, id);
    return toSkillView(await this.#find(accountId, id));
  }

  async setEnabled(accountId: string, id: string, enabled: boolean): Promise<SkillView> {
    const s = await this.#find(accountId, id);
    if (s.source === 'managed')
      throw new NovaError('policy_denied', 'managed skills cannot be disabled');
    await this.#setState(accountId, id, { enabled });
    await this.#changed(accountId, id);
    return toSkillView(await this.#find(accountId, id));
  }

  /** Only user (and imported) and project skills can be deleted (hub-api M4). */
  async delete(accountId: string, id: string): Promise<void> {
    const s = await this.#find(accountId, id);
    if (s.source !== 'user' && s.source !== 'import' && s.source !== 'project')
      throw new NovaError(
        'conflict',
        `${s.source} skills cannot be deleted; disable the skill instead`,
      );
    rmSync(s.dir, { recursive: true, force: true });
    this.#cache.delete(s.dir);
    await this.#db.transaction(() =>
      this.#db.orm
        .delete(skillState)
        .where(and(eq(skillState.accountId, accountId), eq(skillState.skillId, id))),
    );
    await this.#changed(accountId, id);
  }

  /** Forget state rows of skills that went away with a plugin. */
  async forgetPlugin(accountId: string, pluginId: string): Promise<void> {
    const rows = await this.#db.orm
      .select()
      .from(skillState)
      .where(eq(skillState.accountId, accountId));
    const gone = rows
      .filter((r) => r.skillId.startsWith(`skill:${pluginId}:`))
      .map((r) => r.skillId);
    if (!gone.length) return;
    await this.#db.transaction(async () => {
      for (const id of gone)
        await this.#db.orm
          .delete(skillState)
          .where(and(eq(skillState.accountId, accountId), eq(skillState.skillId, id)));
    });
  }

  // ---- discovery --------------------------------------------------------------------------

  async #discover(accountId: string, projectId: string | null): Promise<SkillRecord[]> {
    const out: SkillRecord[] = [];
    let order = 0;
    const states = await this.#states(accountId);
    const add = (
      dir: string,
      source: SkillSource,
      extra: { pluginId?: string; projectId?: string } = {},
    ) => {
      const parse = this.#parse(dir);
      if (!parse.ok) {
        this.#log.debug('skill skipped', { dir, error: parse.error });
        return;
      }
      let src = source;
      if (source === 'user') {
        const state = states.get(idFor('import', parse.skill.name, {}));
        if (state?.origin === 'import') src = 'import';
      }
      out.push({
        ...parse.skill,
        id: idFor(src, parse.skill.name, {
          pluginId: extra.pluginId ?? null,
          projectId: extra.projectId ?? null,
        }),
        source: src,
        pluginId: extra.pluginId ?? null,
        projectId: extra.projectId ?? null,
        dir,
        rank: RANK[src],
        order: order++,
      });
    };
    const managed = this.#opts.managedDir?.() ?? null;
    if (managed) for (const d of skillDirs(managed)) add(d, 'managed');
    if (projectId) {
      const seen = new Set<string>();
      for (const f of await this.#projectFolders(accountId, projectId)) {
        for (const sub of ['.nova/skills', '.agents/skills']) {
          for (const d of skillDirs(join(f.path, sub))) {
            const before = out.length;
            add(d, 'project', { projectId });
            // One project skill per name: the nearest folder (and `.nova` over `.agents`) wins.
            const last = out[before];
            if (last && seen.has(last.name)) out.splice(before, 1);
            else if (last) seen.add(last.name);
          }
        }
      }
    }
    for (const d of skillDirs(this.#opts.userDir)) add(d, 'user');
    for (const p of await this.#plugins(accountId)) {
      for (const s of p.skills) {
        let dir: string;
        try {
          dir = resolveInside(p.root, s.path, 'skill path');
        } catch {
          continue;
        }
        add(dir, 'plugin', { pluginId: p.pluginId });
      }
    }
    if (this.#opts.builtinDir) for (const d of skillDirs(this.#opts.builtinDir)) add(d, 'builtin');
    return out;
  }

  #parse(dir: string): ReturnType<typeof readSkillFolder> {
    let key: string;
    try {
      const st = statSync(join(dir, 'SKILL.md'));
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return { ok: false, error: 'SKILL.md is missing' };
    }
    const hit = this.#cache.get(dir);
    if (hit?.key === key) return hit.parse;
    const parse = readSkillFolder(dir);
    this.#cache.set(dir, { key, parse });
    return parse;
  }

  async #plugins(
    accountId: string,
  ): Promise<{ pluginId: string; root: string; skills: PluginRegistrations['skills'] }[]> {
    const rows = await this.#db.orm
      .select()
      .from(pluginInstall)
      .where(and(eq(pluginInstall.accountId, accountId), eq(pluginInstall.enabled, true)));
    return rows
      .sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))
      .map((r) => ({
        pluginId: r.pluginId,
        root: r.installPath,
        skills: pluginSkills(r.registrationsJson),
      }));
  }

  async #projectFolders(accountId: string, projectId: string): Promise<SkillProjectFolder[]> {
    if (this.#opts.projectFolders) return this.#opts.projectFolders(accountId, projectId);
    return projectFoldersFromTable(this.#db, accountId, projectId);
  }

  async #projectSkillsDir(accountId: string, projectId: string): Promise<string> {
    const folders = await this.#projectFolders(accountId, projectId);
    // A folder's `access` limits what tools may do there; creating a skill is the user's own
    // action, so a read-only folder is used when the project has no writable one.
    const f = folders.find((x) => x.access === 'write') ?? folders[0];
    if (!f)
      throw new NovaError(
        'conflict',
        'add a local folder to the project before creating project skills',
      );
    return join(f.path, '.nova', 'skills');
  }

  async #states(accountId: string): Promise<Map<string, typeof skillState.$inferSelect>> {
    const rows = await this.#db.orm
      .select()
      .from(skillState)
      .where(eq(skillState.accountId, accountId));
    return new Map(rows.map((r) => [r.skillId, r]));
  }

  async #setState(
    accountId: string,
    id: string,
    patch: { enabled?: boolean; origin?: 'import'; provenance?: Record<string, unknown> | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#db.transaction(async () => {
      const [cur] = await this.#db.orm
        .select()
        .from(skillState)
        .where(and(eq(skillState.accountId, accountId), eq(skillState.skillId, id)));
      const row = {
        accountId,
        skillId: id,
        enabled: patch.enabled ?? cur?.enabled ?? true,
        origin: patch.origin ?? cur?.origin ?? null,
        provenanceJson:
          patch.provenance !== undefined
            ? patch.provenance
              ? JSON.stringify(patch.provenance)
              : null
            : (cur?.provenanceJson ?? null),
        updatedAt: now,
      };
      if (cur)
        await this.#db.orm
          .update(skillState)
          .set(row)
          .where(and(eq(skillState.accountId, accountId), eq(skillState.skillId, id)));
      else await this.#db.orm.insert(skillState).values(row);
    });
  }

  /** Write a skill folder atomically: a temporary sibling renamed into place. */
  #writeFolder(parent: string, name: string, files: Record<string, string | Buffer>): void {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = join(parent, `.tmp-${uuidv7()}`);
    try {
      for (const [rel, data] of Object.entries(files)) {
        const to = resolveInside(tmp, rel, 'skill file');
        mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(to, data, { mode: 0o600 });
      }
      renameSync(tmp, join(parent, name));
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  async #changed(accountId: string, skillId: string): Promise<void> {
    await this.#opts.events?.emit({
      name: 'skill.changed',
      actor: 'user',
      accountId,
      payload: { skillId },
    });
  }

  // ---- skill.load ---------------------------------------------------------------------------

  #loadTool(): BuiltinTool {
    return {
      descriptor: builtinDescriptor({
        name: 'skill.load',
        title: 'Load skill',
        description:
          "Load a skill's instructions (SKILL.md) by name, or one of its files with `file`, and " +
          'list its files. Use it when a skill in the catalog fits the task. Scripts never run on load.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            file: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['name'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, action: 'read' },
      }),
      // Skill text is untrusted context like any file (FR-189).
      origin: 'file',
      handler: async (args, ctx) => {
        const a = argsOf(args);
        const name = str(a.name) ?? '';
        const file = str(a.file);
        const s = await this.#lookup(ctx.accountId, ctx.projectId, name);
        if (!s) return fail('skill.not_found', `no enabled skill named ${name}`);
        const files = listFiles(s.dir).filter((f) => f !== 'SKILL.md');
        let text = s.body;
        let path = 'SKILL.md';
        if (file && file !== 'SKILL.md') {
          let full: string;
          try {
            full = resolveInside(s.dir, file, 'file');
          } catch (err) {
            return fail('skill.invalid_file', err instanceof Error ? err.message : 'invalid file');
          }
          if (!existsSync(full) || !reallyInside(s.dir, full) || !statSync(full).isFile())
            return fail('skill.file_not_found', `${file} is not a file of the skill ${s.name}`);
          if (statSync(full).size > SKILL_FILE_MAX_BYTES)
            return fail('skill.file_too_large', `${file} is larger than 1 MB`);
          text = readFileSync(full, 'utf8');
          path = relative(resolve(s.dir), full).split('\\').join('/');
        }
        const listing = files.length ? files.map((f) => `- ${f}`).join('\n') : '(none)';
        return ok(
          `Skill ${s.name} (${s.id}), ${path}:\n\n${clip(text, LOAD_MAX_CHARS)}\n\nFiles:\n${listing}`,
          { skillId: s.id, name: s.name, path, files, allowedTools: s.allowedTools },
        );
      },
    };
  }
}

function pluginSkills(json: string): PluginRegistrations['skills'] {
  try {
    return (JSON.parse(json) as Partial<PluginRegistrations>).skills ?? [];
  } catch {
    return [];
  }
}

/** Child folders of a skills root that hold a SKILL.md, sorted; hidden folders skipped. */
function skillDirs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .sort()
    .slice(0, MAX_SKILLS_PER_ROOT)
    .map((n) => join(root, n))
    .filter((d) => {
      try {
        return statSync(d).isDirectory() && existsSync(join(d, 'SKILL.md'));
      } catch {
        return false;
      }
    });
}

/** Project folders from the workspace area's `project_folder` table, when it exists (FR-035). */
export function projectFoldersFromTable(
  db: NovaDatabase,
  accountId: string,
  projectId: string,
): Promise<SkillProjectFolder[]> {
  const table = db.raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_folder'")
    .get();
  if (!table) return Promise.resolve([]);
  // Only the account's own live projects.
  const own = db.raw
    .prepare('SELECT 1 FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
    .get(projectId, accountId);
  if (!own) return Promise.resolve([]);
  const rows = db.raw
    .prepare('SELECT * FROM project_folder WHERE project_id = ? ORDER BY rowid')
    .all(projectId) as Record<string, unknown>[];
  return Promise.resolve(
    rows
      .filter((r) => typeof r.path === 'string')
      .map((r) => ({
        path: r.path as string,
        access: typeof r.access === 'string' ? r.access : null,
      })),
  );
}
