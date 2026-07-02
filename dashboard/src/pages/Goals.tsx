import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Target, Plus, Trash2, DollarSign,
  TrendingUp, Repeat, Pencil, Zap, Pause, Play,
  ChevronDown, ChevronRight, Lightbulb,
} from 'lucide-react'
import clsx from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import { apiFetch, getGoals, createGoal, updateGoal, deleteGoal, triggerGoal, getGoalStats, getIntelRecommendations, updateRecommendation, getGoalIterations, type Goal, type GoalIteration, type IntelRecommendation } from '../api'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useToast } from '../components/ToastProvider'
import FileViewer from '../components/FileViewer'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Input,
  Metric, Modal, ProgressBar, Select, Skeleton, Textarea, Toast, Tooltip,
} from '../components/ui'
import { DiscussionThread } from '../components/DiscussionThread'
import { MaturationBadge, type MaturationStatus } from '../components/MaturationBadge'
import { GoalMaturationDetail } from '../components/GoalMaturationDetail'
import { RecommendationCard } from '../components/intel/RecommendationCard'
import type { SemanticColor } from '../lib/design-tokens'

const HELP_ENTRIES = [
  { term: 'Goal', definition: 'An autonomous objective Nova pursues on its own — it plans, executes tasks, and checks progress without human prompting.' },
  { term: 'Iterations', definition: 'Thinking cycles — each iteration Nova re-evaluates the goal, plans next steps, and executes tasks.' },
  { term: 'Check Interval', definition: 'Minutes between autonomous thinking cycles. Lower = more frequent re-evaluation, higher cost.' },
  { term: 'Success Criteria', definition: "Observable, testable conditions Nova checks to measure progress — e.g. 'API response time < 200ms'." },
  { term: 'Cortex', definition: "Nova's autonomous brain — the service that runs thinking loops, manages goals, and tracks budgets." },
]

// ── Status helpers ──────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, SemanticColor> = {
  active: 'success',
  paused: 'warning',
  completed: 'info',
  failed: 'danger',
  cancelled: 'neutral',
}

const MATURATION_STAGES = ['triaging', 'scoping', 'speccing', 'review', 'building', 'verifying'] as const
const MATURATION_LABELS: Record<string, string> = {
  triaging: 'Triage',
  scoping: 'Scope',
  speccing: 'Spec',
  review: 'Review',
  building: 'Build',
  verifying: 'Verify',
}

