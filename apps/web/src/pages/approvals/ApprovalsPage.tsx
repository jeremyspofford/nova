import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { EmptyState, Skeleton } from '../../components/ui'
import { ApprovalCard } from '../../components/ApprovalCard'
import { useChatStore } from '../../stores/chat-store'
import { getConsents as apiGetConsents, type ConsentCard } from '../../lib/api'

/**
 * The operator's cross-conversation window onto pending approval cards
 * (services/core/app/consents_api.py's GET, no conversation_id filter) —
 * v0.5.0-alpha's PendingApprovals.tsx is the layout's prior art; this
 * rewrites the data layer against S3's consents, not v3's capability calls.
 *
 * Deciding goes through the SAME store methods the inline chat card uses
 * (useChatStore().decideConsent/resumeApprovedCard) — not a second,
 * page-local decide path.
 *
 * Deny is terminal (ruling S3-R4) and leaves the pending list immediately —
 * a decided card is no longer PENDING, and there is nothing further for the
 * operator to do. Approve is NOT: deciding here almost never shares this
 * tab's open conversation, so decideConsent's own auto-continue essentially
 * never fires for this page (the T2 review's Important #2) — an approved
 * card stays visible with an explicit "Go ahead" (S3-T3) until the operator
 * actually triggers the re-attempt, so approving here can never look like it
 * ran when nothing has.
 */
interface ApprovalsApi {
  getConsents: typeof apiGetConsents
}

const DEFAULT_API: ApprovalsApi = { getConsents: apiGetConsents }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ApprovalsPage({ api = DEFAULT_API }: { api?: ApprovalsApi } = {}) {
  const navigate = useNavigate()
  const { decideConsent, resumeApprovedCard } = useChatStore()
  const [cards, setCards] = useState<ConsentCard[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [goAheadBusyId, setGoAheadBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    let live = true
    setLoadError(null)
    api
      .getConsents()
      .then(rows => {
        if (live) setCards(rows)
      })
      .catch(err => {
        if (live) setLoadError(reasonOf(err))
      })
    return () => {
      live = false
    }
  }, [api])

  useEffect(() => load(), [load])

  const handle = useCallback(
    async (card: ConsentCard, decision: 'approve' | 'deny') => {
      setBusyId(card.consent_id)
      setDecideError(null)
      try {
        const updated = await decideConsent(card, decision)
        if (decision === 'deny') {
          // Terminal — nothing left to do, so the row simply leaves the list.
          setCards(prev => (prev ?? []).filter(c => c.consent_id !== card.consent_id))
        } else {
          // Approved: stays visible (with Go ahead) until the re-attempt
          // actually runs — see this component's docstring.
          setCards(prev => (prev ?? []).map(c => (c.consent_id === card.consent_id ? updated : c)))
        }
      } catch (err) {
        setDecideError(reasonOf(err))
      } finally {
        setBusyId(null)
      }
    },
    [decideConsent],
  )

  const handleGoAhead = useCallback(
    async (card: ConsentCard) => {
      setGoAheadBusyId(card.consent_id)
      setDecideError(null)
      try {
        await resumeApprovedCard(card)
        // The re-attempt turn is now running (or about to) — leave this
        // page's stale-the-moment-it's-clicked row behind and go watch it.
        setCards(prev => (prev ?? []).filter(c => c.consent_id !== card.consent_id))
        navigate('/chat')
      } catch (err) {
        setDecideError(reasonOf(err))
      } finally {
        setGoAheadBusyId(null)
      }
    },
    [resumeApprovedCard, navigate],
  )

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Actions Nova is waiting on you to approve or deny before she runs them."
      />

      {loadError && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load approvals: {loadError}
        </div>
      )}
      {decideError && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not record that decision: {decideError}
        </div>
      )}

      {cards === null ? (
        !loadError && (
          <div data-testid="approvals-skeleton">
            <Skeleton lines={4} />
          </div>
        )
      ) : cards.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing waiting"
          description="Nova will ask here before doing anything that reaches outward, and inline in the chat where she asked."
        />
      ) : (
        <div className="space-y-4">
          {cards.map(card => (
            <ApprovalCard
              key={card.consent_id}
              card={card}
              busy={busyId === card.consent_id}
              onDecide={decision => handle(card, decision)}
              onGoAhead={card.status === 'approved' ? () => handleGoAhead(card) : undefined}
              goAheadBusy={goAheadBusyId === card.consent_id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
