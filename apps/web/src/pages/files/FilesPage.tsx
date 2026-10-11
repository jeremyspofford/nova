import { useEffect, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, FolderOpen } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { CodeView, Markdown } from '../../components/Markdown'
import { Button, Code, EmptyState, Skeleton } from '../../components/ui'
import {
  getWorkspaceFiles as apiGetWorkspaceFiles,
  getWorkspaceFile as apiGetWorkspaceFile,
  workspaceRawUrl,
  type WorkspaceFileEntry,
  type WorkspaceFileDetail,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { codeLanguage, formatBytes, notShownMessage, previewKind } from './filesFormat'

/**
 * The operator's read-only window into Nova's workspace volume
 * (services/core/app/workspace_api.py) — what she has actually written,
 * with its real path and real contents, never a guess dressed up as one.
 *
 * `api` is the same dependency-injection seam ActivityPage uses: production
 * always uses the real client below, tests swap in a fake. `initialPath`
 * exists for the same reason — it is how the Activity drill-in's
 * span-path link opens straight to a file, without this component ever
 * having to read the URL itself (App.tsx's route wrapper reads
 * useSearchParams and passes the value down), so this stays exactly as
 * testable in isolation as ActivityPage is.
 */
interface FilesApi {
  getWorkspaceFiles: typeof apiGetWorkspaceFiles
  getWorkspaceFile: typeof apiGetWorkspaceFile
}

const DEFAULT_API: FilesApi = {
  getWorkspaceFiles: apiGetWorkspaceFiles,
  getWorkspaceFile: apiGetWorkspaceFile,
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; files: WorkspaceFileEntry[]; total: number; truncated: boolean }

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; detail: WorkspaceFileDetail }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function FilesPage({
  api = DEFAULT_API,
  initialPath = null,
}: {
  api?: FilesApi
  initialPath?: string | null
} = {}) {
  const [list, setList] = useState<ListState>({ status: 'loading' })
  // The list is fetched once, up front, whether or not initialPath sends
  // the operator straight to a detail view — Back has to have something to
  // return to without re-fetching (see the "returns to the list without
  // re-fetching" test).
  useEffect(() => {
    let live = true
    api
      .getWorkspaceFiles()
      .then(body => {
        if (live) setList({ status: 'ready', ...body })
      })
      .catch(err => {
        if (live) setList({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [api])

  const [selected, setSelected] = useState<string | null>(initialPath)
  const [detail, setDetail] = useState<DetailState | null>(null)

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      return
    }
    let live = true
    setDetail({ status: 'loading' })
    api
      .getWorkspaceFile(selected)
      .then(d => {
        if (live) setDetail({ status: 'ready', detail: d })
      })
      .catch(err => {
        if (live) setDetail({ status: 'error', reason: reasonOf(err) })
      })
    return () => {
      live = false
    }
  }, [api, selected])

  if (selected !== null) {
    return (
      <div>
        <PageHeader
          title="Files"
          description="What Nova has written into her workspace."
          actions={
            <Button variant="secondary" size="sm" onClick={() => setSelected(null)}>
              <ArrowLeft size={14} className="mr-1" />
              Back to files
            </Button>
          }
        />
        {detail?.status === 'loading' && <Skeleton lines={6} />}
        {detail?.status === 'error' && (
          <div
            role="alert"
            className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
          >
            Could not open {selected}: {detail.reason}
          </div>
        )}
        {detail?.status === 'ready' && <FileDetail detail={detail.detail} />}
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Files" description="What Nova has written into her workspace." />

      {list.status === 'error' && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load files: {list.reason}
        </div>
      )}

      {list.status === 'loading' && <Skeleton lines={6} />}

      {list.status === 'ready' && list.files.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title="Nothing here yet"
          description="Files Nova writes into her workspace will show up here."
        />
      )}

      {list.status === 'ready' && list.files.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
            <table className="w-full text-compact">
              <thead>
                <tr className="bg-surface-elevated">
                  {['Path', 'Size', 'Modified'].map(heading => (
                    <th
                      key={heading}
                      className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {list.files.map(f => (
                  <tr
                    key={f.path}
                    data-testid={`files-row-${f.path}`}
                    onClick={() => setSelected(f.path)}
                    className="cursor-pointer hover:bg-surface-card-hover transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-caption text-content-primary">
                      {f.path}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-caption text-content-secondary whitespace-nowrap">
                      {formatBytes(f.size)}
                    </td>
                    <td className="px-4 py-2.5 text-micro text-content-tertiary whitespace-nowrap">
                      {formatRelativeTime(f.modified)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.truncated && (
            <p className="mt-3 text-caption text-content-tertiary">
              Showing {list.files.length} of {list.total} files.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// Button.tsx always renders a <button>, and a <button> nested in an <a> is
// invalid HTML — so the links below borrow its secondary/sm classes directly
// rather than wrapping one, to look identical anyway.
const LINK_BUTTON =
  'inline-flex items-center justify-center gap-1 h-7 px-2.5 text-caption font-medium rounded-sm transition-all duration-fast bg-surface-elevated border border-border text-content-primary hover:bg-surface-card-hover active:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40'

function FileDetail({ detail }: { detail: WorkspaceFileDetail }) {
  const kind = previewKind(detail.path)
  const inlineUrl = workspaceRawUrl(detail.path, { inline: true })
  const [showSource, setShowSource] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-mono text-compact text-content-primary break-all">{detail.path}</p>
          <p className="text-caption text-content-tertiary">
            {formatBytes(detail.size)} · modified {formatRelativeTime(detail.modified)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {kind === 'markdown' && detail.text !== null && (
            <Button variant="secondary" size="sm" onClick={() => setShowSource(v => !v)}>
              {showSource ? 'Rendered' : 'Source'}
            </Button>
          )}
          {(kind === 'image' || kind === 'pdf') && (
            <a
              data-testid="open-file"
              href={inlineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_BUTTON}
            >
              <ExternalLink size={12} />
              Open
            </a>
          )}
          <a
            data-testid="download-file"
            href={workspaceRawUrl(detail.path)}
            download
            className={LINK_BUTTON}
          >
            <Download size={12} />
            Download
          </a>
        </div>
      </div>

      <FilePreview detail={detail} kind={kind} inlineUrl={inlineUrl} showSource={showSource} />
    </div>
  )
}

/**
 * Images and PDFs are drawn by the browser from /raw?inline=1, so they show
 * whether or not core decoded them as text (they are binary, and often over
 * the text cap). Markdown is rendered through the same component chat
 * replies use — no raw HTML, images as links — so a file Nova wrote gets no
 * more power in the page than a reply she sent.
 */
function FilePreview({
  detail,
  kind,
  inlineUrl,
  showSource,
}: {
  detail: WorkspaceFileDetail
  kind: ReturnType<typeof previewKind>
  inlineUrl: string
  showSource: boolean
}) {
  if (kind === 'image') {
    return (
      <div className="flex justify-center rounded-lg border border-border-subtle p-4">
        <img src={inlineUrl} alt={detail.path} className="max-w-full max-h-[70vh] object-contain" />
      </div>
    )
  }
  if (kind === 'pdf') {
    return (
      <iframe
        src={inlineUrl}
        title={detail.path}
        className="w-full h-[75vh] rounded-lg border border-border-subtle bg-white"
      />
    )
  }
  if (kind === 'word') {
    return (
      <div className="rounded-lg border border-border-subtle p-6 text-center text-compact text-content-secondary">
        Word documents can't be previewed here — download to open it.
      </div>
    )
  }
  if (detail.text === null) {
    return (
      <div className="rounded-lg border border-border-subtle p-6 text-center text-compact text-content-secondary">
        {notShownMessage(detail)}
      </div>
    )
  }
  if (kind === 'markdown' && !showSource) {
    return (
      // Markdown's heading sizes are tuned for a chat reply (h1 renders at
      // h2 size); a file is a document, so they step back up here only.
      <div className="rounded-lg border border-border-subtle p-4 sm:p-6 max-h-[75vh] overflow-auto text-body [&_h1]:text-h1 [&_h2]:text-h2 [&_h3]:text-h3 [&_h1]:mt-6 [&_h2]:mt-5 [&_h3]:mt-4 [&_h1]:mb-2 [&_h2]:mb-2 [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0">
        <Markdown text={detail.text} />
      </div>
    )
  }
  const language = codeLanguage(detail.path)
  if (language) return <CodeView text={detail.text} language={language} />
  return (
    <Code inline={false} className="max-h-[60vh] overflow-auto whitespace-pre-wrap">
      {detail.text}
    </Code>
  )
}
