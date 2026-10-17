// Loads one thread and follows its event stream into the thread reducer (FR-018, FR-019). Shared
// by the chat view and the side chat panel; callers add their own reactions (announcements, list
// updates) through `onEvent`.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type {
  ChatDeltaPayload,
  ChatMessageCompletedPayload,
  EventEnvelope,
  MessageView,
  ThreadDetail,
  ThreadView,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { THREAD_EVENTS, openStream } from '../sse.ts';
import { initialThreadState, threadReducer } from './thread-state.ts';

export interface FeedOptions {
  /** Runs after the shared handling of each event for this thread. */
  onEvent?: (env: EventEnvelope) => void;
  /** Runs after a load (`first`) or a refetch. */
  onLoaded?: (detail: ThreadDetail, first: boolean) => void;
}

export function useThreadFeed(
  threadId: string | null,
  known: ThreadView | null,
  opts: FeedOptions = {},
) {
  const { api, eventSource } = useServices();
  const [state, dispatch] = useReducer(threadReducer, known, initialThreadState);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ opts, state });
  useLayoutEffect(() => {
    latest.current = { opts, state };
  });

  const refetch = useCallback(() => {
    if (!threadId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.getThread(threadId).then(
        (detail) => {
          dispatch({ type: 'loaded', detail });
          latest.current.opts.onLoaded?.(detail, false);
        },
        () => undefined,
      );
    }, 40);
  }, [api, threadId]);

  const refreshQueue = useCallback(() => {
    if (!threadId) return;
    api.listQueue(threadId).then(
      ({ items }) => dispatch({ type: 'queue', items }),
      () => undefined,
    );
  }, [api, threadId]);

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    api.getThread(threadId).then(
      (detail) => {
        if (!alive) return;
        dispatch({ type: 'loaded', detail });
        latest.current.opts.onLoaded?.(detail, true);
      },
      (err: unknown) => {
        if (!alive) return;
        dispatch({
          type: 'load_failed',
          message:
            err instanceof ApiError && err.status === 404
              ? 'This chat was deleted or does not exist.'
              : errorMessage(err, 'Could not load this chat.'),
        });
      },
    );
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, threadId]);

  const onEvent = useCallback(
    (env: EventEnvelope) => {
      const p = env.payload;
      // The stream is per thread; anything else is ignored rather than mixed in. A branch event
      // names the new branch, so it is matched by its parent too.
      const about =
        env.correlation?.threadId ?? (typeof p.threadId === 'string' ? p.threadId : null);
      const forUs =
        !about ||
        about === threadId ||
        (env.name === 'chat.branch.created' && p.parentId === threadId);
      if (!forUs) return;
      switch (env.name) {
        case 'turn.started':
          dispatch({ type: 'turn', running: true });
          break;
        case 'turn.completed':
        case 'turn.interrupted':
          dispatch({ type: 'turn', running: false });
          refetch();
          break;
        case 'chat.message.created': {
          const role = p.role as MessageView['role'];
          dispatch({
            type: 'created',
            messageId: String(p.messageId),
            role,
            turnId: typeof p.turnId === 'string' ? p.turnId : null,
          });
          // A user message from elsewhere (another device, a queued follow-up) needs its text;
          // our own in-flight send gets its id from the HTTP response instead.
          const sending = latest.current.state.messages.some((m) => m.id.startsWith('local-'));
          if (role === 'user' && !sending) refetch();
          break;
        }
        case 'chat.delta':
          dispatch({ type: 'delta', payload: p as unknown as ChatDeltaPayload });
          break;
        case 'chat.message.completed':
          dispatch({ type: 'completed', payload: p as unknown as ChatMessageCompletedPayload });
          refetch();
          break;
        case 'chat.message.updated':
          refetch();
          break;
        case 'chat.message.deleted':
          dispatch({ type: 'removed', ids: [String(p.messageId)] });
          refetch();
          break;
        case 'chat.followup.queued':
          refreshQueue();
          break;
        case 'chat.followup.started':
          dispatch({ type: 'dequeued', queuedId: String(p.queuedId) });
          refetch();
          break;
        default:
          break;
      }
      latest.current.opts.onEvent?.(env);
    },
    [refetch, refreshQueue, threadId],
  );
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!threadId) return;
    const handle = openStream(
      api.threadStreamUrl(threadId),
      { onEvent: (e) => onEventRef.current(e) },
      { names: THREAD_EVENTS, factory: eventSource },
    );
    return () => handle.close();
  }, [api, eventSource, threadId]);

  return { state, dispatch, refetch, refreshQueue };
}
