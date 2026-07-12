/**
 * RepointModal — shown when the operator tries to delete a local model that
 * pods, agents, or config knobs still point at. Nothing in Nova may ever
 * point at a model that doesn't exist, so every reference must be given a
 * replacement before the delete is allowed to run. The server enforces the
 * same rule (409), this dialog is how you satisfy it.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import {
  discoverModels, getAgents, getModelReferences, getPod, getPodAgents,
  patchAgentConfig, updatePlatformConfig, updatePod, updatePodAgent,
  type ModelReference,
} from '../../api'
import { Badge, Button, Modal, Skeleton } from '../../components/ui'
import type { PodAgent } from '../../types'

/** Ollama treats 'x' and 'x:latest' as the same model. */
const normalize = (s: string) => (s.endsWith(':latest') ? s.slice(0, -':latest'.length) : s)
const sameModel = (a: string, b: string) => normalize(a) === normalize(b)

const INHERIT = '__inherit__'

const refKey = (r: ModelReference) =>
  [r.scope, r.pod_id ?? '', r.agent_id ?? '', r.key ?? '', r.field].join('|')

/** Full-payload builder — the PATCH endpoint overwrites every column. */
const agentPayload = (a: PodAgent, changes: Partial<PodAgent>) => ({
  name: a.name, role: a.role, enabled: a.enabled, position: a.position,
  parallel_group: a.parallel_group ?? undefined,
  model: a.model ?? undefined, fallback_models: a.fallback_models ?? [],
  temperature: a.temperature, max_tokens: a.max_tokens,
  timeout_seconds: a.timeout_seconds, max_retries: a.max_retries,
  system_prompt: a.system_prompt ?? undefined,
  allowed_tools: a.allowed_tools ?? undefined, on_failure: a.on_failure,
  run_condition: a.run_condition, artifact_type: a.artifact_type ?? undefined,
  ...changes,
})

const FIELD_LABEL: Record<ModelReference['field'], string> = {
  model: 'primary model',
  fallback_models: 'fallback chain',
  default_model: 'default model',
  value: 'config value',
}

export function RepointModal({
  model, onClose, onRepointed,
}: {
  model: string
  onClose: () => void
  onRepointed: () => void
}) {
  const qc = useQueryClient()
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refs = useQuery({
    queryKey: ['model-references', model],
    queryFn: () => getModelReferences(model),
    staleTime: 0,
  })

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })
  const candidates = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => m.id))
    .filter(id => !sameModel(id, model))

  const references = refs.data?.references ?? []
  const allChosen = references.every(r => !!choices[refKey(r)])

  /** Non-model options vary by slot: a fallback entry can simply be removed;
   * an empty primary/default falls through to the next default; Redis task
   * agents and config knobs need a concrete value (or 'auto'). */
  const emptyOption = (r: ModelReference): { label: string } | null => {
    if (r.field === 'fallback_models') return { label: 'Remove from fallback chain' }
    if (r.scope === 'pod') return { label: 'None — service default' }
    if (r.scope === 'pod_agent') return { label: 'Inherit pod default' }
    return null
  }

  const applyOne = async (ref: ModelReference, choice: string) => {
    const inherit = choice === INHERIT
    const replaceInChain = (chain: string[]) => [...new Set(
      chain.flatMap(m => (sameModel(m, model) ? (inherit ? [] : [choice]) : [m])),
    )]

    if (ref.scope === 'pod_agent' && ref.pod_id && ref.agent_id) {
      const agent = (await getPodAgents(ref.pod_id)).find(a => a.id === ref.agent_id)
      if (!agent) return
      const changes = ref.field === 'model'
        ? { model: inherit ? undefined : choice }
        : { fallback_models: replaceInChain(agent.fallback_models ?? []) }
      await updatePodAgent(ref.pod_id, ref.agent_id, agentPayload(agent, changes))
    } else if (ref.scope === 'pod' && ref.pod_id) {
      const pod = await getPod(ref.pod_id)
      await updatePod(ref.pod_id, { ...pod, default_model: inherit ? null : choice })
    } else if (ref.scope === 'agent' && ref.agent_id) {
      const agent = (await getAgents()).find(a => a.id === ref.agent_id)
      if (!agent) return
      await patchAgentConfig(ref.agent_id, ref.field === 'model'
        ? { model: choice, fallback_models: agent.config.fallback_models ?? [] }
        : { fallback_models: replaceInChain(agent.config.fallback_models ?? []) })
    } else if (ref.scope === 'config' && ref.key) {
      await updatePlatformConfig(ref.key, JSON.stringify(choice))
    }
  }

  const repointAndDelete = async () => {
    setApplying(true)
    setError(null)
    try {
      for (const ref of references) {
        await applyOne(ref, choices[refKey(ref)])
      }
      // Confirm nothing slipped in while the dialog was open — the server
      // would 409 anyway, but re-listing gives a precise error here.
      const still = await getModelReferences(model)
      if (still.count > 0) {
        setChoices({})
        await refs.refetch()
        throw new Error('New assignments appeared while repointing — review the updated list.')
      }
      for (const key of [['pods'], ['pod'], ['agents'], ['model-assignments'], ['platform-config']]) {
        qc.invalidateQueries({ queryKey: key })
      }
      onRepointed()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Still in use: ${model}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
          {references.length > 0 ? (
            <Button
              variant="danger"
              onClick={repointAndDelete}
              loading={applying}
              disabled={!allChosen}
            >
              Repoint & delete
            </Button>
          ) : (
            <Button variant="danger" onClick={onRepointed} disabled={refs.isLoading}>
              Delete model
            </Button>
          )}
        </>
      }
    >
      {refs.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : references.length === 0 ? (
        <p className="text-compact text-content-secondary">
          Nothing points at <span className="font-mono">{model}</span> anymore — it can be deleted.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-compact text-content-secondary">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <p>
              {references.length === 1 ? 'One assignment still points' : `${references.length} assignments still point`} at{' '}
              <span className="font-mono text-content-primary">{model}</span>.
              Nothing may point at a model that doesn't exist — choose a replacement
              for each before it's deleted.
            </p>
          </div>

          <div className="space-y-3">
            {references.map(ref => {
              const key = refKey(ref)
              return (
                <div key={key} className="rounded-md border border-border-subtle p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-compact font-medium text-content-primary">
                      {ref.name}
                    </p>
                    <Badge color="neutral" size="sm">{FIELD_LABEL[ref.field]}</Badge>
                  </div>
                  <select
                    value={choices[key] ?? ''}
                    onChange={e => setChoices(c => ({ ...c, [key]: e.target.value }))}
                    className="w-full rounded-md border border-border-subtle bg-surface-input px-3 py-1.5 text-xs text-content-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent-500/40"
                  >
                    <option value="" disabled>Choose a replacement…</option>
                    {ref.field !== 'fallback_models' && (
                      <option value="auto">auto (resolved at request time)</option>
                    )}
                    {emptyOption(ref) && (
                      <option value={INHERIT}>{emptyOption(ref)!.label}</option>
                    )}
                    {candidates.map(id => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>

          {error && <p className="text-caption text-danger">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
