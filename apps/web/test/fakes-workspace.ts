// In-memory projects, sources, memory, presets, local-server detection and compute nodes for
// the fake Hub (test/fakes.ts). Split out so the workspace surfaces can grow their fakes here.
/* eslint-disable @typescript-eslint/require-await */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  parseAnyModelRef,
  type DetectedServer,
  type MemoryItemView,
  type NodeView,
  type Preset,
  type ProjectView,
  type SourceView,
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
  /** Lifetime of a new compute-node enrollment token (the Hub uses 15 min). */
  enrollTtlMs: number;
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
    enrollTtlMs: 15 * 60_000,
    ...init,
  };
}

let n = 0;
const at = (s = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

export function memoryItem(over: Partial<MemoryItemView> = {}): MemoryItemView {
  return {
    id: `mem-x${++n}`,
    scopeKind: 'global',
    scopeRef: null,
    content: 'Prefers short answers',
    category: null,
    pinned: false,
    confidence: 0.9,
    status: 'active',
    sourceKind: 'chat',
    sourceThreadId: null,
    sourceMessageId: null,
    createdAt: at(),
    updatedAt: at(n),
    ...over,
  };
}

export function project(over: Partial<ProjectView> = {}): ProjectView {
  return {
    id: `proj-x${++n}`,
    name: 'Garden plan',
    instructions: null,
    memoryScope: 'shared',
    threadCount: 0,
    sourceCount: 0,
    createdAt: at(),
    updatedAt: at(n),
    ...over,
  };
}

export function source(projectId: string, over: Partial<SourceView> = {}): SourceView {
  return {
    id: `src-x${++n}`,
    projectId,
    name: 'notes.md',
    mime: 'text/markdown',
    size: 2048,
    status: 'ready',
    chunkCount: 3,
    error: null,
    indexedAt: at(),
    createdAt: at(),
    ...over,
  };
}

export function computeNode(over: Partial<NodeView> = {}): NodeView {
  return {
    id: `node-x${++n}`,
    name: 'Desk GPU',
    status: 'active',
    endpoint: 'http://10.0.0.5:7341',
    models: ['qwen3:14b'],
    capabilities: { gpus: 1, vramBytes: 24 * 1024 ** 3, maxConcurrentJobs: 2 },
    load: { running: 1, queued: 0 },
    lastSeenAt: new Date().toISOString(),
    createdAt: at(),
    ...over,
  };
}

/**
 * Capture the app's polling timers of one period (`useInterval`) so a test can fire them on
 * demand. Other intervals, including Testing Library's own waitFor polling, run for real.
 * Restore with vi.restoreAllMocks() after the components have unmounted.
 */
export function captureIntervals(ms: number) {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const active = new Map<unknown, () => void>();
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    fn: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== ms) return realSet(fn, delay, ...rest);
    // A placeholder handle that never fires; the test fires `fn` itself.
    const handle = realSet(() => undefined, 2 ** 30);
    active.set(handle, fn);
    return handle;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(
    (handle?: Parameters<typeof clearInterval>[0]) => {
      active.delete(handle);
      realClear(handle);
    },
  );
  return {
    /** How many captured timers are running now. */
    count: () => active.size,
    /** Run every captured timer once, as if its period elapsed. */
    fire: () =>
      act(() => {
        for (const fn of [...active.values()]) fn();
      }),
  };
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

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
  const findMemory = (mid: string) => {
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
      ws.sources = ws.sources.filter((x) => x.projectId !== pid);
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
        size:
          body.kind === 'file'
            ? Math.floor((body.data.length * 3) / 4)
            : new TextEncoder().encode(body.text).length,
        status: 'pending',
        chunkCount: 0,
        error: null,
        indexedAt: null,
        createdAt: ts(),
      };
      ws.sources = [...ws.sources, s];
      ws.projects = ws.projects.map((p) =>
        p.id === pid ? { ...p, sourceCount: p.sourceCount + 1 } : p,
      );
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
      const s = ws.sources.find((x) => x.id === sid);
      if (!s) throw notFound();
      ws.sources = ws.sources.filter((x) => x.id !== sid);
      ws.projects = ws.projects.map((p) =>
        p.id === s.projectId ? { ...p, sourceCount: p.sourceCount - 1 } : p,
      );
      return { ok: true } as const;
    },
    listMemory: async (q = {}) => {
      maybeFail('listMemory');
      const status = q.status ?? 'active';
      return {
        items: ws.memory
          .filter(
            (m) =>
              m.status === status &&
              (!q.scopeKind || m.scopeKind === q.scopeKind) &&
              (!q.q || m.content.toLowerCase().includes(q.q.toLowerCase())),
          )
          .sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
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
        ...findMemory(mid),
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
      findMemory(mid);
      ws.memory = ws.memory.filter((m) => m.id !== mid);
      return { ok: true } as const;
    },
    importMemory: async (body) => {
      maybeFail('importMemory');
      // Mirrors the Hub: a JSON array of strings or {content, category?}, or one per line;
      // duplicates by normalized content are skipped.
      let entries: { content: string; category?: string }[];
      if (body.format === 'json') {
        const parsed = JSON.parse(body.data) as (string | { content: string; category?: string })[];
        entries = parsed.map((x) => (typeof x === 'string' ? { content: x } : x));
      } else {
        entries = body.data.split('\n').map((content) => ({ content }));
      }
      const seen = new Set(ws.memory.map((m) => normalize(m.content)));
      let imported = 0;
      let skipped = 0;
      for (const e of entries) {
        const key = normalize(e.content);
        if (!key) continue;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        imported++;
        ws.memory = [
          ...ws.memory,
          memoryItem({
            id: id('mem'),
            content: e.content.trim(),
            category: e.category ?? null,
            sourceKind: 'import',
            confidence: null,
            updatedAt: ts(),
          }),
        ];
      }
      return { imported, skipped };
    },
    listPresets: async () => {
      maybeFail('listPresets');
      return { items: ws.presets, builtIn: ws.presetsBuiltIn };
    },
    savePresets: async (items) => {
      maybeFail('savePresets');
      const bad = items.flatMap((p) => p.targets).find((t) => parseAnyModelRef(t) === null);
      if (bad)
        throw new ApiError(400, {
          code: 'validation',
          message: `Malformed model reference: ${bad}`,
          retryable: false,
        });
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
      return {
        token: 'nve_fake-enroll-token',
        expiresAt: new Date(Date.now() + ws.enrollTtlMs).toISOString(),
      };
    },
    revokeNode: async (nid) => {
      maybeFail('revokeNode');
      ws.nodes = ws.nodes.map((n) => (n.id === nid ? { ...n, status: 'revoked' as const } : n));
      return { ok: true } as const;
    },
  };
}
