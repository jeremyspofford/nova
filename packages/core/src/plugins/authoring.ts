// "Build a plugin" (FR-050): `plugin.scaffold` writes a plugin folder (manifest per
// contracts/schemas/plugin-manifest.json, skills, commands, an MCP server entry) into
// `<dataDir>/plugins-drafts/<id>/` and validates it with the same loader the installer uses.
// It never installs anything: the user installs a draft through the normal preview and sideload
// confirmation (Settings → Plugins & skills → Install from a folder or Git).
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { NovaError, uuidv7 } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import { argsOf, builtinDescriptor, fail, ok, type BuiltinTool } from '../tools/builtin.ts';
import { loadPluginFolder, PLUGIN_MANIFEST_PATH } from './manifest.ts';
import { SKILL_NAME, slugName } from './skill-file.ts';

export const PLUGIN_DRAFTS_DIR = 'plugins-drafts';
const PLUGIN_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const skillName = z.string().regex(SKILL_NAME, 'lowercase letters, digits and dashes (at most 64)');
const oneLine = z
  .string()
  .max(1024)
  // eslint-disable-next-line no-control-regex
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim());

export const scaffoldRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: oneLine.pipe(z.string().min(1).max(500)),
  id: z.string().regex(PLUGIN_ID, 'like local.my-plugin').max(100).optional(),
  version: z.string().regex(SEMVER).default('0.1.0'),
  skills: z
    .array(
      z.strictObject({
        name: skillName,
        description: oneLine.pipe(z.string().min(1)),
        whenToUse: oneLine.optional(),
        allowedTools: z.array(z.string().min(1).max(200)).max(50).optional(),
        instructions: z.string().min(1).max(200_000),
      }),
    )
    .max(50)
    .optional(),
  commands: z
    .array(
      z.strictObject({
        name: skillName,
        description: oneLine.optional(),
        body: z.string().min(1).max(200_000),
      }),
    )
    .max(50)
    .optional(),
  mcpServer: z
    .strictObject({
      name: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
      transport: z.enum(['stdio', 'http', 'sse']),
      command: z.string().min(1).max(1000).optional(),
      args: z.array(z.string().max(1000)).max(50).optional(),
      url: z.url().max(1000).optional(),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).optional(),
    })
    .optional(),
});
export type ScaffoldRequest = z.input<typeof scaffoldRequestSchema>;

