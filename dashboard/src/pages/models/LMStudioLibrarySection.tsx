import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { HardDrive, Info, AlertTriangle, RefreshCw, Server } from 'lucide-react'
import {
  discoverModels,
  getLMStudioStatus,
  getLMStudioDownloaded,
  loadLMStudioModel,
  unloadLMStudioModel,
} from '../../api'
import type { LMStudioStatus, LMStudioDownloadedModel } from '../../api'
import { LocalModelsTable, type LocalModelRow } from './LocalModelsTable'
import { Badge, Button, Card, EmptyState, Skeleton, StatusDot } from '../../components/ui'

function LMStudioStatusBadge({ status }: { status: LMStudioStatus | undefined }) {
  const healthy = status?.healthy ?? false
  return (
    <Badge color={healthy ? 'success' : 'danger'} size="sm">
      <StatusDot status={healthy ? 'success' : 'danger'} pulse={healthy} />
      {healthy ? 'Connected' : 'Not reachable'}
    </Badge>
  )
}

export function LMStudioLibrarySection({ isActive = false }: { isActive?: boolean }) {
  const qc = useQueryClient()
  const [loadingModels, setLoadingModels] = useState<Set<string>>(new Set())
  const [unloadingModels, setUnloadingModels] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const status = useQuery({
    queryKey: ['lmstudio-status'],
    queryFn: getLMStudioStatus,
    refetchInterval: 10_000,
  })

  const downloaded = useQuery({
    queryKey: ['lmstudio-downloaded'],
    queryFn: () => getLMStudioDownloaded().catch(() => [] as LMStudioDownloadedModel[]),
    refetchInterval: 15_000,
    enabled: status.data?.healthy ?? false,
  })

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['lmstudio-downloaded'] })
    qc.invalidateQueries({ queryKey: ['lmstudio-status'] })
    qc.invalidateQueries({ queryKey: ['model-catalog'] })
    qc.fetchQuery({ queryKey: ['model-catalog'], queryFn: () => discoverModels(true) })
  }

  const loadModel = useMutation({
    mutationFn: (key: string) => loadLMStudioModel(key),
    onMutate: (key) => {
      setError(null)
      setLoadingModels(prev => new Set(prev).add(key))
    },
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => setError(e.message || 'Failed to load model'),
    onSettled: () => setLoadingModels(prev => { const n = new Set(prev); n.clear(); return n }),
  })

  const unloadModel = useMutation({
    mutationFn: (instanceId: string) => unloadLMStudioModel(instanceId),
    onMutate: (instanceId) => {
      setError(null)
      setUnloadingModels(prev => new Set(prev).add(instanceId))
    },
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => setError(e.message || 'Failed to unload model'),
    onSettled: () => setUnloadingModels(prev => { const n = new Set(prev); n.clear(); return n }),
  })

  const healthy = status.data?.healthy ?? false
  const models = downloaded.data ?? []
  const loadedCount = models.filter(m => m.loaded).length

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <HardDrive className="h-5 w-5 text-accent" />
        <h2 className="text-compact font-semibold text-content-primary">LM Studio</h2>
        <Badge color={isActive ? 'success' : 'neutral'} size="sm">
          {isActive ? 'Active — serving Nova' : 'Available'}
        </Badge>
        <LMStudioStatusBadge status={status.data} />
        {models.length > 0 && (
          <span className="font-mono text-caption text-content-tertiary">
            on disk {models.length} · in memory {loadedCount}
          </span>
        )}
      </div>
      {healthy && (
        <p className="text-caption text-content-tertiary flex items-center gap-1.5">
          <Info className="h-3 w-3 shrink-0" />
          Add models: download them in the LM Studio app — they appear here once downloaded.
          (LM Studio has no download API, so Nova loads/unloads them but can't pull them for you.)
        </p>
      )}

      {!healthy && (
        <EmptyState
          icon={Server}
          title="LM Studio is not reachable"
          description="Start LM Studio, open the Developer tab, and click Start Server (default port 1234). Then set inference.lmstudio_url in Settings if it isn't on your host."
          action={{ label: 'Configure in Settings', onClick: () => window.location.hash = '#/settings#local-inference' }}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 text-compact text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {healthy && downloaded.isLoading && (
        <Card><div className="p-4"><Skeleton lines={3} /></div></Card>
      )}

      {healthy && !downloaded.isLoading && models.length === 0 && (
        <Card>
          <div className="px-4 py-6 text-compact text-content-tertiary text-center">
            No models downloaded in LM Studio yet. Download models in the LM Studio app to see them here.
          </div>
        </Card>
      )}

      {models.length > 0 && (() => {
        const rows: LocalModelRow[] = models.map(m => ({
          id: m.key,
          name: m.display_name,
          sizeBytes: m.size_bytes,
          params: m.params_string,
          quant: m.quantization,
          context: m.max_context_length ? `${Math.round(m.max_context_length / 1024)}K` : null,
          caps: [
            ...(m.type === 'embedding' ? ['embed'] : []),
            ...(m.supports_vision ? ['vision'] : []),
            ...(m.supports_tools ? ['tools'] : []),
          ],
          loaded: m.loaded,
        }))
        const instanceOf = new Map(models.map(m => [m.key, m.loaded_instances[0] ?? m.key]))
        return (
          <Card>
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-compact font-medium text-content-primary">Models</h3>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className={`h-3.5 w-3.5 ${downloaded.isFetching ? 'animate-spin' : ''}`} />}
                onClick={() => qc.invalidateQueries({ queryKey: ['lmstudio-downloaded'] })}
              >
                Refresh
              </Button>
            </div>
            <LocalModelsTable
              rows={rows}
              busyIds={new Set([
                ...[...loadingModels],
                ...models.filter(m => unloadingModels.has(m.loaded_instances[0] ?? m.key)).map(m => m.key),
              ])}
              onLoad={(id) => loadModel.mutate(id)}
              onUnload={(id) => unloadModel.mutate(instanceOf.get(id) ?? id)}
              emptyText="No models downloaded in LM Studio yet."
            />
          </Card>
        )
      })()}
    </section>
  )
}
