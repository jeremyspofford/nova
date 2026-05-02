import { useState, useCallback, useEffect, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Send, RefreshCw, X, Clock, ChevronDown, ChevronUp,
  ThumbsUp, ThumbsDown, Loader2, Trash2, ShieldAlert,
  FileSearch, AlertTriangle, MessageSquare, Zap, CheckCircle2,
  ListTodo, DollarSign, Timer, Brain, ScrollText,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import { formatAbsoluteDate, formatDuration } from '../utils/formatDate'
import { useTheme } from '../stores/theme-store'
import {
  getPipelineTasks, submitPipelineTask, cancelPipelineTask,
  reviewPipelineTask, getQueueStats, getPods, discoverModels,
  deletePipelineTask, bulkDeletePipelineTasks, bulkDeletePipelineTasksByIds,
  getTaskFindings, getTaskReviews, getTaskSessions, getTaskArtifacts,
  getPipelineStats, getPipelineLatency,
  clarifyPipelineTask,
} from '../api'
import type { TaskSummary, Artifact } from '../api'
import ArtifactCard, { MermaidDiagram } from '../components/ArtifactRenderer'
import FileViewer from '../components/FileViewer'
import type { PipelineTask, TaskStatus, GuardrailFinding, CodeReviewVerdict, AgentSession } from '../types'
import { ACTIVE_TASK_STATUSES, TASK_STATUS_CONFIG } from '../constants'
import { useChatStore } from '../stores/chat-store'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Badge, Button, Card, Checkbox, CopyableId, ConfirmDialog, EmptyState,
  Metric, Modal, PipelineStages, SearchInput, Select, Skeleton,
  Tabs, Textarea, StatusDot, DataList, Tooltip,
} from '../components/ui'
import type { SemanticColor } from '../lib/design-tokens'

/* ── Render mermaid code blocks as diagrams inside markdown ── */
const markdownComponents = {
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    if (className === 'language-mermaid') {
      return <MermaidDiagram content={String(children).replace(/\n$/, '')} />
    }
    return <code className={className}>{children}</code>
  },
}

const HELP_ENTRIES = [
  { term: 'Pipeline', definition: 'The 5-stage agent chain that processes every task — Context gathers info, Task executes, Guardrail validates safety, Code Review checks quality, Decision determines success.' },
  { term: 'Stage', definition: 'One of 5 sequential phases a task passes through. Each stage has its own AI agent.' },
  { term: 'Guardrail', definition: 'A safety-validation agent that checks task outputs for security issues, policy violations, or harmful content.' },
  { term: 'Code Review', definition: 'An agent that reviews task output for correctness, quality, and adherence to requirements.' },
  { term: 'Escalation', definition: 'When a task is flagged for human review instead of being automatically resolved.' },
  { term: 'Finding', definition: 'A specific concern raised by the guardrail agent — e.g. a security risk or policy violation.' },
  { term: 'Verdict', definition: "The code review agent's assessment — approved, rejected, or needs-fix." },
]

/** Full 7-stage pipeline order (from checkpoint.py PIPELINE_STAGE_ORDER). */
const PIPELINE_STAGES = [
  { role: 'context', label: 'Context' },
  { role: 'task', label: 'Task' },
  { role: 'critique_direction', label: 'Critique' },
  { role: 'guardrail', label: 'Guardrail' },
  { role: 'code_review', label: 'Code Review' },
  { role: 'critique_acceptance', label: 'Acceptance' },
  { role: 'decision', label: 'Decision' },
]

// ── Task context builder for chat ─────────────────────────────────────────────

function inferReviewPrompt(task: PipelineTask): string {
  const escalation = (task.metadata?.escalation_message as string | undefined) ?? ''

  if (escalation.match(/^Agent '.+' failed:/)) {
    return (
      'This task was escalated because an agent failed during execution. ' +
      'What went wrong, and is it safe to retry? Should I adjust the task input, ' +
      'change the agent configuration, or reject this task entirely?'
    )
  }

  if (escalation.toLowerCase().includes('guardrail') || escalation.toLowerCase().includes('finding')) {
    return (
      'The guardrail agent flagged this task with security or safety findings. ' +
      'Analyze the findings — are they genuine risks or false positives? ' +
      'What would you recommend: approve with modifications, or reject?'
    )
  }

  if (escalation.toLowerCase().includes('escalat') || escalation.toLowerCase().includes('review')) {
    return (
      'The pipeline escalated this task for human review after the decision agent evaluated it. ' +
      'Summarize what was attempted, explain the concerns that triggered escalation, ' +
      'and recommend whether I should approve or reject — and why.'
    )
  }

  if (task.status === 'complete') {
    return 'This task completed successfully. Review the output and let me know if it achieved the intended goal.'
  }
  if (task.status === 'failed') {
    return 'This task failed. Analyze the error and suggest how to fix or retry it.'
  }

  return (
    'Explain the current state of this task — what has been completed, ' +
    'what issues were found, and what you would recommend as next steps.'
  )
}

function buildTaskContext(task: PipelineTask): string {
  const parts = [
    `I want to discuss pipeline task ${task.id.slice(0, 8)} (full ID: ${task.id}).`,
    '',
    `**Status:** ${task.status}`,
    `**Input:** ${task.user_input}`,
  ]
  if (task.output) parts.push(`**Output:** ${task.output.slice(0, 500)}${task.output.length > 500 ? '...' : ''}`)
  if (task.error) parts.push(`**Error:** ${task.error}`)
  const escalation = task.metadata?.escalation_message as string | undefined
  if (escalation) parts.push(`**Escalation reason:** ${escalation}`)
  if (task.current_stage) parts.push(`**Last stage:** ${task.current_stage}`)
  parts.push('', inferReviewPrompt(task))
  return parts.join('\n')
}

