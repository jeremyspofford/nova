#!/usr/bin/env node
// nova-runner: run a cloud runner (FR-108, FR-071; contracts/rest-api.md §5). Usage:
//   nova-runner [--host 127.0.0.1] [--port 7431] [--data-dir <dir>] [--token-file <file>]
//               [--substrate auto|bwrap|docker|podman] [--image <ref>] [--local-repos <dir,...>]
//   nova-runner token add [--token-file <file>] [--label <name>]
// The token file holds SHA-256 hashes only; `token add` prints the new token once.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { streamLog } from './log.ts';
import { buildRunnerServer } from './server.ts';
import { addToken, readTokenFile, type RunnerToken } from './tokens.ts';

const USAGE = `Usage: nova-runner [--host <addr>] [--port <n>] [--data-dir <dir>] [--token-file <file>]
                   [--substrate auto|bwrap|docker|podman] [--image <ref>] [--local-repos <dirs>]
       nova-runner token add [--token-file <file>] [--label <name>]
  --host          address to listen on (default 127.0.0.1; use 0.0.0.0 behind TLS for a remote runner)
  --port          port (default 7431; 0 picks a free one)
  --data-dir      where environments, snapshots and artifacts live (default ~/.local/share/nova-runner)
  --token-file    the Hubs' token hashes (default <data-dir>/tokens)
  --substrate     the sandbox: bubblewrap, a container runtime, or auto (default)
  --image         the container substrate's default image (default debian:stable-slim)
  --local-repos   folders on this machine that file:// repositories may come from (comma-separated)
`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dataDir =
    values['data-dir'] ??
    process.env.NOVA_RUNNER_DATA_DIR ??
    join(homedir(), '.local', 'share', 'nova-runner');
  const tokenFile =
    values['token-file'] ?? process.env.NOVA_RUNNER_TOKEN_FILE ?? join(dataDir, 'tokens');
  if (positionals[0] === 'token') {
    if (positionals[1] !== 'add') {
      process.stderr.write(USAGE);
      return 2;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { token, record } = addToken(tokenFile, values.label ?? 'hub');
    process.stdout.write(
      `Added token "${record.label}" (${record.id}) to ${tokenFile}.\n` +
        `Give it to the Hub (Settings, Cloud runner); it is not shown again:\n${token}\n`,
    );
    return 0;
  }
  if (positionals.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  const port = Number(values.port ?? process.env.NOVA_RUNNER_PORT ?? 7431);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid --port\n${USAGE}`);
    return 2;
  }
  if (!existsSync(tokenFile)) {
    process.stderr.write(
      `no token file at ${tokenFile}: create a token first with "nova-runner token add"\n`,
    );
    return 2;
  }
  // The token file is read again when it changes, so a new Hub needs no restart.
  let tokens: RunnerToken[] = readTokenFile(tokenFile);
  let mtime = statSync(tokenFile).mtimeMs;
  const log = streamLog();
  const source = () => {
    try {
      const m = statSync(tokenFile).mtimeMs;
      if (m !== mtime) {
        tokens = readTokenFile(tokenFile);
        mtime = m;
        log.info('token file reloaded', { hubs: tokens.length });
      }
    } catch (err) {
      log.warn('the token file could not be read; keeping the previous tokens', { err });
    }
    return tokens;
  };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const server = await buildRunnerServer({
    dataDir,
    tokens: source,
    substrateMode: values.substrate ?? process.env.NOVA_RUNNER_SUBSTRATE ?? 'auto',
    ...(values.image ? { image: values.image } : {}),
    ...(values['local-repos']
      ? {
          localRepoRoots: values['local-repos']
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    log,
  });
  const address = await server.app.listen({ host: values.host ?? '127.0.0.1', port });
  log.info('runner listening', {
    address,
    substrate: server.runner.substrate?.kind ?? null,
    hubs: tokens.length,
  });
  process.stdout.write(`Nova runner listening on ${address}\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await server.close();
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'token-file': { type: 'string' },
      substrate: { type: 'string' },
      image: { type: 'string' },
      'local-repos': { type: 'string' },
      label: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`nova-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
