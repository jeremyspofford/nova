import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Plus, X } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, EmptyState, Skeleton } from '../../components/ui'
import {
  createAgent as apiCreateAgent,
  listAgents as apiListAgents,
  listSkills as apiListSkills,
  listTools as apiListTools,
  type Agent,
  type AgentSaved,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { AgentForm } from './AgentForm'
import { spendWords, statePill } from './agentsFormat'

/**
 * Agents (S12): the roster of what the household runs — every agent, what
 * it is for, whether it is working right now and on what, what it spent
 * this month, when it last ran, how many tools it holds. Read straight off
 * GET /api/v1/agents (services/core/app/agents_api.py); every fact beyond
 * the row's own columns is DERIVED there at the request, and this page
 * shows it as returned: a null spend is "unreadable" with the server's
 * reason, never a 0; a state is the process's own DOING map, never a flag.
 *
 * The roster is re-read on a light poll while the page is open (the
 * Schedules page's idiom, and never tighter than its 5 s here) because state
 * moves as agents work. A poll failure keeps the last list and states why
 * the banner is up until a read succeeds again.
 *
 * "New agent" opens the one form (AgentForm) in a wide sheet; a create is
 * one POST whose answer is the row the store read back, and the roster is
 * re-read after it so what is shown is the server's list, not the draft.
 *
 * `notice` is the one-time line the agent page hands over after a delete
 * (App.tsx's route wrapper reads it off the navigation state) — the
 * server's own summary of what was paused and what remains.
 *
 * `api` is the same dependency-injection seam every page uses; `pollMs` is
 * exposed so a test can drive the poll without waiting seconds.
 */
interface AgentsApi {
  listAgents: typeof apiListAgents
  createAgent: typeof apiCreateAgent
  listTools: typeof apiListTools
  listSkills: typeof apiListSkills
}

const DEFAULT_API: AgentsApi = {
  listAgents: apiListAgents,
  createAgent: apiCreateAgent,
  listTools: apiListTools,
  listSkills: apiListSkills,
}

/** Never tighter: the roster's derived reads (four queries and a ledger
 * report per poll) are shared with everything else core is doing. */
export const ROSTER_POLL_MS = 5_000

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function AgentsPage({
  api = DEFAULT_API,
  pollMs = ROSTER_POLL_MS,
  notice = null,
}: {
  api?: AgentsApi
  pollMs?: number
  notice?: string | null
} = {}) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [shownNotice, setShownNotice] = useState<string | null>(notice)
  // The just-created agent's server sentence (the store's read-back), shown
  // once above the roster so the route outcome is seen, not assumed.
  const [created, setCreated] = useState<AgentSaved | null>(null)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  const refresh = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
      setError(null)
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    let live = true
    setError(null)
    api
      .listAgents()
      .then(rows => {
        if (live) setAgents(rows)
      })
      .catch(err => {
        if (live) setError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api])

  // The light poll: a failure keeps the last known roster (a blip is not "no
  // agents") but is not hidden — the banner states it until a read succeeds.
  useEffect(() => {
    let live = true
    const id = setInterval(() => {
      api
        .listAgents()
        .then(rows => {
          if (!live) return
          setAgents(rows)
          setError(null)
        })
        .catch(err => {
          if (live) setError(reasonOf(err))
        })
    }, pollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, pollMs])

  const onSaved = useCallback(
    (saved: AgentSaved) => {
      setCreated(saved)
      setCreating(false)
      void refresh()
    },
    [refresh],
  )

  return (
    <div>
      <PageHeader
        title="Agents"
        description="What the household runs besides Nova — each one a purpose, a tool subset, a folder and a routing role of its own."
        actions={
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setCreating(true)}>
            New agent
          </Button>
        }
      />

      {shownNotice && (
        <div
          role="status"
          data-testid="agents-notice"
          className="mb-6 flex items-start justify-between gap-3 rounded-sm border border-border bg-surface-elevated px-4 py-3 text-compact text-content-secondary"
        >
          <span>{shownNotice}</span>
          <button
            type="button"
            className="text-content-tertiary hover:text-content-primary"
            onClick={() => setShownNotice(null)}
            aria-label="dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {created && (
        <div
          role="status"
          data-testid="agent-created"
          className="mb-6 flex items-start justify-between gap-3 rounded-sm border border-success/30 bg-success-dim px-4 py-3 text-compact text-success"
        >
          <span>
            {created.text}
            {!created.route.registered && (
              <span className="block text-warning">{created.route.detail}</span>
            )}
          </span>
          <button
            type="button"
            className="text-content-tertiary hover:text-content-primary"
            onClick={() => setCreated(null)}
            aria-label="dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load agents: {error}
        </div>
      )}

      {agents === null ? (
        !error && (
          <div data-testid="agents-skeleton">
            <Skeleton lines={4} />
          </div>
        )
      ) : agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Create one, or ask Nova to — she can make one from chat."
          action={{ label: 'New agent', onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
          <table className="w-full text-compact" data-testid="agents-list">
            <thead>
              <tr className="bg-surface-elevated">
                {['Name', 'Purpose', 'State', 'Spent this month', 'Last active', 'Tools'].map(heading => (
                  <th
                    key={heading}
                    className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider sticky top-0 bg-surface-elevated"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {agents.map(agent => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AgentForm
        open={creating}
        onClose={() => setCreating(false)}
        onSave={body => api.createAgent(body)}
        onSaved={onSaved}
        api={api}
      />
    </div>
  )
}

/** The working/idle pill — the server's derived state, pulsing while it works. */
export function StatePill({ agent }: { agent: Pick<Agent, 'state'> }) {
  const pill = statePill(agent.state)
  return (
    <span data-testid="state-pill" data-working={pill.pulse ? 'true' : 'false'}>
      <Badge
        size="sm"
        color={pill.color}
        dot={pill.pulse}
        className={pill.pulse ? 'animate-pulse-slow' : undefined}
      >
        {pill.label}
      </Badge>
    </span>
  )
}

/** The month's spend, or "unreadable" with the server's reason as the title. */
export function SpendCell({ agent }: { agent: Pick<Agent, 'spent_month_usd' | 'spend_note'> }) {
  const words = spendWords(agent.spent_month_usd, agent.spend_note)
  return (
    <span
      className={words.unreadable ? 'text-warning' : 'font-mono text-content-secondary'}
      title={words.title}
      data-testid="spend"
    >
      {words.text}
    </span>
  )
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <tr data-testid={`agent-row-${agent.name}`} className="hover:bg-surface-card-hover transition-colors">
      <td className="px-4 py-2.5 whitespace-nowrap">
        <Link
          to={`/agents/${encodeURIComponent(agent.name)}`}
          className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
        >
          <Bot size={14} />
          {agent.name}
        </Link>
      </td>
      <td className="px-4 py-2.5 text-content-secondary max-w-[360px]">{agent.purpose}</td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <StatePill agent={agent} />
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <SpendCell agent={agent} />
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-micro text-content-tertiary">
        {agent.last_active === null ? (
          <span title="has never run">never</span>
        ) : (
          formatRelativeTime(agent.last_active)
        )}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span data-testid="tools-count">
          <Badge size="sm" color="accent">
            {agent.tools.length}
          </Badge>
        </span>
        {agent.unknown_tools.length > 0 && (
          <span className="ml-2 text-micro text-warning" title={agent.unknown_tools.join(', ')}>
            {agent.unknown_tools.length} no longer exist{agent.unknown_tools.length === 1 ? 's' : ''}
          </span>
        )}
      </td>
    </tr>
  )
}
