import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, RefreshCw, Layers,
  Loader2, Thermometer, Hash, Clock, RotateCw, FileText, Cpu, Settings2, Shield, Wrench,
  Plus, Trash2, ArrowUp, ArrowDown, X,
} from 'lucide-react'
import clsx from 'clsx'
import { getPods, getPod, updatePod, updatePodAgent, createPod, deletePod, discoverModels } from '../api'
import type { Pod, PodAgent } from '../types'
import { ToolPicker } from '../components/ToolPicker'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Card, Badge, Toggle, StatusDot, PipelineStages, Metric, Tooltip,
  Button, Input, Textarea, Select, RadioGroup, Modal, ConfirmDialog, EmptyState, Skeleton,
} from '../components/ui'

// ── Role → badge color mapping ───────────────────────────────────────────────

const ROLE_BADGE_COLOR: Record<string, 'info' | 'accent' | 'warning' | 'neutral' | 'success'> = {
  context:     'info',
  task:        'accent',
  guardrail:   'warning',
  code_review: 'neutral',
  decision:    'success',
}

// ── Pipeline stage status from agents ────────────────────────────────────────

function agentPipelineStatuses(agents: PodAgent[]): ('done' | 'pending')[] {
  const roles = ['context', 'task', 'guardrail', 'code_review', 'decision']
  return roles.map(role => {
    const agent = agents.find(a => a.role === role)
    return agent && agent.enabled ? 'done' : 'pending'
  })
}

// ── On-failure options ───────────────────────────────────────────────────────

const ON_FAILURE_OPTIONS = [
  { value: 'abort', label: 'Abort', description: 'Stop the pipeline immediately' },
  { value: 'skip', label: 'Skip', description: 'Skip this agent and continue' },
]

// ── Agent row ────────────────────────────────────────────────────────────────

function AgentRow({
  agent, podId, podDefaultModel,
}: {
  agent: PodAgent
  podId: string
  podDefaultModel?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const qc = useQueryClient()

  const toggle = useMutation({
    mutationFn: () => updatePodAgent(podId, agent.id, {
      name: agent.name, role: agent.role, position: agent.position,
      model: agent.model ?? undefined, fallback_models: agent.fallback_models ?? [],
      temperature: agent.temperature,
      max_tokens: agent.max_tokens, timeout_seconds: agent.timeout_seconds,
      max_retries: agent.max_retries, system_prompt: agent.system_prompt ?? undefined,
      allowed_tools: agent.allowed_tools ?? undefined, on_failure: agent.on_failure,
      run_condition: agent.run_condition,
      artifact_type: agent.artifact_type ?? undefined,
      parallel_group: agent.parallel_group ?? undefined,
      enabled: !agent.enabled,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pod', podId] }),
  })

  return (
    <Card
      variant={agent.enabled ? 'default' : 'outlined'}
      className={clsx(!agent.enabled && 'opacity-60')}
    >
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex shrink-0 items-center gap-2 min-w-0 flex-1 text-left"
        >
          <span className="shrink-0 text-content-tertiary">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-elevated text-micro font-bold text-content-tertiary">
            {agent.position + 1}
          </span>
          <Badge color={ROLE_BADGE_COLOR[agent.role] ?? 'neutral'} size="sm">
            {agent.role.replace('_', ' ')}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="truncate text-compact font-medium text-content-primary">{agent.name}</p>
            {agent.model && (
              <p className="truncate text-caption text-content-tertiary font-mono">{agent.model}</p>
            )}
          </div>
        </button>

        {/* Right-side metadata */}
        <Badge color="neutral" size="sm" className="hidden sm:inline-flex">
          {agent.on_failure}
        </Badge>
        <span className="hidden text-caption text-content-tertiary sm:inline">
          {agent.allowed_tools ? `${agent.allowed_tools.length} tools` : 'all tools'}
        </span>

        <Toggle
          checked={agent.enabled}
          onChange={() => toggle.mutate()}
          disabled={toggle.isPending}
          size="sm"
        />
      </div>

      {/* Expanded config detail */}
      {expanded && (
        <div className="border-t border-border-subtle px-5 pb-5 pt-4 space-y-5">
          <AgentAdvancedSettings agent={agent} podId={podId} />
          <AgentToolSettings agent={agent} podId={podId} />
          <AgentModelPicker agent={agent} podId={podId} podDefaultModel={podDefaultModel} />
          <AgentSystemPrompt agent={agent} podId={podId} />
        </div>
      )}
    </Card>
  )
}

// ── Agent system prompt editor ───────────────────────────────────────────────

function AgentSystemPrompt({ agent, podId }: { agent: PodAgent; podId: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState(agent.system_prompt ?? '')
  const [editing, setEditing] = useState(false)

  const save = useMutation({
    mutationFn: () => updatePodAgent(podId, agent.id, {
      name: agent.name, role: agent.role, enabled: agent.enabled,
      position: agent.position, model: agent.model ?? undefined,
      fallback_models: agent.fallback_models,
      temperature: agent.temperature, max_tokens: agent.max_tokens,
      timeout_seconds: agent.timeout_seconds, max_retries: agent.max_retries,
      allowed_tools: agent.allowed_tools ?? undefined, on_failure: agent.on_failure,
      run_condition: agent.run_condition,
      artifact_type: agent.artifact_type ?? undefined,
      parallel_group: agent.parallel_group ?? undefined,
      system_prompt: draft || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] })
      setEditing(false)
    },
  })

  const cancel = () => {
    setDraft(agent.system_prompt ?? '')
    setEditing(false)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-caption font-medium text-content-tertiary">
          <FileText size={12} /> System Prompt
        </p>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea
            rows={8}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Describe this agent's role, persona, and constraints..."
            autoResize={false}
            autoFocus
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-micro text-content-tertiary">{draft.length} chars</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</Button>
              <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
            </div>
          </div>
          {save.isError && (
            <p className="text-caption text-danger">Save failed -- check console</p>
          )}
        </div>
      ) : (
        agent.system_prompt ? (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-surface-elevated border border-border-subtle px-3 py-2 font-mono text-caption text-content-secondary leading-relaxed">
            {agent.system_prompt}
          </pre>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-dashed border-border py-3 text-caption text-content-tertiary hover:border-accent hover:text-accent transition-colors"
          >
            <FileText size={12} />
            No system prompt -- click to add one
          </button>
        )
      )}
    </div>
  )
}

