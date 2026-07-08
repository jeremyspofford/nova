import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Zap, ChevronDown, ChevronRight } from 'lucide-react'
import { getRoutingStats } from '../../api'
import { Badge, Card, Skeleton, Tooltip } from '../../components/ui'

export function RoutingStatsSection() {
  const [open, setOpen] = useState(false)
  const { data: stats, isLoading } = useQuery({
    queryKey: ['routing-stats'],
    queryFn: () => getRoutingStats(),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton variant="rect" height="120px" />
  if (!stats || stats.by_model.length === 0) return null

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-surface-card-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-accent" />
          <span className="text-compact font-semibold text-content-primary">Routing Stats (7d)</span>
          <Tooltip content="Percentage of requests where the primary model failed and a fallback was used.">
            <Badge color={stats.fallback_rate_pct > 20 ? 'warning' : 'success'} size="sm">
              {stats.fallback_rate_pct.toFixed(1)}% fallback
            </Badge>
          </Tooltip>
        </div>
        {open ? <ChevronDown size={14} className="text-content-tertiary" /> : <ChevronRight size={14} className="text-content-tertiary" />}
      </button>
      {open && (
        <div className="px-4 pb-4 overflow-x-auto border-t border-border-subtle pt-3">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-content-tertiary">
                <th className="text-left py-1.5 pr-3 font-medium">Model</th>
                <th className="text-right py-1.5 px-3 font-medium">Requests</th>
                <th className="text-right py-1.5 px-3 font-medium">Avg Tokens</th>
                <th className="text-right py-1.5 px-3 font-medium">Avg Latency</th>
                <th className="text-right py-1.5 pl-3 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {stats.by_model.map(m => (
                <tr key={m.model}>
                  <td className="py-1.5 pr-3 font-mono text-content-primary">{m.model}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{m.requests.toLocaleString()}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{m.avg_tokens.toLocaleString()}</td>
                  <td className="py-1.5 px-3 text-right text-content-secondary">{(m.avg_latency_ms / 1000).toFixed(1)}s</td>
                  <td className="py-1.5 pl-3 text-right font-mono text-content-secondary">${m.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
