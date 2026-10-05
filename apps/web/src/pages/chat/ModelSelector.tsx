import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, Cpu, Info } from 'lucide-react'
import clsx from 'clsx'
import { Link, useInRouterContext } from 'react-router-dom'
import {
  explainRoute as apiExplainRoute,
  getCatalog as apiGetCatalog,
  getRoutes as apiGetRoutes,
  getSettings as apiGetSettings,
  setChatPrimary as apiSetChatPrimary,
  settingValue,
  type CatalogRow,
  type RouteExplain,
  type RouteVerdict,
} from '../../lib/api'
import { ACCURACY_DISCLAIMER_SHORT } from '../../lib/modelDisclaimer'
import { LOCAL_PROVIDER, bareLocalModel } from '../settings/modelsFormat'

/**
 * The chat's model switcher, by the input. It shows the SAME order Settings ->
 * Models -> Routing edits — the pick (link 1) and the fallbacks behind it —
 * and what would answer right now, from the gateway's own walk (2026-10-05).
 *
 * Before, this showed only the pick, from a cache that moved when a turn
 * started in this browser, and a pick here wrote chat.model alone: the model
 * it replaced dropped out of chat without a word, and with the Dell off the
 * trigger kept naming a model that could not answer while another one did.
 *
 * A pick goes through `setChatPrimary`, the one write every "use this model"
 * makes: the picked model becomes link 1 and the one it replaces chat's first
 * fallback. The change reaches the parent only after core stored it.
 *
 * `api` is the dependency-injection seam every page uses.
 */
export interface ModelSelectorApi {
  getCatalog: typeof apiGetCatalog
  getRoutes: typeof apiGetRoutes
  getSettings: typeof apiGetSettings
  explainRoute: typeof apiExplainRoute
  setChatPrimary: typeof apiSetChatPrimary
}

const DEFAULT_API: ModelSelectorApi = {
  getCatalog: apiGetCatalog,
  getRoutes: apiGetRoutes,
  getSettings: apiGetSettings,
  explainRoute: apiExplainRoute,
  setChatPrimary: apiSetChatPrimary,
}

/** Cloud rows grouped by provider, in the catalogue's order — only the rows
 * the gateway offers as the chat model (`use`). A decision model answers
 * typed questions and has no chat; picking one would end every turn. */
export function cloudGroups(rows: CatalogRow[]): { provider: string; rows: CatalogRow[] }[] {
  const groups = new Map<string, CatalogRow[]>()
  for (const row of rows) {
    if (row.kind !== 'cloud' || !(Array.isArray(row.actions) && row.actions.includes('use'))) continue
    const list = groups.get(row.provider) ?? []
    list.push(row)
    groups.set(row.provider, list)
  }
  return Array.from(groups, ([provider, rows]) => ({ provider, rows }))
}

/** Models installed on a machine Nova runs that can chat — what the gateway
 * offers as the chat model (`use`). Never a library pick (it is on no machine
 * yet: picking it would end every turn) and never an embedding model. */
export function localChoices(rows: CatalogRow[]): CatalogRow[] {
  return rows.filter(
    r => r.kind === 'local' && r.installed === true && Array.isArray(r.actions) && r.actions.includes('use'),
  )
}

/** The model part of an id, for the trigger's narrow space:
 * `openrouter:google/gemini-3.8-flash` reads `gemini-3.8-flash`. */
export function shortModelName(id: string): string {
  const model = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}

/** Is the pick on the smaller end of the models on offer — below the mean of
 * the stated sizes? Derived from the catalogue's own params_b, never a list
 * of names: false without two stated sizes to compare, and false for a pick
 * whose size is not stated (nothing is invented for data that is not there). */
export function pickIsSmaller(rows: CatalogRow[], pick: string): boolean {
  const sizeOf = (r: CatalogRow) => r.facts.params_b?.value
  const known = rows.map(sizeOf).filter((n): n is number => typeof n === 'number')
  if (known.length < 2) return false
  const target = rows.find(r => r.id === pick || (r.provider === LOCAL_PROVIDER && r.model === pick))
  const size = target ? sizeOf(target) : undefined
  if (typeof size !== 'number') return false
  return size < known.reduce((sum, n) => sum + n, 0) / known.length
}

/** A verdict that is not "would serve", in a few words — the reason itself
 * is the option's title. */
