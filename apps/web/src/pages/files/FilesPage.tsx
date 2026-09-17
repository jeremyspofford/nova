import { useEffect, useState } from 'react'
import { ArrowLeft, Download, FolderOpen } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Button, Code, EmptyState, Skeleton } from '../../components/ui'
import {
  getWorkspaceFiles as apiGetWorkspaceFiles,
  getWorkspaceFile as apiGetWorkspaceFile,
  workspaceRawUrl,
  type WorkspaceFileEntry,
  type WorkspaceFileDetail,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { formatBytes, notShownMessage } from './filesFormat'

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

function FileDetail({ detail }: { detail: WorkspaceFileDetail }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-compact text-content-primary">{detail.path}</p>
          <p className="text-caption text-content-tertiary">
            {formatBytes(detail.size)} · modified {formatRelativeTime(detail.modified)}
          </p>
        </div>
        {/* Button.tsx always renders a <button>, and a <button> nested in an
         * <a> is invalid HTML — so this borrows its secondary/sm classes
         * directly rather than wrapping one, to look identical anyway. */}
        <a
          data-testid="download-file"
          href={workspaceRawUrl(detail.path)}
          download
          className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-caption font-medium rounded-sm transition-all duration-fast bg-surface-elevated border border-border text-content-primary hover:bg-surface-card-hover active:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
        >
          <Download size={12} />
          Download
        </a>
      </div>

      {detail.text !== null ? (
        <Code inline={false} className="max-h-[60vh] overflow-auto whitespace-pre-wrap">
          {detail.text}
        </Code>
      ) : (
        <div className="rounded-lg border border-border-subtle p-6 text-center text-compact text-content-secondary">
          {notShownMessage(detail)}
        </div>
      )}
    </div>
  )
}
