import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { Copy, Check, Download, FileText, FileCode, GitBranch, Box } from 'lucide-react'
import type { Artifact } from '../api'
import { getWorkspaceFile } from '../api'

const MARKDOWN_TYPES = new Set(['documentation', 'task_summary', 'decision_record', 'api_contract'])
const CODE_TYPES = new Set(['code', 'test', 'config', 'schema'])

/* ── type → icon mapping ────────────────────────────────── */
function typeIcon(t: string) {
  if (MARKDOWN_TYPES.has(t)) return <FileText className="w-3.5 h-3.5" />
  if (CODE_TYPES.has(t)) return <FileCode className="w-3.5 h-3.5" />
  if (t === 'diagram') return <GitBranch className="w-3.5 h-3.5" />
  return <Box className="w-3.5 h-3.5" />
}

/* ── Mermaid sub-component ──────────────────────────────── */
export function MermaidDiagram({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // Strip ```mermaid fences if present (agent output wraps in fences)
  const cleaned = content.replace(/^```mermaid\s*\n?/, '').replace(/\n?```\s*$/, '').trim()

  useEffect(() => {
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        const id = `mermaid-${Math.random().toString(36).slice(2)}`
        const { svg: rendered } = await mermaid.render(id, cleaned)
        // Sanitize SVG output even though mermaid uses securityLevel: 'strict'
        const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } })
        if (!cancelled) setSvg(clean)
      } catch {
        if (!cancelled) setError(true)
      }
    }

    render()
    return () => { cancelled = true }
  }, [cleaned])

  if (error) {
    return (
      <pre className="overflow-x-auto text-mono-sm text-content-secondary leading-relaxed">
        <code>{content}</code>
      </pre>
    )
  }

  if (!svg) {
    return (
      <div className="text-content-tertiary text-compact py-4 text-center">
        Rendering diagram...
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="flex justify-center overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/* ── Render mermaid code blocks inside markdown artifacts ── */
const markdownComponents = {
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    if (className === 'language-mermaid') {
      return <MermaidDiagram content={String(children).replace(/\n$/, '')} />
    }
    return <code className={className}>{children}</code>
  },
}

/* ── Main component ─────────────────────────────────────── */
export default function ArtifactCard({
  artifact,
  onFileClick,
}: {
  artifact: Artifact
  onFileClick?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyContent = () => {
    navigator.clipboard.writeText(artifact.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const downloadContent = async () => {
    let text = artifact.content
    // Fetch live workspace file if available
    if (artifact.file_path) {
      try {
        const file = await getWorkspaceFile(artifact.file_path)
        if (file.content) text = file.content
      } catch { /* fall back to artifact content */ }
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = artifact.file_path?.split('/').pop() ?? artifact.name ?? 'artifact'
    a.click()
    URL.revokeObjectURL(url)
  }

  /* ── content renderer ─────────────────────────────────── */
  function renderContent() {
    const t = artifact.artifact_type

    if (MARKDOWN_TYPES.has(t)) {
      return (
        <div className="markdown-body text-compact text-content-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {artifact.content}
          </ReactMarkdown>
        </div>
      )
    }

    if (CODE_TYPES.has(t)) {
      return (
        <pre className="whitespace-pre-wrap break-words text-mono-sm text-content-secondary leading-relaxed">
          <code>{artifact.content}</code>
        </pre>
      )
    }

    if (t === 'diagram') {
      return <MermaidDiagram content={artifact.content} />
    }

    if (t === 'context_package') {
      let formatted: string
      try {
        formatted = JSON.stringify(JSON.parse(artifact.content), null, 2)
      } catch {
        formatted = artifact.content
      }
      return (
        <pre className="overflow-x-auto text-mono-sm text-content-secondary leading-relaxed">
          <code>{formatted}</code>
        </pre>
      )
    }

    /* fallback: plain text */
    return (
      <pre className="overflow-x-auto text-mono-sm text-content-secondary leading-relaxed whitespace-pre-wrap">
        {artifact.content}
      </pre>
    )
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card">
      {/* ── collapsed header ─────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-content-tertiary hover:text-content-primary transition-colors text-xs leading-none"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '\u25BE' : '\u25B8'}
        </button>

        <span className="text-content-tertiary shrink-0">{typeIcon(artifact.artifact_type)}</span>

        <span className="min-w-0 text-compact text-content-primary font-medium truncate">
          {artifact.name}
        </span>

        <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-caption text-content-tertiary shrink-0">
          {artifact.artifact_type}
        </span>

        {artifact.file_path && (
          <button
            type="button"
            onClick={() => onFileClick?.(artifact.file_path!)}
            className="min-w-0 font-mono text-mono-sm text-content-tertiary hover:text-content-primary hover:underline truncate transition-colors"
            title={artifact.file_path}
          >
            {artifact.file_path}
          </button>
        )}

        <span className="flex-1" />

        <button
          type="button"
          onClick={downloadContent}
          className="p-1.5 rounded-sm text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-150 shrink-0"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={copyContent}
          className="p-1.5 rounded-sm text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-150 shrink-0"
          title="Copy content"
        >
          {copied
            ? <Check className="w-3.5 h-3.5 text-accent" />
            : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* ── expanded content ─────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3 max-h-96 overflow-auto">
          {renderContent()}
        </div>
      )}
    </div>
  )
}