const NOT_SERVING: Record<string, string> = {
  over_cap: 'over cap',
  walled: 'refused recently',
  not_installed: 'not installed',
  switched_off: 'switched off',
  unreachable: 'unreachable',
  unknown: 'no such provider',
  refused: 'refused',
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ModelSelector({
  currentModel,
  onModelChanged,
  api = DEFAULT_API,
}: {
  currentModel: string
  onModelChanged: (model: string) => void
  api?: ModelSelectorApi
}) {
  const inRouter = useInRouterContext()
  const [fallbacks, setFallbacks] = useState<string[] | null>(null)
  const [walk, setWalk] = useState<RouteExplain | null>(null)
  const [rows, setRows] = useState<CatalogRow[]>([])
  const [catalog, setCatalog] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [cloudFilter, setCloudFilter] = useState('')
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickNote, setPickNote] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // What chat walks and what would answer right now: small reads, made on
  // mount, whenever the pick changes, when the window comes back into focus
  // and when the menu opens. The pick itself is read too — the parent's
  // value is a cache that moves only when a turn starts or a pick is made in
  // THIS browser, so a pick made on the phone left the laptop naming the old
  // one. A failed read costs what it would have shown, never the switcher.
  const readOrder = useCallback(async () => {
    const settings = await api.getSettings().catch(() => null)
    const stored = settings ? String(settingValue(settings, 'chat.model', '')) : ''
    const pick = stored || currentModel
    if (stored && stored !== currentModel) {
      // The parent follows; this read runs again for the new pick.
      onModelChanged(stored)
      return
    }
    const [routes, explained] = await Promise.all([
      api.getRoutes().catch(() => null),
      api.explainRoute('chat', pick || undefined).catch(() => null),
    ])
    if (!alive.current) return
    setFallbacks(routes?.roles.find(r => r.role === 'chat')?.chain ?? null)
    setWalk(explained)
  }, [api, currentModel, onModelChanged])

  useEffect(() => {
    void readOrder()
  }, [readOrder])
  useEffect(() => {
    const onFocus = () => void readOrder()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [readOrder])

  // Close on an outside click, the same lightweight pattern ModelPicker uses.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    const opening = !open
    setOpen(opening)
    if (!opening) return
    void readOrder()
    // The catalogue only fills the menu, so it is read when the menu first
    // opens — never on every visit to the chat page.
    if (catalog === 'idle' || catalog === 'failed') {
      setCatalog('loading')
      api.getCatalog().then(
        cat => {
          if (!alive.current) return
          // A body that is not the promised shape is a failed read, never a
          // crash of the chat page.
          if (!Array.isArray(cat?.rows)) {
            setCatalog('failed')
            return
          }
          setRows(cat.rows)
          setCatalog('ready')
        },
        () => alive.current && setCatalog('failed'),
      )
    }
  }

  const choose = async (id: string) => {
    setOpen(false)
    if (id === currentModel) return
    setError(null)
    setPickNote(null)
    setSwitching(true)
    try {
      const stored = await api.setChatPrimary(id)
      // Reflected only now core stored it — never optimistically.
      setFallbacks(stored.chain)
      setPickNote(stored.note ?? null)
      onModelChanged(stored.chat_model)
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setSwitching(false)
    }
  }

  // The order chat walks: the pick, then the fallbacks, each named once.
  const order = [
    ...(currentModel ? [currentModel] : []),
    ...(fallbacks ?? []).filter(id => id !== currentModel),
  ]
  const verdictOf = (id: string): RouteVerdict | undefined => walk?.chain.find(v => v.id === id)
  const serving = walk?.would_serve ?? null
  // The pick cannot answer right now and a model behind it would.
  const fellBack = serving !== null && serving.link > 1
  const inOrder = new Set(order)
  const local = localChoices(rows).filter(r => !inOrder.has(r.id))
  const groups = cloudGroups(rows.filter(r => !inOrder.has(r.id)))
  const filter = cloudFilter.trim().toLowerCase()

  const option = (id: string, note: string | null) => {
    const verdict = verdictOf(id)
    const blocked = verdict && verdict.verdict !== 'runnable' ? (NOT_SERVING[verdict.verdict] ?? verdict.verdict) : null
    return (
      <button
        key={id}
        type="button"
        role="option"
        aria-selected={id === currentModel}
        data-testid={`chat-model-option-${id}`}
        onClick={() => void choose(id)}
        title={verdict?.reason ?? undefined}
        className={clsx(
          'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-compact hover:bg-surface-card-hover transition-colors duration-fast',
          id === currentModel ? 'text-accent' : 'text-content-primary',
        )}
      >
        <span className="min-w-0 truncate font-mono">{bareLocalModel(id)}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-micro">
          {note && <span className="text-content-tertiary">{note}</span>}
          {blocked && <span className="text-warning">{blocked}</span>}
          {id === currentModel && <Check size={13} />}
        </span>
      </button>
    )
  }

  const groupLabel = (text: string) => (
    <div className="px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-content-tertiary">{text}</div>
  )
  const settingsLink = 'Chat order lives in Settings → Models'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="chat-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        onClick={toggle}
        title={
          fellBack && serving
            ? `${currentModel} cannot answer right now${verdictOf(currentModel)?.reason ? ` — ${verdictOf(currentModel)?.reason}` : ''}. ${serving.served_by} answers.`
            : 'Model Nova answers with — click to switch'
        }
        className="flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-fast disabled:opacity-60"
      >
        <Cpu size={13} className="shrink-0" />
        {/* The pick alone lives in this span — the icon, the fallback and the
            chevron are siblings — so its textContent is exactly the model id,
            which the e2e change-model spec asserts with toHaveText. */}
        <span data-testid="chat-model" className="font-mono truncate max-w-[10rem]">
          {currentModel ? bareLocalModel(currentModel) : 'Select a model'}
        </span>
        {fellBack && serving && (
          <span data-testid="chat-model-answering" className="flex min-w-0 items-center gap-0.5 text-warning">
            <ArrowRight size={11} className="shrink-0" />
            <span className="font-mono truncate max-w-[8rem]">{shortModelName(serving.served_by)}</span>
          </span>
        )}
        <ChevronDown size={13} className={clsx('shrink-0 transition-transform duration-fast', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          data-testid="chat-model-menu"
          // Anchored to the RIGHT edge: the trigger ends the control row, and a
          // left-anchored menu ran off a phone's screen.
          className="absolute bottom-full right-0 z-50 mb-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface-card shadow-lg glass-overlay dark:border-white/[0.10]"
        >
          {serving && (
            <p data-testid="chat-model-serving" className="border-b border-border-subtle px-3 py-1.5 text-micro text-content-tertiary">
              answering now: <span className="font-mono text-content-secondary">{serving.served_by}</span>
              {fellBack && serving.reason ? ` — ${serving.reason}` : ''}
            </p>
          )}
          <div role="listbox" className="max-h-80 overflow-y-auto custom-scrollbar py-1">
            {order.length > 0 && (
              <div data-testid="chat-model-order">
                {groupLabel('Chat order')}
                {order.map((id, index) => option(id, index === 0 ? 'primary' : `fallback ${index}`))}
              </div>
            )}
            {local.length > 0 && (
              <div data-testid="chat-model-group-installed">
                {groupLabel('Installed')}
                {local.map(row => option(row.id, null))}
              </div>
            )}
            {catalog === 'loading' && <p className="px-3 py-2 text-caption text-content-tertiary">reading the model list…</p>}
            {catalog === 'failed' && (
              <p role="alert" className="px-3 py-2 text-caption text-danger">
                could not read the model list — close and open to try again
              </p>
            )}
            {/* S10-2: every registered provider's models, grouped — the
                catalogue's rows, ids already provider-qualified. */}
            {groups.length > 0 && (
              <div className="border-t border-border-subtle px-3 py-1.5">
                <input
                  type="text"
                  value={cloudFilter}
                  onChange={e => setCloudFilter(e.target.value)}
                  placeholder="filter cloud models"
                  aria-label="filter cloud models"
                  className="w-full rounded-sm border border-border bg-surface px-2 py-1 text-micro"
                />
              </div>
            )}
            {groups.map(group => {
              const shown = group.rows.filter(r => !filter || r.id.toLowerCase().includes(filter) || r.label.toLowerCase().includes(filter))
              if (shown.length === 0) return null
              return (
                <div key={group.provider} data-testid={`chat-model-group-${group.provider}`}>
                  {groupLabel(group.provider)}
                  {shown.slice(0, 40).map(row => option(row.id, null))}
                  {shown.length > 40 && <p className="px-3 py-1 text-micro text-content-tertiary">{shown.length - 40} more — filter to find them</p>}
                </div>
              )
            })}
          </div>

          <div className="space-y-1 border-t border-border-subtle px-3 py-1.5 text-micro text-content-tertiary">
            <p
              className={clsx('flex items-start gap-1.5', pickIsSmaller(rows, currentModel) && 'text-warning')}
              data-testid="chat-model-accuracy-note"
            >
              <Info size={11} className="mt-0.5 shrink-0" />
              <span>{ACCURACY_DISCLAIMER_SHORT}</span>
            </p>
            <p>
              Picking a model makes it primary; the one it replaces becomes the first fallback.{' '}
              {inRouter ? (
                <Link to="/settings/models" className="text-accent hover:underline" onClick={() => setOpen(false)}>
                  {settingsLink}
                </Link>
              ) : (
                <a href="/settings/models" className="text-accent hover:underline">
                  {settingsLink}
                </a>
              )}
              .
            </p>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 text-micro text-danger">
          Could not switch model: {error}
        </p>
      )}
      {pickNote && (
        <p role="status" className="mt-1 text-micro text-warning" data-testid="chat-model-note">
          {pickNote}
        </p>
      )}
    </div>
  )
}
