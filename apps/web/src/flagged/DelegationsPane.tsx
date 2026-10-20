// External coding agents in a Code session (FR-203; flagged, `externalAgents.enabled`): hand the
// session's task to an agent from an adapter. The agent runs in the session's sandbox; every file
// read, write and command it asks for goes to Nova's policy engine, and its changes show up in the
// Diff like the session's own. Its live activity (messages, tool calls, plan; coalesced by the Hub
// to one update per 250 ms) streams while it works; its reply is untrusted text. Cancel asks first.
// Shown only while the feature is on (turning it off stops running agents). Refusals (no sandbox
// on SSH, WSL or a device; hosts the sandbox cannot enforce; a secret the adapter does not own)
// are said in plain words.
import { useId, useState } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import type { AgentAdapterView, DelegationView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, SelectField, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { Badge } from '../code/parts.tsx';
import { ConfirmAction, InAppLink, TextBlock, useLoad } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useFlaggedApi } from './api.ts';
import {
  DELEGATION_STATUS,
  EXPERIMENTAL_PATH,
  FLAGGED_EVENTS,
  FLAGGED_TEXT,
  failureText,
  flaggedErrorMessage,
  isLiveDelegation,
  stopReasonText,
} from './format.ts';
import { FlagOff } from './ScriptRuns.tsx';
import './flagged.css';

/** The words of the delegations pane and its dialogs. */
export const DELEGATIONS_TEXT = defineMessages('flagged.delegations', {
  /** Said to screen readers when an agent's work ends, by how it ended. */
  finished:
    '{status, select, failed {The external agent failed.} cancelled {The external agent was cancelled.} other {The external agent finished.}}',
  intro:
    'Hand this session’s task to an external coding agent. It works in this session’s ' +
    'sandbox, every file change and command it asks for goes through your policy, and its ' +
    'changes show in the Diff.',
  busy: 'An external agent is already working here.',
  delegate: 'Delegate…',
  loadFailed: 'Could not load the delegations.',
  loading: 'Loading the delegations',
  empty: 'No external agents have worked here',
  emptyHint: 'Delegate the task to an agent from one of your adapters.',
  list: 'Delegations',
  /** Said to screen readers once the agent starts: "Delegated to Coder." */
  delegatedTo: 'Delegated to {name}.',
  delegated: 'Delegated to the agent.',
  stopTitle: 'Stop the external agent?',
  stopBody:
    'It stops at once. Changes it already made stay in the Diff, where you can reject them.',
  stopConfirm: 'Stop agent',
  stopFailed: 'Could not stop the agent.',
  /** An activity line for a tool call the agent did not name. */
  aToolCall: 'A tool call',
  /** An activity line: the tool call's title as the agent wrote it, and its state. */
  toolWithStatus: '{title} ({status})',
  /** A tool call's state as the agent reports it. */
  toolStatus: {
    pending: 'pending',
    in_progress: 'in progress',
    completed: 'completed',
    failed: 'failed',
  },
  dropped: '{n, plural, one {# more tool call, not shown} other {# more tool calls, not shown}}',
  planUpdated: 'Updated its plan',
  /** What kind of activity a line is: what the agent said, thought, which tool, its plan. */
  line: {
    message: 'Said',
    thought: 'Thought',
    tool_call: 'Tool',
    plan: 'Plan',
  },
  removedAdapter: 'A removed adapter',
  /** A delegation's name for screen readers: "Coder 1.2, Working". */
  rowLabel: '{agent}, {state}',
  stop: 'Stop…',
  permissionRequests: '{n, plural, one {# permission request} other {# permission requests}}',
  operations: '{n, plural, one {# operation} other {# operations}}',
  task: 'The task',
  taskLabel: 'The task given to the agent',
  activity: 'What the agent is doing',
  reply: 'The agent’s reply',
  chooseAdapter: 'Choose an adapter.',
  describeTask: 'Describe the task for the agent.',
  startFailed: 'Could not start the agent.',
  dialogTitle: 'Delegate to an external agent',
  dialogBody:
    'The agent works in this session’s folder. Nova decides every file change and command it ' +
    'asks for, under your rules.',
  adaptersLoading: 'Loading the adapters',
  adaptersLoadingText: 'Loading adapters…',
  adaptersLoadFailed: 'Could not load the adapters.',
  /** {link} is a link to the Settings page, named "Settings → Experimental". */
  noneReady: 'No adapter is ready. Add one in {link}, or turn one on there.',
  adapter: 'Adapter',
  /** An adapter in the list whose last check failed. */
  checkFailed: '{name} (its last check failed)',
  submit: 'Delegate',
});

/** What a live `delegation.updated` event says, as one activity line. */
export interface ActivityLine {
  kind: 'message' | 'thought' | 'tool_call' | 'plan';
  text: string;
}

/** At most this many live lines are kept per delegation (older ones scroll away). */
const MAX_LINES = 200;

