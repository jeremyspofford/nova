// How the Code views stay current (FR-064): `code.*` events on the global event stream, and the
// turn events of a session's thread, which the embedded chat re-publishes on the thread bus. A
// burst of events (a reconnect replays them) costs one reload at a time, then one more.
import { useCallback, useEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useServices } from '../services.tsx';
import { subscribeHubEvents } from '../hub-events.ts';

/** Event names the Code views follow (contracts/events.md "code"; `code.changes.updated` M5). */
export const CODE_EVENTS = [
  'code.session.created',
  'code.session.updated',
  'code.session.modeChanged',
  'code.changes.updated',
  'code.change.applied',
  'code.change.reverted',
  'code.diff.commented',
  'code.review.completed',
  'code.commit.created',
  'code.pr.opened',
  'code.pr.ci.changed',
  'thread.status.changed',
  // M6 (docs/10 §2, §7-§10): pushes, auto-verify, dev servers, worktree leases, environments.
  'code.push.completed',
  'code.verify.started',
  'code.verify.completed',
  'code.devserver.started',
  'code.devserver.stopped',
  'worktree.leased',
  'worktree.released',
  'environment.updated',
  'environment.health.changed',
] as const;

/** The M6 events that change what a session's extras show (budget, PR, checks, servers). */
export const EXTRAS_EVENTS: ReadonlySet<string> = new Set([
  'code.session.updated',
  'code.pr.opened',
  'code.pr.ci.changed',
  'code.push.completed',
  'code.verify.started',
  'code.verify.completed',
  'code.devserver.started',
  'code.devserver.stopped',
  'environment.updated',
  'environment.health.changed',
]);

/** Follows the Code events on the global stream while `active`. */
export function useCodeEvents(active: boolean, onEvent: (env: EventEnvelope) => void): void {
  const { eventSource } = useServices();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!active) return;
    // The app's one shared stream (src/hub-events.ts).
    return subscribeHubEvents(eventSource, CODE_EVENTS, {
      onEvent: (env) => handler.current(env),
    });
  }, [active, eventSource]);
}

/** Calls `fn` with the events of one thread that the embedded chat re-publishes. */
export function useThreadBusEvents(
  threadId: string | null,
  fn: (env: EventEnvelope) => void,
): void {
  const { bus } = useServices();
  const handler = useRef(fn);
  useEffect(() => {
    handler.current = fn;
  });
  useEffect(() => {
    if (!threadId) return;
    return bus.subscribe((env) => {
      if (eventThreadId(env) === threadId) handler.current(env);
    });
  }, [bus, threadId]);
}

export function eventThreadId(env: EventEnvelope): string | null {
  const p = env.payload as { threadId?: unknown };
  if (typeof p.threadId === 'string') return p.threadId;
  return env.correlation?.threadId ?? null;
}

/** The session an event is about, when it says. */
export function eventSessionId(env: EventEnvelope): string | null {
  const p = env.payload as { sessionId?: unknown; ref?: { kind?: unknown; id?: unknown } };
  if (typeof p.sessionId === 'string') return p.sessionId;
  if (p.ref && typeof p.ref.id === 'string') return p.ref.id;
  return null;
}

/**
 * Wraps a loader so overlapping calls run it once at a time: a call while it runs schedules one
 * more run after it, however many calls arrive.
 */
export function useCoalesced(load: () => Promise<unknown>): () => void {
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  const state = useRef({ running: false, again: false });
  return useCallback(() => {
    const s = state.current;
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    const run = (): void => {
      latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          if (!s.again) {
            s.running = false;
            return;
          }
          s.again = false;
          run();
        });
    };
    run();
  }, []);
}
