// External coding agents in a Code session (FR-203; flagged, `externalAgents.enabled`): hand the
// session's task to an agent from an adapter. The agent runs in the session's sandbox; every file
// read, write and command it asks for goes to Nova's policy engine, and its changes show up in the
// Diff like the session's own. Its live activity (messages, tool calls, plan; coalesced by the Hub
// to one update per 250 ms) streams while it works; its reply is untrusted text. Cancel asks first.
// Shown only while the feature is on (turning it off stops running agents). Refusals (no sandbox
// on SSH, WSL or a device; hosts the sandbox cannot enforce; a secret the adapter does not own)
// are said in plain words.
import { useId, useState } from 'react';
import type { AgentAdapterView, DelegationView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, SelectField, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { Badge } from '../code/parts.tsx';
import { ConfirmAction, InAppLink, TextBlock, useLoad } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useFlaggedApi } from './api.ts';
import {
  DELEGATION_STATUS,
  EXPERIMENTAL_PATH,
  FLAGGED_EVENTS,
  failureText,
  flaggedErrorMessage,
  isLiveDelegation,
  stopReasonText,
} from './format.ts';
import { FlagOff } from './ScriptRuns.tsx';
import './flagged.css';

/** What a live `delegation.updated` event says, as one activity line. */
export interface ActivityLine {
  kind: 'message' | 'thought' | 'tool_call' | 'plan';
  text: string;
}

/** At most this many live lines are kept per delegation (older ones scroll away). */
const MAX_LINES = 200;

export function DelegationsPane({ sessionId, threadId }: { sessionId: string; threadId: string }) {
  const settings = useSettings();
  if (!settings.get('externalAgents.enabled').value)
    return <FlagOff what="External coding agents" />;
  return <Delegations sessionId={sessionId} threadId={threadId} />;
}

function Delegations({ sessionId, threadId }: { sessionId: string; threadId: string }) {
  const api = useFlaggedApi();
  const announce = useAnnounce();
  const list = useLoad(
    () => api.listDelegations(sessionId).then((r) => r.items),
    `delegations:${sessionId}`,
  );
  const [activity, setActivity] = useState<Record<string, ActivityLine[]>>({});
  const [delegating, setDelegating] = useState(false);
  const [cancelling, setCancelling] = useState<DelegationView | null>(null);
  useHubStream(
    FLAGGED_EVENTS.delegations,
    (env) => {
      if (env.name === 'settings.changed') return;
      const about = env.correlation?.threadId ?? env.payload.threadId;
      if (about !== threadId) return;
      const id = typeof env.payload.delegationId === 'string' ? env.payload.delegationId : null;
      if (env.name === 'delegation.updated' && id) {
        const lines = activityLines(env.payload);
        if (lines.length) setActivity((a) => ({ ...a, [id]: mergeLines(a[id] ?? [], lines) }));
        return;
      }
      if (env.name === 'delegation.finished') {
        const status = typeof env.payload.status === 'string' ? env.payload.status : 'finished';
        announce(`The external agent ${status === 'completed' ? 'finished' : status}.`);
      }
      list.reload();
    },
    list.reload,
  );
  const items = list.data;
  const live = items?.find(isLiveDelegation) ?? null;
  return (
    <div className="fl-pane">
      <div className="cm7-pane-head">
        <p className="muted ws-flush">
          Hand this session’s task to an external coding agent. It works in this session’s sandbox,
          every file change and command it asks for goes through your policy, and its changes show
          in the Diff.
        </p>
        <Button
          disabled={!!live}
          title={live ? 'An external agent is already working here.' : undefined}
          onClick={() => setDelegating(true)}
        >
          <Icon name="agents" /> Delegate…
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(list.error, 'agents', 'Could not load the delegations.')}</p>
          <Button onClick={list.reload}>Retry</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label="Loading the delegations" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No external agents have worked here"
          description="Delegate the task to an agent from one of your adapters."
          icon="agents"
        />
      ) : null}
      {items?.length ? (
        <ul className="fl-list" aria-label="Delegations">
          {items.map((d) => (
            <DelegationRow
              key={d.id}
              d={d}
              lines={activity[d.id] ?? []}
              onCancel={() => setCancelling(d)}
            />
          ))}
        </ul>
      ) : null}
      <DelegateDialog
        open={delegating}
        sessionId={sessionId}
        onClose={() => setDelegating(false)}
        onStarted={(d) => {
          setDelegating(false);
          list.setData((prev) => [d, ...(prev ?? []).filter((x) => x.id !== d.id)]);
          announce(`Delegated to ${d.adapterName ?? 'the agent'}.`);
        }}
      />
      <ConfirmAction
        open={cancelling !== null}
        title="Stop the external agent?"
        description="It stops at once. Changes it already made stay in the Diff, where you can reject them."
        confirmLabel="Stop agent"
        danger
        errorText={(err) => flaggedErrorMessage(err, 'agents', 'Could not stop the agent.')}
        onClose={() => setCancelling(null)}
        onConfirm={async () => {
          if (!cancelling) return;
          const next = await api.cancelDelegation(cancelling.id);
          setCancelling(null);
          list.setData((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? null);
        }}
      />
    </div>
  );
}

/**
 * What one coalesced `delegation.updated` event says (at most one per 250 ms): the message and
 * thought text since the last one, a few tool-call updates (with how many more were left out),
 * and whether the plan changed.
 */
