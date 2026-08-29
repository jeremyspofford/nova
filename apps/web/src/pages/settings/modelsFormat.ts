import type { SuggestedModel } from '../../lib/api'

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
      isCurrent: c.slug === chatModel,
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
      isCurrent: slug === chatModel,
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
    })
  }

  return Array.from(bySlug.values()).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    return a.slug.localeCompare(b.slug)
  })
}
