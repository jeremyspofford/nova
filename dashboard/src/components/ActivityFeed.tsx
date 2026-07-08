import { useState, useEffect } from 'react'
import { Check, Loader2, ChevronRight, FileText, Globe } from 'lucide-react'
import type { ActivityStep } from '../stores/chat-store'
import { MemoryDetailModal } from './MemoryDetailModal'

interface Props {
  steps: ActivityStep[]
  collapsed: boolean
  isStreaming: boolean
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  return <span>{((now - startedAt) / 1000).toFixed(1)}s</span>
}

const stepLabels: Record<string, string> = {
  classifying: 'Classified',
  memory: 'Memory retrieval',
  model: 'Selected',
  generating: 'Generating response',
}

function StepRow({ step }: { step: ActivityStep }) {
  const isDone = step.state === 'done'
  const label = stepLabels[step.step] ?? step.step
  const memHits = step.memory_summaries ?? []
  const webSources = step.sources ?? []
  const [openMem, setOpenMem] = useState<{ id: string; title: string } | null>(null)

  return (
    <>
    <div className="py-0.5">
      <div className="flex items-center gap-1.5">
        {isDone ? (
          <Check size={12} className="text-success shrink-0" />
        ) : (
          <Loader2 size={12} className="text-content-tertiary animate-spin shrink-0" />
        )}
        <span className="text-content-secondary">
          {label}{step.detail ? `: ${step.detail}` : ''}
        </span>
        {isDone && step.elapsed_ms != null && (
          <span className="text-content-tertiary ml-auto font-mono text-mono-sm tabular-nums">
            {(step.elapsed_ms / 1000).toFixed(1)}s
          </span>
        )}
        {!isDone && step.startedAt && (
          <span className="text-content-tertiary ml-auto font-mono text-mono-sm tabular-nums">
            <ElapsedTimer startedAt={step.startedAt} />
          </span>
        )}
      </div>

      {/* Sources — memory files recalled, or web pages pulled */}
      {(memHits.length > 0 || webSources.length > 0) && (
        <div className="ml-[18px] mt-0.5 flex flex-col gap-0.5">
          {memHits.map(h => (
            <button
              key={h.id}
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpenMem({ id: h.id, title: h.title }) }}
              className="flex items-center gap-1.5 text-left text-content-tertiary hover:text-accent transition-colors"
              title={`Open ${h.id}`}
            >
              <FileText size={10} className="shrink-0 text-content-tertiary/70" />
              <span className="min-w-0 truncate underline decoration-content-tertiary/30 underline-offset-2">{h.title}</span>
              {h.score != null && (
                <span className="font-mono text-mono-sm text-content-tertiary/50 tabular-nums">
                  {h.score.toFixed(1)}
                </span>
              )}
            </button>
          ))}
          {webSources.map((s, i) => (
            <a
              key={`${s.url}-${i}`}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-content-tertiary hover:text-accent transition-colors"
              title={s.url}
            >
              <Globe size={10} className="shrink-0 text-content-tertiary/70" />
              <span className="truncate underline decoration-content-tertiary/30 underline-offset-2">{s.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
    <MemoryDetailModal
      memoryId={openMem?.id ?? null}
      title={openMem?.title}
      onClose={() => setOpenMem(null)}
    />
    </>
  )
}

export function ActivityFeed({ steps, collapsed, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false)

  // Build collapsed summary
  const model = steps.find(s => s.step === 'model')?.detail
    ?? steps.find(s => s.step === 'generating')?.model
  const memStep = steps.find(s => s.step === 'memory' && s.state === 'done')
  const totalMs = steps
    .filter(s => s.state === 'done' && s.elapsed_ms != null)
    .reduce((max, s) => Math.max(max, s.elapsed_ms!), 0)

  if (collapsed && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-caption text-content-tertiary hover:text-content-secondary transition-colors duration-fast mb-1.5"
      >
        <ChevronRight size={11} className="shrink-0" />
        <span className="font-mono text-mono-sm tabular-nums">
          {[
            model,
            memStep?.detail,
            totalMs > 0 ? `${(totalMs / 1000).toFixed(1)}s` : null,
          ].filter(Boolean).join(' \u00b7 ')}
        </span>
      </button>
    )
  }

  return (
    <div
      className="text-caption mb-1.5 cursor-pointer"
      onClick={collapsed ? () => setExpanded(false) : undefined}
    >
      {steps.map(s => (
        <StepRow key={s.step} step={s} />
      ))}
    </div>
  )
}
