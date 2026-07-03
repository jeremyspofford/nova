import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, RefreshCw, Wrench, Zap } from 'lucide-react'
import { apiFetch, reindexMemory } from '../../api'
import { Section, Card, Metric, Button } from '../../components/ui'

// ── Types ────────────────────────────────────────────────────────────────────

interface MemoryStats {
  provider_name: string
  total_items: number
  total_edges: number
  last_ingestion?: string | null
}

// ── MaintenanceSection ───────────────────────────────────────────────────────

export function MaintenanceSection() {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: stats } = useQuery<MemoryStats>({
    queryKey: ['memory-stats'],
    queryFn: () => apiFetch('/mem/api/v1/memory/stats'),
    refetchInterval: 30000,
  })

  const handleReindex = async () => {
    setError(null)
    setRunning(true)
    try {
      const result = await reindexMemory()
      setLastResult(`Reindexed ${result.reindexed ?? 0} file(s)`)
      qc.invalidateQueries({ queryKey: ['memory-stats'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reindex failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Section icon={Wrench} title="Maintenance" description="Rebuild the memory retrieval index. Runs automatically on file changes; use this after bulk-editing memory files by hand.">
      <div className="space-y-6">
        <Card>
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-subtitle font-medium text-content-primary">Rebuild Retrieval Index</h3>
                <p className="text-caption text-content-tertiary mt-0.5">
                  Re-scans every memory file and rebuilds the BM25 index. The index normally
                  self-heals when files change, so this is only needed after unusual bulk edits.
                </p>
              </div>
              <Database size={20} className="text-content-quaternary" />
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={handleReindex}
                disabled={running}
                icon={running ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
              >
                {running ? 'Reindexing...' : 'Reindex Now'}
              </Button>
              {lastResult && !error && (
                <span className="text-sm text-content-tertiary">{lastResult}</span>
              )}
            </div>

            {error && (
              <div className="p-3 rounded-sm bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                {error}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="p-5 space-y-3">
            <h3 className="text-subtitle font-medium text-content-primary">Memory Store</h3>
            <div className="flex gap-6">
              <Metric label="Memory files" value={stats?.total_items ?? '...'} />
              <Metric label="Links" value={stats?.total_edges ?? '...'} />
            </div>
          </div>
        </Card>
      </div>
    </Section>
  )
}