// ── Stage helpers ───────────────────────────────────────────────────────────────

const STAGES = ['context', 'task', 'guardrail', 'code_review', 'decision'] as const
type Stage = typeof STAGES[number]

type StageStatus = 'done' | 'active' | 'pending' | 'failed'

function resolveStageStatuses(task: PipelineTask): StageStatus[] {
  if (task.status === 'complete') return STAGES.map(() => 'done' as StageStatus)
  if (task.status === 'failed' || task.status === 'cancelled') {
    const stageName = task.current_stage as Stage | null
    const idx = stageName ? STAGES.indexOf(stageName) : -1
    return STAGES.map((_, i) => {
      if (i < idx) return 'done' as StageStatus
      if (i === idx) return 'failed' as StageStatus
      return 'pending' as StageStatus
    })
  }

  const stageName = task.current_stage as Stage | null
  if (!stageName) return STAGES.map(() => 'pending' as StageStatus)

  const idx = STAGES.indexOf(stageName)
  if (idx === -1) return STAGES.map(() => 'pending' as StageStatus)
  return STAGES.map((_, i) => {
    if (i < idx) return 'done' as StageStatus
    if (i === idx) return 'active' as StageStatus
    return 'pending' as StageStatus
  })
}

// ── Status helpers ──────────────────────────────────────────────────────────────

function statusToBadgeColor(status: TaskStatus): SemanticColor {
  if (status === 'complete') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'cancelled') return 'neutral'
  if (status === 'pending_human_review') return 'info'
  if (status === 'clarification_needed') return 'warning'
  if (ACTIVE_TASK_STATUSES.has(status)) return 'warning'
  return 'neutral'
}

function statusToStatusDot(status: TaskStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'complete') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'cancelled') return 'neutral'
  if (status === 'pending_human_review') return 'warning'
  if (status === 'clarification_needed') return 'warning'
  if (ACTIVE_TASK_STATUSES.has(status)) return 'warning'
  return 'neutral'
}

function statusLabel(status: TaskStatus): string {
  return TASK_STATUS_CONFIG[status]?.label ?? status
}

// ── Filter type ─────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'running' | 'queued' | 'review' | 'complete' | 'failed'

const STATUS_FILTERS: { id: StatusFilter; label: string; color: SemanticColor }[] = [
  { id: 'all', label: 'All', color: 'neutral' },
  { id: 'running', label: 'Running', color: 'warning' },
  { id: 'queued', label: 'Queued', color: 'neutral' },
  { id: 'review', label: 'Review', color: 'info' },
  { id: 'complete', label: 'Complete', color: 'success' },
  { id: 'failed', label: 'Failed', color: 'danger' },
]

function matchesFilter(task: PipelineTask, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return ACTIVE_TASK_STATUSES.has(task.status) && task.status !== 'queued'
  if (filter === 'queued') return task.status === 'queued'
  if (filter === 'review') return task.status === 'pending_human_review' || task.status === 'clarification_needed'
  if (filter === 'complete') return task.status === 'complete'
  if (filter === 'failed') return task.status === 'failed' || task.status === 'cancelled'
  return true
}

type SourceFilter = 'mine' | 'cortex' | 'all'

const SOURCE_FILTERS = [
  { value: 'mine', label: 'My Tasks' },
  { value: 'cortex', label: 'Cortex' },
  { value: 'all', label: 'All Origins' },
]

function matchesSourceFilter(task: PipelineTask, filter: SourceFilter): boolean {
  if (filter === 'all') return true
  const source = task.metadata?.source as string | undefined
  if (filter === 'cortex') return source === 'cortex'
  return source !== 'cortex'
}

// ── Severity badge ────────────────────────────────────────────────────────────

const SEVERITY_TO_COLOR: Record<string, SemanticColor> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

// ── Findings section ──────────────────────────────────────────────────────────

