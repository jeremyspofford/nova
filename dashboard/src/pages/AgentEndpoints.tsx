import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Pencil, ChevronDown, ChevronRight, ExternalLink, Globe } from 'lucide-react'
import {
  getAgentEndpoints,
  createAgentEndpoint,
  updateAgentEndpoint,
  deleteAgentEndpoint,
  type AgentEndpoint,
  type AgentEndpointWrite,
} from '../api'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Card, Button, Input, Textarea, Label, Select, Badge, StatusDot,
  Toggle, ConfirmDialog, EmptyState,
} from '../components/ui'

// ── Form ──────────────────────────────────────────────────────────────────────

const PROTOCOLS = ['a2a', 'acp', 'generic'] as const

const EMPTY_FORM: Omit<AgentEndpointWrite, 'input_schema' | 'output_schema' | 'metadata'> & {
  input_schema: string
  output_schema: string
} = {
  name: '',
  description: '',
  url: '',
  auth_token: '',
  protocol: 'a2a',
  input_schema: '',
  output_schema: '',
  enabled: true,
}

type ProtocolBadgeColor = 'info' | 'accent' | 'neutral'

const PROTOCOL_COLORS: Record<string, ProtocolBadgeColor> = {
  a2a: 'info',
  acp: 'accent',
  generic: 'neutral',
}

