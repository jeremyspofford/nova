// The import scanner (FR-200, docs/08 §4.2): walks the folders and files the user named on the
// Hub and recognises open formats. It only reads: symbolic links are not followed, tool and
// dependency folders are skipped, and every size is capped, so a scan of a large tree stays
// bounded. Recognised items keep what applying them needs (in memory only, with any secrets).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { NovaError, type ImportKind } from '@nova/shared';
import { canonicalJson } from '../../nodes/crypto.ts';
import {
  loadPluginFolder,
  parseFrontmatterMarkdown,
  readCommandFile,
  readSkillFolder,
  SKILL_NAME,
  validatePluginManifest,
} from '../../plugins/index.ts';
import {
  NOVA_MANIFEST,
  findMcpServers,
  generateManifest,
  manifestDir,
  planMcpServer,
  readChats,
  readMemories,
  readProjects,
  renderSkill,
  slug,
  type ChatExport,
  type McpServerPlan,
  type PluginLayout,
} from './formats.ts';

export const SCAN_LIMITS = {
  /** Directory entries looked at across one scan. */
  maxEntries: 50_000,
  maxDepth: 8,
  /** Items one preview lists. */
  maxItems: 5_000,
  /** A text or JSON file read whole. */
  maxFileBytes: 32 * 1024 * 1024,
  /** A chat export archive. */
  maxZipBytes: 128 * 1024 * 1024,
  /** All JSON inside one archive, unpacked. */
  maxZipUnpacked: 256 * 1024 * 1024,
  /** A skill or plugin folder copied on apply. */
  maxFolderFiles: 500,
  maxFolderBytes: 20 * 1024 * 1024,
  /** Instruction text kept (project instructions hold at most 20,000 characters). */
  maxInstructionChars: 20_000,
};

/** Folders that never hold anything to import (dependencies, VCS data, caches). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.npm',
  '.Trash',
]);

export type ImportPayload =
  | {
      kind: 'instructions';
      text: string;
      dir: string;
      scope: 'project' | 'user';
      truncated: boolean;
    }
  | { kind: 'skills'; dir: string; name: string; files: string[]; skillMd: string }
  | { kind: 'commands'; name: string; skillMd: string }
  | {
      kind: 'plugins';
      dir: string;
      files: string[];
      name: string;
      /** The manifest id its secrets are filed under (`secret://plugin/<id>/…`). */
      pluginId: string;
      /** The manifest to install with: Nova's own, or one generated from another layout. */
      manifest: Record<string, unknown>;
      generated: boolean;
      servers: PluginServer[];
    }
  | { kind: 'mcp_servers'; plan: McpServerPlan }
  | { kind: 'projects'; name: string; folder: string | null; instructions: string | null }
  | { kind: 'memories'; facts: { content: string; category: string | null }[] }
  | { kind: 'chats'; chat: ChatExport };

/** One MCP server of a plugin: its manifest key, the entry as written, and what Nova stores. */
export interface PluginServer {
  key: string;
  original: Record<string, unknown>;
  plan: McpServerPlan;
}

export interface ScannedItem {
  kind: ImportKind;
  name: string;
  sourcePath: string;
  sha256: string;
  payload: ImportPayload;
  /** Why it cannot be imported, or null. */
  unsupported: string | null;
  notes: string[];
}

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const norm = (text: string) => text.replace(/\r\n?/g, '\n').trim();

/** Instruction files known by name: the open `AGENTS.md`, rule dotfiles, `*-instructions.md`. */
function isKnownInstructionFile(name: string): boolean {
  return (
    name === 'AGENTS.md' ||
    name === 'AGENT.md' ||
    /^\.[a-z]+rules$/.test(name) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)*-instructions\.md$/.test(name)
  );
}

/**
 * An assistant's own instruction file, recognised without a list of products: `<NAME>.md` inside
 * that assistant's config folder (`.<name>/<NAME>.md`) or beside it (`<NAME>.md` next to
 * `.<name>/`).
 */
function isToolInstructionFile(name: string, dir: string, siblings: ReadonlySet<string>): boolean {
  const m = /^([A-Z][A-Z0-9]{1,23})\.md$/.exec(name);
  if (!m) return false;
  const tool = `.${m[1]!.toLowerCase()}`;
  return basename(dir) === tool || siblings.has(tool);
}

interface Walk {
  kinds: ReadonlySet<ImportKind>;
  home: string;
  items: ScannedItem[];
  entries: number;
  truncated: boolean;
}

