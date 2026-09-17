import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, Info } from 'lucide-react'
import clsx from 'clsx'
import {
  getCatalog as apiGetCatalog,
  getInstalledModels as apiGetInstalledModels,
  getSuggestion as apiGetSuggestion,
  putSetting as apiPutSetting,
  type CatalogRow,
  type SuggestedModel,
} from '../../lib/api'
import { ACCURACY_DISCLAIMER_SHORT } from '../../lib/modelDisclaimer'
import { bareLocalModel, isSmallerTier, mergeModels, qualifyLocalModel } from '../settings/modelsFormat'

/**
 * A compact, inline model switcher for the chat input row — the same catalog
 * and switch contract Settings -> Models uses, in a small dropdown rather than
 * the full section. It REUSES the model API directly: `getInstalledModels` +
 * `getSuggestion` for the list, `mergeModels` to merge/mark them, and
 * `putSetting('chat.model', slug)` to switch — no duplicated fetch/merge/switch
 * logic (see ModelsSection.tsx, which is the same three calls).
 *
 * `currentModel` is the live chat model (chat-store's `state.model`, falling
 * back to the settings snapshot ChatPage was handed). The trigger shows exactly
 * that slug — the same `chat-model` testid the read-only header badge used, and
 * the same contract the Settings<->chat bridge and the e2e change-model spec
 * assert against. On a switch this calls `onModelChanged` ONLY after the PUT
 * returns ok (no fake success); the caller (ChatPage) passes chat-store's
 * `setModel`, which is what makes the new slug show here immediately.
 *
 * `api` is the same dependency-injection seam ModelsSection/ChatPage use:
 * production takes DEFAULT_API, a test injects fakes.
 */

interface ModelSelectorApi {
  getInstalledModels: typeof apiGetInstalledModels
  getSuggestion: typeof apiGetSuggestion
  putSetting: typeof apiPutSetting
  /** S10-2: the catalogue, for the cloud groups (one per provider). A test
   * that omits it gets the local list alone, as before. */
  getCatalog?: typeof apiGetCatalog
}

const DEFAULT_API: ModelSelectorApi = {
  getInstalledModels: apiGetInstalledModels,
  getSuggestion: apiGetSuggestion,
  putSetting: apiPutSetting,
  getCatalog: apiGetCatalog,
}

