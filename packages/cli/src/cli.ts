// The `nova` command (ADR-097 D1): extension authoring (FR-117; docs/14 §4.3), Nova's MCP server
// for stdio-only clients (FR-044) and data export and import (FR-105). Every subcommand is a
// function of its arguments and an I/O object, so tests run it in-process. Talking to a Hub uses
// NOVA_URL and NOVA_TOKEN from the environment; a token never goes on the command line.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  folderBundleFiles,
  generatePublisherKeyPair,
  loadPublisherPrivateKey,
  packBundle,
  publisherFingerprint,
  publisherKeyOf,
  runDataCommand,
  validateExtension,
  type ExtensionValidation,
} from '@nova/core';
import { launcherConfig, runStdioLauncher } from '@nova/mcp';
import { defaultKeyFile, readKeyFile, writeKeyFile } from './keyfile.ts';

export const CLI_VERSION = '0.0.0';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** For `nova mcp stdio`. */
  stdin?: Readable;
  stdoutStream?: Writable;
  fetch?: typeof fetch;
  /** Ends `nova dev`'s watch (Ctrl-C). */
  signal?: AbortSignal;
  /** How long `nova dev` waits after a change before reloading. */
  debounceMs?: number;
}

export const USAGE = `nova: Nova from a terminal

  nova init <dir> [--id <reverse.dns.id>] [--name <name>]
      Start an extension from the template (a command, a panel and a tool).
  nova validate <folder|bundle.novax> [--json]
      Check the manifest, permissions, panel CSP domains, hooks, code and signature.
  nova pack <folder> [--key <file>] [--out <file.novax>] [--unsigned]
      Validate, then write a signed .novax bundle.
  nova keys generate [--key <file>] [--force]
  nova keys show [--key <file>]
      An Ed25519 publisher key, kept 0600 in your config folder (never in a repository).
  nova dev <folder> [--once] [--trust-hooks] [--accept-publisher-change]
      Load the extension into a running Hub and reload it on every change (NOVA_URL, NOVA_TOKEN).
      Replacing an installed extension signed by a publisher needs --accept-publisher-change
      (its secrets and data are cleared).
  nova mcp stdio [--url <url>] [--token-file <file>]
      Nova's MCP server for MCP clients that only speak stdio (NOVA_MCP_URL, NOVA_MCP_TOKEN).
  nova data export|import ...
      Export or import a Hub's data (\`nova data\` for details).
`;

class UsageError extends Error {}

