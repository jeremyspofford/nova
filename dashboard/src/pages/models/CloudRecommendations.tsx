/**
 * CloudRecommendations — curated cloud model picks with per-Mtok pricing,
 * grouped by job. Cross-references live provider availability: a configured
 * provider's pick is one click into chat; an unconfigured one links to add a
 * key. Prices are curated (no uniform pricing API) and dated.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, Cloud, MessageSquare, KeyRound } from 'lucide-react'
import { getRecommendedCloudModels, type CloudModelRec } from '../../api-recovery'
import { useChatStore } from '../../stores/chat-store'
import { Badge, Button, Card } from '../../components/ui'

const JOBS: { key: string; label: string }[] = [
  { key: 'frontier', label: 'Frontier' },
  { key: 'cheap', label: 'Cheap & fast' },
  { key: 'code', label: 'Code' },
  { key: 'free', label: 'Free tier' },
]

const money = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n % 1 === 0 ? n : n.toFixed(2)}`)

export function CloudRecommendations({ configured }: { configured: Set<string> }) {
  const navigate = useNavigate()
  const { setModelId } = useChatStore()
  const [open, setOpen] = useState(true)

  const { data } = useQuery({
    queryKey: ['cloud-recommendations'],
    queryFn: getRecommendedCloudModels,
    staleTime: 300_000,
  })

  if (!data || data.models.length === 0) return null

  // Curated prices drift; flag when the snapshot is more than ~6 months old (TD-17).
  const monthsOld = (() => {
    const m = /^(\d{4})-(\d{2})$/.exec(data.updated ?? '')
    if (!m) return 0
    const updated = new Date(Number(m[1]), Number(m[2]) - 1, 1)
    return (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24 * 30)
  })()
  const stale = monthsOld > 6

  const use = (m: CloudModelRec) => {
    if (configured.has(m.provider)) {
      setModelId(m.model)
      navigate('/chat')
    } else {
      navigate('/settings#ai-models')
    }
  }

  const byJob = (job: string) => data.models.filter(m => m.job === job)

  return (
    <Card>
      <button
        className={`w-full px-4 py-3 flex items-center justify-between text-left ${open ? 'border-b border-border-subtle' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-content-tertiary" /> : <ChevronRight className="h-4 w-4 text-content-tertiary" />}
          <Cloud className="h-4 w-4 text-info" />
          <h3 className="text-compact font-medium text-content-primary">Recommended cloud models</h3>
        </span>
        {data.updated && (
          <span className={`flex items-center gap-1 font-mono text-micro ${stale ? 'text-warning' : 'text-content-tertiary'}`}>
            {stale && <AlertTriangle className="h-3 w-3" />}
            prices curated · {data.updated}{stale ? ' · may be stale, verify' : ''}
          </span>
        )}
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {JOBS.map(job => {
            const rows = byJob(job.key)
            if (rows.length === 0) return null
            return (
              <div key={job.key}>
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-content-tertiary mb-1.5">
                  {job.label}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {rows.map(m => {
                    const ready = configured.has(m.provider)
                    return (
                      <div
                        key={`${m.provider}:${m.model}:${m.job}`}
                        className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-content-primary truncate">{m.name}</span>
                            <Badge color="neutral" size="sm">{m.provider}</Badge>
                            {m.context && <span className="text-micro text-content-tertiary font-mono">{m.context} ctx</span>}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-caption">
                            {m.free_tier ? (
                              <span className="text-success">free tier</span>
                            ) : (
                              <span className="text-content-secondary">
                                {money(m.input_per_mtok)} in / {money(m.output_per_mtok)} out
                                <span className="text-content-tertiary"> per Mtok</span>
                              </span>
                            )}
                          </div>
                          {m.note && <p className="mt-0.5 text-micro text-content-tertiary leading-tight truncate">{m.note}</p>}
                        </div>
                        <Button
                          variant={ready ? 'ghost' : 'ghost'}
                          size="sm"
                          className={ready ? 'text-accent shrink-0' : 'text-content-tertiary shrink-0'}
                          icon={ready ? <MessageSquare className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
                          onClick={() => use(m)}
                          title={ready ? 'Use this model in chat' : `${m.provider} needs an API key`}
                        >
                          {ready ? 'Use' : 'Add key'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {data.note && (
            <p className="text-micro text-content-tertiary pt-1 border-t border-border-subtle">{data.note}</p>
          )}
        </div>
      )}
    </Card>
  )
}
