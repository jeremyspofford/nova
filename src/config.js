// Nova's configuration: nova.config.json at the repo root, overridden by
// environment variables. Everything has a working default.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One configurable command reaches the model. Nova writes the assembled
// system prompt to a file and substitutes its path for {system_file}; the
// conversation arrives on stdin. Output may be plain text or Claude Code's
// stream-json. The flags keep Claude Code's own tools, hooks, MCP servers and
// settings out of the loop, so Nova's tools and approvals are the only ones.
export const DEFAULT_AGENT_CMD = [
  'claude -p',
  '--output-format stream-json --verbose --include-partial-messages',
  '--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands',
  '--no-session-persistence',
  '--system-prompt-file {system_file}',
].join(' ');

export function loadConfig(env = process.env, root = ROOT) {
  const path = resolve(root, 'nova.config.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return {
    root,
    // Personal data lives outside the code, in one folder of plain files.
    home: expandHome(env.NOVA_HOME ?? file.home ?? '~/Nova', root),
    host: env.NOVA_HOST ?? file.host ?? '127.0.0.1',
    port: Number(env.NOVA_PORT ?? file.port ?? 4317),
    agentCmd: env.NOVA_AGENT_CMD ?? file.agent_cmd ?? DEFAULT_AGENT_CMD,
    // Where the model command sends the conversation: none (this process), local (this machine or
    // the person's own devices), remote (a cloud service). Undeclared counts as remote, so a
    // local-only profile never reaches the cloud by assumption.
    agentEgress: egress(env.NOVA_AGENT_EGRESS ?? file.agent_egress),
    timezone: env.NOVA_TZ ?? file.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Set explicitly (env or file) wins; otherwise the profile's timezone, once setup has one.
    timezonePinned: Boolean(env.NOVA_TZ ?? file.timezone),
    theme: file.theme ?? 'nova',
    dev: env.NOVA_DEV === '1',
    maxSteps: Number(file.max_tool_steps ?? 8),
    execTimeoutMs: Number(file.exec_timeout_ms ?? 120_000),
    // Stand-ins for Google and the search engine, for tests and screenshots.
    googleBase: env.NOVA_GOOGLE_BASE ?? '',
    imapUrl: env.NOVA_IMAP_URL ?? undefined,
    searchUrl: env.NOVA_SEARCH_URL ?? undefined,
    // The mesh listener for paired devices (M4 plan §0), or null: then nothing beyond this machine
    // can reach Nova's console, and devices can't pair.
    mesh: meshConfig(env, file),
  };
}

// A setting Nova refuses to start with; the message says why, in plain words.
export class ConfigError extends Error {}

// NOVA_MESH_URL=https://host:port with NOVA_TLS_CERT and NOVA_TLS_KEY; or http://host:port only with
// NOVA_MESH_TRANSPORT=proxy (a TLS proxy carries it) or network (an encrypted network, such as a
// tailnet, does). Plain HTTP with no such statement is refused: anyone on the way could read and
// change what devices say. NOVA_MESH_PUBLIC_URL is the address devices are told to use.
export function meshConfig(env, file = {}) {
  const raw = env.NOVA_MESH_URL ?? file.mesh_url;
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new ConfigError(`NOVA_MESH_URL isn't an address Nova can listen on: ${raw}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.port === '' || url.pathname !== '/') {
    throw new ConfigError(`NOVA_MESH_URL must be http(s)://<address>:<port>, with nothing after the port: ${raw}`);
  }
  let transport = env.NOVA_MESH_TRANSPORT ?? file.mesh_transport;
  let tls = null;
  if (url.protocol === 'https:') {
    if (transport && transport !== 'tls') throw new ConfigError('NOVA_MESH_TRANSPORT is only for an http:// mesh address; an https:// one carries its own TLS.');
    const cert = env.NOVA_TLS_CERT ?? file.tls_cert;
    const key = env.NOVA_TLS_KEY ?? file.tls_key;
    if (!cert || !key) throw new ConfigError('An https:// mesh address needs NOVA_TLS_CERT and NOVA_TLS_KEY: the certificate and its private key, as PEM files.');
    tls = { cert, key };
    transport = 'tls';
  } else if (!['proxy', 'network'].includes(transport)) {
    throw new ConfigError(`Nova won't serve other devices over plain HTTP at ${raw}: anyone on the way could read and change what they send. Use an https:// address with NOVA_TLS_CERT and NOVA_TLS_KEY. If a TLS proxy or an encrypted network (such as a tailnet) already carries it, say so with NOVA_MESH_TRANSPORT=proxy or NOVA_MESH_TRANSPORT=network.`);
  }
  const bindHost = url.hostname.replace(/^\[|\]$/g, '');
  const wildcard = ['0.0.0.0', '::'].includes(bindHost);
  const pub = env.NOVA_MESH_PUBLIC_URL ?? file.mesh_public_url ?? (wildcard ? null : url.origin);
  if (!pub) throw new ConfigError(`NOVA_MESH_URL listens on every address, so Nova can't tell devices which one to use. Set NOVA_MESH_PUBLIC_URL to the address they reach it at.`);
  let publicUrl;
  try { publicUrl = new URL(pub); } catch { throw new ConfigError(`NOVA_MESH_PUBLIC_URL isn't an address: ${pub}`); }
  if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new ConfigError(`NOVA_MESH_PUBLIC_URL must be an http(s) address: ${pub}`);
  if (transport !== 'network' && publicUrl.protocol !== 'https:') {
    throw new ConfigError(`Devices reach Nova over TLS here, so NOVA_MESH_PUBLIC_URL must be an https:// address, not ${pub}.`);
  }
  return { bindHost, port: Number(url.port), transport, tls, publicUrl: publicUrl.origin };
}

function egress(v) {
  return ['none', 'local', 'remote'].includes(v) ? v : 'remote';
}

function expandHome(p, root) {
  return p === '~' || p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(root, p);
}