export interface ScanOptions {
  /** The user's home folder: instruction files in its config folders apply to the user. */
  home?: string;
}

/**
 * Scan the given paths. A path that does not exist is a `validation` error. The walk yields to
 * the event loop between folders, so a large tree never stalls the Hub.
 */
export async function scanPaths(
  paths: readonly string[],
  kinds: readonly ImportKind[],
  opts: ScanOptions = {},
): Promise<{ items: ScannedItem[]; truncated: boolean }> {
  const walk: Walk = {
    kinds: new Set(kinds),
    home: resolve(opts.home ?? homedir()),
    items: [],
    entries: 0,
    truncated: false,
  };
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = expand(raw, walk.home);
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new NovaError('validation', `${raw} does not exist on the Hub`, {
        details: { field: 'paths', path: raw },
      });
    }
    if (seen.has(p)) continue;
    seen.add(p);
    if (st.isDirectory()) await walkDir(walk, p, 0);
    else if (st.isFile()) scanFile(walk, p, { explicit: true, siblings: new Set() });
  }
  return { items: walk.items, truncated: walk.truncated };
}

function expand(p: string, home: string): string {
  return resolve(p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p);
}

const tick = () => new Promise<void>((done) => setImmediate(done));

function add(walk: Walk, item: ScannedItem): void {
  if (walk.items.length >= SCAN_LIMITS.maxItems) {
    walk.truncated = true;
    return;
  }
  walk.items.push(item);
}

function readDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkDir(walk: Walk, dir: string, depth: number): Promise<void> {
  if (walk.truncated) return;
  await tick();
  const entries = readDir(dir);
  walk.entries += entries.length;
  if (walk.entries > SCAN_LIMITS.maxEntries) {
    walk.truncated = true;
    return;
  }
  const names = new Set(entries.map((e) => e.name));
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  // A plugin or a skill is one item: its own files are not scanned again.
  const mDir = manifestDir(dirs);
  if (mDir) {
    const plugin = walk.kinds.has('plugins') ? scanPlugin(dir, mDir) : null;
    if (plugin) add(walk, plugin);
    return;
  }
  if (names.has('SKILL.md') && entries.some((e) => e.name === 'SKILL.md' && e.isFile())) {
    if (walk.kinds.has('skills')) add(walk, scanSkill(dir));
    return;
  }
  if (walk.kinds.has('projects') && names.has('.git')) add(walk, folderProject(dir));
  for (const e of entries) {
    if (e.isFile()) scanFile(walk, join(dir, e.name), { explicit: false, siblings: names });
  }
  if (depth >= SCAN_LIMITS.maxDepth) return;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name))
      await walkDir(walk, join(dir, e.name), depth + 1);
  }
}

