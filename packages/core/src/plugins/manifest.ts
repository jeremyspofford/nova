// Loading a plugin folder (FR-045, docs/08 §3.1): `.nova-plugin/plugin.json` validated against
// contracts/schemas/plugin-manifest.json (unknown fields refused), every component path kept
// inside the folder, skills and commands parsed as skills, roles and hooks read, MCP servers
// checked. Loading never writes anything: the preview and the installer share it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contracts, type Validator } from '@nova/contracts';
import { NovaError } from '@nova/shared';
import { FrontmatterError, parseFrontmatterMarkdown } from './frontmatter.ts';
import { pluginHookContentHash } from './hook-hash.ts';
import { realInside, resolveInside } from './paths.ts';
import {
  modelHintText,
  readCommandFile,
  readSkillFolder,
  SKILL_FILE_MAX_BYTES,
  SKILL_NAME,
  toolList,
  type ParsedSkill,
} from './skill-file.ts';
import type {
  PluginHookConfig,
  PluginManifest,
  PluginMcpServerConfig,
  PluginUiEntryPoint,
} from './types.ts';

export const PLUGIN_MANIFEST_PATH = '.nova-plugin/plugin.json';
/** Where install writes converted commands; a plugin may not bring this folder itself. */
export const COMMANDS_DIR = '.nova-plugin/commands';
const MANIFEST_MAX_BYTES = 256 * 1024;
const HOOKS_MAX_BYTES = 256 * 1024;
const SERVER_NAME = /^[a-z0-9-]{1,40}$/;

export interface LoadedPluginSkill extends ParsedSkill {
  kind: 'skill' | 'command';
  /** For skills, the folder relative to the plugin root; for commands, the command file. */
  sourcePath: string;
}

export interface LoadedPluginRole {
  /** `<pluginId>:<name>`. */
  key: string;
  name: string;
  description: string;
  tools: string[];
  modelHint: string | null;
  instructions: string;
  sourcePath: string;
}

export interface LoadedPluginHook {
  hook: PluginHookConfig;
  contentHash: string;
}

export interface LoadedPluginServer {
  /** The manifest key. */
  key: string;
  config: PluginMcpServerConfig;
}

export interface LoadedPlugin {
  root: string;
  manifest: PluginManifest;
  skills: LoadedPluginSkill[];
  roles: LoadedPluginRole[];
  hooks: LoadedPluginHook[];
  servers: LoadedPluginServer[];
  uiEntryPoints: PluginUiEntryPoint[];
  warnings: string[];
}

let manifestValidator: Validator | null = null;
let hooksValidator: Validator | null = null;

function invalid(where: string, message: string, details?: unknown): NovaError {
  return new NovaError(
    'validation',
    `${where}: ${message}`,
    details ? { details: details as Record<string, unknown> } : {},
  );
}

function readJson(file: string, max: number, what: string): unknown {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw invalid(what, 'file not found');
  }
  if (!st.isFile()) throw invalid(what, 'not a file');
  if (st.size > max) throw invalid(what, `larger than ${max} bytes`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw invalid(what, `not valid JSON (${err instanceof Error ? err.message : 'parse error'})`);
  }
}

interface SchemaIssue {
  path: string;
  message: string;
  params?: Record<string, unknown>;
}

function schemaIssues(
  errors: { instancePath: string; message?: string; params?: Record<string, unknown> }[],
): SchemaIssue[] {
  return errors.slice(0, 20).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
    ...(e.params ? { params: e.params } : {}),
  }));
}

/** Validate a manifest object (contracts/schemas/plugin-manifest.json). */
export function validatePluginManifest(data: unknown): PluginManifest {
  manifestValidator ??= contracts().validator('plugin-manifest.json');
  const v = manifestValidator(data);
  if (!v.ok) {
    const issues = schemaIssues(v.errors);
    const first = issues[0];
    const extra = first?.params?.additionalProperty;
    const extraText = typeof extra === 'string' ? ` (${extra})` : '';
    throw invalid(
      'plugin.json',
      `${first?.path ?? '/'} ${first?.message ?? 'invalid'}${extraText}`,
      { issues },
    );
  }
  return data as PluginManifest;
}

