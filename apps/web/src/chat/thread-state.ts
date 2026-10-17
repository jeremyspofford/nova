// State of one open chat (FR-018, FR-019, FR-020, FR-100): messages from the Hub, an optimistic
// user bubble, streamed text that has not been persisted yet, follow-ups queued behind a running
// turn, the turn status, live tool calls (M3: `tool.call.*` events, merged with the stored
// `tool_call` parts) and the approvals this chat waits on. Events may arrive before or after the
// HTTP responses that announce the same ids, and a reconnect can replay events, so every
// transition is idempotent.
import type {
  ApprovalDecisionKind,
  ApprovalView,
  ChatDeltaPayload,
  ChatMessageCompletedPayload,
  MessageView,
  PartView,
  QueuedInputView,
  SendMessageResponse,
  ThreadDetail,
  ThreadView,
  ToolCallPartView,
  ToolCallStatus,
  ToolSource,
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
  /** Tool calls seen on the stream, by call id (M3). */
  calls: Record<string, LiveCall>;
  /** Approvals for this chat, by id (FR-100). */
  approvals: Record<string, ClientApproval>;
}

/** A tool call as the stream reports it, before (or alongside) its stored `tool_call` part. */
export interface LiveCall {
  callId: string;
  turnId: string | null;
  /** The assistant message the call belongs to, when it was known at the time. */
  messageId: string | null;
  tool: string;
  source: ToolSource;
  status: ToolCallStatus;
  argsPreview: string;
  resultPreview: string | null;
  error: string | null;
  approvalId: string | null;
  durationMs: number | null;
  /** Output streamed so far (ephemeral `tool.call.progress`), keeping the newest text. */
  progress: string;
  /** Length of the message's streamed text when the call started: where its card sits. */
  at: number;
  /** Arrival order. */
  seq: number;
}

export interface ClientApproval extends ApprovalView {
  /** The user marked a handed-off step done (POST /approvals/:id/handoff-done). */
  handoffDone?: boolean;
  /** This client sent the decision (others show "answered on another device"). */
  answeredHere?: boolean;
}

/** Streamed tool output kept per call; older text is dropped. */
export const PROGRESS_LIMIT = 8000;

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
  | { type: 'removed'; ids: string[] }
  | {
      type: 'tool_started';
      callId: string;
      tool: string;
      source: ToolSource;
      argsPreview: string;
      turnId: string | null;
    }
  | { type: 'tool_progress'; callId: string; chunk: string }
  | {
      type: 'tool_completed';
      callId: string;
      status: ToolCallStatus;
      durationMs: number | null;
      resultPreview: string | null;
      turnId: string | null;
    }
  | { type: 'tool_denied'; callId: string; tool: string; reason: string; turnId: string | null }
  | { type: 'approvals'; items: ClientApproval[] }
  | { type: 'approval_decided'; approvalId: string; decision: ApprovalDecisionKind }
  | { type: 'handoff_done'; approvalId: string };

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
    calls: {},
    approvals: {},
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
  const next = reduce(s, a);
  return next === s ? s : settleWaiting(next);
}

/**
 * A thread marked `waiting_approval` whose known approvals are all answered is no longer waiting:
 * the turn runs on (or has ended). The Hub's own status change follows; this avoids a stale
 * Needs input in between.
 */
function settleWaiting(s: ThreadState): ThreadState {
  if (s.thread?.state !== 'waiting_approval') return s;
  const known = Object.values(s.approvals);
  if (known.length === 0 || known.some(awaitsUser)) return s;
  return { ...s, thread: { ...s.thread, state: s.turnRunning ? 'streaming' : 'idle' } };
}