function readText(file: string): string | null {
  try {
    if (statSync(file).size > SCAN_LIMITS.maxFileBytes) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function scanFile(
  walk: Walk,
  file: string,
  ctx: { explicit: boolean; siblings: ReadonlySet<string> },
): void {
  const name = basename(file);
  const ext = extname(name).toLowerCase();
  const dir = dirname(file);
  let matched = false;

  if (walk.kinds.has('instructions')) {
    const known = isKnownInstructionFile(name) || isToolInstructionFile(name, dir, ctx.siblings);
    const chosen = ctx.explicit && ['.md', '.txt', '.mdc', ''].includes(ext);
    if (known || chosen) {
      const text = readText(file);
      if (text !== null && text.trim()) {
        add(walk, instructionItem(file, text, walk.home));
        matched = true;
      }
    }
  }
  if (walk.kinds.has('commands') && ext === '.md' && commandName(file)) {
    const text = readText(file);
    if (text !== null) {
      add(walk, commandItem(file, text));
      matched = true;
    }
  }
  if (matched) return;
  if (ext === '.json') {
    const text = readText(file);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    scanJson(walk, file, name, json, text);
  } else if ((ext === '.txt' || ext === '.md') && /^memor(y|ies)\b/i.test(name)) {
    if (!walk.kinds.has('memories')) return;
    const text = readText(file);
    if (text !== null) memoryItem(walk, file, text, false);
  } else if (ext === '.zip') {
    if (walk.kinds.has('chats') || walk.kinds.has('memories') || walk.kinds.has('projects'))
      scanZip(walk, file);
  }
}

/** A command file is a Markdown file under a `commands` folder (one sub-folder deep at most). */
function commandName(file: string): string | null {
  const parent = basename(dirname(file));
  const grand = basename(dirname(dirname(file)));
  const stem = slug(basename(file, extname(file)));
  if (!stem) return null;
  if (parent === 'commands') return stem;
  if (grand === 'commands') return slug(`${parent}-${stem}`) || null;
  return null;
}

function scanJson(walk: Walk, path: string, name: string, json: unknown, text: string): void {
  if (walk.kinds.has('mcp_servers')) {
    for (const [serverName, entry] of findMcpServers(json, name)) {
      const plan = planMcpServer(serverName, entry as Record<string, unknown>);
      add(walk, {
        kind: 'mcp_servers',
        name: serverName,
        sourcePath: `${path}#${serverName}`,
        sha256: sha(`mcp\0${canonicalJson(serverIdentity(plan))}`),
        payload: { kind: 'mcp_servers', plan },
        unsupported: plan.unsupported,
        notes: [...plan.notes],
      });
    }
  }
  if (walk.kinds.has('memories') && /^memor(y|ies)\b/i.test(name))
    memoryItem(walk, path, text, true);
  if (walk.kinds.has('projects') && /^projects\.json$/i.test(name)) {
    for (const p of readProjects(json)) {
      add(walk, {
        kind: 'projects',
        name: p.name,
        sourcePath: `${path}#${p.key}`,
        sha256: sha(`project\0export\0${p.name}\0${norm(p.instructions ?? '')}`),
        payload: { kind: 'projects', name: p.name, folder: null, instructions: p.instructions },
        unsupported: null,
        notes: [],
      });
    }
  }
  if (walk.kinds.has('chats')) {
    for (const chat of readChats(json) ?? []) {
      add(walk, {
        kind: 'chats',
        name: chat.title ?? 'Untitled chat',
        sourcePath: `${path}#${chat.key}`,
        sha256: sha(
          `chat\0${canonicalJson({ title: chat.title, messages: chat.messages.map((m) => [m.role, m.text]) })}`,
        ),
        payload: { kind: 'chats', chat },
        unsupported: null,
        notes: [],
      });
    }
  }
}

/** The parts of a server that identify it; secret values are left out of the stored hash. */
function serverIdentity(plan: McpServerPlan): unknown {
  const secret = new Set(plan.secrets.map((s) => s.name));
  return {
    name: plan.originalName,
    transport: plan.transport,
    command: plan.command,
    args: plan.args,
    url: plan.url,
    env: Object.fromEntries(Object.entries(plan.env).map(([k, v]) => [k, secret.has(k) ? '' : v])),
  };
}

function memoryItem(walk: Walk, path: string, text: string, json: boolean): void {
  const facts = readMemories(text, json);
  add(walk, {
    kind: 'memories',
    name: `${basename(path.split('!').at(-1) ?? path)} (${facts?.length ?? 0} memories)`,
    sourcePath: path,
    sha256: sha(`memories\0${canonicalJson(facts ?? [])}`),
    payload: { kind: 'memories', facts: facts ?? [] },
    unsupported: !facts ? 'not a memory export' : facts.length ? null : 'no memories found',
    notes: [],
  });
}

function scanZip(walk: Walk, file: string): void {
  let bytes: Buffer;
  try {
    if (statSync(file).size > SCAN_LIMITS.maxZipBytes) return;
    bytes = readFileSync(file);
  } catch {
    return;
  }
  const sizes = new Map<string, number>();
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (!f.name.toLowerCase().endsWith('.json') || f.name.includes('..')) return false;
        if (f.originalSize > SCAN_LIMITS.maxFileBytes) return false;
        total += f.originalSize;
        if (total > SCAN_LIMITS.maxZipUnpacked) return false;
        sizes.set(f.name, f.originalSize);
        return true;
      },
    });
  } catch {
    return;
  }
  for (const [entry, data] of Object.entries(entries)) {
    // A declared size that does not match is a damaged or hostile archive entry.
    if (data.length !== sizes.get(entry)) continue;
    let json: unknown;
    const text = Buffer.from(data).toString('utf8');
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    scanJson(walk, `${file}!${entry}`, basename(entry), json, text);
  }
}

