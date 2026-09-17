import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react'
import { Button, ProgressBar } from '../../../components/ui'
import { pullModel, putSetting } from '../../../lib/api'
import { STREAM_ENDED_QUIET, formatBytes, preflightNote } from '../../../lib/pullStream'

type Phase = 'pulling' | 'done' | 'failed'


/**
 * Pulls the weights and only then writes chat.model.
 *
 * "Only then" is the whole point: the setting is written when ollama has said
 * `success` and not one line earlier. A stream that stops quietly, an error
 * line, or a failed settings write all land in `failed` with the reason on
 * screen — none of them can look like a finished download.
 */
export function Downloading({
  model,
  onComplete,
  onNext,
  onBack,
}: {
  model: string
  onComplete: (model: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const [phase, setPhase] = useState<Phase>('pulling')
  const [status, setStatus] = useState('starting the download…')
  const [completed, setCompleted] = useState(0)
  const [total, setTotal] = useState(0)
  const [preflight, setPreflight] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    // Per-run, not a ref: StrictMode mounts this effect twice in dev, and a
    // shared flag would let the second run un-cancel the first one's loop.
    let abandoned = false
    let sawSuccess = false
    let failure: string | null = null

    setPhase('pulling')
    setStatus('starting the download…')
    setCompleted(0)
    setTotal(0)
    setError(null)

    const run = async () => {
      try {
        for await (const line of pullModel(model, controller.signal)) {
          if (abandoned) return
          if (line.error) {
            failure = line.error
            break
          }
          if (line.status === 'preflight') {
            setPreflight(preflightNote(line, model))
            continue
          }
          if (line.status) setStatus(line.status)
          if (line.status === 'success') sawSuccess = true
          if (typeof line.total === 'number') setTotal(line.total)
          if (typeof line.completed === 'number') setCompleted(line.completed)
        }
      } catch (err) {
        if (abandoned) return
        failure = err instanceof Error ? err.message : String(err)
      }

      if (abandoned) return
      if (failure) {
        setError(failure)
        setPhase('failed')
        return
      }
      if (!sawSuccess) {
        setError(STREAM_ENDED_QUIET)
        setPhase('failed')
        return
      }

      try {
        await putSetting('chat.model', model)
      } catch (err) {
        // The weights are here but Nova was not told to use them. That is not
        // a finished step.
        setError(
          `${model} downloaded, but saving it as the chat model failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        setPhase('failed')
        return
      }
      onComplete(model)
      setPhase('done')
    }

    void run()
    return () => {
      abandoned = true
      controller.abort()
    }
  }, [model, attempt, onComplete])

  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <h2 className="text-h3 text-content-primary mb-2">
        {phase === 'done' ? 'Model installed' : 'Downloading the model'}
      </h2>
      <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
        <span className="font-mono">{model}</span>
        {phase === 'pulling' && ' — this can take a while on a first pull.'}
      </p>

      {preflight && (
        <p className="text-caption text-content-tertiary mb-4 text-center max-w-sm">{preflight}</p>
      )}

      <div className="w-full max-w-sm space-y-3">
        {phase === 'pulling' && (
          <>
            <div className="flex items-center gap-2 text-compact text-content-primary">
              <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
              <span className="truncate">{status}</span>
            </div>
            <ProgressBar
              value={percent ?? undefined}
              variant={percent === null ? 'indeterminate' : 'determinate'}
            />
            <p className="text-caption text-content-tertiary">
              {total > 0
                ? `${formatBytes(completed)} of ${formatBytes(total)}${
                    percent === null ? '' : ` (${percent}%)`
                  }`
                : 'waiting for the first progress report…'}
            </p>
          </>
        )}

        {phase === 'done' && (
          <div className="flex items-center gap-2 text-compact text-content-primary">
            <Check className="w-4 h-4 text-success shrink-0" />
            <span>Installed and set as the chat model.</span>
          </div>
        )}

        {phase === 'failed' && error && (
          <div
            role="alert"
            className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger flex items-start gap-2"
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="flex gap-3 mt-8">
        {/* Leaving the step unmounts it, and the cleanup aborts the pull. */}
        <Button variant="outline" onClick={onBack}>
          {phase === 'pulling' ? 'Cancel' : 'Back'}
        </Button>
        {phase === 'failed' && (
          <Button icon={<RotateCcw size={14} />} onClick={() => setAttempt(a => a + 1)}>
            Try again
          </Button>
        )}
        {phase === 'done' && <Button onClick={onNext}>Continue</Button>}
      </div>
    </div>
  )
}
