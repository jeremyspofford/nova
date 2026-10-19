#!/usr/bin/env node
// nova-relay: run a self-hosted Relay (FR-137, docs/22 §3). Usage:
//   nova-relay [--host 0.0.0.0] [--port 7430] [--data-dir <dir>] [--trust-proxy <hops|addr,...>]
// The registration token, when wanted, comes from NOVA_RELAY_REGISTRATION_TOKEN (never argv).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { streamLog } from './log.ts';
import { pushSenderFromEnv } from './push.ts';
import { buildRelayServer, parseTrustProxy } from './server.ts';

const USAGE = `Usage: nova-relay [--host <addr>] [--port <n>] [--data-dir <dir>] [--trust-proxy <hops|addrs>]
  --host          address to listen on (default 0.0.0.0)
  --port          port (default 7430; 0 picks a free one)
  --data-dir      keep routing registrations across restarts (memory only without it)
  --trust-proxy   behind a reverse proxy: the number of proxy hops in front (e.g. 1), or the
                  proxies' addresses or CIDR ranges (comma-separated); the client address for
                  the per-address limits then comes from X-Forwarded-For past those proxies only
Environment: NOVA_RELAY_REGISTRATION_TOKEN makes Hub registration need that bearer token.
Push (off unless set): NOVA_RELAY_APNS_KEY_FILE, NOVA_RELAY_APNS_KEY_ID, NOVA_RELAY_APNS_TEAM_ID,
  NOVA_RELAY_APNS_TOPICS, NOVA_RELAY_APNS_SANDBOX=1; NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE.
`;

async function main(argv: string[]): Promise<number> {
  let values: {
    host?: string;
    port?: string;
    'data-dir'?: string;
    'trust-proxy'?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'data-dir': { type: 'string' },
        'trust-proxy': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const port = Number(values.port ?? process.env.NOVA_RELAY_PORT ?? 7430);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid --port\n${USAGE}`);
    return 2;
  }
  const log = streamLog();
  // Real APNs and FCM only when the operator configured them; the recording mock otherwise.
  const push = pushSenderFromEnv(process.env, (path) => readFileSync(path, 'utf8'));
  const relay = await buildRelayServer({
    push: push.sender,
    dataDir: values['data-dir'] ?? process.env.NOVA_RELAY_DATA_DIR ?? null,
    registrationToken: process.env.NOVA_RELAY_REGISTRATION_TOKEN || null,
    trustProxy:
      values['trust-proxy'] === undefined ? false : parseTrustProxy(values['trust-proxy']),
    log,
  });
  const address = await relay.app.listen({ host: values.host ?? '0.0.0.0', port });
  log.info('relay listening', {
    address,
    persistent: relay.state.persistent,
    push: push.configured.length ? push.configured : 'mock',
  });
  process.stdout.write(`Nova Relay listening on ${address}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await relay.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`nova-relay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
