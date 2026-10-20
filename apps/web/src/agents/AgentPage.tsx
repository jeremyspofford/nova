// One agent (FR-079..FR-090, FR-181, FR-206; docs/04 §2.5, docs/09 §8): the header (avatar, name,
// status chip, its own state, autonomy, use), the controls (Pause, Resume, Stop, Research now,
// Delete), its conversation (the main thread, or another of its threads read-only), and its
// sections: Activity, Responsibilities, Goal, Rules, Memory, Suggestions, Schedules and wakes,
// Background work, Threads, Channels, Computer and Profile. `?tab=<id>` opens a section. Every
// part follows the agent's events on the shared stream.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentThreadView, AgentView, ChannelBindingView, EventEnvelope } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, StatusChip, Tabs, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { budgetLine, formatCost, formatSpan, formatTokens } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { AgentActivity } from './AgentActivity.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { AgentConversation } from './AgentConversation.tsx';
import { AgentGoal } from './AgentGoal.tsx';
import { AgentBackground, AgentChannels, AgentComputer, AgentThreads } from './AgentLinks.tsx';
import { AgentStateBadge, lastActiveText } from './AgentList.tsx';
import { AgentMemory } from './AgentMemory.tsx';
import { AgentProfile } from './AgentProfile.tsx';
import { AgentResponsibilities } from './AgentResponsibilities.tsx';
import { AgentRules } from './AgentRules.tsx';
import { AgentSchedules } from './AgentSchedules.tsx';
import { AgentSuggestions } from './AgentSuggestions.tsx';
import { useAgentsApi } from './api.ts';
import { eventAgentId, eventThreadRef, useAgentEvents } from './events.ts';
import { AGENT_AUTONOMY_TEXT, AGENTS_PATH, AGENTS_TEXT, agentPath } from './format.ts';
import { rich } from '../i18n/rich.tsx';
import '../workspace.css';
import '../work/work.css';
import './agents.css';
import { AgentPluginsSection } from '../team/AgentPlugins.tsx';
import { ScopedSiteLevels } from '../browser/SiteLevels.tsx';
import { OpenInWindowButton } from '../shellbridge/OpenInWindow.tsx';

export const PAGE_TEXT = defineMessages('agents.page', {
  missing: 'This agent was deleted or does not exist.',
  loadFailed: 'Could not load this agent.',
  threadsFailed: 'Could not load the threads.',
  channelsFailed: 'Could not load the channels.',
  deleted: 'This agent was deleted.',
  /** Said out loud when the agent's state changes. */
  announce:
    '{name} is {state, select, paused {paused} stopped {stopped} needs_input {needs input} blocked {blocked} running {working} other {ready}}.',
  resumed: '{name} resumed.',
  resumeFailed: 'Could not resume: {reason}',
  paused: '{name} paused, with its runs, schedules and wakes.',
  pauseFailed: 'Could not pause: {reason}',
  stopped: 'Stopped. Partial results are kept.',
  stopFailed: 'Could not stop: {reason}',
  researchStarted: 'Research started. Findings arrive as suggestions.',
  researchNotStarted: 'Research did not start: {reason}.',
  researchLater: 'Research did not start: try again later.',
  researchFailed: 'Could not start research: {reason}',
  deletedNamed: '{name} was deleted.',
  deleteFailed: 'Could not delete it: {reason}',
  loading: 'Loading the agent',
  tabs: {
    activity: 'Activity',
    responsibilities: 'Responsibilities',
    goal: 'Goal',
    rules: 'Rules',
    memory: 'Memory',
    suggestions: 'Suggestions',
    suggestionsOpen: 'Suggestions ({n})',
    schedules: 'Schedules',
    background: 'Background',
    threads: 'Threads',
    channels: 'Channels',
    computer: 'Computer',
    plugins: 'Plugins',
    profile: 'Profile',
  },
  region: 'Agent: {name}',
  autonomy: 'Autonomy: {level}',
  proactiveOn: 'Proactive research on',
  proactiveOff: 'Proactive research off',
  memoryOn: 'Memory on',
  memoryOff: 'Memory off',
  usedSoFar: 'Used so far: {time} · {tokens} tokens · {cost}',
  eachPiece: 'Each piece of work: {budget}',
  safetyPaused:
    'Safety monitoring paused this agent. Review its activity, then resume it when you are ready.',
  safetyPausedDetail:
    'Safety monitoring paused this agent: {detail}. Review its activity, then resume it when you are ready.',
  stoppedNote:
    'Stopped: its current work was cancelled and partial results kept. It answers new ' +
    'messages; Resume lets its schedules and goal go on.',
  controls: 'Agent controls',
  resume: 'Resume',
  pause: 'Pause',
  stop: 'Stop',
  research: 'Research now',
  sections: 'Agent sections',
  deleteTitle: 'Delete {name}?',
  /** The Hub's notice before deleting an agent (AGENT_DELETE_NOTICE in @nova/shared). */
  deleteNotice:
    'Deleting this agent is permanent. It removes its threads, notes, rules, schedules, wakes, ' +
    'channel bindings and grants. Actions it already took are not undone.',
  keep: 'Keep the agent',
  deletePermanently: 'Delete permanently',
});

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
  'plugins',
  'profile',
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Parts of the page that refetch when an event says they changed. */
type Part =
  'agent' | 'threads' | 'channels' | Exclude<AgentTab, 'computer' | 'profile' | 'plugins'>;

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
    message: missing ? PAGE_TEXT.missing : errorMessage(err, PAGE_TEXT.loadFailed),
    missing,
  };
}

