import { useCallback, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useAuth } from '../../stores/auth-store'
import {
  initialStep,
  nextStep,
  prevStep,
  wizardSteps,
  STEP_LABELS,
  type EngineKind,
  type WizardStep,
} from './steps'
import { Welcome } from './steps/Welcome'
import { CreateAccount } from './steps/CreateAccount'
import { HardwareDetection } from './steps/HardwareDetection'
import { ChooseEngine } from './steps/ChooseEngine'
import { PickModel } from './steps/PickModel'
import { Downloading } from './steps/Downloading'
import { Ready } from './steps/Ready'

function StepIndicator({ steps, current }: { steps: WizardStep[]; current: WizardStep }) {
  const currentIdx = steps.indexOf(current)
  return (
    <ol className="flex items-center justify-center gap-1 mb-8">
      {steps.map((step, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <li key={step} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                aria-current={active ? 'step' : undefined}
                className={clsx(
                  'w-8 h-8 rounded-full flex items-center justify-center text-caption font-medium transition-colors',
                  done && 'bg-success text-white',
                  active && 'bg-accent text-neutral-950',
                  !done && !active &&
                    'bg-surface-elevated text-content-tertiary border border-border-subtle',
                )}
              >
                {done ? <Check size={14} /> : i + 1}
              </div>
              <span
                className={clsx(
                  'mt-1 text-micro',
                  active ? 'text-content-primary font-medium' : 'text-content-tertiary',
                )}
              >
                {STEP_LABELS[step]}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={clsx(
                  'w-6 sm:w-10 h-0.5 mx-1 mt-[-14px]',
                  i < currentIdx ? 'bg-success' : 'bg-border-subtle',
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * First-run setup. Every step writes its own result to core as it is made —
 * the backend config on Engine, chat.model when the model is really in
 * place, onboarding.completed only after Ready has seen a real streamed
 * reply on screen. Nothing is deferred to a final "save" that could claim
 * a setup that never happened.
 */
export function OnboardingWizard({ onCompleted }: { onCompleted: () => void }) {
  const { hasUsers } = useAuth()
  // Frozen at mount: registering an owner mid-run must not make the step
  // list shrink under the progress indicator.
  const hadUsersAtStart = useRef(hasUsers).current

  const [engine, setEngine] = useState<EngineKind | null>(null)
  const [model, setModel] = useState('')
  const [modelConfigured, setModelConfigured] = useState(false)
  const [step, setStep] = useState<WizardStep>(() => initialStep(hadUsersAtStart))

  const steps = useMemo(
    () => wizardSteps({ hasUsers: hadUsersAtStart, engine }),
    [hadUsersAtStart, engine],
  )

  const goNext = useCallback(() => {
    setStep(current => nextStep(steps, current) ?? current)
  }, [steps])

  const goBack = useCallback(() => {
    setStep(current => prevStep(steps, current) ?? current)
  }, [steps])

  const handleEngineChosen = useCallback(
    (kind: EngineKind, chosenModel: string) => {
      setEngine(kind)
      setModel(chosenModel)
      setModelConfigured(false)
      // The engine decides whether a download step exists at all, so the
      // next step is read off the list this choice produces.
      const withEngine = wizardSteps({ hasUsers: hadUsersAtStart, engine: kind })
      setStep(nextStep(withEngine, 'engine') ?? 'ready')
    },
    [hadUsersAtStart],
  )

  const handleModelReady = useCallback((chosen: string) => {
    setModel(chosen)
    setModelConfigured(true)
  }, [])

  return (
    <div className="min-h-dvh bg-surface-root dark:bg-transparent flex flex-col items-center justify-center py-8">
      <div className="w-full max-w-xl mx-auto px-4">
        <StepIndicator steps={steps} current={step} />

        <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm glass-card dark:border-white/[0.08]">
          {step === 'welcome' && (
            // Skipping lands on Ready with nothing configured. Ready says so
            // in as many words — it never shows a success it did not see.
            <Welcome onNext={goNext} onSkip={() => setStep('ready')} />
          )}
          {step === 'account' && <CreateAccount onNext={goNext} />}
          {step === 'hardware' && <HardwareDetection onNext={goNext} />}
          {step === 'engine' && (
            <ChooseEngine onChosen={handleEngineChosen} onBack={goBack} />
          )}
          {step === 'model' && engine && (
            <PickModel
              engine={engine}
              selected={model}
              onSelect={setModel}
              onConfigured={handleModelReady}
              onNext={goNext}
              onBack={goBack}
            />
          )}
          {step === 'downloading' && (
            <Downloading
              model={model}
              onComplete={handleModelReady}
              onNext={goNext}
              onBack={goBack}
            />
          )}
          {step === 'ready' && (
            <Ready
              engine={engine}
              model={model}
              modelConfigured={modelConfigured}
              onBackToSetup={() => setStep('hardware')}
              onFinish={onCompleted}
            />
          )}
        </div>
      </div>
    </div>
  )
}
