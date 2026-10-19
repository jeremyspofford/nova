// Reads while the Hub is unreachable (FR-112, FR-129, docs/21 §9). With an offline copy, chats,
// their messages, projects, spaces and pages are built from it (src/replica/views.ts). Without
// one, only what this page already loaded is shown again, read-only, and nothing is kept on the
// device. The app's start (hello, session, settings) and a few lists the views need (models,
// presets, spaces) are also kept sealed with the copy, so a device with one can start offline.
import type {
  PageSummaryView,
  ProjectView,
  QueuedInputView,
  SpaceView,
  ThreadDetail,
  ThreadView,
} from '@nova/shared';
import type { HubRequest } from '../api.ts';
import {
  pageList,
  pageView,
  pendingQueue,
  projectList,
  projectView,
  spaceList,
  spaceView,
  threadDetail,
  threadList,
  type ThreadQuery,
  type ViewHints,
  type ViewSource,
} from '../replica/views.ts';

export const V1 = '/api/v1';
export const SESSION_PATH = `${V1}/session`;

/** Answers kept with the offline copy so the app can start without the Hub. */
export const BOOT_PATHS: readonly string[] = [
  `${V1}/hello`,
  SESSION_PATH,
  `${V1}/settings`,
  `${V1}/account`,
  `${V1}/models`,
  `${V1}/presets`,
  `${V1}/spaces`,
];

/** Reads answered again when the Hub does not answer (from the copy, or this page's memory). */
const READ_PREFIXES = ['threads', 'projects', 'spaces'];

const MAX_MEMORY = 400;

/** The path's segments after /api/v1 and its query, or null for another path. */
export function splitPath(path: string): { parts: string[]; query: URLSearchParams } | null {
  const q = path.indexOf('?');
  const base = q < 0 ? path : path.slice(0, q);
  if (!base.startsWith(`${V1}/`)) return null;
  const parts = base
    .slice(V1.length + 1)
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  return { parts, query: new URLSearchParams(q < 0 ? '' : path.slice(q + 1)) };
}

function threadQuery(query: URLSearchParams): ThreadQuery {
  const get = (k: string) => query.get(k) ?? undefined;
  const out: ThreadQuery = {};
  const mode = get('mode');
  const archived = get('archived');
  const projectId = get('projectId');
  const q = get('q');
  const cursor = get('cursor');
  const limit = get('limit');
  if (mode) out.mode = mode;
  if (archived !== undefined) out.archived = archived === 'true';
  if (projectId) out.projectId = projectId;
  if (q) out.q = q;
  if (cursor) out.cursor = cursor;
  if (limit) out.limit = Number(limit);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const itemsOf = (v: unknown): unknown[] =>
  isObj(v) && Array.isArray(v.items) ? (v.items as unknown[]) : [];

/** What this page loaded from the Hub, by path, with the views in it indexed by id. */
export class ReadCache {
  readonly #answers = new Map<string, unknown>();
  readonly #threads = new Map<string, ThreadView>();
  readonly #projects = new Map<string, ProjectView>();
  readonly #spaces = new Map<string, SpaceView>();
  #spaceList: SpaceView[] = [];
  readonly #pages = new Map<string, PageSummaryView>();
  readonly #queues = new Map<string, QueuedInputView[]>();

  remember(path: string, data: unknown): void {
    this.#answers.delete(path);
    this.#answers.set(path, data);
    if (this.#answers.size > MAX_MEMORY) {
      const oldest = this.#answers.keys().next().value;
      if (oldest !== undefined) this.#answers.delete(oldest);
    }
    this.#index(path, data);
  }

  get(path: string): unknown {
    return this.#answers.get(path);
  }

  has(path: string): boolean {
    return this.#answers.has(path);
  }

  clear(): void {
    this.#answers.clear();
    this.#threads.clear();
    this.#projects.clear();
    this.#spaces.clear();
    this.#spaceList = [];
    this.#pages.clear();
    this.#queues.clear();
  }

  hints(): ViewHints {
    return {
      thread: (id) => this.#threads.get(id) ?? null,
      project: (id) => this.#projects.get(id) ?? null,
      space: (id) => this.#spaces.get(id) ?? null,
      spaces: () => this.#spaceList,
      page: (id) => this.#pages.get(id) ?? null,
      queue: (threadId) => this.#queues.get(threadId) ?? [],
    };
  }

  #index(path: string, data: unknown): void {
    const s = splitPath(path);
    if (!s || !isObj(data)) return;
    const [head, id, sub, subId] = s.parts;
    const keep = <T extends { id: string }>(map: Map<string, T>, v: unknown) => {
      if (isObj(v) && typeof v.id === 'string') map.set(v.id, v as unknown as T);
    };
    if (head === 'threads') {
      if (!id) for (const t of itemsOf(data)) keep(this.#threads, t);
      else if (!sub) {
        keep(this.#threads, (data as Partial<ThreadDetail>).thread);
        const q = (data as Partial<ThreadDetail>).queue;
        if (Array.isArray(q)) this.#queues.set(id, q);
      } else if (sub === 'queue') this.#queues.set(id, itemsOf(data) as QueuedInputView[]);
    } else if (head === 'projects') {
      if (!id) for (const p of itemsOf(data)) keep(this.#projects, p);
      else if (!sub) keep(this.#projects, data);
    } else if (head === 'spaces') {
      if (!id) {
        this.#spaceList = itemsOf(data).filter(
          (v): v is SpaceView => isObj(v) && typeof v.id === 'string',
        );
        for (const v of this.#spaceList) this.#spaces.set(v.id, v);
      } else if (!sub) keep(this.#spaces, data);
      else if (sub === 'pages' && !subId) for (const p of itemsOf(data)) keep(this.#pages, p);
      else if (sub === 'pages' && subId && s.parts.length === 4) keep(this.#pages, data);
    }
  }
}

/**
 * The answer to a read while the Hub is unreachable, or undefined when this device has none.
 * `source` is the offline copy (null without one: then only this page's memory answers).
 */
export function answerRead(req: HubRequest, cache: ReadCache, source: ViewSource | null): unknown {
  const s = splitPath(req.path);
  if (!s) return undefined;
  const fromMemory = () => cache.get(req.path);
  const base = req.path.split('?')[0] ?? req.path;
  if (BOOT_PATHS.includes(base) && !(base === `${V1}/spaces` && source)) return fromMemory();
  const [head, id, sub, subId] = s.parts;
  if (!head || !READ_PREFIXES.includes(head)) return undefined;
  if (!source) return fromMemory();
  const n = s.parts.length;
  if (head === 'threads') {
    if (n === 1) return threadList(source, threadQuery(s.query));
    if (n === 2 && id) return threadDetail(source, id) ?? fromMemory();
    if (n === 3 && id && sub === 'queue') return { items: pendingQueue(source, id) };
  } else if (head === 'projects') {
    if (n === 1) return { items: projectList(source) };
    if (n === 2 && id) return projectView(source, id) ?? fromMemory();
  } else if (head === 'spaces') {
    if (n === 1) return { items: spaceList(source) };
    if (n === 2 && id) return spaceView(source, id) ?? fromMemory();
    if (n === 3 && id && sub === 'pages') {
      const pages = pageList(source, id);
      return pages.length || !cache.has(req.path) ? { items: pages } : fromMemory();
    }
    if (n === 4 && id && sub === 'pages' && subId)
      return pageView(source, id, subId) ?? fromMemory();
  }
  return fromMemory();
}
