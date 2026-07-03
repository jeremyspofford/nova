import { useState } from 'react'
import { ChevronRight, ChevronDown, Activity, Brain, Terminal, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import type { ActivityStep, Message, MemorySummary } from '../../stores/chat-store'

interface Props {
  messages: Message[]
  isStreaming: boolean
  collapsed: boolean
  onToggle: () => void
}

function MemoryRow({ memory }: { memory: MemorySummary }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-border-subtle/20 first:border-0">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-start gap-1.5 py-1.5 w-full text-left hover:bg-surface-card-hover/50
                   rounded-xs transition-colors duration-fast group"
      >
        {expanded
          ? <ChevronDown size={12} className="text-content-tertiary mt-0.5 shrink-0" />
          : <ChevronRight size={12} className="text-content-tertiary mt-0.5 shrink-0" />
        }
        <span className="text-compact text-content-primary leading-snug flex-1 min-w-0 line-clamp-2">
          {memory.title || 'Untitled memory'}
        </span>
      </button>
      {expanded && (
        <div className="pl-5 pb-1.5 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-micro font-semibold uppercase text-content-tertiary">File</span>
            <span className="text-mono-sm font-mono text-content-tertiary select-all break-all">
              {memory.id}
            </span>
          </div>
          {memory.score != null && (
            <div className="flex items-center gap-2">
              <span className="text-micro font-semibold uppercase text-content-tertiary">Score</span>
              <span className="text-micro text-content-secondary">{memory.score.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ContextPanel({ messages, isStreaming, collapsed, onToggle }: Props) {
  // Extract live state from the most recent assistant message
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const steps = lastAssistant?.activitySteps ?? []

  // Memory files recalled this turn ({id, title, score}), with a bare-id
  // fallback when the backend sent ids but no summaries.
  const memorySummaries: MemorySummary[] = steps
    .filter(s => s.step === 'memory')
    .flatMap(s => s.memory_summaries ?? [])
  const memoryIds = steps
    .filter(s => s.step === 'memory' && s.memory_ids?.length)
    .flatMap(s => s.memory_ids ?? [])
  const memoryItems: MemorySummary[] =
    memorySummaries.length > 0
      ? memorySummaries
      : memoryIds.map(id => ({ id, title: id }))

  // Tool call steps — anything that isn't a built-in pipeline step
  const builtinSteps = new Set(['classifying', 'memory', 'model', 'generating'])
  const toolSteps = steps.filter(s => !builtinSteps.has(s.step))

  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="w-6 h-full flex items-center justify-center
                   border-l border-border-subtle hover:bg-surface-card-hover
                   text-content-tertiary hover:text-content-secondary transition-colors duration-fast"
        aria-label="Expand context panel"
      >
        <ChevronRight className="w-3.5 h-3.5 rotate-180" />
      </button>
    )
  }

  return (
    <aside
      className="w-[340px] shrink-0 h-full flex
                 bg-surface-card/85 backdrop-blur-xl border-l border-border-subtle glass-nav dark:border-white/[0.06]"
      aria-label="Context panel"
    >
      {/* Collapse strip */}
      <button
        onClick={onToggle}
        className="w-6 shrink-0 flex items-center justify-center
                   border-r border-border-subtle/30 hover:bg-surface-card-hover
                   text-content-tertiary hover:text-content-secondary transition-colors duration-fast cursor-pointer"
        aria-label="Collapse context panel"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Active Tasks */}
        <ContextSection
          icon={Activity}
          title="ACTIVE TASKS"
          count={steps.filter(s => s.state === 'running').length}
        >
          {steps.map((step, i) => (
            <div key={i} className="py-2.5 border-t border-border-subtle/30 first:border-0">
              <div className="flex items-center justify-between">
                <span className="text-compact font-medium text-content-primary truncate">
                  {stepLabel(step)}
                </span>
                <span
                  className={clsx(
                    'text-micro font-mono font-semibold uppercase px-1.5 py-0.5 rounded-xs',
                    step.state === 'running'
                      ? 'bg-accent text-white'
                      : 'bg-neutral-700 text-content-tertiary',
                  )}
                >
                  {step.state === 'running' ? 'RUNNING' : 'DONE'}
                </span>
              </div>
              {step.detail && (
                <div className="text-micro text-content-tertiary mt-1">{step.detail}</div>
              )}
              {step.elapsed_ms != null && (
                <div className="text-mono-sm font-mono text-content-tertiary mt-0.5">
                  {(step.elapsed_ms / 1000).toFixed(1)}s
                </div>
              )}
              {/* Progress bar */}
              <div className="h-[3px] bg-border-subtle rounded-full mt-1.5 overflow-hidden">
                <div
                  className={clsx(
                    'h-full rounded-full transition-all duration-slow',
                    step.state === 'running' ? 'bg-accent animate-pulse' : 'bg-neutral-600',
                  )}
                  style={{ width: step.state === 'done' ? '100%' : '60%' }}
                />
              </div>
            </div>
          ))}
          {steps.length === 0 && (
            <div className="text-caption text-content-tertiary py-2">No active tasks</div>
          )}
        </ContextSection>

        {/* Memory Hits */}
        {memoryItems.length > 0 && (
          <ContextSection icon={Brain} title="MEMORY HITS" count={memoryItems.length}>
            {memoryItems.slice(0, 8).map((memory) => (
              <MemoryRow key={memory.id} memory={memory} />
            ))}
            {memoryItems.length > 8 && (
              <div className="text-micro text-content-tertiary pt-1">
                +{memoryItems.length - 8} more
              </div>
            )}
          </ContextSection>
        )}

        {/* Tool Calls */}
        {toolSteps.length > 0 && (
          <ContextSection
            icon={Terminal}
            title="TOOL CALLS"
            count={toolSteps.length}
          >
            {toolSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5">
                {step.state === 'done' ? (
                  <span className="text-success text-compact">&#10003;</span>
                ) : (
                  <Loader2 className="w-3.5 h-3.5 text-warning animate-spin" />
                )}
                <span className="text-caption font-mono text-content-secondary">{step.step}</span>
                {step.detail && (
                  <span className="text-caption font-mono text-content-tertiary truncate flex-1">
                    {step.detail}
                  </span>
                )}
                {step.elapsed_ms != null && (
                  <span className="text-mono-sm font-mono text-content-tertiary shrink-0">
                    {(step.elapsed_ms / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            ))}
          </ContextSection>
        )}
      </div>
    </aside>
  )
}

function ContextSection({ icon: Icon, title, count, children }: {
  icon: React.ElementType
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-content-tertiary" />
        <span className="text-micro font-semibold uppercase tracking-wider text-content-tertiary">
          {title}
        </span>
        <span className="text-micro font-mono px-1.5 py-0.5 bg-neutral-700 rounded-full text-content-tertiary">
          {count}
        </span>
      </div>
      {children}
    </section>
  )
}

const KNOWN_STEPS: Record<string, string> = {
  classifying: 'Classifying request',
  memory: 'Searching memory',
  model: 'Selecting model',
  generating: 'Generating response',
}

function stepLabel(step: ActivityStep): string {
  if (KNOWN_STEPS[step.step]) return KNOWN_STEPS[step.step]
  // Tool calls: convert snake_case to title case (e.g. "create_goal" → "Create Goal")
  return step.step.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
