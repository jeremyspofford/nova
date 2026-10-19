// Readers for the open formats the importer understands (FR-200, docs/08 §4.2): skills and
// command files, MCP server configs (`mcpServers` JSON objects), plugin manifests, memory exports
// (JSON or text) and chat exports (a list of messages per conversation, or a message tree).
// Everything read here is untrusted data: it is parsed, never executed.
import { isAbsolute } from 'node:path';
import type { PluginHookConfig } from '../../plugins/types.ts';
import { isPlaceholder, isSecret, isSecretName, looksLikeToken } from './secrets.ts';

/** A lowercase name of letters, digits and `-` (`My Server_1` → `my-server-1`). */
export function slug(value: string, max = 64): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ---- skills and commands --------------------------------------------------------------------------

/** Give a SKILL.md another name (a collision on import): only its `name:` line changes. */
export function renameSkill(text: string, name: string): string {
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  const close = open ? /^---[ \t]*(?:\r?\n|$)/m.exec(text.slice(open[0].length)) : null;
  if (!open || !close) return `---\nname: ${name}\n---\n${text}`;
  const start = open[0].length;
  const head = text.slice(start, start + close.index);
  const next = /^name\s*:.*$/m.test(head)
    ? head.replace(/^name\s*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${head}`;
  return text.slice(0, start) + next + text.slice(start + close.index);
}

/**
 * A SKILL.md for a command file (docs/08 §3.1: commands become skills). Values are written as
 * JSON scalars and lists, which YAML reads as they are.
 */
export function renderSkill(
  fields: { name: string; description: string; whenToUse?: string | null; allowedTools?: string[] },
  body: string,
): string {
  const lines = [
    '---',
    `name: ${fields.name}`,
    `description: ${JSON.stringify(fields.description)}`,
  ];
  if (fields.whenToUse) lines.push(`when_to_use: ${JSON.stringify(fields.whenToUse)}`);
  if (fields.allowedTools?.length)
    lines.push(`allowed_tools: ${JSON.stringify([...new Set(fields.allowedTools)])}`);
  lines.push('---', '');
  return `${lines.join('\n')}${body.replace(/\r\n?/g, '\n').replace(/^\n+/, '')}`;
}

// ---- MCP server configs ---------------------------------------------------------------------------

/** `mcpServers` maps anywhere in the first levels of a JSON config (or `servers` in mcp.json). */
export function findMcpServers(json: unknown, fileName: string): [string, unknown][] {
  const out: [string, unknown][] = [];
  const visit = (v: unknown, depth: number) => {
    if (!isRecord(v) || depth > 4) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === 'mcpServers' && isRecord(child)) {
        for (const [name, entry] of Object.entries(child))
          if (isRecord(entry)) out.push([name, entry]);
      } else if (isRecord(child)) visit(child, depth + 1);
    }
  };
  visit(json, 0);
  if (!out.length && /^\.?mcp\.json$/i.test(fileName) && isRecord(json) && isRecord(json.servers)) {
    for (const [name, entry] of Object.entries(json.servers))
      if (isRecord(entry)) out.push([name, entry]);
  }
  return out;
}

export interface McpServerPlan {
  /** The name in the source config. */
  originalName: string;
  /** A valid Nova server name (`^[a-z0-9-]{1,40}$`). */
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  /**
   * Environment for stdio, headers for sse/http (the MCP area sends `X_Api_Key` as `X-Api-Key`).
   * Every value goes to the vault on apply; only `secret://` references reach the database.
   */
  env: Record<string, string>;
  /** Names in `env` whose values are secrets, with where each was found. */
  secrets: { name: string; where: string }[];
  /** Hosts the server talks to, proposed as its network permission. */
  hosts: string[];
  notes: string[];
  /** Why the entry cannot be imported, or null. */
  unsupported: string | null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FLAG = /^--?[A-Za-z][\w-]*$/;

function envName(raw: string): string {
  const n = raw.replace(/^-+/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return ENV_NAME.test(n) ? n : `_${n}`;
}

/** Turn one source entry into what Nova stores, moving secrets out of arguments and URLs. */
export function planMcpServer(originalName: string, entry: Record<string, unknown>): McpServerPlan {
  const plan: McpServerPlan = {
    originalName,
    name: slug(originalName, 40) || 'server',
    transport: 'stdio',
    command: null,
    args: [],
    url: null,
    env: {},
    secrets: [],
    hosts: [],
    notes: [],
    unsupported: null,
  };
  const put = (raw: string, value: string, where: string) => {
    let name = envName(raw);
    for (let n = 2; name in plan.env; n++) name = `${envName(raw)}_${n}`;
    // A reference to the other tool's environment (or vault) means nothing here: the name is
    // kept with an empty value for the user to fill in.
    const placeholder = isPlaceholder(value) && value.trim() !== '';
    plan.env[name] = placeholder ? '' : value;
    if (placeholder) plan.notes.push(`${name} refers to ${value.trim()}; enter its value in Nova`);
    else if (isSecret(raw, value)) plan.secrets.push({ name, where });
    return name;
  };
  const type = str(entry.type) ?? str(entry.transport);
  const command = str(entry.command);
  const url = str(entry.url) ?? str(entry.serverUrl) ?? str(entry.httpUrl);
  if (command) {
    plan.transport = 'stdio';
    plan.command = command;
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
    plan.args = moveArgSecrets(args, put, plan.notes);
    if (isRecord(entry.env))
      for (const [k, v] of Object.entries(entry.env))
        if (typeof v === 'string' || typeof v === 'number') put(k, String(v), `env ${k}`);
  } else if (url) {
    plan.transport = type === 'sse' || /\/sse\/?$/.test(url) ? 'sse' : 'http';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      plan.unsupported = 'the server URL is not valid';
      return plan;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      plan.unsupported = 'the server URL must use http or https';
      return plan;
    }
    if (parsed.password) {
      const n = put('URL_PASSWORD', decodeURIComponent(parsed.password), 'the URL credentials');
      plan.notes.push(`the URL password moved to ${n}`);
      parsed.password = '';
    }
    for (const [k, v] of [...parsed.searchParams.entries()]) {
      if (!isSecret(k, v)) continue;
      const n = put(k, v, `URL parameter ${k}`);
      parsed.searchParams.delete(k);
      plan.notes.push(
        `the URL parameter ${k} moved to the header ${n}; check the server accepts it`,
      );
    }
    plan.url = parsed.toString();
    plan.hosts.push(parsed.hostname);
    if (isRecord(entry.headers))
      for (const [k, v] of Object.entries(entry.headers))
        if (typeof v === 'string') put(k, v, `header ${k}`);
    if (isRecord(entry.env))
      for (const [k, v] of Object.entries(entry.env))
        if (typeof v === 'string') put(k, v, `env ${k}`);
  } else {
    plan.unsupported = 'neither a command nor a URL';
    return plan;
  }
  if (str(entry.cwd)) plan.notes.push('the working directory is not imported');
  if (command && !isAbsolute(command) && /[\\/]/.test(command))
    plan.notes.push('the command is a relative path; check that it resolves');
  return plan;
}

function moveArgSecrets(
  args: string[],
  put: (raw: string, value: string, where: string) => string,
  notes: string[],
): string[] {
  const out: string[] = [];
  let loose = 0;
  for (const a of args) {
    const eq = /^(--?[A-Za-z][\w-]*)=(.*)$/s.exec(a);
    if (eq && isSecret(eq[1]!, eq[2]!)) {
      const n = put(eq[1]!, eq[2]!, `argument ${eq[1]}`);
      notes.push(
        `the value of ${eq[1]} moved to the environment variable ${n}; check the server reads it`,
      );
      continue;
    }
    const prev = out.at(-1);
    if (prev && FLAG.test(prev) && isSecretName(prev) && !a.startsWith('-') && !isPlaceholder(a)) {
      out.pop();
      const n = put(prev, a, `argument ${prev}`);
      notes.push(
        `the value of ${prev} moved to the environment variable ${n}; check the server reads it`,
      );
      continue;
    }
    if (!FLAG.test(a) && looksLikeToken(a)) {
      const n = put(`IMPORTED_SECRET_${++loose}`, a, 'an argument');
      notes.push(
        `a secret argument moved to the environment variable ${n}; check the server reads it`,
      );
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---- memories -------------------------------------------------------------------------------------

/** Memory facts from JSON (an array, or `{memories: [...]}`) or one per line of text. */
export function readMemories(
  text: string,
  json: boolean,
): { content: string; category: string | null }[] | null {
  if (!json) {
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((content) => ({ content, category: null }));
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v.memories) ? v.memories : null;
  if (!list) return null;
  const out: { content: string; category: string | null }[] = [];
  for (const item of list as unknown[]) {
    if (typeof item === 'string' && item.trim()) out.push({ content: item.trim(), category: null });
    else if (isRecord(item)) {
      const content = str(item.content) ?? str(item.text) ?? str(item.memory) ?? str(item.value);
      if (content) out.push({ content, category: str(item.category)?.slice(0, 60) ?? null });
    }
  }
  return out;
}

// ---- projects ------------------------------------------------------------------------------------

export interface ProjectExport {
  key: string;
  name: string;
  instructions: string | null;
}

/** Projects from an export: an array (or `{projects: [...]}`) of `{name, instructions?}`. */
export function readProjects(json: unknown): ProjectExport[] {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.projects)
      ? json.projects
      : [];
  const out: ProjectExport[] = [];
  (list as unknown[]).forEach((p, i) => {
    if (!isRecord(p)) return;
    const name = str(p.name) ?? str(p.title);
    if (!name) return;
    out.push({
      key: str(p.uuid) ?? str(p.id) ?? String(i),
      name: name.slice(0, 200),
      instructions:
        str(p.instructions) ??
        str(p.prompt_template) ??
        str(p.custom_instructions) ??
        str(p.system_prompt),
    });
  });
  return out;
}

// ---- chat exports --------------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string | null;
}

export interface ChatExport {
  key: string;
  title: string | null;
  createdAt: string | null;
  messages: ChatMessage[];
}

const MAX_MESSAGES = 5_000;
const MAX_TEXT = 200_000;

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function role(v: unknown): ChatMessage['role'] | null {
  const r = typeof v === 'string' ? v.toLowerCase() : '';
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'ai' || r === 'model' || r === 'bot') return 'assistant';
  return null;
}

/** Text of a message's content: a string, a list of parts, or `{parts: [...]}`. */
function contentText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(contentText).filter(Boolean).join('\n\n');
  if (isRecord(v)) {
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.parts)) return contentText(v.parts);
    if (typeof v.content === 'string' || Array.isArray(v.content)) return contentText(v.content);
  }
  return '';
}

