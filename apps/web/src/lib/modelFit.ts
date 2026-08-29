import type { ModelFit } from './api'

/**
 * Pure presentation for a gateway-computed fit verdict (GET /api/v1/models/
 * suggest's per-model `fit`, services/gateway/app/fit.py). `fit` is missing
 * entirely for a model the curated catalog never covered (an installed-but-
 * uncatalogued model, or chat.model itself when it matches neither list) —
 * that renders identically to the gateway's own 'unknown' verdict, since
 * both mean the same thing to the operator: nothing to show, stated as such.
 */

const LABELS: Record<ModelFit['verdict'], (fit: ModelFit) => string> = {
  comfortable: () => 'comfortable',
  tight: fit => `tight fit — ~${fit.needed_gb}/${fit.total_gb} GB`,
  wont_fit: () => "won't fit on this GPU",
  unknown: () => 'fit unknown',
}

export function fitLabel(fit: ModelFit | null | undefined): string {
  if (!fit) return 'fit unknown'
  return LABELS[fit.verdict](fit)
}

export function fitSourceLabel(fit: ModelFit | null | undefined): string | null {
  if (!fit) return null
  return fit.source === 'verified' ? 'verified on your hardware' : 'estimated'
}

export type FitSeverity = 'success' | 'warning' | 'danger' | 'neutral'

const SEVERITIES: Record<ModelFit['verdict'], FitSeverity> = {
  comfortable: 'success',
  tight: 'warning',
  wont_fit: 'danger',
  unknown: 'neutral',
}

export function fitSeverity(fit: ModelFit | null | undefined): FitSeverity {
  if (!fit) return 'neutral'
  return SEVERITIES[fit.verdict]
}
