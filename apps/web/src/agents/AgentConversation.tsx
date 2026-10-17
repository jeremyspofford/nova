// The agent's conversation (FR-079, FR-083, FR-088; docs/04 §2.5): its main thread with the chat's
// own view and composer, so the user talks to the agent as in a chat, with approvals inline. Its
// other threads (a channel binding's, proactive research) open here read-only with the chat's
// message and approval components: the user answers in that channel, and approvals still decide
// here. Messages in those threads come from other people and agents: untrusted, shown as text.
import { useId } from 'react';
import type { AgentThreadView, AgentView, ChannelBindingView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
import { ChatView } from '../chat/ChatView.tsx';
import { MessageItem, type CallApproval } from '../chat/MessageItem.tsx';
import {
  awaitsUser,
  liveCallsByMessage,
  type ClientApproval,
  type DisplayCall,
} from '../chat/thread-state.ts';
import { ToolAppsProvider } from '../chat/tool-apps.tsx';
import { useThreadFeed } from '../chat/useThreadFeed.ts';
import { useServices } from '../services.tsx';
import { modelLabel, useModels } from '../stores.tsx';
import { CHANNEL_KIND_TEXT, THREAD_KIND_TEXT } from './format.ts';

/** How a thread of the agent is named: its channel binding's label, or its kind. */
export function threadLabel(t: AgentThreadView, channels: readonly ChannelBindingView[]): string {
  if (t.kind === 'binding') {
    const b = channels.find((c) => c.id === t.bindingRef);
    if (b) return `${CHANNEL_KIND_TEXT[b.kind]} · ${b.label}`;
    return t.title ?? THREAD_KIND_TEXT.binding;
  }
  if (t.kind === 'main') return THREAD_KIND_TEXT.main;
  return t.title ?? THREAD_KIND_TEXT[t.kind];
}

export function AgentConversation({
  agent,
  thread,
  channels,
  onMain,
}: {
  agent: AgentView;
  /** Another thread of the agent to read, or null for the main thread. */
  thread: AgentThreadView | null;
  channels: readonly ChannelBindingView[];
  onMain: () => void;
}) {
  if (thread && thread.threadId !== agent.primaryThreadId)
    return (
      <AgentThreadLog
        key={thread.threadId}
        thread={thread}
        label={threadLabel(thread, channels)}
        onMain={onMain}
      />
    );
  if (!agent.primaryThreadId)
    return (
      <p className="muted agent-conversation-empty">
        <Spinner label="Setting up the main thread" /> Setting up the agent&apos;s main thread…
      </p>
    );
  return (
    <div className="agent-chat">
      {agent.status === 'paused' ? (
        <p className="ws-callout agent-chat-note" role="note">
          <Icon name="clock" />
          <span>Paused: it will not answer until you resume it.</span>
        </p>
      ) : null}
      <ChatView key={agent.primaryThreadId} threadId={agent.primaryThreadId} active embedded />
    </div>
  );
}

function AgentThreadLog({
  thread,
  label,
  onMain,
}: {
  thread: AgentThreadView;
  label: string;
  onMain: () => void;
}) {
  const { api } = useServices();
  const { models } = useModels();
  const headingId = useId();
  const { state, dispatch } = useThreadFeed(thread.threadId, null);

  const approvalCard = (a: ClientApproval) => (
    <ApprovalCard
      key={a.id}
      approval={a}
      onChange={(view) => dispatch({ type: 'approvals', items: [view] })}
    />
  );
  const byCall = new Map<string, ClientApproval>();
  for (const a of Object.values(state.approvals)) {
    if (!a.callId) continue;
    const prev = byCall.get(a.callId);
    if (!prev || prev.createdAt <= a.createdAt) byCall.set(a.callId, a);
  }
  const approvalFor = (call: DisplayCall): CallApproval | null => {
    const a =
      (call.approvalId ? state.approvals[call.approvalId] : undefined) ?? byCall.get(call.callId);
    if (!a) return null;
    return { node: approvalCard(a), status: awaitsUser(a) ? 'awaiting_approval' : undefined };
  };
  const shownCalls = new Set(
    state.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.callId] : [])),
    ),
  );
  for (const c of Object.values(state.calls)) shownCalls.add(c.callId);
  const orphans = Object.values(state.approvals).filter(
    (a) => awaitsUser(a) && !(a.callId && shownCalls.has(a.callId)),
  );
  const live = liveCallsByMessage(state);

  return (
    <section className="agent-thread-log" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{label}</h2>
        <Button onClick={onMain}>
          <Icon name="back" /> Main thread
        </Button>
      </div>
      <p className="muted ws-flush">
        {thread.kind === 'binding'
          ? `Read-only here: answer in the channel. ${thread.audience === 'shared' ? 'Shared with others in the channel.' : 'Private to you.'}`
          : thread.kind === 'proactive'
            ? 'Read-only: research the agent did on its own, with read-only tools.'
            : 'Read-only.'}
      </p>
      {state.status === 'loading' || (state.status === 'ready' && state.thread === null) ? (
        <p className="muted">
          <Spinner label="Loading the thread" /> Loading…
        </p>
      ) : state.status === 'error' ? (
        <p className="ws-error" role="alert">
          <Icon name="alert" /> {state.loadError ?? 'Could not load the thread.'}
        </p>
      ) : state.messages.length === 0 ? (
        <p className="muted">Nothing has been said in this thread yet.</p>
      ) : (
        <ToolAppsProvider>
          <div className="work-log" role="log" aria-label={`${label} messages`}>
            {state.messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                streamed={state.streamed[m.id]}
                reasoning={state.reasoning[m.id]}
                attachmentUrl={api.attachmentUrl}
                modelName={m.model ? modelLabel(models, m.model) : null}
                actions={null}
                idPrefix="agent-msg-"
                liveCalls={live.get(m.id)}
                approvalFor={approvalFor}
              />
            ))}
            {orphans.length ? (
              <div className="approval-orphans">{orphans.map(approvalCard)}</div>
            ) : null}
          </div>
        </ToolAppsProvider>
      )}
    </section>
  );
}
