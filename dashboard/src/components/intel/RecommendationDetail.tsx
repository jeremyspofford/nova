import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Clock, X, ExternalLink } from 'lucide-react'
import { getIntelRecommendation, updateRecommendation } from '../../api'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { DiscussionThread } from '../DiscussionThread'

interface Props {
  id: string
  onStatusChange: (status: string) => void
}

export function RecommendationDetail({ id, onStatusChange }: Props) {
  const qc = useQueryClient()

  const { data: rec, isLoading } = useQuery({
    queryKey: ['intel-recommendation', id],
    queryFn: () => getIntelRecommendation(id),
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) => updateRecommendation(id, { status }),
    onSuccess: (_, status) => {
      qc.invalidateQueries({ queryKey: ['intel-recommendation', id] })
      qc.invalidateQueries({ queryKey: ['intel-recs'] })
      qc.invalidateQueries({ queryKey: ['intel-stats'] })
      onStatusChange(status)
    },
  })

  if (isLoading) {
    return (
      <div className="p-4">
        <Skeleton lines={6} />
      </div>
    )
  }

  if (!rec) {
    return (
      <div className="p-4 text-caption text-content-tertiary">
        Recommendation not found.
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5">
      {/* Summary */}
      <div>
        <p className="text-compact text-content-secondary leading-relaxed">{rec.summary}</p>
      </div>

      {/* Side-by-side: Why Implement + Features */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Why Implement */}
        <div className="p-3 rounded-md bg-surface-elevated">
          <div className="text-caption font-semibold text-content-primary uppercase tracking-wide mb-2">
            Why Implement
          </div>
          <p className="text-caption text-content-secondary leading-relaxed whitespace-pre-wrap">
            {rec.rationale || 'No rationale provided.'}
          </p>
        </div>

        {/* Features */}
        <div className="p-3 rounded-md bg-surface-elevated">
          <div className="text-caption font-semibold text-content-primary uppercase tracking-wide mb-2">
            Features
          </div>
          {rec.features.length > 0 ? (
            <ul className="space-y-1">
              {rec.features.map((feat, i) => (
                <li key={i} className="text-caption text-content-secondary flex items-start gap-1.5">
                  <span className="text-accent mt-0.5 shrink-0">-</span>
                  <span>{feat}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-content-tertiary">No features listed.</p>
          )}
        </div>
      </div>

      {/* Implementation plan */}
      {rec.implementation_plan && (
        <div className="p-3 rounded-md bg-surface-elevated">
          <div className="text-caption font-semibold text-content-primary uppercase tracking-wide mb-2">
            Implementation Plan
          </div>
          <p className="text-caption text-content-secondary leading-relaxed whitespace-pre-wrap">
            {rec.implementation_plan}
          </p>
        </div>
      )}

      {/* Sources */}
      {rec.sources && rec.sources.length > 0 && (
        <div>
          <div className="text-caption font-semibold text-content-primary uppercase tracking-wide mb-2">
            Sources ({rec.sources.length})
          </div>
          <div className="space-y-2">
            {rec.sources.map(src => (
              <div key={src.id} className="flex items-start gap-2 text-caption p-2 rounded-md bg-surface-elevated">
                <div className="flex-1 min-w-0">
                  <div className="text-content-primary font-medium truncate">
                    {src.title || 'Untitled'}
                  </div>
                  {src.url && (
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-1 mt-0.5"
                      onClick={e => e.stopPropagation()}
                    >
                      {new URL(src.url).hostname}
                      <ExternalLink size={10} />
                    </a>
                  )}
                  {src.author && (
                    <span className="text-content-tertiary ml-2">by {src.author}</span>
                  )}
                </div>
                {src.score != null && (
                  <span className="shrink-0 text-micro font-mono text-content-tertiary">
                    score: {src.score}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related Memories */}
      {rec.memories && rec.memories.length > 0 && (
        <div>
          <div className="text-caption font-semibold text-content-primary uppercase tracking-wide mb-2">
            Related Memories ({rec.memories.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {rec.memories.map(m => (
              <span
                key={m.memory_id}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-elevated text-micro font-mono text-content-secondary"
              >
                {m.memory_id}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-border-subtle">
        <Button
          variant="primary"
          size="sm"
          icon={<Check size={14} />}
          onClick={() => statusMutation.mutate('approved')}
          loading={statusMutation.isPending}
          disabled={rec.status === 'approved'}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Clock size={14} />}
          onClick={() => statusMutation.mutate('deferred')}
          loading={statusMutation.isPending}
          disabled={rec.status === 'deferred'}
        >
          Defer
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<X size={14} />}
          onClick={() => statusMutation.mutate('dismissed')}
          loading={statusMutation.isPending}
          disabled={rec.status === 'dismissed'}
        >
          Dismiss
        </Button>
        {rec.complexity && (
          <span className="ml-auto text-micro text-content-tertiary">
            Complexity: <span className="text-content-secondary">{rec.complexity}</span>
          </span>
        )}
        {rec.auto_implementable && (
          <span className="text-micro px-1.5 py-0.5 rounded-xs bg-green-500/15 text-green-400 font-medium">
            Auto-implementable
          </span>
        )}
      </div>

      {/* Discussion thread */}
      <DiscussionThread entityType="recommendation" entityId={id} />
    </div>
  )
}
