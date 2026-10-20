// What an agent works through (FR-080, FR-083, FR-088; docs/09 §8, docs/04 §2.5): its background
// runs (each a Work run), its threads (main, one per channel binding, proactive research,
// background), its channel bindings (managed in Settings → Channels) and its computer (opened in
// the computers view). These sections read and link; the owning areas do the editing.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type {
  AgentBackgroundView,
  AgentThreadView,
  AgentView,
  ChannelBindingView,
  ComputerView,
} from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { RUN_STATUS_TEXT, runPath } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { threadLabel } from './AgentConversation.tsx';
import { useAgentsApi } from './api.ts';
import {
  AGENTS_TEXT,
  CHANNEL_KIND_ICON,
  CHANNEL_KIND_TEXT,
  CHANNELS_SETTINGS_PATH,
  COMPUTER_STATE_ICON,
  COMPUTER_STATE_TEXT,
  computerPath,
  THREAD_KIND_ICON,
  THREAD_KIND_TEXT,
} from './format.ts';
import { rich } from '../i18n/rich.tsx';
import { AgentComputerPanel } from '../devices/Connections.tsx';

export const BACKGROUND_TEXT = defineMessages('agents.background', {
  loadFailed: 'Could not load background work.',
  heading: 'Background work',
  intro:
    'Work the agent handed off while it keeps talking with you. Each piece is a Work run you ' +
    'can open, pause or cancel; pausing the agent pauses them too.',
  loading: 'Loading background work',
  empty: 'Nothing in the background yet.',
  list: 'Background work',
  started: 'Started {when}',
  ended: 'Ended {when}',
});

export const THREADS_TEXT = defineMessages('agents.threads', {
  heading: 'Threads',
  intro: "Each channel has its own thread; the agent's memory is shared across them.",
  loading: 'Loading the threads',
  empty: 'No threads yet.',
  list: 'Agent threads',
  since: 'Since {when}',
  openRun: 'Open the run',
  shown: 'Shown in the conversation',
  showOf: 'Show {label}',
  show: 'Show',
});

export const CHANNELS_TEXT = defineMessages('agents.channels', {
  status: {
    connected: 'Connected',
    disconnected: 'Turned off',
    not_configured: 'Needs setup',
  },
  settingsLink: 'Settings, Channels',
  heading: 'Channels',
  manage: 'Manage channels',
  intro:
    'Message the agent from Slack, Teams, email or a webhook. Bindings are set up in {link}. Content from your private threads reaches a shared channel only through a policy check.',
  loading: 'Loading the channels',
  empty:
    'No channels yet. You can always message the agent here; to reach it from Slack, Teams, email or a webhook, add a binding in {link}.',
  list: 'Channel bindings',
  /** A binding's row: its channel kind and label ("Slack #support"). */
  row: '{kind} {label}',
  /** A binding's name: "Slack · #support". */
  name: '{kind} · {label}',
  usesMain: 'Uses the main thread',
  lastMessage: 'Last message {when}',
  noMessages: 'No messages yet',
  showThreadOf: 'Show the thread of {label}',
  showThread: 'Show thread',
});

export const COMPUTER_TEXT = defineMessages('agents.computer', {
  kind: {
    cloud: 'Cloud computer',
    local_container: 'Container on the Hub',
    local_host: 'The Hub itself',
  },
  loadFailed: 'Could not load the computer.',
  heading: 'Computer',
  intro:
    "The agent's own computer keeps its files, installed software and browser sign-ins between " +
    'sessions. You can watch it work and take over the keyboard and mouse.',
  settingUp: 'Setting up the computer',
  settingUpLong: 'Its computer is being set up. Check back in a moment.',
  gone: 'This computer no longer exists.',
  loading: 'Loading the computer',
  kindLabel: 'Kind',
  state: 'State',
  details: 'Details',
  snapshots: 'Snapshots',
  lastUsed: 'Last used',
  open: 'Open the computer',
});

function runStatusText(status: string): string {
  return (RUN_STATUS_TEXT as Record<string, string | undefined>)[status] ?? status;
}

// ---- background runs (FR-083, FR-059) ------------------------------------------------------------

