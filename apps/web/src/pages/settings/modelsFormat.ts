/**
 * Model ids are `provider:model` (S10-pre). The bundled ollama is the
 * provider named `ollama`, so a local model is written `ollama:qwen3:8b` —
 * NEVER bare: a bare id routes to whichever provider is currently the
 * default, which Settings → Providers lets the owner move. The local
 * catalogue still works in bare slugs, so these two are the seam.
 */
export const LOCAL_PROVIDER = 'ollama'

export function qualifyLocalModel(slug: string): string {
  return slug.startsWith(`${LOCAL_PROVIDER}:`) ? slug : `${LOCAL_PROVIDER}:${slug}`
}

/** The bare local slug of a chat model id, or the id unchanged when it names
 * another provider (so it never matches a local row by accident). */
export function bareLocalModel(model: string): string {
  return model.startsWith(`${LOCAL_PROVIDER}:`) ? model.slice(LOCAL_PROVIDER.length + 1) : model
}

import type { ModelFit, SuggestedModel } from '../../lib/api'

/**
 * One row of the Settings -> Models list: a curated catalog entry, an
 * installed-but-uncatalogued model, or chat.model itself when it matches
 * neither — merged so every model Nova could serve appears exactly once,
 * with the operator's actual current pick always represented.
 */
export interface MergedModel {
  slug: string
  label: string
  note: string
  minVramGb: number | null
  installed: boolean
  curated: boolean
  isCurrent: boolean
  /** From the gateway's GET /admin/suggest (slice-02e-model-surface T2).
   * null for a model the curated catalog never covered — an installed-but-
   * uncatalogued model, or chat.model given its own entry below — since
   * there is no tier estimate or probe row to compute a verdict from. */
  fit: ModelFit | null
  /** Billions of parameters, straight from the curated catalog's params_b —
   * null for the same "never covered" cases fit is null for. The only size
   * signal isSmallerTier below is allowed to use; nothing here is estimated. */
  paramsB: number | null
}

/**
 * Curated (from GET /api/v1/models/suggest) and installed (from GET
 * /api/v1/models) merged into one list, keyed by slug, with chat.model
 * marked `isCurrent` wherever it appears — and given its own entry when it
 * appears nowhere else, so a remote/cloud model id never goes unrepresented.
 *
 * `installed: null` (the installed-models fetch failed) is treated the same
 * as an empty list: nothing is claimed installed that was not confirmed —
 * see "never report success you did not check".
 */
export function mergeModels(
  chatModel: string,
  installed: string[] | null,
  curatedModels: SuggestedModel[] | null,
): MergedModel[] {
  const installedSet = new Set(installed ?? [])
  const bySlug = new Map<string, MergedModel>()

  for (const c of curatedModels ?? []) {
    bySlug.set(c.slug, {
      slug: c.slug,
      label: c.label,
      note: c.note,
      minVramGb: c.min_vram_gb,
      installed: installedSet.has(c.slug),
      curated: true,
      isCurrent: c.slug === bareLocalModel(chatModel),
      fit: c.fit ?? null,
      paramsB: c.params_b,
    })
  }

  for (const slug of installedSet) {
    if (bySlug.has(slug)) continue
    bySlug.set(slug, {
      slug,
      label: slug,
      note: '',
      minVramGb: null,
      installed: true,
      curated: false,
      isCurrent: slug === bareLocalModel(chatModel),
      fit: null,
      paramsB: null,
    })
  }

  if (chatModel && !bySlug.has(chatModel)) {
    bySlug.set(chatModel, {
      slug: chatModel,
      label: chatModel,
      note: '',
      minVramGb: null,
      installed: installedSet.has(chatModel),
      curated: false,
      isCurrent: true,
      fit: null,
      paramsB: null,
    })
  }

  return Array.from(bySlug.values()).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    return a.slug.localeCompare(b.slug)
  })
}

/**
 * True when `slug`'s parameter count sits below the mean of every known
 * paramsB in `models` — a comparison relative to what the catalog actually
 * offers right now, on this box, never a hardcoded "8B is small" cutoff
 * (CLAUDE.md's "derived, never hardcoded" rule). Backs the size-aware
 * emphasis on the accuracy disclaimer in ModelsSection and ModelSelector —
 * see lib/modelDisclaimer.ts.
 *
 * A model missing paramsB (installed-but-uncatalogued, or chat.model
 * standing in for a remote/cloud id) can't be placed on the scale and reads
 * as not-smaller — nothing is invented for data that isn't there. Also
 * false with fewer than two known sizes to compare, since "smaller" has no
 * meaning without a spread to be smaller relative to.
 */
export function isSmallerTier(models: MergedModel[], slug: string): boolean {
  const known = models.map(m => m.paramsB).filter((n): n is number => n !== null)
  if (known.length < 2) return false
  const target = models.find(m => m.slug === slug)?.paramsB
  if (target == null) return false
  const mean = known.reduce((sum, n) => sum + n, 0) / known.length
  return target < mean
}