/** Cloud rows grouped by provider, in the catalogue's order. */
export function cloudGroups(rows: CatalogRow[]): { provider: string; rows: CatalogRow[] }[] {
  const groups = new Map<string, CatalogRow[]>()
  for (const row of rows) {
    if (row.kind !== 'cloud') continue
    const list = groups.get(row.provider) ?? []
    list.push(row)
    groups.set(row.provider, list)
  }
  return Array.from(groups, ([provider, rows]) => ({ provider, rows }))
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
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [curated, setCurated] = useState<SuggestedModel[] | null>(null)
  const [cloud, setCloud] = useState<CatalogRow[]>([])
  const [cloudFilter, setCloudFilter] = useState('')
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // Two independent reads, each degrading on its own: a failed installed-list
    // or catalog fetch just leaves the dropdown thinner (mergeModels still
    // surfaces the current model), never a thrown/uncaught error — the same
    // "claim nothing you did not confirm" stance ModelsSection takes.
    api.getInstalledModels().then(
      list => {
        if (!cancelled) setInstalled(list)
      },
      () => {},
    )
    api.getSuggestion().then(
      s => {
        if (!cancelled) setCurated(s.models)
      },
      () => {},
    )
    api.getCatalog?.().then(
      cat => {
        if (!cancelled) setCloud(cat.rows.filter(r => r.kind === 'cloud'))
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [api])

  // Close on an outside click, the same lightweight pattern ModelPicker uses.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const merged = mergeModels(currentModel, installed, curated)
  // Derived from the catalog's own params_b, never a hardcoded model list —
  // see modelsFormat.isSmallerTier. Backs the note's emphasis below.
  const currentIsSmaller = isSmallerTier(merged, currentModel)

  const choose = async (slug: string) => {
    setOpen(false)
    if (slug === bareLocalModel(currentModel)) return
    setError(null)
    setSwitching(true)
    try {
      await api.putSetting('chat.model', qualifyLocalModel(slug))
      // Reflected only now the server confirmed the write — never optimistically.
      onModelChanged(qualifyLocalModel(slug))
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setSwitching(false)
    }
  }

  // A cloud row's id is already `provider:model` — written as is.
  const chooseCloud = async (id: string) => {
    setOpen(false)
    if (id === currentModel) return
    setError(null)
    setSwitching(true)
    try {
      await api.putSetting('chat.model', id)
      onModelChanged(id)
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setSwitching(false)
    }
  }
  const groups = cloudGroups(cloud)
  const filter = cloudFilter.trim().toLowerCase()

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="chat-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        onClick={() => setOpen(o => !o)}
        title="Model Nova answers with — click to switch"
        className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-fast disabled:opacity-60"
      >
        <Cpu size={13} className="shrink-0" />
        {/* The slug alone lives in this span — the icon and chevron are
            siblings — so its textContent is exactly the model id, which the
            Settings<->chat bridge test and the e2e change-model spec both
            assert with toHaveText(slug). */}
        <span data-testid="chat-model" className="font-mono truncate max-w-[10rem]">
          {currentModel ? bareLocalModel(currentModel) : 'Select a model'}
        </span>
        <ChevronDown
          size={13}
          className={clsx('shrink-0 transition-transform duration-fast', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          data-testid="chat-model-menu"
          className="absolute bottom-full left-0 mb-1 z-50 min-w-[14rem] max-w-[20rem] rounded-lg border border-border bg-surface-card shadow-lg glass-overlay dark:border-white/[0.10]"
        >
          <div role="listbox" className="max-h-72 overflow-y-auto custom-scrollbar py-1">
            {groups.length > 0 && (
              <div className="px-3 pb-1 pt-1 text-micro font-semibold uppercase tracking-wider text-content-tertiary">Local</div>
            )}
            {merged.length === 0 ? (
              <p className="px-3 py-2 text-caption text-content-tertiary">No models to show yet.</p>
            ) : (
              merged.map(model => (
                <button
                  key={model.slug}
                  type="button"
                  role="option"
                  aria-selected={model.slug === bareLocalModel(currentModel)}
                  data-testid={`chat-model-option-${model.slug}`}
                  onClick={() => choose(model.slug)}
                  className={clsx(
                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-compact hover:bg-surface-card-hover transition-colors duration-fast',
                    model.slug === bareLocalModel(currentModel) ? 'text-accent' : 'text-content-primary',
                  )}
                >
                  <span className="font-mono truncate">{model.slug}</span>
                  {model.slug === bareLocalModel(currentModel) && <Check size={13} className="shrink-0" />}
                </button>
              ))
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
              const rows = group.rows.filter(r => !filter || r.id.toLowerCase().includes(filter) || r.label.toLowerCase().includes(filter))
              if (rows.length === 0) return null
              return (
                <div key={group.provider} data-testid={`chat-model-group-${group.provider}`}>
                  <div className="px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-content-tertiary">{group.provider}</div>
                  {rows.slice(0, 40).map(row => (
                    <button
                      key={row.id}
                      type="button"
                      role="option"
                      aria-selected={row.id === currentModel}
                      data-testid={`chat-model-option-${row.id}`}
                      onClick={() => chooseCloud(row.id)}
                      className={clsx(
                        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-compact hover:bg-surface-card-hover transition-colors duration-fast',
                        row.id === currentModel ? 'text-accent' : 'text-content-primary',
                      )}
                    >
                      <span className="font-mono truncate">{row.model}</span>
                      {row.id === currentModel && <Check size={13} className="shrink-0" />}
                    </button>
                  ))}
                  {rows.length > 40 && <p className="px-3 py-1 text-micro text-content-tertiary">{rows.length - 40} more — filter to find them</p>}
                </div>
              )
            })}
          </div>

          {/* Light affordance (S3 walk-fix round 12): one caption, only while
              the dropdown is open, so the compact always-visible trigger stays
              uncluttered — see ModelsSection for the prominent version of the
              same honest, qualitative note (lib/modelDisclaimer.ts). Warmer
              tone when the model in use is on the smaller end of the catalog. */}
          <div
            data-testid="chat-model-accuracy-note"
            className={clsx(
              'flex items-start gap-1.5 border-t border-border-subtle px-3 py-1.5 text-micro',
              currentIsSmaller ? 'text-warning' : 'text-content-tertiary',
            )}
          >
            <Info size={11} className="shrink-0 mt-0.5" />
            <span>{ACCURACY_DISCLAIMER_SHORT}</span>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 text-micro text-danger">
          Could not switch model: {error}
        </p>
      )}
    </div>
  )
}
