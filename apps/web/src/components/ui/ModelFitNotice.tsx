import { AlertTriangle } from 'lucide-react'
import { Badge } from './Badge'
import { fitLabel, fitSeverity, fitSourceLabel } from '../../lib/modelFit'
import type { ModelFit } from '../../lib/api'

/**
 * The fit verdict + verified/estimated badge for one model, shared by
 * Settings -> Models (ModelsSection) and the onboarding wizard's Pick a
 * model step — the two pickers slice-02e-model-surface's T2 requires to
 * both show a fit signal BEFORE the operator picks or downloads.
 *
 * `fit` is null for a model the curated catalog never covered (an
 * installed-but-uncatalogued model, or chat.model itself standing in for a
 * remote/cloud id) — rendered identically to the gateway's own 'unknown'
 * verdict, since neither case has a real number to show.
 */
export function ModelFitNotice({ fit }: { fit: ModelFit | null | undefined }) {
  const label = fitLabel(fit)
  const sourceLabel = fitSourceLabel(fit)
  const severity = fitSeverity(fit)
  const unknownReason = fit?.verdict === 'unknown' ? fit.reason : null

  const sourceBadge = sourceLabel && (
    <Badge color={fit?.source === 'verified' ? 'info' : 'neutral'} size="sm">
      {sourceLabel}
    </Badge>
  )

  // wont_fit gets an explicit alert box (the S1 wizard's missing warning),
  // not just a colored badge like the other three verdicts.
  if (fit?.verdict === 'wont_fit') {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <div
          role="alert"
          className="flex items-center gap-1.5 rounded-sm bg-danger/10 border border-danger/30 px-2 py-1 text-caption text-danger"
        >
          <AlertTriangle size={13} className="shrink-0" />
          <span>{label}</span>
        </div>
        {sourceBadge}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap" title={unknownReason ?? undefined}>
      <Badge color={severity} size="sm">
        {label}
      </Badge>
      {sourceBadge}
    </div>
  )
}
