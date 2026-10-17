// One agent (FR-079..FR-090, FR-181, FR-206; docs/04 §2.5, docs/09 §8): the header (avatar, name,
// status chip, its own state, autonomy, use), the controls (Pause, Resume, Stop, Research now,
// Delete), its conversation (the main thread, or another of its threads read-only), and its
// sections: Activity, Responsibilities, Goal, Rules, Memory, Suggestions, Schedules and wakes,
// Background work, Threads, Channels, Computer and Profile. `?tab=<id>` opens a section. Every
// part follows the agent's events on the shared stream.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AGENT_DELETE_NOTICE,
  type AgentThreadView,
  type AgentView,
  type ChannelBindingView,
  type EventEnvelope,
} from '@nova/shared';
import { Button, Dialog, Icon, Spinner, StatusChip, Tabs, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { budgetLine, formatCost, formatSpan, formatTokens } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { AgentActivity } from './AgentActivity.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { AgentConversation } from './AgentConversation.tsx';
import { AgentGoal } from './AgentGoal.tsx';
import { AgentBackground, AgentChannels, AgentComputer, AgentThreads } from './AgentLinks.tsx';
import { AgentStateBadge } from './AgentList.tsx';
import { AgentMemory } from './AgentMemory.tsx';
import { AgentProfile } from './AgentProfile.tsx';
import { AgentResponsibilities } from './AgentResponsibilities.tsx';
import { AgentRules } from './AgentRules.tsx';
import { AgentSchedules } from './AgentSchedules.tsx';
import { AgentSuggestions } from './AgentSuggestions.tsx';
import { useAgentsApi } from './api.ts';
import { eventAgentId, eventThreadRef, useAgentEvents } from './events.ts';
import { AGENT_AUTONOMY_TEXT, AGENTS_PATH, agentPath } from './format.ts';
import '../workspace.css';
import '../work/work.css';
import './agents.css';

export const AGENT_TABS = [
  'activity',
  'responsibilities',
  'goal',
  'rules',
  'memory',
  'suggestions',
  'schedules',
  'background',
  'threads',
  'channels',
  'computer',
  'profile',
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Parts of the page that refetch when an event says they changed. */
type Part = 'agent' | 'threads' | 'channels' | Exclude<AgentTab, 'computer' | 'profile'>;

/** Which parts an event about this agent touches. */
export function partsFor(name: string): Part[] {
  if (name === 'agent.rule.changed') return ['rules', 'activity'];
  if (name === 'agent.responsibility.changed') return ['agent', 'responsibilities', 'goal'];
  if (name.startsWith('agent.note.') || name === 'agent.memory.purged') return ['memory'];
  if (name.startsWith('memory.item.')) return ['memory'];
  if (name.startsWith('agent.suggestion.')) return ['agent', 'suggestions'];
  if (name === 'agent.research.finding') return ['activity', 'suggestions', 'memory'];
  if (name === 'agent.background.started') return ['background', 'activity', 'threads'];
  if (name.startsWith('goal.')) return ['agent', 'goal', 'responsibilities', 'activity'];
  if (name.startsWith('schedule.')) return ['schedules', 'activity'];
  if (name.startsWith('run.')) return ['background', 'activity'];
  // created, updated, paused, resumed, status changed, budget reached
  return ['agent', 'activity', 'schedules', 'background', 'threads'];
}

function loadError(err: unknown): { message: string; missing: boolean } {
  const missing = err instanceof ApiError && err.status === 404;
  return {
    message: missing
      ? 'This agent was deleted or does not exist.'
      : errorMessage(err, 'Could not load this agent.'),
    missing,
  };
}

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={AGENTS_PATH} onClick={(e) => followLink(e, AGENTS_PATH)}>
        <Icon name="back" /> Agents
      </a>
    </nav>
  );
}

