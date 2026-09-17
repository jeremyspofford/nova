import { useCallback, useEffect, useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { ArrowUp, Plus, RefreshCw, Trash2, Waypoints, X } from 'lucide-react'
import { Badge, Button, ConfirmDialog, Section, Select } from '../../components/ui'
import { InlineSave, type SaveMessage } from '../settings/shared'
import {
  clearWall as apiClearWall,
  deleteRoute as apiDeleteRoute,
  explainRoute as apiExplainRoute,
  getCatalog as apiGetCatalog,
  getRoutes as apiGetRoutes,
  listAgents as apiListAgents,
  putRoute as apiPutRoute,
  type AgentSummary,
  type BuiltinRole,
  type CatalogRow,
  type RouteExplain,
  type Routes,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'

/**
 * Routing by role (S10-2). Each role has an ordered chain of `provider:model`
 * ids the gateway walks BEFORE a call is made: a link is skipped when its
 * provider is over its monthly cap or walled (it refused recently), or a
 * local model is not installed — with the reason — and the first runnable
 * link serves; a fallback is stated on the reply. For chat, link 1 is the
 * model picked in chat (chat.model); this page edits only the fallbacks
 * behind it, so the pick has one writer. Every verdict shown here is the
 * gateway's live answer to "what would serve right now?", never a guess.
 *
 * The roles are the gateway's list, in the gateway's order — never a list
 * kept here. Built-ins come first; an agent (S12) owns a derived
 * `agent_<name>` role, named after the live agents list. A stored role no
 * agent owns any more can be removed — but only once the agents list was
 * actually READ and the name is absent: unread is not empty.
 */
export interface RoutingApi {
  getRoutes: typeof apiGetRoutes
  putRoute: typeof apiPutRoute
  explainRoute: typeof apiExplainRoute
  clearWall: typeof apiClearWall
  getCatalog: typeof apiGetCatalog
  deleteRoute: typeof apiDeleteRoute
  listAgents: typeof apiListAgents
}

const DEFAULT_API: RoutingApi = {
  getRoutes: apiGetRoutes,
  putRoute: apiPutRoute,
  explainRoute: apiExplainRoute,
  clearWall: apiClearWall,
  getCatalog: apiGetCatalog,
  deleteRoute: apiDeleteRoute,
  listAgents: apiListAgents,
}

const ROLE_WORDS: Record<BuiltinRole, { label: string; note: string }> = {
  chat: { label: 'Chat', note: 'your conversations; link 1 is the model picked in chat' },
  scheduled: { label: 'Scheduled tasks', note: 'turns the scheduler runs on a timer; empty = the chat chain' },
  judge: { label: 'Quality judging', note: 'the responsiveness judge and honesty redirects inside a turn; empty = the chat chain' },
  coding: { label: 'Coding', note: 'reserved — nothing routes here yet' },
  vision: { label: 'Vision', note: 'reserved — nothing routes here yet' },
}

const VERDICT_WORDS: Record<string, string> = {
  runnable: 'would serve',
  over_cap: 'over its cap',
  walled: 'refused recently',
  not_installed: 'not installed',
  unreachable: 'ollama unreachable',
  unknown: 'no such provider',
  refused: 'refused',
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What a row says about its role. */
interface RoleWords {
  label: string
  note: string
  /** a badge beside the label */
  badge?: string
  /** the label links here — an agent's page */
  link?: string
  /** the agents list was read and no agent owns this role: it can be removed */
  orphan: boolean
}

/**
 * Built-ins keep their words, looked up by name (a built-in this page has no
 * words for is still a built-in — labelled verbatim, never removable). A
 * non-built-in is an agent's derived role: named after the agent when the
 * list was read and holds it; an orphan when the list was read and does
 * not; and merely "an agent role" when the list could not be read — that
 * state offers no Remove, because it cannot tell an orphan from a live
 * agent's role.
 */
function wordsFor(role: string, builtin: boolean, agents: AgentSummary[] | null, agentsError: string | null): RoleWords {
  if (builtin) {
    const words = role in ROLE_WORDS ? ROLE_WORDS[role as BuiltinRole] : undefined
    return words ? { ...words, orphan: false } : { label: role, note: 'built-in role', orphan: false }
  }
  if (agents === null) {
    return { label: role, badge: 'agent role', note: `could not read the agents list — ${agentsError ?? 'unknown'}`, orphan: false }
  }
  const agent = agents.find(a => a.role === role)
  if (agent) return { label: `Agent · ${agent.name}`, note: agent.purpose, link: `/agents/${agent.name}`, orphan: false }
  return { label: role, note: 'no agent by this name', orphan: true }
}

export function RoutingSection({ chatModel, api = DEFAULT_API }: { chatModel: string; api?: RoutingApi }) {
  const [routes, setRoutes] = useState<Routes | null>(null)
  const [catalog, setCatalog] = useState<CatalogRow[]>([])
  // null = the agents list was NOT read (agentsError says why); [] = read and empty.
  const [agents, setAgents] = useState<AgentSummary[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [explains, setExplains] = useState<Record<string, RouteExplain | { error: string }>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [r, cat, agentsRead] = await Promise.all([
        api.getRoutes(),
        api.getCatalog(),
        // The agents list decides whether a role's Remove is offered, so its
        // failure is kept as a fact of its own, never folded into "no agents".
        api.listAgents().then(
          list => ({ list, error: null as string | null }),
          (err: unknown) => ({ list: null as AgentSummary[] | null, error: reasonOf(err) }),
        ),
      ])
      setRoutes(r)
      setCatalog(cat.rows)
      setAgents(agentsRead.list)
      setAgentsError(agentsRead.error)
      const entries = await Promise.all(
        r.roles
          .filter(role => !role.reserved)
          .map(async role => {
            try {
              const model = role.role === 'chat' && chatModel ? chatModel : undefined
              return [role.role, await api.explainRoute(role.role, model)] as const
            } catch (err) {
              return [role.role, { error: reasonOf(err) }] as const
            }
          }),
      )
      setExplains(Object.fromEntries(entries))
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api, chatModel])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Section
      icon={Waypoints}
      title="Routing"
      description="Which model answers each kind of work. A role's chain is walked before every call: a provider over its monthly cap or one that refused recently is skipped, a local model that is not installed is skipped, and the reply says so when a fallback answered."
    >
      <div className="space-y-4" data-testid="routing-section">
        {error && (
          <div role="alert" className="rounded-sm border border-danger/30 bg-danger-dim px-3 py-2 text-caption text-danger">
            {error}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            Re-check
          </Button>
        </div>
        {routes?.roles.map(entry => {
          // A gateway that predates the flag still names the built-ins.
          const builtin = entry.builtin ?? entry.role in ROLE_WORDS
          const words = wordsFor(entry.role, builtin, agents, agentsError)
          return (
            <RoleEditor
              key={entry.role}
              role={entry.role}
              words={words}
              reserved={entry.reserved}
              chain={entry.chain}
              chatModel={chatModel}
              catalog={catalog}
              explain={explains[entry.role]}
              onSave={async chain => {
                await api.putRoute(entry.role, chain)
                await load()
              }}
              onRemove={
                words.orphan
                  ? async () => {
                      await api.deleteRoute(entry.role)
                      await load()
                    }
                  : undefined
              }
            />
          )
        })}
        {routes && routes.walls.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-caption" data-testid="routing-walls">
            <div className="font-medium">Providers that refused recently</div>
            <ul className="mt-1 space-y-1">
              {routes.walls.map(w => (
                <li key={w.provider} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{w.provider}</span>
                  <span>{w.reason}</span>
                  <span className="text-content-tertiary">
                    skipped until {formatRelativeTime(w.walled_until)} (strike {w.strikes})
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X size={12} />}
                    aria-label={`clear wall ${w.provider}`}
                    onClick={async () => {
                      await api.clearWall(w.provider)
                      await load()
                    }}
                  >
                    Try it again
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  )
}

function RoleEditor({
  role,
  words,
  reserved,
  chain,
  chatModel,
  catalog,
  explain,
  onSave,
  onRemove,
}: {
  role: string
  words: RoleWords
  reserved: boolean
  chain: string[]
  chatModel: string
  catalog: CatalogRow[]
  explain: RouteExplain | { error: string } | undefined
  onSave: (chain: string[]) => Promise<void>
  /** present only when the role is an orphan — the one thing to do with it */
  onRemove?: () => Promise<void>
}) {
  const inRouter = useInRouterContext()
  const [draft, setDraft] = useState<string[]>(chain)
  const [adding, setAdding] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(chain)
  }, [chain])
  const dirty = JSON.stringify(draft) !== JSON.stringify(chain)
  // A reserved role has no user; an orphan's PUT is refused by core (no such
  // agent) — neither gets controls whose call cannot run.
  const editable = !reserved && !words.orphan
  const verbatim = words.label === role
  const verdicts = explain && !('error' in explain) ? explain.chain : []
  const verdictFor = (id: string) => verdicts.find(v => v.id === id)
  const options = catalog
    .filter(r => (r.kind === 'local' || r.kind === 'cloud') && !draft.includes(r.id) && r.id !== chatModel)
    .map(r => ({ value: r.id, label: `${r.provider} · ${r.model}${r.installed === false ? ' (not installed)' : ''}` }))

  const remove = async () => {
    if (!onRemove) return
    setRemoveError(null)
    try {
      await onRemove()
    } catch (err) {
      setRemoveError(reasonOf(err))
    }
  }

  const labelClass = `text-compact font-medium${verbatim ? ' font-mono' : ''}`
  const label = words.link ? (
    inRouter ? (
      <Link to={words.link} className={`${labelClass} text-accent hover:underline`}>
        {words.label}
      </Link>
    ) : (
      <a href={words.link} className={`${labelClass} text-accent hover:underline`}>
        {words.label}
      </a>
    )
  ) : (
    <span className={labelClass}>{words.label}</span>
  )

  return (
    <div className="rounded-md border border-line px-4 py-3" data-testid={`route-${role}`}>
      <div className="flex flex-wrap items-center gap-2">
        {label}
        {reserved && <Badge size="sm" color="neutral">no user yet</Badge>}
        {words.badge && <Badge size="sm" color="neutral">{words.badge}</Badge>}
        <span className="text-caption text-content-tertiary">{words.note}</span>
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={12} />}
            aria-label={`remove role ${role}`}
            onClick={() => setConfirmingRemove(true)}
          >
            Remove
          </Button>
        )}
      </div>
      <ol className="mt-2 space-y-1 text-caption">
        {role === 'chat' && (
          <li className="flex flex-wrap items-center gap-2" data-testid={`route-${role}-link-1`}>
            <span className="w-4 text-content-tertiary">1.</span>
            <span className="font-mono">{chatModel || '(no chat model set)'}</span>
            <span className="text-content-tertiary">your current pick, set in chat or on Models</span>
            <VerdictBadge verdict={verdictFor(chatModel)} />
          </li>
        )}
        {draft.map((id, index) => {
          const number = role === 'chat' ? index + 2 : index + 1
          return (
            <li key={id} className="flex flex-wrap items-center gap-2" data-testid={`route-${role}-link-${number}`}>
              <span className="w-4 text-content-tertiary">{number}.</span>
              <span className="font-mono">{id}</span>
              <VerdictBadge verdict={verdictFor(id)} />
              {editable && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowUp size={12} />}
                    disabled={index === 0}
                    aria-label={`move up ${role} ${id}`}
                    onClick={() => setDraft(d => {
                      const next = [...d]
                      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                      return next
                    })}
                  >
                    Up
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} aria-label={`remove ${role} ${id}`} onClick={() => setDraft(d => d.filter(x => x !== id))}>
                    Remove
                  </Button>
                </>
              )}
            </li>
          )
        })}
        {draft.length === 0 && role !== 'chat' && !reserved && (
          <li className="text-content-tertiary">no chain of its own — uses the chat chain</li>
        )}
      </ol>
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select
            value={adding}
            onChange={e => setAdding(e.target.value)}
            items={[{ value: '', label: 'add a fallback…' }, ...options]}
            label={`add to ${role}`}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={12} />}
            disabled={!adding}
            aria-label={`add ${role}`}
            onClick={() => {
              if (adding) setDraft(d => [...d, adding])
              setAdding('')
            }}
          >
            Add
          </Button>
          <InlineSave
            dirty={dirty}
            saving={saving}
            onSave={async () => {
              setSaving(true)
              setMessage(null)
              try {
                await onSave(draft)
                setMessage({ kind: 'ok', text: 'chain saved' })
              } catch (err) {
                setMessage({ kind: 'err', text: reasonOf(err) })
              } finally {
                setSaving(false)
              }
            }}
            onReset={() => setDraft(chain)}
            message={message}
          />
        </div>
      )}
      {removeError && (
        <p role="alert" className="mt-2 text-caption text-danger" data-testid={`route-${role}-remove-error`}>
          could not remove — {removeError}
        </p>
      )}
      {explain && 'error' in explain && <p className="mt-2 text-caption text-danger">could not check: {explain.error}</p>}
      {explain && !('error' in explain) && (
        <p className="mt-2 text-caption text-content-tertiary" data-testid={`route-${role}-would-serve`}>
          {explain.would_serve
            ? `right now: ${explain.would_serve.served_by} would answer${explain.would_serve.link > 1 ? ` — ${explain.would_serve.reason}` : ''}`
            : `right now: nothing could answer — ${explain.reason}`}
        </p>
      )}
      {onRemove && (
        <ConfirmDialog
          open={confirmingRemove}
          onClose={() => setConfirmingRemove(false)}
          title={`Remove ${role}?`}
          description={`Remove the chain for ${role}? No agent has this name.`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => {
            setConfirmingRemove(false)
            void remove()
          }}
        />
      )}
    </div>
  )
}

function VerdictBadge({ verdict }: { verdict: { verdict: string; reason: string | null } | undefined }) {
  if (!verdict) return null
  const ok = verdict.verdict === 'runnable'
  return (
    <span title={verdict.reason ?? undefined} data-verdict={verdict.verdict}>
      <Badge size="sm" color={ok ? 'success' : verdict.verdict === 'over_cap' ? 'warning' : 'danger'}>
        {VERDICT_WORDS[verdict.verdict] ?? verdict.verdict}
      </Badge>
    </span>
  )
}
