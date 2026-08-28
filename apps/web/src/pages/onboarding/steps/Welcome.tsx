import { Sparkles } from 'lucide-react'
import { Button } from '../../../components/ui'

export function Welcome({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-16 h-16 rounded-xl bg-accent/10 flex items-center justify-center mb-6">
        <Sparkles className="w-8 h-8 text-accent" />
      </div>
      <h1 className="text-h2 text-content-primary mb-2">Welcome to Nova</h1>
      <p className="text-compact text-content-secondary max-w-md mb-8">
        This runs on your hardware, in your house. The next few steps create your
        account, look at what this machine can do, and get a model answering — then
        you can talk to it.
      </p>
      <Button size="lg" onClick={onNext}>
        Get started
      </Button>
      <button
        type="button"
        onClick={onSkip}
        className="mt-4 text-caption text-content-tertiary hover:text-content-secondary transition-colors"
      >
        Skip setup
      </button>
      <p className="mt-2 text-micro text-content-tertiary max-w-xs">
        Skipping leaves no engine and no model configured. Nothing will answer until
        you come back and finish.
      </p>
    </div>
  )
}
