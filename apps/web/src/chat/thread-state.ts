// State of one open chat (FR-018, FR-019, FR-020): messages from the Hub, an optimistic user
// bubble, streamed text that has not been persisted yet, follow-ups queued behind a running turn,
// and the turn status. Events may arrive before or after the HTTP responses that announce the
// same ids, and a reconnect can replay events, so every transition is idempotent.
import type {
  ChatDeltaPayload,
  ChatMessageCompletedPayload,
  MessageView,
  PartView,
  QueuedInputView,
  SendMessageResponse,
  ThreadDetail,
  ThreadView,
} from '@nova/shared';

export interface ClientMessage extends MessageView {
  /** Created on this client and not yet seen in a Hub response. */
  local?: boolean;
  /** A send made while a turn runs: how this client expects the Hub to take it (FR-019). */
  expect?: 'steer' | 'queue';
}

export interface ThreadState {
  thread: ThreadView | null;
  messages: ClientMessage[];
  /** messageId → text streamed since the message was last loaded. */
  streamed: Record<string, string>;
  reasoning: Record<string, string>;
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  /** True between turn.started and turn.completed/interrupted. */
  turnRunning: boolean;
  /** Follow-ups waiting for the running turn to end, oldest first (FR-019). */
  queue: QueuedInputView[];
}

export type ThreadAction =
  | { type: 'loaded'; detail: ThreadDetail }
  | { type: 'load_failed'; message: string }
  | { type: 'thread'; thread: ThreadView }
  | { type: 'optimistic'; message: ClientMessage }
  | { type: 'accepted'; tempId: string; res: SendMessageResponse }
  | { type: 'send_failed'; tempId: string }
  | { type: 'created'; messageId: string; role: MessageView['role']; turnId: string | null }
  | { type: 'delta'; payload: ChatDeltaPayload }
  | { type: 'completed'; payload: ChatMessageCompletedPayload }
  | { type: 'turn'; running: boolean }
  | { type: 'queue'; items: QueuedInputView[] }
  | { type: 'dequeued'; queuedId: string }
  /** A new version replaces the active path from `fromId` on (edit, regenerate; FR-020). */
  | { type: 'rewound'; fromId: string; add: ClientMessage[] }
  | { type: 'removed'; ids: string[] };

export function initialThreadState(thread: ThreadView | null): ThreadState {
  return {
    thread,
    messages: [],
    streamed: {},
    reasoning: {},
    status: thread ? 'loading' : 'ready',
    loadError: null,
    turnRunning: thread?.state === 'streaming',
    queue: [],
  };
}

/** A message known only by id so far (from an event or an HTTP response). */
export function placeholder(
  id: string,
  threadId: string,
  role: MessageView['role'],
  turnId: string | null,
  over: Partial<ClientMessage> = {},
): ClientMessage {
  return {
    id,
    threadId,
    turnId,
    role,
    status: role === 'assistant' ? 'streaming' : 'complete',
    parts: [],
    model: null,
    usage: null,
    createdAt: new Date().toISOString(),
    local: true,
    ...over,
  };
}

