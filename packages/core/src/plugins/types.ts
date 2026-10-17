// Shapes shared by the plugin installer, the skill index and the Hub's plugins area (FR-045,
// FR-046; contracts/schemas/plugin-manifest.json, hook-config.json, mcp-config.json).

export type PluginApprovalDefault = 'allow' | 'ask' | 'deny';
export type PluginActionClass = 'read' | 'write' | 'send' | 'delete' | 'execute';

/** contracts/schemas/mcp-config.json#/$defs/server. */
export interface PluginMcpServerConfig {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  oauth?: { clientMetadataUrl?: string; dynamicRegistration?: boolean; scopes?: string[] };
  deviceId?: string;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  required?: boolean;
  defaultApproval?: PluginApprovalDefault;
  deferred?: boolean;
  policy?: { network?: string[]; fs?: 'none' | 'read' | 'project' };
  enabled?: boolean;
}

/** contracts/schemas/hook-config.json#/$defs/hook. */
export interface PluginHookConfig {
  id: string;
  event: string;
  matcher?: string | string[];
  handler:
    | {
        type: 'command';
        command: string[];
        windowsCommand?: string[];
        network?: string[];
        timeoutMs?: number;
      }
    | { type: 'mcp_tool'; tool: string; arguments?: Record<string, unknown>; timeoutMs?: number };
  failClosed?: boolean;
  statusMessage?: string;
  enabled?: boolean;
}

export interface PluginManifestPermissions {
  network?: string[];
  fs?: string[];
  secrets?: string[];
  tools?: Record<string, { action: PluginActionClass; default?: PluginApprovalDefault }>;
  actionDefaults?: Partial<Record<PluginActionClass, PluginApprovalDefault>>;
  hooks?: { answersAsks?: boolean };
  browserExtensions?: string[];
  ui?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] };
}

export interface PluginUiEntryPoint {
  kind: 'global' | 'thread' | 'file';
  resource: string;
  title?: string;
  extensions?: string[];
}

/** A validated .nova-plugin/plugin.json. */
export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name?: string; url?: string };
  license?: string;
  homepage?: string;
  engines?: { nova?: string };
  permissions: PluginManifestPermissions;
  skills?: string[];
  commands?: string[];
  agents?: string[];
  hooks?: string | PluginHookConfig[];
  mcpServers?: Record<string, PluginMcpServerConfig>;
  browserExtensions?: { id: string; path: string; browsers?: string[]; hosts?: string[] }[];
  ui?: { entryPoints?: PluginUiEntryPoint[] };
}

/** A skill a plugin brings: a skill folder, or a command converted at install. */
export interface PluginSkillEntry {
  name: string;
  description: string;
  kind: 'skill' | 'command';
  /** The folder holding SKILL.md, relative to the installed plugin folder. */
  path: string;
}

/** What an install registered (plugin_install.registrations_json). */
export interface PluginRegistrations {
  /** MCP server ids by manifest key. */
  servers: Record<string, string>;
  skills: PluginSkillEntry[];
  /** Role keys `<pluginId>:<name>`. */
  roles: string[];
  hooks: { id: string; contentHash: string }[];
  /** Hooks the user trusted on the install screen, by hash (status until the hooks area answers). */
  trustedHooks: { id: string; contentHash: string }[];
  uiEntryPoints: number;
  /** The digest of the files the preview showed. */
  digest: string;
}