/** Validate a hooks file (contracts/schemas/hook-config.json). */
export function validatePluginHooksFile(data: unknown, where: string): PluginHookConfig[] {
  hooksValidator ??= contracts().validator('hook-config.json');
  const v = hooksValidator(data);
  if (!v.ok) {
    const issues = schemaIssues(v.errors);
    throw invalid(where, `${issues[0]?.path ?? '/'} ${issues[0]?.message ?? 'invalid'}`, {
      issues,
    });
  }
  return (data as { hooks: PluginHookConfig[] }).hooks;
}

/** The server name for a manifest key: the key itself when it is a valid MCP server name. */
export function serverNameFor(key: string): string {
  const s = key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'server';
}

function readRole(root: string, rel: string, pluginId: string): LoadedPluginRole {
  const file = realInside(root, rel, 'agent file');
  const where = `agent ${rel}`;
  let text: string;
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    if (statSync(file).size > SKILL_FILE_MAX_BYTES) throw new Error('larger than 1 MB');
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw invalid(where, err instanceof Error ? err.message : 'unreadable');
  }
  let md;
  try {
    md = parseFrontmatterMarkdown(text);
  } catch (err) {
    throw invalid(where, err instanceof FrontmatterError ? err.message : String(err));
  }
  const d = md.data;
  const name = typeof d.name === 'string' ? d.name : basename(rel).replace(/\.md$/i, '');
  if (!SKILL_NAME.test(name)) throw invalid(where, `invalid role name "${name}"`);
  if (typeof d.description !== 'string' || !d.description.trim() || d.description.length > 1024)
    throw invalid(where, 'description is required (1 to 1,024 characters)');
  if (!md.body.trim()) throw invalid(where, "the role's instructions (the body) are empty");
  return {
    key: `${pluginId}:${name}`,
    name,
    description: d.description.trim(),
    tools: toolList(d.tools),
    modelHint: modelHintText(d.model_hint),
    instructions: md.body,
    sourcePath: rel,
  };
}

/** A plugin's hooks with their content hashes, read from its folder. */
export function loadPluginHooks(root: string, manifest: PluginManifest): LoadedPluginHook[] {
  if (manifest.hooks === undefined) return [];
  let hooks: PluginHookConfig[];
  if (typeof manifest.hooks === 'string') {
    const file = realInside(root, manifest.hooks, 'hooks file');
    hooks = validatePluginHooksFile(
      readJson(file, HOOKS_MAX_BYTES, `hooks file ${manifest.hooks}`),
      `hooks file ${manifest.hooks}`,
    );
  } else hooks = manifest.hooks;
  const seen = new Set<string>();
  for (const h of hooks) {
    if (seen.has(h.id)) throw invalid('hooks', `duplicate hook id ${h.id}`);
    seen.add(h.id);
  }
  return hooks.map((hook) => ({ hook, contentHash: pluginHookContentHash(hook, root) }));
}

function checkSecretRefs(
  pluginId: string,
  key: string,
  values: Record<string, string> | undefined,
  field: string,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    // A plugin may only reference its own secrets: anything else could hand it another vault entry.
    if (value.startsWith('secret://') && !value.startsWith(`secret://plugin/${pluginId}/`))
      throw invalid(
        `mcpServers.${key}.${field}.${name}`,
        `a plugin may only reference secret://plugin/${pluginId}/… secrets`,
      );
  }
}

