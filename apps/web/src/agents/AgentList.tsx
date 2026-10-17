// The Agents list (FR-079, FR-090, FR-215; docs/04 §1, §1.1, §2.5): every always-on agent with its
// avatar, status chip, its own state (Paused, Stopped), last activity, responsibilities and open
// suggestions. Needs input sorts first, then Blocked, Running and Ready. The list follows agent
// events and the derived status of their threads. `/agents/new` creates one.
import { useEffect, useState } from 'react';
import type { AgentView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, StatusChip } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { formatWhen, plural } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { statusRank } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { useAgentsApi } from './api.ts';
import { useAgentEvents } from './events.ts';
import { agentPath, agentStateBadge, NEW_AGENT_PATH } from './format.ts';
import '../workspace.css';
import '../work/work.css';
import './agents.css';

/** Needs input first, then Blocked, Running and Ready; most recently active first within each. */
export function sortAgents(list: readonly AgentView[]): AgentView[] {
  return [...list].sort(
    (a, b) =>
      statusRank(a.derived.status) - statusRank(b.derived.status) ||
      (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt),
  );
}

/** The account's agents, kept current by agent and thread status events. */
export function useAgentList(): {
  agents: AgentView[] | null;
  error: string | null;
  retry: () => void;
} {
  const api = useAgentsApi();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    // Through a promise, so a client without the agents calls fails quietly (the sidebar is
    // always mounted).
    Promise.resolve()
      .then(() => api.listAgents())
      .then(
        ({ items }) => {
          if (!alive) return;
          setAgents(items);
          setError(null);
        },
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load agents.')),
      );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = useDebounced(() => setVersion((v) => v + 1), 200);
  useAgentEvents((env) => {
    if (env.name.startsWith('agent.') || env.name === 'thread.status.changed') reload();
  }, reload);
  return { agents, error, retry: () => setVersion((v) => v + 1) };
}

export function lastActiveText(a: Pick<AgentView, 'lastActiveAt'>): string {
  return a.lastActiveAt ? `Active ${formatWhen(a.lastActiveAt)}` : 'Not active yet';
}

export function AgentStateBadge({ agent }: { agent: Pick<AgentView, 'status' | 'pauseReason'> }) {
  const badge = agentStateBadge(agent);
  if (!badge) return null;
  return (
    <span className="ws-badge agent-state" data-state={agent.status}>
      <Icon name={badge.icon} /> {badge.text}
    </span>
  );
}

export function AgentList() {
  const { agents, error, retry } = useAgentList();
  const shown = agents ? sortAgents(agents) : null;

  return (
    <div className="ws-page agents-page">
      <header className="ws-page-header">
        <h1>Agents</h1>
        <Button variant="primary" onClick={() => navigate(NEW_AGENT_PATH)}>
          <Icon name="plus" /> New agent
        </Button>
      </header>
      <p className="muted ws-flush">
        An agent keeps working on its responsibilities in the background, with its own computer,
        memory and rules. It asks you when an action needs a decision.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={retry}>Retry</Button>
        </div>
      ) : null}
      {shown === null && !error ? <Spinner label="Loading agents" /> : null}
      {shown?.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create an agent to watch an inbox, follow a project or prepare a weekly report. You choose what it may do on its own."
          icon="agents"
          level={2}
          action={<Button onClick={() => navigate(NEW_AGENT_PATH)}>Create an agent</Button>}
        />
      ) : null}
      {shown?.length ? (
        <ul className="ws-list" aria-label="Agents">
          {shown.map((a) => (
            <li key={a.id} className="ws-list-row agent-row">
              <AgentAvatar agent={a} />
              <div className="work-row-main">
                <a
                  href={agentPath(a.id)}
                  className="ws-card-link"
                  onClick={(e) => followLink(e, agentPath(a.id))}
                >
                  {a.name}
                </a>
                <span className="muted ws-row-meta">
                  <AgentStateBadge agent={a} />
                  <span>{lastActiveText(a)}</span>
                  {a.responsibilities.length ? (
                    <span>
                      {plural(a.responsibilities.length, 'responsibility', 'responsibilities')}
                    </span>
                  ) : null}
                  {a.openSuggestions ? (
                    <span className="ws-badge">
                      <Icon name="bell" /> {plural(a.openSuggestions, 'suggestion')}
                    </span>
                  ) : null}
                </span>
              </div>
              <StatusChip status={a.derived.status} reason={a.derived.reason ?? undefined} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
