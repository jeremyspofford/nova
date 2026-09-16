import { FileText, Image as ImageIcon, Music, Paperclip } from 'lucide-react'
import type { Attachment } from '../../lib/api'

/**
 * What he attached, drawn on the message that carried it (S28).
 *
 * An image is SHOWN — a screenshot he sent and cannot see in the transcript
 * leaves him reading "what does this say?" with no way to know what "this"
 * was. Everything else is a chip with its name, type and size: a PDF's
 * contents are not something to render here, but which PDF very much is.
 *
 * The bytes come from core's own content route, which serves the SNIFFED
 * media type — the same value the turn routed on — so what is drawn here and
 * what she was sent cannot be two opinions about one file.
 */

/** Bytes a person reads. Exact figures are for a machine; "2.1 MB" is what
 * tells him whether the thing he sent is the thing he meant. */
export function sizeWords(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}

function iconFor(kind: string) {
  if (kind === 'image') return ImageIcon
  if (kind === 'audio') return Music
  if (kind === 'text') return FileText
  return Paperclip
}

export function Attached({ files }: { files: Attachment[] }) {
  if (files.length === 0) return null
  const images = files.filter(f => f.kind === 'image')
  const rest = files.filter(f => f.kind !== 'image')

  return (
    <div className="mt-1.5 flex flex-col items-end gap-1.5" data-testid="message-attachments">
      {images.map(file => (
        <a
          key={file.id}
          href={`/api/v1/attachments/${encodeURIComponent(file.id)}/content`}
          target="_blank"
          rel="noreferrer"
          title={`${file.filename} — ${sizeWords(file.size_bytes)}`}
        >
          <img
            src={`/api/v1/attachments/${encodeURIComponent(file.id)}/content`}
            alt={file.filename}
            data-testid="attached-image"
            className="max-h-64 max-w-full rounded-lg border border-border-subtle object-contain"
          />
        </a>
      ))}
      {rest.map(file => {
        const Icon = iconFor(file.kind)
        return (
          <a
            key={file.id}
            href={`/api/v1/attachments/${encodeURIComponent(file.id)}/content`}
            target="_blank"
            rel="noreferrer"
            data-testid="attached-file"
            title={file.media_type}
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-card px-2 py-1 text-micro text-content-secondary hover:text-content-primary transition-colors"
          >
            <Icon size={12} className="shrink-0" />
            <span className="max-w-[16rem] truncate">{file.filename}</span>
            <span className="text-content-tertiary">{sizeWords(file.size_bytes)}</span>
          </a>
        )
      })}
    </div>
  )
}