export function AgentBackground({ agentId, version }: { agentId: string; version: number }) {
  const api = useAgentsApi();
  const headingId = useId();
  const [items, setItems] = useState<AgentBackgroundView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  useEffect(() => {
    let alive = true;
    api.agentBackground(agentId).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, BACKGROUND_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{BACKGROUND_TEXT.heading}</h2>
      <p className="muted ws-flush">{BACKGROUND_TEXT.intro}</p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <Spinner label={BACKGROUND_TEXT.loading} />
      ) : items.length === 0 ? (
        <p className="muted">{BACKGROUND_TEXT.empty}</p>
      ) : (
        <ul className="ws-list" aria-label={BACKGROUND_TEXT.list}>
          {items.map((b) => (
            <li key={b.runId} className="ws-list-row">
              <div className="work-row-main">
                <a
                  href={runPath(b.runId)}
                  className="ws-card-link"
                  dir="auto"
                  onClick={(e) => followLink(e, runPath(b.runId))}
                >
                  {b.title}
                </a>
                <span className="muted ws-row-meta">
                  <span className="work-badge" data-run={b.status}>
                    {runStatusText(b.status)}
                  </span>
                  <span>{BACKGROUND_TEXT.started({ when: formatWhen(b.createdAt) })}</span>
                  {b.endedAt ? (
                    <span>{BACKGROUND_TEXT.ended({ when: formatWhen(b.endedAt) })}</span>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- threads (FR-083, FR-088) --------------------------------------------------------------------

export function AgentThreads({
  agent,
  threads,
  error,
  channels,
  shownId,
  onShow,
  onRetry,
}: {
  agent: AgentView;
  threads: AgentThreadView[] | null;
  error: string | null;
  channels: readonly ChannelBindingView[];
  /** The thread the conversation shows now. */
  shownId: string | null;
  onShow: (t: AgentThreadView) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{THREADS_TEXT.heading}</h2>
      <p className="muted ws-flush">{THREADS_TEXT.intro}</p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={onRetry}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : threads === null ? (
        <Spinner label={THREADS_TEXT.loading} />
      ) : threads.length === 0 ? (
        <p className="muted">{THREADS_TEXT.empty}</p>
      ) : (
        <ul className="ws-list" aria-label={THREADS_TEXT.list}>
          {threads.map((t) => {
            const label = threadLabel(t, channels);
            const shown =
              t.threadId === shownId || (shownId === null && t.threadId === agent.primaryThreadId);
            return (
              <li key={t.threadId} className="ws-list-row" aria-label={label}>
                <div className="work-row-main">
                  <span className="ws-card-link" dir="auto">
                    <Icon name={THREAD_KIND_ICON[t.kind]} /> {label}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>{THREAD_KIND_TEXT[t.kind]}</span>
                    <span className="ws-badge" data-audience={t.audience}>
                      {t.audience === 'shared' ? AGENTS_TEXT.shared : AGENTS_TEXT.private}
                    </span>
                    <span>{THREADS_TEXT.since({ when: formatWhen(t.createdAt) })}</span>
                  </span>
                </div>
                <div className="ws-row-actions ws-toolbar">
                  {t.kind === 'background' && t.runId ? (
                    <a
                      href={runPath(t.runId)}
                      className="nv-btn"
                      data-variant="default"
                      onClick={(e) => followLink(e, runPath(t.runId ?? ''))}
                    >
                      {THREADS_TEXT.openRun}
                    </a>
                  ) : shown ? (
                    <span className="muted">{THREADS_TEXT.shown}</span>
                  ) : (
                    <Button aria-label={THREADS_TEXT.showOf({ label })} onClick={() => onShow(t)}>
                      {THREADS_TEXT.show}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- channels (FR-088) ---------------------------------------------------------------------------

const BINDING_STATUS_ICON: Record<ChannelBindingView['status'], 'check' | 'stop' | 'alert'> = {
  connected: 'check',
  disconnected: 'stop',
  not_configured: 'alert',
};

export function AgentChannels({
  channels,
  error,
  threads,
  onShowThread,
  onRetry,
}: {
  channels: ChannelBindingView[] | null;
  error: string | null;
  threads: AgentThreadView[] | null;
  onShowThread: (t: AgentThreadView) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const manage = (
    <a href={CHANNELS_SETTINGS_PATH} onClick={(e) => followLink(e, CHANNELS_SETTINGS_PATH)}>
      {CHANNELS_TEXT.settingsLink}
    </a>
  );
  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{CHANNELS_TEXT.heading}</h2>
        <a
          href={CHANNELS_SETTINGS_PATH}
          className="nv-btn"
          data-variant="default"
          onClick={(e) => followLink(e, CHANNELS_SETTINGS_PATH)}
        >
          {CHANNELS_TEXT.manage}
        </a>
      </div>
      <p className="muted ws-flush">{rich(CHANNELS_TEXT.intro, { link: manage })}</p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={onRetry}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : channels === null ? (
        <Spinner label={CHANNELS_TEXT.loading} />
      ) : channels.length === 0 ? (
        <p className="muted">{rich(CHANNELS_TEXT.empty, { link: manage })}</p>
      ) : (
        <ul className="ws-list" aria-label={CHANNELS_TEXT.list}>
          {channels.map((c) => {
            const thread = threads?.find((t) => t.kind === 'binding' && t.bindingRef === c.id);
            const kind = CHANNEL_KIND_TEXT[c.kind];
            return (
              <li
                key={c.id}
                className="ws-list-row"
                aria-label={CHANNELS_TEXT.row({ kind, label: c.label })}
              >
                <div className="work-row-main">
                  <span className="ws-card-link" dir="auto">
                    <Icon name={CHANNEL_KIND_ICON[c.kind]} />{' '}
                    {CHANNELS_TEXT.name({ kind, label: c.label })}
                  </span>
                  <span className="muted ws-row-meta">
                    <span className="ws-badge" data-tone={c.status === 'connected' ? 'ok' : 'warn'}>
                      <Icon name={BINDING_STATUS_ICON[c.status]} /> {CHANNELS_TEXT.status[c.status]}
                    </span>
                    <span className="ws-badge" data-audience={c.audience}>
                      {c.audience === 'shared' ? AGENTS_TEXT.shared : AGENTS_TEXT.private}
                    </span>
                    {c.sharePrimaryThread ? <span>{CHANNELS_TEXT.usesMain}</span> : null}
                    <span>
                      {c.lastMessageAt
                        ? CHANNELS_TEXT.lastMessage({ when: formatWhen(c.lastMessageAt) })
                        : CHANNELS_TEXT.noMessages}
                    </span>
                  </span>
                  {c.statusDetail ? (
                    <span className="muted agent-text">{c.statusDetail}</span>
                  ) : null}
                </div>
                {thread ? (
                  <div className="ws-row-actions ws-toolbar">
                    <Button
                      aria-label={CHANNELS_TEXT.showThreadOf({ label: c.label })}
                      onClick={() => onShowThread(thread)}
                    >
                      {CHANNELS_TEXT.showThread}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- computer (FR-080, FR-087) ---------------------------------------------------------------------

export function AgentComputer({ agent }: { agent: AgentView }) {
  const api = useAgentsApi();
  const headingId = useId();
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [manual, setManual] = useState(0);
  const cid = agent.computerId;

  useEffect(() => {
    if (!cid) return;
    let alive = true;
    api.getAgentComputer(cid).then(
      (c) => {
        if (!alive) return;
        setComputer(c);
        setError(null);
      },
      (err: unknown) =>
        alive &&
        setError({
          message: errorMessage(err, COMPUTER_TEXT.loadFailed),
          missing: err instanceof ApiError && err.status === 404,
        }),
    );
    return () => {
      alive = false;
    };
  }, [api, cid, manual]);

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{COMPUTER_TEXT.heading}</h2>
      <p className="muted ws-flush">{COMPUTER_TEXT.intro}</p>
      {!cid ? (
        <p className="muted">
          <Spinner label={COMPUTER_TEXT.settingUp} /> {COMPUTER_TEXT.settingUpLong}
        </p>
      ) : error ? (
        <div className="ws-error" role="alert">
          <p>{error.missing ? COMPUTER_TEXT.gone : error.message}</p>
          {error.missing ? null : (
            <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
          )}
        </div>
      ) : computer === null ? (
        <Spinner label={COMPUTER_TEXT.loading} />
      ) : (
        <div className="panel-inset">
          <dl className="ws-dl">
            <dt>{COMPUTER_TEXT.kindLabel}</dt>
            <dd>{COMPUTER_TEXT.kind[computer.kind]}</dd>
            <dt>{COMPUTER_TEXT.state}</dt>
            <dd>
              <span className="ws-badge" data-state={computer.state}>
                <Icon name={COMPUTER_STATE_ICON[computer.state]} />{' '}
                {COMPUTER_STATE_TEXT[computer.state]}
              </span>
            </dd>
            {computer.detail ? (
              <>
                <dt>{COMPUTER_TEXT.details}</dt>
                <dd>{computer.detail}</dd>
              </>
            ) : null}
            <dt>{COMPUTER_TEXT.snapshots}</dt>
            <dd>{fmt.number(computer.snapshotCount)}</dd>
            <dt>{COMPUTER_TEXT.lastUsed}</dt>
            <dd>{formatWhen(computer.lastUsedAt)}</dd>
          </dl>
        </div>
      )}
      {cid && !error?.missing ? (
        <div className="ws-toolbar">
          <a
            href={computerPath(cid)}
            className="nv-btn"
            data-variant="primary"
            onClick={(e) => followLink(e, computerPath(cid))}
          >
            <Icon name="server" /> {COMPUTER_TEXT.open}
          </a>
        </div>
      ) : null}
      {/* One of your own computers, connected through novad (FR-081). */}
      <AgentComputerPanel agentId={agent.id} agentName={agent.name} />
    </section>
  );
}
