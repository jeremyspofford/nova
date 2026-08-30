import { useCallback, useEffect, useState } from 'react'
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
 * Deciding goes through the SAME store method the inline chat card uses
 * (useChatStore().decideConsent) — not a second, page-local decide path —
 * so the approve→continuation reconciliation (ruling S3-R4: the kernel runs
 * nothing at decide time, only a re-attempt through the funnel does) applies
 * here exactly as it does inline, on the rare chance the decided card
 * belongs to the conversation currently open in this same tab.
 *
 * `api` is the same dependency-injection seam as ActivityPage's: production
 * uses the real client, tests inject a fake.
 */
interface ApprovalsApi {
  getConsents: typeof apiGetConsents
}

const DEFAULT_API: ApprovalsApi = { getConsents: apiGetConsents }

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ApprovalsPage({ api = DEFAULT_API }: { api?: ApprovalsApi } = {}) {
  const { decideConsent } = useChatStore()
  const [cards, setCards] = useState<ConsentCard[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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
        await decideConsent(card, decision)
        // Decided cards are no longer PENDING — this page only ever shows
        // the pending set, so the row simply leaves the list.
        setCards(prev => (prev ?? []).filter(c => c.consent_id !== card.consent_id))
      } catch (err) {
        setDecideError(reasonOf(err))
      } finally {
        setBusyId(null)
      }
    },
    [decideConsent],
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
