import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Server } from 'lucide-react'
import {
  Badge, Button, Card, Input, Label, Select, StatusDot, Toggle,
} from '../../components/ui'
import {
  getBackendPool,
  upsertBackend,
  deleteBackend,
  type BackendPoolEntry,
} from '../../api'

const ENGINE_OPTIONS = [
  { value: 'ollama',   label: 'Ollama' },
  { value: 'vllm',     label: 'vLLM' },
  { value: 'sglang',   label: 'SGLang' },
  { value: 'llamacpp', label: 'llama.cpp' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openai',   label: 'OpenAI-compatible' },
] as const

const DEFAULT_FORM = {
  id: '',
  engine: 'ollama' as BackendPoolEntry['engine'],
  url: '',
  auth_header: '',
}

/** The backend pool: every named local-inference backend the gateway routes
 *  over — bundled containers (managed by start/stop above) plus user-named
 *  remote servers. First enabled entry is the primary (default target). */
export function BackendPoolCard() {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState<string | null>(null)

  const { data: entries = [], isLoading } = useQuery<BackendPoolEntry[]>({
    queryKey: ['backend-pool'],
    queryFn: getBackendPool,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: 1,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['backend-pool'] })
    queryClient.invalidateQueries({ queryKey: ['local-models'] })
  }

  const upsert = useMutation({
    mutationFn: ({ id, ...body }: BackendPoolEntry) =>
      upsertBackend(id, {
        kind: body.kind, engine: body.engine, url: body.url,
        enabled: body.enabled, auth_header: body.auth_header,
      }),
    onMutate: () => setError(null),
    onError: e => setError(e instanceof Error ? e.message : 'Save failed'),
    onSuccess: () => { setShowForm(false); setForm(DEFAULT_FORM) },
    onSettled: invalidate,
  })

  const remove = useMutation({
    mutationFn: deleteBackend,
    onMutate: () => setError(null),
    onError: e => setError(e instanceof Error ? e.message : 'Delete failed'),
    onSettled: invalidate,
  })

  const addValid = form.id.trim() && form.url.trim()

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={14} className="text-content-tertiary" />
          <span className="text-compact font-medium text-content-primary">Backend pool</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={12} />}
          onClick={() => { setShowForm(v => !v); setForm(DEFAULT_FORM) }}
        >
          {showForm ? 'Cancel' : 'Add remote'}
        </Button>
      </div>
      <p className="text-caption text-content-tertiary">
        Every named backend the gateway can route local inference to. Requests go to the
        backend whose catalog serves the requested model; the first enabled entry is the
        primary fallback. Containers are managed by the bundled controls; remotes are servers
        you run yourself.
      </p>

      {showForm && (
        <div className="rounded-lg border border-border-subtle bg-surface-elevated p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Name *</Label>
              <Input
                value={form.id}
                onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                placeholder="e.g. remote-vllm-a"
                className="font-mono text-caption"
              />
            </div>
            <div>
              <Label>Engine</Label>
              <Select
                value={form.engine}
                onChange={e => setForm(f => ({ ...f, engine: e.target.value as BackendPoolEntry['engine'] }))}
              >
                {ENGINE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>URL *</Label>
              <Input
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="http://192.168.1.50:8000"
                className="font-mono text-caption"
              />
            </div>
            <div>
              <Label>Authorization header <span className="text-content-tertiary">(optional)</span></Label>
              <Input
                value={form.auth_header}
                onChange={e => setForm(f => ({ ...f, auth_header: e.target.value }))}
                placeholder="Bearer sk-..."
                type="password"
                className="font-mono text-caption"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              icon={<Plus size={12} />}
              disabled={!addValid}
              loading={upsert.isPending}
              onClick={() => upsert.mutate({
                id: form.id.trim(), kind: 'remote', engine: form.engine,
                url: form.url.trim(), enabled: true,
                auth_header: form.auth_header.trim(),
              })}
            >
              Add backend
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {entries.map(entry => (
          <div
            key={entry.id}
            className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2"
          >
            <StatusDot status={entry.available ? 'success' : entry.enabled ? 'danger' : 'neutral'} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-compact font-medium text-content-primary">{entry.id}</span>
                <Badge color="neutral" size="sm">{entry.engine}</Badge>
                <Badge color="neutral" size="sm">{entry.kind}</Badge>
                {entry.is_primary && <Badge color="accent" size="sm">primary</Badge>}
                {(entry.model_count ?? 0) > 0 && (
                  <Badge color="success" size="sm">{entry.model_count} models</Badge>
                )}
              </div>
              <p className="mt-0.5 text-caption text-content-tertiary font-mono truncate">{entry.url}</p>
            </div>
            <Toggle
              size="sm"
              checked={entry.enabled}
              disabled={upsert.isPending}
              onChange={enabled => upsert.mutate({ ...entry, enabled })}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => remove.mutate(entry.id)}
              className="text-content-tertiary hover:text-danger"
            />
          </div>
        ))}
        {entries.length === 0 && !isLoading && (
          <p className="text-caption text-content-tertiary text-center py-3">
            Pool is empty — start a bundled container or add a remote server.
          </p>
        )}
      </div>

      {error && <p className="text-caption text-danger">{error}</p>}
    </Card>
  )
}
