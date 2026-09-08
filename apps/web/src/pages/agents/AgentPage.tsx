import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Bot, FileText, Pencil, ScrollText, Trash2 } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, ConfirmDialog, EmptyState, Skeleton, Tabs } from '../../components/ui'
import {
  ApiError,
  ACTIVITY_PAGE_SIZE,
  deleteAgent as apiDeleteAgent,
  getActivity as apiGetActivity,
  getActivityTurn as apiGetActivityTurn,
  getAgent as apiGetAgent,
  getAgentLog as apiGetAgentLog,
  getWorkspaceFiles as apiGetWorkspaceFiles,
  listSkills as apiListSkills,
  listTools as apiListTools,
  updateAgent as apiUpdateAgent,
  type ActivityTurn,
  type Agent,
  type AgentDeleted,
  type AgentSaved,
  type StoredMessage,
  type WorkspaceFileListing,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { ActivityTable } from '../activity/ActivityTable'
import { formatBytes } from '../files/filesFormat'
import { AgentForm } from './AgentForm'
import { SpendCell, StatePill } from './AgentsPage'
import { capWords, deleteDescription, logPairs } from './agentsFormat'

/**
 * One agent (S12): its spec as the store holds it, the facts core derives
 * about it at the request (state, spend, bound timers, which of its skills
 * and tools still exist), and three views of what it has actually done —
 * Traces (its turns, the Activity page's own rows and drill-in), Artifacts
 * (what it wrote under its folder, off the workspace listing) and Log (the
 * briefs it was handed and the reports it wrote back).
 *
 * Nothing here is a claim of the agent's: a trace is the ledger, an artifact
 * is a file that exists, a report is a row in its log conversation. Edit is
 * the same sheet the roster's "New agent" opens, name locked; Delete asks
 * with the timers it will pause NAMED (from the server's `bound_timers`),
 * and what the server answers — what it paused, what remains — is handed to
 * the roster to show once, never a bare "deleted".
 *
 * A name no agent holds is core's 404, shown in its words with a way back.
 *
 * `name` comes from the route (App.tsx's wrapper reads useParams) so this
 * stays testable via props, the FilesPage idiom; `onDeleted` is the wrapper's
 * navigation. `api` is the usual seam; `pollMs` drives the header's re-read.
 */
interface AgentApi {
  getAgent: typeof apiGetAgent
  updateAgent: typeof apiUpdateAgent
  deleteAgent: typeof apiDeleteAgent
  getAgentLog: typeof apiGetAgentLog
  getActivity: typeof apiGetActivity
  getActivityTurn: typeof apiGetActivityTurn
  getWorkspaceFiles: typeof apiGetWorkspaceFiles
  listTools: typeof apiListTools
  listSkills: typeof apiListSkills
}

const DEFAULT_API: AgentApi = {
  getAgent: apiGetAgent,
  updateAgent: apiUpdateAgent,
  deleteAgent: apiDeleteAgent,
  getAgentLog: apiGetAgentLog,
  getActivity: apiGetActivity,
  getActivityTurn: apiGetActivityTurn,
  getWorkspaceFiles: apiGetWorkspaceFiles,
  listTools: apiListTools,
  listSkills: apiListSkills,
}

const HEADER_POLL_MS = 5_000

type TabId = 'traces' | 'artifacts' | 'log'

type Load<T> = { status: 'loading' } | { status: 'error'; reason: string } | { status: 'ready'; data: T }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const bannerClass = 'mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

export function AgentPage({
  name,
  api = DEFAULT_API,
  onDeleted,
  pollMs = HEADER_POLL_MS,
  pageSize = ACTIVITY_PAGE_SIZE,
}: {
  name: string
  api?: AgentApi
  onDeleted: (result: AgentDeleted) => void
  pollMs?: number
  pageSize?: number
}) {
  const [agent, setAgent] = useState<Agent | null>(null)
  // A 404 is its own state: "no agent named x" in core's words, not a broken
  // page — and not a banner over a stale header either.
  const [notFound, setNotFound] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saved, setSaved] = useState<AgentSaved | null>(null)
  const [tab, setTab] = useState<TabId>('traces')

  const [traces, setTraces] = useState<Load<ActivityTurn[]>>({ status: 'loading' })
  const [tracesExhausted, setTracesExhausted] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [artifacts, setArtifacts] = useState<Load<WorkspaceFileListing> | null>(null)
  const [log, setLog] = useState<Load<StoredMessage[]> | null>(null)
  const tracesRef = useRef(traces)
  tracesRef.current = traces

  const readAgent = useCallback(async (): Promise<Agent | null> => {
    try {
      const row = await api.getAgent(name)
      setAgent(row)
      setNotFound(null)
      setError(null)
      return row
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(err.message)
      else setError(reasonOf(err))
      return null
    }
  }, [api, name])

  useEffect(() => {
    let live = true
    setAgent(null)
    setNotFound(null)
    setError(null)
    api.getAgent(name).then(
      row => {
        if (live) setAgent(row)
      },
      err => {
        if (!live) return
        if (err instanceof ApiError && err.status === 404) setNotFound(err.message)
        else setError(reasonOf(err))
      },
    )
    return () => {
      live = false
    }
  }, [api, name])

  // The header's light poll — state moves as the agent works. Stops on a
  // 404: an agent deleted elsewhere is not re-asked for every few seconds.
  useEffect(() => {
    if (notFound !== null) return
    let live = true
    const id = setInterval(() => {
      api.getAgent(name).then(
        row => {
          if (!live) return
          setAgent(row)
          setError(null)
        },
        err => {
          if (!live) return
          if (err instanceof ApiError && err.status === 404) setNotFound(err.message)
          else setError(reasonOf(err))
        },
      )
    }, pollMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [api, name, pollMs, notFound])

  // Traces: this agent's turns, first page on mount, older pages by cursor.
  useEffect(() => {
    let live = true
    setTraces({ status: 'loading' })
    api.getActivity({ limit: pageSize, agent: name }).then(
      rows => {
        if (!live) return
        setTraces({ status: 'ready', data: rows })
        setTracesExhausted(rows.length < pageSize)
      },
      err => {
        if (live) setTraces({ status: 'error', reason: reasonOf(err) })
      },
    )
    return () => {
      live = false
    }
  }, [api, name, pageSize])

  const loadMoreTraces = useCallback(() => {
    const current = tracesRef.current
    if (current.status !== 'ready' || current.data.length === 0) return
    const before = current.data[current.data.length - 1].id
    setLoadingMore(true)
    api
      .getActivity({ limit: pageSize, agent: name, before })
      .then(next => {
        setTraces(prev => (prev.status === 'ready' ? { status: 'ready', data: [...prev.data, ...next] } : prev))
        setTracesExhausted(next.length < pageSize)
      })
      .catch(err => setActionError(`Could not load older traces: ${reasonOf(err)}`))
      .finally(() => setLoadingMore(false))
  }, [api, name, pageSize])

  // Artifacts and Log are read when their tab is first opened, and re-read
  // each time it is opened again — cheap, and what is shown is then current.
  useEffect(() => {
    if (tab !== 'artifacts' || agent === null) return
    let live = true
    setArtifacts({ status: 'loading' })
    api.getWorkspaceFiles(agent.folder).then(
      listing => live && setArtifacts({ status: 'ready', data: listing }),
      err => live && setArtifacts({ status: 'error', reason: reasonOf(err) }),
    )
    return () => {
      live = false
    }
    // The folder is derived from the name and never changes for a row —
    // keyed on it, not the whole agent object the poll replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tab, agent?.folder])

  useEffect(() => {
    if (tab !== 'log') return
    let live = true
    setLog({ status: 'loading' })
    api.getAgentLog(name).then(
      rows => live && setLog({ status: 'ready', data: rows }),
      err => live && setLog({ status: 'error', reason: reasonOf(err) }),
    )
    return () => {
      live = false
    }
  }, [api, tab, name])

  const onSaved = useCallback((result: AgentSaved) => {
    setSaved(result)
    setEditing(false)
    setAgent(result)
  }, [])

  const remove = useCallback(async () => {
    setConfirmDelete(false)
    setDeleting(true)
    setActionError(null)
    try {
      onDeleted(await api.deleteAgent(name))
    } catch (err) {
      setActionError(`Could not delete ${name}: ${reasonOf(err)}`)
      setDeleting(false)
      // The row may have changed underneath (a timer bound since): re-read.
      void readAgent()
    }
  }, [api, name, onDeleted, readAgent])

  if (notFound !== null) {
    return (
      <div>
        <PageHeader title={name} />
        <EmptyState
          icon={Bot}
          title={notFound}
          description="There is no agent by that name. It may have been deleted, or the name is misspelt."
        />
        <div className="flex justify-center">
          <Link to="/agents" className="inline-flex items-center gap-1 text-compact text-accent hover:underline">
            <ArrowLeft size={14} /> Back to agents
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={agent?.name ?? name}
        description={agent?.purpose}
        actions={
          agent && (
            <>
              <Button size="sm" variant="secondary" icon={<Pencil size={12} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={12} />}
                loading={deleting}
                disabled={deleting}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </>
          )
        }
      />

      <p className="-mt-6 mb-6">
        <Link to="/agents" className="inline-flex items-center gap-1 text-caption text-content-tertiary hover:text-content-primary">
          <ArrowLeft size={12} /> All agents
        </Link>
      </p>

      {error && (
        <div role="alert" className={bannerClass}>
          Could not load {name}: {error}
        </div>
      )}
      {actionError && (
        <div role="alert" className={bannerClass}>
          {actionError}
        </div>
      )}
      {saved && (
        <div role="status" data-testid="agent-saved" className="mb-6 rounded-sm border border-success/30 bg-success-dim px-4 py-3 text-compact text-success">
          {saved.text}
          {!saved.route.registered && <span className="block text-warning">{saved.route.detail}</span>}
        </div>
      )}

      {agent === null && !error && (
        <div data-testid="agent-skeleton">
          <Skeleton lines={4} />
        </div>
      )}

      {agent && (
        <>
          <dl
            className="mb-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-caption"
            data-testid="agent-facts"
          >
            <dt className="text-content-tertiary">State</dt>
            <dd>
              <StatePill agent={agent} />
              {agent.state.since && (
                <span className="ml-2 text-micro text-content-tertiary">since {formatRelativeTime(agent.state.since)}</span>
              )}
            </dd>
            <dt className="text-content-tertiary">Role</dt>
            <dd className="text-content-secondary">
              <span className="font-mono">{agent.role}</span>
              <span className="text-content-tertiary"> · </span>
              <Link to="/settings" className="text-accent hover:underline">
                model chain on Settings → Routing
              </Link>
            </dd>
            <dt className="text-content-tertiary">Spend</dt>
            <dd className="text-content-secondary">
              <SpendCell agent={agent} />
              <span className="text-content-tertiary"> of {capWords(agent.monthly_cap_usd)}</span>
            </dd>
            <dt className="text-content-tertiary">Rounds</dt>
            <dd className="text-content-secondary" data-testid="agent-rounds">
              up to {agent.max_tool_rounds} tool round{agent.max_tool_rounds === 1 ? '' : 's'} a turn
            </dd>
            <dt className="text-content-tertiary">Shared memory</dt>
            <dd className="text-content-secondary" data-testid="agent-read-shared">
              {agent.read_shared_memory ? 'reads the household\'s shared notes; writes only its own' : 'its own notes only'}
            </dd>
            <dt className="text-content-tertiary">Tools</dt>
            <dd className="flex flex-wrap gap-1" data-testid="agent-tools">
              {agent.tools.length === 0 && <span className="text-content-tertiary">none</span>}
              {agent.tools.map(tool => {
                const gone = agent.unknown_tools.includes(tool)
                return (
                  <Badge key={tool} size="sm" color={gone ? 'warning' : 'neutral'} className="font-mono">
                    {gone && <AlertTriangle size={10} />}
                    {tool}
                    {gone && ' — no longer exists'}
                  </Badge>
                )
              })}
            </dd>
            <dt className="text-content-tertiary">Skills</dt>
            <dd className="flex flex-wrap gap-1" data-testid="agent-skills">
              {agent.skills.length === 0 && <span className="text-content-tertiary">none</span>}
              {agent.skills.map(skill => (
                <Badge key={skill.name} size="sm" color={skill.present ? 'neutral' : 'warning'} className="font-mono">
                  {!skill.present && <AlertTriangle size={10} />}
                  {skill.name}
                  {!skill.present && ' — missing'}
                </Badge>
              ))}
            </dd>
            <dt className="text-content-tertiary">Folder</dt>
            <dd className="font-mono text-content-secondary" data-testid="agent-folder">
              {agent.folder}
            </dd>
            {agent.bound_timers.length > 0 && (
              <>
                <dt className="text-content-tertiary">Timers</dt>
                <dd className="text-content-secondary" data-testid="agent-timers">
                  {agent.bound_timers.map(t => t.title).join(', ')}
                  <span className="text-content-tertiary"> · </span>
                  <Link to="/schedules" className="text-accent hover:underline">
                    Schedules
                  </Link>
                </dd>
              </>
            )}
            <dt className="text-content-tertiary">Last active</dt>
            <dd className="text-content-secondary">
              {agent.last_active === null ? 'never' : formatRelativeTime(agent.last_active)}
            </dd>
          </dl>

          <Tabs
            className="mb-4"
            activeTab={tab}
            onChange={id => setTab(id as TabId)}
            tabs={[
              { id: 'traces', label: 'Traces', icon: ScrollText },
              { id: 'artifacts', label: 'Artifacts', icon: FileText },
              { id: 'log', label: 'Log', icon: Bot },
            ]}
          />

          {tab === 'traces' && (
            <div data-testid="agent-traces">
              {traces.status === 'loading' && <Skeleton lines={4} />}
              {traces.status === 'error' && (
                <p className="text-compact text-danger">Could not load traces: {traces.reason}</p>
              )}
              {traces.status === 'ready' &&
                (traces.data.length === 0 ? (
                  <EmptyState icon={ScrollText} title="No turns yet" description={`${agent.name} has not run yet — its turns will appear here as it works.`} />
                ) : (
                  <>
                    <ActivityTable turns={traces.data} getActivityTurn={api.getActivityTurn} />
                    {!tracesExhausted && (
                      <div className="flex justify-center mt-4">
                        <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMoreTraces}>
                          Load more
                        </Button>
                      </div>
                    )}
                  </>
                ))}
            </div>
          )}

          {tab === 'artifacts' && (
            <div data-testid="agent-artifacts">
              {(artifacts === null || artifacts.status === 'loading') && <Skeleton lines={3} />}
              {artifacts?.status === 'error' && (
                <p className="text-compact text-danger">Could not list {agent.folder}: {artifacts.reason}</p>
              )}
              {artifacts?.status === 'ready' &&
                (artifacts.data.files.length === 0 ? (
                  <EmptyState icon={FileText} title="nothing written yet" description={`Files ${agent.name} writes under ${agent.folder} will show up here.`} />
                ) : (
                  <>
                    <div className="overflow-x-auto rounded-lg border border-border glass-card dark:border-white/[0.08]">
                      <table className="w-full text-compact">
                        <thead>
                          <tr className="bg-surface-elevated">
                            {['Path', 'Size', 'Modified'].map(heading => (
                              <th key={heading} className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">
                                {heading}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border-subtle">
                          {artifacts.data.files.map(f => (
                            <tr key={f.path} data-testid={`artifact-row-${f.path}`} className="hover:bg-surface-card-hover transition-colors">
                              <td className="px-4 py-2.5 font-mono text-caption">
                                <Link to={`/files?path=${encodeURIComponent(f.path)}`} className="text-accent hover:underline">
                                  {f.path}
                                </Link>
                              </td>
                              <td className="px-4 py-2.5 font-mono text-caption text-content-secondary whitespace-nowrap">{formatBytes(f.size)}</td>
                              <td className="px-4 py-2.5 text-micro text-content-tertiary whitespace-nowrap">{formatRelativeTime(f.modified)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {artifacts.data.truncated && (
                      <p className="mt-3 text-caption text-content-tertiary">
                        Showing {artifacts.data.files.length} of {artifacts.data.total} files.
                      </p>
                    )}
                  </>
                ))}
            </div>
          )}

          {tab === 'log' && (
            <div data-testid="agent-log">
              {(log === null || log.status === 'loading') && <Skeleton lines={3} />}
              {log?.status === 'error' && <p className="text-compact text-danger">Could not load the log: {log.reason}</p>}
              {log?.status === 'ready' && <LogView messages={log.data} name={agent.name} />}
            </div>
          )}
        </>
      )}

      {agent && (
        <AgentForm
          open={editing}
          onClose={() => setEditing(false)}
          initial={agent}
          onSave={(_body, changes) => api.updateAgent(agent.name, changes)}
          onSaved={onSaved}
          api={api}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${name}?`}
        description={deleteDescription(name, agent?.bound_timers ?? [])}
        confirmLabel="Delete agent"
        destructive
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** The log conversation as brief → report pairs: what Nova asked, what the
 * agent answered, in order. A brief with no report yet is shown as such. */
function LogView({ messages, name }: { messages: StoredMessage[]; name: string }) {
  const pairs = logPairs(messages)
  if (pairs.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No delegations yet"
        description={`Nothing has been asked of ${name} yet. Ask Nova to hand it something, or @${name} in chat.`}
      />
    )
  }
  return (
    <ol className="space-y-4">
      {pairs.map((pair, i) => (
        <li key={pair.brief?.id ?? pair.reports[0]?.id ?? i} className="rounded-lg border border-border-subtle p-4 space-y-3" data-testid="log-pair">
          {pair.brief ? (
            <div>
              <div className="mb-1 flex items-center gap-2 text-micro uppercase tracking-wider text-content-tertiary">
                Brief
                <span className="normal-case tracking-normal">{formatRelativeTime(pair.brief.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-compact text-content-primary" data-testid="log-brief">
                {pair.brief.content}
              </p>
            </div>
          ) : (
            <p className="text-caption text-warning">a report with no brief before it</p>
          )}
          {pair.reports.length === 0 ? (
            <p className="text-caption text-content-tertiary italic">no report yet</p>
          ) : (
            pair.reports.map(report => (
              <div key={report.id}>
                <div className="mb-1 flex items-center gap-2 text-micro uppercase tracking-wider text-content-tertiary">
                  Report
                  <span className="normal-case tracking-normal">{formatRelativeTime(report.created_at)}</span>
                  {report.served_by && <span className="font-mono normal-case tracking-normal">{report.served_by}</span>}
                </div>
                <p className="whitespace-pre-wrap text-compact text-content-secondary" data-testid="log-report">
                  {report.content}
                </p>
              </div>
            ))
          )}
        </li>
      ))}
    </ol>
  )
}
