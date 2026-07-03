import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings, Wifi, WifiOff, Loader2, Eye, Ban } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  getCaptureSessions,
  getCaptureTodayStats,
  getPlatformConfig,
  updatePlatformConfig,
  testScreenpipeConnection,
  addCaptureExclude,
  type CaptureSession,
  type ExcludeScope,
} from '../api'
import { Modal } from '../components/ui/Modal'
import { Popover } from '../components/ui/Popover'
import { RadioGroup } from '../components/ui/Radio'
import { useToast } from '../components/ToastProvider'

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatTimeRange(start?: string, end?: string): string {
  if (!start) return '—'
  const fmt = (s: string) => {
    try {
      const d = parseISO(s)
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    } catch {
      return '?'
    }
  }
  return end ? `${fmt(start)} → ${fmt(end)}` : fmt(start)
}

// ── Connection card ────────────────────────────────────────────────────────────

function ConnectionCard({ sessionsCount }: { sessionsCount: number | null }) {
  const { data: health, isLoading } = useQuery({
    queryKey: ['screenpipe', 'health'],
    queryFn: () => testScreenpipeConnection(),
    staleTime: 5_000,
    retry: 1,
    refetchInterval: 30_000,
  })

  const connected = health?.ok === true

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-content-tertiary">Connection</p>
      <div className="flex items-center gap-2">
        {isLoading ? (
          <Loader2 size={14} className="animate-spin text-content-tertiary" />
        ) : connected ? (
          <Wifi size={14} className="text-teal-500" />
        ) : (
          <WifiOff size={14} className="text-amber-500" />
        )}
        <span className="text-sm font-medium text-content-primary">
          {isLoading ? 'Checking…' : connected ? 'Connected to workstation' : 'Not connected'}
        </span>
      </div>
      {!isLoading && !connected && health?.error && (
        <p className="text-xs text-red-500">{health.error}</p>
      )}
      {sessionsCount !== null && (
        <p className="text-xs text-content-tertiary">Sessions today: {sessionsCount}</p>
      )}
      <Link
        to="/settings#screenpipe"
        className="inline-block text-xs text-teal-600 dark:text-teal-400 hover:underline mt-1"
      >
        Configure
      </Link>
    </div>
  )
}

// ── Today stats card ───────────────────────────────────────────────────────────

function TodayStatsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['capture', 'today-stats'],
    queryFn: getCaptureTodayStats,
    staleTime: 5_000,
    retry: 1,
    refetchInterval: 30_000,
  })

  const topApp = data?.top_apps?.[0]

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-content-tertiary">Today</p>
      {isLoading ? (
        <div className="space-y-1.5">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-4 rounded bg-surface-elevated animate-pulse w-3/4" />
          ))}
        </div>
      ) : (
        <div className="space-y-1 text-sm text-content-primary">
          <p>Sessions: <span className="font-medium">{data?.sessions_count ?? 0}</span></p>
          <p>Captured time: <span className="font-medium">{formatDuration(data?.captured_seconds ?? 0)}</span></p>
          <p>Dropped (filtered): <span className="font-medium">{data?.dropped_count ?? 0}</span></p>
          {topApp && (
            <p>Top app: <span className="font-medium">{topApp.app}</span>{' '}
              <span className="text-content-tertiary">({formatDuration(topApp.captured_seconds)})</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Pause toggle button ────────────────────────────────────────────────────────

function PauseToggle() {
  const qc = useQueryClient()

  const { data: entries = [] } = useQuery({
    queryKey: ['platform-config'],
    queryFn: getPlatformConfig,
    staleTime: 30_000,
  })

  const paused = entries.find(e => e.key === 'capture.paused')?.value === true
    || entries.find(e => e.key === 'capture.paused')?.value === 'true'

  const mutation = useMutation({
    mutationFn: (value: string) => updatePlatformConfig('capture.paused', value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-config'] }),
  })

  return (
    <button
      type="button"
      onClick={() => mutation.mutate(paused ? 'false' : 'true')}
      disabled={mutation.isPending}
      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
        paused
          ? 'border-teal-600 text-teal-600 dark:text-teal-400 dark:border-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20'
          : 'border-amber-500 text-amber-600 dark:text-amber-400 dark:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20'
      }`}
      aria-label={paused ? 'Resume capture' : 'Pause capture'}
    >
      {mutation.isPending && <Loader2 size={13} className="animate-spin" />}
      {paused ? 'Resume' : 'Pause'}
    </button>
  )
}

// ── View modal ─────────────────────────────────────────────────────────────────

function SessionViewModal({
  session,
  onClose,
}: {
  session: CaptureSession | null
  onClose: () => void
}) {
  const meta = session?.metadata ?? {}
  return (
    <Modal
      open={session !== null}
      onClose={onClose}
      size="lg"
      title={session?.title || session?.metadata?.window || 'Session details'}
    >
      {session && (
        <div className="space-y-3 text-sm text-content-secondary">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {Object.entries(meta).map(([k, v]) => (
              v != null && v !== '' ? (
                <div key={k} className="contents">
                  <dt className="text-content-tertiary">{k}</dt>
                  <dd className="font-mono text-xs break-all">{String(v)}</dd>
                </div>
              ) : null
            ))}
          </dl>
          <p className="text-xs text-content-tertiary">
            Captured text is ingested into Nova's memory journal — see the journal files under
            your workspace memory folder for the full content.
          </p>
        </div>
      )}
    </Modal>
  )
}

// ── Exclude popover ────────────────────────────────────────────────────────────

function ExcludePopover({ session }: { session: CaptureSession }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { addToast } = useToast()

  const meta = session.metadata ?? {}
  const app: string = meta.app ?? session.source_kind
  const windowTitle: string = meta.window ?? session.title ?? ''
  const url: string | undefined = meta.url

  // Build option list: App always first, URL only if present, Window title always
  type ScopeOption = { value: ExcludeScope; label: string; displayValue: string }
  const options: ScopeOption[] = [
    { value: 'app', label: 'App', displayValue: app },
    ...(url ? [{ value: 'url_pattern' as ExcludeScope, label: 'URL pattern', displayValue: url }] : []),
    ...(windowTitle && windowTitle !== app
      ? [{ value: 'window_title' as ExcludeScope, label: 'Window title', displayValue: windowTitle }]
      : []),
  ]

  const [selected, setSelected] = useState<ExcludeScope>('app')

  const mutation = useMutation({
    mutationFn: ({ scope, value }: { scope: ExcludeScope; value: string }) =>
      addCaptureExclude(scope, value),
    onSuccess: (data, { scope, value }) => {
      qc.invalidateQueries({ queryKey: ['capture', 'sessions'] })
      const msg = data.added
        ? `Excluded "${value}" from future captures.`
        : `"${value}" was already in the ${scope} denylist.`
      addToast({
        variant: 'success',
        message: msg,
        action: {
          label: 'Privacy settings',
          onClick: () => navigate('/settings#capture-privacy'),
        },
      })
    },
    onError: (err) => {
      addToast({ variant: 'error', message: `Failed to exclude: ${(err as Error).message}` })
    },
  })

  const selectedOption = options.find(o => o.value === selected) ?? options[0]

  const handleConfirm = () => {
    const opt = options.find(o => o.value === selected) ?? options[0]
    mutation.mutate({ scope: opt.value, value: opt.displayValue })
  }

  return (
    <Popover
      align="end"
      trigger={
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-content-secondary hover:text-content-primary hover:border-border-strong transition-colors"
          aria-label="Exclude from future captures"
        >
          <Ban size={11} />
          exclude
        </button>
      }
    >
      <div className="w-56 space-y-3 p-1">
        <p className="text-xs font-semibold text-content-secondary">Exclude from future captures</p>
        <RadioGroup
          name={`exclude-${session.id}`}
          value={selected}
          onChange={(v) => setSelected(v as ExcludeScope)}
          options={options.map(o => ({
            value: o.value,
            label: o.label,
            description: o.displayValue,
          }))}
        />
        <button
          type="button"
          onClick={handleConfirm}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {mutation.isPending && <Loader2 size={11} className="animate-spin" />}
          Exclude {selectedOption.displayValue.length > 20
            ? selectedOption.displayValue.slice(0, 20) + '…'
            : selectedOption.displayValue}
        </button>
      </div>
    </Popover>
  )
}

// ── Activity row ───────────────────────────────────────────────────────────────

function ActivityRow({
  session,
  onView,
}: {
  session: CaptureSession
  onView: (s: CaptureSession) => void
}) {
  const meta = session.metadata ?? {}
  const timeRange = formatTimeRange(meta.captured_at_start, meta.captured_at_end)
  const app: string = meta.app ?? session.source_kind
  const window: string = meta.window ?? session.title ?? '—'
  const wordCount: number | undefined = meta.word_count
  const url: string | undefined = meta.url

  const relTime = (() => {
    try {
      return formatDistanceToNow(parseISO(session.ingested_at), { addSuffix: true })
    } catch {
      return ''
    }
  })()

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-3 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-xs text-content-tertiary font-mono">{timeRange}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-content-primary truncate">{app}</span>
            {window && window !== app && (
              <span className="text-xs text-content-secondary truncate">{window}</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-content-tertiary flex-wrap">
            {wordCount !== undefined && (
              <span>{wordCount.toLocaleString()} words</span>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 dark:text-teal-400 hover:underline truncate max-w-xs"
              >
                {url}
              </a>
            )}
            {relTime && <span>{relTime}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onView(session)}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-content-secondary hover:text-content-primary hover:border-border-strong transition-colors"
            aria-label="View session content"
          >
            <Eye size={11} />
            view
          </button>
          <ExcludePopover session={session} />
        </div>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CapturePage() {
  const [viewSession, setViewSession] = useState<CaptureSession | null>(null)

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ['capture', 'sessions'],
    queryFn: () => getCaptureSessions(50),
    staleTime: 5_000,
    retry: 1,
    refetchInterval: 30_000,
  })

  const sessions = sessionsData?.sessions ?? []

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-content-primary">Capture</h1>
        <div className="flex items-center gap-2">
          <PauseToggle />
          <Link
            to="/settings#screenpipe"
            className="flex items-center justify-center rounded-md border border-border-subtle w-8 h-8 text-content-tertiary hover:text-content-primary hover:border-border-strong transition-colors"
            aria-label="Capture settings"
          >
            <Settings size={15} />
          </Link>
        </div>
      </div>

      {/* Cards row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ConnectionCard
          sessionsCount={sessionsData ? sessions.length : null}
        />
        <TodayStatsCard />
      </div>

      {/* Activity feed */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-content-secondary uppercase tracking-wider">
          Recent activity
        </h2>
        {sessionsLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-16 rounded-lg border border-border-subtle bg-surface-card animate-pulse" />
            ))}
          </div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="rounded-lg border border-border-subtle bg-surface-card p-6 text-center text-sm text-content-tertiary">
            No sessions yet. Connect Screenpipe to start capturing.
          </div>
        )}
        {sessions.map(session => (
          <ActivityRow
            key={session.id}
            session={session}
            onView={setViewSession}
          />
        ))}
      </div>

      {/* View modal */}
      <SessionViewModal
        session={viewSession}
        onClose={() => setViewSession(null)}
      />
    </div>
  )
}
