// How the channels, triggers and routing views stay current (FR-088, FR-056, FR-201, FR-060):
// their events on the global stream (contracts/events.md). Each view follows them while it is
// mounted and refetches on a change, and again when the stream reconnects (anything emitted while
// it was closed is read back by the refetch).
import { useCallback, useEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useHubStream } from '../hub-events.ts';

/** Bindings and their messages; the request events carry the owner's share decisions. */
export const CHANNEL_EVENTS = [
  'channel.binding.changed',
  'channel.message.received',
  'channel.message.sent',
  'request.created',
  'request.resolved',
  'request.expired',
] as const;

export const TRIGGER_EVENTS = [
  'trigger.changed',
  'trigger.fired',
  'mcp.subscription.changed',
  'mcp.event.received',
  'channel.binding.changed',
] as const;

/** Follows the named events on the app's shared stream while mounted (src/hub-events.ts). */
export function useChannelEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
  onOpen?: () => void,
): void {
  useHubStream(names, onEvent, onOpen);
}

/** Calls `fn` once, `ms` after the last call (a burst of events refetches once). */
export function useDebouncedCallback(fn: () => void, ms = 120): () => void {
  const ref = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
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
