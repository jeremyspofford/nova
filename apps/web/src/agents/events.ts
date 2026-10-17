// How the agents views stay current (FR-079..FR-090, FR-181, FR-206): `agent.*` events, the goal
// and schedule events an agent's goal and wakes emit, and `thread.status.changed` for the derived
// status of its threads (contracts/events.md; contracts/hub-api.md §5). Every agents view on a
// page listens through one shared connection: it opens with the first listener and closes with
// the last, and a reconnect refetches what may have been missed.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useServices } from '../services.tsx';
import { subscribeHubEvents } from '../hub-events.ts';
import type { EventSourceFactory } from '../sse.ts';

export const AGENT_EVENTS = [
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'agent.paused',
  'agent.resumed',
  'agent.status.changed',
  'agent.responsibility.changed',
  'agent.rule.changed',
  'agent.note.created',
  'agent.note.updated',
  'agent.note.deleted',
  'agent.memory.purged',
  'agent.suggestion.created',
  'agent.suggestion.updated',
  'agent.research.finding',
  'agent.budget.reached',
  'agent.background.started',
  'memory.item.created',
  'memory.item.updated',
  'memory.item.deleted',
  'goal.created',
  'goal.updated',
  'goal.status.changed',
  'schedule.created',
  'schedule.changed',
  'schedule.cancelled',
  'schedule.wake.set',
  'schedule.fired',
  'run.created',
  'run.status.changed',
  'run.completed',
  'thread.status.changed',
] as const;

export interface AgentListener {
  onEvent: (env: EventEnvelope) => void;
  /** The stream (re)connected: anything emitted while it was closed is fetched again. */
  onOpen?: () => void;
}

/** Agent events on the app's shared stream (src/hub-events.ts). */
export function subscribeAgentEvents(factory: EventSourceFactory, l: AgentListener): () => void {
  return subscribeHubEvents(factory, AGENT_EVENTS, l);
}

/** Follow the shared stream while mounted; the latest callbacks are always the ones called. */
export function useAgentEvents(onEvent: (env: EventEnvelope) => void, onOpen?: () => void): void {
  const { eventSource } = useServices();
  const ref = useRef({ onEvent, onOpen });
  useLayoutEffect(() => {
    ref.current = { onEvent, onOpen };
  });
  useEffect(
    () =>
      subscribeAgentEvents(eventSource, {
        onEvent: (env) => ref.current.onEvent(env),
        onOpen: () => ref.current.onOpen?.(),
      }),
    [eventSource],
  );
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The agent an event is about: its payload's `agentId`, or its correlation. */
export function eventAgentId(env: EventEnvelope): string | null {
  const corr = env.correlation as { agentId?: unknown } | undefined;
  return str(env.payload.agentId) ?? str(corr?.agentId);
}

/** The thread a `thread.status.changed` event is about. */
export function eventThreadRef(env: EventEnvelope): string | null {
  const ref = env.payload.ref as { kind?: unknown; id?: unknown } | undefined;
  return ref?.kind === 'thread' ? str(ref.id) : null;
}