export function DelegationsPane({ sessionId, threadId }: { sessionId: string; threadId: string }) {
  const settings = useSettings();
  if (!settings.get('externalAgents.enabled').value) return <FlagOff feature="agents" />;
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
        const status = typeof env.payload.status === 'string' ? env.payload.status : 'completed';
        announce(DELEGATIONS_TEXT.finished({ status }));
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
        <p className="muted ws-flush">{DELEGATIONS_TEXT.intro}</p>
        <Button
          disabled={!!live}
          title={live ? DELEGATIONS_TEXT.busy : undefined}
          onClick={() => setDelegating(true)}
        >
          <Icon name="agents" /> {DELEGATIONS_TEXT.delegate}
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(list.error, 'agents', DELEGATIONS_TEXT.loadFailed)}</p>
          <Button onClick={list.reload}>{FLAGGED_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={DELEGATIONS_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={DELEGATIONS_TEXT.empty}
          description={DELEGATIONS_TEXT.emptyHint}
          icon="agents"
        />
      ) : null}
      {items?.length ? (
        <ul className="fl-list" aria-label={DELEGATIONS_TEXT.list}>
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
          announce(
            d.adapterName
              ? DELEGATIONS_TEXT.delegatedTo({ name: d.adapterName })
              : DELEGATIONS_TEXT.delegated,
          );
        }}
      />
      <ConfirmAction
        open={cancelling !== null}
        title={DELEGATIONS_TEXT.stopTitle}
        description={DELEGATIONS_TEXT.stopBody}
        confirmLabel={DELEGATIONS_TEXT.stopConfirm}
        danger
        errorText={(err) => flaggedErrorMessage(err, 'agents', DELEGATIONS_TEXT.stopFailed)}
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
      const title = typeof t.title === 'string' && t.title ? t.title : DELEGATIONS_TEXT.aToolCall;
      const status =
        typeof t.status === 'string'
          ? (messageFor(DELEGATIONS_TEXT.toolStatus, t.status) ?? t.status.replace(/_/g, ' '))
          : null;
      out.push({
        kind: 'tool_call',
        text: status ? DELEGATIONS_TEXT.toolWithStatus({ title, status }) : title,
      });
    }
  if (typeof p.droppedToolCalls === 'number' && p.droppedToolCalls > 0)
    out.push({ kind: 'tool_call', text: DELEGATIONS_TEXT.dropped({ n: p.droppedToolCalls }) });
  if (p.plan === true) out.push({ kind: 'plan', text: DELEGATIONS_TEXT.planUpdated });
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
    : (d.adapterName ?? DELEGATIONS_TEXT.removedAdapter);
  return (
    <li
      className="fl-row"
      aria-label={DELEGATIONS_TEXT.rowLabel({ agent: agentName, state: s.text })}
    >
      <span className="fl-row-title">
        <span className="cl-strong">{agentName}</span>
        <Badge tone={s.tone} icon={s.icon}>
          {s.text}
        </Badge>
        {live ? (
          <Button variant="danger" onClick={onCancel}>
            <Icon name="stop" /> {DELEGATIONS_TEXT.stop}
          </Button>
        ) : null}
      </span>
      <span className="muted ws-row-meta">
        <span>{formatWhen(d.createdAt)}</span>
        <span>{DELEGATIONS_TEXT.permissionRequests({ n: d.permissionRequests })}</span>
        <span>{DELEGATIONS_TEXT.operations({ n: d.operations })}</span>
      </span>
      <details className="ws-advanced">
        <summary>{DELEGATIONS_TEXT.task}</summary>
        <TextBlock text={d.prompt} label={DELEGATIONS_TEXT.taskLabel} />
      </details>
      {live && lines.length ? (
        <ol className="fl-activity" aria-label={DELEGATIONS_TEXT.activity} aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} data-kind={l.kind}>
              <span className="fl-activity-kind">{DELEGATIONS_TEXT.line[l.kind]}</span>{' '}
              <span className="fl-activity-text">{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {d.output ? <TextBlock text={d.output} label={DELEGATIONS_TEXT.reply} /> : null}
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
  if (!chosen) problems.adapter = DELEGATIONS_TEXT.chooseAdapter;
  if (!prompt.trim()) problems.prompt = DELEGATIONS_TEXT.describeTask;
  const shown = tried ? problems : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.startDelegation(sessionId, { adapterId: chosen, prompt: prompt.trim() }));
    } catch (err) {
      setError(flaggedErrorMessage(err, 'agents', DELEGATIONS_TEXT.startFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={DELEGATIONS_TEXT.dialogTitle}
      description={DELEGATIONS_TEXT.dialogBody}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      {adapters.loading ? (
        <p className="muted">
          <Spinner label={DELEGATIONS_TEXT.adaptersLoading} />{' '}
          {DELEGATIONS_TEXT.adaptersLoadingText}
        </p>
      ) : adapters.error ? (
        <div className="ws-error" role="alert">
          <p>
            {flaggedErrorMessage(adapters.error, 'agents', DELEGATIONS_TEXT.adaptersLoadFailed)}
          </p>
          <Button onClick={adapters.reload}>{FLAGGED_TEXT.retry}</Button>
        </div>
      ) : usable.length === 0 ? (
        <div className="stack">
          <p>
            {rich(DELEGATIONS_TEXT.noneReady, {
              link: <InAppLink to={EXPERIMENTAL_PATH}>{FLAGGED_TEXT.where}</InAppLink>,
            })}
          </p>
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{FLAGGED_TEXT.close}</Button>
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
            label={DELEGATIONS_TEXT.adapter}
            value={chosen}
            onChange={setAdapterId}
            options={usable.map((a) => ({
              value: a.id,
              label:
                a.lastCheck?.ok === false ? DELEGATIONS_TEXT.checkFailed({ name: a.name }) : a.name,
            }))}
            error={shown.adapter}
          />
          <TextArea
            id={`${id}-prompt`}
            label={DELEGATIONS_TEXT.task}
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
            <Button onClick={onClose}>{FLAGGED_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null} {DELEGATIONS_TEXT.submit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