function checkServer(root: string, pluginId: string, key: string, c: PluginMcpServerConfig): void {
  const where = `mcpServers.${key}`;
  if (c.deviceId !== undefined)
    throw invalid(where, 'plugin servers run on the Hub; deviceId is not allowed');
  checkSecretRefs(pluginId, key, c.env, 'env');
  checkSecretRefs(pluginId, key, c.headers, 'headers');
  if (c.auth !== undefined) checkSecretRefs(pluginId, key, { auth: c.auth }, 'auth');
  // `${pluginRoot}/…` paths must stay inside the plugin after expansion.
  for (const v of [c.command ?? '', ...(c.args ?? [])]) {
    if (!v.includes('${pluginRoot}')) continue;
    const at = v.indexOf('${pluginRoot}');
    resolveInside(root, v.slice(at).split(/[=\s]/)[0] ?? '', `${where} path`);
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Whether `version` satisfies a simple `>=x.y.z` (or exact) range; null when it cannot tell. */
export function satisfiesEngine(range: string, version: string): boolean | null {
  const m = /^\s*(>=|>|=)?\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range);
  if (!m || !/^\d+\.\d+\.\d+/.test(version)) return null;
  const c = compareSemver(version, m[2]!);
  if (m[1] === '>') return c > 0;
  if (m[1] === '>=') return c >= 0;
  return c === 0;
}

export { compareSemver };

/**
 * Load and validate a plugin folder. Throws `validation` with a clear message for the first
 * problem; non-blocking notes go to `warnings`.
 */
export function loadPluginFolder(root: string, opts: { novaVersion?: string } = {}): LoadedPlugin {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new NovaError('validation', `plugin folder not found: ${root}`);
  const manifestFile = realInside(root, PLUGIN_MANIFEST_PATH, 'plugin.json');
  const manifest = validatePluginManifest(
    readJson(manifestFile, MANIFEST_MAX_BYTES, PLUGIN_MANIFEST_PATH),
  );
  if (existsSync(join(root, COMMANDS_DIR)))
    throw invalid(COMMANDS_DIR, 'this folder is reserved for converted commands');
  const warnings: string[] = [];
  const skills: LoadedPluginSkill[] = [];
  const names = new Set<string>();
  const addSkill = (s: LoadedPluginSkill) => {
    if (names.has(s.name))
      throw invalid(s.sourcePath, `another skill or command is named ${s.name}`);
    names.add(s.name);
    warnings.push(...s.warnings);
    skills.push(s);
  };
  for (const rel of manifest.skills ?? []) {
    const dir = realInside(root, rel, 'skill folder');
    if (!statSync(dir).isDirectory()) throw invalid(`skill ${rel}`, 'not a folder');
    const p = readSkillFolder(dir);
    if (!p.ok) throw invalid(`skill ${rel}`, p.error);
    addSkill({ ...p.skill, kind: 'skill', sourcePath: rel });
  }
  for (const rel of manifest.commands ?? []) {
    const file = realInside(root, rel, 'command file');
    if (!statSync(file).isFile() || !/\.md$/i.test(file))
      throw invalid(`command ${rel}`, 'not a Markdown file');
    const p = readCommandFile(file);
    if (!p.ok) throw invalid(`command ${rel}`, p.error);
    addSkill({ ...p.skill, kind: 'command', sourcePath: rel });
  }
  const roles: LoadedPluginRole[] = [];
  for (const rel of manifest.agents ?? []) {
    const r = readRole(root, rel, manifest.id);
    if (roles.some((x) => x.name === r.name))
      throw invalid(`agent ${rel}`, `another role is named ${r.name}`);
    roles.push(r);
  }
  const hooks = loadPluginHooks(root, manifest);
  const servers: LoadedPluginServer[] = [];
  const serverNames = new Set<string>();
  for (const [key, config] of Object.entries(manifest.mcpServers ?? {})) {
    const name = serverNameFor(key);
    if (!SERVER_NAME.test(name) || serverNames.has(name))
      throw invalid(`mcpServers.${key}`, 'server keys must be distinct lowercase names');
    serverNames.add(name);
    checkServer(root, manifest.id, key, config);
    servers.push({ key, config });
  }
  const declared = new Set((manifest.browserExtensions ?? []).map((b) => b.id));
  for (const b of manifest.browserExtensions ?? [])
    realInside(root, b.path, `browser extension ${b.id}`);
  for (const id of manifest.permissions.browserExtensions ?? [])
    if (!declared.has(id))
      throw invalid('permissions.browserExtensions', `${id} is not declared in browserExtensions`);
  if (declared.size)
    warnings.push(
      'Browser extensions are declared but never installed without a separate consent.',
    );
  const ui = manifest.ui?.entryPoints ?? [];
  if (ui.length && !servers.length)
    warnings.push('UI entry points need an MCP server in the plugin to serve their resources.');
  if (manifest.permissions.hooks?.answersAsks)
    warnings.push(
      "This plugin's hooks may answer approval questions raised by your rules or tool defaults.",
    );
  if (manifest.permissions.secrets?.length)
    warnings.push(`This plugin asks for secrets: ${manifest.permissions.secrets.join(', ')}.`);
  if (manifest.engines?.nova && opts.novaVersion) {
    const ok = satisfiesEngine(manifest.engines.nova, opts.novaVersion);
    if (ok === false)
      warnings.push(
        `This plugin asks for Nova ${manifest.engines.nova}; this Hub is ${opts.novaVersion}.`,
      );
  }
  return { root, manifest, skills, roles, hooks, servers, uiEntryPoints: ui, warnings };
}