export function activityLines(p: Record<string, unknown>): ActivityLine[] {
  const out: ActivityLine[] = [];
  if (typeof p.thought === 'string' && p.thought) out.push({ kind: 'thought', text: p.thought });
  if (typeof p.message === 'string' && p.message) out.push({ kind: 'message', text: p.message });
  if (Array.isArray(p.toolCalls))
    for (const t of p.toolCalls as { title?: unknown; status?: unknown }[]) {
      const title = typeof t.title === 'string' && t.title ? t.title : 'A tool call';
      const status = typeof t.status === 'string' ? ` (${t.status.replace(/_/g, ' ')})` : '';
      out.push({ kind: 'tool_call', text: `${title}${status}` });
    }
  if (typeof p.droppedToolCalls === 'number' && p.droppedToolCalls > 0)
    out.push({
      kind: 'tool_call',
      text:
        p.droppedToolCalls === 1
          ? '1 more tool call, not shown'
          : `${p.droppedToolCalls} more tool calls, not shown`,
    });
  if (p.plan === true) out.push({ kind: 'plan', text: 'Updated its plan' });
  return out;
}

/** New lines after the old: message and thought text continues the line it belongs to. */
export function mergeLines(prev: ActivityLine[], add: ActivityLine[]): ActivityLine[] {
  const next = [...prev];
  for (const line of add) {
    const last = next[next.length - 1];
    if (last && last.kind === line.kind && (line.kind === 'message' || line.kind === 'thought'))
      next[next.length - 1] = { ...last, text: last.text + line.text };
    else next.push(line);
  }
  return next.slice(-MAX_LINES);
}

const LINE_LABEL: Record<ActivityLine['kind'], string> = {
  message: 'Said',
  thought: 'Thought',
  tool_call: 'Tool',
  plan: 'Plan',
};

function DelegationRow({
  d,
  lines,
  onCancel,
}: {
  d: DelegationView;
  lines: ActivityLine[];
  onCancel: () => void;
}) {
  const s = DELEGATION_STATUS[d.status];
  const live = isLiveDelegation(d);
  const stop = stopReasonText(d.stopReason);
  const agentName = d.agent?.name
    ? `${d.agent.name}${d.agent.version ? ` ${d.agent.version}` : ''}`
    : (d.adapterName ?? 'A removed adapter');
  return (
    <li className="fl-row" aria-label={`${agentName}, ${s.text}`}>
      <span className="fl-row-title">
        <span className="cl-strong">{agentName}</span>
        <Badge tone={s.tone} icon={s.icon}>
          {s.text}
        </Badge>
        {live ? (
          <Button variant="danger" onClick={onCancel}>
            <Icon name="stop" /> Stop…
          </Button>
        ) : null}
      </span>
      <span className="muted ws-row-meta">
        <span>{formatWhen(d.createdAt)}</span>
        <span>{plural(d.permissionRequests, 'permission request')}</span>
        <span>{plural(d.operations, 'operation')}</span>
      </span>
      <details className="ws-advanced">
        <summary>The task</summary>
        <TextBlock text={d.prompt} label="The task given to the agent" />
      </details>
      {live && lines.length ? (
        <ol className="fl-activity" aria-label="What the agent is doing" aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} data-kind={l.kind}>
              <span className="fl-activity-kind">{LINE_LABEL[l.kind]}</span>{' '}
              <span className="fl-activity-text">{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {d.output ? <TextBlock text={d.output} label="The agent’s reply" /> : null}
      {d.error ? (
        <p className="fl-why" role="note">
          {failureText(d.error)}
        </p>
      ) : null}
      {stop ? <p className="muted cl-small">{stop}</p> : null}
    </li>
  );
}

function DelegateDialog({
  open,
  sessionId,
  onClose,
  onStarted,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onStarted: (d: DelegationView) => void;
}) {
  if (!open) return null;
  return <DelegateForm sessionId={sessionId} onClose={onClose} onStarted={onStarted} />;
}

function DelegateForm({
  sessionId,
  onClose,
  onStarted,
}: {
  sessionId: string;
  onClose: () => void;
  onStarted: (d: DelegationView) => void;
}) {
  const api = useFlaggedApi();
  const id = `dg${useId()}`;
  const adapters = useLoad<AgentAdapterView[]>(
    () => api.listAgentAdapters().then((r) => r.items),
    'adapters',
  );
  const [adapterId, setAdapterId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = (adapters.data ?? []).filter((a) => a.enabled);
  const chosen = adapterId || usable[0]?.id || '';
  const problems: Record<string, string> = {};
  if (!chosen) problems.adapter = 'Choose an adapter.';
  if (!prompt.trim()) problems.prompt = 'Describe the task for the agent.';
  const shown = tried ? problems : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.startDelegation(sessionId, { adapterId: chosen, prompt: prompt.trim() }));
    } catch (err) {
      setError(flaggedErrorMessage(err, 'agents', 'Could not start the agent.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Delegate to an external agent"
      description="The agent works in this session’s folder. Nova decides every file change and command it asks for, under your rules."
      onClose={onClose}
      className="ws-wide-dialog"
    >
      {adapters.loading ? (
        <p className="muted">
          <Spinner label="Loading the adapters" /> Loading adapters…
        </p>
      ) : adapters.error ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(adapters.error, 'agents', 'Could not load the adapters.')}</p>
          <Button onClick={adapters.reload}>Retry</Button>
        </div>
      ) : usable.length === 0 ? (
        <div className="stack">
          <p>
            No adapter is ready. Add one in{' '}
            <InAppLink to={EXPERIMENTAL_PATH}>Settings → Experimental</InAppLink>, or turn one on
            there.
          </p>
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <SelectField
            label="Adapter"
            value={chosen}
            onChange={setAdapterId}
            options={usable.map((a) => ({
              value: a.id,
              label: a.lastCheck?.ok === false ? `${a.name} (its last check failed)` : a.name,
            }))}
            error={shown.adapter}
          />
          <TextArea
            id={`${id}-prompt`}
            label="The task"
            value={prompt}
            rows={5}
            error={shown.prompt}
            onChange={setPrompt}
          />
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null} Delegate
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
