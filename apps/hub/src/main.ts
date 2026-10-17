#!/usr/bin/env node
// Hub entry point. Usage:
//   node apps/hub/src/main.ts [--port N] [--host H] [--data-dir D]   start the Hub
//   node apps/hub/src/main.ts code [--data-dir D]                     print a new setup code
import { join } from 'node:path';
import { FileVault } from '@nova/secrets';
import { migrate, openDatabase } from '@nova/storage';
import { Logger, RotatingFileSink, stderrSink } from '@nova/telemetry';
import { buildHub } from './app.ts';
import { AuthService } from './auth.ts';
import { loadConfig, type HubConfig } from './config.ts';

export async function start(
  config: HubConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  const log = new Logger({
    module: 'hub',
    level: config.logLevel,
    sinks: [stderrSink, new RotatingFileSink(join(config.logDir, 'hub.jsonl'))],
  });
  const db = openDatabase({ path: config.dbPath });
  const result = await migrate(db, { backupDir: config.backupDir });
  if (result.applied.length)
    log.info('database migrated', { from: result.from, to: result.to, backup: result.backupPath });

  // Credentials live in the encrypted vault, never in the database (FR-101, docs/12 §5).
  const secrets = new FileVault(join(config.dataDir, 'secrets.vault'), {
    kind: 'keyfile',
    path: join(config.dataDir, 'vault.key'),
  });
  const { app, auth, chat, registry } = await buildHub({ config, db, log, secrets });
  // A crash may have left replies mid-stream: keep their text, mark them incomplete (FR-018).
  const recovered = await chat.recoverOnStartup();
  if (recovered.messages || recovered.turns) log.warn('recovered interrupted turns', recovered);
  const owner = await auth.ownerAccount();
  if (owner) await registry.ensureDefaultProvider(owner.id);
  const port = await listenWithFallback(app, config, log);
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;
  log.info('hub listening', { url, dataDir: config.dataDir, version: config.version });

  if ((await auth.ownerAccount()) === null || !(await auth.hasActiveSessions())) {
    const code = await auth.issueSetupCode();
    // Shown once, on the console only: the fragment never reaches server logs (docs/22 §4).
    process.stdout.write(
      `\nOpen this link to set up Nova (valid 1 hour):\n  ${url}/#setup=${code}\n\n`,
    );
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    log.info('hub stopping');
    await app.close();
    db.close();
  };
  return { url, close };
}

async function listenWithFallback(
  app: Awaited<ReturnType<typeof buildHub>>['app'],
  config: HubConfig,
  log: Logger,
): Promise<number> {
  for (let i = 0; i <= config.portFallbacks; i++) {
    const port = config.port === 0 ? 0 : config.port + i;
    try {
      await app.listen({ host: config.host, port });
      const addr = app.server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || config.port === 0) throw err;
      // FR-225: a taken port is a diagnostic and a fallback, never a silent exit.
      log.warn('port in use, trying the next one', { port, next: port + 1 });
    }
  }
  throw new Error(
    `ports ${config.port}-${config.port + config.portFallbacks} are all in use; set --port or NOVA_PORT`,
  );
}

async function printSetupCode(config: HubConfig): Promise<void> {
  const db = openDatabase({ path: config.dbPath });
  await migrate(db, { backupDir: config.backupDir });
  const code = await new AuthService(db).issueSetupCode();
  db.close();
  process.stdout.write(`${code}\n`);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.ts');
if (isMain) {
  const config = loadConfig();
  if (process.argv[2] === 'code') {
    await printSetupCode(config);
  } else {
    const hub = await start(config);
    const shutdown = (signal: string) => {
      process.stderr.write(`received ${signal}\n`);
      void hub.close().then(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}
