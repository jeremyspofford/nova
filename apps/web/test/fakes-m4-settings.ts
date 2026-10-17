// Test data for the M4 settings surfaces (plugins, skills, hooks, clients, bundles, profile,
// usage, import, project folders). The fake Hub behind them is test/fakes-m4.ts.
import type {
  AppAuthorizationView,
  BundlePreview,
  CatalogEntryView,
  HookView,
  ImportItemView,
  PluginPreview,
  PluginView,
  ProjectFolderView,
  SkillDetail,
} from '@nova/shared';

let n = 0;
const at = (s = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

export const HASH_A = `sha256:${'9f2c'.padEnd(60, '0')}41ab`;
export const HASH_B = `sha256:${'77aa'.padEnd(60, '1')}ee01`;

export function hook(over: Partial<HookView> = {}): HookView {
  return {
    id: `hook-${++n}`,
    source: 'project',
    pluginId: null,
    event: 'tool.pre',
    matcher: 'exec.run',
    handler: { type: 'command', command: ['./scripts/check-branch.sh'] },
    timeoutMs: 30_000,
    contentHash: HASH_A,
    status: 'needs_trust',
    enabled: true,
    lastRun: null,
    ...over,
  };
}

export function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    id: 'com.example.notes',
    name: 'Notes',
    version: '1.0.0',
    description: 'Keeps notes in a folder.',
    author: 'Example',
    source: 'catalog',
    origin: 'sample/com.example.notes',
    enabled: true,
    verified: true,
    permissions: { network: ['api.example.com'] },
    components: { skills: 2, commands: 0, agents: 0, hooks: 1, mcpServers: 1, uiEntryPoints: 0 },
    status: 'ok',
    error: null,
    installedAt: at(),
    updatedAt: at(),
    ...over,
  };
}

export function pluginPreview(over: Partial<PluginPreview> = {}): PluginPreview {
  return {
    previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    manifest: {
      schemaVersion: 1,
      id: 'com.example.tracker',
      name: 'Tracker',
      version: '2.0.0',
      description: 'Tracks issues.',
      author: { name: 'Example Labs' },
    },
    permissions: {
      network: ['api.tracker.example'],
      secrets: ['TRACKER_TOKEN'],
      tools: { 'tracker.create': { action: 'write', default: 'ask' } },
    },
    hooks: [
      hook({
        id: 'tracker-guard',
        source: 'plugin',
        pluginId: 'com.example.tracker',
        contentHash: HASH_A,
      }),
    ],
    mcpServers: [{ name: 'tracker', transport: 'stdio', command: 'node server.js', url: null }],
    skills: [{ name: 'triage', description: 'Sort new issues.' }],
    verified: true,
    warnings: [],
    replaces: null,
    ...over,
  };
}

export function catalogEntry(over: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    catalogId: 'sample',
    pluginId: 'com.example.tracker',
    name: 'Tracker',
    version: '2.0.0',
    description: 'Tracks issues.',
    verified: true,
    installedVersion: null,
    ...over,
  };
}

export function skill(over: Partial<SkillDetail> = {}): SkillDetail {
  const name = over.name ?? `skill-${++n}`;
  return {
    id: `skill:user:${name}`,
    name,
    description: 'Does a thing well.',
    whenToUse: null,
    allowedTools: [],
    modelHint: null,
    source: 'user',
    pluginId: null,
    projectId: null,
    enabled: true,
    shadowedBy: null,
    updatedAt: at(),
    body: '## Instructions\n1. Do it.',
    files: [],
    ...over,
  };
}

export function appAuth(over: Partial<AppAuthorizationView> = {}): AppAuthorizationView {
  return {
    id: `app-x${++n}`,
    kind: 'mcp_client',
    clientName: 'Laptop editor',
    scopes: { tools: '*', projects: '*', threads: 'read', mode: 'read_only' },
    expiresAt: '2027-01-01T00:00:00.000Z',
    lastUsedAt: null,
    createdAt: at(),
    ...over,
  };
}

export function bundlePreview(over: Partial<BundlePreview> = {}): BundlePreview {
  return {
    previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
    name: 'weather',
    displayName: 'Weather',
    version: '0.3.0',
    description: 'Forecasts by city.',
    author: 'Example',
    serverType: 'node',
    signature: 'unverified',
    permissions: { network: ['api.weather.example'], fs: 'none' },
    userConfig: [
      {
        key: 'api_key',
        type: 'string',
        title: 'API key',
        description: null,
        required: true,
        sensitive: true,
        multiple: false,
        default: undefined,
      },
      {
        key: 'units',
        type: 'string',
        title: 'Units',
        description: 'metric or imperial',
        required: false,
        sensitive: false,
        multiple: false,
        default: 'metric',
      },
      {
        key: 'days',
        type: 'number',
        title: 'Days',
        description: null,
        required: false,
        sensitive: false,
        multiple: false,
        default: 3,
      },
    ],
    tools: [{ name: 'forecast', description: 'Get a forecast.' }],
    warnings: [],
    ...over,
  };
}

export function importItem(over: Partial<ImportItemView> = {}): ImportItemView {
  return {
    id: `item-${++n}`,
    kind: 'skills',
    name: 'review-pr',
    sourcePath: '/home/me/.config/assistant/skills/review-pr',
    target: 'skill review-pr',
    sha256: `sha256:${'ab'.repeat(32)}`,
    status: 'new',
    maskedSecrets: [],
    note: null,
    ...over,
  };
}

export function folder(over: Partial<ProjectFolderView> = {}): ProjectFolderView {
  return {
    id: `fold-x${++n}`,
    projectId: 'p1',
    path: '/home/me/notes',
    access: 'read',
    status: 'ready',
    fileCount: 12,
    error: null,
    indexedAt: at(),
    ...over,
  };
}
