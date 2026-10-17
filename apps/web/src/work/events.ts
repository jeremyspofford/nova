// Runs, goals, schedules, requests and thread status on the app's one shared event stream
// (src/hub-events.ts; contracts/events.md). The Work views, the sidebar and every run or question
// card in a chat listen through it, so a page holds one connection however many cards it shows.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useServices } from '../services.tsx';
import { subscribeHubEvents } from '../hub-events.ts';
import type { EventSourceFactory } from '../sse.ts';

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

/** Work events on the app's shared stream (src/hub-events.ts). */
export function subscribeWorkEvents(factory: EventSourceFactory, l: WorkListener): () => void {
  return subscribeHubEvents(factory, WORK_EVENTS, l);
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