function message(m: unknown): ChatMessage | null {
  if (!isRecord(m)) return null;
  const author = isRecord(m.author) ? m.author.role : undefined;
  const r = role(m.role ?? m.sender ?? author);
  if (!r) return null;
  const text = contentText(m.content ?? m.text ?? m.parts).trim();
  if (!text) return null;
  return {
    role: r,
    text: text.slice(0, MAX_TEXT),
    createdAt: iso(m.created_at ?? m.create_time ?? m.timestamp ?? m.createdAt),
  };
}

/** Messages of a tree export: the path from the current node up to the root, oldest first. */
function treeMessages(mapping: Record<string, unknown>, current: unknown): ChatMessage[] {
  let id = typeof current === 'string' && current in mapping ? current : null;
  if (!id) {
    // No current node: follow the last child from the root.
    const root = Object.entries(mapping).find(([, n]) => isRecord(n) && !n.parent);
    id = root?.[0] ?? null;
    while (id) {
      const node = mapping[id];
      const kids: unknown[] = isRecord(node) && Array.isArray(node.children) ? node.children : [];
      const next = kids.at(-1);
      if (typeof next !== 'string' || !(next in mapping)) break;
      id = next;
    }
  }
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id) && out.length < MAX_MESSAGES) {
    seen.add(id);
    const node = mapping[id];
    if (!isRecord(node)) break;
    const m = message(node.message);
    if (m) out.push(m);
    id = typeof node.parent === 'string' ? node.parent : null;
  }
  return out.reverse();
}

