import { useQuery } from '@tanstack/react-query'
import { Server, Cloud, Cpu, Laptop } from 'lucide-react'
import type { HardwareInfo } from '../../../api-recovery'
import { getLMStudioStatus } from '../../../api'
import { Button, Badge } from '../../../components/ui'
import clsx from 'clsx'

type Engine = 'vllm' | 'ollama' | 'lmstudio' | 'cloud'

interface Props {
  hardware: HardwareInfo
  selected: Engine
  onSelect: (engine: Engine) => void
  onNext: () => void
  onBack: () => void
}

const engines: Array<{
  id: Engine
  label: string
  description: string
  icon: typeof Server
  requiresGpu: boolean
  minVram?: number
  requiresProbe?: boolean
}> = [
  {
    id: 'vllm',
    label: 'vLLM',
    description: 'High-performance GPU inference. Best throughput for NVIDIA GPUs.',
    icon: Server,
    requiresGpu: true,
    minVram: 8,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Easy local inference. Works on CPU and GPU. Great for getting started.',
    icon: Cpu,
    requiresGpu: false,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: 'Use the LM Studio desktop app for local models. Requires LM Studio running on your host with the local server started.',
    icon: Laptop,
    requiresGpu: false,
    requiresProbe: true,
  },
  {
    id: 'cloud',
    label: 'Cloud Only',
    description: 'Use cloud LLM providers (Anthropic, OpenAI, etc). No local setup needed.',
    icon: Cloud,
    requiresGpu: false,
  },
]

function getRecommended(hardware: HardwareInfo): Engine {
  const totalVram = hardware.gpus.reduce((s, g) => s + g.vram_gb, 0)
  if (totalVram >= 8) return 'vllm'
  return 'ollama'
}

export function ChooseEngine({ hardware, selected, onSelect, onNext, onBack }: Props) {
  // Probe for a host-side LM Studio server. The option only appears when one is
  // reachable (via the gateway's host.docker.internal mapping) so users never
  // see a dead choice. Probe is best-effort: never blocks the step.
  const { data: lmstudioStatus } = useQuery({
    queryKey: ['lmstudio-status'],
    queryFn: getLMStudioStatus,
    staleTime: 30_000,
    retry: 0,
  })
  const lmstudioReachable = !!lmstudioStatus?.healthy

  const recommended = getRecommended(hardware)
  const hasGpu = hardware.gpus.length > 0
  const totalVram = hardware.gpus.reduce((s, g) => s + g.vram_gb, 0)

  const available = engines.filter(e => {
    if (e.requiresGpu && !hasGpu) return false
    if (e.minVram && totalVram < e.minVram) return false
    if (e.requiresProbe && !lmstudioReachable) return false
    return true
  })

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <h2 className="text-h3 text-content-primary mb-2">
        Choose Your Engine
      </h2>
      <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
        Select how Nova should run AI models.
      </p>

      <div className="w-full max-w-sm space-y-3">
        {available.map(engine => {
          const isSelected = selected === engine.id
          const isRecommended = engine.id === recommended
          const Icon = engine.icon

          return (
            <button
              key={engine.id}
              onClick={() => onSelect(engine.id)}
              className={clsx(
                'w-full text-left rounded-lg border p-4 transition-colors',
                isSelected
                  ? 'border-accent bg-accent/5'
                  : 'border-border-subtle hover:border-border',
              )}
            >
              <div className="flex items-start gap-3">
                <Icon className={clsx('w-5 h-5 mt-0.5 shrink-0', isSelected ? 'text-accent' : 'text-content-tertiary')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-compact font-medium text-content-primary">
                      {engine.label}
                    </span>
                    {isRecommended && (
                      <Badge color="accent" size="sm">Recommended</Badge>
                    )}
                  </div>
                  <p className="text-caption text-content-secondary mt-1">
                    {engine.description}
                  </p>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </div>
  )
}
