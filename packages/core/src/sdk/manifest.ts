// `.nova-plugin/extension.json`, the SDK part of an extension (FR-117; docs/14 §4.1-§4.2; ADR-097
// D2-D3). It names the API version, the entry module and everything the extension may do:
// network hosts, filesystem scopes, secrets, and the commands, panels, tools (with their action
// class), hooks and events it may register. The runtime refuses anything else and audits the
// attempt; the owner confirms these permissions at install. Loading never runs anything.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { NovaError, type HookEvent } from '@nova/shared';
import { hostMatch } from '@nova/policy';
import { HOOK_EVENTS, type HookDefinition } from '../hooks/config.ts';
import { canonicalJson } from '../nodes/crypto.ts';
import { loadPluginFolder, type LoadedPlugin } from '../plugins/manifest.ts';
import { realInside, walkTree } from '../plugins/paths.ts';
import type { PluginManifest } from '../plugins/types.ts';
import { EXTENSION_MANIFEST_PATH } from './bundle.ts';

export const EXTENSION_API = 1;
const MANIFEST_MAX_BYTES = 256 * 1024;
/** JavaScript the engine may load from one extension, in characters. */
export const EXTENSION_SOURCE_MAX_CHARS = 4_000_000;
const PANEL_MAX_BYTES = 5 * 1024 * 1024;

/** Events an extension may observe (docs/14 §4.1 "Events": observe only, never block). */
export const OBSERVABLE_EVENTS = [
  'chat.message.created',
  'chat.message.completed',
  'chat.message.deleted',
  'thread.created',
  'thread.updated',
  'thread.deleted',
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'tool.call.started',
  'tool.call.completed',
  'run.created',
  'run.status.changed',
  'run.completed',
  'approval.requested',
  'approval.decided',
  'project.created',
  'project.updated',
  'project.deleted',
  'schedule.fired',
  'agent.status.changed',
] as const;

/** The names docs/14 §4.1 uses for the common events. */
export const EVENT_ALIASES: Readonly<Record<string, string>> = {
  'thread.message': 'chat.message.completed',
  'run.end': 'run.completed',
  'tool.call': 'tool.call.completed',
};

/** Where an extension's own files live, as fs scope variables. */
export const EXTENSION_DATA_VAR = '${extensionData}';
export const EXTENSION_ROOT_VAR = '${extensionRoot}';

const IDENT = /^[a-z0-9][a-zA-Z0-9._-]{0,99}$/;
/** A tool's own name; its canonical name is `ext:<extensionId>/<name>`. */
export const EXTENSION_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const HOOK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST =
  /^(\*|(\*\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;
const UI_RESOURCE = /^ui:\/\/[a-z0-9][a-z0-9.-]{0,99}(\/[A-Za-z0-9._~-]+)*\/?$/;
const RELATIVE_FILE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,300}$/;

const actionClass = z.enum(['read', 'write', 'send', 'delete', 'execute']);
const approvalDefault = z.enum(['allow', 'ask', 'deny']);
const domainList = z.array(z.string().min(1).max(300)).max(50);

const panelSchema = z
  .object({
    id: z.string().regex(IDENT),
    title: z.string().min(1).max(100),
    resource: z.string().max(500).regex(UI_RESOURCE, 'a ui:// resource'),
    entryPoint: z.enum(['global', 'thread', 'file']),
    extensions: z
      .array(z.string().regex(/^\.[A-Za-z0-9]+$/))
      .min(1)
      .max(50)
      .optional(),
    /** The HTML file in the extension that the resource serves. */
    file: z
      .string()
      .regex(RELATIVE_FILE)
      .regex(/\.html?$/i, 'an .html file'),
    connectDomains: domainList.optional(),
    resourceDomains: domainList.optional(),
    frameDomains: domainList.optional(),
  })
  .strict()
  .refine((p) => (p.entryPoint === 'file') === (p.extensions !== undefined), {
    message: 'extensions is required for a file panel and not allowed otherwise',
    path: ['extensions'],
  });

const hookSchema = z
  .object({
    id: z.string().regex(HOOK_ID),
    event: z.enum(HOOK_EVENTS as unknown as [HookEvent, ...HookEvent[]]),
    matcher: z
      .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(20)])
      .optional(),
    failClosed: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    statusMessage: z.string().max(120).optional(),
  })
  .strict();

const fsScopeSchema = z.union([
  z.string().min(1).max(1000),
  z.object({ path: z.string().min(1).max(1000), write: z.boolean().optional() }).strict(),
]);

