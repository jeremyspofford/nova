#!/usr/bin/env node
// Hub entry point. Usage:
//   node apps/hub/src/main.ts [--port N] [--host H] [--data-dir D]   start the Hub
//   node apps/hub/src/main.ts code [--data-dir D]                     print a new setup code
// NOVA_TLS_CERT and NOVA_TLS_KEY (PEM files) serve HTTPS; without them the trust mode decides
// (FR-134: the Hub local CA's certificate, or plain HTTP). Over HTTPS the listener asks clients for
// a device certificate of the Hub local CA without requiring one (FR-126: novad devices and compute
// nodes present theirs; browsers are not asked for anything they hold), and the device-trust area
// checks it on the device routes. NOVA_SECRETS=keychain keeps secrets in the OS keychain (default:
// the encrypted vault).
import { readFileSync } from 'node:fs';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { openSecretStore } from '@nova/secrets';
import { migrate, openDatabase } from '@nova/storage';
import { Logger, RingSink, RotatingFileSink, stderrSink } from '@nova/telemetry';
import { buildHub, type Hub } from './app.ts';
import { AuthService } from './auth.ts';
import { loadConfig, type HubConfig } from './config.ts';
import type { HubTlsSource } from './trust.ts';

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
  const hub: Hub = await buildHub({ config, db, log, secrets });
  const { app, auth, chat, registry, sources, runs } = hub;
  // A crash may have left replies mid-stream: keep their text, mark them incomplete (FR-018).
  // Queued follow-ups then start (FR-019), unfinished source indexing resumes (FR-040), and
  // temporary chats past their TTL are purged (FR-027).
  const recovered = await chat.recoverOnStartup();
  if (recovered.messages || recovered.turns) log.warn('recovered interrupted turns', recovered);
  // Work runs a restart interrupted continue from their last committed state (FR-052).
  const resumed = await runs.recover();
  if (resumed) log.info('resuming work runs', { runs: resumed });
  const reindexing = await sources.recover();
  if (reindexing) log.info('resuming source indexing', { sources: reindexing });
  const purged = await chat.sweepTemporary();
  if (purged) log.info('purged expired temporary chats', { threads: purged });
  const owner = await auth.ownerAccount();
  if (owner) await registry.ensureDefaultProvider(owner.id);
  // An explicit certificate wins; otherwise the trust mode's (FR-134), else plain HTTP.
  const trust = tls ? null : hub.trust.tls;
  let trustMaterial: ListenerTls | null = null;
  let trustFailure: string | null = null;
  if (trust) {
    try {
      trustMaterial = await trust.material();
    } catch (err) {
      // Never lock the owner out (docs/22 §9), and never widen either: without the certificates
      // the trust mode asked for, plain HTTP is served on loopback only (the trust problems say
      // why), not on every interface.
      trustFailure = err instanceof Error ? err.message : String(err);
      log.error('the trust certificates could not be read; serving plain HTTP on loopback only', {
        err,
      });
    }
  }
  const host = trustFailure ? '127.0.0.1' : config.host;
  // Client certificates are requested from the Hub local CA's devices whenever one exists, also
  // with an explicit certificate (mutual TLS, FR-126).
  const clientCa = () => hub.trust.service.caCertificate();
  const material = tls
    ? { cert: tls.cert, key: tls.key, sni: [], clientCa: clientCa() }
    : trustMaterial
      ? { ...trustMaterial, clientCa: clientCa() }
      : null;
  const listener = material ? await tlsListener(app, material) : null;
  const port = await listenWithFallback(config, log, (p) =>
    listener ? listener.listen(p, host) : plainListen(app, p, host),
  );
  const scheme = listener ? 'https' : 'http';
  const url = `${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  hub.trust.tls.reportServing({
    scheme,
    source: tls ? 'explicit' : trustMaterial ? 'trust' : 'none',
    fallbackReason: trustFailure,
  });
  // Renewed certificates reach the running listener; a new trust mode waits for a restart.
  const offTls =
    trust && listener
      ? watchTrust(
          trust,
          { update: (next) => listener.update({ ...next, clientCa: clientCa() }) },
          log,
        )
      : null;
  // The endpoints are checked against the real listener before any is advertised (FR-135).
  await hub.network
    .listening({ host, port, protocol: scheme })
    .catch((err: unknown) => log.warn('network endpoints not checked', { err }));
  log.info('hub listening', {
    url,
    dataDir: config.dataDir,
    version: config.version,
    tls: tls ? 'explicit' : trustMaterial ? 'trust' : false,
  });

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
    offTls?.();
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

/** A default certificate chain and key, plus certificates chosen by name (SNI). */
export interface ListenerTls {
  cert: string | Buffer;
  key: string | Buffer;
  sni: { host: string; cert: string; key: string }[];
  /**
   * The Hub local CA (PEM): clients are asked for a certificate it issued (mutual TLS, FR-126),
   * never required to send one; the device-trust area checks what they send. None: not asked.
   */
  clientCa?: string | null;
}

/**
 * Apply renewed trust certificates to the running listener. A failure (unreadable material, a key
 * the TLS stack refuses) is logged and the listener keeps its current certificates; it never
 * becomes an unhandled rejection that would end the process.
 */
export function watchTrust(
  trust: Pick<HubTlsSource, 'material' | 'onChange'>,
  listener: { update: (tls: ListenerTls) => void },
  log: Pick<Logger, 'error'>,
): () => void {
  return trust.onChange(() => {
    void (async () => {
      const next = await trust.material();
      if (next) listener.update(next);
    })().catch((err: unknown) => {
      log.error('the renewed certificates could not be applied; keeping the current ones', {
        err,
      });
    });
  });
}

function sniContexts(tls: ListenerTls): Map<string, SecureContext> {
  return new Map(
    tls.sni.map((s) => [
      s.host.toLowerCase(),
      createSecureContext({
        cert: s.cert,
        key: s.key,
        minVersion: 'TLSv1.2',
        ...(tls.clientCa ? { ca: tls.clientCa } : {}),
      }),
    ]),
  );
}

/**
 * An HTTPS server in front of the Hub's Fastify routes (FR-149: TLS in transit when certificates
 * are configured; FR-134: the trust mode's certificates). Requests and WebSocket upgrades go
 * through the same routes and hooks, so authentication and Host/Origin checks are identical to
 * plain HTTP. A client that names a host with its own certificate (a mesh name) gets that one.
 * With `clientCa` the handshake asks for a client certificate issued by it; one that is missing
 * or does not verify still connects (`rejectUnauthorized: false`), so browsers keep working, and
 * the device-trust area decides on the device routes (FR-126).
 */
export async function tlsListener(
  app: App,
  tls: ListenerTls,
): Promise<{
  listen: (port: number, host: string) => Promise<number>;
  close: () => Promise<void>;
  /** Swap the certificates in place (a renewal); open connections keep theirs. */
  update: (tls: ListenerTls) => void;
}> {
  await app.ready();
  let byName = sniContexts(tls);
  const server: TlsServer = createTlsServer(
    {
      cert: tls.cert,
      key: tls.key,
      minVersion: 'TLSv1.2',
      // Asked, never required: the check is the device-trust area's, on the device routes only.
      requestCert: Boolean(tls.clientCa),
      rejectUnauthorized: false,
      ...(tls.clientCa ? { ca: tls.clientCa } : {}),
      // No match (or no name, as for an address) uses the default certificate.
      SNICallback: (name, cb) => cb(null, byName.get(name.toLowerCase())),
    },
    (req, res) => app.routing(req, res),
  );
  server.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
  return {
    update: (next) => {
      server.setSecureContext({
        cert: next.cert,
        key: next.key,
        minVersion: 'TLSv1.2',
        ...(next.clientCa ? { ca: next.clientCa } : {}),
      });
      byName = sniContexts(next);
    },
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