function conversation(c: unknown, index: number): ChatExport | null {
  if (!isRecord(c)) return null;
  let messages: ChatMessage[];
  if (isRecord(c.mapping)) messages = treeMessages(c.mapping, c.current_node);
  else {
    const list = Array.isArray(c.messages)
      ? c.messages
      : Array.isArray(c.chat_messages)
        ? c.chat_messages
        : null;
    if (!list) return null;
    messages = (list as unknown[]).slice(0, MAX_MESSAGES).flatMap((m) => message(m) ?? []);
  }
  if (!messages.length) return null;
  return {
    key: str(c.uuid) ?? str(c.id) ?? str(c.conversation_id) ?? String(index),
    title: (str(c.title) ?? str(c.name))?.slice(0, 200) ?? null,
    createdAt: iso(c.created_at ?? c.create_time ?? c.createdAt) ?? messages[0]!.createdAt,
    messages,
  };
}

/** Conversations in a chat export, or null when the JSON is not one. */
export function readChats(json: unknown): ChatExport[] | null {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.conversations)
      ? json.conversations
      : isRecord(json) &&
          (isRecord(json.mapping) ||
            Array.isArray(json.messages) ||
            Array.isArray(json.chat_messages))
        ? [json]
        : null;
  if (!list) return null;
  const looks = (list as unknown[]).some(
    (c) =>
      isRecord(c) &&
      (isRecord(c.mapping) || Array.isArray(c.messages) || Array.isArray(c.chat_messages)),
  );
  if (!looks) return null;
  return (list as unknown[]).flatMap((c, i) => conversation(c, i) ?? []);
}

