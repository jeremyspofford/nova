// Settings → Triggers (FR-056, FR-201; docs/09 §7, docs/18 J7 step 5): what starts work when
// something happens. Webhook triggers (a private address with a token and signature, shown once),
// MCP event subscriptions (a connected server's advertised event; status, renewal and last
// delivery) and channel watches (a Slack conversation). Each says what it starts (a Work run or a
// wake of an agent), can be turned off, edited and deleted, and shows its delivery log. File and
// email triggers made elsewhere are listed as not available yet, with the reason. Live through
// trigger and subscription events.
import { useCallback, useEffect, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type {
  AgentView,
  ChannelBindingViewM7,
  McpEventSourceView,
  McpServerView,
  ProjectView,
  TriggerEventView,
  TriggerView,
} from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { runPath } from '../work/format.ts';
import { useChannelsApi } from './api.ts';
import { TRIGGER_EVENTS, useChannelEvents, useDebouncedCallback } from './events.ts';
import {
  CREDENTIAL_TEXT,
  EVENT_STATUS,
  SUBSCRIPTION_STATUS,
  TRIGGER_KIND_TEXT,
  absoluteUrl,
  chips,
  eventDetail,
  formatStamp,
  randomSecret,
} from './format.ts';
import { Chip, CopyValue, SecretsOnce, SigningHelp } from './parts.tsx';
import { EditTriggerDialog, NewTriggerDialog, type NewTriggerKind } from './TriggerDialogs.tsx';
import '../workspace.css';
import './channels.css';

const CHANNELS_PATH = '/settings/channels';
const TOOLS_PATH = '/settings/tools';

/** Settings → Triggers' words (FR-016). Names, events and the Hub's errors are data. */
export const TRIGGERS_TEXT = defineMessages('channels.triggers', {
  title: 'Triggers',
  intro:
    'Start work when something happens: a call to a webhook, an event from an MCP server, or a message in a Slack conversation you choose. What an event says is passed along as untrusted data and never counts as your instruction. Scheduled work is in {scheduled}.',
  scheduled: 'Work → Scheduled',
  yourTriggers: 'Your triggers',
  newTrigger: 'New trigger',
  webhook: 'Webhook',
  mcpEvent: 'MCP event',
  channelWatch: 'Channel watch',
  loadFailed: 'Could not load triggers.',
  retry: 'Retry',
  loading: 'Loading triggers',
  emptyTitle: 'No triggers yet',
  emptyDescription:
    "Add a webhook for another service to call, subscribe to an MCP server's event, or watch a Slack conversation.",
  list: 'Triggers',
  wakes: 'Wakes {agent}',
  anAgent: 'an agent',
  aProject: 'a project',
  anMcpServer: 'An MCP server',
  startsRunIn: 'Starts a Work run in {project}',
  startsRun: 'Starts a Work run',
  asksFirst: '{starts} · asks before acting',
  renewedBefore: 'Renewed before {when}',
  noExpiry: 'Does not expire',
  lastDelivery: 'Last delivery {when}',
  noDeliveries: 'No deliveries yet',
  deletedChannel: 'A channel that was deleted',
  containing: 'Only messages containing “{text}”',
  lastFired: 'Last fired {when}',
  notFired: 'Not fired yet',
  onLabel: '{name} on',
  unsubscribedHint: 'Unsubscribed; add a new MCP event trigger.',
  deliveriesOf: 'Deliveries of {name}',
  deliveries: 'Deliveries',
  editName: 'Edit {name}',
  edit: 'Edit',
  newSecretFor: 'New token and secret for {name}',
  newSecret: 'New secret',
  unsubscribeName: 'Unsubscribe {name}',
  unsubscribe: 'Unsubscribe',
  deleteName: 'Delete {name}',
  delete: 'Delete',
  address: 'Webhook address',
  done: 'Done',
  where: 'MCP servers are connected in {tools}; Slack channels in {channels}.',
  tools: 'Tools & MCP',
  channels: 'Channels',
  turnedOn: '{name} is on.',
  turnedOff: '{name} is off.',
  changeFailed: 'Could not change the trigger: {error}',
  deleted: '{name} deleted.',
  deleteFailed: 'Could not delete: {error}',
  unsubscribed: 'Unsubscribed from {event}. The trigger is off.',
  unsubscribeFailed: 'Could not unsubscribe: {error}',
  rotateFailed: 'Could not make new credentials: {error}',
  deleteTitle: 'Delete {name}?',
  deleteThis: 'Delete this trigger?',
  deleteMcp: 'Nova unsubscribes from the server first. Runs it started are kept.',
  deleteOther: 'Events stop starting work at once. Runs it started are kept.',
  cancel: 'Cancel',
  unsubscribeTitle: 'Unsubscribe from this event?',
  unsubscribeWhat:
    'The server stops sending it and the trigger turns off. To subscribe again, add a new MCP event trigger.',
  rotateTitle: 'Make a new token and secret?',
  rotateWhat:
    'The current ones stop working at once. Give the new ones to the service that calls this webhook.',
  rotateConfirm: 'Make new ones',
  log: {
    loadFailed: 'Could not load the deliveries.',
    loading: 'Loading deliveries',
    empty: 'No deliveries yet. They are listed here with what each one started.',
    openRun: 'Open run',
    openThread: 'Open thread',
  },
});

/** Whether a trigger runs, as a chip. */
const TRIGGER_STATE = chips(
  defineMessages('channels.triggers.stateChip', {
    unavailable: 'Not available yet',
    on: 'On',
    off: 'Off',
  }),
  {
    unavailable: { icon: 'alert' },
    on: { icon: 'check', tone: 'ready' },
    off: { icon: 'stop' },
  },
);

function go(path: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
}

export function TriggersPage() {
  const api = useChannelsApi();
  const { api: core } = useServices();
  const toast = useToast();
  const publicUrl = useSettings().get('channels.publicUrl').value;
  const [items, setItems] = useState<TriggerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [sources, setSources] = useState<McpEventSourceView[] | null>(null);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [bindings, setBindings] = useState<ChannelBindingViewM7[]>([]);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [creating, setCreating] = useState<NewTriggerKind | null>(null);
  const [editing, setEditing] = useState<TriggerView | null>(null);
  const [deleting, setDeleting] = useState<TriggerView | null>(null);
  const [unsubscribing, setUnsubscribing] = useState<TriggerView | null>(null);
  const [rotating, setRotating] = useState<TriggerView | null>(null);
  const [fresh, setFresh] = useState<{ id: string; token: string; secret: string } | null>(null);
  const [logs, setLogs] = useState<Set<string>>(new Set());
  const [logVersion, setLogVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listTriggers().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, TRIGGERS_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  // What the forms and rows name: each optional, so a failure leaves the list working.
  useEffect(() => {
    let alive = true;
    api.listMcpEventSources().then(
      ({ items: list }) => alive && setSources(list),
      () => alive && setSources([]),
    );
    api.listChannels().then(
      ({ items: list }) => alive && setBindings(list),
      () => undefined,
    );
    core.listMcpServers().then(
      ({ items: list }) => alive && setServers(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, core, version]);

  useEffect(() => {
    let alive = true;
    api.listChannelAgents().then(
      ({ items: list }) => alive && setAgents(list),
      () => alive && setAgents(null),
    );
    core.listProjects().then(
      ({ items: list }) => alive && setProjects(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, core]);

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    setLogVersion((v) => v + 1);
  }, []);
  const debounced = useDebouncedCallback(reload, 150);
  useChannelEvents(TRIGGER_EVENTS, () => debounced(), reload);

  const replace = (t: TriggerView) =>
    setItems((list) =>
      list
        ? list.some((x) => x.id === t.id)
          ? list.map((x) => (x.id === t.id ? t : x))
          : [...list, t]
        : list,
    );

  const toggle = async (t: TriggerView) => {
    try {
      const next = await api.updateTrigger(t.id, { enabled: !t.enabled });
      replace(next);
      toast.show(
        next.enabled
          ? TRIGGERS_TEXT.turnedOn({ name: next.title })
          : TRIGGERS_TEXT.turnedOff({ name: next.title }),
        { tone: 'success' },
      );
    } catch (err) {
      toast.show(TRIGGERS_TEXT.changeFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const remove = async (t: TriggerView) => {
    setDeleting(null);
    try {
      await api.deleteTrigger(t.id);
      setItems((list) => list?.filter((x) => x.id !== t.id) ?? null);
      toast.show(TRIGGERS_TEXT.deleted({ name: t.title }), { tone: 'success' });
    } catch (err) {
      toast.show(TRIGGERS_TEXT.deleteFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const unsubscribe = async (t: TriggerView) => {
    setUnsubscribing(null);
    if (!t.subscription) return;
    try {
      await api.deleteMcpSubscription(t.subscription.id);
      reload();
      toast.show(TRIGGERS_TEXT.unsubscribed({ event: t.subscription.event }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(TRIGGERS_TEXT.unsubscribeFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const rotate = async (t: TriggerView) => {
    setRotating(null);
    const credentials = { token: randomSecret(24), secret: randomSecret(32) };
    try {
      replace(await api.updateTrigger(t.id, { credentials }));
      setFresh({ id: t.id, ...credentials });
    } catch (err) {
      toast.show(TRIGGERS_TEXT.rotateFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const S = TRIGGERS_TEXT;
  const agentName = (agentId: string | null) =>
    agentId ? (agents?.find((a) => a.id === agentId)?.name ?? S.anAgent) : S.anAgent;
  const projectName = (projectId: string | null) =>
    projectId ? (projects.find((p) => p.id === projectId)?.name ?? S.aProject) : null;
  const serverName = (serverId: string) =>
    sources?.find((s) => s.serverId === serverId)?.name ??
    servers.find((s) => s.id === serverId)?.name ??
    S.anMcpServer;
  const bindingOf = (bid: string | null) => bindings.find((b) => b.id === bid) ?? null;
  const slackBindings = bindings.filter((b) => b.kind === 'slack');

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted ws-flush">
        {rich(S.intro, {
          scheduled: (
            <a href="/work/scheduled" onClick={go('/work/scheduled')}>
              {S.scheduled}
            </a>
          ),
        })}
      </p>
      <section className="settings-section" aria-labelledby="tr-list">
        <h3 id="tr-list">{S.yourTriggers}</h3>
        <div className="row" role="group" aria-label={S.newTrigger}>
          <Button variant="primary" onClick={() => setCreating('webhook')}>
            <Icon name="plus" /> {S.webhook}
          </Button>
          <Button onClick={() => setCreating('mcp_event')} disabled={sources === null}>
            <Icon name="plus" /> {S.mcpEvent}
          </Button>
          <Button onClick={() => setCreating('connector_event')}>
            <Icon name="plus" /> {S.channelWatch}
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>{S.retry}</Button>
          </div>
        ) : null}
        {items === null && !error ? <Spinner label={S.loading} /> : null}
        {items?.length === 0 ? (
          <EmptyState
            level={3}
            icon="activity"
            title={S.emptyTitle}
            description={S.emptyDescription}
          />
        ) : null}
        {items?.length ? (
          <ul className="ws-list" aria-label={S.list}>
            {items.map((t) => {
              const sub = t.subscription;
              const removed = sub?.status === 'removed';
              const binding = t.kind === 'connector_event' ? bindingOf(t.sourceRef) : null;
              const conversation =
                typeof t.config.conversation === 'string' ? t.config.conversation : null;
              const contains = typeof t.config.contains === 'string' ? t.config.contains : null;
              const logOpen = logs.has(t.id);
              const project = projectName(t.projectId);
              const starts =
                t.action === 'wake'
                  ? S.wakes({ agent: agentName(t.agentId) })
                  : project
                    ? S.startsRunIn({ project })
                    : S.startsRun;
              return (
                <li key={t.id} className="ws-list-row ch-trigger" aria-label={t.title}>
                  <div className="ws-source-main">
                    <strong className="ws-source-name" dir="auto">
                      {t.title}
                    </strong>
                    <span className="ws-row-meta">
                      <span className="ws-badge">{TRIGGER_KIND_TEXT[t.kind]}</span>
                      {!t.available ? (
                        <Chip spec={TRIGGER_STATE.unavailable} />
                      ) : t.enabled ? (
                        <Chip spec={TRIGGER_STATE.on} />
                      ) : (
                        <Chip spec={TRIGGER_STATE.off} />
                      )}
                      {sub ? <Chip spec={SUBSCRIPTION_STATUS[sub.status]} /> : null}
                    </span>
                    <span className="ws-row-meta">
                      {t.autonomy === 'ask_first' ? S.asksFirst({ starts }) : starts}
                    </span>
                    {t.kind === 'mcp_event' && sub ? (
                      <span className="muted ws-row-meta">
                        <span>
                          {serverName(sub.serverId)} ·{' '}
                          <code className="ws-code-inline">{sub.event}</code>
                        </span>
                        {sub.status === 'active' || sub.status === 'refreshing' ? (
                          <span>
                            {sub.expiresAt
                              ? S.renewedBefore({ when: formatStamp(sub.expiresAt) })
                              : S.noExpiry}
                          </span>
                        ) : null}
                        <span>
                          {sub.lastDeliveryAt
                            ? S.lastDelivery({ when: formatWhen(sub.lastDeliveryAt) })
                            : S.noDeliveries}
                        </span>
                      </span>
                    ) : null}
                    {sub?.lastError && !removed ? (
                      <p className="ws-warning">
                        <Icon name="alert" /> {sub.lastError}
                      </p>
                    ) : null}
                    {t.kind === 'connector_event' ? (
                      <span className="muted ws-row-meta">
                        <span>
                          {binding ? binding.label : S.deletedChannel}
                          {conversation && conversation !== binding?.externalRef
                            ? ` · ${conversation}`
                            : ''}
                        </span>
                        {contains ? <span>{S.containing({ text: contains })}</span> : null}
                      </span>
                    ) : null}
                    {t.kind === 'webhook' && t.webhookPath ? (
                      <span className="muted ws-row-meta">
                        <code className="ws-code-inline">
                          {absoluteUrl(t.webhookPath, publicUrl)}
                        </code>
                      </span>
                    ) : null}
                    {!t.available && t.unavailableReason ? (
                      <p className="ws-warning">
                        <Icon name="alert" /> {sentenceCase(t.unavailableReason)}
                      </p>
                    ) : null}
                    <span className="muted ws-row-meta">
                      {t.lastFiredAt
                        ? S.lastFired({ when: formatWhen(t.lastFiredAt) })
                        : S.notFired}
                    </span>
                  </div>
                  <div className="row ws-row-actions">
                    <button
                      type="button"
                      role="switch"
                      className="nv-switch"
                      aria-checked={t.enabled}
                      aria-label={S.onLabel({ name: t.title })}
                      title={removed ? S.unsubscribedHint : undefined}
                      disabled={removed || !t.available}
                      onClick={() => void toggle(t)}
                    />
                    <Button
                      variant="ghost"
                      aria-expanded={logOpen}
                      aria-controls={`tr-log-${t.id}`}
                      aria-label={S.deliveriesOf({ name: t.title })}
                      onClick={() =>
                        setLogs((s) => {
                          const next = new Set(s);
                          if (logOpen) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        })
                      }
                    >
                      {S.deliveries}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={S.editName({ name: t.title })}
                      onClick={() => setEditing(t)}
                    >
                      {S.edit}
                    </Button>
                    {t.kind === 'webhook' ? (
                      <Button
                        variant="ghost"
                        aria-label={S.newSecretFor({ name: t.title })}
                        onClick={() => setRotating(t)}
                      >
                        {S.newSecret}
                      </Button>
                    ) : null}
                    {sub && !removed ? (
                      <Button
                        variant="ghost"
                        aria-label={S.unsubscribeName({ name: t.title })}
                        onClick={() => setUnsubscribing(t)}
                      >
                        {S.unsubscribe}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      aria-label={S.deleteName({ name: t.title })}
                      onClick={() => setDeleting(t)}
                    >
                      {S.delete}
                    </Button>
                  </div>
                  {fresh?.id === t.id ? (
                    <div className="ch-panel stack">
                      <SecretsOnce
                        items={[
                          { label: CREDENTIAL_TEXT.token, value: fresh.token },
                          { label: CREDENTIAL_TEXT.secret, value: fresh.secret },
                        ]}
                      />
                      {t.webhookPath ? (
                        <CopyValue
                          label={S.address}
                          value={absoluteUrl(t.webhookPath, publicUrl)}
                        />
                      ) : null}
                      <SigningHelp eventId />
                      <div className="row">
                        <Button onClick={() => setFresh(null)}>{S.done}</Button>
                      </div>
                    </div>
                  ) : null}
                  {logOpen ? (
                    <div id={`tr-log-${t.id}`} className="ch-panel">
                      <DeliveryLog trigger={t} version={logVersion} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="muted ws-flush">
          {rich(S.where, {
            tools: (
              <a href={TOOLS_PATH} onClick={go(TOOLS_PATH)}>
                {S.tools}
              </a>
            ),
            channels: (
              <a href={CHANNELS_PATH} onClick={go(CHANNELS_PATH)}>
                {S.channels}
              </a>
            ),
          })}
        </p>
      </section>
      {creating ? (
        <NewTriggerDialog
          kind={creating}
          onClose={() => setCreating(null)}
          agents={agents}
          projects={projects}
          sources={sources}
          slackBindings={slackBindings}
          publicUrl={publicUrl}
          onCreated={(t) => (t ? replace(t) : reload())}
        />
      ) : null}
      {editing ? (
        <EditTriggerDialog trigger={editing} onClose={() => setEditing(null)} onSaved={replace} />
      ) : null}
      <Dialog
        open={deleting !== null}
        title={deleting ? S.deleteTitle({ name: deleting.title }) : S.deleteThis}
        description={deleting?.kind === 'mcp_event' ? S.deleteMcp : S.deleteOther}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              {S.delete}
            </Button>
          </>
        }
      />
      <Dialog
        open={unsubscribing !== null}
        title={S.unsubscribeTitle}
        description={S.unsubscribeWhat}
        onClose={() => setUnsubscribing(null)}
        footer={
          <>
            <Button onClick={() => setUnsubscribing(null)}>{S.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => unsubscribing && void unsubscribe(unsubscribing)}
            >
              {S.unsubscribe}
            </Button>
          </>
        }
      />
      <Dialog
        open={rotating !== null}
        title={S.rotateTitle}
        description={S.rotateWhat}
        onClose={() => setRotating(null)}
        footer={
          <>
            <Button onClick={() => setRotating(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => rotating && void rotate(rotating)}>
              {S.rotateConfirm}
            </Button>
          </>
        }
      />
    </div>
  );
}

function sentenceCase(text: string): string {
  const t = text.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t;
}

/** A trigger's deliveries, newest first: what each started, or why it did not. */
function DeliveryLog({ trigger, version }: { trigger: TriggerView; version: number }) {
  const api = useChannelsApi();
  const [items, setItems] = useState<TriggerEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listTriggerEvents(trigger.id, 50).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, TRIGGERS_TEXT.log.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, trigger.id, version, retry]);

  if (error)
    return (
      <div role="alert" className="ws-error">
        <p>{error}</p>
        <Button onClick={() => setRetry((r) => r + 1)}>{TRIGGERS_TEXT.retry}</Button>
      </div>
    );
  if (items === null) return <Spinner label={TRIGGERS_TEXT.log.loading} />;
  if (!items.length) return <p className="muted ws-flush">{TRIGGERS_TEXT.log.empty}</p>;
  return (
    <ul className="ch-log" aria-label={TRIGGERS_TEXT.deliveriesOf({ name: trigger.title })}>
      {items.map((e) => {
        const detail = eventDetail(e);
        return (
          <li key={`${e.dedupeKey}-${e.receivedAt}`} className="ch-log-row">
            <span className="ch-log-when">{formatStamp(e.receivedAt)}</span>
            <Chip spec={EVENT_STATUS[e.status]} />
            {detail ? <span className="muted ch-log-detail">{detail}</span> : null}
            {e.runId ? (
              <a
                href={runPath(e.runId)}
                onClick={(ev) => {
                  ev.preventDefault();
                  navigate(runPath(e.runId ?? ''));
                }}
              >
                {TRIGGERS_TEXT.log.openRun}
              </a>
            ) : e.threadId ? (
              <a
                href={chatPath(e.threadId)}
                onClick={(ev) => {
                  ev.preventDefault();
                  navigate(chatPath(e.threadId));
                }}
              >
                {TRIGGERS_TEXT.log.openThread}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
