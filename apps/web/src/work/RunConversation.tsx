// The run's thread (FR-051, ADR-076): a run is a thread whose turns run in the same loop as chat,
// so its messages, tool cards and approval cards render with the chat's own components, read-only.
// The user steers the run through Redirect in the header, never by typing here.
import { useId } from 'react';
import { defineMessages } from '@nova/i18n';
import { Icon, Spinner } from '@nova/ui';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
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
import { WORK_TEXT } from './format.ts';

/** A run's thread. */
export const CONVERSATION_TEXT = defineMessages('work.conversation', {
  heading: 'Conversation',
  loading: 'Loading the conversation',
  loadFailed: 'Could not load the conversation.',
  empty: 'Nothing has been said in this run yet.',
  log: 'Run conversation',
});

export function RunConversation({
  threadId,
  onOpenArtifact,
}: {
  threadId: string;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { api } = useServices();
  const { models } = useModels();
  const headingId = useId();
  const { state, dispatch } = useThreadFeed(threadId, null);

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
  const S = CONVERSATION_TEXT;

  return (
    <section className="work-conversation" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.heading}</h2>
      {/* The feed starts without a thread view; it arrives with the first load. */}
      {state.status === 'loading' || (state.status === 'ready' && state.thread === null) ? (
        <p className="muted">
          <Spinner label={S.loading} /> {WORK_TEXT.loading}
        </p>
      ) : state.status === 'error' ? (
        <p className="ws-error" role="alert">
          <Icon name="alert" /> {state.loadError ?? S.loadFailed}
        </p>
      ) : state.messages.length === 0 ? (
        <p className="muted">{S.empty}</p>
      ) : (
        <ToolAppsProvider>
          <div className="work-log" role="log" aria-label={S.log}>
            {state.messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                streamed={state.streamed[m.id]}
                reasoning={state.reasoning[m.id]}
                attachmentUrl={api.attachmentUrl}
                modelName={m.model ? modelLabel(models, m.model) : null}
                actions={null}
                idPrefix="run-msg-"
                liveCalls={live.get(m.id)}
                approvalFor={approvalFor}
                onOpenArtifact={onOpenArtifact}
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