function MaturationStages({ current, compact }: { current: string; compact?: boolean }) {
  const idx = MATURATION_STAGES.indexOf(current as typeof MATURATION_STAGES[number])
  return (
    <div className="inline-flex items-start gap-0.5">
      {MATURATION_STAGES.map((stage, i) => {
        const status = i < idx ? 'done' : i === idx ? 'active' : 'pending'
        return (
          <div key={stage} className={clsx('flex flex-col items-center', !compact && 'gap-0.5')}>
            <div className={clsx(
              'rounded-xs',
              compact ? 'w-4 h-1' : 'w-7 h-1.5',
              status === 'done' && 'bg-accent',
              status === 'active' && 'bg-accent animate-pulse-slow',
              status === 'pending' && 'bg-border-subtle',
            )} />
            {!compact && (
              <span className={clsx(
                'text-[9px] leading-tight',
                status === 'active' ? 'text-accent font-medium' : 'text-content-tertiary',
              )}>
                {MATURATION_LABELS[stage]}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Spawned subgoals affordance ─────────────────────────────────────────────────

function SpawnedChildrenLine({ goalId, count }: { goalId: string; count: number }) {
  const [open, setOpen] = useState(false)
  const { data: children } = useQuery<Goal[]>({
    queryKey: ['goal-children', goalId],
    queryFn: () => apiFetch<Goal[]>(`/api/v1/goals?parent_goal_id=${goalId}`),
    enabled: open,
    staleTime: 10_000,
  })

  const summary = children
    ? `Spawned ${count} subgoals → ${children.filter(c => c.status === 'completed').length} done · ${children.filter(c => c.status === 'active').length} active · ${children.filter(c => c.maturation_status === 'review').length} need review`
    : `Spawned ${count} subgoals (click to load)`

  return (
    <div onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(v => !v)}
        className="text-caption text-accent hover:underline"
      >
        {summary}
      </button>
      {open && children && (
        <ul className="mt-1 ml-4 space-y-0.5 list-disc list-inside">
          {children.map(c => (
            <li key={c.id} className="text-caption text-content-secondary">
              <span className="font-medium">{c.title}</span> · {c.status}
              {c.maturation_status && (
                <span className="text-content-tertiary"> ({c.maturation_status})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type StatusFilter = 'all' | 'active' | 'paused' | 'completed' | 'failed'

const STATUS_FILTERS: { id: StatusFilter; label: string; color: SemanticColor }[] = [
  { id: 'all', label: 'All', color: 'neutral' },
  { id: 'active', label: 'Active', color: 'success' },
  { id: 'paused', label: 'Paused', color: 'warning' },
  { id: 'completed', label: 'Completed', color: 'info' },
  { id: 'failed', label: 'Failed', color: 'danger' },
]

// ── Stats row ───────────────────────────────────────────────────────────────────

function GoalStatsRow() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['goal-stats'],
    queryFn: getGoalStats,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton lines={2} />
          </Card>
        ))}
      </div>
    )
  }

  const activeCount = stats?.active ?? 0
  const successPct = stats ? Math.round(stats.success_rate * 100) : null
  const successColor = successPct == null ? 'text-content-primary'
    : successPct >= 70 ? 'text-success'
    : successPct >= 40 ? 'text-warning'
    : 'text-danger'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {/* Hero metric — active goals */}
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
            <Target size={20} />
          </div>
          <div>
            <p className="text-caption text-content-tertiary">Active Goals</p>
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

      {/* Success rate — color-coded by performance */}
      <Card className="p-4">
        <div className="flex flex-col gap-1">
          <Tooltip content="Percentage of goal iterations that produced useful progress." side="bottom">
            <span className="text-caption font-medium text-content-tertiary uppercase tracking-wider inline-flex items-center gap-1.5">
              <TrendingUp size={12} />
              Success Rate
            </span>
          </Tooltip>
          <span className={clsx('text-display font-mono', successColor)}>
            {successPct != null ? `${successPct}%` : '--'}
          </span>
        </div>
      </Card>
      <Card className="p-4">
        <Metric
          label="Avg Iterations"
          value={stats?.avg_iterations?.toFixed(1) ?? '--'}
          icon={<Repeat size={12} />}
          tooltip="Average number of thinking cycles per goal before completion or pause."
        />
      </Card>
      <Card className="p-4">
        <Metric
          label="Total Cost"
          value={stats ? `$${stats.total_cost_usd.toFixed(2)}` : '--'}
          icon={<DollarSign size={12} />}
          tooltip="Cumulative LLM API spend across all goal iterations."
        />
      </Card>
    </div>
  )
}

// ── Create goal modal ─────────────────────────────────────────────────────────

function CreateGoalModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [successCriteria, setSuccessCriteria] = useState('')
  const [priority, setPriority] = useState('3')
  const [maxCost, setMaxCost] = useState('')
  const [maxIterations, setMaxIterations] = useState('')
  const [checkInterval, setCheckInterval] = useState('60')
  const [scheduleCron, setScheduleCron] = useState('')
  const [maxCompletions, setMaxCompletions] = useState('')
  const qc = useQueryClient()

  const create = useMutation({
    mutationFn: () =>
      createGoal({
        title,
        description: description || undefined,
        success_criteria: successCriteria || undefined,
        priority: Number(priority),
        max_iterations: maxIterations ? Number(maxIterations) : null,
        max_cost_usd: maxCost ? Number(maxCost) : undefined,
        check_interval_seconds: checkInterval ? Number(checkInterval) * 60 : undefined,
        schedule_cron: scheduleCron.trim() || null,
        max_completions: maxCompletions ? Number(maxCompletions) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      qc.invalidateQueries({ queryKey: ['goal-stats'] })
      resetForm()
      onClose()
    },
  })

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setSuccessCriteria('')
    setPriority('3')
    setMaxCost('')
    setMaxIterations('')
    setCheckInterval('60')
    setScheduleCron('')
    setMaxCompletions('')
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create Goal"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!title.trim()}
            loading={create.isPending}
          >
            Create Goal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What should Nova achieve?"
          autoFocus
        />
        <Textarea
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Describe the objective — what state should Nova work to achieve and maintain?"
          rows={3}
        />
        <Textarea
          label="Success Criteria"
          value={successCriteria}
          onChange={e => setSuccessCriteria(e.target.value)}
          placeholder="How does Nova measure progress? List observable, testable conditions."
          rows={3}
          description="Goals are standing objectives, not one-shot tasks. Describe measurable conditions Nova can check after each iteration."
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Priority"
            value={priority}
            onChange={e => setPriority(e.target.value)}
            items={[
              { value: '1', label: 'Critical' },
              { value: '2', label: 'High' },
              { value: '3', label: 'Normal' },
              { value: '4', label: 'Low' },
            ]}
          />
          <Input
            label="Budget (USD)"
            type="number"
            value={maxCost}
            onChange={e => setMaxCost(e.target.value)}
            placeholder="No limit"
            description="Optional spending cap"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Max Iterations"
            type="number"
            value={maxIterations}
            onChange={e => setMaxIterations(e.target.value)}
            placeholder="No limit"
            description="Leave blank to run indefinitely"
          />
          <Input
            label="Check Interval (min)"
            type="number"
            value={checkInterval}
            onChange={e => setCheckInterval(e.target.value)}
            placeholder="60"
            description="Minutes between thinking cycles"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Schedule (cron)"
            value={scheduleCron}
            onChange={e => setScheduleCron(e.target.value)}
            placeholder="0 9 * * 1"
            description="Optional. Fires the goal on a cron schedule (needs the brain enabled)."
          />
          <Input
            label="Max Runs"
            type="number"
            value={maxCompletions}
            onChange={e => setMaxCompletions(e.target.value)}
            placeholder="Unlimited"
            description="Auto-complete after N scheduled runs"
          />
        </div>
        {create.isError && (
          <p className="text-caption text-danger">Failed to create goal: {String(create.error)}</p>
        )}
      </div>
    </Modal>
  )
}

// ── Edit goal modal ──────────────────────────────────────────────────────────

function EditGoalModal({
  goal,
  open,
  onClose,
}: {
  goal: Goal
  open: boolean
  onClose: () => void
}) {
  const [title, setTitle] = useState(goal.title)
  const [description, setDescription] = useState(goal.description ?? '')
  const [successCriteria, setSuccessCriteria] = useState(goal.success_criteria ?? '')
  const [priority, setPriority] = useState(String(goal.priority))
  const [maxCost, setMaxCost] = useState(goal.max_cost_usd != null ? String(goal.max_cost_usd) : '')
  const [maxIterations, setMaxIterations] = useState(goal.max_iterations != null ? String(goal.max_iterations) : '')
  const [checkInterval, setCheckInterval] = useState(goal.check_interval_seconds != null ? String(Math.round(goal.check_interval_seconds / 60)) : '')
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: () =>
      updateGoal(goal.id, {
        title,
        description: description || null,
        success_criteria: successCriteria || null,
        priority: Number(priority),
        max_cost_usd: maxCost ? Number(maxCost) : null,
        max_iterations: maxIterations ? Number(maxIterations) : null,
        check_interval_seconds: checkInterval ? Number(checkInterval) * 60 : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      qc.invalidateQueries({ queryKey: ['goal-stats'] })
      onClose()
    },
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit Goal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!title.trim()}
            loading={save.isPending}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What should Nova achieve?"
          autoFocus
        />
        <Textarea
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Describe the objective — what state should Nova work to achieve and maintain?"
          rows={3}
        />
        <Textarea
          label="Success Criteria"
          value={successCriteria}
          onChange={e => setSuccessCriteria(e.target.value)}
          placeholder="How does Nova measure progress? List observable, testable conditions."
          rows={3}
          description="Goals are standing objectives, not one-shot tasks. Describe measurable conditions Nova can check after each iteration."
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Priority"
            value={priority}
            onChange={e => setPriority(e.target.value)}
            items={[
              { value: '1', label: 'Critical' },
              { value: '2', label: 'High' },
              { value: '3', label: 'Normal' },
              { value: '4', label: 'Low' },
            ]}
          />
          <Input
            label="Budget (USD)"
            type="number"
            value={maxCost}
            onChange={e => setMaxCost(e.target.value)}
            placeholder="No limit"
            description="Optional spending cap"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Max Iterations"
            type="number"
            value={maxIterations}
            onChange={e => setMaxIterations(e.target.value)}
            placeholder="No limit"
            description="Leave blank to run indefinitely"
          />
          <Input
            label="Check Interval (min)"
            type="number"
            value={checkInterval}
            onChange={e => setCheckInterval(e.target.value)}
            placeholder="60"
            description="Minutes between thinking cycles"
          />
        </div>
        {save.isError && (
          <p className="text-caption text-danger">Failed to save: {String(save.error)}</p>
        )}
      </div>
    </Modal>
  )
}

// ── Goal timeline ────────────────────────────────────────────────────────────

function buildNarrative(iterations: GoalIteration[]): string {
  if (iterations.length === 0) return 'No activity yet.'
  const parts: string[] = []
  const chronological = [...iterations].reverse()
  for (const it of chronological) {
    if (it.task_status === 'complete') {
      parts.push(it.task_summary || 'Completed a task.')
    } else if (it.task_status === 'failed') {
      parts.push(`Failed: ${it.task_summary || 'unknown error'}.`)
    }
  }
  return parts.join(' ') || 'Work in progress.'
}

function GoalTimeline({ goalId, onFileClick }: { goalId: string; onFileClick: (p: string) => void }) {
  const navigate = useNavigate()
  const { data: iterations = [], isLoading } = useQuery({
    queryKey: ['goal-iterations', goalId],
    queryFn: () => getGoalIterations(goalId),
    staleTime: 10_000,
  })

  if (isLoading) return <Skeleton lines={4} />
  if (iterations.length === 0) return <p className="text-compact text-content-tertiary">No iteration history yet.</p>

  const narrative = buildNarrative(iterations.slice(0, 5))

  return (
    <div>
      {/* Progress narrative */}
      <div className="mb-4 rounded-md border border-accent/20 bg-gradient-to-br from-surface to-surface-elevated p-3">
        <p className="text-caption font-medium uppercase tracking-wide text-accent">
          Progress — {iterations.length} attempt{iterations.length !== 1 ? 's' : ''}
        </p>
        <p className="mt-1 text-compact text-content-primary">{narrative}</p>
      </div>

      {/* Timeline */}
      <div className="space-y-0">
        {iterations.map((it, i) => (
          <div key={it.id} className="relative pb-4 pl-6">
            {/* Connector line */}
            {i < iterations.length - 1 && (
              <div className="absolute left-[9px] top-5 h-full w-0.5 bg-border" />
            )}
            {/* Status dot */}
            <div className={`absolute left-1 top-1.5 h-3 w-3 rounded-full border-2 border-surface ${
              it.task_status === 'complete' ? 'bg-success' :
              it.task_status === 'failed' ? 'bg-danger' : 'bg-content-tertiary'
            }`} />

            <div className="rounded-md border border-border bg-surface-elevated p-2.5">
              <div className="mb-1 text-caption text-content-tertiary">
                Attempt {it.attempt} — {new Date(it.created_at).toLocaleString()}
              </div>

              {/* Plan adjustment callout */}
              {it.plan_adjustment && (
                <div className="mb-2 rounded-sm border border-warning-dim/30 bg-warning-dim/10 px-2 py-1 text-caption text-warning">
                  {it.plan_adjustment}
                </div>
              )}

              <p className="text-compact font-medium text-content-primary">
                {it.task_summary || it.plan_text || 'No details'}
              </p>

              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption">
                <span className={
                  it.task_status === 'complete' ? 'text-success' :
                  it.task_status === 'failed' ? 'text-danger' : 'text-content-tertiary'
                }>
                  {it.task_status || 'pending'}
                </span>
                {it.task_id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(`/tasks?id=${it.task_id}`) }}
                    className="text-accent hover:underline font-medium"
                    title={`View task ${it.task_id}`}
                  >
                    View task
                  </button>
                )}
                {(it.files_touched || []).map((f: string) => (
                  <button key={f} onClick={() => onFileClick(f)}
                          className="text-accent hover:underline">
                    {f.split('/').pop()}
                  </button>
                ))}
                {Number(it.cost_usd) > 0 && (
                  <span className="text-content-tertiary">${Number(it.cost_usd).toFixed(2)}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Goal card ──────────────────────────────────────────────────────────────────

function GoalCard({ goal }: { goal: Goal }) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)
  const [maturationOpen, setMaturationOpen] = useState(false)
  const qc = useQueryClient()
  const [viewingFile, setViewingFile] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: () => deleteGoal(goal.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      qc.invalidateQueries({ queryKey: ['goal-stats'] })
    },
  })

  const trigger = useMutation({
    mutationFn: () => triggerGoal(goal.id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['goal-tasks', goal.id] })
      qc.invalidateQueries({ queryKey: ['goals'] })
      setToast({
        variant: 'success',
        message: data.task_id
          ? `Task ${data.task_id.slice(0, 8)} dispatched.`
          : 'Goal triggered.',
      })
    },
    onError: (e) => setToast({ variant: 'error', message: `Failed to trigger: ${e}` }),
  })

  const toggleEnabled = useMutation({
    mutationFn: () => {
      const newStatus = goal.status === 'active' ? 'paused' : 'active'
      return updateGoal(goal.id, { status: newStatus })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      qc.invalidateQueries({ queryKey: ['goal-stats'] })
    },
    onError: (e) => setToast({ variant: 'error', message: `Failed to toggle: ${e}` }),
  })

  const progressPct = Math.round(goal.progress * 100)
  const color = STATUS_COLOR[goal.status] ?? 'neutral'

  const priorityLabel = (p: number) => {
    if (p <= 1) return 'Critical'
    if (p <= 2) return 'High'
    if (p <= 3) return 'Normal'
    return 'Low'
  }

  return (
    <>
      <Card
        variant="hoverable"
        className={clsx(
          'p-4',
          goal.status === 'active' && 'border-l-2 border-l-accent shadow-[inset_4px_0_8px_-4px_rgba(25,168,158,0.25)]',
          goal.status === 'paused' && 'opacity-70 hover:opacity-85',
          (goal.status === 'completed' || goal.status === 'failed' || goal.status === 'cancelled') && 'opacity-55 hover:opacity-75',
        )}
        onClick={() => setExpanded(v => !v)}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-compact font-semibold text-content-primary truncate">
                {goal.title}
              </span>
              <Badge color={color} size="sm">{goal.status}</Badge>
              <MaturationBadge status={goal.maturation_status as MaturationStatus} />
              {goal.maturation_status && (
                <MaturationStages current={goal.maturation_status} compact />
              )}
              {goal.priority <= 2 && (
                <Badge color={goal.priority <= 1 ? 'danger' : 'warning'} size="sm">
                  {priorityLabel(goal.priority)}
                </Badge>
              )}
            </div>
            {goal.description && (
              <p className="text-caption text-content-secondary line-clamp-2">
                {goal.description}
              </p>
            )}
            {goal.spec_children && goal.spec_children.length > 0 && (
              <div className="mt-1.5">
                <SpawnedChildrenLine goalId={goal.id} count={goal.spec_children.length} />
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
            {(goal.status === 'active' || goal.status === 'paused') && (
              <Tooltip content={goal.status === 'active' ? 'Disable goal' : 'Enable goal'}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={goal.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                  onClick={() => toggleEnabled.mutate()}
                  loading={toggleEnabled.isPending}
                />
              </Tooltip>
            )}
            {goal.status === 'active' && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Zap size={14} />}
                onClick={() => trigger.mutate()}
                loading={trigger.isPending}
                title="Run now"
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={14} />}
              onClick={() => setEditing(true)}
              title="Edit goal"
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={() => setConfirmDelete(true)}
              title="Delete goal"
            />
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 flex items-center gap-3">
          <ProgressBar value={progressPct} size="sm" className="flex-1" />
          <span className="text-mono-sm text-content-tertiary w-10 text-right">
            {progressPct}%
          </span>
        </div>

        {/* Quick stats */}
        <div className="mt-2 flex items-center gap-4 text-caption text-content-tertiary">
          <Tooltip content="Thinking cycles used out of the maximum allowed.">
            <span>
              Iter: <span className="text-content-secondary">
                {goal.iteration}{goal.max_iterations ? `/${goal.max_iterations}` : ''}
              </span>
            </span>
          </Tooltip>
          <span>
            Cost: <span className="font-mono text-content-secondary">
              ${goal.cost_so_far_usd.toFixed(2)}
              {goal.max_cost_usd ? ` / $${goal.max_cost_usd.toFixed(2)}` : ''}
            </span>
          </span>
          {goal.last_checked_at && (
            <span>
              Last run: <span className="text-content-secondary">
                {formatDistanceToNow(new Date(goal.last_checked_at), { addSuffix: true })}
              </span>
            </span>
          )}
          {goal.schedule_cron && (
            <span>
              Schedule: <span className="font-mono text-content-secondary">{goal.schedule_cron}</span>
              {goal.schedule_next_at && (
                <> · next {formatDistanceToNow(new Date(goal.schedule_next_at), { addSuffix: true })}</>
              )}
              {goal.max_completions != null && (
                <> · run {goal.completion_count ?? 0}/{goal.max_completions}</>
              )}
            </span>
          )}
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border-subtle space-y-2 text-caption text-content-tertiary">
            {goal.success_criteria && (
              <div>
                <span className="font-medium text-content-secondary">Success Criteria</span>
                <p className="text-content-secondary whitespace-pre-wrap mt-0.5">{goal.success_criteria}</p>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <span className="text-content-tertiary">Priority</span>
                <p className="text-content-secondary">{priorityLabel(goal.priority)}</p>
              </div>
              <div>
                <span className="text-content-tertiary">Created</span>
                <p className="text-content-secondary">
                  {formatDistanceToNow(new Date(goal.created_at), { addSuffix: true })}
                </p>
              </div>
              <div>
                <span className="text-content-tertiary">Created by</span>
                <p className="text-content-secondary">{goal.created_by}</p>
              </div>
              <div>
                <span className="text-content-tertiary">Last Updated</span>
                <p className="text-content-secondary">
                  {formatDistanceToNow(new Date(goal.updated_at), { addSuffix: true })}
                </p>
              </div>
            </div>
            {goal.check_interval_seconds && (
              <div>
                <span className="text-content-tertiary">Check interval: </span>
                <span className="text-content-secondary">
                  {goal.check_interval_seconds >= 3600
                    ? `${(goal.check_interval_seconds / 3600).toFixed(1)}h`
                    : `${Math.round(goal.check_interval_seconds / 60)}m`}
                </span>
              </div>
            )}

            {/* Goal Timeline */}
            <div className="mt-2" onClick={e => e.stopPropagation()}>
              <GoalTimeline goalId={goal.id} onFileClick={setViewingFile} />
            </div>

            {/* Maturation & Discussion */}
            <div className="mt-3 pt-3 border-t border-border-subtle">
              <button
                onClick={(e) => { e.stopPropagation(); setMaturationOpen(v => !v) }}
                className="flex items-center gap-1.5 text-caption font-medium text-content-secondary hover:text-content-primary transition-colors"
              >
                {maturationOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Maturation & Discussion
                {goal.maturation_status && (
                  <MaturationStages current={goal.maturation_status} />
                )}
              </button>

              {maturationOpen && (
                <div className="mt-3 space-y-3" onClick={e => e.stopPropagation()}>
                  <GoalMaturationDetail
                    goal={goal}
                    onSuccess={(message) => setToast({ variant: 'success', message })}
                    onError={(message) => setToast({ variant: 'error', message })}
                  />

                  {/* Discussion thread */}
                  <DiscussionThread entityType="goal" entityId={goal.id} />
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Confirm delete */}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete Goal"
        description={`Are you sure you want to delete "${goal.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          remove.mutate()
          setConfirmDelete(false)
        }}
        destructive
      />

      {/* Edit modal */}
      {editing && (
        <EditGoalModal goal={goal} open={editing} onClose={() => setEditing(false)} />
      )}

      {/* File viewer modal */}
      {viewingFile && <FileViewer path={viewingFile} onClose={() => setViewingFile(null)} />}

      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

type PageView = 'goals' | 'suggested'

export function Goals() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showCreate, setShowCreate] = useState(false)
  const [pageView, setPageView] = useState<PageView>('goals')
  const [expandedRecId, setExpandedRecId] = useState<string | null>(null)
  const qc = useQueryClient()
  const [directCreation] = useLocalStorage('goals.directCreation', false)
  const [request, setRequest] = useState('')
  const [sending, setSending] = useState(false)
  const { addToast } = useToast()

  const handleRequest = async () => {
    if (!request.trim() || sending) return
    setSending(true)
    try {
      await apiFetch('/api/v1/pipeline/tasks', {
        method: 'POST',
        body: JSON.stringify({
          user_input: request.trim(),
          metadata: { source: 'goals_page' },
        }),
      })
      setRequest('')
      addToast({ variant: 'success', message: 'Request sent to Nova' })
    } catch (err) {
      addToast({ variant: 'error', message: 'Failed to send request' })
    } finally {
      setSending(false)
    }
  }

  const apiStatus = statusFilter === 'all' ? undefined : statusFilter

  const { data: goals = [], isFetching } = useQuery({
    queryKey: ['goals', apiStatus],
    queryFn: () => getGoals(apiStatus),
    refetchInterval: 10_000,
  })

  const { data: pendingRecs = [], isLoading: recsLoading } = useQuery({
    queryKey: ['intel-recs', 'pending'],
    queryFn: () => getIntelRecommendations({ status: 'pending' }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })

  const recMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateRecommendation(id, { status }),
    onSuccess: (_rec, { status }) => {
      qc.invalidateQueries({ queryKey: ['intel-recs'] })
      qc.invalidateQueries({ queryKey: ['intel-stats'] })
      qc.invalidateQueries({ queryKey: ['goals'] })
      qc.invalidateQueries({ queryKey: ['goal-stats'] })
      if (status === 'approved') {
        addToast({ variant: 'success', message: 'Goal created from recommendation' })
      } else if (status === 'deferred') {
        addToast({ variant: 'info', message: 'Recommendation deferred' })
      } else if (status === 'dismissed') {
        addToast({ variant: 'info', message: 'Recommendation declined' })
      }
    },
    onError: (err) => {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to update recommendation',
      })
    },
  })

  const handleRecStatusChange = (id: string) => (status: string) => {
    recMutation.mutate({ id, status })
  }

  const pendingCount = pendingRecs.length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals"
        description="Define autonomous objectives for Nova to pursue"
        helpEntries={HELP_ENTRIES}
        actions={
          directCreation ? (
            <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Create Directly
            </Button>
          ) : undefined
        }
      />

      {/* Request input — prominent card below header */}
      <Card className="p-4">
        <div className="flex gap-3 items-start">
          <div className="flex-1">
            <textarea
              value={request}
              onChange={e => setRequest(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleRequest()
                }
              }}
              placeholder="Tell Nova what you want to achieve... (e.g. 'Monitor Ollama releases weekly' or 'Track AI security advisories')"
              disabled={sending}
              rows={2}
              className="w-full resize-none rounded-sm border border-border bg-surface-input px-3 py-2.5 text-compact text-content-primary placeholder:text-content-tertiary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40 transition-colors"
            />
            <p className="mt-1.5 text-micro text-content-tertiary">
              Nova will structure your request into an actionable goal with success criteria, then ask for confirmation before creating it.
            </p>
          </div>
          <Button
            onClick={handleRequest}
            disabled={!request.trim() || sending}
            loading={sending}
          >
            {sending ? 'Sending...' : 'Request'}
          </Button>
        </div>
      </Card>

      {/* Stats row */}
      <GoalStatsRow />

      {/* Pending recommendations banner */}
      {pendingCount > 0 && pageView === 'goals' && (
        <button
          onClick={() => setPageView('suggested')}
          className="flex items-center gap-2 w-full rounded-md border border-accent/20 bg-accent/5 px-4 py-2.5 text-left transition-colors hover:bg-accent/10"
        >
          <Lightbulb size={16} className="text-accent shrink-0" />
          <span className="text-compact text-content-secondary">
            <strong className="text-accent">{pendingCount}</strong> new recommendation{pendingCount !== 1 ? 's' : ''} waiting for review
          </span>
          <ChevronRight size={14} className="ml-auto text-content-tertiary" />
        </button>
      )}

      {/* Page view tabs: Goals | Suggested */}
      <div className="flex items-center gap-1 border-b border-border-subtle">
        <button
          onClick={() => setPageView('goals')}
          className={clsx(
            'px-4 py-2 text-compact font-medium transition-colors border-b-2 -mb-px',
            pageView === 'goals'
              ? 'border-accent-500 text-content-primary'
              : 'border-transparent text-content-tertiary hover:text-content-secondary',
          )}
        >
          Goals
        </button>
        <button
          onClick={() => setPageView('suggested')}
          className={clsx(
            'flex items-center gap-1.5 px-4 py-2 text-compact font-medium transition-colors border-b-2 -mb-px',
            pageView === 'suggested'
              ? 'border-accent-500 text-content-primary'
              : 'border-transparent text-content-tertiary hover:text-content-secondary',
          )}
        >
          <Lightbulb size={13} />
          Suggested
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-micro font-semibold bg-accent-500/20 text-accent-400">
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {pageView === 'goals' ? (
        <>
          {/* Status filter pills */}
          <div className="flex items-center gap-1 flex-wrap">
            {STATUS_FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
              >
                <Badge
                  color={statusFilter === f.id ? f.color : 'neutral'}
                  size="md"
                  className={clsx(
                    'cursor-pointer transition-opacity',
                    statusFilter !== f.id && 'opacity-60 hover:opacity-100',
                  )}
                >
                  {f.label}
                </Badge>
              </button>
            ))}
            {isFetching && (
              <span className="text-caption text-content-tertiary animate-pulse ml-2">Updating...</span>
            )}
          </div>

          {/* Goals list */}
          {goals.length === 0 ? (
            <EmptyState
              icon={Target}
              title={statusFilter === 'all' ? 'No goals yet' : `No ${statusFilter} goals`}
              description={
                statusFilter === 'all'
                  ? 'Tell Nova what you want to accomplish. It will plan, execute, and iterate autonomously.'
                  : 'Try selecting a different filter.'
              }
            />
          ) : (
            <div className="space-y-3">
              {goals.map((goal: Goal) => (
                <GoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Suggested: pending intel recommendations */}
          <p className="text-caption text-content-tertiary -mb-2">
            Recommendations from intelligence feeds that Nova thinks could become goals. Approve to create a goal, defer to review later, or decline to dismiss permanently.
          </p>
          {recsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="p-4">
                  <Skeleton lines={4} />
                </Card>
              ))}
            </div>
          ) : pendingRecs.length === 0 ? (
            <EmptyState
              icon={Lightbulb}
              title="No pending recommendations"
              description="Intelligence feeds haven't surfaced any new suggestions yet."
            />
          ) : (
            <div className="space-y-3">
              {pendingRecs.map((rec: IntelRecommendation) => (
                <RecommendationCard
                  key={rec.id}
                  rec={rec}
                  expanded={expandedRecId === rec.id}
                  onToggle={() => setExpandedRecId(prev => prev === rec.id ? null : rec.id)}
                  onStatusChange={handleRecStatusChange(rec.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Create goal modal — only when direct creation is enabled */}
      {directCreation && <CreateGoalModal open={showCreate} onClose={() => setShowCreate(false)} />}
    </div>
  )
}
