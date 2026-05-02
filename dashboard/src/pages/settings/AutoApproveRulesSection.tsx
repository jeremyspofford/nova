import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark, Trash2, Loader2, AlertCircle, Brain,
} from 'lucide-react'
import {
  listConsentRules, updateConsentRule, deleteConsentRule,
  type ConsentRule,
} from '../../api'
import {
  Section, Toggle, Skeleton, EmptyState, Toast, ConfirmDialog, Badge,
} from '../../components/ui'

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function ScopeMatchPretty({ scope }: { scope: Record<string, unknown> }) {
  const entries = Object.entries(scope)
  if (entries.length === 0) {
    return <span className="text-micro italic text-content-tertiary">match anything</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-elevated border border-border-subtle text-micro font-mono text-content-secondary"
        >
          <span className="text-content-tertiary">{k}:</span>
          <span>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
        </span>
      ))}
    </div>
  )
}

function ConsentRuleRow({ rule, onChanged }: { rule: ConsentRule; onChanged: () => void }) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)

  const toggle = useMutation({
    mutationFn: () => updateConsentRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['consent-rules'] }); onChanged() },
    onError: (e: Error) => setToast({ variant: 'error', message: e.message }),
  })

  const remove = useMutation({
    mutationFn: () => deleteConsentRule(rule.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['consent-rules'] }); onChanged() },
    onError: (e: Error) => setToast({ variant: 'error', message: e.message }),
  })

  return (
    <div className="flex items-start gap-3 px-3 py-3 rounded-md border border-border-subtle bg-surface-elevated">
      <Bookmark size={14} className="text-content-tertiary shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-compact font-mono font-semibold text-content-primary">
            {rule.tool_name}
          </span>
          <Badge color="neutral" size="sm">{rule.provider_kind}</Badge>
          {rule.source === 'cortex_proposed' && (
            <Badge color="info" size="sm">
              <Brain size={10} className="inline mr-0.5" />
              cortex-proposed
            </Badge>
          )}
        </div>
        <ScopeMatchPretty scope={rule.scope_match} />
        <div className="flex items-center gap-3 text-micro text-content-tertiary">
          <span>Applied {rule.apply_count}×</span>
          <span>·</span>
          <span>Last {relativeTime(rule.last_applied_at)}</span>
          <span>·</span>
          <span>Saved {relativeTime(rule.accepted_at)}</span>
        </div>
      </div>
      <Toggle
        checked={rule.enabled}
        onChange={() => toggle.mutate()}
        disabled={toggle.isPending}
        size="sm"
      />
      <button
        onClick={() => setConfirmDelete(true)}
        className="text-content-tertiary hover:text-danger p-1 transition-colors"
        title="Delete rule"
      >
        {remove.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this auto-approve rule?"
        description={`Future ${rule.tool_name} calls matching this scope will require manual approval again.`}
        confirmLabel="Delete rule"
        destructive
        onConfirm={() => { remove.mutate(); setConfirmDelete(false) }}
        onClose={() => setConfirmDelete(false)}
      />
      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}

export function AutoApproveRulesSection() {
  const qc = useQueryClient()
  const { data: rules = [], isLoading, error } = useQuery({
    queryKey: ['consent-rules'],
    queryFn: () => listConsentRules(),
    staleTime: 10_000,
  })

  return (
    <Section
      icon={Bookmark}
      title="Auto-Approve Rules"
      description="Saved policies that auto-approve future MUTATE/DESTRUCT capability calls in scope. Created via 'Approve and remember' on the Approvals page, or proposed by cortex."
    >
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 text-danger mb-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <p className="text-compact">{(error as Error).message}</p>
        </div>
      )}

      {isLoading ? (
        <Skeleton lines={3} />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="No auto-approve rules yet"
          description="Approve a pending request with 'Approve and remember' to save a rule. Rules let Nova act on similar requests automatically without prompting."
        />
      ) : (
        <div className="space-y-2">
          {rules.map(r => (
            <ConsentRuleRow
              key={r.id}
              rule={r}
              onChanged={() => qc.invalidateQueries({ queryKey: ['consent-rules'] })}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
