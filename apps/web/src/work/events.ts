// One shared subscription to the Hub's global event stream for runs, goals, schedules, requests
// and thread status (contracts/events.md; contracts/hub-api.md §5). The Work views, the sidebar
// and every run or question card in a chat listen through it, so a page holds one connection for
// all of them however many cards it shows. The stream opens with the first listener and closes
// with the last.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { EVENTS_STREAM_URL } from '../notifications/Bell.tsx';
import { useServices } from '../services.tsx';
import { openStream, type EventSourceFactory, type StreamHandle } from '../sse.ts';

export const WORK_EVENTS = [
  'run.created',
  'run.plan.proposed',
  'run.plan.amended',
  'run.step.started',
  'run.step.completed',
  'run.subagent.spawned',
  'run.subagent.completed',
  'run.status.changed',
  'run.budget.usage',
  'run.budget.reached',
  'run.budget.extended',
  'run.completed',
  'goal.created',
  'goal.updated',
  'goal.status.changed',
  'schedule.fired',
  'schedule.catchup',
  'schedule.wake.set',
  'schedule.created',
  'schedule.changed',
  'schedule.cancelled',
  'request.created',
  'request.resolved',
  'request.expired',
  'thread.status.changed',
  'approval.requested',
  'approval.decided',
] as const;

export interface WorkListener {
  onEvent: (env: EventEnvelope) => void;
  /** The stream (re)connected: anything emitted while it was closed is fetched again. */
  onOpen?: () => void;
}

interface Shared {
  handle: StreamHandle;
  listeners: Set<WorkListener>;
}

const shared = new WeakMap<EventSourceFactory, Shared>();

export function subscribeWorkEvents(factory: EventSourceFactory, l: WorkListener): () => void {
  let s = shared.get(factory);
  if (!s) {
    const listeners = new Set<WorkListener>();
    const handle = openStream(
      EVENTS_STREAM_URL,
      {
        onEvent: (env) => {
          for (const x of [...listeners]) x.onEvent(env);
        },
        onOpen: () => {
          for (const x of [...listeners]) x.onOpen?.();
        },
      },
      { names: WORK_EVENTS, factory },
    );
    s = { handle, listeners };
    shared.set(factory, s);
  }
  const mine = s;
  mine.listeners.add(l);
  return () => {
    mine.listeners.delete(l);
    if (mine.listeners.size > 0) return;
    mine.handle.close();
    if (shared.get(factory) === mine) shared.delete(factory);
  };
}

/** Follow the shared stream while mounted; the latest callbacks are always the ones called. */
export function useWorkEvents(onEvent: (env: EventEnvelope) => void, onOpen?: () => void): void {
  const { eventSource } = useServices();
  const ref = useRef({ onEvent, onOpen });
  useLayoutEffect(() => {
    ref.current = { onEvent, onOpen };
  });
  useEffect(
    () =>
      subscribeWorkEvents(eventSource, {
        onEvent: (env) => ref.current.onEvent(env),
        onOpen: () => ref.current.onOpen?.(),
      }),
    [eventSource],
  );
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The run an event is about: its payload's `runId`, or its correlation. */
export function eventRunId(env: EventEnvelope): string | null {
  const corr = env.correlation as { runId?: unknown } | undefined;
  return str(env.payload.runId) ?? str(corr?.runId);
}

/** A request event's correlation (payload first, as `request.created` carries it). */
export function eventCorrelation(env: EventEnvelope): {
  callId: string | null;
  runId: string | null;
} {
  const c = (env.payload.correlation ?? env.correlation ?? {}) as Record<string, unknown>;
  return { callId: str(c.callId), runId: str(c.runId) };
}

/**
 * A trailing debounce: bursts of events (a step finishing emits several) cause one fetch. The
 * returned function is stable; the timer is cleared on unmount.
 */
export function useDebounced(fn: () => void, ms = 120): () => void {
  const ref = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      ref.current();
    }, ms);
  }, [ms]);
}