function FindingsSection({ findings }: { findings: GuardrailFinding[] }) {
  if (findings.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-caption font-medium text-warning">
        <ShieldAlert size={13} /> Guardrail Findings ({findings.length})
      </div>
      {findings.map(f => (
        <div key={f.id} className="rounded-sm border border-border-subtle bg-surface-elevated p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge color={SEVERITY_TO_COLOR[f.severity] ?? 'neutral'} size="sm">
              {f.severity}
            </Badge>
            <span className="text-compact font-medium text-content-primary capitalize">
              {f.finding_type.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="text-caption text-content-secondary">{f.description}</p>
          {f.evidence && (
            <pre className="mt-1 rounded-xs bg-surface-card p-2 text-mono-sm text-content-secondary whitespace-pre-wrap break-words">
              {f.evidence}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Code review section ───────────────────────────────────────────────────────

function CodeReviewSection({ reviews }: { reviews: CodeReviewVerdict[] }) {
  if (reviews.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-caption font-medium text-info">
        <FileSearch size={13} /> Code Review ({reviews.length} {reviews.length === 1 ? 'iteration' : 'iterations'})
      </div>
      {reviews.map(r => (
        <div key={r.id} className="rounded-sm border border-border-subtle bg-surface-elevated p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Badge
              color={r.verdict === 'pass' ? 'success' : r.verdict === 'needs_refactor' ? 'warning' : 'danger'}
              size="sm"
            >
              {r.verdict.replace(/_/g, ' ')}
            </Badge>
            <span className="text-caption text-content-tertiary">Iteration {r.iteration}</span>
          </div>
          {r.summary && <p className="text-caption text-content-secondary">{r.summary}</p>}
          {Array.isArray(r.issues) && r.issues.length > 0 && (
            <ul className="space-y-1 pl-2 border-l-2 border-border-subtle">
              {r.issues.map((iss, j) => (
                <li key={j} className="text-caption text-content-secondary">
                  <Badge color={SEVERITY_TO_COLOR[iss.severity] ?? 'neutral'} size="sm">
                    {iss.severity}
                  </Badge>{' '}
                  {iss.description}
                  {iss.file && (
                    <span className="text-content-tertiary"> ({iss.file}{iss.line ? `:${iss.line}` : ''})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Review panel (for pending_human_review tasks) ──────────────────────────────

function ReviewPanel({ task, onDone }: { task: PipelineTask; onDone: () => void }) {
  const [comment, setComment] = useState('')
  const qc = useQueryClient()

  const review = useMutation({
    mutationFn: ({ decision }: { decision: 'approve' | 'reject' }) =>
      reviewPipelineTask(task.id, decision, comment || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      onDone()
    },
  })

  const escalationMsg = task.metadata?.escalation_message as string | undefined

  return (
    <div className="space-y-4">
      {/* Escalation reason */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5 text-caption font-semibold text-warning">
          <AlertTriangle size={13} /> Why This Needs Review
        </div>
        <p className="text-compact text-content-secondary">
          {escalationMsg || 'This task was escalated for human review.'}
        </p>
      </div>

      <p className="text-caption text-content-tertiary">
        Check the Findings and Code Review tabs for details, then approve or reject below.
      </p>

      {/* Decision area */}
      <div className="border-t border-border-subtle pt-3 space-y-2">
        <p className="text-caption font-medium text-content-tertiary">Your Decision</p>
        <Textarea
          rows={2}
          placeholder="Optional comment..."
          value={comment}
          onChange={e => setComment(e.target.value)}
          autoResize={false}
        />
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<ThumbsUp size={12} />}
            onClick={() => review.mutate({ decision: 'approve' })}
            loading={review.isPending}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={<ThumbsDown size={12} />}
            onClick={() => review.mutate({ decision: 'reject' })}
            loading={review.isPending}
          >
            Reject
          </Button>
          {review.isError && <span className="self-center text-caption text-danger">Failed -- try again</span>}
        </div>
      </div>
    </div>
  )
}

// ── Clarification panel (for clarification_needed tasks) ───────────────────────

function ClarificationPanel({ task, onDone }: { task: PipelineTask; onDone: () => void }) {
  const qc = useQueryClient()
  const questions: string[] = Array.isArray(task.metadata?.clarification_questions)
    ? (task.metadata.clarification_questions as string[])
    : []
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''))

  const clarify = useMutation({
    mutationFn: () => clarifyPipelineTask(task.id, answers),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      onDone()
    },
  })

  const canSubmit = answers.every(a => a.trim().length > 0)

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-1.5 mb-1.5 text-caption font-semibold text-warning">
          <MessageSquare size={13} /> Clarification Needed
        </div>
        <p className="text-compact text-content-secondary">
          The pipeline needs more information before it can proceed. Answer the questions below.
        </p>
      </div>

      {questions.length === 0 ? (
        <p className="text-compact text-content-tertiary">No specific questions provided.</p>
      ) : (
        <div className="space-y-3">
          {questions.map((q, i) => (
            <div key={i}>
              <p className="mb-1 text-caption font-medium text-content-primary">
                {i + 1}. {q}
              </p>
              <Textarea
                rows={2}
                placeholder="Your answer..."
                value={answers[i]}
                onChange={e => {
                  const next = [...answers]
                  next[i] = e.target.value
                  setAnswers(next)
                }}
                autoResize={false}
              />
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border-subtle pt-3 flex gap-2 items-center">
        <Button
          variant="primary"
          size="sm"
          icon={<Send size={12} />}
          onClick={() => clarify.mutate()}
          disabled={!canSubmit}
          loading={clarify.isPending}
        >
          Submit Answers
        </Button>
        {clarify.isError && (
          <span className="text-caption text-danger">Failed — try again</span>
        )}
      </div>
    </div>
  )
}

// ── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ summary, onFileClick }: { summary: TaskSummary; onFileClick: (p: string) => void }) {
  const allFiles = [...(summary.files_created || []), ...(summary.files_modified || [])]
  // Don't render empty summary card
  if (!summary.headline && allFiles.length === 0) return null
  return (
    <div className="mb-3 rounded-md border border-accent/20 bg-gradient-to-br from-surface to-surface-elevated p-3">
      <p className="text-caption font-medium uppercase tracking-wide text-accent">Summary</p>
      <p className="mt-1 text-compact text-content-primary">{summary.headline}</p>
      {allFiles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {allFiles.map(f => (
            <button key={f} onClick={() => onFileClick(f)}
                    className="rounded-full bg-surface-elevated px-2 py-0.5 text-caption text-accent hover:underline">
              {f.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-3 text-caption text-content-tertiary">
        {summary.findings_count > 0 && <span>{summary.findings_count} findings</span>}
        {summary.review_verdict && <span>Review: {summary.review_verdict}</span>}
        {summary.cost_usd != null && <span>${Number(summary.cost_usd).toFixed(2)}</span>}
        {summary.duration_s != null && <span>{summary.duration_s}s</span>}
      </div>
    </div>
  )
}

// ── Task artifacts tab ───────────────────────────────────────────────────────

function TaskArtifactsTab({ taskId, onFileClick }: { taskId: string; onFileClick: (p: string) => void }) {
  const { data: artifacts = [], isLoading } = useQuery({
    queryKey: ['task-artifacts', taskId],
    queryFn: () => getTaskArtifacts(taskId),
    staleTime: 10_000,
  })
  if (isLoading) return <Skeleton lines={3} />
  if (artifacts.length === 0) return <p className="text-compact text-content-tertiary">No artifacts for this task.</p>
  return (
    <div className="space-y-2">
      {artifacts.map(a => <ArtifactCard key={a.id} artifact={a} onFileClick={onFileClick} />)}
    </div>
  )
}

// ── Stage card (collapsible card for a single pipeline stage) ────────────────

function StageCard({ stage, session, checkpoint, isFailed }: {
  stage: { role: string; label: string }
  session?: AgentSession
  checkpoint: Record<string, unknown> | null
  isFailed: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  const duration = session?.duration_ms
    ? `${(session.duration_ms / 1000).toFixed(1)}s`
    : null
  const model = session?.model_used?.split('/').pop() ?? null
  const cost = session?.cost_usd != null ? `$${Number(session.cost_usd).toFixed(3)}` : null

  return (
    <div className={clsx(
      'rounded-md border p-2.5',
      isFailed ? 'border-danger/30 bg-danger-dim/10' : 'border-border bg-surface-elevated',
    )}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-content-tertiary hover:text-content-primary text-xs"
        >
          {expanded ? '\u25BE' : '\u25B8'}
        </button>
        <span className={clsx(
          'text-compact font-medium',
          isFailed ? 'text-danger' : 'text-content-primary',
        )}>
          {stage.label}
        </span>
        <span className="flex-1" />
        {duration && <span className="text-caption text-content-tertiary">{duration}</span>}
        {model && <span className="text-caption text-content-tertiary">{model}</span>}
        {cost && <span className="text-caption text-content-tertiary">{cost}</span>}
      </div>

      {isFailed && session?.error && (
        <div className="mt-2">
          <pre className="whitespace-pre-wrap break-words rounded-sm bg-danger-dim p-2 text-mono-sm text-danger">
            {session.error}
          </pre>
          {session.traceback && (
            <details className="mt-1">
              <summary className="text-caption text-content-tertiary cursor-pointer hover:text-content-secondary">
                Traceback
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-mono-sm text-content-tertiary max-h-48 overflow-y-auto">
                {session.traceback}
              </pre>
            </details>
          )}
        </div>
      )}

      {expanded && checkpoint && (
        <div className="mt-2 rounded-sm bg-surface-card p-2 markdown-body text-compact text-content-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {typeof checkpoint.content === 'string'
              ? checkpoint.content
              : JSON.stringify(checkpoint, null, 2)}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

// ── Failed task stages view (stage-by-stage timeline) ────────────────────────

function FailedTaskStagesView({ taskId, checkpoint, error: taskError }: {
  taskId: string
  checkpoint: Record<string, Record<string, unknown>> | null
  error: string | null
}) {
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['task-sessions', taskId],
    queryFn: () => getTaskSessions(taskId),
    staleTime: Infinity,
  })

  if (isLoading) return <Skeleton lines={5} />

  const sessionByRole = new Map(sessions.map(s => [s.role, s]))
  const completedRoles = new Set(checkpoint ? Object.keys(checkpoint) : [])
  const failedSession = sessions.find(s => s.status === 'failed')

  return (
    <div className="space-y-0">
      {PIPELINE_STAGES.map((stage, i) => {
        const session = sessionByRole.get(stage.role)
        const isCompleted = completedRoles.has(stage.role)
        const isFailed = session?.status === 'failed' || (failedSession?.role === stage.role)
        const isNotReached = !isCompleted && !isFailed && !session

        const dotColor = isCompleted ? 'bg-success'
          : isFailed ? 'bg-danger'
          : 'bg-content-tertiary'

        return (
          <div key={stage.role} className="relative pb-3 pl-6">
            {i < PIPELINE_STAGES.length - 1 && (
              <div className="absolute left-[9px] top-5 h-full w-0.5 bg-border" />
            )}
            <div className={`absolute left-1 top-1.5 h-3 w-3 rounded-full border-2 border-surface ${dotColor}`} />

            {isNotReached ? (
              <div className="py-1 text-caption text-content-tertiary">
                {stage.label} — <span className="italic">not reached</span>
              </div>
            ) : (
              <StageCard
                stage={stage}
                session={session}
                checkpoint={isCompleted ? checkpoint![stage.role] : null}
                isFailed={isFailed}
              />
            )}
          </div>
        )
      })}

      {taskError && !failedSession && (
        <div className="mt-3 rounded-sm bg-danger-dim p-3">
          <p className="text-caption font-medium text-danger mb-1">Pipeline Error</p>
          <pre className="whitespace-pre-wrap break-words text-mono-sm text-danger">
            {taskError}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Task details tab ─────────────────────────────────────────────────────────

function TaskDetailsTab({ taskId, taskStatus, checkpoint, fallbackOutput, fallbackError }: {
  taskId: string
  taskStatus: string
  checkpoint: Record<string, Record<string, unknown>> | null
  fallbackOutput: string | null
  fallbackError: string | null
}) {
  const { data: artifacts = [] } = useQuery({
    queryKey: ['task-artifacts', taskId],
    queryFn: () => getTaskArtifacts(taskId),
    staleTime: 10_000,
  })
  const summary = artifacts.find(a => a.artifact_type === 'task_summary')

  if (summary) {
    return (
      <div className="prose prose-invert max-w-none rounded-sm bg-surface-elevated p-3 text-compact markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{summary.content}</ReactMarkdown>
      </div>
    )
  }

  // Failed task with no summary — show stage-by-stage recovery view
  if (taskStatus === 'failed' && !fallbackOutput) {
    return <FailedTaskStagesView taskId={taskId} checkpoint={checkpoint} error={fallbackError} />
  }

  return (
    <div className="space-y-3">
      {fallbackOutput ? (
        <div className="rounded-sm bg-surface-elevated p-3 text-compact text-content-secondary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{fallbackOutput}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-compact text-content-tertiary">No output yet.</p>
      )}
      {fallbackError && (
        <div>
          <p className="mb-1 text-caption font-medium text-danger">Error</p>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-danger-dim p-3 text-mono-sm text-danger">
            {fallbackError}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Task detail sheet ─────────────────────────────────────────────────────────

export function TaskDetailSheet({
  task,
  open,
  onClose,
}: {
  task: PipelineTask | null
  open: boolean
  onClose: () => void
}) {
  const [detailTab, setDetailTab] = useState(
    task?.status === 'pending_human_review' ? 'review'
      : task?.status === 'clarification_needed' ? 'clarify'
      : 'details'
  )
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { setPrefillInput } = useChatStore()
  const { timezone } = useTheme()

  const cancelMutation = useMutation({
    mutationFn: () => cancelPipelineTask(task!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline-tasks'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePipelineTask(task!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      onClose()
    },
  })

  if (!task) return null

  const isActive = ACTIVE_TASK_STATUSES.has(task.status)
  const isTerminal = ['complete', 'failed', 'cancelled'].includes(task.status)
  const needsReview = task.status === 'pending_human_review'
  const needsClarification = task.status === 'clarification_needed'

  const handleDiscuss = () => {
    setPrefillInput(buildTaskContext(task))
    navigate('/chat')
  }

  const detailTabs = [
    { id: 'details', label: 'Details' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'findings', label: 'Findings' },
    { id: 'pipeline', label: 'Pipeline' },
    ...(needsReview ? [{ id: 'review', label: 'Review' }] : []),
    ...(needsClarification ? [{ id: 'clarify', label: 'Clarify' }] : []),
  ]

  return (
    <Modal open={open} onClose={onClose} size="xl" title={task.user_input.slice(0, 60) + (task.user_input.length > 60 ? '...' : '')}
      footer={
        <div className="flex gap-2 w-full">
          <Button variant="secondary" size="sm" icon={<MessageSquare size={14} />} onClick={handleDiscuss}>Discuss</Button>
          {isActive && !needsReview && (
            <Button variant="danger" size="sm" icon={<X size={14} />} onClick={() => cancelMutation.mutate()} loading={cancelMutation.isPending}>Cancel</Button>
          )}
          {isTerminal && (
            <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => deleteMutation.mutate()} loading={deleteMutation.isPending}>Delete</Button>
          )}
        </div>
      }
    >
      <div className="space-y-5 text-left">
        {/* Status + ID header */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge color={statusToBadgeColor(task.status)} dot>
            {statusLabel(task.status)}
          </Badge>
          <CopyableId id={task.id} />
          {task.pod_name && (
            <Badge color="accent" size="sm">{task.pod_name}</Badge>
          )}
          {(task.metadata?.source as string) === 'cortex' && (
            <Badge color="accent" size="sm">
              <Brain size={10} className="inline mr-0.5" />
              cortex
            </Badge>
          )}
          <Link
            to={`/audit-log?task_id=${task.id}`}
            className="inline-flex items-center gap-1 text-caption text-content-tertiary hover:text-accent transition-colors ml-auto"
            title="View capability audit events for this task"
          >
            <ScrollText size={12} /> Audit trail
          </Link>
        </div>

        {/* Task input */}
        <div>
          <p className="text-caption text-content-tertiary mb-1">Input</p>
          <p className="text-compact text-content-primary whitespace-pre-wrap">{task.user_input}</p>
        </div>

        {/* Timestamps / metadata */}
        <DataList
          items={[
            ...(task.queued_at ? [{
              label: 'Queued',
              value: task.started_at
                ? `${formatDuration(task.queued_at, task.started_at)} in queue`
                : formatAbsoluteDate(task.queued_at, timezone),
            }] : []),
            ...(task.started_at ? [{ label: 'Started', value: formatAbsoluteDate(task.started_at, timezone) }] : []),
            ...(task.completed_at && task.started_at ? [{
              label: 'Duration',
              value: formatDuration(task.started_at, task.completed_at),
            }] : []),
            ...(task.completed_at ? [{ label: 'Completed', value: formatAbsoluteDate(task.completed_at, timezone) }] : []),
            { label: 'Retries', value: `${task.retry_count}/${task.max_retries}` },
            ...(task.current_stage ? [{ label: 'Current Stage', value: task.current_stage }] : []),
          ]}
        />

        {/* Pipeline stages */}
        <div>
          <p className="text-caption font-medium text-content-tertiary mb-2">Pipeline Progress</p>
          <PipelineStages stages={resolveStageStatuses(task)} />
        </div>

        {/* Summary card */}
        {task.summary && (
          <SummaryCard summary={task.summary as unknown as TaskSummary} onFileClick={setViewingFile} />
        )}

        {/* Tabs */}
        <Tabs tabs={detailTabs} activeTab={detailTab} onChange={setDetailTab} />

        {/* Tab content */}
        <div className="min-h-[120px]">
          {detailTab === 'details' && (
            <TaskDetailsTab
              taskId={task.id}
              taskStatus={task.status}
              checkpoint={task.checkpoint}
              fallbackOutput={task.output}
              fallbackError={task.error}
            />
          )}
          {detailTab === 'artifacts' && (
            <TaskArtifactsTab taskId={task.id} onFileClick={setViewingFile} />
          )}
          {detailTab === 'findings' && <TaskFindingsTab taskId={task.id} />}
          {detailTab === 'pipeline' && <TaskReviewsTab taskId={task.id} />}
          {detailTab === 'review' && needsReview && (
            <ReviewPanel task={task} onDone={onClose} />
          )}
          {detailTab === 'clarify' && needsClarification && (
            <ClarificationPanel task={task} onDone={onClose} />
          )}
        </div>

      </div>

      {viewingFile && <FileViewer path={viewingFile} onClose={() => setViewingFile(null)} />}
    </Modal>
  )
}

function TaskFindingsTab({ taskId }: { taskId: string }) {
  const { data: findings = [], isLoading } = useQuery({
    queryKey: ['task-findings', taskId],
    queryFn: () => getTaskFindings(taskId),
    staleTime: 10_000,
  })

  if (isLoading) return <Skeleton lines={3} />
  if (findings.length === 0) return <p className="text-compact text-content-tertiary">No findings for this task.</p>
  return <FindingsSection findings={findings} />
}

function TaskReviewsTab({ taskId }: { taskId: string }) {
  const { data: reviews = [], isLoading, isError } = useQuery({
    queryKey: ['task-reviews', taskId],
    queryFn: () => getTaskReviews(taskId),
    staleTime: 10_000,
    retry: false,
  })

  if (isLoading) return <Skeleton lines={3} />
  if (isError) return <p className="text-compact text-content-tertiary">Could not load code reviews.</p>
  if (reviews.length === 0) return <p className="text-compact text-content-tertiary">No code reviews for this task.</p>
  return <CodeReviewSection reviews={reviews} />
}

// ── Submit form ────────────────────────────────────────────────────────────────

function SubmitForm() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [podName, setPodName] = useState('')
  const [modelId, setModelId] = useState('')
  const qc = useQueryClient()

  const { data: pods } = useQuery({ queryKey: ['pods'], queryFn: getPods, staleTime: 30_000 })
  const { data: providers } = useQuery({ queryKey: ['model-catalog'], queryFn: () => discoverModels(), staleTime: 60_000 })
  const models = (providers ?? []).filter(p => p.available).flatMap(p => p.models.filter(m => m.registered).map(m => ({ id: m.id })))

  const submit = useMutation({
    mutationFn: () => submitPipelineTask(
      input.trim(),
      podName || undefined,
      modelId || undefined,
    ),
    onSuccess: () => {
      setInput('')
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      qc.invalidateQueries({ queryKey: ['pipeline-stats'] })
    },
  })

  const podItems = [
    { value: '', label: 'Default pod' },
    ...(pods ?? []).map(p => ({ value: p.name, label: p.name })),
  ]

  const modelItems = [
    { value: '', label: 'Default model' },
    ...models.map(m => ({ value: m.id, label: m.id })),
  ]

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-surface-card-hover transition-colors"
      >
        <span className="flex items-center gap-2 text-compact font-medium text-content-secondary">
          <Send size={14} className="text-content-tertiary" />
          Submit a manual task
        </span>
        {open ? <ChevronUp size={14} className="text-content-tertiary" /> : <ChevronDown size={14} className="text-content-tertiary" />}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2 border-t border-border-subtle pt-3">
          <Textarea
            rows={3}
            placeholder="Describe what you want the agent pipeline to do..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && input.trim()) submit.mutate()
            }}
          />
          <div className="flex flex-wrap gap-2">
            <div className="w-40">
              <Select
                value={podName}
                onChange={e => setPodName(e.target.value)}
                items={podItems}
              />
            </div>
            <div className="w-40">
              <Select
                value={modelId}
                onChange={e => setModelId(e.target.value)}
                items={modelItems}
              />
            </div>
            <Button
              className="ml-auto"
              icon={<Send size={14} />}
              onClick={() => submit.mutate()}
              disabled={!input.trim()}
              loading={submit.isPending}
            >
              Submit<span className="hidden sm:inline"> (Cmd+Enter)</span>
            </Button>
          </div>
          {submit.isError && (
            <p className="text-caption text-danger">Failed to submit: {String(submit.error)}</p>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Task row ────────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  onSelect,
  selected,
  onToggleSelect,
}: {
  task: PipelineTask
  onSelect: (task: PipelineTask) => void
  selected: boolean
  onToggleSelect: (taskId: string, shiftKey: boolean) => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { setPrefillInput } = useChatStore()

  const needsReview = task.status === 'pending_human_review'
  const needsClarification = task.status === 'clarification_needed'
  const isActive = ACTIVE_TASK_STATUSES.has(task.status)
  const isTerminal = ['complete', 'failed', 'cancelled'].includes(task.status)

  const cancelMutation = useMutation({
    mutationFn: () => cancelPipelineTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline-tasks'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePipelineTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline-tasks'] }),
  })

  const handleDiscuss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setPrefillInput(buildTaskContext(task))
    navigate('/chat')
  }, [task, setPrefillInput, navigate])

  const relativeTime = task.queued_at
    ? formatDistanceToNow(new Date(task.queued_at), { addSuffix: true })
    : '--'

  const modelOverride = task.metadata?.model_override as string | undefined
  const costUsd = task.metadata?.cost_usd as number | undefined

  return (
    <div
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault()
          onToggleSelect(task.id, true)
        } else {
          onSelect(task)
        }
      }}
      className={clsx(
        'flex items-center gap-3 px-4 py-3 border-b border-border-subtle cursor-pointer transition-colors',
        'hover:bg-surface-card-hover',
        selected && 'bg-accent/10',
        (needsReview || needsClarification) && !selected && 'bg-info-dim/30',
        // Running tasks: teal left accent + subtle glow
        isActive && !needsReview && !needsClarification && !selected && 'border-l-2 border-l-accent shadow-[inset_4px_0_8px_-4px_rgba(25,168,158,0.25)]',
        // Terminal tasks visually recede
        isTerminal && !selected && 'opacity-60 hover:opacity-80',
      )}
    >
      {/* Selection checkbox */}
      <div onClick={e => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelect(task.id, false)}
          className="mr-0"
        />
      </div>

      {/* Status dot */}
      <StatusDot
        status={statusToStatusDot(task.status)}
        pulse={ACTIVE_TASK_STATUSES.has(task.status)}
        size="md"
      />

      {/* Task info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-compact text-content-primary truncate max-w-xs">
            {task.user_input.slice(0, 80)}{task.user_input.length > 80 ? '...' : ''}
          </span>
          <CopyableId id={task.id} />
        </div>
        <div className="flex items-center gap-3 mt-1">
          {(task.metadata?.source as string) === 'cortex' && (
            <Badge color="accent" size="sm">
              <Brain size={10} className="inline mr-0.5" />
              cortex
            </Badge>
          )}
          {modelOverride && (
            <span className="text-mono-sm text-content-tertiary">{modelOverride}</span>
          )}
          {costUsd != null && (
            <span className="text-mono-sm text-content-tertiary">${costUsd.toFixed(4)}</span>
          )}
          <span className="text-caption text-content-tertiary">{relativeTime}</span>
        </div>
      </div>

      {/* Pipeline stages (compact) */}
      <div className="hidden md:block">
        <PipelineStages stages={resolveStageStatuses(task)} compact />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        {isActive && !needsReview && (
          <Button
            variant="ghost"
            size="sm"
            icon={<X size={12} />}
            onClick={() => cancelMutation.mutate()}
            loading={cancelMutation.isPending}
            title="Cancel task"
          />
        )}
        {isTerminal && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={() => deleteMutation.mutate()}
            loading={deleteMutation.isPending}
            title="Delete task"
          />
        )}
        <Button
          variant="secondary"
          size="sm"
          icon={<MessageSquare size={12} />}
          onClick={handleDiscuss}
          title="Discuss this task with Nova"
        >
          <span className="hidden sm:inline">Discuss</span>
        </Button>
      </div>
    </div>
  )
}

// ── Stats row ───────────────────────────────────────────────────────────────────

function StatsRow() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['pipeline-stats'],
    queryFn: getPipelineStats,
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  const { data: latency, isLoading: latencyLoading } = useQuery({
    queryKey: ['pipeline-latency'],
    queryFn: getPipelineLatency,
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  const isLoading = statsLoading || latencyLoading
  const activeCount = stats?.active_count ?? 0

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_1fr] gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className={clsx('p-4', i === 0 && 'sm:row-span-1')}>
            <Skeleton lines={2} />
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {/* Hero metric — active tasks */}
      <Card className={clsx(
        'col-span-2 sm:col-span-1 p-5 relative overflow-hidden',
        activeCount > 0 && 'border-accent/30 shadow-[0_0_20px_rgba(25,168,158,0.15)]',
      )}>
        <div className="flex items-center gap-3">
          <div className={clsx(
            'flex items-center justify-center w-10 h-10 rounded-lg',
            activeCount > 0
              ? 'bg-accent/15 text-accent'
              : 'bg-surface-elevated text-content-tertiary',
          )}>
            <Zap size={20} />
          </div>
          <div>
            <p className="text-caption text-content-tertiary">Active Now</p>
            <p className={clsx(
              'text-2xl font-bold tracking-tight font-mono',
              activeCount > 0 ? 'text-accent' : 'text-content-primary',
            )}>
              {activeCount}
            </p>
          </div>
        </div>
        {activeCount > 0 && (
          <div className="absolute inset-0 rounded-[inherit] animate-[glow-pulse_3s_ease-in-out_infinite] pointer-events-none border border-accent/20" />
        )}
      </Card>

      {/* Secondary metrics */}
      <Card className="p-4">
        <Metric
          label="Completed Today"
          value={stats?.completed_today ?? 0}
          icon={<CheckCircle2 size={12} />}
          tooltip="Tasks that finished successfully today."
        />
      </Card>
      <Card className="p-4">
        <Metric
          label="Failed Today"
          value={stats?.failed_today ?? 0}
          icon={<AlertTriangle size={12} />}
          tooltip="Tasks that failed or were aborted today."
        />
      </Card>
      <Card className="p-4">
        <Metric
          label="Avg Latency"
          value={latency ? `${(latency.avg_total_ms / 1000).toFixed(1)}s` : '--'}
          icon={<Timer size={12} />}
          tooltip="Average time from task submission to completion over the last 7 days."
        />
      </Card>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function Tasks() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('mine')
  const [search, setSearch] = useState('')
  const [podFilter, setPodFilter] = useState('')
  const [selectedTask, setSelectedTask] = useState<PipelineTask | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: tasks = [], isFetching } = useQuery({
    queryKey: ['pipeline-tasks'],
    queryFn: () => getPipelineTasks({ limit: 100 }),
    refetchInterval: statusFilter === 'complete' || statusFilter === 'failed' ? 30_000 : 3_000,
  })

  // Auto-open task from ?id= query param (e.g. from friction log links)
  useEffect(() => {
    const targetId = searchParams.get('id')
    if (targetId && tasks.length > 0 && !selectedTask) {
      const match = tasks.find(t => t.id === targetId)
      if (match) {
        setSelectedTask(match)
        // Also clear source filter in case the task is a cortex task
        setSourceFilter('all')
        // Clean up the URL
        setSearchParams({}, { replace: true })
      }
    }
  }, [tasks, searchParams, selectedTask, setSearchParams])

  const { data: queueStats } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: getQueueStats,
    refetchInterval: 5_000,
  })

  const { data: pods } = useQuery({ queryKey: ['pods'], queryFn: getPods, staleTime: 30_000 })

  const bulkDelete = useMutation({
    mutationFn: () => bulkDeletePipelineTasks(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      setConfirmClear(false)
    },
  })

  const bulkDeleteByIds = useMutation({
    mutationFn: (ids: string[]) => bulkDeletePipelineTasksByIds(ids),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })
      setSelectedIds(new Set())
      setConfirmBulkDelete(false)
    },
  })

  // Filter tasks
  const filteredTasks = tasks
    .filter(t => matchesFilter(t, statusFilter))
    .filter(t => matchesSourceFilter(t, sourceFilter))
    .filter(t => !search || t.user_input.toLowerCase().includes(search.toLowerCase()) || t.id.includes(search))
    .filter(t => !podFilter || t.pod_name === podFilter)

  const handleToggleSelect = useCallback((taskId: string, shiftKey: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)

      if (shiftKey && lastClickedRef.current) {
        // Shift-click: select range between last clicked and current
        const ids = filteredTasks.map(t => t.id)
        const lastIdx = ids.indexOf(lastClickedRef.current)
        const curIdx = ids.indexOf(taskId)
        if (lastIdx !== -1 && curIdx !== -1) {
          const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx]
          for (let i = start; i <= end; i++) {
            const t = filteredTasks[i]
            if (['complete', 'failed', 'cancelled'].includes(t.status)) {
              next.add(ids[i])
            }
          }
        }
      } else {
        // Normal click: toggle single
        if (next.has(taskId)) next.delete(taskId)
        else next.add(taskId)
      }

      lastClickedRef.current = taskId
      return next
    })
  }, [filteredTasks])

  // Count review/clarification tasks for alert badge
  const reviewCount = tasks.filter(t => t.status === 'pending_human_review' || t.status === 'clarification_needed').length
  const hasHistory = tasks.length > 0

  const uniquePods = [...new Set(tasks.map(t => t.pod_name).filter(Boolean) as string[])]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline Tasks"
        description="Submit and monitor async agent tasks."
        helpEntries={HELP_ENTRIES}
        actions={
          <div className="flex items-center gap-3">
            {queueStats && (
              <div className="hidden sm:flex gap-3 text-caption text-content-tertiary">
                <Tooltip content="Tasks waiting in the Redis queue to be picked up."><span>Queue: <strong className="text-content-primary">{queueStats.queue_depth}</strong></span></Tooltip>
                <Tooltip content="Tasks that failed repeatedly and were moved out of the queue."><span>Dead letter: <strong className={queueStats.dead_letter_depth > 0 ? 'text-danger' : 'text-content-primary'}>{queueStats.dead_letter_depth}</strong></span></Tooltip>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />}
              onClick={() => qc.invalidateQueries({ queryKey: ['pipeline-tasks'] })}
              disabled={isFetching}
            />
          </div>
        }
      />

      {/* Stats row */}
      <StatsRow />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status pills */}
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={clsx(
                'transition-colors',
              )}
            >
              <Badge
                color={statusFilter === f.id ? f.color : 'neutral'}
                size="md"
                dot={f.id === 'review' && reviewCount > 0}
                className={clsx(
                  'cursor-pointer transition-opacity',
                  statusFilter !== f.id && 'opacity-60 hover:opacity-100',
                )}
              >
                {f.label}
                {f.id === 'review' && reviewCount > 0 && (
                  <span className="ml-1 font-bold">{reviewCount}</span>
                )}
              </Badge>
            </button>
          ))}
        </div>

        {/* Search */}
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search tasks..."
          className="w-56"
        />

        {/* Source filter */}
        <div className="w-36">
          <Select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value as SourceFilter)}
            items={SOURCE_FILTERS}
          />
        </div>

        {/* Pod filter */}
        {uniquePods.length > 0 && (
          <div className="w-36">
            <Select
              value={podFilter}
              onChange={e => setPodFilter(e.target.value)}
              items={[
                { value: '', label: 'All pods' },
                ...uniquePods.map(p => ({ value: p, label: p })),
              ]}
            />
          </div>
        )}

        {/* Clear history */}
        {hasHistory && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={12} />}
            className="ml-auto"
            onClick={() => setConfirmClear(true)}
          >
            Clear History
          </Button>
        )}
      </div>

      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-surface-elevated border border-border-subtle">
          <Checkbox
            checked={selectedIds.size === filteredTasks.length}
            indeterminate={selectedIds.size > 0 && selectedIds.size < filteredTasks.length}
            onChange={(checked) => {
              if (checked) {
                setSelectedIds(new Set(filteredTasks.map(t => t.id)))
              } else {
                setSelectedIds(new Set())
              }
            }}
          />
          <span className="text-compact text-content-secondary">
            {selectedIds.size} selected
          </span>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={() => setConfirmBulkDelete(true)}
          >
            Delete Selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSelectedIds(new Set()); lastClickedRef.current = null }}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Task list */}
      {filteredTasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title={statusFilter === 'all' && sourceFilter === 'all' && !search ? 'No tasks yet' : 'No matching tasks'}
          description={
            statusFilter === 'all' && sourceFilter === 'all' && !search
              ? "Nova hasn't started any tasks yet. Create a goal and Nova will break it down into tasks automatically."
              : 'Try adjusting your filters or search query.'
          }
          action={statusFilter === 'all' && sourceFilter === 'all' && !search ? {
            label: 'Go to Goals',
            onClick: () => navigate('/goals'),
          } : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          {filteredTasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={setSelectedTask}
              selected={selectedIds.has(task.id)}
              onToggleSelect={handleToggleSelect}
            />
          ))}
        </Card>
      )}

      {/* Submit form — demoted below task list */}
      <SubmitForm />


      {/* Task detail sheet */}
      <TaskDetailSheet
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
      />

      {/* Confirm clear dialog */}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear Task History"
        description="This will permanently delete all non-running tasks — completed, failed, cancelled, and tasks waiting for review or clarification. Only actively running tasks are kept."
        confirmLabel={bulkDelete.isPending ? 'Deleting...' : 'Delete All'}
        onConfirm={() => bulkDelete.mutate()}
        destructive
      />

      {/* Confirm bulk delete selected */}
      <ConfirmDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        title={`Delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}?`}
        description={`${selectedIds.size} selected task${selectedIds.size === 1 ? '' : 's'} will be permanently deleted.`}
        confirmLabel={bulkDeleteByIds.isPending ? 'Deleting...' : `Delete ${selectedIds.size}`}
        onConfirm={() => bulkDeleteByIds.mutate([...selectedIds])}
        destructive
      />
    </div>
  )
}
