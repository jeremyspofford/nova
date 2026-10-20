// In-memory M4 surfaces for the fake Hub (test/fakes.ts): plugins and catalogs, skills and slash
// commands, hooks, app authorizations, bundles and OAuth, MCP Apps entry points, files,
// terminals, the library, project folders, profile and usage, and import. Each web area extends
// the part it owns.
/* eslint-disable @typescript-eslint/require-await */
import type {
  AccountView,
  AppAuthorizationView,
  BundlePreview,
  CatalogEntryView,
  CatalogView,
  FileContentView,
  FileEntryView,
  HookView,
  ImportPreview,
  ImportRecordView,
  LibraryItemView,
  McpServerView,
  PluginPreview,
  PluginView,
  ProjectFolderView,
  ProviderAccountView,
  SkillDetail,
  SlashCommandView,
  TerminalView,
  UiEntryPointView,
  UsageSummary,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';

export interface M4State {
  plugins: PluginView[];
  pluginPreview: PluginPreview | null;
  /**
   * M8: the plugin would replace an extension signed by a publisher (the Hub's sentence): the
   * preview says it first, and the install needs `acceptPublisherChange: true` (400 `validation`
   * `{field: acceptPublisherChange, reason: publisher_change_confirmation_required}` otherwise).
   */
  pluginTakeover?: string | null;
  catalogs: CatalogView[];
  catalog: CatalogEntryView[];
  skills: SkillDetail[];
  slash: SlashCommandView[];
  hooks: HookView[];
  apps: AppAuthorizationView[];
  bundlePreview: BundlePreview | null;
  entryPoints: UiEntryPointView[];
  roots: { path: string; label: string; access: 'read' | 'write' }[];
  files: Map<string, FileEntryView[]>;
  contents: Map<string, FileContentView>;
  terminals: TerminalView[];
  library: LibraryItemView[];
  folders: ProjectFolderView[];
  account: AccountView;
  usage: UsageSummary;
  importPreview: ImportPreview | null;
  importRecords: ImportRecordView[];
  suggestions: Map<string, string[]>;
}

export function m4State(init: Partial<M4State> = {}): M4State {
  return {
    plugins: [],
    pluginPreview: null,
    catalogs: [],
    catalog: [],
    skills: [],
    slash: [],
    hooks: [],
    apps: [],
    bundlePreview: null,
    entryPoints: [],
    roots: [{ path: '/data/workspace', label: 'Workspace', access: 'write' }],
    files: new Map(),
    contents: new Map(),
    terminals: [],
    library: [],
    folders: [],
    account: {
      accountId: 'a1',
      displayName: 'Sam',
      username: null,
      hasAvatar: false,
      createdAt: '2026-10-01T12:00:00.000Z',
    },
    usage: {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0 },
      byModel: [],
      byProject: [],
      byDay: [],
      activeDays: 0,
      streak: 0,
      longestTurn: null,
    },
    importPreview: null,
    importRecords: [],
    suggestions: new Map(),
    ...init,
  };
}

type M4Api = Pick<
  Api,
  | 'listPlugins'
  | 'previewPlugin'
  | 'installPlugin'
  | 'updatePlugin'
  | 'uninstallPlugin'
  | 'listCatalogs'
  | 'searchCatalog'
  | 'listSkills'
  | 'getSkill'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'slashCommands'
  | 'listHooks'
  | 'updateHook'
  | 'deleteHook'
  | 'trustHook'
  | 'untrustHook'
  | 'listAppAuthorizations'
  | 'createAppAuthorization'
  | 'revokeAppAuthorization'
  | 'previewBundle'
  | 'installBundle'
  | 'startMcpOAuth'
  | 'revokeMcpOAuth'
  | 'uiEntryPoints'
  | 'uiResourceUrl'
  | 'setUiContext'
  | 'fileRoots'
  | 'listFiles'
  | 'readFile'
  | 'rawFileUrl'
  | 'saveFile'
  | 'createTerminal'
  | 'listTerminals'
  | 'closeTerminal'
  | 'terminalSocketUrl'
  | 'library'
  | 'listProjectFolders'
  | 'addProjectFolder'
  | 'reindexProjectFolder'
  | 'removeProjectFolder'
  | 'getAccount'
  | 'updateProfile'
  | 'avatarUrl'
  | 'usage'
  | 'setActiveProvider'
  | 'importPreview'
  | 'importApply'
  | 'importRecords'
  | 'suggestions'
>;

