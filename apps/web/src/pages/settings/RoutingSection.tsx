import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Plus, RefreshCw, Trash2, Waypoints, X } from 'lucide-react'
import { Badge, Button, Section, Select } from '../../components/ui'
import { InlineSave, type SaveMessage } from '../settings/shared'
import {
  clearWall as apiClearWall,
  explainRoute as apiExplainRoute,
  getCatalog as apiGetCatalog,
  getRoutes as apiGetRoutes,
  putRoute as apiPutRoute,
  type CatalogRow,
  type RouteExplain,
  type RouteRole,
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
 */
export interface RoutingApi {
  getRoutes: typeof apiGetRoutes
  putRoute: typeof apiPutRoute
  explainRoute: typeof apiExplainRoute
  clearWall: typeof apiClearWall
  getCatalog: typeof apiGetCatalog
}

const DEFAULT_API: RoutingApi = {
  getRoutes: apiGetRoutes,
  putRoute: apiPutRoute,
  explainRoute: apiExplainRoute,
  clearWall: apiClearWall,
  getCatalog: apiGetCatalog,
}

const ROLE_WORDS: Record<RouteRole, { label: string; note: string }> = {
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

export function RoutingSection({ chatModel, api = DEFAULT_API }: { chatModel: string; api?: RoutingApi }) {
  const [routes, setRoutes] = useState<Routes | null>(null)
  const [catalog, setCatalog] = useState<CatalogRow[]>([])
  const [explains, setExplains] = useState<Record<string, RouteExplain | { error: string }>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [r, cat] = await Promise.all([api.getRoutes(), api.getCatalog()])
      setRoutes(r)
      setCatalog(cat.rows)
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
        {routes?.roles.map(role => (
          <RoleEditor
            key={role.role}
            role={role.role}
            reserved={role.reserved}
            chain={role.chain}
            chatModel={chatModel}
            catalog={catalog}
            explain={explains[role.role]}
            onSave={async chain => {
              await api.putRoute(role.role, chain)
              await load()
            }}
          />
        ))}
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
  reserved,
  chain,
  chatModel,
  catalog,
  explain,
  onSave,
}: {
  role: RouteRole
  reserved: boolean
  chain: string[]
  chatModel: string
  catalog: CatalogRow[]
  explain: RouteExplain | { error: string } | undefined
  onSave: (chain: string[]) => Promise<void>
}) {
  const [draft, setDraft] = useState<string[]>(chain)
  const [adding, setAdding] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  useEffect(() => {
    setDraft(chain)
  }, [chain])
  const dirty = JSON.stringify(draft) !== JSON.stringify(chain)
  const words = ROLE_WORDS[role]
  const verdicts = explain && !('error' in explain) ? explain.chain : []
  const verdictFor = (id: string) => verdicts.find(v => v.id === id)
  const options = catalog
    .filter(r => (r.kind === 'local' || r.kind === 'cloud') && !draft.includes(r.id) && r.id !== chatModel)
    .map(r => ({ value: r.id, label: `${r.provider} · ${r.model}${r.installed === false ? ' (not installed)' : ''}` }))

  return (
    <div className="rounded-md border border-line px-4 py-3" data-testid={`route-${role}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-compact font-medium">{words.label}</span>
        {reserved && <Badge size="sm" color="neutral">no user yet</Badge>}
        <span className="text-caption text-content-tertiary">{words.note}</span>
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
            </li>
          )
        })}
        {draft.length === 0 && role !== 'chat' && !reserved && (
          <li className="text-content-tertiary">no chain of its own — uses the chat chain</li>
        )}
      </ol>
      {!reserved && (
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
      {explain && 'error' in explain && <p className="mt-2 text-caption text-danger">could not check: {explain.error}</p>}
      {explain && !('error' in explain) && (
        <p className="mt-2 text-caption text-content-tertiary" data-testid={`route-${role}-would-serve`}>
          {explain.would_serve
            ? `right now: ${explain.would_serve.served_by} would answer${explain.would_serve.link > 1 ? ` — ${explain.would_serve.reason}` : ''}`
            : `right now: nothing could answer — ${explain.reason}`}
        </p>
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