export function AgentPage({ agentId }: { agentId: string }) {
  const api = useAgentsApi();
  const toast = useToast();
  const announce = useAnnounce();
  const loc = useLocation();
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [threads, setThreads] = useState<AgentThreadView[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelBindingView[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [shown, setShown] = useState<AgentThreadView | null>(null);
  const [versions, setVersions] = useState<Record<Part, number>>({
    agent: 0,
    threads: 0,
    channels: 0,
    activity: 0,
    responsibilities: 0,
    goal: 0,
    rules: 0,
    memory: 0,
    suggestions: 0,
    schedules: 0,
    background: 0,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const lastState = useRef<string | null>(null);

  const query = new URLSearchParams(loc.includes('?') ? loc.slice(loc.indexOf('?') + 1) : '');
  const asked = query.get('tab');
  const tab: AgentTab = (AGENT_TABS as readonly string[]).includes(asked ?? '')
    ? (asked as AgentTab)
    : 'activity';
  const setTab = (t: string) => navigate(agentPath(agentId, t), { replace: true });

  // ---- loading ---------------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    api.getAgent(agentId).then(
      (a) => {
        if (!alive) return;
        setAgent(a);
        setError(null);
      },
      (err: unknown) => alive && setError(loadError(err)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, attempt, versions.agent]);

  useEffect(() => {
    let alive = true;
    api.agentThreads(agentId).then(
      ({ items }) => {
        if (!alive) return;
        setThreads(items);
        setThreadsError(null);
      },
      (err: unknown) => alive && setThreadsError(errorMessage(err, 'Could not load the threads.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, versions.threads]);

  useEffect(() => {
    let alive = true;
    api.listAgentChannels(agentId).then(
      ({ items }) => {
        if (!alive) return;
        setChannels(items);
        setChannelsError(null);
      },
      (err: unknown) =>
        alive && setChannelsError(errorMessage(err, 'Could not load the channels.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, versions.channels]);

  // ---- live updates ------------------------------------------------------------------------------
  const pending = useRef(new Set<Part>());
  const flush = useDebounced(() => {
    const parts = [...pending.current];
    pending.current.clear();
    setVersions((v) => {
      const next = { ...v };
      for (const p of parts) next[p] += 1;
      return next;
    });
  }, 150);
  const bump = (parts: Part[]) => {
    for (const p of parts) pending.current.add(p);
    flush();
  };
  const bumpNow = (parts: Part[]) =>
    setVersions((v) => {
      const next = { ...v };
      for (const p of parts) next[p] += 1;
      return next;
    });

  const threadIds = new Set((threads ?? []).map((t) => t.threadId));
  if (agent?.primaryThreadId) threadIds.add(agent.primaryThreadId);
  useAgentEvents(
    (env: EventEnvelope) => {
      if (env.name === 'thread.status.changed') {
        const ref = eventThreadRef(env);
        if (ref && threadIds.has(ref)) bump(['agent']);
        return;
      }
      const about = eventAgentId(env);
      if (env.name === 'agent.deleted' && about === agentId) {
        setError({ message: 'This agent was deleted.', missing: true });
        return;
      }
      // Schedule and run events do not name the agent; they refetch only what may list them.
      if (env.name.startsWith('schedule.') && !about) {
        bump(['schedules']);
        return;
      }
      if (env.name.startsWith('run.')) {
        bump(['background']);
        return;
      }
      if (env.name.startsWith('goal.') && about !== agentId) {
        if (agent?.goalId && env.payload.goalId === agent.goalId) bump(partsFor(env.name));
        return;
      }
      if (about !== agentId) return;
      bump(partsFor(env.name));
    },
    () => bump(['agent', 'threads', 'channels', 'activity']),
  );

  // Say a change of state out loud once (docs/04 §4.4).
  useEffect(() => {
    if (!agent) return;
    const line = `${agent.status}:${agent.derived.status}`;
    if (lastState.current !== null && lastState.current !== line) {
      const what =
        agent.status === 'paused'
          ? 'paused'
          : agent.status === 'stopped'
            ? 'stopped'
            : agent.derived.status === 'needs_input'
              ? 'needs input'
              : agent.derived.status === 'blocked'
                ? 'blocked'
                : agent.derived.status === 'running'
                  ? 'working'
                  : 'ready';
      announce(`${agent.name} is ${what}.`);
    }
    lastState.current = line;
  }, [agent, announce]);

  // ---- controls ----------------------------------------------------------------------------------
  const control = (call: (id: string) => Promise<AgentView>, done: string, what: string): void => {
    call(agentId).then(
      (a) => {
        setAgent(a);
        bumpNow(['activity', 'schedules', 'background']);
        toast.show(done, { tone: 'success' });
      },
      (err: unknown) => toast.show(`${what}: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };
  const research = () => {
    api.researchAgent(agentId).then(
      (r) => {
        if (r.started) {
          toast.show('Research started. Findings arrive as suggestions.', { tone: 'success' });
          bumpNow(['activity', 'threads']);
        } else {
          toast.show(`Research did not start: ${r.reason ?? 'try again later'}.`, {
            tone: 'info',
          });
        }
      },
      (err: unknown) =>
        toast.show(`Could not start research: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };
  const remove = () => {
    setDeleting(true);
    api.deleteAgent(agentId).then(
      () => {
        setConfirmDelete(false);
        toast.show(`${agent?.name ?? 'The agent'} was deleted.`, { tone: 'success' });
        navigate(AGENTS_PATH);
      },
      (err: unknown) => {
        setDeleting(false);
        toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  // ---- render ------------------------------------------------------------------------------------
  if (error)
    return (
      <div className="ws-page agents-page">
        <Breadcrumb />
        <div role="alert" className="ws-error">
          <p>{error.message}</p>
          {error.missing ? null : <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
        </div>
      </div>
    );
  if (!agent)
    return (
      <div className="ws-page agents-page">
        <Breadcrumb />
        <Spinner label="Loading the agent" />
      </div>
    );

  const paused = agent.status === 'paused';
  const showThread = (t: AgentThreadView) => {
    setShown(t.threadId === agent.primaryThreadId ? null : t);
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>('.agent-conversation')
        ?.scrollIntoView?.({ block: 'start' }),
    );
  };

  const tabs: { id: AgentTab; label: string; panel: ReactNode }[] = [
    {
      id: 'activity',
      label: 'Activity',
      panel: <AgentActivity agentId={agentId} version={versions.activity} />,
    },
    {
      id: 'responsibilities',
      label: 'Responsibilities',
      panel: (
        <AgentResponsibilities
          agentId={agentId}
          goalId={agent.goalId}
          version={versions.responsibilities}
          onOpenGoal={() => setTab('goal')}
        />
      ),
    },
    {
      id: 'goal',
      label: 'Goal',
      panel: (
        <AgentGoal
          agentId={agentId}
          version={versions.goal}
          onChanged={() => bumpNow(['agent', 'responsibilities'])}
        />
      ),
    },
    {
      id: 'rules',
      label: 'Rules',
      panel: <AgentRules agentId={agentId} version={versions.rules} />,
    },
    {
      id: 'memory',
      label: 'Memory',
      panel: <AgentMemory agent={agent} version={versions.memory} onAgent={setAgent} />,
    },
    {
      id: 'suggestions',
      label: agent.openSuggestions ? `Suggestions (${agent.openSuggestions})` : 'Suggestions',
      panel: (
        <AgentSuggestions
          agentId={agentId}
          version={versions.suggestions}
          onDecided={() => bumpNow(['agent'])}
        />
      ),
    },
    {
      id: 'schedules',
      label: 'Schedules',
      panel: <AgentSchedules agent={agent} version={versions.schedules} />,
    },
    {
      id: 'background',
      label: 'Background',
      panel: <AgentBackground agentId={agentId} version={versions.background} />,
    },
    {
      id: 'threads',
      label: 'Threads',
      panel: (
        <AgentThreads
          agent={agent}
          threads={threads}
          error={threadsError}
          channels={channels ?? []}
          shownId={shown?.threadId ?? null}
          onShow={showThread}
          onRetry={() => bumpNow(['threads'])}
        />
      ),
    },
    {
      id: 'channels',
      label: 'Channels',
      panel: (
        <AgentChannels
          channels={channels}
          error={channelsError}
          threads={threads}
          onShowThread={showThread}
          onRetry={() => bumpNow(['channels'])}
        />
      ),
    },
    { id: 'computer', label: 'Computer', panel: <AgentComputer agent={agent} /> },
    {
      id: 'profile',
      label: 'Profile',
      panel: <AgentProfile key={agent.updatedAt} agent={agent} onAgent={setAgent} />,
    },
  ];

  return (
    <div className="agent-page" aria-label={`Agent: ${agent.name}`} role="region">
      <header className="agent-header">
        <Breadcrumb />
        <div className="agent-title-row">
          <AgentAvatar agent={agent} size="lg" />
          <div className="agent-title">
            <div className="ws-page-header">
              <h1>{agent.name}</h1>
              <StatusChip
                status={agent.derived.status}
                reason={agent.derived.reason ?? undefined}
              />
              <AgentStateBadge agent={agent} />
            </div>
            <p className="muted ws-row-meta">
              <span>Autonomy: {AGENT_AUTONOMY_TEXT[agent.autonomy].label}</span>
              <span>Proactive research {agent.proactive.enabled ? 'on' : 'off'}</span>
              <span>Memory {agent.memoryEnabled ? 'on' : 'off'}</span>
              <span>
                {agent.lastActiveAt ? `Active ${formatWhen(agent.lastActiveAt)}` : 'Not active yet'}
              </span>
            </p>
            <p className="muted ws-row-meta">
              <span>
                Used so far: {formatSpan(agent.usage.timeSeconds)} ·{' '}
                {formatTokens(agent.usage.tokens)} tokens · {formatCost(agent.usage.costUsd)}
              </span>
              <span>Each piece of work: {budgetLine(agent.budgets)}</span>
            </p>
          </div>
        </div>
        {paused && agent.pauseReason === 'safety' ? (
          <p className="ws-callout" role="note">
            <Icon name="shield" />
            <span>
              Safety monitoring paused this agent
              {agent.statusDetail ? (
                <>
                  : <span data-untrusted="true">{agent.statusDetail}</span>
                </>
              ) : null}
              . Review its activity, then resume it when you are ready.
            </span>
          </p>
        ) : agent.status === 'stopped' ? (
          <p className="muted ws-flush">
            Stopped: its current work was cancelled and partial results kept. It answers new
            messages; Resume lets its schedules and goal go on.
          </p>
        ) : null}
        <div className="ws-toolbar" role="group" aria-label="Agent controls">
          {paused ? (
            <Button
              onClick={() => control(api.resumeAgent, `${agent.name} resumed.`, 'Could not resume')}
            >
              <Icon name="forward" /> Resume
            </Button>
          ) : (
            <Button
              onClick={() =>
                control(
                  api.pauseAgent,
                  `${agent.name} paused, with its runs, schedules and wakes.`,
                  'Could not pause',
                )
              }
            >
              <Icon name="clock" /> Pause
            </Button>
          )}
          {agent.status === 'stopped' ? (
            <Button
              onClick={() => control(api.resumeAgent, `${agent.name} resumed.`, 'Could not resume')}
            >
              <Icon name="forward" /> Resume
            </Button>
          ) : null}
          {agent.status === 'active' ? (
            <Button
              onClick={() =>
                control(api.stopAgent, 'Stopped. Partial results are kept.', 'Could not stop')
              }
            >
              <Icon name="stop" /> Stop
            </Button>
          ) : null}
          <Button
            onClick={research}
            disabled={paused}
            title={paused ? 'Resume the agent first' : undefined}
          >
            <Icon name="search" /> Research now
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" /> Delete
          </Button>
        </div>
      </header>
      <div className="agent-body">
        <div className="agent-conversation">
          <AgentConversation
            agent={agent}
            thread={shown}
            channels={channels ?? []}
            onMain={() => setShown(null)}
          />
        </div>
        <div className="agent-sections">
          <Tabs
            label="Agent sections"
            className="agent-tabs"
            value={tab}
            onChange={setTab}
            items={tabs}
          />
        </div>
      </div>
      <Dialog
        open={confirmDelete}
        title={`Delete ${agent.name}?`}
        description={AGENT_DELETE_NOTICE}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Keep the agent
            </Button>
            <Button variant="danger" onClick={remove} disabled={deleting}>
              {deleting ? <Spinner /> : null} Delete permanently
            </Button>
          </>
        }
      />
    </div>
  );
}