function Breadcrumb() {
  return (
    <nav aria-label={AGENTS_TEXT.breadcrumb} className="ws-breadcrumb">
      <a href={AGENTS_PATH} onClick={(e) => followLink(e, AGENTS_PATH)}>
        <Icon name="back" /> {AGENTS_TEXT.agents}
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
      (err: unknown) => alive && setThreadsError(errorMessage(err, PAGE_TEXT.threadsFailed)),
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
      (err: unknown) => alive && setChannelsError(errorMessage(err, PAGE_TEXT.channelsFailed)),
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
        setError({ message: PAGE_TEXT.deleted, missing: true });
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
      const state = agent.status === 'active' ? agent.derived.status : agent.status;
      announce(PAGE_TEXT.announce({ name: agent.name, state }));
    }
    lastState.current = line;
  }, [agent, announce]);

  // ---- controls ----------------------------------------------------------------------------------
  const control = (
    call: (id: string) => Promise<AgentView>,
    done: string,
    failed: (p: { reason: string }) => string,
  ): void => {
    call(agentId).then(
      (a) => {
        setAgent(a);
        bumpNow(['activity', 'schedules', 'background']);
        toast.show(done, { tone: 'success' });
      },
      (err: unknown) => toast.show(failed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };
  const research = () => {
    api.researchAgent(agentId).then(
      (r) => {
        if (r.started) {
          toast.show(PAGE_TEXT.researchStarted, { tone: 'success' });
          bumpNow(['activity', 'threads']);
        } else {
          toast.show(
            r.reason ? PAGE_TEXT.researchNotStarted({ reason: r.reason }) : PAGE_TEXT.researchLater,
            { tone: 'info' },
          );
        }
      },
      (err: unknown) =>
        toast.show(PAGE_TEXT.researchFailed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };
  const remove = () => {
    setDeleting(true);
    api.deleteAgent(agentId).then(
      () => {
        setConfirmDelete(false);
        toast.show(agent ? PAGE_TEXT.deletedNamed({ name: agent.name }) : PAGE_TEXT.deleted, {
          tone: 'success',
        });
        navigate(AGENTS_PATH);
      },
      (err: unknown) => {
        setDeleting(false);
        toast.show(PAGE_TEXT.deleteFailed({ reason: errorMessage(err) }), { tone: 'error' });
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
          {error.missing ? null : (
            <Button onClick={() => setAttempt((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
          )}
        </div>
      </div>
    );
  if (!agent)
    return (
      <div className="ws-page agents-page">
        <Breadcrumb />
        <Spinner label={PAGE_TEXT.loading} />
      </div>
    );
  const T = PAGE_TEXT.tabs;

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
      label: T.activity,
      panel: <AgentActivity agentId={agentId} version={versions.activity} />,
    },
    {
      id: 'responsibilities',
      label: T.responsibilities,
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
      label: T.goal,
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
      label: T.rules,
      panel: <AgentRules agentId={agentId} version={versions.rules} />,
    },
    {
      id: 'memory',
      label: T.memory,
      panel: <AgentMemory agent={agent} version={versions.memory} onAgent={setAgent} />,
    },
    {
      id: 'suggestions',
      label: agent.openSuggestions
        ? T.suggestionsOpen({ n: agent.openSuggestions })
        : T.suggestions,
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
      label: T.schedules,
      panel: <AgentSchedules agent={agent} version={versions.schedules} />,
    },
    {
      id: 'background',
      label: T.background,
      panel: <AgentBackground agentId={agentId} version={versions.background} />,
    },
    {
      id: 'threads',
      label: T.threads,
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
      label: T.channels,
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
    {
      id: 'computer',
      label: T.computer,
      panel: (
        <>
          <AgentComputer agent={agent} />
          {/* This agent's own site permission levels (FR-094, M7). */}
          <ScopedSiteLevels
            scopeKind="agent"
            scopeRef={agent.id}
            scopeName={agent.name}
            headingLevel={3}
          />
        </>
      ),
    },
    // The plugins connected to this agent: only their tools are usable (FR-045, M7).
    { id: 'plugins', label: T.plugins, panel: <AgentPluginsSection agentId={agentId} /> },
    {
      id: 'profile',
      label: T.profile,
      panel: <AgentProfile key={agent.updatedAt} agent={agent} onAgent={setAgent} />,
    },
  ];

  return (
    <div className="agent-page" aria-label={PAGE_TEXT.region({ name: agent.name })} role="region">
      <header className="agent-header">
        <Breadcrumb />
        <div className="agent-title-row">
          <AgentAvatar agent={agent} size="lg" />
          <div className="agent-title">
            <div className="ws-page-header">
              <h1>{agent.name}</h1>
              <OpenInWindowButton path={agentPath(agentId)} what={agent.name} compact />
              <StatusChip
                status={agent.derived.status}
                reason={agent.derived.reason ?? undefined}
              />
              <AgentStateBadge agent={agent} />
            </div>
            <p className="muted ws-row-meta">
              <span>
                {PAGE_TEXT.autonomy({ level: AGENT_AUTONOMY_TEXT[agent.autonomy].label })}
              </span>
              <span>
                {agent.proactive.enabled ? PAGE_TEXT.proactiveOn : PAGE_TEXT.proactiveOff}
              </span>
              <span>{agent.memoryEnabled ? PAGE_TEXT.memoryOn : PAGE_TEXT.memoryOff}</span>
              <span>{lastActiveText(agent)}</span>
            </p>
            <p className="muted ws-row-meta">
              <span>
                {PAGE_TEXT.usedSoFar({
                  time: formatSpan(agent.usage.timeSeconds),
                  tokens: formatTokens(agent.usage.tokens),
                  cost: formatCost(agent.usage.costUsd),
                })}
              </span>
              <span>{PAGE_TEXT.eachPiece({ budget: budgetLine(agent.budgets) })}</span>
            </p>
          </div>
        </div>
        {paused && agent.pauseReason === 'safety' ? (
          <p className="ws-callout" role="note">
            <Icon name="shield" />
            <span>
              {agent.statusDetail
                ? rich(PAGE_TEXT.safetyPausedDetail, {
                    detail: <span data-untrusted="true">{agent.statusDetail}</span>,
                  })
                : PAGE_TEXT.safetyPaused}
            </span>
          </p>
        ) : agent.status === 'stopped' ? (
          <p className="muted ws-flush">{PAGE_TEXT.stoppedNote}</p>
        ) : null}
        <div className="ws-toolbar" role="group" aria-label={PAGE_TEXT.controls}>
          {paused ? (
            <Button
              onClick={() =>
                control(
                  api.resumeAgent,
                  PAGE_TEXT.resumed({ name: agent.name }),
                  PAGE_TEXT.resumeFailed,
                )
              }
            >
              <Icon name="forward" /> {PAGE_TEXT.resume}
            </Button>
          ) : (
            <Button
              onClick={() =>
                control(
                  api.pauseAgent,
                  PAGE_TEXT.paused({ name: agent.name }),
                  PAGE_TEXT.pauseFailed,
                )
              }
            >
              <Icon name="clock" /> {PAGE_TEXT.pause}
            </Button>
          )}
          {agent.status === 'stopped' ? (
            <Button
              onClick={() =>
                control(
                  api.resumeAgent,
                  PAGE_TEXT.resumed({ name: agent.name }),
                  PAGE_TEXT.resumeFailed,
                )
              }
            >
              <Icon name="forward" /> {PAGE_TEXT.resume}
            </Button>
          ) : null}
          {agent.status === 'active' ? (
            <Button onClick={() => control(api.stopAgent, PAGE_TEXT.stopped, PAGE_TEXT.stopFailed)}>
              <Icon name="stop" /> {PAGE_TEXT.stop}
            </Button>
          ) : null}
          <Button
            onClick={research}
            disabled={paused}
            title={paused ? AGENTS_TEXT.resumeFirst : undefined}
          >
            <Icon name="search" /> {PAGE_TEXT.research}
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" /> {AGENTS_TEXT.delete}
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
            label={PAGE_TEXT.sections}
            className="agent-tabs"
            value={tab}
            onChange={setTab}
            items={tabs}
          />
        </div>
      </div>
      <Dialog
        open={confirmDelete}
        title={PAGE_TEXT.deleteTitle({ name: agent.name })}
        description={PAGE_TEXT.deleteNotice}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
              {PAGE_TEXT.keep}
            </Button>
            <Button variant="danger" onClick={remove} disabled={deleting}>
              {deleting ? <Spinner /> : null} {PAGE_TEXT.deletePermanently}
            </Button>
          </>
        }
      />
    </div>
  );
}
