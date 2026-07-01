import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ToggleRight, History, RotateCcw, AlertTriangle, X } from 'lucide-react'
import {
  listFeatureFlags,
  patchFeatureFlag,
  resetFeatureFlag,
  getFeatureFlagAudit,
  type FeatureFlagRow,
  type FeatureFlagAuditRow,
} from '../../api'
import { Section, Button, Toggle, Badge, Select } from '../../components/ui'

// ── CRITICAL_FLAGS — must match orchestrator/app/feature_flags_router.py ─────
//
// These flags require a typed-confirmation modal because flipping them in
// error has user-visible blast radius (the pipeline guardrail disarms). The
// dashboard mirrors the server-side hardcoded set so the modal renders even
// before the PATCH is sent; the server still re-checks on receipt — defense
// in depth.

const CRITICAL_FLAGS = new Set<string>([
  'pipeline.guardrail_strict_mode',
  'pipeline.web_fetch_strict_sanitize',
])

// ── Group rows by namespace prefix (split on first '.') ──────────────────────

function groupByNamespace(rows: FeatureFlagRow[]): Record<string, FeatureFlagRow[]> {
  const groups: Record<string, FeatureFlagRow[]> = {}
  for (const row of rows) {
    const ns = row.key.includes('.') ? row.key.split('.')[0] : 'other'
    if (!groups[ns]) groups[ns] = []
    groups[ns].push(row)
  }
  // Sort each group's rows alphabetically for stable rendering
  for (const ns of Object.keys(groups)) {
    groups[ns].sort((a, b) => a.key.localeCompare(b.key))
  }
  return groups
}

const NAMESPACE_LABELS: Record<string, string> = {
  kill: 'Kill switches',
  pipeline: 'Pipeline behavior',
  memory: 'Memory subsystem',
  cortex: 'Autonomous brain',
  other: 'Other',
}

// ── Critical-flag confirm modal ──────────────────────────────────────────────