/** `--name value` or `--name=value`; undefined when absent. */
function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    return v;
  }
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Positional arguments (anything that is not an option or an option's value). */
function positional(argv: string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      if (valued.includes(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Run one `nova` command; resolves to the exit code (0 ok, 1 failed, 2 usage). */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return command === undefined ? 2 : 0;
      case '--version':
      case 'version':
        io.stdout(`nova ${CLI_VERSION}\n`);
        return 0;
      case 'init':
        return initCommand(rest, io);
      case 'validate':
        return await validateCommand(rest, io);
      case 'pack':
        return await packCommand(rest, io);
      case 'keys':
        return keysCommand(rest, io);
      case 'dev':
        return await devCommand(rest, io);
      case 'mcp':
        return await mcpCommand(rest, io);
      case 'data':
        return await runDataCommand(rest, {
          env: io.env,
          stdout: io.stdout,
          stderr: io.stderr,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`nova ${command ?? ''}: ${message}\n`);
    if (err instanceof UsageError) {
      io.stderr('Run `nova help` for the commands.\n');
      return 2;
    }
    return 1;
  }
}

// ---- init ------------------------------------------------------------------------------------

const TEMPLATE = fileURLToPath(new URL('../../sdk/examples/hello/', import.meta.url));
const TEMPLATE_ID = 'com.example.hello';
const TEMPLATE_NAME = 'Hello extension';
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
/** Template files that are text, and how the extension's name is written inside each. */
const TEXT_FILES: [RegExp, (name: string) => string][] = [
  [/\.json$/i, (n) => JSON.stringify(n).slice(1, -1)],
  [
    /\.(m?js|cjs|ts)$/i,
    (n) =>
      JSON.stringify(n)
        .slice(1, -1)
        .replace(/'/g, "\\'")
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${'),
  ],
  [
    /\.(html?|svg|css)$/i,
    (n) =>
      n.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
      ),
  ],
  [/\.(md|txt)$/i, (n) => n],
];

/** Every reference to the template's id and name in the copied files, rewritten for this one. */
function rewriteTemplate(dir: string, id: string, name: string): void {
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const file = join(dir, rel);
    const kind = TEXT_FILES.find(([re]) => re.test(rel));
    if (!kind || !statSync(file).isFile()) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.split(TEMPLATE_ID).join(id).split(TEMPLATE_NAME).join(kind[1](name));
    if (after !== before) writeFileSync(file, after);
  }
}

function initCommand(argv: string[], io: CliIo): number {
  const [dirArg] = positional(argv, ['id', 'name']);
  if (!dirArg) throw new UsageError('nova init <dir> [--id <id>] [--name <name>]');
  const dir = resolve(io.cwd, dirArg);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const id = option(argv, 'id') ?? `local.${slug(dirArg)}`;
  if (!ID.test(id)) throw new UsageError(`${id} is not a reverse-DNS id like com.example.tool`);
  const name = option(argv, 'name') ?? dirArg.split(/[\\/]/).pop()!;
  cpSync(TEMPLATE, dir, { recursive: true });
  rewriteTemplate(dir, id, name.slice(0, 100));
  const pluginFile = join(dir, '.nova-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginFile, 'utf8')) as Record<string, unknown>;
  manifest.name = name.slice(0, 100);
  manifest.version = '0.1.0';
  writeFileSync(pluginFile, `${JSON.stringify(manifest, null, 2)}\n`);
  io.stdout(
    `Created ${id} in ${dir}.\nNext: edit extension.js and .nova-plugin/extension.json, then run \`nova validate ${dirArg}\` and \`nova dev ${dirArg}\`.\n`,
  );
  return 0;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .split(/[\\/]/)
      .pop()!
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'extension'
  );
}

// ---- validate and pack ------------------------------------------------------------------------

function report(v: ExtensionValidation, path: string, io: CliIo): void {
  const name = v.id ? `${v.id}${v.version ? ` ${v.version}` : ''}` : path;
  if (v.signature)
    io.stdout(
      `signature: ${v.signature.status}${v.signature.publisher ? ` (${publisherFingerprint(v.signature.publisher)})` : ''}\n`,
    );
  for (const w of v.warnings) io.stdout(`warning: ${w}\n`);
  for (const e of v.errors) io.stderr(`error: ${e.where}: ${e.message}\n`);
  if (v.ok) {
    const s = v.summary;
    io.stdout(
      `${name} is valid${s ? `: ${s.commands} commands, ${s.panels} panels, ${s.tools} tools, ${s.hooks} hooks, ${s.events} events` : ''}\n`,
    );
  } else io.stderr(`${name}: ${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}\n`);
}

async function validateCommand(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv, []);
  if (!target) throw new UsageError('nova validate <folder|bundle.novax> [--json]');
  const path = resolve(io.cwd, target);
  const v = await validateExtension(path);
  if (flag(argv, 'json')) io.stdout(`${JSON.stringify(v, null, 2)}\n`);
  else report(v, target, io);
  return v.ok ? 0 : 1;
}

async function packCommand(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv, ['key', 'out']);
  if (!target)
    throw new UsageError('nova pack <folder> [--key <file>] [--out <file>] [--unsigned]');
  const keyOpt = option(argv, 'key');
  const outOpt = option(argv, 'out');
  const root = resolve(io.cwd, target);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`${root} is not an extension folder`);
  const v = await validateExtension(root);
  if (!v.ok) {
    report(v, target, io);
    io.stderr('nothing was packed\n');
    return 1;
  }
  let privateKey = null;
  if (!flag(argv, 'unsigned')) {
    const keyFile = keyOpt ? resolve(io.cwd, keyOpt) : defaultKeyFile(io.env);
    const { pem, warning } = readKeyFile(keyFile);
    if (warning) io.stderr(`warning: ${warning}\n`);
    privateKey = loadPublisherPrivateKey(pem);
  }
  const packed = packBundle(folderBundleFiles(root), { privateKey });
  const out = resolve(io.cwd, outOpt ?? `${v.id}-${v.version}.novax`);
  writeFileSync(out, packed.bytes);
  io.stdout(
    `${out}: ${packed.files} files, digest ${packed.digest}, ${
      packed.publisher
        ? `signed by ${publisherFingerprint(packed.publisher)}`
        : 'unsigned (installs only as a sideload)'
    }\n`,
  );
  return 0;
}

// ---- keys ---------------------------------------------------------------------------------------

