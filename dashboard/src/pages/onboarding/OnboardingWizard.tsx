import { useState, useCallback } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import type { HardwareInfo } from '../../api-recovery'
import { Welcome } from './steps/Welcome'
import { HardwareDetection } from './steps/HardwareDetection'
import { ChooseEngine } from './steps/ChooseEngine'
import { PickModel } from './steps/PickModel'
import { Downloading } from './steps/Downloading'
import { Ready } from './steps/Ready'

type Step = 'welcome' | 'hardware' | 'engine' | 'model' | 'downloading' | 'ready'

const stepOrder: Step[] = ['welcome', 'hardware', 'engine', 'model', 'downloading', 'ready']

const stepLabels: Record<Step, string> = {
  welcome: 'Welcome',
  hardware: 'Hardware',
  engine: 'Engine',
  model: 'Model',
  downloading: 'Setup',
  ready: 'Ready',
}

export function OnboardingWizard() {
  const [step, setStep] = useState<Step>('welcome')
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [engine, setEngine] = useState<'vllm' | 'ollama' | 'cloud' | 'lmstudio'>('ollama')
  const [model, setModel] = useState('')

  const completeOnboarding = useCallback(async () => {
    try {
      // Public one-shot bootstrap endpoint — works before any credential
      // exists in the browser (409 on an already-completed instance is fine).
      await fetch('/api/v1/onboarding/complete', { method: 'POST' })
    } catch {
      // Best-effort -- don't block the user
    }
    window.location.href = '/chat'
  }, [])

  const handleSkip = useCallback(() => {
    completeOnboarding()
  }, [completeOnboarding])

  const handleHardwareNext = useCallback((hw: HardwareInfo) => {
    setHardware(hw)
    const totalVram = hw.gpus.reduce((s, g) => s + g.vram_gb, 0)
    if (totalVram >= 8) setEngine('vllm')
    else setEngine('ollama')
    setStep('engine')
  }, [])

  const handleEngineNext = useCallback(() => {
    // Cloud and LM Studio skip model selection: cloud has no local model, and
    // LM Studio models are loaded in its GUI (nothing to pull).
    if (engine === 'cloud' || engine === 'lmstudio') {
      setStep('downloading')
    } else {
      setStep('model')
    }
  }, [engine])

  const handleModelNext = useCallback(() => {
    setStep('downloading')
  }, [])

  const handleDownloadNext = useCallback(() => {
    setStep('ready')
  }, [])

  const currentIdx = stepOrder.indexOf(step)

  return (
    <div className="min-h-screen bg-surface-root dark:bg-transparent flex flex-col items-center justify-center">
      <div className="w-full max-w-xl mx-auto px-4">
        {/* Step progress indicator */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {stepOrder.map((s, i) => {
            const isDone = i < currentIdx
            const isCurrent = i === currentIdx
            const isPending = i > currentIdx

            return (
              <div key={s} className="flex items-center">
                {/* Step circle */}
                <div className="flex flex-col items-center">
                  <div
                    className={clsx(
                      'w-8 h-8 rounded-full flex items-center justify-center text-caption font-medium transition-colors',
                      isDone && 'bg-success text-white',
                      isCurrent && 'bg-accent text-neutral-950',
                      isPending && 'bg-surface-elevated text-content-tertiary border border-border-subtle',
                    )}
                  >
                    {isDone ? <Check size={14} /> : i + 1}
                  </div>
                  <span className={clsx(
                    'mt-1 text-micro',
                    isCurrent ? 'text-content-primary font-medium' : 'text-content-tertiary',
                  )}>
                    {stepLabels[s]}
                  </span>
                </div>

                {/* Connector line */}
                {i < stepOrder.length - 1 && (
                  <div
                    className={clsx(
                      'w-6 sm:w-10 h-0.5 mx-1 mt-[-14px]',
                      i < currentIdx ? 'bg-success' : 'bg-border-subtle',
                    )}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Step content card */}
        <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm glass-card dark:border-white/[0.08]">
          {step === 'welcome' && (
            <Welcome onNext={() => setStep('hardware')} onSkip={handleSkip} />
          )}
          {step === 'hardware' && (
            <HardwareDetection onNext={handleHardwareNext} />
          )}
          {step === 'engine' && hardware && (
            <ChooseEngine
              hardware={hardware}
              selected={engine}
              onSelect={setEngine}
              onNext={handleEngineNext}
              onBack={() => setStep('hardware')}
            />
          )}
          {step === 'model' && hardware && (
            <PickModel
              backend={engine}
              maxVramGb={hardware.gpus.reduce((s, g) => s + g.vram_gb, 0)}
              selectedModel={model}
              onSelect={setModel}
              onNext={handleModelNext}
              onBack={() => setStep('engine')}
            />
          )}
          {step === 'downloading' && (
            <Downloading
              backend={engine}
              model={model}
              onNext={handleDownloadNext}
            />
          )}
          {step === 'ready' && (
            <Ready
              backend={engine}
              model={model}
              onFinish={completeOnboarding}
            />
          )}
        </div>
      </div>
    </div>
  )
}