function CriticalConfirmModal({
  flagKey,
  newValue,
  onConfirm,
  onCancel,
  saving,
}: {
  flagKey: string
  newValue: unknown
  onConfirm: () => void
  onCancel: () => void
  saving: boolean
}) {
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === flagKey

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border border-amber-300/30 bg-surface-primary p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-amber-500" size={22} />
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-content-primary">
              Confirm critical flag change
            </h3>
            <p className="mt-1 text-sm text-content-secondary">
              Setting this flag has platform-wide impact. Type the flag key
              exactly to confirm.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-content-tertiary hover:text-content-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mb-3 rounded border border-amber-300/20 bg-amber-50/5 p-3">
          <div className="text-caption text-content-tertiary">Flag</div>
          <div className="mt-1 font-mono text-sm text-content-primary">{flagKey}</div>
          <div className="mt-2 text-caption text-content-tertiary">New value</div>
          <div className="mt-1 font-mono text-sm text-content-primary">
            {JSON.stringify(newValue)}
          </div>
        </div>

        <label className="block">
          <span className="text-caption font-medium text-content-secondary">
            Type <span className="font-mono">{flagKey}</span> to confirm
          </span>
          <input
            autoFocus
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={flagKey}
            className="mt-1 w-full rounded border border-border-primary bg-surface-secondary px-3 py-2 font-mono text-sm text-content-primary focus:border-teal-500 focus:outline-none"
            onKeyDown={e => {
              if (e.key === 'Enter' && matches && !saving) onConfirm()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </label>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={!matches || saving}
            loading={saving}
          >
            Confirm change
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Audit history side panel ─────────────────────────────────────────────────

function AuditPanel({ flagKey, onClose }: { flagKey: string | null; onClose: () => void }) {
  const isOpen = flagKey !== null
  const { data: rows, isLoading } = useQuery({
    queryKey: ['feature-flag-audit', flagKey],
    queryFn: () => getFeatureFlagAudit(flagKey!),
    enabled: isOpen,
    staleTime: 5_000,
    retry: 1,
  })

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-surface-primary p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-content-primary">Audit history</h3>
            <div className="mt-1 font-mono text-caption text-content-tertiary">{flagKey}</div>
          </div>
          <button
            onClick={onClose}
            className="text-content-tertiary hover:text-content-primary"
          >
            <X size={18} />
          </button>
        </div>

        {isLoading && (
          <div className="text-caption text-content-tertiary">Loading…</div>
        )}
        {rows && rows.length === 0 && (
          <div className="rounded border border-border-primary p-4 text-caption text-content-tertiary">
            No changes recorded yet.
          </div>
        )}
        {rows && rows.length > 0 && (
          <ol className="space-y-3">
            {rows.map(r => (
              <AuditRow key={r.id} row={r} />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function AuditRow({ row }: { row: FeatureFlagAuditRow }) {
  const at = new Date(row.occurred_at).toLocaleString()
  return (
    <li className="rounded border border-border-primary bg-surface-secondary p-3 text-caption">
      <div className="flex items-center justify-between">
        <Badge color={row.action === 'set' ? 'warning' : 'success'}>{row.action}</Badge>
        <span className="text-content-tertiary">{at}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 font-mono text-content-primary">
        <span>{JSON.stringify(row.old_value)}</span>
        <span className="text-content-tertiary">→</span>
        <span>{JSON.stringify(row.new_value)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-content-tertiary">
        <span>by {row.actor}</span>
        {row.actor_ip && <span>· {row.actor_ip}</span>}
        {row.actor_user_agent && (
          <span className="truncate" title={row.actor_user_agent}>
            · {row.actor_user_agent.slice(0, 30)}
            {row.actor_user_agent.length > 30 ? '…' : ''}
          </span>
        )}
      </div>
      {row.notes && (
        <div className="mt-2 italic text-content-secondary">{row.notes}</div>
      )}
    </li>
  )
}

// ── Per-flag row ─────────────────────────────────────────────────────────────

function FlagRow({
  row,
  onPatch,
  onReset,
  onShowAudit,
  saving,
}: {
  row: FeatureFlagRow
  onPatch: (key: string, value: unknown) => void
  onReset: (key: string) => void
  onShowAudit: (key: string) => void
  saving: boolean
}) {
  const isCritical = CRITICAL_FLAGS.has(row.key)
  const isBool = row.type === 'bool' || (row.type === null && typeof row.current_value === 'boolean')

  return (
    <div className="flex items-center gap-3 border-b border-border-primary py-3 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-content-primary">{row.key}</span>
          {isCritical && (
            <span title="Critical flag — typed-confirm required to change">
              <AlertTriangle size={12} className="text-amber-500" />
            </span>
          )}
          {row.is_orphan && <Badge color="warning">orphan</Badge>}
          {row.is_override && !row.is_orphan && <Badge color="accent">override</Badge>}
        </div>
        {row.set_by && row.is_override && (
          <div className="mt-0.5 text-caption text-content-tertiary">
            set by {row.set_by}
            {row.set_at && ` · ${new Date(row.set_at).toLocaleString()}`}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isBool ? (
          <Toggle
            checked={Boolean(row.current_value)}
            onChange={v => onPatch(row.key, v)}
            disabled={saving}
          />
        ) : row.type === 'enum' && row.variants && row.variants.length > 0 ? (
          <Select
            value={String(row.current_value)}
            onChange={(e) => onPatch(row.key, e.target.value)}
            disabled={saving}
            items={row.variants.map(v => ({ value: String(v), label: String(v) }))}
          />
        ) : (
          // Orphan rows (type === null) and non-bool/non-enum primitives intentionally
          // fall through to read-only display — the admin can still see the value but
          // can't edit until the flag is properly declared in code.
          <span className="font-mono text-caption text-content-secondary">
            {String(row.current_value)}
          </span>
        )}

        {row.is_override && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onReset(row.key)}
            disabled={saving}
            icon={<RotateCcw size={11} />}
            title="Reset to in-code default"
          >
            Reset
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onShowAudit(row.key)}
          icon={<History size={11} />}
          title="View audit history"
        />
      </div>
    </div>
  )
}

// ── Main section ─────────────────────────────────────────────────────────────

export function FeatureFlagsSection() {
  const queryClient = useQueryClient()
  const [auditFor, setAuditFor] = useState<string | null>(null)
  const [pendingCriticalChange, setPendingCriticalChange] = useState<{
    key: string
    value: unknown
  } | null>(null)

  const { data: flags, isLoading, error } = useQuery({
    queryKey: ['feature-flags'],
    queryFn: listFeatureFlags,
    staleTime: 5_000,
    retry: 1,
    refetchOnWindowFocus: true,
  })

  const patchMutation = useMutation({
    mutationFn: ({ key, value, confirm }: { key: string; value: unknown; confirm?: string }) =>
      patchFeatureFlag(key, { value, confirm }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feature-flags'] })
      queryClient.invalidateQueries({ queryKey: ['feature-flag-audit'] })
      setPendingCriticalChange(null)
    },
  })

  const resetMutation = useMutation({
    mutationFn: (key: string) => resetFeatureFlag(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feature-flags'] })
      queryClient.invalidateQueries({ queryKey: ['feature-flag-audit'] })
    },
  })

  const handlePatch = (key: string, value: unknown) => {
    if (CRITICAL_FLAGS.has(key)) {
      // Stage the change; the modal asks for typed confirmation before
      // sending the PATCH (with `confirm` = key) to the server.
      setPendingCriticalChange({ key, value })
      return
    }
    patchMutation.mutate({ key, value })
  }

  const handleConfirmCritical = () => {
    if (!pendingCriticalChange) return
    const { key, value } = pendingCriticalChange
    patchMutation.mutate({ key, value, confirm: key })
  }

  const groups = flags ? groupByNamespace(flags) : {}
  const groupOrder = ['kill', 'pipeline', 'memory', 'cortex'].filter(n => groups[n])
  const remainingGroups = Object.keys(groups)
    .filter(n => !groupOrder.includes(n))
    .sort()
  const orderedGroups = [...groupOrder, ...remainingGroups]

  const saving = patchMutation.isPending || resetMutation.isPending

  return (
    <Section
      id="feature-flags"
      title="Feature flags"
      icon={ToggleRight}
      description="Runtime toggles for kill switches and behavior experiments. Changes propagate to every service in <5 seconds."
    >
      {isLoading && (
        <div className="text-caption text-content-tertiary">Loading…</div>
      )}
      {error && (
        <div className="rounded border border-red-300/30 bg-red-50/5 p-3 text-caption text-red-300">
          Failed to load flags: {(error as Error).message}
        </div>
      )}

      {flags && flags.length === 0 && (
        <div className="rounded border border-border-primary p-4 text-caption text-content-tertiary">
          No flags declared yet. Services register flags at startup; this list
          populates as services come online.
        </div>
      )}

      {flags && flags.length > 0 && (
        <div className="space-y-5">
          {orderedGroups.map(ns => (
            <div key={ns}>
              <h3 className="mb-1 text-caption font-medium uppercase tracking-wide text-content-tertiary">
                {NAMESPACE_LABELS[ns] ?? ns}
              </h3>
              <div className="rounded border border-border-primary bg-surface-secondary px-3">
                {groups[ns].map(row => (
                  <FlagRow
                    key={row.key}
                    row={row}
                    onPatch={handlePatch}
                    onReset={k => resetMutation.mutate(k)}
                    onShowAudit={setAuditFor}
                    saving={saving}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {patchMutation.isError && !pendingCriticalChange && (
        <div className="mt-3 rounded border border-red-300/30 bg-red-50/5 p-3 text-caption text-red-300">
          {(patchMutation.error as Error).message}
        </div>
      )}

      <AuditPanel flagKey={auditFor} onClose={() => setAuditFor(null)} />

      {pendingCriticalChange && (
        <CriticalConfirmModal
          flagKey={pendingCriticalChange.key}
          newValue={pendingCriticalChange.value}
          onConfirm={handleConfirmCritical}
          onCancel={() => setPendingCriticalChange(null)}
          saving={patchMutation.isPending}
        />
      )}
    </Section>
  )
}
