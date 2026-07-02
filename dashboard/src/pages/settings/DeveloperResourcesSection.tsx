import { useState, useCallback, Fragment } from 'react'
import { FileCode, ExternalLink, RefreshCw } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getQueueStats, getMCPServers } from '../../api'
import { getAllServiceStatus, restartService, type FullServiceStatus } from '../../api-recovery'
import { Section, Button, StatusDot, Badge } from '../../components/ui'

const SERVICE_META: Record<string, { desc: string; hasDocs?: boolean }> = {
  'postgres':       { desc: 'pgvector-enabled database' },
  'redis':          { desc: 'State, task queue, rate limiting' },
  'orchestrator':   { desc: 'Agent lifecycle, pipeline, task queue', hasDocs: true },
  'llm-gateway':    { desc: 'Multi-provider model routing', hasDocs: true },
  'memory-service': { desc: 'Semantic memory & retrieval', hasDocs: true },
  'chat-api':       { desc: 'WebSocket streaming bridge' },
  'recovery':       { desc: 'Backup, restore, factory reset', hasDocs: true },
  'dashboard':      { desc: 'React admin UI' },
  'website':        { desc: 'Documentation & landing page' },
  'ollama':         { desc: 'Local model serving' },
  'cloudflared':    { desc: 'Cloudflare Tunnel' },
  'tailscale':      { desc: 'Tailscale VPN' },
}

const NO_RESTART = new Set(['postgres', 'redis', 'recovery'])

function docsUrl(port: number): string {
  return `${window.location.protocol}//${window.location.hostname}:${port}/docs`
}

function ServiceStatusDot({ status, health }: { status: string; health: string }) {
  const isUp = status === 'running' && (health === 'healthy' || health === 'none')
  const isStarting = status === 'running' && health === 'starting'
  const notStarted = status === 'not_found'

  const dotStatus = isUp ? 'success' : isStarting ? 'warning' : notStarted ? 'neutral' : 'danger'
  const label = isUp ? 'Healthy' : isStarting ? 'Starting' : notStarted ? 'Not started' : status

  return (
    <div className="flex items-center gap-1.5">
      <StatusDot status={dotStatus} size="sm" />
      <span className="text-caption text-content-tertiary capitalize">{label}</span>
    </div>
  )
}

function ServiceRow({
  svc,
  restartingService,
  onRestart,
}: {
  svc: FullServiceStatus
  restartingService: string | null
  onRestart: (name: string) => void
}) {
  const meta = SERVICE_META[svc.service]
  const port = svc.ports[0]
  const dimmed = svc.optional && svc.status !== 'running'
  const canRestart = !NO_RESTART.has(svc.service) && svc.status === 'running'

  return (
    <tr className={dimmed ? 'opacity-50' : ''}>
      <td className="px-3 py-2 text-compact font-medium text-content-primary">
        {svc.service}
      </td>
      <td className="px-3 py-2 font-mono text-caption text-content-tertiary">
        {port ?? '\u2014'}
      </td>
      <td className="hidden md:table-cell px-3 py-2 text-caption text-content-tertiary">
        {meta?.desc ?? ''}
      </td>
      <td className="px-3 py-2">
        <ServiceStatusDot status={svc.status} health={svc.health} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {canRestart && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRestart(svc.service)}
              loading={restartingService === svc.service}
              icon={<RefreshCw size={11} />}
            >
              Restart
            </Button>
          )}
          {meta?.hasDocs && port && svc.status === 'running' && (
            <a
              href={docsUrl(port)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
            >
              Docs <ExternalLink size={11} />
            </a>
          )}
        </div>
      </td>
    </tr>
  )
}

function SubsystemRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <tr>
      <td className="pl-6 pr-3 py-1 text-caption text-content-tertiary border-l-2 border-border-subtle ml-3">
        <span className="text-content-tertiary mr-1">\u2514</span>
        {label}
      </td>
      <td className="px-3 py-1" />
      <td className="hidden md:table-cell px-3 py-1 text-caption text-content-tertiary">
        {detail}
      </td>
      <td className="px-3 py-1">
        <StatusDot status={ok ? 'success' : 'neutral'} size="sm" />
      </td>
      <td className="px-3 py-1" />
    </tr>
  )
}

export function DeveloperResourcesSection() {
  const qc = useQueryClient()
  const [restartingService, setRestartingService] = useState<string | null>(null)

  const { data: allServices, isLoading } = useQuery({
    queryKey: ['all-service-status'],
    queryFn: getAllServiceStatus,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  const { data: queueStats, isError: queueError } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: getQueueStats,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 1,
  })

  const { data: mcpServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: getMCPServers,
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

  const enabledServers = mcpServers.filter((s: any) => s.enabled)
  const connectedServers = mcpServers.filter((s: any) => s.connected)
  const totalTools = connectedServers.reduce((sum: number, s: any) => sum + (s.tool_count ?? 0), 0)
  const orchestratorOk = !queueError && queueStats !== undefined

  const handleRestart = useCallback(async (svc: string) => {
    setRestartingService(svc)
    try {
      await restartService(svc)
      qc.invalidateQueries({ queryKey: ['all-service-status'] })
      qc.invalidateQueries({ queryKey: ['recovery-services'] })
    } catch { /* silently handled */ }
    setRestartingService(null)
  }, [qc])

  const subsystems = [
    { label: 'Queue Worker', ok: orchestratorOk, detail: queueStats ? `depth ${(queueStats as any).queue_depth}` : undefined },
    { label: 'Reaper', ok: orchestratorOk, detail: 'stale-agent recovery' },
    {
      label: 'MCP Servers',
      ok: enabledServers.length > 0 && connectedServers.length === enabledServers.length,
      detail: enabledServers.length === 0
        ? 'none configured'
        : `${connectedServers.length}/${enabledServers.length} connected \u00b7 ${totalTools} tools`,
    },
  ]

  return (
    <Section
      icon={FileCode}
      title="Developer Resources"
      description="Unified service status, ports, and API documentation. Auto-refreshes every 10 seconds."
    >
      {isLoading ? (
        <p className="text-compact text-content-tertiary">Checking services...</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden text-compact">
          <table className="w-full">
            <thead>
              <tr className="bg-surface-elevated text-content-tertiary text-caption">
                <th className="px-3 py-2 text-left font-medium">Service</th>
                <th className="px-3 py-2 text-left font-medium font-mono">Port</th>
                <th className="hidden md:table-cell px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {(allServices?.core ?? []).map(svc => (
                <Fragment key={svc.service}>
                  <ServiceRow
                    svc={svc}
                    restartingService={restartingService}
                    onRestart={handleRestart}
                  />
                  {svc.service === 'orchestrator' &&
                    subsystems.map(sub => (
                      <SubsystemRow key={sub.label} {...sub} />
                    ))}
                </Fragment>
              ))}

              {(allServices?.optional ?? []).length > 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-1.5 text-micro font-semibold uppercase tracking-wider text-content-tertiary bg-surface-elevated"
                  >
                    Optional Services
                  </td>
                </tr>
              )}

              {(allServices?.optional ?? []).map(svc => (
                <ServiceRow
                  key={svc.service}
                  svc={svc}
                  restartingService={restartingService}
                  onRestart={handleRestart}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
