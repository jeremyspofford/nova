// `nova data export|import` (FR-105, ADR-097 D1/D5): the data controls from a terminal, through a
// Hub's API. The Hub and the owner's token come from NOVA_URL and NOVA_TOKEN; a passphrase from
// NOVA_EXPORT_PASSPHRASE or `--passphrase-file`, never from the command line. The `nova` command
// (packages/cli) wires this module as its `data` subcommand.
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export const DATA_CLI_USAGE = [
  'nova data export [--out <file>] [--passphrase-file <file> --confirm <hub name>]',
  'nova data import <file> [--passphrase-file <file>] [--yes]',
  '',
  'NOVA_URL (https, or http only to this machine) and NOVA_TOKEN name the Hub and the owner token.',
  'A passphrase seals the export and includes the vault secrets; set NOVA_EXPORT_PASSPHRASE or use',
  "--passphrase-file, and confirm with the Hub's name (--confirm).",
  'An import goes into an empty Hub; without --yes it only checks the archive.',
].join('\n');

export interface DataCliIo {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

class CliError extends Error {}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new CliError(`--${name} needs a value`);
    return v;
  }
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function passphrase(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  if (argv.some((a) => a === '--passphrase' || a.startsWith('--passphrase=')))
    throw new CliError(
      'a passphrase is never given on the command line: use --passphrase-file or NOVA_EXPORT_PASSPHRASE',
    );
  const file = option(argv, 'passphrase-file');
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return env.NOVA_EXPORT_PASSPHRASE || undefined;
}

function hub(env: NodeJS.ProcessEnv): { base: string; token: string } {
  const base = env.NOVA_URL?.replace(/\/+$/, '');
  const token = env.NOVA_TOKEN;
  if (!base || !token) throw new CliError('set NOVA_URL and NOVA_TOKEN');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CliError('NOVA_URL is not a URL');
  }
  // The token (and a passphrase) never cross a network in clear.
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new CliError('NOVA_URL must be https:// (http:// only to this machine)');
  return { base, token };
}

async function failure(res: Response): Promise<CliError> {
  let message = `the Hub answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string; details?: unknown } };
    if (body.error?.message) message = `${message}: ${body.error.message}`;
  } catch {
    // not JSON
  }
  return new CliError(message);
}

async function exportCommand(argv: string[], io: DataCliIo): Promise<number> {
  const { base, token } = hub(io.env);
  const pass = passphrase(argv, io.env);
  const confirm = option(argv, 'confirm');
  if (pass && !confirm)
    throw new CliError(
      "a sealed export carries every secret: confirm with --confirm <the Hub's name>",
    );
  const stamp = (io.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const out = option(argv, 'out') ?? `nova-${stamp}.novaexport`;
  const res = await (io.fetch ?? fetch)(`${base}/api/v1/data/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(pass ? { passphrase: pass, confirm } : {}),
  });
  if (!res.ok || !res.body) throw await failure(res);
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(out, { flags: 'wx', mode: 0o600 }),
  );
  io.stdout(
    `Exported to ${out} (${statSync(out).size} bytes)${pass ? ', sealed with your passphrase' : '; secrets were left out'}\n`,
  );
  return 0;
}

async function post(io: DataCliIo, url: string, token: string, body: unknown): Promise<unknown> {
  const res = await (io.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

async function importCommand(argv: string[], io: DataCliIo): Promise<number> {
  const { base, token } = hub(io.env);
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--passphrase-file');
  if (!file) throw new CliError('name the archive to import');
  const pass = passphrase(argv, io.env);
  const up = await (io.fetch ?? fetch)(`${base}/api/v1/data/import/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
  });
  if (!up.ok) throw await failure(up);
  const { uploadId } = (await up.json()) as { uploadId: string };
  const auth = { uploadId, ...(pass ? { passphrase: pass } : {}) };
  const check = (await post(io, `${base}/api/v1/data/import/check`, token, auth)) as {
    rows: number;
    tables: unknown[];
    files: { count: number };
    hubEmpty: boolean;
    blockingTables: string[];
    toReEnter: string[];
    migratesFrom: number | null;
  };
  io.stdout(
    `The archive holds ${check.rows} rows in ${check.tables.length} tables and ${check.files.count} files.\n`,
  );
  if (check.migratesFrom !== null)
    io.stdout(
      `It comes from an older Hub and is migrated forward from schema ${check.migratesFrom}.\n`,
    );
  if (!check.hubEmpty) {
    io.stderr(
      `This Hub is not empty (${check.blockingTables.join(', ')}): delete all data first.\n`,
    );
    return 1;
  }
  if (!argv.includes('--yes')) {
    io.stdout('Checked; nothing was imported. Run again with --yes to import.\n');
    return 0;
  }
  const result = (await post(io, `${base}/api/v1/data/import`, token, {
    ...auth,
    confirm: true,
  })) as { rows: number; toReEnter: string[] };
  io.stdout(`Imported ${result.rows} rows. The Hub restarts its services.\n`);
  if (result.toReEnter.length)
    io.stdout(`Secrets to enter again: ${result.toReEnter.join(', ')}\n`);
  return 0;
}

/** Run `nova data <export|import> ...`; returns the exit code. */
export async function runDataCommand(argv: string[], io: DataCliIo): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'export') return await exportCommand(rest, io);
    if (sub === 'import') return await importCommand(rest, io);
    io.stderr(`${DATA_CLI_USAGE}\n`);
    return 2;
  } catch (err) {
    io.stderr(`nova data ${sub ?? ''}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