export function threadReducer(s: ThreadState, a: ThreadAction): ThreadState {
  switch (a.type) {
    case 'loaded': {
      const server = a.detail.messages;
      const ids = new Set(server.map((m) => m.id));
      // Keep local bubbles the Hub does not know about yet (an in-flight send).
      const pending = s.messages.filter((m) => m.local && !ids.has(m.id));
      const streamed: Record<string, string> = {};
      const reasoning: Record<string, string> = {};
      for (const m of server) {
        if (m.status !== 'streaming') continue;
        if (s.streamed[m.id]) streamed[m.id] = s.streamed[m.id]!;
        if (s.reasoning[m.id]) reasoning[m.id] = s.reasoning[m.id]!;
      }
      for (const m of pending) {
        if (s.streamed[m.id]) streamed[m.id] = s.streamed[m.id]!;
        if (s.reasoning[m.id]) reasoning[m.id] = s.reasoning[m.id]!;
      }
      const anyStreaming = server.some((m) => m.status === 'streaming');
      return {
        ...s,
        thread: a.detail.thread,
        messages: [...server, ...pending],
        streamed,
        reasoning,
        status: 'ready',
        loadError: null,
        turnRunning: anyStreaming || a.detail.thread.state === 'streaming' || hasLocalTurn(pending),
        queue: a.detail.queue ?? s.queue,
      };
    }
    case 'load_failed':
      return { ...s, status: 'error', loadError: a.message };
    case 'thread':
      return { ...s, thread: a.thread };
    case 'optimistic':
      return { ...s, messages: [...s.messages, a.message] };
    case 'accepted': {
      const { userMessageId, assistantMessageId, turnId, disposition } = a.res;
      const temp = s.messages.find((m) => m.id === a.tempId);
      if (disposition === 'queued') {
        // Not part of any turn yet: it waits in the queue strip, not in the log.
        const text = temp ? messageText(temp, undefined) : '';
        const item: QueuedInputView = {
          id: userMessageId,
          threadId: temp?.threadId ?? s.thread?.id ?? '',
          text,
          attachmentCount: temp?.parts.filter((p) => p.type === 'file').length ?? 0,
          position: a.res.queuePosition ?? s.queue.length + 1,
          createdAt: temp?.createdAt ?? new Date().toISOString(),
        };
        return {
          ...s,
          messages: s.messages.filter((m) => m.id !== a.tempId),
          queue: s.queue.some((q) => q.id === item.id) ? s.queue : [...s.queue, item],
        };
      }
      const provenance = disposition === 'steered' ? ('steer' as const) : undefined;
      let messages = s.messages;
      if (messages.some((m) => m.id === userMessageId)) {
        // The created event won the race: fill its placeholder with our text, drop the temp.
        messages = messages
          .filter((m) => m.id !== a.tempId)
          .map((m) =>
            m.id === userMessageId
              ? {
                  ...m,
                  ...(m.parts.length === 0 && temp ? { parts: temp.parts } : {}),
                  ...(provenance ? { provenance } : {}),
                }
              : m,
          );
      } else {
        messages = messages.map((m) => {
          if (m.id !== a.tempId) return m;
          const { expect: _expect, ...rest } = m;
          return { ...rest, id: userMessageId, turnId, ...(provenance ? { provenance } : {}) };
        });
      }
      if (assistantMessageId && turnId && !messages.some((m) => m.id === assistantMessageId)) {
        const threadId = temp?.threadId ?? s.thread?.id ?? '';
        messages = [...messages, placeholder(assistantMessageId, threadId, 'assistant', turnId)];
      }
      return { ...s, messages, turnRunning: true };
    }
    case 'send_failed':
      return { ...s, messages: s.messages.filter((m) => m.id !== a.tempId) };
    case 'created': {
      if (s.messages.some((m) => m.id === a.messageId)) return s;
      // Our own user message is still a temp bubble; `accepted` will give it this id.
      if (a.role === 'user' && s.messages.some((m) => m.local && m.id.startsWith('local-')))
        return s;
      const threadId = s.thread?.id ?? '';
      return {
        ...s,
        messages: [...s.messages, placeholder(a.messageId, threadId, a.role, a.turnId)],
        turnRunning: a.role === 'assistant' ? true : s.turnRunning,
      };
    }
    case 'delta': {
      const p = a.payload;
      const msg = s.messages.find((m) => m.id === p.messageId);
      // Late deltas for a finished message (a replay) are ignored.
      if (msg && msg.status !== 'streaming') return s;
      if (p.type === 'text_delta')
        return {
          ...s,
          streamed: { ...s.streamed, [p.messageId]: (s.streamed[p.messageId] ?? '') + p.text },
        };
      return {
        ...s,
        reasoning: { ...s.reasoning, [p.messageId]: (s.reasoning[p.messageId] ?? '') + p.text },
      };
    }
    case 'completed': {
      const p = a.payload;
      const messages = s.messages.map((m) => {
        if (m.id !== p.messageId) return m;
        const done: ClientMessage = { ...m, status: p.status, usage: p.usage ?? m.usage };
        // Fold streamed text in so it stays visible until the refetch returns the stored parts.
        const text = s.streamed[m.id];
        if (text && !m.parts.some((x) => x.type === 'text'))
          done.parts = [...m.parts, { type: 'text', text }];
        return done;
      });
      const streamed = { ...s.streamed };
      if (messages.some((m) => m.id === p.messageId)) delete streamed[p.messageId];
      return { ...s, messages, streamed };
    }
    case 'turn':
      return { ...s, turnRunning: a.running };
    case 'queue':
      return { ...s, queue: a.items };
    case 'dequeued':
      return { ...s, queue: s.queue.filter((q) => q.id !== a.queuedId) };
    case 'rewound': {
      const at = s.messages.findIndex((m) => m.id === a.fromId);
      if (at < 0) return s;
      const added = new Set(a.add.map((m) => m.id));
      // Events for the new ids may have arrived first; the rewound list places them once.
      const kept = s.messages.slice(0, at).filter((m) => !added.has(m.id));
      return { ...s, messages: [...kept, ...a.add], turnRunning: true };
    }
    case 'removed': {
      const gone = new Set(a.ids);
      return { ...s, messages: s.messages.filter((m) => !gone.has(m.id)) };
    }
  }
}

/** The messages a deletion removes: a user message takes the reply in its turn with it. */
export function deletionIds(messages: MessageView[], id: string): string[] {
  const m = messages.find((x) => x.id === id);
  if (!m) return [id];
  if (m.role !== 'user' || !m.turnId) return [id];
  const replies = messages.filter(
    (x) => x.turnId === m.turnId && x.role === 'assistant' && x.id !== id,
  );
  return [id, ...replies.map((r) => r.id)];
}

function hasLocalTurn(pending: ClientMessage[]): boolean {
  return pending.some((m) => m.role === 'assistant' && m.status === 'streaming');
}

/** The visible text of a message: stored text parts plus anything streamed since. */
export function messageText(m: ClientMessage, streamed: string | undefined): string {
  const stored = m.parts
    .filter((p): p is Extract<PartView, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
  if (!streamed) return stored;
  if (!stored) return streamed;
  // Some Hubs persist partial text while streaming; avoid showing it twice.
  return streamed.startsWith(stored) ? streamed : stored + streamed;
}

export function isStreaming(s: ThreadState): boolean {
  return s.turnRunning || s.messages.some((m) => m.status === 'streaming');
}