const permissionsSchema = z
  .object({
    network: z.array(z.string().max(253).regex(HOST, 'a host name or *.host')).max(100).optional(),
    fs: z.array(fsScopeSchema).max(20).optional(),
    secrets: z.array(z.string().regex(SECRET_NAME)).max(20).optional(),
    commands: z.array(z.string().regex(IDENT)).max(100).optional(),
    panels: z.array(panelSchema).max(20).optional(),
    tools: z
      .record(
        z.string().regex(EXTENSION_TOOL_NAME),
        z.object({ action: actionClass, default: approvalDefault.optional() }).strict(),
      )
      .optional(),
    actionDefaults: z.partialRecord(actionClass, approvalDefault).optional(),
    hooks: z.array(hookSchema).max(20).optional(),
    events: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .strict();

export const extensionManifestSchema = z
  .object({
    api: z.literal(EXTENSION_API),
    entry: z
      .string()
      .regex(RELATIVE_FILE)
      .regex(/\.m?js$/, 'a .js or .mjs module'),
    permissions: permissionsSchema,
  })
  .strict();

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionPanel = NonNullable<ExtensionManifest['permissions']['panels']>[number];
export type ExtensionHookDecl = NonNullable<ExtensionManifest['permissions']['hooks']>[number];
export type ExtensionActionClass = z.infer<typeof actionClass>;

/** A filesystem scope after its variables are known: an absolute folder and whether it is writable. */
export interface FsScope {
  /** As written in the manifest. */
  declared: string;
  path: string;
  write: boolean;
}

/** One problem `nova validate` reports: where, and what is wrong. */
export interface ExtensionIssue {
  where: string;
  message: string;
}

function issuesOf(err: z.ZodError, prefix: string): ExtensionIssue[] {
  return err.issues.slice(0, 50).map((i) => ({
    where: `${prefix}${i.path.length ? `.${i.path.join('.')}` : ''}`,
    message: i.message,
  }));
}

/** Validate extension.json; throws `validation` naming the first problem (all in `details`). */
export function parseExtensionManifest(data: unknown): ExtensionManifest {
  const r = extensionManifestSchema.safeParse(data);
  if (r.success) return r.data;
  const issues = issuesOf(r.error, 'extension.json');
  throw new NovaError('validation', `${issues[0]!.where}: ${issues[0]!.message}`, {
    details: { issues },
  });
}

/** extension.json issues without throwing (nova validate lists them all). */
export function extensionManifestIssues(data: unknown): ExtensionIssue[] {
  const r = extensionManifestSchema.safeParse(data);
  return r.success ? [] : issuesOf(r.error, 'extension.json');
}

/** The canonical name of an extension's tool. */
export function extensionToolName(extensionId: string, name: string): string {
  return `ext:${extensionId}/${name}`;
}

/** The internal tool a hook dispatch calls for an SDK hook (the hooks area's `mcp_tool` path). */
export function extensionHookTool(extensionId: string, hookId: string): string {
  return `ext:${extensionId}/hooks/${hookId}`;
}

/** `ext:<id>/<name>` → its parts; null for anything else. */
export function parseExtensionToolName(
  name: string,
): { extensionId: string; name: string; hook: string | null } | null {
  const m =
    /^ext:([a-z0-9]+(?:\.[a-z0-9-]+)+)\/(hooks\/([a-z0-9][a-z0-9-]{0,63})|[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/.exec(
      name,
    );
  if (!m) return null;
  return { extensionId: m[1]!, name: m[3] ?? m[2]!, hook: m[3] ?? null };
}

/** An SDK hook as the hooks area stores it: an `mcp_tool` handler on the extension's hook tool. */
export function extensionHookDefinition(extensionId: string, h: ExtensionHookDecl): HookDefinition {
  return {
    id: h.id,
    event: h.event,
    ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
    ...(h.failClosed !== undefined ? { failClosed: h.failClosed } : {}),
    ...(h.statusMessage !== undefined ? { statusMessage: h.statusMessage } : {}),
    handler: {
      type: 'mcp_tool',
      tool: extensionHookTool(extensionId, h.id),
      timeoutMs: h.timeoutMs ?? 30_000,
    },
  };
}

/**
 * The content hash an SDK hook is trusted by (docs/14 §4.2): SHA-256 over its definition and the
 * digest of the bundle that implements it, so an update that changes the bundle needs re-trust.
 */
export function extensionHookHash(
  extensionId: string,
  h: ExtensionHookDecl,
  bundleDigest: string,
): string {
  const def = extensionHookDefinition(extensionId, h);
  const text = canonicalJson({ hook: def, bundle: bundleDigest });
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** An event name or pattern an extension asks for, with docs/14 aliases resolved. */
export function resolveEventName(name: string): string {
  return EVENT_ALIASES[name] ?? name;
}

function eventPatternMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** The observable events a pattern covers (empty when it names none). */
export function observableEventsFor(pattern: string): string[] {
  const p = resolveEventName(pattern);
  return OBSERVABLE_EVENTS.filter((e) => eventPatternMatches(p, e));
}

/** Whether a subscription pattern stays within what the manifest declared. */
export function eventAllowed(declared: readonly string[], pattern: string): boolean {
  const wanted = observableEventsFor(pattern);
  if (!wanted.length) return false;
  return wanted.every((e) => declared.some((d) => observableEventsFor(d).includes(e)));
}

/** Whether a host is one the manifest declared (`host`, `*.host` or `*`). */
export function hostDeclared(network: readonly string[], host: string): boolean {
  return network.some((p) => hostMatch(p, host));
}

/** The filesystem scopes, with `${extensionData}` (writable) and `${extensionRoot}` (read) known. */
export function fsScopes(m: ExtensionManifest, where: { data: string; root: string }): FsScope[] {
  const out: FsScope[] = [];
  for (const s of m.permissions.fs ?? []) {
    const declared = typeof s === 'string' ? s : s.path;
    const write = typeof s === 'string' ? declared === EXTENSION_DATA_VAR : s.write === true;
    if (declared === EXTENSION_DATA_VAR) out.push({ declared, path: where.data, write: true });
    else if (declared === EXTENSION_ROOT_VAR)
      out.push({ declared, path: where.root, write: false });
    else if (isAbsolute(declared)) out.push({ declared, path: normalize(declared), write });
  }
  return out;
}

/** Problems with the declared filesystem scopes: only the variables and absolute paths. */
export function fsScopeIssues(m: ExtensionManifest): ExtensionIssue[] {
  const out: ExtensionIssue[] = [];
  (m.permissions.fs ?? []).forEach((s, i) => {
    const declared = typeof s === 'string' ? s : s.path;
    if (declared === EXTENSION_DATA_VAR) return;
    if (declared === EXTENSION_ROOT_VAR) {
      if (typeof s !== 'string' && s.write)
        out.push({ where: `permissions.fs.${i}`, message: 'the extension folder is read-only' });
      return;
    }
    if (declared.includes('${'))
      out.push({
        where: `permissions.fs.${i}`,
        message: `only ${EXTENSION_DATA_VAR} and ${EXTENSION_ROOT_VAR} may be used as variables`,
      });
    else if (!isAbsolute(declared) || declared.includes('\0'))
      out.push({ where: `permissions.fs.${i}`, message: 'a folder must be an absolute path' });
  });
  return out;
}

// ---- CSP domains of panels (docs/14 §4.3: within the declared network permissions) ----------

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(
  `^(?:(https?|wss?)://)?((?:\\*\\.)?${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?/?$`,
  'i',
);

/** Whether a panel's declared CSP domain is covered by the network permissions. */
export function domainCovered(domain: string, network: readonly string[]): boolean {
  const m = DOMAIN.exec(domain.trim());
  if (!m?.[2]) return false;
  const host = m[2].toLowerCase();
  const wildcard = host.startsWith('*.');
  const bare = wildcard ? host.slice(2) : host;
  return network.some((p) => {
    const pat = p.toLowerCase();
    if (pat === '*') return false; // a UI never gets `*`: name its hosts.
    if (!pat.startsWith('*.')) return !wildcard && bare === pat;
    const base = pat.slice(2);
    return bare.endsWith(`.${base}`) || (wildcard && bare === base);
  });
}

/** Panel CSP domains that the network permissions do not cover. */
export function panelDomainIssues(m: ExtensionManifest): ExtensionIssue[] {
  const network = m.permissions.network ?? [];
  const out: ExtensionIssue[] = [];
  (m.permissions.panels ?? []).forEach((p, i) => {
    for (const field of ['connectDomains', 'resourceDomains', 'frameDomains'] as const)
      for (const d of p[field] ?? [])
        if (!domainCovered(d, network))
          out.push({
            where: `permissions.panels.${i}.${field}`,
            message: `${d} is not within the declared network permissions`,
          });
  });
  return out;
}

// ---- loading a folder --------------------------------------------------------------------------

export interface LoadedExtension {
  root: string;
  plugin: LoadedPlugin;
  manifest: ExtensionManifest;
  /** JavaScript files the engine may load, by path relative to the root. */
  sources: Record<string, string>;
  warnings: string[];
}

function readJsonFile(file: string): unknown {
  const st = statSync(file);
  if (!st.isFile()) throw new NovaError('validation', `${EXTENSION_MANIFEST_PATH} is not a file`);
  if (st.size > MANIFEST_MAX_BYTES)
    throw new NovaError('validation', `${EXTENSION_MANIFEST_PATH} is larger than 256 KiB`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new NovaError(
      'validation',
      `${EXTENSION_MANIFEST_PATH} is not valid JSON (${err instanceof Error ? err.message : 'parse error'})`,
    );
  }
}

/** The JavaScript modules of a folder (`.js`, `.mjs`), capped in total. */
export function extensionSources(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const e of walkTree(root)) {
    if (!/\.m?js$/.test(e.path) || e.path.split('/').includes('node_modules')) continue;
    const text = readFileSync(e.source, 'utf8');
    total += text.length;
    if (total > EXTENSION_SOURCE_MAX_CHARS)
      throw new NovaError('validation', 'the extension has more than 4 MB of JavaScript');
    out[e.path] = text;
  }
  return out;
}

/** Whether a folder holds an extension (a plugin with `.nova-plugin/extension.json`). */
export function isExtensionFolder(root: string): boolean {
  try {
    return statSync(`${root}/${EXTENSION_MANIFEST_PATH}`).isFile();
  } catch {
    return false;
  }
}

/**
 * Load and check an extension folder: the plugin (plugin.json and its parts), extension.json, the
 * entry module, panel files, filesystem scopes, CSP domains and hook ids. Throws `validation`
 * naming the first problem.
 */
export function loadExtensionFolder(
  root: string,
  opts: { novaVersion?: string } = {},
): LoadedExtension {
  const plugin = loadPluginFolder(root, opts);
  const file = realInside(root, EXTENSION_MANIFEST_PATH, 'extension.json');
  const manifest = parseExtensionManifest(readJsonFile(file));
  const problems = [...fsScopeIssues(manifest), ...panelDomainIssues(manifest)];
  const pluginHookIds = new Set(plugin.hooks.map((h) => h.hook.id));
  const seen = new Set<string>();
  for (const h of manifest.permissions.hooks ?? []) {
    if (seen.has(h.id) || pluginHookIds.has(h.id))
      problems.push({
        where: 'permissions.hooks',
        message: `hook id ${h.id} is used twice (SDK hooks and plugin hooks share ids)`,
      });
    seen.add(h.id);
  }
  const panelIds = new Set<string>();
  for (const p of manifest.permissions.panels ?? []) {
    if (panelIds.has(p.id))
      problems.push({ where: 'permissions.panels', message: `panel id ${p.id} is used twice` });
    panelIds.add(p.id);
  }
  if (problems.length) {
    const first = problems[0]!;
    throw new NovaError('validation', `extension.json ${first.where}: ${first.message}`, {
      details: { issues: problems },
    });
  }
  realInside(root, manifest.entry, 'entry module');
  for (const p of manifest.permissions.panels ?? []) {
    const f = realInside(root, p.file, `panel ${p.id}`);
    if (statSync(f).size > PANEL_MAX_BYTES)
      throw new NovaError('validation', `panel ${p.id}: ${p.file} is larger than 5 MB`);
  }
  const sources = extensionSources(root);
  if (sources[manifest.entry] === undefined)
    throw new NovaError('validation', `the entry module ${manifest.entry} could not be read`);
  return {
    root,
    plugin,
    manifest,
    sources,
    warnings: extensionWarnings(manifest, plugin.manifest),
  };
}

function extensionWarnings(m: ExtensionManifest, plugin: PluginManifest): string[] {
  const out: string[] = [];
  const p = m.permissions;
  if (p.network?.includes('*'))
    out.push(
      'This extension asks to reach any host on the network. Install it only if you trust it.',
    );
  if (p.secrets?.length)
    out.push(`This extension reads secrets you store for it: ${p.secrets.join(', ')}.`);
  if (p.hooks?.length)
    out.push('Its hooks run only after you trust them, and need trust again after every update.');
  if (Object.values(p.tools ?? {}).some((t) => t.default === 'allow' && t.action !== 'read'))
    out.push('Some of its tools that change things are allowed without asking by default.');
  if (plugin.mcpServers && Object.keys(plugin.mcpServers).length)
    out.push('It also starts MCP servers, which run as programs on this Hub.');
  return out;
}

/** The text of a panel's HTML file, for the MCP Apps area. */
export function readPanelHtml(root: string, panel: ExtensionPanel): string {
  const f = realInside(root, panel.file, `panel ${panel.id}`);
  if (statSync(f).size > PANEL_MAX_BYTES)
    throw new NovaError('validation', `panel ${panel.id} is larger than 5 MB`);
  return readFileSync(f, 'utf8');
}
