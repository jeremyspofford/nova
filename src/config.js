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
    timezone: env.NOVA_TZ ?? file.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    theme: file.theme ?? 'paper',
    dev: env.NOVA_DEV === '1',
    maxSteps: Number(file.max_tool_steps ?? 8),
    execTimeoutMs: Number(file.exec_timeout_ms ?? 120_000),
  };
}

function expandHome(p, root) {
  return p === '~' || p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(root, p);
}