// ── Agent advanced settings ──────────────────────────────────────────────────

function AgentAdvancedSettings({ agent, podId }: { agent: PodAgent; podId: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [onFailure, setOnFailure] = useState(agent.on_failure)
  const [temperature, setTemperature] = useState(String(agent.temperature))
  const [maxTokens, setMaxTokens] = useState(String(agent.max_tokens))
  const [timeout, setTimeout_] = useState(String(agent.timeout_seconds))
  const [maxRetries, setMaxRetries] = useState(String(agent.max_retries))

  const cancel = () => {
    setOnFailure(agent.on_failure)
    setTemperature(String(agent.temperature))
    setMaxTokens(String(agent.max_tokens))
    setTimeout_(String(agent.timeout_seconds))
    setMaxRetries(String(agent.max_retries))
    setEditing(false)
  }

  const save = useMutation({
    mutationFn: () => updatePodAgent(podId, agent.id, {
      name: agent.name, role: agent.role, enabled: agent.enabled,
      position: agent.position, model: agent.model ?? undefined,
      fallback_models: agent.fallback_models,
      system_prompt: agent.system_prompt ?? undefined,
      run_condition: agent.run_condition,
      artifact_type: agent.artifact_type ?? undefined,
      parallel_group: agent.parallel_group ?? undefined,
      on_failure: onFailure,
      temperature: parseFloat(temperature) || agent.temperature,
      max_tokens: parseInt(maxTokens) || agent.max_tokens,
      timeout_seconds: parseInt(timeout) || agent.timeout_seconds,
      max_retries: parseInt(maxRetries) || agent.max_retries,
      allowed_tools: agent.allowed_tools,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] })
      setEditing(false)
    },
  })

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-caption font-medium text-content-tertiary">
          <Settings2 size={12} /> Settings
        </p>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-4 rounded-sm border border-border-subtle bg-surface-elevated p-4">
          {/* On failure */}
          <div>
            <p className="text-caption font-medium text-content-secondary mb-2">On Failure</p>
            <RadioGroup
              name={`on-failure-${agent.id}`}
              options={ON_FAILURE_OPTIONS}
              value={onFailure}
              onChange={setOnFailure}
            />
          </div>

          {/* Numeric fields */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input
              label="Temperature"
              type="number"
              step="0.05"
              min="0"
              max="2"
              value={temperature}
              onChange={e => setTemperature(e.target.value)}
            />
            <Input
              label="Max Tokens"
              type="number"
              min="1"
              value={maxTokens}
              onChange={e => setMaxTokens(e.target.value)}
            />
            <Input
              label="Timeout (s)"
              type="number"
              min="1"
              value={timeout}
              onChange={e => setTimeout_(e.target.value)}
            />
            <Input
              label="Max Retries"
              type="number"
              min="0"
              max="10"
              value={maxRetries}
              onChange={e => setMaxRetries(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</Button>
            <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
          </div>
          {save.isError && (
            <p className="text-caption text-danger">Save failed -- check console</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-sm bg-surface-elevated border border-border-subtle px-3 py-2">
            <p className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-content-tertiary mb-0.5">
              <Thermometer size={10} /> Temperature
            </p>
            <p className="text-compact font-semibold text-content-primary">{String(agent.temperature)}</p>
          </div>
          <div className="rounded-sm bg-surface-elevated border border-border-subtle px-3 py-2">
            <p className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-content-tertiary mb-0.5">
              <Hash size={10} /> Max Tokens
            </p>
            <p className="text-compact font-semibold text-content-primary">{agent.max_tokens.toLocaleString()}</p>
          </div>
          <div className="rounded-sm bg-surface-elevated border border-border-subtle px-3 py-2">
            <p className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-content-tertiary mb-0.5">
              <Clock size={10} /> Timeout
            </p>
            <p className="text-compact font-semibold text-content-primary">{agent.timeout_seconds}s</p>
          </div>
          <div className="rounded-sm bg-surface-elevated border border-border-subtle px-3 py-2">
            <p className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-content-tertiary mb-0.5">
              <RotateCw size={10} /> Max Retries
            </p>
            <p className="text-compact font-semibold text-content-primary">{String(agent.max_retries)}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Agent tool settings ──────────────────────────────────────────────────────

function AgentToolSettings({ agent, podId }: { agent: PodAgent; podId: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [tools, setTools] = useState<string[] | null>(agent.allowed_tools)

  const save = useMutation({
    mutationFn: () => updatePodAgent(podId, agent.id, {
      name: agent.name, role: agent.role, enabled: agent.enabled,
      position: agent.position, model: agent.model ?? undefined,
      fallback_models: agent.fallback_models,
      temperature: agent.temperature, max_tokens: agent.max_tokens,
      timeout_seconds: agent.timeout_seconds, max_retries: agent.max_retries,
      system_prompt: agent.system_prompt ?? undefined,
      on_failure: agent.on_failure, run_condition: agent.run_condition,
      artifact_type: agent.artifact_type ?? undefined,
      parallel_group: agent.parallel_group ?? undefined,
      allowed_tools: tools,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] })
      setEditing(false)
    },
  })

  const cancel = () => {
    setTools(agent.allowed_tools)
    setEditing(false)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-caption font-medium text-content-tertiary">
          <Wrench size={12} /> Tools
        </p>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3 rounded-sm border border-border-subtle bg-surface-elevated p-4">
          <ToolPicker selectedTools={tools} onChange={setTools} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</Button>
            <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
          </div>
          {save.isError && (
            <p className="text-caption text-danger">Save failed -- check console</p>
          )}
        </div>
      ) : (
        <p className="text-caption text-content-tertiary">
          {agent.allowed_tools
            ? <>{agent.allowed_tools.length} tool{agent.allowed_tools.length !== 1 ? 's' : ''} allowed</>
            : <span className="italic">All tools allowed (no restriction)</span>
          }
        </p>
      )}
    </div>
  )
}

// ── Pod model picker (primary + fallbacks) ──────────────────────────────────

function PodModelPicker({
  primaryModel, fallbackModels, onChange, podDefaultModel,
}: {
  primaryModel: string | null
  fallbackModels: string[]
  onChange: (primary: string | null, fallbacks: string[]) => void
  podDefaultModel?: string | null
}) {
  const [addingFallback, setAddingFallback] = useState(false)

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })
  const allModelIds = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => m.id))

  const available = allModelIds.filter(
    id => id !== primaryModel && !fallbackModels.includes(id),
  )

  const removeFallback = (idx: number) =>
    onChange(primaryModel, fallbackModels.filter((_, i) => i !== idx))

  const moveUp = (idx: number) => {
    if (idx === 0) return
    const next = [...fallbackModels]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    onChange(primaryModel, next)
  }

  const moveDown = (idx: number) => {
    if (idx === fallbackModels.length - 1) return
    const next = [...fallbackModels]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    onChange(primaryModel, next)
  }

  const inheritLabel = podDefaultModel
    ? `Inherit from pod (${podDefaultModel.split('/').pop()})`
    : 'Inherit from pod / service default'

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-content-tertiary">
          Primary model
        </label>
        <select
          value={primaryModel ?? ''}
          onChange={e => onChange(e.target.value || null, fallbackModels)}
          className="w-full rounded-md border border-border-subtle bg-surface-input px-3 py-1.5 text-xs text-content-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent-500/40"
        >
          <option value="">{inheritLabel}</option>
          {allModelIds.map(id => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-content-tertiary">
          Fallback models{' '}
          <span className="normal-case text-content-quaternary">(tried in order on failure)</span>
        </label>

        {fallbackModels.length === 0 && !addingFallback && (
          <p className="mb-1.5 text-[11px] italic text-content-tertiary">
            No fallbacks — task will fail if primary model is unavailable
          </p>
        )}

        <div className="space-y-1">
          {fallbackModels.map((fb, i) => (
            <div
              key={fb}
              className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-card px-2 py-1"
            >
              <span className="w-4 shrink-0 text-center text-[10px] font-semibold text-content-tertiary">
                {i + 1}
              </span>
              <span className="flex-1 truncate font-mono text-xs text-content-primary">{fb}</span>
              <button onClick={() => moveUp(i)} disabled={i === 0} title="Move up"
                className="rounded p-0.5 text-content-tertiary hover:text-content-primary disabled:opacity-20">
                <ArrowUp size={11} />
              </button>
              <button onClick={() => moveDown(i)} disabled={i === fallbackModels.length - 1} title="Move down"
                className="rounded p-0.5 text-content-tertiary hover:text-content-primary disabled:opacity-20">
                <ArrowDown size={11} />
              </button>
              <button onClick={() => removeFallback(i)} title="Remove"
                className="rounded p-0.5 text-content-tertiary hover:text-danger">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        {addingFallback ? (
          <select
            className="mt-1.5 w-full rounded-md border border-accent bg-surface-card px-3 py-1.5 text-xs text-content-primary outline-none ring-2 ring-accent-500/40"
            defaultValue=""
            autoFocus
            onBlur={() => setAddingFallback(false)}
            onChange={e => {
              if (e.target.value) onChange(primaryModel, [...fallbackModels, e.target.value])
              setAddingFallback(false)
            }}
          >
            <option value="">Select a fallback model...</option>
            {available.map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        ) : available.length > 0 ? (
          <button onClick={() => setAddingFallback(true)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-accent hover:text-accent-600">
            <Plus size={11} /> Add fallback
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Agent model picker ───────────────────────────────────────────────────────

function AgentModelPicker({
  agent, podId, podDefaultModel,
}: {
  agent: PodAgent
  podId: string
  podDefaultModel?: string | null
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [primary, setPrimary] = useState<string | null>(agent.model ?? null)
  const [fallbacks, setFallbacks] = useState<string[]>(agent.fallback_models ?? [])

  const hasChanges =
    primary !== (agent.model ?? null) ||
    JSON.stringify(fallbacks) !== JSON.stringify(agent.fallback_models ?? [])

  const save = useMutation({
    mutationFn: () => updatePodAgent(podId, agent.id, {
      name: agent.name, role: agent.role, enabled: agent.enabled,
      position: agent.position, temperature: agent.temperature,
      max_tokens: agent.max_tokens, timeout_seconds: agent.timeout_seconds,
      max_retries: agent.max_retries,
      system_prompt: agent.system_prompt ?? undefined,
      allowed_tools: agent.allowed_tools ?? undefined,
      on_failure: agent.on_failure, run_condition: agent.run_condition,
      artifact_type: agent.artifact_type ?? undefined,
      parallel_group: agent.parallel_group ?? undefined,
      model: primary ?? undefined,
      fallback_models: fallbacks,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] })
      setEditing(false)
    },
  })

  const cancel = () => {
    setPrimary(agent.model ?? null)
    setFallbacks(agent.fallback_models ?? [])
    setEditing(false)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-caption font-medium text-content-tertiary">
          <Cpu size={12} /> Model
        </p>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <PodModelPicker
            primaryModel={primary}
            fallbackModels={fallbacks}
            onChange={(p, f) => { setPrimary(p); setFallbacks(f) }}
            podDefaultModel={podDefaultModel}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</Button>
            <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!hasChanges}>Save</Button>
          </div>
          {save.isError && (
            <p className="text-caption text-danger">Save failed -- check console</p>
          )}
        </div>
      ) : (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-caption">
            <span className="text-content-tertiary">Primary:</span>
            {agent.model ? (
              <span className="font-mono text-content-primary">{agent.model}</span>
            ) : (
              <span className="italic text-content-tertiary">
                inherit{podDefaultModel ? ` (${podDefaultModel.split('/').pop()})` : ''}
              </span>
            )}
          </div>
          {(agent.fallback_models ?? []).length > 0 ? (
            <p className="text-caption text-content-tertiary">
              Fallbacks:{' '}
              <span className="font-mono">{(agent.fallback_models ?? []).join(' \u2192 ')}</span>
            </p>
          ) : (
            <p className="text-caption italic text-content-tertiary">No fallbacks configured</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Pod sandbox selector ─────────────────────────────────────────────────────

const SANDBOX_TIERS = [
  { value: 'workspace', label: 'workspace' },
  { value: 'home', label: 'home' },
  { value: 'root', label: 'root' },
  { value: 'isolated', label: 'isolated' },
]

const SANDBOX_DESCRIPTIONS: Record<string, string> = {
  workspace: 'Paths scoped to workspace directory',
  home:      'Paths scoped to home directory',
  root:      'Full host filesystem access',
  isolated:  'No filesystem or shell access',
}

function PodSandbox({ pod }: { pod: Pod }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (sandbox: string) => updatePod(pod.id, { ...pod, sandbox }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pods'] })
      qc.invalidateQueries({ queryKey: ['pod', pod.id] })
    },
  })

  return (
    <div className="flex items-center gap-2.5 rounded-sm border border-border-subtle bg-surface-elevated px-3 py-2">
      <Shield size={13} className="shrink-0 text-content-tertiary" />
      <div className="min-w-0 flex-1">
        <p className="text-micro font-medium uppercase tracking-wider text-content-tertiary">Sandbox</p>
        <p className="text-micro text-content-tertiary truncate">{SANDBOX_DESCRIPTIONS[pod.sandbox] ?? ''}</p>
      </div>
      <div className="w-36 shrink-0">
        <Select
          value={pod.sandbox ?? 'workspace'}
          onChange={e => save.mutate(e.target.value)}
          disabled={save.isPending}
          items={SANDBOX_TIERS}
        />
      </div>
      {save.isPending && <Loader2 size={12} className="animate-spin text-content-tertiary" />}
    </div>
  )
}

// ── Pod detail (expanded) ────────────────────────────────────────────────────

function PodDetail({ podId }: { podId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pod', podId],
    queryFn: () => getPod(podId),
    staleTime: 10_000,
  })

  if (isLoading) return (
    <div className="space-y-2 pl-4 pt-3">
      <Skeleton lines={3} />
    </div>
  )

  if (isError || !data) return (
    <p className="py-4 pl-4 text-caption text-danger">Failed to load agents</p>
  )

  const agents = data.agents ?? []

  if (agents.length === 0) return (
    <p className="py-4 pl-4 text-caption text-content-tertiary">No agents configured in this pod.</p>
  )

  return (
    <div className="mt-3 space-y-2 pl-2 pt-2 border-t border-border-subtle">
      {agents
        .sort((a, b) => a.position - b.position)
        .map(agent => (
          <AgentRow
            key={agent.id}
            agent={agent}
            podId={podId}
            podDefaultModel={data.default_model ?? null}
          />
        ))}
    </div>
  )
}

// ── Pod card ─────────────────────────────────────────────────────────────────

const REVIEW_LABELS: Record<string, string> = {
  always:         'Always',
  never:          'Never',
  on_escalation:  'On Escalation',
}

const REVIEW_TOOLTIPS: Record<string, string> = {
  on_escalation: 'Human review is requested when the guardrail agent flags concerns.',
  never:         'Tasks complete without human review.',
}

function PodCard({ pod, onDelete }: { pod: Pod; onDelete: (pod: Pod) => void }) {
  const [expanded, setExpanded] = useState(false)
  const qc = useQueryClient()

  const toggleEnabled = useMutation({
    mutationFn: () => updatePod(pod.id, { ...pod, enabled: !pod.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pods'] })
    },
  })

  // Get agent statuses for pipeline visualization
  const { data: podDetail } = useQuery({
    queryKey: ['pod', pod.id],
    queryFn: () => getPod(pod.id),
    staleTime: 30_000,
  })

  const agents = podDetail?.agents ?? []
  const pipelineStatuses = agentPipelineStatuses(agents)

  return (
    <Card variant="default" className={clsx(!pod.enabled && 'opacity-60', pod.enabled && 'border-l-2 border-l-accent')}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex shrink-0 items-center gap-3 min-w-0 flex-1 text-left"
        >
          <span className="shrink-0 text-content-tertiary">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>

          <StatusDot status={pod.enabled ? 'success' : 'neutral'} />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-compact font-semibold text-content-primary">{pod.name}</span>
              {!pod.enabled && (
                <Badge color="neutral" size="sm">disabled</Badge>
              )}
            </div>
            {pod.description && (
              <p className="truncate text-caption text-content-secondary mt-0.5">{pod.description}</p>
            )}
          </div>
        </button>

        {/* Pipeline stages indicator */}
        <Tooltip content="Pipeline stages: Context, Task, Guardrail, Code Review, Decision">
          <PipelineStages stages={pipelineStatuses} compact className="hidden sm:inline-flex" />
        </Tooltip>

        {/* Agent count */}
        <Badge color="neutral" size="sm">
          <Layers size={10} className="mr-0.5" />
          {pod.active_agent_count ?? 0}
        </Badge>

        {/* Model */}
        {pod.default_model && (
          <Badge color="accent" size="sm" className="hidden sm:inline-flex">
            {pod.default_model.split('/').pop()}
          </Badge>
        )}

        {/* Review setting */}
        {REVIEW_TOOLTIPS[pod.require_human_review] ? (
          <Tooltip content={REVIEW_TOOLTIPS[pod.require_human_review]}>
            <span className="hidden text-caption text-content-tertiary sm:inline">
              Review: {REVIEW_LABELS[pod.require_human_review] ?? pod.require_human_review}
            </span>
          </Tooltip>
        ) : (
          <span className="hidden text-caption text-content-tertiary sm:inline">
            Review: {REVIEW_LABELS[pod.require_human_review] ?? pod.require_human_review}
          </span>
        )}

        {/* Routing keywords */}
        {(pod.routing_keywords?.length ?? 0) > 0 && (
          <div className="hidden shrink-0 gap-1 sm:flex">
            {(pod.routing_keywords ?? []).slice(0, 3).map(kw => (
              <Badge key={kw} color="neutral" size="sm">{kw}</Badge>
            ))}
            {(pod.routing_keywords?.length ?? 0) > 3 && (
              <span className="text-micro text-content-tertiary">+{(pod.routing_keywords?.length ?? 0) - 3}</span>
            )}
          </div>
        )}

        {/* Enable/disable toggle */}
        <Toggle
          checked={pod.enabled}
          onChange={() => toggleEnabled.mutate()}
          disabled={toggleEnabled.isPending}
          size="sm"
        />
      </div>

      {/* Expanded pod settings + agent list */}
      {expanded && (
        <div className="px-5 pb-5 space-y-3">
          <PodSandbox pod={pod} />
          <PodDetail podId={pod.id} />
          <div className="flex justify-end pt-2">
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={12} />}
              onClick={() => onDelete(pod)}
            >
              Delete Pod
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Create pod modal ─────────────────────────────────────────────────────────

function CreatePodModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const create = useMutation({
    mutationFn: () => createPod({ name, description, enabled: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pods'] })
      setName('')
      setDescription('')
      onClose()
    },
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Pod"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
            Create Pod
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Pod Name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Research Agent"
          autoFocus
        />
        <Input
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this pod does..."
        />
        {create.isError && (
          <p className="text-caption text-danger">Failed to create pod</p>
        )}
      </div>
    </Modal>
  )
}

// ── Help entries ─────────────────────────────────────────────────────────────

const HELP_ENTRIES = [
  { term: 'Pod', definition: 'An isolated pipeline configuration — each pod defines which AI models and settings are used for each stage of task execution.' },
  { term: 'Agent Role', definition: 'Each pod has 5 agents: Context (gathers info), Task (does the work), Guardrail (safety check), Code Review (quality check), Decision (pass/fail).' },
  { term: 'Sandbox Tier', definition: "How isolated the agent's execution environment is — from 'isolated' (most restricted) to 'root' (full system access)." },
  { term: 'Routing Keywords', definition: "Terms that trigger this pod — when a task matches these keywords, it's routed to this pod's pipeline." },
  { term: 'Fallback Models', definition: 'Secondary AI models used if the primary model is unavailable or rate-limited.' },
  { term: 'On Failure', definition: 'What happens when an agent crashes — abort (task fails) or skip (continue without it). Crashes never go to human review; only quality escalations do.' },
]

// ── Main page ────────────────────────────────────────────────────────────────

export function Pods() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingPod, setDeletingPod] = useState<Pod | null>(null)

  const { data: pods = [], isLoading, isFetching, isError } = useQuery({
    queryKey: ['pods'],
    queryFn: getPods,
    staleTime: 15_000,
  })

  const removePod = useMutation({
    mutationFn: (podId: string) => deletePod(podId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pods'] })
      setDeletingPod(null)
    },
  })

  const enabled  = pods.filter(p => p.enabled)
  const disabled = pods.filter(p => !p.enabled)

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6">
      <PageHeader
        title="Pods"
        description="Inspect and configure agent pipeline pods."
        helpEntries={HELP_ENTRIES}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />}
              onClick={() => qc.invalidateQueries({ queryKey: ['pods'] })}
              disabled={isFetching}
            />
            <Button
              icon={<Plus size={14} />}
              onClick={() => setCreateOpen(true)}
            >
              New Pod
            </Button>
          </div>
        }
      />

      {/* Summary strip */}
      <div className="flex flex-wrap gap-6">
        <Metric label="Total Pods" value={pods.length} icon={<Layers size={12} />} />
        <Metric label="Enabled" value={enabled.length} />
        <Metric label="Disabled" value={disabled.length} />
      </div>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton variant="rect" height="80px" />
          <Skeleton variant="rect" height="80px" />
        </div>
      )}

      {isError && (
        <Card variant="outlined" className="p-4">
          <p className="text-compact text-danger">
            Failed to load pods -- check your admin secret and API connectivity.
          </p>
        </Card>
      )}

      {/* Enabled pods */}
      {enabled.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-micro font-semibold uppercase tracking-wider text-content-tertiary">Active Pods</h2>
          <p className="text-caption text-content-tertiary">Pods currently receiving routed tasks from the orchestrator.</p>
          {enabled.map(pod => <PodCard key={pod.id} pod={pod} onDelete={setDeletingPod} />)}
        </div>
      )}

      {/* Disabled pods */}
      {disabled.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-micro font-semibold uppercase tracking-wider text-content-tertiary">Disabled Pods</h2>
          <p className="text-caption text-content-tertiary">Inactive pods that won't receive tasks until re-enabled.</p>
          {disabled.map(pod => <PodCard key={pod.id} pod={pod} onDelete={setDeletingPod} />)}
        </div>
      )}

      {!isLoading && pods.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No pods found"
          description="Pods are created via the orchestrator API or by clicking New Pod above."
          action={{ label: 'Create Pod', onClick: () => setCreateOpen(true) }}
        />
      )}

      {/* Create modal */}
      <CreatePodModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deletingPod}
        onClose={() => setDeletingPod(null)}
        title="Delete Pod"
        description={`Are you sure you want to delete "${deletingPod?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deletingPod && removePod.mutate(deletingPod.id)}
        destructive
        confirmText={deletingPod?.name}
      />
    </div>
  )
}
