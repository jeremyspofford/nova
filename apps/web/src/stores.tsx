// Shared lists the sidebar and views both read: chat threads (FR-017) and models with presets
// (FR-023, FR-221). The Hub is the source of truth; these mirror it and refetch after changes.
// Side chats never enter the thread list (FR-026).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ModelView, Preset, ThreadView, UpdateThreadRequest } from '@nova/shared';
import { errorMessage, type Api } from './api.ts';

export interface ThreadsStore {
  threads: ThreadView[];
  archived: ThreadView[] | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadArchived: () => Promise<void>;
  update: (id: string, patch: UpdateThreadRequest) => Promise<ThreadView>;
  remove: (id: string) => Promise<void>;
  /** Merge a fresher view (from a thread page or stream) without refetching. */
  upsertLocal: (view: Partial<ThreadView> & { id: string }) => void;
}

const ThreadsCtx = createContext<ThreadsStore | null>(null);

function sortThreads(list: ThreadView[]): ThreadView[] {
  return [...list].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function ThreadsProvider({ api, children }: { api: Api; children: ReactNode }) {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [archived, setArchived] = useState<ThreadView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(0);

  const refresh = useCallback(async () => {
    try {
      // Refetch at least as many rows as are shown, so "Show more" pages are not dropped.
      const page = await api.listThreads({
        mode: 'chat',
        limit: Math.min(200, Math.max(50, loaded.current)),
      });
      loaded.current = page.items.length;
      setThreads(page.items.filter((t) => !t.archived && !t.side));
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load chats.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await api.listThreads({ mode: 'chat', cursor, limit: 50 });
      loaded.current += page.items.length;
      setThreads((list) => {
        const seen = new Set(list.map((t) => t.id));
        return [...list, ...page.items.filter((t) => !seen.has(t.id) && !t.archived && !t.side)];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, 'Could not load more chats.'));
    }
  }, [api, cursor]);

  const loadArchived = useCallback(async () => {
    try {
      const page = await api.listThreads({ mode: 'chat', archived: true, limit: 200 });
      setArchived(page.items.filter((t) => t.archived));
    } catch (err) {
      setError(errorMessage(err, 'Could not load archived chats.'));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsertLocal = useCallback((view: Partial<ThreadView> & { id: string }) => {
    // Side chats, Work runs and Code sessions live in their own lists, never in Recent.
    if (view.side) return;
    if (view.mode && view.mode !== 'chat') return;
    setThreads((list) => {
      const i = list.findIndex((t) => t.id === view.id);
      if (i < 0) {
        const full = view as ThreadView;
        return full.mode && !full.archived ? sortThreads([full, ...list]) : list;
      }
      const merged = { ...list[i]!, ...view };
      const next = [...list];
      if (merged.archived) next.splice(i, 1);
      else next[i] = merged;
      return sortThreads(next);
    });
    setArchived((list) => {
      if (!list) return list;
      const i = list.findIndex((t) => t.id === view.id);
      if (i < 0)
        return view.archived && (view as ThreadView).mode ? [view as ThreadView, ...list] : list;
      const merged = { ...list[i]!, ...view };
      return merged.archived
        ? list.map((t, j) => (j === i ? merged : t))
        : list.filter((_, j) => j !== i);
    });
  }, []);

  const update = useCallback(
    async (id: string, patch: UpdateThreadRequest) => {
      const view = await api.updateThread(id, patch);
      upsertLocal(view);
      return view;
    },
    [api, upsertLocal],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.deleteThread(id);
      setThreads((list) => list.filter((t) => t.id !== id));
      setArchived((list) => list?.filter((t) => t.id !== id) ?? null);
    },
    [api],
  );

  const store = useMemo<ThreadsStore>(
    () => ({
      threads,
      archived,
      loading,
      error,
      hasMore: cursor !== null,
      refresh,
      loadMore,
      loadArchived,
      update,
      remove,
      upsertLocal,
    }),
    [
      threads,
      archived,
      loading,
      error,
      cursor,
      refresh,
      loadMore,
      loadArchived,
      update,
      remove,
      upsertLocal,
    ],
  );
  return <ThreadsCtx.Provider value={store}>{children}</ThreadsCtx.Provider>;
}

export function useThreads(): ThreadsStore {
  const s = useContext(ThreadsCtx);
  if (!s) throw new Error('useThreads must be used inside <ThreadsProvider>');
  return s;
}

// ---- models ---------------------------------------------------------------------------------------

export interface ModelsStore {
  /** Presets first, then provider and compute-node models (GET /models). */
  models: ModelView[];
  /** Preset definitions; their ranks order the Faster to Smarter control (FR-221). */
  presets: Preset[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const ModelsCtx = createContext<ModelsStore | null>(null);

export function ModelsProvider({ api, children }: { api: Api; children: ReactNode }) {
  const [models, setModels] = useState<ModelView[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    // Preset ranks are optional polish: without them the control keeps the /models order.
    const ranks = api.listPresets().then(
      (r) => setPresets(r.items),
      () => undefined,
    );
    try {
      const { items } = await api.listModels();
      setModels(items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load models.'));
    } finally {
      setLoading(false);
    }
    await ranks;
  }, [api]);
  useEffect(() => {
    // refresh() sets state only after awaiting the network, so this cannot cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  const store = useMemo(
    () => ({ models, presets, loading, error, refresh }),
    [models, presets, loading, error, refresh],
  );
  return <ModelsCtx.Provider value={store}>{children}</ModelsCtx.Provider>;
}

export function useModels(): ModelsStore {
  const s = useContext(ModelsCtx);
  if (!s) throw new Error('useModels must be used inside <ModelsProvider>');
  return s;
}

/** Display name for a model ref, falling back to the raw id. */
export function modelLabel(models: ModelView[], ref: string | null): string {
  if (!ref) return 'No model';
  const known = models.find((m) => m.ref === ref)?.label;
  if (known) return known;
  if (ref.startsWith('preset:')) return ref.slice('preset:'.length);
  return ref.slice(ref.indexOf('/') + 1);
}
