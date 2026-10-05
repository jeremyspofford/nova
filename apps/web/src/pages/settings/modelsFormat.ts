/**
 * Model ids are `provider:model` (S10-pre), split on the FIRST colon. The
 * bundled engine is the provider named `hub` (S40; gateway engines.BUILTIN,
 * a reserved name), so a local model is written `hub:qwen3:8b` — NEVER bare:
 * a bare id routes to whichever provider is the default, which Settings →
 * Providers lets the owner move. `library:` rows are catalogue entries on no
 * machine yet: they can be pulled, never routed to. The local catalogue
 * still works in bare slugs, so the two functions below are the seam.
 */
export const LOCAL_PROVIDER = 'hub'
export const LIBRARY = 'library'

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
   * null for the same "never covered" cases fit is null for; nothing here is
   * estimated. */
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

