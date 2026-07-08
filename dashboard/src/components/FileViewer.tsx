import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Copy, FileText, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createPortal } from 'react-dom'
import { getWorkspaceFile } from '../api'
import { formatBytes } from '../lib/format'

interface FileViewerProps {
  path: string
  onClose: () => void
}

function detectLanguage(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript',
    jsx: 'javascript', sql: 'sql', sh: 'bash', yml: 'yaml', yaml: 'yaml',
    json: 'json', toml: 'toml', css: 'css', html: 'html', rs: 'rust',
    go: 'go', java: 'java', rb: 'ruby', md: 'markdown',
  }
  return ext ? map[ext] ?? null : null
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export default function FileViewer({ path, onClose }: FileViewerProps) {
  const [copied, setCopied] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['workspace-file', path],
    queryFn: () => getWorkspaceFile(path),
    staleTime: 30_000,
    retry: 1,
  })

  const lang = detectLanguage(path)
  const isMarkdown = lang === 'markdown'

  const copyPath = () => {
    navigator.clipboard.writeText(path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={`File viewer: ${fileName(path)}`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-4xl max-h-[85vh] flex flex-col bg-surface-card rounded-xl border border-border-subtle shadow-lg glass-overlay dark:border-white/[0.12]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border-subtle shrink-0">
          <FileText className="w-4 h-4 text-content-tertiary shrink-0" />
          <span className="min-w-0 flex-1 font-mono text-mono-sm text-content-primary truncate">
            {path}
          </span>
          {data && (
            <span className="text-caption text-content-tertiary shrink-0">
              {formatBytes(data.size_bytes)}
            </span>
          )}
          <button
            type="button"
            onClick={copyPath}
            className="p-1.5 rounded-sm text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-150"
            title="Copy path"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-sm text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-150"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {isLoading && (
            <div className="flex items-center justify-center py-16 text-content-tertiary text-compact">
              Loading file...
            </div>
          )}

          {error && (
            <div className="px-5 py-8 text-center">
              <p className="text-compact text-red-400">
                Failed to load file
              </p>
              <p className="text-caption text-content-tertiary mt-1">
                {error instanceof Error ? error.message : 'Unknown error'}
              </p>
            </div>
          )}

          {data?.error && (
            <div className="px-5 py-8 text-center">
              <p className="text-compact text-red-400">
                {data.error}
              </p>
            </div>
          )}

          {data && !data.error && (
            <>
              {data.truncated && (
                <div className="px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 text-caption text-amber-400">
                  File truncated -- too large to display in full ({formatBytes(data.size_bytes)})
                </div>
              )}

              {data.content !== null && (
                <div className="p-5">
                  {isMarkdown ? (
                    <div className="markdown-body text-compact text-content-secondary">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {data.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="overflow-x-auto text-mono-sm text-content-secondary leading-relaxed">
                      <code className={lang ? `language-${lang}` : undefined}>
                        {data.content}
                      </code>
                    </pre>
                  )}
                </div>
              )}

              {data.content === null && !data.error && (
                <div className="px-5 py-8 text-center text-content-tertiary text-compact">
                  No content available
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
