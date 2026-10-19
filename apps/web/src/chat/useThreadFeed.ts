// Loads one thread and follows its event stream into the thread reducer (FR-018, FR-019). Shared
// by the chat view and the side chat panel; callers add their own reactions (announcements, list
// updates) through `onEvent`. M3: tool calls update live from `tool.call.*` and `policy.denied`,
// and the approvals the chat waits on are listed on load and fetched when one is requested
// (FR-100), so a card appears whichever client or device opened the chat.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type {
  ApprovalDecisionKind,
  ChatDeltaPayload,
  ChatMessageCompletedPayload,
  EventEnvelope,
  MessageView,
  ThreadDetail,
  ThreadState,
  ThreadView,
  ToolCallStatus,
  ToolSource,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { THREAD_EVENTS, openStream } from '../sse.ts';
import { initialThreadState, pendingApprovals, threadReducer } from './thread-state.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** `thread.status.changed` statuses (FR-215) as the thread state the views read. */
const STATE_OF: Record<string, ThreadState> = {
  needs_input: 'waiting_approval',
  running: 'streaming',
  ready: 'idle',
  blocked: 'error',
};

export function threadStateOf(status: unknown): ThreadState | null {
  return typeof status === 'string' ? (STATE_OF[status] ?? null) : null;
}

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
  /** The first listing of pending approvals finished (or failed). */
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ opts, state });
  useLayoutEffect(() => {
    latest.current = { opts, state };
  });

  const listApprovals = useCallback(() => {
    if (!threadId) return Promise.resolve();
    return api.listApprovals({ status: 'pending', threadId }).then(
      ({ items }) => dispatch({ type: 'approvals', items }),
      () => undefined,
    );
  }, [api, threadId]);

  const loadApproval = useCallback(
    (approvalId: string) => {
      api.getApproval(approvalId).then(
        (view) => {
          if (view.threadId && view.threadId !== threadId) return;
          dispatch({ type: 'approvals', items: [view] });
        },
        () => void listApprovals(),
      );
    },
    [api, listApprovals, threadId],
  );

  const refetch = useCallback(() => {
    if (!threadId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.getThread(threadId).then(
        (detail) => {
          dispatch({ type: 'loaded', detail });
          latest.current.opts.onLoaded?.(detail, false);
          // Waiting on an approval this view has not seen (missed while offline): list them.
          if (
            detail.thread.state === 'waiting_approval' &&
            pendingApprovals(latest.current.state).length === 0
          )
            void listApprovals();
        },
        () => undefined,
      );
    }, 40);
  }, [api, listApprovals, threadId]);

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
    void listApprovals().finally(() => {
      if (alive) setApprovalsLoaded(true);
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, listApprovals, threadId]);

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
        case 'thread.status.changed': {
          const ref = p.ref as { kind?: unknown; id?: unknown } | undefined;
          const next = threadStateOf(p.status);
          const current = latest.current.state.thread;
          if (ref?.kind === 'thread' && ref.id === threadId && next && current)
            dispatch({ type: 'thread', thread: { ...current, state: next } });
          break;
        }
        case 'tool.call.started':
          if (typeof p.callId !== 'string') break;
          dispatch({
            type: 'tool_started',
            callId: p.callId,
            tool: str(p.tool),
            source: (str(p.source) || 'builtin') as ToolSource,
            argsPreview: str(p.argsPreview),
            turnId: env.correlation?.turnId ?? null,
          });
          break;
        case 'tool.call.progress':
          if (typeof p.callId === 'string')
            dispatch({ type: 'tool_progress', callId: p.callId, chunk: str(p.chunk) });
          break;
        case 'tool.call.completed':
          if (typeof p.callId !== 'string') break;
          dispatch({
            type: 'tool_completed',
            callId: p.callId,
            status: (str(p.status) || 'ok') as ToolCallStatus,
            durationMs: numOrNull(p.durationMs),
            resultPreview: strOrNull(p.resultPreview),
            turnId: env.correlation?.turnId ?? null,
          });
          break;
        case 'policy.denied':
          if (typeof p.callId !== 'string') break;
          dispatch({
            type: 'tool_denied',
            callId: p.callId,
            tool: str(p.tool),
            reason: str(p.reason),
            turnId: env.correlation?.turnId ?? null,
          });
          break;
        case 'approval.requested':
          if (typeof p.approvalId === 'string') loadApproval(p.approvalId);
          break;
        case 'approval.decided':
          if (typeof p.approvalId === 'string' && typeof p.decision === 'string')
            dispatch({
              type: 'approval_decided',
              approvalId: p.approvalId,
              decision: p.decision as ApprovalDecisionKind,
            });
          break;
        default:
          break;
      }
      latest.current.opts.onEvent?.(env);
    },
    [loadApproval, refetch, refreshQueue, threadId],
  );
  /**
   * Catch up with the Hub: the thread, its queue and its approvals. Pending cards the Hub no longer
   * lists were answered (or expired) elsewhere; each is fetched so its card closes.
   */
  const resync = useCallback(() => {
    if (!threadId) return;
    refetch();
    refreshQueue();
    const before = pendingApprovals(latest.current.state).map((a) => a.id);
    api.listApprovals({ status: 'pending', threadId }).then(
      ({ items }) => {
        dispatch({ type: 'approvals', items });
        const still = new Set(items.map((a) => a.id));
        for (const id of before) if (!still.has(id)) loadApproval(id);
      },
      () => undefined,
    );
  }, [api, loadApproval, refetch, refreshQueue, threadId]);

  const onEventRef = useRef(onEvent);
  const resyncRef = useRef(resync);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
    resyncRef.current = resync;
  });

  useEffect(() => {
    if (!threadId) return;
    // Every connection catches up. The first has no cursor and receives live events only, so
    // anything emitted between the load and the connection (a new chat's first approval, say) is
    // fetched once it opens. A reconnect after an outage may have no cursor either (no event had
    // arrived), and what happened meanwhile (messages sent from another device or this device's
    // offline queue, approvals answered elsewhere) is fetched again; the reducer replaces the
    // messages by id, so none is lost or shown twice.
    const handle = openStream(
      api.threadStreamUrl(threadId),
      {
        onEvent: (e) => onEventRef.current(e),
        onOpen: () => resyncRef.current(),
      },
      { names: THREAD_EVENTS, factory: eventSource },
    );
    return () => handle.close();
  }, [api, eventSource, threadId]);

  return { state, dispatch, refetch, refreshQueue, approvalsLoaded, listApprovals };
}
