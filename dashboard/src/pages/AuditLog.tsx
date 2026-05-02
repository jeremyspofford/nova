import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ScrollText, Filter, Download, ChevronDown, ChevronRight,
  AlertCircle, ChevronLeft, ChevronRight as ChevRight,
} from 'lucide-react'
import { queryAudit, type AuditEvent, type AuditFilters } from '../api'
import { PageHeader } from '../components/layout/PageHeader'
import { Button, Input, Select, Skeleton, Badge } from '../components/ui'

const PAGE_SIZE = 50

const BLAST_COLOR: Record<string, 'info' | 'warning' | 'danger' | 'neutral'> = {
  read: 'info',
  propose: 'info',
  mutate: 'warning',
  destruct: 'danger',
}

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  success: 'success',
  rejected: 'warning',
  error: 'danger',
  rate_limited: 'warning',
  timeout: 'warning',
  pending: 'neutral',
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

// ── CSV serialization ────────────────────────────────────────────────────────

const CSV_COLS: (keyof AuditEvent)[] = [
  'timestamp', 'actor_kind', 'actor_id', 'event_type', 'tool_name',
  'tool_kind', 'blast_radius', 'provider_kind', 'target',
  'credential_id', 'task_id', 'response_status', 'response_summary',
  'error_class', 'duration_ms', 'id',
]

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function rowsToCsv(rows: AuditEvent[]): string {
  const header = CSV_COLS.join(',')
  const body = rows.map(r => CSV_COLS.map(c => csvEscape(r[c])).join(',')).join('\n')
  return `${header}\n${body}\n`
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Row ──────────────────────────────────────────────────────────────────────

function AuditRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false)

  const blastColor = event.blast_radius ? BLAST_COLOR[event.blast_radius] ?? 'neutral' : 'neutral'
  const statusColor = STATUS_COLOR[event.response_status] ?? 'neutral'

  const argsPretty = useMemo(() => {
    if (!event.args_redacted) return null
    try { return JSON.stringify(event.args_redacted, null, 2) } catch { return String(event.args_redacted) }
  }, [event.args_redacted])

  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        className="cursor-pointer border-t border-border-subtle hover:bg-surface-card-hover transition-colors"
      >
        <td className="px-3 py-2 text-micro text-content-tertiary whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {fmt(event.timestamp)}
          </span>
        </td>
        <td className="px-3 py-2 text-caption text-content-secondary whitespace-nowrap">
          <span className="font-mono">{event.actor_kind}</span>
          <span className="text-content-tertiary"> · </span>
          <span className="font-mono text-micro">{event.actor_id.length > 16 ? event.actor_id.slice(0, 8) + '…' : event.actor_id}</span>
        </td>
        <td className="px-3 py-2 text-caption text-content-secondary whitespace-nowrap font-mono">
          {event.event_type}
        </td>
        <td className="px-3 py-2 text-caption font-mono text-content-primary">
          {event.tool_name ?? <span className="text-content-tertiary">—</span>}
        </td>
        <td className="px-3 py-2 text-caption font-mono text-content-secondary truncate max-w-[200px]">
          {event.target ?? <span className="text-content-tertiary">—</span>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          {event.blast_radius
            ? <Badge color={blastColor} size="sm">{event.blast_radius}</Badge>
            : <span className="text-content-tertiary text-caption">—</span>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <Badge color={statusColor} size="sm">{event.response_status}</Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border-subtle bg-surface-elevated/40">
          <td colSpan={7} className="px-6 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <dl className="text-caption space-y-1.5">
                <div>
                  <dt className="text-content-tertiary inline">id: </dt>
                  <dd className="font-mono text-content-secondary inline">{event.id}</dd>
                </div>
                {event.task_id && (
                  <div>
                    <dt className="text-content-tertiary inline">task_id: </dt>
                    <dd className="font-mono text-content-secondary inline">{event.task_id}</dd>
                  </div>
                )}
                {event.credential_id && (
                  <div>
                    <dt className="text-content-tertiary inline">credential_id: </dt>
                    <dd className="font-mono text-content-secondary inline">{event.credential_id}</dd>
                  </div>
                )}
                {event.tool_kind && (
                  <div>
                    <dt className="text-content-tertiary inline">tool_kind: </dt>
                    <dd className="font-mono text-content-secondary inline">{event.tool_kind}</dd>
                  </div>
                )}
                {event.provider_kind && (
                  <div>
                    <dt className="text-content-tertiary inline">provider: </dt>
                    <dd className="font-mono text-content-secondary inline">{event.provider_kind}</dd>
                  </div>
                )}
                {event.duration_ms !== null && (
                  <div>
                    <dt className="text-content-tertiary inline">duration: </dt>
                    <dd className="font-mono text-content-secondary inline">{event.duration_ms}ms</dd>
                  </div>
                )}
                {event.response_summary && (
                  <div>
                    <dt className="text-content-tertiary block mt-2">summary:</dt>
                    <dd className="text-content-secondary mt-0.5">{event.response_summary}</dd>
                  </div>
                )}
                {event.error_class && (
                  <div className="text-danger">
                    <dt className="inline">error: </dt>
                    <dd className="font-mono inline">{event.error_class}</dd>
                  </div>
                )}
              </dl>
              <div>
                <p className="text-caption text-content-tertiary mb-1">args_redacted</p>
                {argsPretty
                  ? <pre className="text-micro font-mono text-content-secondary bg-surface-card border border-border-subtle rounded-md p-2 overflow-auto max-h-60 whitespace-pre-wrap">{argsPretty}</pre>
                  : <p className="text-caption text-content-tertiary italic">none</p>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AuditLog() {
  const [filters, setFilters] = useState<AuditFilters>({ limit: PAGE_SIZE, offset: 0 })
  const [filtersExpanded, setFiltersExpanded] = useState(false)

  const setFilter = useCallback(<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    setFilters(f => ({ ...f, [key]: value || undefined, offset: 0 }))
  }, [])

  const { data: events = [], isLoading, error, refetch } = useQuery({
    queryKey: ['audit', filters],
    queryFn: () => queryAudit(filters),
    staleTime: 5_000,
    refetchInterval: 30_000,
  })

  const offset = filters.offset ?? 0
  const limit = filters.limit ?? PAGE_SIZE
  const hasNext = events.length === limit
  const hasPrev = offset > 0
  const showingFrom = events.length === 0 ? 0 : offset + 1
  const showingTo = offset + events.length

  const handleExportJson = () => {
    downloadBlob(
      JSON.stringify(events, null, 2),
      `nova-audit-${Date.now()}.json`,
      'application/json',
    )
  }
  const handleExportCsv = () => {
    downloadBlob(rowsToCsv(events), `nova-audit-${Date.now()}.csv`, 'text/csv')
  }

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        title="Audit Log"
        description="Tamper-evident log of every capability event — tool calls, consent decisions, credential use, rule applies. Append-only at the database layer."
      />

      {/* Filter bar */}
      <div className="mb-4 rounded-lg border border-border-subtle bg-surface-card p-3 space-y-3">
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="text-caption text-content-secondary block mb-1">Tool name</label>
            <Input
              value={filters.tool_name ?? ''}
              onChange={e => setFilter('tool_name', e.target.value)}
              placeholder="e.g. open_fix_pr"
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-caption text-content-secondary block mb-1">Target</label>
            <Input
              value={filters.target ?? ''}
              onChange={e => setFilter('target', e.target.value)}
              placeholder="e.g. owner/repo"
            />
          </div>
          <div className="min-w-[140px]">
            <label className="text-caption text-content-secondary block mb-1">Blast radius</label>
            <Select
              value={filters.blast_radius ?? ''}
              onChange={e => setFilter('blast_radius', e.target.value)}
            >
              <option value="">Any</option>
              <option value="read">read</option>
              <option value="propose">propose</option>
              <option value="mutate">mutate</option>
              <option value="destruct">destruct</option>
            </Select>
          </div>
          <div className="min-w-[140px]">
            <label className="text-caption text-content-secondary block mb-1">Status</label>
            <Select
              value={filters.response_status ?? ''}
              onChange={e => setFilter('response_status', e.target.value)}
            >
              <option value="">Any</option>
              <option value="success">success</option>
              <option value="rejected">rejected</option>
              <option value="error">error</option>
              <option value="rate_limited">rate limited</option>
              <option value="timeout">timeout</option>
              <option value="pending">pending</option>
            </Select>
          </div>
          <Button
            variant="ghost"
            onClick={() => setFiltersExpanded(e => !e)}
            icon={<Filter size={12} />}
          >
            {filtersExpanded ? 'Less' : 'More'}
          </Button>
        </div>

        {filtersExpanded && (
          <div className="flex items-end gap-2 flex-wrap pt-2 border-t border-border-subtle">
            <div className="flex-1 min-w-[200px]">
              <label className="text-caption text-content-secondary block mb-1">Actor ID</label>
              <Input
                value={filters.actor_id ?? ''}
                onChange={e => setFilter('actor_id', e.target.value)}
                placeholder="e.g. quartet:context"
              />
            </div>
            <div className="min-w-[160px]">
              <label className="text-caption text-content-secondary block mb-1">Actor kind</label>
              <Select
                value={filters.actor_kind ?? ''}
                onChange={e => setFilter('actor_kind', e.target.value)}
              >
                <option value="">Any</option>
                <option value="agent">agent</option>
                <option value="human">human</option>
                <option value="cortex_drive">cortex_drive</option>
                <option value="cron">cron</option>
                <option value="webhook">webhook</option>
                <option value="system">system</option>
              </Select>
            </div>
            <div className="min-w-[180px]">
              <label className="text-caption text-content-secondary block mb-1">Event type</label>
              <Select
                value={filters.event_type ?? ''}
                onChange={e => setFilter('event_type', e.target.value)}
              >
                <option value="">Any</option>
                <option value="tool_call">tool_call</option>
                <option value="consent_request">consent_request</option>
                <option value="consent_decision">consent_decision</option>
                <option value="credential_use">credential_use</option>
                <option value="mcp_register">mcp_register</option>
                <option value="tier_override">tier_override</option>
                <option value="rule_apply">rule_apply</option>
                <option value="budget_exceeded">budget_exceeded</option>
              </Select>
            </div>
            <div className="min-w-[200px]">
              <label className="text-caption text-content-secondary block mb-1">From</label>
              <Input
                type="datetime-local"
                value={filters.from_ts?.slice(0, 16) ?? ''}
                onChange={e => setFilter('from_ts', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
              />
            </div>
            <div className="min-w-[200px]">
              <label className="text-caption text-content-secondary block mb-1">To</label>
              <Input
                type="datetime-local"
                value={filters.to_ts?.slice(0, 16) ?? ''}
                onChange={e => setFilter('to_ts', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
              />
            </div>
            <Button
              variant="ghost"
              onClick={() => setFilters({ limit: PAGE_SIZE, offset: 0 })}
            >
              Clear all
            </Button>
          </div>
        )}
      </div>

      {/* Toolbar — pagination + export */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-caption text-content-tertiary">
          {isLoading
            ? 'Loading…'
            : events.length === 0
              ? 'No events match the current filters.'
              : `Showing ${showingFrom}–${showingTo}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(f => ({ ...f, offset: Math.max(0, (f.offset ?? 0) - (f.limit ?? PAGE_SIZE)) }))}
            disabled={!hasPrev || isLoading}
            icon={<ChevronLeft size={12} />}
          >
            Prev
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(f => ({ ...f, offset: (f.offset ?? 0) + (f.limit ?? PAGE_SIZE) }))}
            disabled={!hasNext || isLoading}
            icon={<ChevRight size={12} />}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportJson}
            disabled={events.length === 0}
            icon={<Download size={12} />}
          >
            JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={events.length === 0}
            icon={<Download size={12} />}
          >
            CSV
          </Button>
        </div>
      </div>

      {/* Table */}
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 mb-3 flex items-start gap-2 text-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-compact">{(error as Error).message}</p>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Skeleton lines={8} />
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated">
              <tr className="text-caption text-content-tertiary uppercase tracking-wider text-left">
                <th className="px-3 py-2 font-medium">Timestamp</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Blast</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center">
                    <ScrollText className="w-8 h-8 text-content-tertiary mx-auto mb-2" />
                    <p className="text-compact text-content-secondary">No audit events yet.</p>
                  </td>
                </tr>
              )}
              {events.map(e => <AuditRow key={e.id} event={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
