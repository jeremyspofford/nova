// In-memory projects, sources, memory, presets, local-server detection and compute nodes for
// the fake Hub (test/fakes.ts). Split out so the workspace surfaces can grow their fakes here.
/* eslint-disable @typescript-eslint/require-await */
import type {
  DetectedServer,
  MemoryItemView,
  NodeView,
  Preset,
  ProjectView,
  SourceView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';

export interface WorkspaceState {
  projects: ProjectView[];
  sources: SourceView[];
  memory: MemoryItemView[];
  presets: Preset[];
  presetsBuiltIn: boolean;
  detected: DetectedServer[];
  nodes: NodeView[];
}

export const BUILT_IN_PRESETS: Preset[] = [
  { id: 'faster', label: 'Faster', strategy: 'single', targets: ['pa1/mock-fast'], rank: 1 },
  { id: 'balanced', label: 'Balanced', strategy: 'single', targets: ['pa1/mock-fast'], rank: 2 },
  {
    id: 'smarter',
    label: 'Smarter',
    strategy: 'single',
    targets: ['pa1/mock-smart'],
    reasoningLevel: 'high',
    rank: 3,
  },
];

export function workspaceState(init: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    projects: [],
    sources: [],
    memory: [],
    presets: BUILT_IN_PRESETS,
    presetsBuiltIn: true,
    detected: [],
    nodes: [],
    ...init,
  };
}

type WorkspaceApi = Pick<
  Api,
  | 'listProjects'
  | 'createProject'
  | 'getProject'
  | 'updateProject'
  | 'deleteProject'
  | 'listSources'
  | 'addSource'
  | 'reindexSource'
  | 'deleteSource'
  | 'listMemory'
  | 'createMemory'
  | 'updateMemory'
  | 'deleteMemory'
  | 'importMemory'
  | 'listPresets'
  | 'savePresets'
  | 'detectServers'
  | 'listNodes'
  | 'createNodeEnrollToken'
  | 'revokeNode'
>;

export function workspaceImpl(
  ws: WorkspaceState,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): WorkspaceApi {
  const { id, ts, maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const project = (pid: string) => {
    const p = ws.projects.find((x) => x.id === pid);
    if (!p) throw notFound();
    return p;
  };
  const memoryItem = (mid: string) => {
    const m = ws.memory.find((x) => x.id === mid);
    if (!m) throw notFound();
    return m;
  };
  return {
    listProjects: async () => {
      maybeFail('listProjects');
      return { items: ws.projects };
    },
    createProject: async (body) => {
      maybeFail('createProject');
      const p: ProjectView = {
        id: id('p'),
        name: body.name,
        instructions: body.instructions ?? null,
        memoryScope: body.memoryScope ?? 'shared',
        threadCount: 0,
        sourceCount: 0,
        createdAt: ts(),
        updatedAt: ts(),
      };
      ws.projects = [...ws.projects, p];
      return p;
    },
    getProject: async (pid) => {
      maybeFail('getProject');
      return project(pid);
    },
    updateProject: async (pid, body) => {
      maybeFail('updateProject');
      const next: ProjectView = {
        ...project(pid),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        updatedAt: ts(),
      };
      ws.projects = ws.projects.map((p) => (p.id === pid ? next : p));
      return next;
    },
    deleteProject: async (pid) => {
      maybeFail('deleteProject');
      project(pid);
      ws.projects = ws.projects.filter((p) => p.id !== pid);
      return { ok: true } as const;
    },
    listSources: async (pid) => {
      maybeFail('listSources');
      return { items: ws.sources.filter((s) => s.projectId === pid) };
    },
    addSource: async (pid, body) => {
      maybeFail('addSource');
      project(pid);
      const s: SourceView = {
        id: id('src'),
        projectId: pid,
        name: body.name,
        mime: body.kind === 'file' ? body.mime : 'text/plain',
        size: body.kind === 'file' ? body.data.length : body.text.length,
        status: 'pending',
        chunkCount: 0,
        error: null,
        indexedAt: null,
        createdAt: ts(),
      };
      ws.sources = [...ws.sources, s];
      return s;
    },
    reindexSource: async (sid) => {
      maybeFail('reindexSource');
      const s = ws.sources.find((x) => x.id === sid);
      if (!s) throw notFound();
      const next: SourceView = { ...s, status: 'pending', error: null };
      ws.sources = ws.sources.map((x) => (x.id === sid ? next : x));
      return next;
    },
    deleteSource: async (sid) => {
      maybeFail('deleteSource');
      ws.sources = ws.sources.filter((x) => x.id !== sid);
      return { ok: true } as const;
    },
    listMemory: async (q = {}) => {
      maybeFail('listMemory');
      return {
        items: ws.memory.filter(
          (m) =>
            (!q.status || m.status === q.status) &&
            (!q.scopeKind || m.scopeKind === q.scopeKind) &&
            (!q.q || m.content.toLowerCase().includes(q.q.toLowerCase())),
        ),
      };
    },
    createMemory: async (body) => {
      maybeFail('createMemory');
      const m: MemoryItemView = {
        id: id('mem'),
        scopeKind: body.scopeKind ?? 'global',
        scopeRef: body.scopeRef ?? null,
        content: body.content,
        category: body.category ?? null,
        pinned: body.pinned ?? false,
        confidence: null,
        status: 'active',
        sourceKind: 'manual',
        sourceThreadId: null,
        sourceMessageId: null,
        createdAt: ts(),
        updatedAt: ts(),
      };
      ws.memory = [...ws.memory, m];
      return m;
    },
    updateMemory: async (mid, body) => {
      maybeFail('updateMemory');
      const next: MemoryItemView = {
        ...memoryItem(mid),
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        updatedAt: ts(),
      };
      ws.memory = ws.memory.map((m) => (m.id === mid ? next : m));
      return next;
    },
    deleteMemory: async (mid) => {
      maybeFail('deleteMemory');
      memoryItem(mid);
      ws.memory = ws.memory.filter((m) => m.id !== mid);
      return { ok: true } as const;
    },
    importMemory: async (body) => {
      maybeFail('importMemory');
      const lines = body.data
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return { imported: lines.length, skipped: 0 };
    },
    listPresets: async () => {
      maybeFail('listPresets');
      return { items: ws.presets, builtIn: ws.presetsBuiltIn };
    },
    savePresets: async (items) => {
      maybeFail('savePresets');
      ws.presets = items.length ? items : BUILT_IN_PRESETS;
      ws.presetsBuiltIn = items.length === 0;
      return { items: ws.presets, builtIn: ws.presetsBuiltIn };
    },
    detectServers: async () => {
      maybeFail('detectServers');
      return { items: ws.detected };
    },
    listNodes: async () => {
      maybeFail('listNodes');
      return { items: ws.nodes };
    },
    createNodeEnrollToken: async () => {
      maybeFail('createNodeEnrollToken');
      return { token: 'nve_fake-enroll-token', expiresAt: ts() };
    },
    revokeNode: async (nid) => {
      maybeFail('revokeNode');
      ws.nodes = ws.nodes.map((n) => (n.id === nid ? { ...n, status: 'revoked' as const } : n));
      return { ok: true } as const;
    },
  };
}