export interface ScaffoldResult {
  id: string;
  /** The draft folder (absolute). */
  path: string;
  /** Files written, relative to the folder. */
  files: string[];
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** YAML for one value: JSON strings are valid YAML double-quoted scalars. */
const yaml = (s: string) => JSON.stringify(s);

function frontmatter(entries: [string, string | string[] | undefined][]): string {
  const lines = ['---'];
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(yaml).join(', ')}]`);
    else lines.push(`${k}: ${yaml(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function invalid(message: string): NovaError {
  return new NovaError('validation', message);
}

/** The manifest and files for a request; throws `validation` for an unsafe one. */
export function pluginFiles(req: ScaffoldRequest): { id: string; files: [string, string][] } {
  const r = scaffoldRequestSchema.parse(req);
  const slug = slugName(r.name).slice(0, 50).replace(/-+$/, '') || 'plugin';
  const id = r.id ?? `local.${slug}`;
  const files: [string, string][] = [];
  const names = new Set<string>();
  const skillDirs: string[] = [];
  for (const s of r.skills ?? []) {
    if (names.has(s.name)) throw invalid(`two skills or commands are named ${s.name}`);
    names.add(s.name);
    const dir = `skills/${s.name}`;
    skillDirs.push(dir);
    files.push([
      `${dir}/SKILL.md`,
      frontmatter([
        ['name', s.name],
        ['description', s.description],
        ['when_to_use', s.whenToUse || undefined],
        ['allowed_tools', s.allowedTools?.length ? s.allowedTools : undefined],
      ]) + `${s.instructions.trim()}\n`,
    ]);
  }
  const commandFiles: string[] = [];
  for (const c of r.commands ?? []) {
    if (names.has(c.name)) throw invalid(`two skills or commands are named ${c.name}`);
    names.add(c.name);
    const file = `commands/${c.name}.md`;
    commandFiles.push(file);
    files.push([
      file,
      frontmatter([
        ['name', c.name],
        ['description', c.description || undefined],
      ]) + `${c.body.trim()}\n`,
    ]);
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    name: r.name,
    version: r.version,
    description: r.description,
    permissions: {},
  };
  if (skillDirs.length) manifest.skills = skillDirs;
  if (commandFiles.length) manifest.commands = commandFiles;
  const s = r.mcpServer;
  if (s) {
    const key = s.name ?? (slug.slice(0, 40).replace(/-+$/, '') || 'server');
    const server: Record<string, unknown> = { transport: s.transport };
    if (s.transport === 'stdio') {
      if (!s.command) throw invalid('a stdio server needs a command');
      if (s.url) throw invalid('a stdio server takes a command, not a url');
      server.command = s.command;
      if (s.args?.length) server.args = s.args;
    } else {
      if (!s.url) throw invalid(`an ${s.transport} server needs a url`);
      if (s.command || s.args?.length)
        throw invalid(`an ${s.transport} server takes a url, not a command`);
      server.url = s.url;
      // The server's host is a declared network permission, shown at install (FR-045).
      manifest.permissions = { network: [new URL(s.url).host] };
    }
    if (s.env && Object.keys(s.env).length) {
      for (const [k, v] of Object.entries(s.env)) {
        // Credentials never land in plugin files: only references to the plugin's own secrets.
        const ref = v.startsWith('secret://');
        if (ref && !v.startsWith(`secret://plugin/${id}/`))
          throw invalid(`env ${k}: a plugin may only reference secret://plugin/${id}/… secrets`);
        if (!ref && defaultRedactor.redactString(v) !== v)
          throw invalid(
            `env ${k} looks like a credential; use secret://plugin/${id}/${k.toLowerCase()} instead`,
          );
      }
      server.env = s.env;
    }
    manifest.mcpServers = { [key]: server };
  }
  files.unshift([PLUGIN_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`]);
  return { id, files };
}

/**
 * Write a draft plugin folder (replacing an earlier draft with the same id) and validate it.
 * The result says whether it would install; nothing is installed.
 */
export function scaffoldPlugin(
  dataDir: string,
  req: ScaffoldRequest,
  opts: { novaVersion?: string; accountId?: string } = {},
): ScaffoldResult {
  const { id, files } = pluginFiles(req);
  // Drafts made by a tool live per account: one person never replaces another's (decision 5).
  const drafts = opts.accountId
    ? join(dataDir, PLUGIN_DRAFTS_DIR, opts.accountId.replace(/[^A-Za-z0-9_-]/g, '_'))
    : join(dataDir, PLUGIN_DRAFTS_DIR);
  mkdirSync(drafts, { recursive: true, mode: 0o700 });
  const target = join(drafts, id);
  const tmp = join(drafts, `.tmp-${uuidv7()}`);
  try {
    for (const [rel, text] of files) {
      const to = join(tmp, rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, text, { mode: 0o600 });
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const errors: string[] = [];
  let warnings: string[] = [];
  try {
    const loaded = loadPluginFolder(
      target,
      opts.novaVersion ? { novaVersion: opts.novaVersion } : {},
    );
    warnings = loaded.warnings;
  } catch (err) {
    if (!(err instanceof NovaError)) throw err;
    errors.push(err.message);
  }
  return {
    id,
    path: target,
    files: files.map(([f]) => f),
    valid: !errors.length,
    errors,
    warnings,
  };
}

export interface PluginScaffoldToolOptions {
  dataDir: string;
  novaVersion?: string;
}

/** The `plugin.scaffold` tool (FR-050). */
export function pluginScaffoldTool(opts: PluginScaffoldToolOptions): BuiltinTool {
  return {
    descriptor: builtinDescriptor({
      name: 'plugin.scaffold',
      title: 'Draft a plugin',
      description:
        'Write a draft Nova plugin (manifest, skills, commands, an MCP server entry) and validate it. Nothing is installed: the user installs the draft from Settings, after reviewing what it may do. Skills need a name (lowercase-dashes), a description of what they do and when, and instructions in Markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          id: { type: 'string', maxLength: 100 },
          version: { type: 'string', maxLength: 50 },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                whenToUse: { type: 'string' },
                allowedTools: { type: 'array', items: { type: 'string' } },
                instructions: { type: 'string' },
              },
              required: ['name', 'description', 'instructions'],
            },
          },
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['name', 'body'],
            },
          },
          mcpServer: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              transport: { enum: ['stdio', 'http', 'sse'] },
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              url: { type: 'string' },
              env: { type: 'object' },
            },
            required: ['transport'],
          },
        },
        required: ['name', 'description'],
        additionalProperties: false,
      },
      annotations: { action: 'write' },
      timeoutMs: 30_000,
    }),
    origin: null,
    handler: (args, ctx) => {
      try {
        const r = scaffoldPlugin(opts.dataDir, argsOf(args) as ScaffoldRequest, {
          accountId: ctx.accountId,
          ...(opts.novaVersion ? { novaVersion: opts.novaVersion } : {}),
        });
        const meta = { ...r };
        if (!r.valid)
          return Promise.resolve(
            ok(
              `Drafted ${r.id} in ${r.path}, but it does not validate yet: ${r.errors.join('; ')}. Fix it and call plugin.scaffold again.`,
              meta,
            ),
          );
        const notes = r.warnings.length ? ` Notes: ${r.warnings.join(' ')}` : '';
        return Promise.resolve(
          ok(
            `Drafted plugin ${r.id} in ${r.path} (${r.files.length} file${r.files.length === 1 ? '' : 's'}); it validates.${notes} It is not installed: to install it, open Settings → Plugins & skills → Install from a folder or Git and enter that path, then review and confirm.`,
            meta,
          ),
        );
      } catch (err) {
        if (err instanceof z.ZodError) {
          const issues = err.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
          return Promise.resolve(
            fail('validation', `the plugin request is not valid: ${issues.join('; ')}`),
          );
        }
        if (err instanceof NovaError) return Promise.resolve(fail(err.code, err.message));
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