// ---- plugins -------------------------------------------------------------------------------------

export const NOVA_MANIFEST = '.nova-plugin/plugin.json';
const OTHER_MANIFEST_DIR = /^\.[a-z0-9][a-z0-9-]*-plugin$/;

/** Where a folder's plugin manifest is: Nova's layout, or another `.<name>-plugin/plugin.json`. */
export function manifestDir(dirNames: readonly string[]): string | null {
  if (dirNames.includes('.nova-plugin')) return '.nova-plugin';
  return dirNames.find((n) => OTHER_MANIFEST_DIR.test(n)) ?? null;
}

export interface PluginLayout {
  skills: string[];
  commands: string[];
  agents: string[];
  hasHooks: boolean;
  /** Hooks converted from the layout's hooks file (FR-200); they install untrusted. */
  hooks?: PluginHookConfig[];
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * A Nova manifest for a plugin in another layout (docs/08 §4.2: "a generated manifest beside the
 * original", written into Nova's own copy). Components come from the conventional folders; the
 * proposed permissions name only the hosts its MCP servers use. Its servers are added on apply,
 * once their secrets are in the vault.
 */
export function generateManifest(
  source: Record<string, unknown>,
  layout: PluginLayout,
  hosts: string[],
): Record<string, unknown> {
  const name = (str(source.name) ?? 'plugin').slice(0, 100);
  const version = str(source.version);
  const author = isRecord(source.author) ? str(source.author.name) : str(source.author);
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id: `imported.${slug(name, 60) || 'plugin'}`,
    name,
    version: version && SEMVER.test(version) ? version : '0.1.0',
    permissions: hosts.length ? { network: [...new Set(hosts)].sort() } : {},
  };
  const description = str(source.description);
  if (description) manifest.description = description.slice(0, 500);
  if (author) manifest.author = { name: author };
  if (layout.skills.length) manifest.skills = layout.skills;
  if (layout.commands.length) manifest.commands = layout.commands;
  if (layout.agents.length) manifest.agents = layout.agents;
  if (layout.hooks?.length) manifest.hooks = layout.hooks;
  return manifest;
}
