import { useQuery } from '@tanstack/react-query'
import { Modal, Skeleton } from './ui'
import { getMemoryItem } from '../api'

// Journals are high-volume inboxes (can be >1MB). Cap what we render so a click
// never freezes the tab; the note tells the user it's truncated.
const MAX_CHARS = 40_000

/** Read-only viewer for a single recalled memory (OKF markdown item). */
export function MemoryDetailModal({ memoryId, title, onClose }: {
  memoryId: string | null
  title?: string
  onClose: () => void
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['memory-item', memoryId],
    queryFn: () => getMemoryItem(memoryId!.replace(/^\//, '')),
    enabled: !!memoryId,
  })
  const content = data?.content ?? ''
  const truncated = content.length > MAX_CHARS

  return (
    <Modal open={!!memoryId} onClose={onClose} size="xl" title={title || 'Memory'}>
      <div className="max-h-[65vh] overflow-auto">
        {memoryId && (
          <p className="mb-3 font-mono text-mono-sm text-content-tertiary break-all">{memoryId}</p>
        )}
        {isLoading && <Skeleton lines={8} />}
        {isError && (
          <p className="text-caption text-danger">Couldn't load this memory ({memoryId}).</p>
        )}
        {data && (
          <>
            <pre className="whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-content-secondary">
              {truncated ? content.slice(0, MAX_CHARS) : content}
            </pre>
            {truncated && (
              <p className="mt-3 text-micro text-content-tertiary">
                Showing the first {MAX_CHARS.toLocaleString()} of {content.length.toLocaleString()} characters.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