export function m4Impl(
  st: M4State,
  helpers: {
    id: (prefix: string) => string;
    ts: () => string;
    maybeFail: (n: keyof Api) => void;
    providers: () => ProviderAccountView[];
    setProviders: (p: ProviderAccountView[]) => void;
    mcpServers: () => McpServerView[];
  },
): M4Api {
  const { id, ts, maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const key = (root: string, path: string) => `${root}::${path}`;
  return {
    listPlugins: async () => {
      maybeFail('listPlugins');
      return { items: st.plugins };
    },
    previewPlugin: async () => {
      maybeFail('previewPlugin');
      if (!st.pluginPreview) throw notFound();
      return st.pluginTakeover
        ? { ...st.pluginPreview, warnings: [st.pluginTakeover, ...st.pluginPreview.warnings] }
        : st.pluginPreview;
    },
    installPlugin: async (body) => {
      maybeFail('installPlugin');
      const p = st.pluginPreview;
      if (!p || p.previewId !== body.previewId) throw notFound();
      if (st.pluginTakeover && body.acceptPublisherChange !== true)
        throw new ApiError(400, {
          code: 'validation',
          message: st.pluginTakeover,
          retryable: false,
          details: {
            field: 'acceptPublisherChange',
            reason: 'publisher_change_confirmation_required',
          },
        });
      const m = p.manifest as {
        id?: string;
        name?: string;
        version?: string;
        description?: string;
      };
      const view: PluginView = {
        id: m.id ?? 'plugin',
        name: m.name ?? 'Plugin',
        version: m.version ?? '1.0.0',
        description: m.description ?? null,
        author: null,
        source: 'local',
        origin: '/plugins/sample',
        enabled: body.enable ?? true,
        verified: p.verified,
        permissions: p.permissions,
        components: {
          skills: p.skills.length,
          commands: 0,
          agents: 0,
          hooks: p.hooks.length,
          mcpServers: p.mcpServers.length,
          uiEntryPoints: 0,
        },
        status: p.hooks.length && !body.trustHooks?.length ? 'needs_trust' : 'ok',
        error: null,
        installedAt: ts(),
        updatedAt: ts(),
      };
      st.plugins = [...st.plugins.filter((x) => x.id !== view.id), view];
      return view;
    },
    updatePlugin: async (pid, body) => {
      maybeFail('updatePlugin');
      const p = st.plugins.find((x) => x.id === pid);
      if (!p) throw notFound();
      const next = {
        ...p,
        enabled: body.enabled,
        status: body.enabled ? p.status : 'disabled',
      };
      st.plugins = st.plugins.map((x) => (x.id === pid ? next : x));
      return next;
    },
    uninstallPlugin: async (pid) => {
      maybeFail('uninstallPlugin');
      st.plugins = st.plugins.filter((x) => x.id !== pid);
      return { ok: true } as const;
    },
    listCatalogs: async () => {
      maybeFail('listCatalogs');
      return { items: st.catalogs };
    },
    searchCatalog: async (q = '') => {
      maybeFail('searchCatalog');
      const n = q.toLowerCase();
      return { items: st.catalog.filter((e) => e.name.toLowerCase().includes(n)) };
    },
    listSkills: async () => {
      maybeFail('listSkills');
      return { items: st.skills.map(({ body: _b, files: _f, ...v }) => v) };
    },
    getSkill: async (sid) => {
      maybeFail('getSkill');
      const s = st.skills.find((x) => x.id === sid);
      if (!s) throw notFound();
      return s;
    },
    createSkill: async (body) => {
      maybeFail('createSkill');
      const s: SkillDetail = {
        id: `skill:user:${body.name}`,
        name: body.name,
        description: body.description,
        whenToUse: body.whenToUse ?? null,
        allowedTools: body.allowedTools ?? [],
        modelHint: null,
        source: body.projectId ? 'project' : 'user',
        pluginId: null,
        projectId: body.projectId ?? null,
        enabled: true,
        shadowedBy: null,
        updatedAt: ts(),
        body: body.body,
        files: [],
      };
      st.skills = [...st.skills, s];
      const { body: _b, files: _f, ...view } = s;
      return view;
    },
    updateSkill: async (sid, body) => {
      maybeFail('updateSkill');
      const s = st.skills.find((x) => x.id === sid);
      if (!s) throw notFound();
      const next = { ...s, enabled: body.enabled };
      st.skills = st.skills.map((x) => (x.id === sid ? next : x));
      const { body: _b, files: _f, ...view } = next;
      return view;
    },
    deleteSkill: async (sid) => {
      maybeFail('deleteSkill');
      st.skills = st.skills.filter((x) => x.id !== sid);
      return { ok: true } as const;
    },
    slashCommands: async () => {
      maybeFail('slashCommands');
      return { items: st.slash };
    },
    listHooks: async () => {
      maybeFail('listHooks');
      return { items: st.hooks };
    },
    updateHook: async (hid, body) => {
      maybeFail('updateHook');
      const h = st.hooks.find((x) => x.id === hid);
      if (!h) throw notFound();
      const next = { ...h, enabled: body.enabled };
      st.hooks = st.hooks.map((x) => (x.id === hid ? next : x));
      return next;
    },
    deleteHook: async (hid) => {
      maybeFail('deleteHook');
      st.hooks = st.hooks.filter((x) => x.id !== hid);
      return { ok: true } as const;
    },
    trustHook: async (hid, contentHash) => {
      maybeFail('trustHook');
      const h = st.hooks.find((x) => x.id === hid);
      if (!h) throw notFound();
      if (h.contentHash !== contentHash)
        throw new ApiError(409, {
          code: 'conflict',
          message: 'The hook changed',
          retryable: false,
        });
      const next: HookView = { ...h, status: 'trusted' };
      st.hooks = st.hooks.map((x) => (x.id === hid ? next : x));
      return next;
    },
    untrustHook: async (hid) => {
      maybeFail('untrustHook');
      const h = st.hooks.find((x) => x.id === hid);
      if (!h) throw notFound();
      const next: HookView = { ...h, status: 'revoked' };
      st.hooks = st.hooks.map((x) => (x.id === hid ? next : x));
      return next;
    },
    listAppAuthorizations: async () => {
      maybeFail('listAppAuthorizations');
      return { items: st.apps };
    },
    createAppAuthorization: async (body) => {
      maybeFail('createAppAuthorization');
      const a: AppAuthorizationView = {
        id: id('app'),
        kind: 'mcp_client',
        clientName: body.clientName,
        scopes: body.scopes,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: ts(),
      };
      st.apps = [...st.apps, a];
      return {
        authorization: a,
        token: 'nva_fake-client-token',
        endpoint: 'http://127.0.0.1:7419/mcp',
      };
    },
    revokeAppAuthorization: async (aid) => {
      maybeFail('revokeAppAuthorization');
      st.apps = st.apps.filter((x) => x.id !== aid);
      return { ok: true } as const;
    },
    previewBundle: async () => {
      maybeFail('previewBundle');
      if (!st.bundlePreview) throw notFound();
      return st.bundlePreview;
    },
    installBundle: async (body) => {
      maybeFail('installBundle');
      const p = st.bundlePreview;
      if (!p || p.previewId !== body.previewId) throw notFound();
      if (p.signature === 'unverified' && !body.confirmSideload)
        throw new ApiError(400, {
          code: 'validation',
          message: 'Confirm installing an unverified bundle',
          retryable: false,
        });
      const s = helpers.mcpServers()[0];
      if (!s) throw notFound();
      return { ...s, bundle: { name: p.name, version: p.version, signature: p.signature } };
    },
    startMcpOAuth: async () => {
      maybeFail('startMcpOAuth');
      return { authorizeUrl: 'https://auth.example.com/authorize?state=x' };
    },
    revokeMcpOAuth: async (sid) => {
      maybeFail('revokeMcpOAuth');
      const s = helpers.mcpServers().find((x) => x.id === sid);
      if (!s) throw notFound();
      return { ...s, auth: { kind: 'oauth', status: 'needs_auth', expiresAt: null, scopes: [] } };
    },
    uiEntryPoints: async (kind) => {
      maybeFail('uiEntryPoints');
      return { items: st.entryPoints.filter((e) => !kind || e.kind === kind) };
    },
    uiResourceUrl: (entryId) => `/api/v1/ui/resource?entry=${entryId}`,
    setUiContext: async () => {
      maybeFail('setUiContext');
      return { ok: true } as const;
    },
    fileRoots: async () => {
      maybeFail('fileRoots');
      return { items: st.roots };
    },
    listFiles: async (root, path = '') => {
      maybeFail('listFiles');
      return { items: st.files.get(key(root, path)) ?? [] };
    },
    readFile: async (root, path) => {
      maybeFail('readFile');
      const c = st.contents.get(key(root, path));
      if (!c) throw notFound();
      return c;
    },
    rawFileUrl: (root, path) =>
      `/api/v1/files/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    saveFile: async (body) => {
      maybeFail('saveFile');
      const cur = st.contents.get(key(body.root, body.path));
      if (cur && body.baseSha256 !== cur.sha256)
        throw new ApiError(409, {
          code: 'conflict',
          message: 'The file changed',
          retryable: false,
        });
      const next: FileContentView = {
        root: body.root,
        path: body.path,
        mime: cur?.mime ?? 'text/plain',
        size: body.text.length,
        text: body.text,
        sha256: `sha-${body.text.length}-${Date.now()}`,
        readOnly: false,
      };
      st.contents.set(key(body.root, body.path), next);
      return next;
    },
    createTerminal: async () => {
      maybeFail('createTerminal');
      const t: TerminalView = {
        id: id('term'),
        threadId: null,
        cwd: '/data/workspace',
        status: 'running',
        exitCode: null,
        createdAt: ts(),
      };
      st.terminals = [...st.terminals, t];
      return t;
    },
    listTerminals: async () => {
      maybeFail('listTerminals');
      return { items: st.terminals };
    },
    closeTerminal: async (tid) => {
      maybeFail('closeTerminal');
      st.terminals = st.terminals.filter((t) => t.id !== tid);
      return { ok: true } as const;
    },
    terminalSocketUrl: (tid) => `/api/v1/terminals/${tid}/ws`,
    library: async (q = {}) => {
      maybeFail('library');
      const n = (q.q ?? '').toLowerCase();
      const all = st.library.filter(
        (i) => (!q.kind || i.kind === q.kind) && (!n || i.title.toLowerCase().includes(n)),
      );
      // The cursor is the offset of the next page (the Hub's is opaque).
      const start = q.cursor ? Number(q.cursor) : 0;
      const end = start + (q.limit ?? 50);
      return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
    },
    listProjectFolders: async (pid) => {
      maybeFail('listProjectFolders');
      return { items: st.folders.filter((f) => f.projectId === pid) };
    },
    addProjectFolder: async (pid, body) => {
      maybeFail('addProjectFolder');
      const f: ProjectFolderView = {
        id: id('fold'),
        projectId: pid,
        path: body.path,
        access: body.access ?? 'read',
        status: 'indexing',
        fileCount: 0,
        error: null,
        indexedAt: null,
      };
      st.folders = [...st.folders, f];
      return f;
    },
    reindexProjectFolder: async (_pid, fid) => {
      maybeFail('reindexProjectFolder');
      const f = st.folders.find((x) => x.id === fid);
      if (!f) throw notFound();
      const next: ProjectFolderView = { ...f, status: 'indexing' };
      st.folders = st.folders.map((x) => (x.id === fid ? next : x));
      return next;
    },
    removeProjectFolder: async (_pid, fid) => {
      maybeFail('removeProjectFolder');
      st.folders = st.folders.filter((f) => f.id !== fid);
      return { ok: true } as const;
    },
    getAccount: async () => {
      maybeFail('getAccount');
      return st.account;
    },
    updateProfile: async (body) => {
      maybeFail('updateProfile');
      st.account = {
        ...st.account,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.username !== undefined ? { username: body.username } : {}),
        ...(body.avatar !== undefined ? { hasAvatar: body.avatar !== null } : {}),
      };
      return st.account;
    },
    avatarUrl: () => '/api/v1/account/avatar',
    usage: async () => {
      maybeFail('usage');
      return st.usage;
    },
    setActiveProvider: async (pid) => {
      maybeFail('setActiveProvider');
      const all = helpers.providers();
      const target = all.find((p) => p.id === pid);
      if (!target) throw notFound();
      const next = all.map((p) =>
        p.provider === target.provider ? { ...p, active: p.id === pid } : p,
      );
      helpers.setProviders(next);
      return next.find((p) => p.id === pid)!;
    },
    importPreview: async () => {
      maybeFail('importPreview');
      if (!st.importPreview) throw notFound();
      return st.importPreview;
    },
    importApply: async (previewId, items) => {
      maybeFail('importApply');
      const p = st.importPreview;
      if (!p || p.previewId !== previewId) throw notFound();
      // Records what the Hub's import ledger keeps per item (FR-200).
      const chosen = p.items.filter((i) => items.includes(i.id) && i.status !== 'duplicate');
      st.importRecords = [
        ...st.importRecords,
        ...chosen.map((i) => ({
          id: id('rec'),
          kind: i.kind,
          sourcePath: i.sourcePath,
          sha256: i.sha256,
          target: i.target,
          createdAt: ts(),
        })),
      ];
      return {
        importId: id('imp'),
        imported: chosen.length,
        duplicates: items.length - chosen.length,
        disabled: chosen.filter((i) => i.kind === 'plugins' || i.kind === 'mcp_servers').length,
        secretsMigrated: chosen.reduce((n, i) => n + i.maskedSecrets.length, 0),
      };
    },
    importRecords: async () => {
      maybeFail('importRecords');
      return { items: st.importRecords };
    },
    suggestions: async (tid) => {
      maybeFail('suggestions');
      return { items: st.suggestions.get(tid) ?? [] };
    },
  };
}
