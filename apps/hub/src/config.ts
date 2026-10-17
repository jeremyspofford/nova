// Hub configuration (docs/05 §8: defaults → Hub settings → managed policy → env).
// Data directories are resolved explicitly (FR-225); nothing relies on per-user virtualization.
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecretsMode } from '@nova/secrets';
import type { Level } from '@nova/telemetry';

export interface HubConfig {
  host: string;
  port: number;
  /** Try up to this many following ports when `port` is taken (FR-225). */
  portFallbacks: number;
  dataDir: string;
  dbPath: string;
  backupDir: string;
  logDir: string;
  webDir: string;
  logLevel: Level;
  /** Extra origins allowed for browser requests (e.g. a mesh hostname). */
  allowedOrigins: string[];
  version: string;
  dev: boolean;
  /** Where secrets live (FR-101): the encrypted vault (default) or the OS keychain. */
  secrets: SecretsMode;
  /** TLS for the Hub listener (FR-149), from NOVA_TLS_CERT and NOVA_TLS_KEY (PEM files). */
  tls: { certPath: string; keyPath: string } | null;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Nova');
    case 'win32':
      return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Nova');
    default:
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'Nova');
  }
}

const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error'];

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): HubConfig {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq?.slice(name.length + 3);
  };
  const dataDir = resolve(arg('data-dir') ?? env.NOVA_DATA_DIR ?? defaultDataDir(env));
  const port = Number(arg('port') ?? env.NOVA_PORT ?? 7419);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  const level = (arg('log-level') ?? env.NOVA_LOG_LEVEL ?? 'info') as Level;
  if (!LEVELS.includes(level)) throw new Error(`invalid log level: ${level}`);
  const secrets = (env.NOVA_SECRETS ?? 'vault') as SecretsMode;
  if (secrets !== 'vault' && secrets !== 'keychain')
    throw new Error(`invalid NOVA_SECRETS: ${String(secrets)} (use vault or keychain)`);
  const cert = arg('tls-cert') ?? env.NOVA_TLS_CERT;
  const key = arg('tls-key') ?? env.NOVA_TLS_KEY;
  // Half a TLS configuration is a mistake, never a silent fallback to plain HTTP.
  if (!!cert !== !!key) throw new Error('set both NOVA_TLS_CERT and NOVA_TLS_KEY, or neither');
  return {
    host: arg('host') ?? env.NOVA_HOST ?? '127.0.0.1',
    port,
    portFallbacks: Number(env.NOVA_PORT_FALLBACKS ?? 10),
    dataDir,
    dbPath: join(dataDir, 'nova.db'),
    backupDir: join(dataDir, 'backups'),
    logDir: join(dataDir, 'logs'),
    webDir: resolve(
      arg('web-dir') ??
        env.NOVA_WEB_DIR ??
        fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    ),
    logLevel: level,
    allowedOrigins: (env.NOVA_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    version: env.NOVA_VERSION ?? '0.0.0-dev',
    dev: env.NODE_ENV === 'development',
    secrets,
    tls: cert && key ? { certPath: resolve(cert), keyPath: resolve(key) } : null,
  };
}
