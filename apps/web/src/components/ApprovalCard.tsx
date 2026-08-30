import { ShieldAlert } from 'lucide-react'
import { Badge, Button } from './ui'
import type { ConsentCard } from '../lib/consentCard'

/**
 * One approval card — the operator's view of a REQUIRE_CONSENT decision the
 * policy kernel raised (services/core/app/policy.py, card_spec in
 * consents.py). Shared, unstyled-by-context, between two call sites: the
 * inline chat row (pages/chat, wrapped for busy/error state around a live
 * store) and the Approvals page (pages/approvals, wrapped the same way
 * around a fetched list) — both read the same fields, so this is the one
 * place the card's layout lives.
 *
 * The summary is EXACTLY what the kernel computed from the call's own args
 * (policy._summary) — never re-derived here, so the card can never promise
 * more or less than what will actually run if approved.
 *
 * `onGoAhead` (S3-T3, folding T2 review Important #2): an approved card does
 * not run itself (ruling S3-R4) — the model re-attempts it in a later turn,
 * which happens automatically only when the deciding conversation is the one
 * currently open and idle. When `onGoAhead` is given, an approved card shows
 * a "Go ahead" button that triggers that re-attempt explicitly, so approving
 * from the Approvals page (or while another turn was mid-stream) still has a
 * path to actually running the action. Omitted entirely — never shown
 * disabled — when there is nothing for it to do (a caller passes it only
 * while the card genuinely has not been resumed yet).
 */
export function ApprovalCard({
  card,
  onDecide,
  onGoAhead,
  busy,
  goAheadBusy,
}: {
  card: ConsentCard
  onDecide: (decision: 'approve' | 'deny') => void
  onGoAhead?: () => void
  busy?: boolean
  goAheadBusy?: boolean
}) {
  const decided = card.status !== 'pending'
  const canGoAhead = card.status === 'approved' && onGoAhead !== undefined

  return (
    <div
      data-testid={`approval-card-${card.consent_id}`}
      className="rounded-lg border border-warning/30 bg-warning-dim px-4 py-3 space-y-2"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-compact font-medium text-content-primary">Approval needed</span>
        <Badge size="sm">{card.action_class}</Badge>
      </div>
      <p className="text-compact text-content-secondary break-words">{card.summary}</p>
      {decided ? (
        <div className="flex items-center gap-2 pt-1">
          <Badge color={card.status === 'approved' ? 'success' : 'neutral'} size="sm">
            {card.status}
          </Badge>
          {canGoAhead && (
            <Button size="sm" onClick={onGoAhead} disabled={goAheadBusy}>
              Go ahead
            </Button>
          )}
        </div>
      ) : (
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => onDecide('approve')} disabled={busy}>
            Approve
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDecide('deny')} disabled={busy}>
            Deny
          </Button>
        </div>
      )}
    </div>
  )
}