function keysCommand(argv: string[], io: CliIo): number {
  const [sub] = positional(argv, ['key']);
  const file = option(argv, 'key') ? resolve(io.cwd, option(argv, 'key')!) : defaultKeyFile(io.env);
  if (sub === 'generate') {
    const pair = generatePublisherKeyPair();
    writeKeyFile(file, pair.privateKeyPem, { force: flag(argv, 'force') });
    io.stdout(
      `Wrote a new publisher key to ${file} (keep it private).\npublic key: ${pair.publicKey}\nfingerprint: ${publisherFingerprint(pair.publicKey)}\nTo trust it on a Hub, add the public key to Settings > Trusted publishers (plugins.trustedPublishers).\n`,
    );
    return 0;
  }
  if (sub === 'show') {
    const { pem, warning } = readKeyFile(file);
    if (warning) io.stderr(`warning: ${warning}\n`);
    const key = publisherKeyOf(loadPublisherPrivateKey(pem));
    io.stdout(`public key: ${key}\nfingerprint: ${publisherFingerprint(key)}\nfile: ${file}\n`);
    return 0;
  }
  throw new UsageError('nova keys generate|show [--key <file>]');
}

// ---- dev ---------------------------------------------------------------------------------------

/** The Hub from NOVA_URL and NOVA_TOKEN: https, or http only to this machine (a token travels). */
export function hubFromEnv(env: NodeJS.ProcessEnv): { base: string; token: string } {
  const raw = env.NOVA_URL?.trim();
  const token = env.NOVA_TOKEN?.trim();
  if (!raw || !token) throw new UsageError('set NOVA_URL and NOVA_TOKEN (an owner session token)');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('NOVA_URL is not a URL');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new UsageError('NOVA_URL must use https (http only for this machine)');
  return { base: url.toString().replace(/\/+$/, ''), token };
}

const IGNORED = new Set(['.git', 'node_modules']);

async function devCommand(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv, []);
  if (!target)
    throw new UsageError('nova dev <folder> [--once] [--trust-hooks] [--accept-publisher-change]');
  const root = resolve(io.cwd, target);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`${root} is not an extension folder`);
  const hub = hubFromEnv(io.env);
  const doFetch = io.fetch ?? fetch;
  const trustHooks = flag(argv, 'trust-hooks');
  const acceptPublisherChange = flag(argv, 'accept-publisher-change');

  const load = async (): Promise<boolean> => {
    const v = await validateExtension(root);
    if (!v.ok) {
      report(v, target, io);
      io.stderr('not loaded: fix the problems above\n');
      return false;
    }
    const packed = packBundle(folderBundleFiles(root));
    let res: Response;
    try {
      res = await doFetch(`${hub.base}/api/v1/extensions/dev`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          bundle: Buffer.from(packed.bytes).toString('base64'),
          confirmSideload: true,
          trustHooks,
          ...(acceptPublisherChange ? { acceptPublisherChange: true } : {}),
        }),
      });
    } catch (err) {
      io.stderr(
        `the Hub could not be reached: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const error = body.error as { message?: string } | undefined;
      io.stderr(`the Hub answered ${res.status}: ${error?.message ?? 'refused'}\n`);
      return false;
    }
    const reg = (body.registered ?? {}) as Record<string, number>;
    const error = typeof body.error === 'string' ? ` (${body.error})` : '';
    io.stdout(
      `loaded ${String(body.id)} ${String(body.version)}: ${String(body.status)}${error}; ${reg.commands ?? 0} commands, ${reg.panels ?? 0} panels, ${reg.tools ?? 0} tools\n`,
    );
    return body.status === 'running';
  };

  const first = await load();
  if (flag(argv, 'once')) return first ? 0 : 1;
  io.stdout(`watching ${root} (Ctrl-C to stop)\n`);
  await new Promise<void>((resolveWatch) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = Promise.resolve();
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      const rel = typeof file === 'string' ? file : '';
      if (rel.split(sep).some((s) => IGNORED.has(s))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        busy = busy.then(async () => {
          io.stdout(`changed: ${relative(root, join(root, rel)) || '.'}\n`);
          await load();
        });
      }, io.debounceMs ?? 300);
    });
    const stop = () => {
      clearTimeout(timer);
      watcher.close();
      void busy.then(() => resolveWatch());
    };
    if (io.signal?.aborted) stop();
    io.signal?.addEventListener('abort', stop, { once: true });
  });
  return 0;
}

// ---- mcp ---------------------------------------------------------------------------------------

async function mcpCommand(argv: string[], io: CliIo): Promise<number> {
  if (argv[0] !== 'stdio') throw new UsageError('nova mcp stdio [--url URL] [--token-file FILE]');
  let config: { url: string; token: string };
  try {
    config = launcherConfig(argv.slice(1), io.env);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!io.stdin || !io.stdoutStream) throw new Error('nova mcp stdio needs a terminal');
  await runStdioLauncher({
    ...config,
    stdin: io.stdin,
    stdout: io.stdoutStream,
    log: (line) => io.stderr(`${line}\n`),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  return 0;
}
