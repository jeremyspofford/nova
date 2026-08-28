import { useState } from 'react'
import { AlertTriangle, Check, MessageSquare, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '../../../components/ui'
import { putSetting } from '../../../lib/api'
import { streamChat } from '../../../lib/streamChat'
import type { EngineKind } from '../steps'

const GREETING = 'Introduce yourself in one short sentence.'

type Phase = 'idle' | 'checking' | 'passed' | 'failed'

const ENGINE_LABELS: Record<EngineKind, string> = {
  ollama: 'the bundled Ollama',
  remote: 'a remote endpoint',
  cloud: 'a cloud endpoint',
}

/**
 * The only step that can finish setup, and it can only do it by watching a
 * real turn happen.
 *
 * onboarding.completed is written after [DONE] arrives with no error frame
 * and with non-empty text that is on screen while you read this. An error, an
 * interruption, an empty reply, or a failed settings write all land in
 * `failed` with the reason — there is no path here that shows a success
 * screen without the model's own words above it.
 */
export function Ready({
  engine,
  model,
  modelConfigured,
  onBackToSetup,
  onFinish,
}: {
  engine: EngineKind | null
  model: string
  modelConfigured: boolean
  onBackToSetup: () => void
  onFinish: () => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [reply, setReply] = useState('')
  const [servingModel, setServingModel] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const runCheck = async () => {
    setPhase('checking')
    setReply('')
    setFailure(null)
    setServingModel('')

    let text = ''
    let stated: string | null = null

    for await (const event of streamChat({ message: GREETING })) {
      if (event.type === 'meta') setServingModel(event.model)
      if (event.type === 'delta') {
        text += event.text
        setReply(text)
      }
      if (event.type === 'error' || event.type === 'interrupted') stated = event.reason
    }

    if (stated) {
      setFailure(stated)
      setPhase('failed')
      return
    }
    if (!text.trim()) {
      setFailure('the turn finished without a reply — nothing was said, so nothing is proven')
      setPhase('failed')
      return
    }

    try {
      await putSetting('onboarding.completed', true)
    } catch (err) {
      setFailure(
        `the model answered, but recording that setup finished failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      setPhase('failed')
      return
    }
    setPhase('passed')
  }

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <div
        className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 ${
          phase === 'passed' ? 'bg-success' : 'bg-accent/10'
        }`}
      >
        {phase === 'passed' ? (
          <Check className="w-8 h-8 text-white" />
        ) : (
          <Sparkles className="w-8 h-8 text-accent" />
        )}
      </div>

      <h2 className="text-h3 text-content-primary mb-2">
        {phase === 'passed' ? 'Nova is answering' : 'One real answer, then you are done'}
      </h2>

      {modelConfigured ? (
        <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
          <span className="font-mono text-content-primary">{model}</span> on{' '}
          {engine ? ENGINE_LABELS[engine] : 'the configured engine'}. Setup finishes only
          if it actually replies.
        </p>
      ) : (
        <div className="w-full max-w-sm rounded-lg bg-warning-dim border border-warning/20 p-3 mb-6">
          <p className="text-compact text-amber-700 dark:text-amber-400 font-medium">
            No model configured
          </p>
          <p className="text-caption text-content-secondary mt-1">
            Setup was skipped, so nothing has been chosen to answer with. Go back and
            finish the engine and model steps — a check run now will fail, and it will
            say why.
          </p>
        </div>
      )}

      {(phase === 'checking' || reply) && (
        <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface-elevated p-3 mb-4">
          <p className="text-micro text-content-tertiary mb-1">
            {servingModel ? `${servingModel} says` : 'waiting for the first token…'}
          </p>
          <p className="text-compact text-content-primary whitespace-pre-wrap">
            {reply || (phase === 'checking' ? '…' : '')}
          </p>
        </div>
      )}

      {phase === 'failed' && failure && (
        <div
          role="alert"
          className="w-full max-w-sm rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger flex items-start gap-2 mb-4"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{failure}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-3 justify-center mt-2">
        {phase !== 'passed' && (
          <Button
            size="lg"
            onClick={runCheck}
            loading={phase === 'checking'}
            icon={phase === 'failed' ? <RotateCcw size={16} /> : undefined}
          >
            {phase === 'failed' ? 'Try again' : 'Say hello'}
          </Button>
        )}
        {phase !== 'passed' && (
          <Button size="lg" variant="outline" onClick={onBackToSetup} disabled={phase === 'checking'}>
            Back to setup
          </Button>
        )}
        {phase === 'passed' && (
          <Button size="lg" icon={<MessageSquare size={16} />} onClick={onFinish}>
            Meet Nova
          </Button>
        )}
      </div>
    </div>
  )
}