function EndpointForm({
  initial,
  endpointId,
  onDone,
  title = 'New Agent Endpoint',
}: {
  initial?: typeof EMPTY_FORM
  endpointId?: string
  onDone: () => void
  title?: string
}) {
  const [form, setForm] = useState(initial ?? EMPTY_FORM)
  const [schemaError, setSchemaError] = useState('')

  const mutation = useMutation({
    mutationFn: (data: Partial<AgentEndpointWrite>) =>
      endpointId ? updateAgentEndpoint(endpointId, data) : createAgentEndpoint(data),
    onSuccess: onDone,
  })

  const set = (key: string, value: unknown) =>
    setForm(f => ({ ...f, [key]: value }))

  const handleSubmit = () => {
    setSchemaError('')
    let input_schema: Record<string, unknown> = {}
    let output_schema: Record<string, unknown> = {}
    if (form.input_schema.trim()) {
      try { input_schema = JSON.parse(form.input_schema) } catch {
        setSchemaError('Input schema is not valid JSON')
        return
      }
    }
    if (form.output_schema.trim()) {
      try { output_schema = JSON.parse(form.output_schema) } catch {
        setSchemaError('Output schema is not valid JSON')
        return
      }
    }
    const payload: Partial<AgentEndpointWrite> = {
      name: form.name.trim(),
      description: form.description.trim(),
      url: form.url.trim(),
      protocol: form.protocol,
      input_schema,
      output_schema,
      enabled: form.enabled,
      metadata: {},
    }
    if (form.auth_token?.trim()) payload.auth_token = form.auth_token.trim()
    mutation.mutate(payload)
  }

  const isValid = form.name.trim() && form.url.trim()

  return (
    <Card className="p-5 space-y-4">
      <p className="text-caption font-medium text-content-tertiary uppercase tracking-wider">
        {title}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Name *</Label>
          <Input
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="e.g. coding-agent, research-bot"
          />
        </div>
        <div>
          <Label>Protocol</Label>
          <Select
            value={form.protocol}
            onChange={e => set('protocol', e.target.value)}
          >
            {PROTOCOLS.map(p => (
              <option key={p} value={p}>{p.toUpperCase()}</option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label>Base URL *</Label>
        <Input
          value={form.url}
          onChange={e => set('url', e.target.value)}
          placeholder="https://agent.example.com"
        />
      </div>

      <div>
        <Label>Description</Label>
        <Input
          value={form.description}
          onChange={e => set('description', e.target.value)}
          placeholder="What does this agent do?"
        />
      </div>

      <div>
        <Label>
          Auth Token <span className="text-content-tertiary">(sent as Bearer -- leave blank to clear)</span>
        </Label>
        <Input
          type="password"
          value={form.auth_token ?? ''}
          onChange={e => set('auth_token', e.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>
            Input Schema <span className="text-content-tertiary">(JSON, optional)</span>
          </Label>
          <Textarea
            value={form.input_schema}
            onChange={e => set('input_schema', e.target.value)}
            rows={3}
            placeholder='{"type":"object","properties":{"task":{"type":"string"}}}'
            className="text-mono-sm font-mono"
          />
        </div>
        <div>
          <Label>
            Output Schema <span className="text-content-tertiary">(JSON, optional)</span>
          </Label>
          <Textarea
            value={form.output_schema}
            onChange={e => set('output_schema', e.target.value)}
            rows={3}
            placeholder='{"type":"object","properties":{"result":{"type":"string"}}}'
            className="text-mono-sm font-mono"
          />
        </div>
      </div>

      {schemaError && (
        <p className="text-caption text-danger">{schemaError}</p>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <Toggle
          checked={form.enabled}
          onChange={(checked) => set('enabled', checked)}
          label="Enable endpoint"
          size="sm"
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button
            icon={<Plus size={13} />}
            onClick={handleSubmit}
            disabled={!isValid}
            loading={mutation.isPending}
          >
            {endpointId ? 'Save Changes' : 'Add Endpoint'}
          </Button>
        </div>
      </div>

      {mutation.isError && (
        <p className="text-caption text-danger">{String(mutation.error)}</p>
      )}
    </Card>
  )
}

// ── Endpoint card ─────────────────────────────────────────────────────────────

function EndpointCard({
  endpoint,
  onDelete,
}: {
  endpoint: AgentEndpoint
  onDelete: () => void
}) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const initial = {
    name: endpoint.name,
    description: endpoint.description,
    url: endpoint.url,
    auth_token: '',
    protocol: endpoint.protocol as typeof PROTOCOLS[number],
    input_schema: Object.keys(endpoint.input_schema).length
      ? JSON.stringify(endpoint.input_schema, null, 2)
      : '',
    output_schema: Object.keys(endpoint.output_schema).length
      ? JSON.stringify(endpoint.output_schema, null, 2)
      : '',
    enabled: endpoint.enabled,
  }

  const handleEditDone = () => {
    setEditing(false)
    qc.invalidateQueries({ queryKey: ['agent-endpoints'] })
  }

  return (
    <Card className="overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-card-hover transition-colors"
        onClick={() => !editing && setExpanded(v => !v)}
      >
        <StatusDot status={endpoint.enabled ? 'success' : 'neutral'} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-compact font-medium text-content-primary">
              {endpoint.name}
            </span>
            <Badge color={PROTOCOL_COLORS[endpoint.protocol] ?? 'neutral'}>
              {endpoint.protocol.toUpperCase()}
            </Badge>
            {!endpoint.enabled && (
              <Badge color="neutral" size="sm">disabled</Badge>
            )}
          </div>
          {endpoint.description && (
            <p className="mt-0.5 text-caption text-content-tertiary truncate">
              {endpoint.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-2" onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            icon={<Pencil size={13} />}
            onClick={() => { setEditing(v => !v); setExpanded(false) }}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={onDelete}
            className="text-content-tertiary hover:text-danger"
          />
        </div>

        {!editing && (
          <div className="text-content-tertiary">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        )}
      </div>

      {editing && (
        <div className="border-t border-border-subtle bg-surface-elevated/50 p-4">
          <EndpointForm
            initial={initial}
            endpointId={endpoint.id}
            onDone={handleEditDone}
            title="Edit Agent Endpoint"
          />
        </div>
      )}

      {expanded && !editing && (
        <div className="border-t border-border-subtle bg-surface-elevated px-4 py-3 space-y-2">
          <div className="text-caption flex items-center gap-1">
            <span className="text-content-tertiary">URL:</span>
            <code className="min-w-0 flex-1 text-content-secondary font-mono text-mono-sm truncate">{endpoint.url}</code>
            <a
              href={endpoint.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="shrink-0 text-content-tertiary hover:text-accent"
              title="Open URL"
            >
              <ExternalLink size={11} />
            </a>
          </div>
          <div className="text-caption">
            <span className="text-content-tertiary mr-1">Added:</span>
            <span className="text-content-secondary">
              {new Date(endpoint.created_at).toLocaleString()}
            </span>
          </div>
          {Object.keys(endpoint.input_schema).length > 0 && (
            <div className="text-caption">
              <span className="text-content-tertiary mr-1">Input schema:</span>
              <code className="text-content-secondary font-mono text-mono-sm">
                {JSON.stringify(endpoint.input_schema)}
              </code>
            </div>
          )}
          {Object.keys(endpoint.output_schema).length > 0 && (
            <div className="text-caption">
              <span className="text-content-tertiary mr-1">Output schema:</span>
              <code className="text-content-secondary font-mono text-mono-sm">
                {JSON.stringify(endpoint.output_schema)}
              </code>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Agent endpoints content (shared between standalone page and Integrations tab) ──

export function AgentEndpointsContent() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [deleteTarget, setDeleteTarget] = useState<AgentEndpoint | null>(null)

  const { data: endpoints = [], isLoading, error } = useQuery({
    queryKey: ['agent-endpoints'],
    queryFn: getAgentEndpoints,
    refetchInterval: 30_000,
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAgentEndpoint,
    onSuccess: () => {
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['agent-endpoints'] })
    },
  })

  const handleFormDone = () => {
    setShowForm(false)
    qc.invalidateQueries({ queryKey: ['agent-endpoints'] })
  }

  return (
    <div className="space-y-5">
      {/* Actions */}
      <div className="flex items-center justify-between">
        <div />
        <Button
          icon={<Plus size={14} />}
          onClick={() => {
            setFormKey(k => k + 1)
            setShowForm(v => !v)
          }}
        >
          {showForm ? 'Cancel' : 'Add Endpoint'}
        </Button>
      </div>

      {showForm && (
        <EndpointForm key={formKey} onDone={handleFormDone} />
      )}

      {isLoading && <Card className="p-8"><p className="text-compact text-content-tertiary text-center">Loading...</p></Card>}
      {error && <Card className="p-4"><p className="text-compact text-danger">{String(error)}</p></Card>}

      <div className="space-y-3">
        {endpoints.map(ep => (
          <EndpointCard
            key={ep.id}
            endpoint={ep}
            onDelete={() => setDeleteTarget(ep)}
          />
        ))}

        {endpoints.length === 0 && !isLoading && (
          <Card className="py-8">
            <EmptyState
              icon={Globe}
              title="No agent endpoints registered"
              description="Add an A2A or ACP endpoint to delegate tasks to external agent systems."
              action={{ label: 'Add Endpoint', onClick: () => { setFormKey(k => k + 1); setShowForm(true) } }}
            />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove Agent Endpoint"
        description={`Remove "${deleteTarget?.name}"? Nova will no longer be able to delegate tasks to this endpoint.`}
        confirmLabel="Remove"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        destructive
      />
    </div>
  )
}

// ── Agent Endpoints page (standalone) ────────────────────────────────────────

export function AgentEndpoints() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Endpoints"
        description="Connect Nova to external agent systems using A2A (Google Agent-to-Agent) or ACP (BeeAI Agent Communication Protocol)."
      />
      <AgentEndpointsContent />
    </div>
  )
}
