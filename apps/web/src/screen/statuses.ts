// The control state of every computer the account has (FR-207), for the global control indicator
// and Settings: one status per computer, refetched when the screen service says it changed and
// when the next grant runs out (an expiry emits no event). A failed load retries every 30 s so the
// indicator never stays blind for long.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerView, ScreenStatusView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { errorMessage } from '../api.ts';
import { useScreenApi } from './api.ts';
import { eventComputerId, useHubEvents } from './events.ts';

export const STATUSES_TEXT = defineMessages('screen.statuses', {
  loadFailed: 'Could not load your computers.',
});

/** Events after which a computer's control state may differ (not every recorded action). */
export const STATUS_EVENTS = [
  'screen.control.changed',
  'screen.grant.changed',
  'computer.takeover.started',
  'computer.takeover.ended',
] as const;

export const STATUS_RETRY_MS = 30_000;

export interface ScreenStatuses {
  /** Null until the first load. */
  statuses: ScreenStatusView[] | null;
  /** The computers by id, for their names. */
  computers: ReadonlyMap<string, ComputerView>;
  error: string | null;
  /** Refetch one computer, or all of them. */
  refresh: (computerId?: string) => void;
  /** Put a status the Hub just returned (after kill, renew, revoke). */
  put: (status: ScreenStatusView) => void;
}

export function useScreenStatuses(): ScreenStatuses {
  const api = useScreenApi();
  const [map, setMap] = useState<Map<string, ScreenStatusView> | null>(null);
  const [computers, setComputers] = useState<ReadonlyMap<string, ComputerView>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const put = useCallback((s: ScreenStatusView) => {
    setMap((m) => new Map(m ?? []).set(s.computerId, s));
  }, []);

  const one = useCallback(
    (id: string) => {
      api.screenStatus(id).then(
        (s) => {
          if (alive.current) put(s);
        },
        () => {
          // A computer that is gone drops out of the list.
          if (alive.current)
            setMap((m) => {
              if (!m?.has(id)) return m;
              const next = new Map(m);
              next.delete(id);
              return next;
            });
        },
      );
    },
    [api, put],
  );

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    api
      .listScreenComputers()
      .then(async ({ items }) => {
        const out = await Promise.allSettled(items.map((c) => api.screenStatus(c.id)));
        if (!live) return;
        const next = new Map<string, ScreenStatusView>();
        for (const r of out) if (r.status === 'fulfilled') next.set(r.value.computerId, r.value);
        setMap(next);
        setComputers(new Map(items.map((c) => [c.id, c])));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(errorMessage(err, STATUSES_TEXT.loadFailed));
        retry = setTimeout(() => setAttempt((n) => n + 1), STATUS_RETRY_MS);
      });
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
    };
  }, [api, attempt]);

  useHubEvents(STATUS_EVENTS, (env) => {
    const id = eventComputerId(env);
    if (id) one(id);
  });

  // Grants run out without an event: look again when the next one does.
  const next = map
    ? Math.min(
        ...[...map.values()].flatMap((s) =>
          s.grants.filter((g) => g.active).map((g) => Date.parse(g.expiresAt)),
        ),
      )
    : Infinity;
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const t = setTimeout(
      () => setAttempt((n) => n + 1),
      Math.max(1_000, Math.min(next - Date.now() + 500, 2_147_000_000)),
    );
    return () => clearTimeout(t);
  }, [next]);

  const refresh = useCallback(
    (computerId?: string) => {
      if (computerId) one(computerId);
      else setAttempt((n) => n + 1);
    },
    [one],
  );

  return {
    statuses: map
      ? [...map.values()].sort((a, b) => a.computerId.localeCompare(b.computerId))
      : null,
    computers,
    error,
    refresh,
    put,
  };
}
