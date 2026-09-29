import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { ArrowUp, Plus, RefreshCw, Trash2, Waypoints, X } from 'lucide-react'
import { Badge, Button, ConfirmDialog, Section, Select, Toggle } from '../../components/ui'
import { InlineSave, type SaveMessage } from '../settings/shared'
import {
  clearWall as apiClearWall,
  deleteRoute as apiDeleteRoute,
  explainRoute as apiExplainRoute,
  getCatalog as apiGetCatalog,
  getRoutes as apiGetRoutes,
  listAgents as apiListAgents,
  putJevRouter as apiPutJevRouter,
  putRoute as apiPutRoute,
  type AgentSummary,
  type BuiltinRole,
  type CatalogRow,
  type CatalogSource,
  type RouteExplain,
  type RouteProtocol,
  type RouteRouter,
  type Routes,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { suitabilityEntries } from '../models/catalogFormat'
import { LIBRARY } from './modelsFormat'

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
  putJevRouter: typeof apiPutJevRouter
  explainRoute: typeof apiExplainRoute
  clearWall: typeof apiClearWall
  getCatalog: typeof apiGetCatalog
  deleteRoute: typeof apiDeleteRoute
  listAgents: typeof apiListAgents
}

const DEFAULT_API: RoutingApi = {
  getRoutes: apiGetRoutes,
  putRoute: apiPutRoute,
  putJevRouter: apiPutJevRouter,
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
  decisions: {
    label: 'Decisions',
    note: 'a decision model answers typed questions before she replies — which tool the message needs, which recalled notes still hold; empty = none, and her turns run as before',
  },
  coding: { label: 'Coding', note: 'reserved — nothing routes here yet' },
  vision: { label: 'Vision', note: 'reserved — nothing routes here yet' },
}

const VERDICT_WORDS: Record<string, string> = {
  runnable: 'would serve',
  over_cap: 'over its cap',
  walled: 'refused recently',
  not_installed: 'not installed',
  // S40: a link on a machine the owner switched off (`engines.serving`) is
  // passed over by choice, not failure; and `unreachable` is any provider
  // whose dial failed — a machine or a cloud — so the words name none.
  switched_off: 'switched off',
  unreachable: 'could not be reached',
  unknown: 'no such provider',
  refused: 'refused',
  // The decision role: the link's provider cannot answer this role — a chat
  // model where typed questions are needed, or a decision model where chat is.
  wrong_protocol: 'cannot answer this role',
}

/** Jev Router's model id (decision-role spec §4). The LINK is whichever
 * registered provider's listing carries it — read from the live catalogue,
 * never assumed to be a provider named openrouter. */
export const JEV_ROUTER_MODEL = 'typesafe/jev-router'
/** What the switch says Jev Router does. OpenRouter lists no parameters for
 * typesafe/jev-router (supported_parameters is empty, checked 2026-09-28), so
 * there is no quality-first setting to turn on — the spec's fallback: say what
 * it balances. */
export const JEV_ROUTER_BALANCES =
  'Jev Router picks a model and reasoning effort for each request, balancing quality, speed and cost, and you pay for the model it picks. It has no setting to put quality first.'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A decision model: the catalogue says it outputs decisions — read from the
 * provider's own listing, never a list kept here. It is offered to the
 * decisions role and to no chat role; the gateway refuses the other pairing
 * by name, too. */