function reduce(s: ThreadState, a: ThreadAction): ThreadState {
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
    case 'tool_started': {
      const prev = s.calls[a.callId];
      const owner = prev?.messageId ?? streamingAssistant(s.messages, a.turnId)?.id ?? null;
      const call: LiveCall = {
        ...(prev ?? emptyCall(a.callId, Object.keys(s.calls).length)),
        turnId: a.turnId ?? prev?.turnId ?? null,
        messageId: owner,
        tool: a.tool || prev?.tool || '',
        source: a.source,
        argsPreview: a.argsPreview,
        // A replayed start never moves a finished call back to running.
        status: prev && isTerminal(prev.status) ? prev.status : 'running',
        at: prev ? prev.at : owner ? (s.streamed[owner]?.length ?? 0) : 0,
      };
      return { ...s, calls: { ...s.calls, [a.callId]: call } };
    }
    case 'tool_progress': {
      const prev = s.calls[a.callId];
      if (!prev || isTerminal(prev.status)) return s;
      const progress = (prev.progress + a.chunk).slice(-PROGRESS_LIMIT);
      return { ...s, calls: { ...s.calls, [a.callId]: { ...prev, progress } } };
    }
    case 'tool_completed':
    case 'tool_denied': {
      const prev =
        s.calls[a.callId] ??
        ({
          ...emptyCall(a.callId, Object.keys(s.calls).length),
          turnId: a.turnId,
          messageId: streamingAssistant(s.messages, a.turnId)?.id ?? null,
        } satisfies LiveCall);
      const done: LiveCall =
        a.type === 'tool_completed'
          ? {
              ...prev,
              status: a.status,
              durationMs: a.durationMs,
              resultPreview: a.resultPreview,
            }
          : { ...prev, tool: prev.tool || a.tool, status: 'denied', error: a.reason };
      return { ...s, calls: { ...s.calls, [a.callId]: done } };
    }
    case 'approvals': {
      if (a.items.length === 0) return s;
      const approvals = { ...s.approvals };
      let calls = s.calls;
      for (const item of a.items) {
        const prev = approvals[item.id];
        // A view fetched before a decision arrived must not reopen the card.
        if (prev && prev.status !== 'pending' && item.status === 'pending') continue;
        approvals[item.id] = {
          ...item,
          handoffDone: item.handoffDone ?? prev?.handoffDone,
          answeredHere: item.answeredHere ?? prev?.answeredHere,
        };
        const call = item.callId ? calls[item.callId] : undefined;
        if (call && call.approvalId !== item.id)
          calls = { ...calls, [call.callId]: { ...call, approvalId: item.id } };
      }
      return { ...s, approvals, calls };
    }
    case 'approval_decided': {
      const prev = s.approvals[a.approvalId];
      if (!prev) return s;
      // A handed-off step keeps waiting until the user marks it done.
      const status =
        a.decision === 'timeout' ? 'expired' : a.decision === 'handoff' ? prev.status : 'decided';
      return {
        ...s,
        approvals: { ...s.approvals, [a.approvalId]: { ...prev, status, decision: a.decision } },
      };
    }
    case 'handoff_done': {
      const prev = s.approvals[a.approvalId];
      if (!prev) return s;
      return {
        ...s,
        approvals: {
          ...s.approvals,
          [a.approvalId]: { ...prev, status: 'decided', handoffDone: true },
        },
      };
    }
  }
}

function emptyCall(callId: string, seq: number): LiveCall {
  return {
    callId,
    turnId: null,
    messageId: null,
    tool: '',
    source: 'builtin',
    status: 'pending',
    argsPreview: '',
    resultPreview: null,
    error: null,
    approvalId: null,
    durationMs: null,
    progress: '',
    at: 0,
    seq,
  };
}

/** The reply a tool call of `turnId` belongs to: the newest streaming assistant message. */
function streamingAssistant(messages: ClientMessage[], turnId: string | null) {
  const replies = messages.filter((m) => m.role === 'assistant');
  return (
    replies.findLast((m) => m.status === 'streaming' && (!turnId || m.turnId === turnId)) ??
    (turnId ? replies.findLast((m) => m.turnId === turnId) : undefined)
  );
}

const TERMINAL: readonly ToolCallStatus[] = ['ok', 'error', 'denied', 'timeout', 'cancelled'];

export function isTerminal(status: ToolCallStatus): boolean {
  return TERMINAL.includes(status);
}

/** True while an approval still needs the user: undecided, or a hand-off not yet marked done. */
export function awaitsUser(a: ClientApproval): boolean {
  if (a.handoffDone) return false;
  return a.status === 'pending' || (a.status === 'decided' && a.decision === 'handoff');
}

/** Approvals that still need the user, oldest first. */
export function pendingApprovals(s: Pick<ThreadState, 'approvals'>): ClientApproval[] {
  return Object.values(s.approvals)
    .filter(awaitsUser)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

/** A tool call as a card shows it: the stored part, updated by anything newer from the stream. */
export type DisplayCall = ToolCallPartView & { progress: string };

export function mergeCall(part: ToolCallPartView | null, live: LiveCall | undefined): DisplayCall {
  const base: DisplayCall = part
    ? { ...part, progress: '' }
    : {
        type: 'tool_call',
        callId: live?.callId ?? '',
        tool: live?.tool ?? '',
        title: null,
        source: live?.source ?? 'builtin',
        status: live?.status ?? 'pending',
        argsPreview: live?.argsPreview ?? '',
        resultPreview: live?.resultPreview ?? null,
        error: live?.error ?? null,
        approvalId: live?.approvalId ?? null,
        durationMs: live?.durationMs ?? null,
        progress: '',
      };
  if (!live) return base;
  // A stored part that already finished wins over a stale live state, and the other way round.
  const liveNewer = isTerminal(live.status) || !isTerminal(base.status);
  return {
    ...base,
    tool: base.tool || live.tool,
    argsPreview: base.argsPreview || live.argsPreview,
    approvalId: base.approvalId ?? live.approvalId,
    progress: live.progress,
    ...(liveNewer
      ? {
          status: live.status,
          resultPreview: live.resultPreview ?? base.resultPreview,
          error: live.error ?? base.error,
          durationMs: live.durationMs ?? base.durationMs,
        }
      : {}),
  };
}

export type ArtifactPart = Extract<PartView, { type: 'artifact' }>;

/** What an assistant message shows, in order: text runs, tool cards and artifact cards. */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'call'; call: DisplayCall }
  | { kind: 'artifact'; part: ArtifactPart };