function instructionItem(file: string, raw: string, home: string): ScannedItem {
  const dir = dirname(file);
  const text = norm(raw);
  const truncated = text.length > SCAN_LIMITS.maxInstructionChars;
  // A file in a dot folder belongs to the folder that holds it (`.github/` to its repository);
  // in the home folder (or one of its config folders) it applies to the user, elsewhere to the
  // project in that folder.
  const owner = basename(dir).startsWith('.') ? dirname(dir) : dir;
  const user = owner === home;
  return {
    kind: 'instructions',
    name: relative(user ? home : dirname(owner), file) || basename(file),
    sourcePath: file,
    sha256: sha(`instructions\0${user ? 'user' : owner}\0${text}`),
    payload: {
      kind: 'instructions',
      text: text.slice(0, SCAN_LIMITS.maxInstructionChars),
      dir: owner,
      scope: user ? 'user' : 'project',
      truncated,
    },
    unsupported: null,
    notes: truncated ? ['longer than 20,000 characters; the rest is left out'] : [],
  };
}

function commandItem(file: string, text: string): ScannedItem {
  const name = commandName(file)!;
  // Parsed as the plugins area parses commands, but named after the file, as it is invoked.
  const parsed = readCommandFile(file);
  return {
    kind: 'commands',
    name,
    sourcePath: file,
    sha256: sha(`command\0${norm(text)}`),
    payload: {
      kind: 'commands',
      name,
      skillMd: parsed.ok
        ? renderSkill(
            {
              name,
              description: parsed.skill.description,
              whenToUse: parsed.skill.whenToUse,
              allowedTools: parsed.skill.allowedTools,
            },
            parsed.skill.body,
          )
        : '',
    },
    unsupported: parsed.ok
      ? parsed.skill.body.trim()
        ? null
        : 'the command file is empty'
      : parsed.error,
    notes: [],
  };
}

/** Files of a folder to copy (relative paths), skipping links, VCS data and dependencies. */
function folderFiles(dir: string): { files: string[]; hash: string; tooBig: boolean } {
  const files: string[] = [];
  let bytes = 0;
  let tooBig = false;
  const h = createHash('sha256');
  const visit = (d: string) => {
    for (const e of readDir(d).sort((a, b) => a.name.localeCompare(b.name))) {
      if (tooBig) return;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const st = statSync(abs);
      bytes += st.size;
      if (files.length >= SCAN_LIMITS.maxFolderFiles || bytes > SCAN_LIMITS.maxFolderBytes) {
        tooBig = true;
        return;
      }
      const rel = relative(dir, abs).split(sep).join('/');
      files.push(rel);
      h.update(`${rel}\0${sha(readFileSync(abs))}\n`);
    }
  };
  visit(dir);
  return { files, hash: h.digest('hex'), tooBig };
}

function scanSkill(dir: string): ScannedItem {
  const skillMd = readText(join(dir, 'SKILL.md')) ?? '';
  const parsed = readSkillFolder(dir);
  const name = parsed.ok ? parsed.skill.name : slug(basename(dir));
  const { files, hash, tooBig } = folderFiles(dir);
  return {
    kind: 'skills',
    name: name || basename(dir),
    sourcePath: dir,
    sha256: sha(`skill\0${hash}`),
    payload: { kind: 'skills', dir, name, files, skillMd },
    unsupported: !parsed.ok
      ? parsed.error
      : tooBig
        ? 'the skill folder is larger than 20 MB or 500 files'
        : null,
    notes: parsed.ok ? parsed.skill.warnings : [],
  };
}

function folderProject(dir: string): ScannedItem {
  const name = basename(dir).slice(0, 200) || dir;
  return {
    kind: 'projects',
    name,
    sourcePath: dir,
    sha256: sha(`project\0folder\0${dir}`),
    payload: { kind: 'projects', name, folder: dir, instructions: null },
    unsupported: null,
    notes: [],
  };
}

