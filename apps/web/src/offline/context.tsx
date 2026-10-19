// The offline layer for React (FR-112): the runtime `createApi` was given, started on the app's
// one event stream while the workspace is open, and its state for the banner, the queue, the local
// answers in chat and Settings → Sync. Without a provider (tests, a page that does not wire it)
// everything reads as online with no copy and nothing waiting.
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useServices } from '../services.tsx';
import type { OfflineRuntime, OfflineState } from './runtime.ts';

const RuntimeCtx = createContext<OfflineRuntime | null>(null);

export function OfflineProvider({
  runtime,
  children,
}: {
  runtime: OfflineRuntime | null | undefined;
  children: ReactNode;
}) {
  const { eventSource } = useServices();
  useEffect(() => runtime?.start({ eventSource }), [runtime, eventSource]);
  return <RuntimeCtx.Provider value={runtime ?? null}>{children}</RuntimeCtx.Provider>;
}

const IDLE: OfflineState = {
  hub: 'online',
  since: null,
  nextCheckAt: null,
  checking: false,
  replica: {
    phase: 'off',
    granted: null,
    deviceId: null,
    reason: null,
    removal: null,
    syncing: false,
    loadedAt: null,
    lastSyncAt: null,
    cursor: 0,
    bytes: 0,
    counts: null,
    version: 0,
  },
  queue: [],
  reads: 'memory',
  scopes: null,
};

const noSubscribe = () => () => undefined;
const idle = () => IDLE;

export function useOffline(): { runtime: OfflineRuntime | null; state: OfflineState } {
  const runtime = useContext(RuntimeCtx);
  const state = useSyncExternalStore(
    runtime?.subscribe ?? noSubscribe,
    runtime?.getState ?? idle,
    runtime?.getState ?? idle,
  );
  return { runtime, state };
}