/**
 * The visible pieces of an assistant message. Stored parts keep their order; streamed text (not
 * persisted yet) is split where live calls started, so a card sits between the text before and
 * after it. When the Hub persisted part of the streamed text, the streamed copy is used once.
 */
export function messageSegments(
  m: ClientMessage,
  streamed: string | undefined,
  live: LiveCall[],
): Segment[] {
  const out: Segment[] = [];
  const addText = (text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === 'text') last.text += text;
    else out.push({ kind: 'text', text });
  };
  const byId = new Map(live.map((c) => [c.callId, c]));
  const storedCalls = new Set(m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.callId] : [])));
  const extra = live
    .filter((c) => !storedCalls.has(c.callId))
    .sort((x, y) => x.at - y.at || x.seq - y.seq)
    .map((c): { at: number; seg: Segment } => ({
      at: c.at,
      seg: { kind: 'call', call: mergeCall(null, c) },
    }));
  const nonText = (p: PartView): Segment | null =>
    p.type === 'tool_call'
      ? { kind: 'call', call: mergeCall(p, byId.get(p.callId)) }
      : p.type === 'artifact'
        ? { kind: 'artifact', part: p }
        : null;
  const split = (text: string, markers: { at: number; seg: Segment }[]) => {
    let pos = 0;
    for (const mk of markers) {
      const at = Math.min(Math.max(mk.at, pos), text.length);
      addText(text.slice(pos, at));
      out.push(mk.seg);
      pos = at;
    }
    addText(text.slice(pos));
  };

  const stored = m.parts
    .filter((p): p is Extract<PartView, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
  if (streamed && streamed.startsWith(stored)) {
    // The streamed text covers the stored text: place stored cards at their text offsets.
    const markers: { at: number; seg: Segment }[] = [];
    let offset = 0;
    for (const p of m.parts) {
      if (p.type === 'text') offset += p.text.length;
      else {
        const seg = nonText(p);
        if (seg) markers.push({ at: offset, seg });
      }
    }
    split(
      streamed,
      [...markers, ...extra].sort((x, y) => x.at - y.at),
    );
    return out;
  }
  for (const p of m.parts) {
    if (p.type === 'text') addText(p.text);
    else {
      const seg = nonText(p);
      if (seg) out.push(seg);
    }
  }
  split(streamed ?? '', extra);
  return out;
}

/**
 * Live calls grouped by the assistant message whose card shows them. A call whose message was
 * not known when it started goes to the newest reply of its turn, else the newest reply. A call
 * with no turn and no message was made from the UI (an MCP App or the file editor), not by the
 * model: it belongs to no reply, and its approval card shows on its own.
 */
export function liveCallsByMessage(s: Pick<ThreadState, 'calls' | 'messages'>) {
  const out = new Map<string, LiveCall[]>();
  const ids = new Set(s.messages.map((m) => m.id));
  const replies = s.messages.filter((m) => m.role === 'assistant');
  // A stored part decides where a call lives, whatever the stream guessed.
  const storedIn = new Map<string, string>();
  for (const m of replies)
    for (const p of m.parts) if (p.type === 'tool_call') storedIn.set(p.callId, m.id);
  for (const c of Object.values(s.calls).sort((x, y) => x.seq - y.seq)) {
    if (!c.turnId && !c.messageId && !storedIn.has(c.callId)) continue;
    const owner =
      storedIn.get(c.callId) ??
      (c.messageId && ids.has(c.messageId)
        ? c.messageId
        : (replies.findLast((m) => !!c.turnId && m.turnId === c.turnId) ?? replies.at(-1))?.id);
    if (!owner) continue;
    out.set(owner, [...(out.get(owner) ?? []), c]);
  }
  return out;
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