function scanPlugin(dir: string, mDir: string): ScannedItem | null {
  const text = readText(join(dir, mDir, 'plugin.json'));
  if (text === null) return null;
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null;
  const manifest = source as Record<string, unknown>;
  const nova = `${mDir}/plugin.json` === NOVA_MANIFEST;
  const { files, hash, tooBig } = folderFiles(dir);
  const name =
    typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : basename(dir);
  const notes: string[] = [];
  let unsupported: string | null = tooBig
    ? 'the plugin folder is larger than 20 MB or 500 files'
    : null;

  // Servers come from the manifest, or from a `.mcp.json` beside it in other layouts.
  const serverMap: Record<string, unknown> = {};
  const declared = manifest.mcpServers;
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared))
    Object.assign(serverMap, declared);
  else if (!nova) {
    const mcp = readText(join(dir, '.mcp.json'));
    try {
      const parsed: unknown = mcp ? JSON.parse(mcp) : null;
      for (const [k, v] of findMcpServers(parsed, '.mcp.json')) serverMap[k] = v;
    } catch {
      notes.push('its .mcp.json is not valid JSON');
    }
  }
  const servers: PluginServer[] = [];
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(serverMap)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const original = entry as Record<string, unknown>;
    const plan = planMcpServer(key, original);
    if (plan.unsupported) {
      notes.push(`MCP server ${key} is left out: ${plan.unsupported}`);
      continue;
    }
    // Generated manifests use valid, distinct server keys (plugin-manifest.json).
    let k = nova ? key : plan.name;
    for (let n = 2; !nova && keys.has(k); n++) k = `${plan.name.slice(0, 36)}-${n}`;
    keys.add(k);
    servers.push({ key: k, original, plan });
  }

  let out = manifest;
  if (nova) {
    // Nova's own layout is checked exactly as the plugins area will install it.
    if (!unsupported) {
      try {
        loadPluginFolder(dir);
      } catch (err) {
        unsupported = err instanceof Error ? err.message : String(err);
      }
    }
  } else {
    const layout = pluginLayout(dir, files, notes);
    out = generateManifest(
      manifest,
      layout,
      servers.flatMap((s) => s.plan.hosts),
    );
    try {
      validatePluginManifest(out);
    } catch (err) {
      unsupported ??= err instanceof Error ? err.message : String(err);
    }
    notes.push('a Nova manifest is generated for Nova’s copy; the original is not changed');
  }
  const id =
    typeof out.id === 'string' && out.id ? out.id : `imported.${slug(name, 60) || 'plugin'}`;
  return {
    kind: 'plugins',
    name,
    sourcePath: dir,
    sha256: sha(`plugin\0${hash}`),
    payload: {
      kind: 'plugins',
      dir,
      files,
      name,
      pluginId: id,
      manifest: out,
      generated: !nova,
      servers,
    },
    unsupported,
    notes,
  };
}

/**
 * Components of a plugin in another layout, from the conventional folders. Only parts the plugins
 * area accepts are listed (a skill, command or role that does not parse would fail the whole
 * install); the rest are named in the notes.
 */
function pluginLayout(dir: string, files: string[], notes: string[]): PluginLayout {
  const skills: string[] = [];
  const commands: string[] = [];
  const agents: string[] = [];
  const names = new Set<string>();
  const skipped: string[] = [];
  let hasHooks = false;
  const take = (name: string) => {
    if (names.has(name)) return false;
    names.add(name);
    return true;
  };
  for (const f of files) {
    const parts = f.split('/');
    if (parts[0] === 'hooks') hasHooks = true;
    if (parts[0] === 'skills' && parts.length === 3 && parts[2] === 'SKILL.md') {
      const p = readSkillFolder(join(dir, parts[0], parts[1]!));
      if (p.ok && take(p.skill.name)) skills.push(`skills/${parts[1]}`);
      else skipped.push(`skills/${parts[1]}`);
    } else if (parts[0] === 'commands' && parts.length >= 2 && f.endsWith('.md')) {
      const p = readCommandFile(join(dir, ...parts));
      if (p.ok && take(p.skill.name)) commands.push(f);
      else skipped.push(f);
    } else if (parts[0] === 'agents' && parts.length === 2 && f.endsWith('.md')) {
      if (isRoleFile(join(dir, ...parts), parts[1]!)) agents.push(f);
      else skipped.push(f);
    }
  }
  if (hasHooks) notes.push('its hooks use another format and are not imported');
  if (skipped.length) notes.push(`left out (not valid here): ${skipped.slice(0, 10).join(', ')}`);
  return { skills: skills.sort(), commands, agents, hasHooks };
}

/** A sub-agent file the plugins area can read as a role: a name, a description and a body. */
function isRoleFile(file: string, fileName: string): boolean {
  const text = readText(file);
  if (text === null) return false;
  try {
    const md = parseFrontmatterMarkdown(text);
    const name = typeof md.data.name === 'string' ? md.data.name : fileName.replace(/\.md$/i, '');
    const d = md.data.description;
    return (
      SKILL_NAME.test(name) &&
      typeof d === 'string' &&
      d.trim().length > 0 &&
      d.length <= 1024 &&
      md.body.trim().length > 0
    );
  } catch {
    return false;
  }
}
