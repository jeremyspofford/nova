#!/usr/bin/env node
// Hub entry point. Usage:
//   node apps/hub/src/main.ts [--port N] [--host H] [--data-dir D]   start the Hub
//   node apps/hub/src/main.ts code [--data-dir D]                     print a new setup code
// NOVA_TLS_CERT and NOVA_TLS_KEY (PEM files) serve HTTPS; NOVA_SECRETS=keychain keeps secrets in
// the OS keychain (default: the encrypted vault).
import { readFileSync } from 'node:fs';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { join } from 'node:path';
import { openSecretStore } from '@nova/secrets';
import { migrate, openDatabase } from '@nova/storage';
import { Logger, RingSink, RotatingFileSink, stderrSink } from '@nova/telemetry';
import { buildHub } from './app.ts';
import { AuthService } from './auth.ts';
import { loadConfig, type HubConfig } from './config.ts';

export async function start(
  config: HubConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  // The ring feeds the Diagnostics log viewer and the log export (FR-118).
  const log = new Logger({
    module: 'hub',
    level: config.logLevel,
    sinks: [stderrSink, new RotatingFileSink(join(config.logDir, 'hub.jsonl')), new RingSink(5000)],
  });
  // Read TLS material first: a bad path fails the start before anything listens (FR-149).
  const tls = config.tls
    ? { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) }
    : null;
  const db = openDatabase({ path: config.dbPath });
  const result = await migrate(db, { backupDir: config.backupDir });
  if (result.applied.length)
    log.info('database migrated', { from: result.from, to: result.to, backup: result.backupPath });

  // Credentials live in the encrypted vault or the OS keychain, never in the database (FR-101,
  // docs/12 §5). NOVA_SECRETS=keychain falls back to the vault with a warning.
  const opened = await openSecretStore({
    mode: config.secrets,
    vaultPath: join(config.dataDir, 'secrets.vault'),
    vaultKey: { kind: 'keyfile', path: join(config.dataDir, 'vault.key') },
  });
  if (opened.warning) log.warn(opened.warning);
  if (opened.migrated) log.info('moved secrets into the OS keychain', { count: opened.migrated });
  const secrets = opened.store;
  const { app, auth, chat, registry, sources } = await buildHub({ config, db, log, secrets });
  // A crash may have left replies mid-stream: keep their text, mark them incomplete (FR-018).
  // Queued follow-ups then start (FR-019), unfinished source indexing resumes (FR-040), and
  // temporary chats past their TTL are purged (FR-027).
  const recovered = await chat.recoverOnStartup();
  if (recovered.messages || recovered.turns) log.warn('recovered interrupted turns', recovered);
  const reindexing = await sources.recover();
  if (reindexing) log.info('resuming source indexing', { sources: reindexing });
  const purged = await chat.sweepTemporary();
  if (purged) log.info('purged expired temporary chats', { threads: purged });
  const owner = await auth.ownerAccount();
  if (owner) await registry.ensureDefaultProvider(owner.id);
  const listener = tls ? await tlsListener(app, tls) : null;
  const port = await listenWithFallback(config, log, (p) =>
    listener ? listener.listen(p, config.host) : plainListen(app, p, config.host),
  );
  const scheme = tls ? 'https' : 'http';
  const url = `${scheme}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;
  log.info('hub listening', { url, dataDir: config.dataDir, version: config.version, tls: !!tls });

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
    await listener?.close();
    db.close();
  };
  return { url, close };
}

type App = Awaited<ReturnType<typeof buildHub>>['app'];

async function plainListen(app: App, port: number, host: string): Promise<number> {
  await app.listen({ host, port });
  const addr = app.server.address();
  return typeof addr === 'object' && addr ? addr.port : port;
}

/**
 * An HTTPS server in front of the Hub's Fastify routes (FR-149: TLS in transit when certificates
 * are configured). Requests and WebSocket upgrades go through the same routes and hooks, so
 * authentication and Host/Origin checks are identical to plain HTTP.
 */
async function tlsListener(
  app: App,
  tls: { cert: Buffer; key: Buffer },
): Promise<{
  listen: (port: number, host: string) => Promise<number>;
  close: () => Promise<void>;
}> {
  await app.ready();
  const server: TlsServer = createTlsServer({ ...tls, minVersion: 'TLSv1.2' }, (req, res) =>
    app.routing(req, res),
  );
  server.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
  return {
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function listenWithFallback(
  config: HubConfig,
  log: Logger,
  listen: (port: number) => Promise<number>,
): Promise<number> {
  for (let i = 0; i <= config.portFallbacks; i++) {
    const port = config.port === 0 ? 0 : config.port + i;
    try {
      return await listen(port);
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
