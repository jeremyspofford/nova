import { useEffect, useState, useRef, useCallback } from 'react'
import { Loader2, Check, AlertTriangle, RotateCcw } from 'lucide-react'
import { recoveryFetch, getBackendStatus, type BackendStatus } from '../../../api-recovery'
import { Button } from '../../../components/ui'
import clsx from 'clsx'

interface Props {
  backend: string
  model: string
  onNext: () => void
}

type Phase = 'starting' | 'downloading' | 'loading' | 'ready' | 'error'

const phaseLabels: Record<Phase, string> = {
  starting: 'Starting backend...',
  downloading: 'Downloading model...',
  loading: 'Loading model into memory...',
  ready: 'Ready!',
  error: 'Something went wrong',
}

const phaseOrder: Phase[] = ['starting', 'downloading', 'loading', 'ready']

function mapStateToPhase(status: BackendStatus): Phase {
  const state = status.state?.toLowerCase() ?? ''
  const step = status.switch_progress?.step?.toLowerCase() ?? ''

  if (state === 'ready') return 'ready'
  if (step.includes('download') || step.includes('pull')) return 'downloading'
  if (step.includes('load') || state === 'loading') return 'loading'
  if (state === 'starting' || state === 'pulling' || step.includes('start')) return 'starting'
  if (state === 'error' || state === 'failed') return 'error'
  return 'starting'
}

export function Downloading({ backend, model, onNext }: Props) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [detail, setDetail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const retry = useCallback(() => {
    setError(null)
    setPhase('starting')
    setDetail('')
    setAttempt(a => a + 1)
  }, [])

  useEffect(() => {
    async function startBackend() {
      try {
        if (backend === 'cloud') {
          setPhase('ready')
          return
        }

        await recoveryFetch(`/api/v1/recovery/inference/backend/${backend}/start`, {
          method: 'POST',
        })

        if (backend === 'ollama') {
          setPhase('downloading')
          setDetail(`Pulling ${model}...`)
          try {
            await recoveryFetch(`/api/v1/recovery/inference/backend/${backend}/switch-model`, {
              method: 'POST',
              body: JSON.stringify({ model }),
            })
          } catch {
            // switch-model may return before completion; polling will track progress
          }
        }

        if (backend === 'vllm') {
          setPhase('downloading')
          setDetail(`Loading ${model}...`)
        }

        pollRef.current = setInterval(async () => {
          try {
            const status = await getBackendStatus()
            const newPhase = mapStateToPhase(status)
            setPhase(newPhase)
            if (status.switch_progress?.detail) {
              setDetail(status.switch_progress.detail)
            }
            if (newPhase === 'ready') {
              if (pollRef.current) clearInterval(pollRef.current)
            }
            if (newPhase === 'error') {
              if (pollRef.current) clearInterval(pollRef.current)
              setError(status.switch_progress?.detail ?? 'Backend failed to start')
            }
          } catch {
            // Ignore transient poll failures
          }
        }, 2000)
      } catch (e) {
        setPhase('error')
        setError(e instanceof Error ? e.message : 'Failed to start backend')
      }
    }

    startBackend()

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [backend, model, attempt])

  // Auto-advance when ready
  useEffect(() => {
    if (phase === 'ready') {
      const t = setTimeout(onNext, 1500)
      return () => clearTimeout(t)
    }
  }, [phase, onNext])

  return (
    <div className="flex flex-col items-center py-16 px-6">
      <h2 className="text-h3 text-content-primary mb-2">
        Setting Up
      </h2>
      <p className="text-compact text-content-secondary mb-10 text-center max-w-md">
        {backend === 'cloud'
          ? 'Configuring cloud providers...'
          : backend === 'lmstudio'
            ? 'Connecting to LM Studio...'
            : `Installing ${model} via ${backend}...`}
      </p>

      {/* Progress steps */}
      <div className="w-full max-w-xs space-y-4">
        {phaseOrder.map((p, i) => {
          const currentIdx = phaseOrder.indexOf(phase)
          const isDone = i < currentIdx || phase === 'ready'
          const isCurrent = i === currentIdx && phase !== 'ready' && phase !== 'error'

          return (
            <div key={p} className="flex items-center gap-3">
              <div className={clsx(
                'w-6 h-6 rounded-full flex items-center justify-center shrink-0',
                isDone && 'bg-success',
                isCurrent && 'bg-accent/20',
                !isDone && !isCurrent && 'bg-surface-elevated',
              )}>
                {isDone ? (
                  <Check className="w-3.5 h-3.5 text-white" />
                ) : isCurrent ? (
                  <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
                ) : (
                  <div className="w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-600" />
                )}
              </div>
              <span className={clsx(
                'text-compact',
                isDone && 'text-content-secondary',
                isCurrent && 'text-content-primary font-medium',
                !isDone && !isCurrent && 'text-content-tertiary',
              )}>
                {phaseLabels[p]}
              </span>
            </div>
          )
        })}
      </div>

      {/* Detail text */}
      {detail && phase !== 'ready' && phase !== 'error' && (
        <p className="mt-6 text-caption text-content-tertiary text-center max-w-sm truncate">
          {detail}
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="mt-6 flex flex-col items-center">
          <div className="flex items-center gap-2 text-warning mb-2">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-compact font-medium">Error</span>
          </div>
          <p className="text-caption text-content-secondary text-center max-w-sm mb-4">
            {error}
          </p>
          <Button icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
