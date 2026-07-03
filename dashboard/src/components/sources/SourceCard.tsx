import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, Github, RefreshCw, Trash2, Pause, Play, AlertCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import {
  type KnowledgeSource,
  deleteKnowledgeSource,
  triggerCrawl,
  pauseKnowledgeSource,
  resumeKnowledgeSource,
} from '../../api'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import type { SemanticColor } from '../../lib/design-tokens'

const SOURCE_TYPE_LABELS: Record<string, string> = {
  web_crawl: 'Web',
  github_profile: 'GitHub',
  gitlab_profile: 'GitLab',
  twitter: 'Twitter',
}

const SOURCE_TYPE_COLORS: Record<string, string> = {
  web_crawl: 'bg-blue-900/30 text-blue-400',
  github_profile: 'bg-purple-900/30 text-purple-400',
  gitlab_profile: 'bg-orange-900/30 text-orange-400',
  twitter: 'bg-sky-900/30 text-sky-400',
}

const STATUS_COLORS: Record<string, SemanticColor> = {
  active: 'success',
  paused: 'warning',
  error: 'danger',
  restricted: 'warning',
  pending: 'neutral',
}

function SourceIcon({ sourceType }: { sourceType: string }) {
  if (sourceType === 'github_profile' || sourceType === 'gitlab_profile') {
    return <Github size={16} className="text-content-tertiary" />
  }
  return <Globe size={16} className="text-content-tertiary" />
}

function truncateUrl(url: string, max = 50): string {
  try {
    const u = new URL(url)
    const display = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')
    return display.length > max ? display.slice(0, max - 3) + '...' : display
  } catch {
    return url.length > max ? url.slice(0, max - 3) + '...' : url
  }
}

interface Props {
  source: KnowledgeSource
}

export function SourceCard({ source }: Props) {
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['knowledge-sources'] })
    qc.invalidateQueries({ queryKey: ['knowledge-stats'] })
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteKnowledgeSource(source.id),
    onSuccess: () => { invalidate(); setDeleteOpen(false) },
  })

  const crawlMutation = useMutation({
    mutationFn: () => triggerCrawl(source.id),
    onSuccess: invalidate,
  })

  const pauseMutation = useMutation({
    mutationFn: () => pauseKnowledgeSource(source.id),
    onSuccess: invalidate,
  })

  const resumeMutation = useMutation({
    mutationFn: () => resumeKnowledgeSource(source.id),
    onSuccess: invalidate,
  })

  const isPaused = source.status === 'paused'
  const isError = source.status === 'error'
  const memoryCount = (source.last_crawl_summary?.engrams_created as number) ?? null

  return (
    <>
      <Card className={clsx('p-4', isError && 'border-red-500/30')}>
        <div className="flex items-start justify-between gap-3">
          {/* Left: icon + info */}
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="mt-0.5 shrink-0">
              <SourceIcon sourceType={source.source_type} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-compact font-semibold text-content-primary truncate">
                  {source.name}
                </span>
                <span className={clsx(
                  'inline-flex px-1.5 py-0.5 rounded text-micro font-medium',
                  SOURCE_TYPE_COLORS[source.source_type] ?? 'bg-neutral-700 text-neutral-300',
                )}>
                  {SOURCE_TYPE_LABELS[source.source_type] ?? source.source_type}
                </span>
                <Badge
                  color={STATUS_COLORS[source.status] ?? 'neutral'}
                  size="sm"
                  dot
                >
                  {source.status}
                </Badge>
              </div>

              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-caption text-accent hover:text-accent-hover truncate block"
                title={source.url}
              >
                {truncateUrl(source.url)}
              </a>

              <div className="flex items-center gap-3 mt-2 text-micro text-content-tertiary">
                {source.last_crawl_at && (
                  <span>
                    Crawled {formatDistanceToNow(new Date(source.last_crawl_at), { addSuffix: true })}
                  </span>
                )}
                {memoryCount !== null && (
                  <span>{memoryCount} memories</span>
                )}
                {source.error_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <AlertCircle size={10} />
                    {source.error_count} errors
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              icon={isPaused ? <Play size={12} /> : <Pause size={12} />}
              onClick={() => isPaused ? resumeMutation.mutate() : pauseMutation.mutate()}
              loading={pauseMutation.isPending || resumeMutation.isPending}
              title={isPaused ? 'Resume' : 'Pause'}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={12} />}
              onClick={() => crawlMutation.mutate()}
              loading={crawlMutation.isPending}
              title="Trigger crawl"
              disabled={isPaused}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              onClick={() => setDeleteOpen(true)}
              title="Delete source"
            />
          </div>
        </div>
      </Card>

      {deleteOpen && (
        <ConfirmDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title="Delete Source"
          description={`Delete "${source.name}"? Previously crawled content will remain in memory.`}
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate()}
          destructive
        />
      )}
    </>
  )
}
