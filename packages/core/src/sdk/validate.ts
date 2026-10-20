// `nova validate` (FR-117; docs/14 §4.3): check an extension folder or `.novax` bundle and list
// every problem at once: the plugin manifest and its parts (skill front-matter, hooks, servers),
// extension.json against its schema, the entry module and panel files, filesystem scopes, panel
// CSP domains within the declared network permissions, hook definitions, observable events, the
// JavaScript's syntax and imports, and, for a bundle, its signature. Nothing is installed or run.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovaError } from '@nova/shared';
import { loadPluginFolder, type LoadedPlugin } from '../plugins/manifest.ts';
import { realInside } from '../plugins/paths.ts';
import {
  EXTENSION_MANIFEST_PATH,
  extractBundle,
  folderBundleFiles,
  secretFileProblems,
  verifyBundle,
  type BundleCheck,
  type TrustedKey,
} from './bundle.ts';
import { checkExtensionModules, moduleSpecifiers, resolveExtensionImport } from './engine.ts';
import {
  extensionManifestIssues,
  extensionSources,
  fsScopeIssues,
  loadExtensionFolder,
  observableEventsFor,
  panelDomainIssues,
  type ExtensionIssue,
  type ExtensionManifest,
} from './manifest.ts';

export interface ExtensionValidation {
  ok: boolean;
  id: string | null;
  version: string | null;
  errors: ExtensionIssue[];
  warnings: string[];
  /** For a bundle: how its signature checked out; null for a folder. */
  signature: Omit<BundleCheck, 'files'> | null;
  /** What it declares, when extension.json is valid. */
  summary: {
    commands: number;
    panels: number;
    tools: number;
    hooks: number;
    events: number;
    skills: number;
    mcpServers: number;
  } | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate a folder or a `.novax` file. Never throws for a problem in the extension itself. */
export async function validateExtension(
  path: string,
  opts: { trusted?: readonly TrustedKey[]; novaVersion?: string } = {},
): Promise<ExtensionValidation> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return failed(`${path} does not exist`);
  }
  if (st.isDirectory()) return validateFolder(path, opts, null);
  let check: BundleCheck;
  try {
    check = verifyBundle(readFileSync(path), { trusted: opts.trusted ?? [] });
  } catch (err) {
    return failed(message(err));
  }
  const { files, ...signature } = check;
  const dir = mkdtempSync(join(tmpdir(), 'nova-validate-'));
  try {
    extractBundle(files, join(dir, 'x'));
    const out = await validateFolder(join(dir, 'x'), opts, signature);
    if (signature.status === 'invalid')
      out.errors.unshift({ where: 'signature', message: signature.message ?? 'invalid signature' });
    else if (signature.status === 'unverified')
      out.warnings.unshift(
        `Unverified: ${signature.message ?? 'not signed by a trusted publisher'}`,
      );
    out.ok = out.errors.length === 0;
    return out;
  } catch (err) {
    return failed(message(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function failed(text: string): ExtensionValidation {
  return {
    ok: false,
    id: null,
    version: null,
    errors: [{ where: 'bundle', message: text }],
    warnings: [],
    signature: null,
    summary: null,
  };
}

async function validateFolder(
  root: string,
  opts: { novaVersion?: string },
  signature: ExtensionValidation['signature'],
): Promise<ExtensionValidation> {
  const errors: ExtensionIssue[] = [];
  const warnings: string[] = [];
  let plugin: LoadedPlugin | null = null;
  try {
    plugin = loadPluginFolder(root, opts.novaVersion ? { novaVersion: opts.novaVersion } : {});
  } catch (err) {
    errors.push({ where: '.nova-plugin/plugin.json', message: message(err) });
  }
  let manifest: ExtensionManifest | null = null;
  let raw: unknown = null;
  try {
    const file = realInside(root, EXTENSION_MANIFEST_PATH, 'extension.json');
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    errors.push({
      where: EXTENSION_MANIFEST_PATH,
      message: err instanceof NovaError ? err.message : `not valid JSON (${message(err)})`,
    });
  }
  if (raw !== null) {
    const issues = extensionManifestIssues(raw);
    errors.push(...issues);
    if (!issues.length) manifest = raw as ExtensionManifest;
  }
  if (manifest) {
    errors.push(...fsScopeIssues(manifest), ...panelDomainIssues(manifest));
    try {
      realInside(root, manifest.entry, 'entry module');
    } catch (err) {
      errors.push({ where: 'extension.json.entry', message: message(err) });
    }
    for (const p of manifest.permissions.panels ?? [])
      try {
        realInside(root, p.file, `panel ${p.id}`);
      } catch (err) {
        errors.push({ where: `permissions.panels.${p.id}`, message: message(err) });
      }
    const pluginHooks = new Set(plugin?.hooks.map((h) => h.hook.id) ?? []);
    const seen = new Set<string>();
    for (const h of manifest.permissions.hooks ?? []) {
      if (seen.has(h.id) || pluginHooks.has(h.id))
        errors.push({ where: `permissions.hooks.${h.id}`, message: 'this hook id is used twice' });
      seen.add(h.id);
    }
    for (const e of manifest.permissions.events ?? [])
      if (!observableEventsFor(e).length)
        errors.push({
          where: 'permissions.events',
          message: `${e} is not an event extensions can observe`,
        });
    const commands = manifest.permissions.commands ?? [];
    if (new Set(commands).size !== commands.length)
      errors.push({ where: 'permissions.commands', message: 'a command id is listed twice' });
  }
  // Secrets that would ship with it (a .env file, a private key): never packed.
  try {
    for (const f of secretFileProblems(folderBundleFiles(root)))
      errors.push({ where: f.path, message: `refusing to pack this file: ${f.why}` });
  } catch (err) {
    errors.push({ where: 'files', message: message(err) });
  }
  // The code: syntax of every module and imports that resolve inside the extension.
  let sources: Record<string, string> = {};
  try {
    sources = extensionSources(root);
  } catch (err) {
    errors.push({ where: 'code', message: message(err) });
  }
  if (manifest && Object.keys(sources).length) {
    if (
      sources[manifest.entry] === undefined &&
      !errors.some((e) => e.where === 'extension.json.entry')
    )
      errors.push({
        where: 'extension.json.entry',
        message: `${manifest.entry} is not a module of the extension`,
      });
    // Loading reports the first import that does not resolve; the scan below lists them all.
    for (const s of await checkExtensionModules(manifest.entry, sources))
      if (!/cannot import/.test(s.message)) errors.push({ where: s.file, message: s.message });
    for (const [file, text] of Object.entries(sources))
      for (const spec of moduleSpecifiers(text))
        if (resolveExtensionImport(file, spec, sources) === null)
          errors.push({
            where: file,
            message: `cannot import ${spec}: only the extension's own files (./…) and @nova/sdk resolve`,
          });
  }
  if (manifest && plugin && !errors.length) {
    try {
      warnings.push(
        ...loadExtensionFolder(root, opts.novaVersion ? { novaVersion: opts.novaVersion } : {})
          .warnings,
      );
    } catch (err) {
      errors.push({ where: 'extension', message: message(err) });
    }
    warnings.push(...plugin.warnings);
  }
  return {
    ok: errors.length === 0,
    id: plugin?.manifest.id ?? null,
    version: plugin?.manifest.version ?? null,
    errors,
    warnings: [...new Set(warnings)],
    signature,
    summary: manifest
      ? {
          commands: manifest.permissions.commands?.length ?? 0,
          panels: manifest.permissions.panels?.length ?? 0,
          tools: Object.keys(manifest.permissions.tools ?? {}).length,
          hooks: manifest.permissions.hooks?.length ?? 0,
          events: manifest.permissions.events?.length ?? 0,
          skills: plugin?.skills.length ?? 0,
          mcpServers: plugin?.servers.length ?? 0,
        }
      : null,
  };
}
