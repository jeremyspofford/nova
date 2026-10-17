// What an agent works through (FR-080, FR-083, FR-088; docs/09 §8, docs/04 §2.5): its background
// runs (each a Work run), its threads (main, one per channel binding, proactive research,
// background), its channel bindings (managed in Settings → Channels) and its computer (opened in
// the computers view). These sections read and link; the owning areas do the editing.
import { useEffect, useId, useState } from 'react';
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
  CHANNEL_KIND_ICON,
  CHANNEL_KIND_TEXT,
  CHANNELS_SETTINGS_PATH,
  COMPUTER_STATE_TEXT,
  computerPath,
  THREAD_KIND_ICON,
  THREAD_KIND_TEXT,
} from './format.ts';
import { AgentComputerPanel } from '../devices/Connections.tsx';

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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load background work.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Background work</h2>
      <p className="muted ws-flush">
        Work the agent handed off while it keeps talking with you. Each piece is a Work run you can
        open, pause or cancel; pausing the agent pauses them too.
      </p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <Spinner label="Loading background work" />
      ) : items.length === 0 ? (
        <p className="muted">Nothing in the background yet.</p>
      ) : (
        <ul className="ws-list" aria-label="Background work">
          {items.map((b) => (
            <li key={b.runId} className="ws-list-row">
              <div className="work-row-main">
                <a
                  href={runPath(b.runId)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, runPath(b.runId))}
                >
                  {b.title}
                </a>
                <span className="muted ws-row-meta">
                  <span className="work-badge" data-run={b.status}>
                    {runStatusText(b.status)}
                  </span>
                  <span>Started {formatWhen(b.createdAt)}</span>
                  {b.endedAt ? <span>Ended {formatWhen(b.endedAt)}</span> : null}
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
      <h2 id={headingId}>Threads</h2>
      <p className="muted ws-flush">
        Each channel has its own thread; the agent&apos;s memory is shared across them.
      </p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : threads === null ? (
        <Spinner label="Loading the threads" />
      ) : threads.length === 0 ? (
        <p className="muted">No threads yet.</p>
      ) : (
        <ul className="ws-list" aria-label="Agent threads">
          {threads.map((t) => {
            const label = threadLabel(t, channels);
            const shown =
              t.threadId === shownId || (shownId === null && t.threadId === agent.primaryThreadId);
            return (
              <li key={t.threadId} className="ws-list-row" aria-label={label}>
                <div className="work-row-main">
                  <span className="ws-card-link">
                    <Icon name={THREAD_KIND_ICON[t.kind]} /> {label}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>{THREAD_KIND_TEXT[t.kind]}</span>
                    <span className="ws-badge" data-audience={t.audience}>
                      {t.audience === 'shared' ? 'Shared' : 'Private'}
                    </span>
                    <span>Since {formatWhen(t.createdAt)}</span>
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
                      Open the run
                    </a>
                  ) : shown ? (
                    <span className="muted">Shown in the conversation</span>
                  ) : (
                    <Button aria-label={`Show ${label}`} onClick={() => onShow(t)}>
                      Show
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

const BINDING_STATUS: Record<
  ChannelBindingView['status'],
  { text: string; icon: 'check' | 'stop' | 'alert' }
> = {
  connected: { text: 'Connected', icon: 'check' },
  disconnected: { text: 'Turned off', icon: 'stop' },
  not_configured: { text: 'Needs setup', icon: 'alert' },
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
      Settings, Channels
    </a>
  );
  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>Channels</h2>
        <a
          href={CHANNELS_SETTINGS_PATH}
          className="nv-btn"
          data-variant="default"
          onClick={(e) => followLink(e, CHANNELS_SETTINGS_PATH)}
        >
          Manage channels
        </a>
      </div>
      <p className="muted ws-flush">
        Message the agent from Slack, Teams, email or a webhook. Bindings are set up in {manage}.
        Content from your private threads reaches a shared channel only through a policy check.
      </p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : channels === null ? (
        <Spinner label="Loading the channels" />
      ) : channels.length === 0 ? (
        <p className="muted">
          No channels yet. You can always message the agent here; to reach it from Slack, Teams,
          email or a webhook, add a binding in {manage}.
        </p>
      ) : (
        <ul className="ws-list" aria-label="Channel bindings">
          {channels.map((c) => {
            const thread = threads?.find((t) => t.kind === 'binding' && t.bindingRef === c.id);
            const st = BINDING_STATUS[c.status];
            return (
              <li
                key={c.id}
                className="ws-list-row"
                aria-label={`${CHANNEL_KIND_TEXT[c.kind]} ${c.label}`}
              >
                <div className="work-row-main">
                  <span className="ws-card-link">
                    <Icon name={CHANNEL_KIND_ICON[c.kind]} /> {CHANNEL_KIND_TEXT[c.kind]} ·{' '}
                    {c.label}
                  </span>
                  <span className="muted ws-row-meta">
                    <span className="ws-badge" data-tone={c.status === 'connected' ? 'ok' : 'warn'}>
                      <Icon name={st.icon} /> {st.text}
                    </span>
                    <span className="ws-badge" data-audience={c.audience}>
                      {c.audience === 'shared' ? 'Shared' : 'Private'}
                    </span>
                    {c.sharePrimaryThread ? <span>Uses the main thread</span> : null}
                    <span>
                      {c.lastMessageAt
                        ? `Last message ${formatWhen(c.lastMessageAt)}`
                        : 'No messages yet'}
                    </span>
                  </span>
                  {c.statusDetail ? (
                    <span className="muted agent-text">{c.statusDetail}</span>
                  ) : null}
                </div>
                {thread ? (
                  <div className="ws-row-actions ws-toolbar">
                    <Button
                      aria-label={`Show the thread of ${c.label}`}
                      onClick={() => onShowThread(thread)}
                    >
                      Show thread
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

const KIND_TEXT: Record<ComputerView['kind'], string> = {
  cloud: 'Cloud computer',
  local_container: 'Container on the Hub',
  local_host: 'The Hub itself',
};

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
          message: errorMessage(err, 'Could not load the computer.'),
          missing: err instanceof ApiError && err.status === 404,
        }),
    );
    return () => {
      alive = false;
    };
  }, [api, cid, manual]);

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Computer</h2>
      <p className="muted ws-flush">
        The agent&apos;s own computer keeps its files, installed software and browser sign-ins
        between sessions. You can watch it work and take over the keyboard and mouse.
      </p>
      {!cid ? (
        <p className="muted">
          <Spinner label="Setting up the computer" /> Its computer is being set up. Check back in a
          moment.
        </p>
      ) : error ? (
        <div className="ws-error" role="alert">
          <p>{error.missing ? 'This computer no longer exists.' : error.message}</p>
          {error.missing ? null : <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>}
        </div>
      ) : computer === null ? (
        <Spinner label="Loading the computer" />
      ) : (
        <div className="panel-inset">
          <dl className="ws-dl">
            <dt>Kind</dt>
            <dd>{KIND_TEXT[computer.kind]}</dd>
            <dt>State</dt>
            <dd>
              <span className="ws-badge" data-state={computer.state}>
                <Icon name={COMPUTER_STATE_TEXT[computer.state].icon} />{' '}
                {COMPUTER_STATE_TEXT[computer.state].text}
              </span>
            </dd>
            {computer.detail ? (
              <>
                <dt>Details</dt>
                <dd>{computer.detail}</dd>
              </>
            ) : null}
            <dt>Snapshots</dt>
            <dd>{computer.snapshotCount}</dd>
            <dt>Last used</dt>
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
            <Icon name="server" /> Open the computer
          </a>
        </div>
      ) : null}
      {/* One of your own computers, connected through novad (FR-081). */}
      <AgentComputerPanel agentId={agent.id} agentName={agent.name} />
    </section>
  );
}
