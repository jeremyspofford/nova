// The providers that ship with Nova (M5 plan §1). They are installed on every start and stay off
// until the person configures and turns them on (tier 2: enabling asks for an OK on the
// permissions). Each is an ordinary extension manifest with an `adapter` block.
import { OLLAMA_BASE } from './openai.ts';
import type { AdapterBlock, Implementation } from './types.ts';

const base = { version: '1.0.0', secrets: [] as string[], setup_flow: null, nova_compat: '>=0.1.0', on_remove: { delete: [], keep: [], export: [] } };

const runs = (program: string) => ({ kind: 'device', target: `this computer: runs ${program}`, why: 'to do the task in a folder made for it alone' });
const writes = { kind: 'data-write', target: 'workspace/tasks', why: 'it changes files in the task’s own folder; Nova copies them into your workspace only after checking them' };
const reads = { kind: 'data-read', target: 'the files a brief names', why: 'they are copied into the task’s folder for it to work on' };

export const BUILTINS: (Record<string, unknown> & { id: string; name: string; adapter: AdapterBlock })[] = [
  {
    ...base, id: 'claude-code', kind: 'agent-adapter', name: 'Claude Code',
    capabilities: ['code.edit', 'code.run'],
    permissions: [runs('claude'), reads, writes, { kind: 'network', target: 'Anthropic', why: 'Claude Code sends the brief and the files it reads to Anthropic’s models' }],
    config_schema: { type: 'object', properties: { command: { type: 'string' }, model: { type: 'string' }, permission_mode: { type: 'string' }, allowed_tools: { type: 'array' }, timeout_s: { type: 'number' } } },
    health_check: { kind: 'command', program: 'claude' },
    adapter: { implementation: 'claude-code', class: 'coding-agent', transport: 'cli', egress: 'remote:anthropic', capabilities: ['edit-files'], config: { command: 'claude', model: '', permission_mode: 'acceptEdits', timeout_s: 1800 }, secrets: [] },
  },
  {
    ...base, id: 'codex', kind: 'agent-adapter', name: 'Codex',
    capabilities: ['code.edit', 'code.run'],
    permissions: [runs('codex'), reads, writes, { kind: 'network', target: 'OpenAI', why: 'Codex sends the brief and the files it reads to OpenAI’s models' }],
    config_schema: { type: 'object', properties: { command: { type: 'string' }, model: { type: 'string' }, sandbox: { type: 'string' }, timeout_s: { type: 'number' } } },
    health_check: { kind: 'command', program: 'codex' },
    adapter: { implementation: 'codex', class: 'coding-agent', transport: 'cli', egress: 'remote:openai', capabilities: ['edit-files', 'run-commands'], config: { command: 'codex', model: '', sandbox: 'workspace-write', timeout_s: 1800 }, secrets: [] },
  },
  {
    ...base, id: 'openai-compatible', kind: 'agent-adapter', name: 'Local model (Ollama or compatible)',
    capabilities: ['chat', 'code.edit'],
    permissions: [reads, writes, { kind: 'network', target: 'the model server you set', why: 'to send it the brief and the files, and get its reply' }],
    config_schema: { type: 'object', properties: { base_url: { type: 'string' }, model: { type: 'string' }, api_key: { type: 'string' }, json_mode: { type: 'boolean' }, timeout_s: { type: 'number' } } },
    health_check: { kind: 'http', path: '/models' },
    adapter: { implementation: 'openai-compatible', class: 'chat', transport: 'http', egress: 'local', capabilities: ['chat', 'files-contract'], config: { base_url: OLLAMA_BASE, model: '', api_key: '', json_mode: true, timeout_s: 600 }, secrets: [] },
  },
  {
    ...base, id: 'custom-cli', kind: 'agent-adapter', name: 'Your model command',
    capabilities: ['chat', 'code.edit'],
    permissions: [runs('the model command (agent_cmd)'), reads, writes],
    config_schema: { type: 'object', properties: { command: { type: 'string' }, egress: { type: 'string' } } },
    health_check: { kind: 'command' },
    adapter: { implementation: 'custom-cli', class: 'chat', transport: 'cli', egress: 'remote:model', capabilities: ['chat', 'files-contract'], config: {}, secrets: [] },
  },
  {
    ...base, id: 'n8n', kind: 'automation-adapter', name: 'n8n', secrets: ['N8N_SIGNING_SECRET'],
    capabilities: ['automation.run'],
    permissions: [{ kind: 'network', target: 'the n8n workflow you set', why: 'to send it the brief, signed, and take its signed report back' }],
    config_schema: { type: 'object', properties: { webhook_url: { type: 'string' }, signing_secret: { type: 'string' }, callback_url: { type: 'string' }, timeout_s: { type: 'number' } } },
    health_check: { kind: 'http' },
    adapter: { implementation: 'n8n', class: 'automation', transport: 'http', egress: 'local', capabilities: ['webhook', 'callback'], config: { webhook_url: '', signing_secret: 'secret://N8N_SIGNING_SECRET', callback_url: '', timeout_s: 900 }, secrets: ['N8N_SIGNING_SECRET'] },
  },
];

export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((b) => b.id));

// What a person can set for each implementation, for the settings screen: plain labels, and
// which are read from Nova's own config file rather than set here.
export interface Field { key: string; label: string; kind: 'text' | 'secret' | 'boolean' | 'number'; note?: string; fixed?: boolean }
export const FIELDS: Record<Implementation, Field[]> = {
  'claude-code': [
    { key: 'command', label: 'Program', kind: 'text', note: 'claude, or its full path.' },
    { key: 'model', label: 'Model', kind: 'text', note: 'Empty for Claude Code’s default.' },
  ],
  codex: [
    { key: 'command', label: 'Program', kind: 'text', note: 'codex, or its full path.' },
    { key: 'model', label: 'Model', kind: 'text', note: 'Empty for Codex’s default.' },
  ],
  'openai-compatible': [
    { key: 'base_url', label: 'Server address', kind: 'text', note: 'Ollama on this computer is http://127.0.0.1:11434/v1.' },
    { key: 'model', label: 'Model', kind: 'text', note: 'A model the server has, like the one you pulled.' },
    { key: 'api_key', label: 'Key', kind: 'secret', note: 'Only if the server needs one: secret://NAME, kept in the vault.' },
  ],
  'custom-cli': [
    { key: 'command', label: 'Command', kind: 'text', note: 'agent_cmd in nova.config.json.', fixed: true },
    { key: 'egress', label: 'Where it sends', kind: 'text', note: 'agent_egress in nova.config.json.', fixed: true },
  ],
  n8n: [
    { key: 'webhook_url', label: 'Workflow webhook', kind: 'text', note: 'The address of the workflow’s Webhook node.' },
    { key: 'signing_secret', label: 'Signing secret', kind: 'secret', note: 'secret://NAME in the vault; the workflow signs with the same secret.' },
    { key: 'callback_url', label: 'Nova’s address for the workflow', kind: 'text', note: 'Optional: where the workflow reaches Nova.' },
  ],
};
