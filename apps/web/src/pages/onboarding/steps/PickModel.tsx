import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Badge, Button, Input } from '../../../components/ui'
import { getSuggestion, putSetting, type Suggestion } from '../../../lib/api'
import type { EngineKind } from '../steps'

/**
 * For the bundled engine this lists what actually fits the hardware core
 * measured, with the tier's reasoning printed rather than hidden. For a
 * remote or cloud engine there is nothing to pull, so the model is typed and
 * written straight to chat.model — the download step does not exist on that
 * path to do it later.
 */
export function PickModel({
  engine,
  selected,
  onSelect,
  onConfigured,
  onNext,
  onBack,
}: {
  engine: EngineKind
  selected: string
  onSelect: (slug: string) => void
  onConfigured: (model: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const local = engine === 'ollama'
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [loading, setLoading] = useState(local)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!local) return
    setLoading(true)
    getSuggestion()
      .then(setSuggestion)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [local])

  const handleContinue = async () => {
    if (local) {
      // chat.model is written once the weights are really here — see Downloading.
      onNext()
      return
    }
    setError(null)
    setSaving(true)
    try {
      await putSetting('chat.model', selected.trim())
      onConfigured(selected.trim())
      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
        <p className="text-compact text-content-secondary">Working out what fits…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <h2 className="text-h3 text-content-primary mb-2">Pick a model</h2>

      {local && suggestion && (
        <>
          <p className="text-compact text-content-secondary mb-1 text-center max-w-md">
            {suggestion.rationale}
          </p>
          <p className="text-caption text-content-tertiary mb-6">
            Tier: <span className="font-mono">{suggestion.tier}</span>
          </p>
        </>
      )}

      {!local && (
        <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
          Name the model this endpoint should answer with. Nova sends it verbatim.
        </p>
      )}

      <div className="w-full max-w-sm space-y-3">
        {!local && (
          <Input
            label="Model"
            value={selected}
            onChange={e => onSelect(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
            autoFocus
          />
        )}

        {local && suggestion && suggestion.models.length === 0 && (
          <div className="flex flex-col items-center text-center gap-3 py-6">
            <AlertTriangle className="w-8 h-8 text-warning" />
            <p className="text-compact text-content-secondary">
              No curated model matches this tier. Go back and point Nova at a remote
              or cloud endpoint instead.
            </p>
          </div>
        )}

        {local &&
          suggestion?.models.map(candidate => {
            const isSelected = selected === candidate.slug
            return (
              <button
                key={candidate.slug}
                type="button"
                onClick={() => onSelect(candidate.slug)}
                className={clsx(
                  'w-full text-left rounded-lg border p-4 transition-colors',
                  isSelected
                    ? 'border-accent bg-accent/5'
                    : 'border-border-subtle hover:border-border',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-compact font-medium text-content-primary truncate">
                      {candidate.label}
                    </p>
                    <p className="font-mono text-micro text-content-tertiary truncate">
                      {candidate.slug}
                    </p>
                    {candidate.note && (
                      <p className="text-caption text-content-secondary mt-1">{candidate.note}</p>
                    )}
                  </div>
                  <Badge color="neutral" size="sm" className="shrink-0">
                    {candidate.min_vram_gb} GB VRAM
                  </Badge>
                </div>
              </button>
            )
          })}

        {error && (
          <div
            role="alert"
            className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button onClick={handleContinue} loading={saving} disabled={!selected.trim()}>
          Continue
        </Button>
      </div>
    </div>
  )
}