export function isDecisionModel(row: CatalogRow): boolean {
  return suitabilityEntries(row, 'decisions').some(fact => fact.value === true)
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

export function RoutingSection({
  chatModel,
  api = DEFAULT_API,
  onChatModelChanged,
}: {
  chatModel: string
  api?: RoutingApi
  /** The switch can move chat.model itself (chat's cloud link IS chat.model,
   * and core writes it once the gateway names what it must become) — this
   * tells the settings page to reload it, the same way a pick made on Models
   * or Providers does. Called only when a switch answer names one. */
  onChatModelChanged: (model: string) => void
}) {
  const [routes, setRoutes] = useState<Routes | null>(null)
  const [catalog, setCatalog] = useState<CatalogRow[]>([])
  const [catalogSources, setCatalogSources] = useState<CatalogSource[]>([])
  // null = the agents list was NOT read (agentsError says why); [] = read and empty.
  const [agents, setAgents] = useState<AgentSummary[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [explains, setExplains] = useState<Record<string, RouteExplain | { error: string }>>({})
  const [error, setError] = useState<string | null>(null)
  // The link that serves Jev Router, from the catalogue the page already read.
  const routerLink = catalog.find(r => r.kind === 'cloud' && r.model === JEV_ROUTER_MODEL)?.id ?? null
  // The switch's disabled-with-no-link reason: the base sentence, plus a
  // named reason for each catalogue source that failed outright — read from
  // the sources themselves, since a source this page has not read is not the
  // same fact as one that came back empty.
  const failedSources = catalogSources.filter(s => s.ok === false)
  const routerUnavailableReason =
    `no provider lists ${JEV_ROUTER_MODEL} right now (OpenRouter serves it)` +
    (failedSources.length > 0
      ? ` — these model lists could not be read: ${failedSources.map(s => `${s.key} (${s.note ?? 'failed'})`).join(', ')}`
      : '')
  // Which providers are still registered, for the "in place of X" promise: a
  // kept link's provider (the part before its first colon) that is no
  // longer among these will never come back.
  const catalogProviders = new Set(catalogSources.map(s => s.key))

  // Answers arriving out of order — an older reload landing after a newer one
  // (two quick switches on different roles, or this reload racing the
  // parent's own re-render once a switch moves chat.model) — must not
  // publish over what the newer one already wrote: every load takes a
  // sequence number, and only the newest one may set state. `loadPromise`
  // carries this further: a CALLER awaiting `load(...)` (onRouter, onSave)
  // must not resolve, and so must not clear its own busy/message state,
  // until the load that actually wrote has — never a superseded one that
  // wrote nothing part way through.
  const loadSeq = useRef(0)
  const loadPromise = useRef<Promise<void> | null>(null)

  const load = useCallback((overrideChatModel?: string): Promise<void> => {
    const seq = ++loadSeq.current
    // The model to explain chat against: an override the CALLER already
    // knows is current (a switch answer's own chat_model) beats this
    // closure's own `chatModel`, which can still be one render behind it.
    const modelForChat = overrideChatModel ?? chatModel

    const p: Promise<void> = (async (): Promise<void> => {
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
        if (seq === loadSeq.current) {
          setRoutes(r)
          setCatalog(cat.rows)
          setCatalogSources(cat.sources)
          setAgents(agentsRead.list)
          setAgentsError(agentsRead.error)
          const entries = await Promise.all(
            r.roles
              .filter(role => !role.reserved)
              .map(async role => {
                try {
                  const model = role.role === 'chat' && modelForChat ? modelForChat : undefined
                  return [role.role, await api.explainRoute(role.role, model)] as const
                } catch (err) {
                  return [role.role, { error: reasonOf(err) }] as const
                }
              }),
          )
          if (seq === loadSeq.current) {
            setExplains(Object.fromEntries(entries))
          }
        }
      } catch (err) {
        if (seq === loadSeq.current) setError(reasonOf(err))
      }
      // This call wrote nothing (it was superseded before either checkpoint
      // above) exactly when `seq` is no longer the latest — a caller
      // awaiting THIS promise actually wants to know when the load that
      // superseded it, or whatever has superseded THAT one by now in turn,
      // has landed. `seq === loadSeq.current` is what tells this call it IS
      // the latest, without ever needing to name its own promise.
      for (;;) {
        if (seq === loadSeq.current) return
        const latest = loadPromise.current
        if (!latest) return
        await latest
        if (loadPromise.current === latest) return
      }
    })()

    loadPromise.current = p
    return p
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
              protocol={entry.protocol ?? 'chat'}
              explain={explains[entry.role]}
              router={entry.router ?? null}
              routerLink={routerLink}
              routerUnavailableReason={routerUnavailableReason}
              catalogProviders={catalogProviders}
              onRouter={async on => {
                const result = await api.putJevRouter(entry.role, on, on ? routerLink ?? undefined : undefined)
                // Reload with the model the ANSWER just named, not this
                // closure's — the parent's own re-render (which would
                // otherwise start a second, correctly-modelled reload) has
                // not necessarily happened yet.
                if (result.chat_model !== undefined) onChatModelChanged(result.chat_model)
                await load(result.chat_model)
                return result.note
              }}
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
  protocol,
  explain,
  router,
  routerLink,
  routerUnavailableReason,
  catalogProviders,
  onRouter,
  onSave,
  onRemove,
}: {
  role: string
  words: RoleWords
  reserved: boolean
  chain: string[]
  chatModel: string
  catalog: CatalogRow[]
  protocol: RouteProtocol
  explain: RouteExplain | { error: string } | undefined
  /** null where the Jev Router switch is not offered on this role. */
  router: RouteRouter | null
  /** the provider:model that serves Jev Router, from the live catalogue; null
   * when no registered provider lists it. */
  routerLink: string | null
  /** Why the switch is off with no way to turn it on — the base sentence,
   * plus a named reason for each catalogue source that failed outright.
   * Always a real sentence; only ever shown when `routerLink` is null. */
  routerUnavailableReason: string
  /** Provider keys the catalogue's sources still list — never assumed just
   * because a row happens to be offered. A kept link whose provider has
   * fallen out of this set will not come back off a switch off. */
  catalogProviders: Set<string>
  /** Flips the switch. Resolves to the gateway's `note` (undefined for none)
   * on success; a refusal is thrown, in the gateway's own words. */
  onRouter: (on: boolean) => Promise<string | undefined>
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
  const [routerBusy, setRouterBusy] = useState(false)
  const [routerError, setRouterError] = useState<string | null>(null)
  const [routerNote, setRouterNote] = useState<string | null>(null)
  // The ONE reason the switch cannot be flipped right now: mid-flight, or
  // off with no link to turn it on with (turning off never needs one). The
  // toggle's `disabled` and the guard inside `flipRouter` both read this
  // and only this, so they cannot drift apart.
  const routerDisabled = routerBusy || !router || (!router.on && !routerLink)
  const flipRouter = async (on: boolean) => {
    // Checked again here, not just reflected in `disabled`: an input's
    // `disabled` attribute is what a pointer respects, not what a
    // dispatched event is required to. Nothing may reach `onRouter` while
    // this holds.
    if (routerDisabled) return
    setRouterBusy(true)
    setRouterError(null)
    setRouterNote(null)
    try {
      const note = await onRouter(on)
      setRouterNote(note ?? null)
    } catch (err) {
      setRouterError(reasonOf(err))
    } finally {
      setRouterBusy(false)
    }
  }
  // A refusal is about the attempt that produced it, not a persistent fact:
  // once a reload shows this role's router state actually moved (this
  // role's own switch, or another role's switch racing a shared reload in),
  // a stale refusal no longer describes what the toggle now shows. The note
  // is different — it is set by the very reload that just applied it — so
  // it is never touched here.
  useEffect(() => {
    setRouterError(null)
  }, [router?.on, router?.kept])
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
  const wantsDecisions = protocol === 'systemone'
  const options = catalog
    // A `library:` row is a model on no machine yet: the gateway cannot
    // route to it, so it is never offered as a link (pull it on Models).
    // A decision model answers typed questions only: offered to the
    // decisions role, and to no other.
    .filter(r => (r.kind === 'local' || r.kind === 'cloud') && r.provider !== LIBRARY && !draft.includes(r.id) && r.id !== chatModel && isDecisionModel(r) === wantsDecisions)
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
          <li className="text-content-tertiary">
            {wantsDecisions ? 'no decision model — her turns run without one' : 'no chain of its own — uses the chat chain'}
          </li>
        )}
      </ol>
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select
            value={adding}
            onChange={e => setAdding(e.target.value)}
            items={[{ value: '', label: wantsDecisions ? 'add a decision model…' : 'add a fallback…' }, ...options]}
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
      {router && editable && (
        <div className="mt-2 space-y-1" data-testid={`route-${role}-router`}>
          <Toggle
            id={`jev-router-${role}`}
            size="sm"
            checked={router.on}
            disabled={routerDisabled}
            onChange={on => void flipRouter(on)}
            label="Let Jev Router pick the cloud model"
          />
          <p className="text-caption text-content-tertiary">{JEV_ROUTER_BALANCES}</p>
          {role === 'chat' && (
            <p className="text-caption text-content-tertiary">
              Switching on puts Jev Router in place of the first cloud model a chat turn reaches: the model picked in chat when that is a cloud model, otherwise the first cloud link after it. Local links keep their places.
            </p>
          )}
          {router.on && router.kept && (
            <p className="text-caption text-content-tertiary" data-testid={`route-${role}-router-kept`}>
              {catalogProviders.has(router.kept.split(':')[0])
                ? `in place of ${router.kept}, which comes back when you switch it off`
                : `in place of ${router.kept} — its provider is gone, so switching off will not put it back`}
            </p>
          )}
          {router.on && router.kept === '' && (
            <p className="text-caption text-content-tertiary" data-testid={`route-${role}-router-kept`}>
              added after the local links; switching it off removes it
            </p>
          )}
          {!router.on && !routerLink && (
            <p className="text-caption text-content-tertiary" data-testid={`route-${role}-router-unavailable`}>
              {routerUnavailableReason}
            </p>
          )}
          {routerNote && (
            <p role="status" className="text-caption text-content-tertiary" data-testid={`route-${role}-router-note`}>
              {routerNote}
            </p>
          )}
          {routerError && (
            <p role="alert" className="text-caption text-danger" data-testid={`route-${role}-router-error`}>
              could not switch — {routerError}
            </p>
          )}
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
  // switched_off is the owner's choice, not a failure: neutral, never red.
  return (
    <span title={verdict.reason ?? undefined} data-verdict={verdict.verdict}>
      <Badge size="sm" color={ok ? 'success' : verdict.verdict === 'over_cap' ? 'warning' : verdict.verdict === 'switched_off' ? 'neutral' : 'danger'}>
        {VERDICT_WORDS[verdict.verdict] ?? verdict.verdict}
      </Badge>
    </span>
  )
}
