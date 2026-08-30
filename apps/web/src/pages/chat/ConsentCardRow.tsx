import { useState } from 'react'
import { ApprovalCard } from '../../components/ApprovalCard'
import { useChatStore } from '../../stores/chat-store'
import type { ConsentCard } from '../../lib/consentCard'

/**
 * The inline chat transcript's wrapper around ApprovalCard: wires the
 * store's decideConsent (decide + the approve-continuation, see
 * stores/chat-store.tsx) to the card's buttons, and shows a decide failure
 * plainly rather than leaving the card looking like nothing happened — the
 * same "no fake success" stance the rest of this turn's UI takes.
 *
 * Go ahead (S3-T3): offered exactly while `card.status === 'approved'` AND
 * this store is idle. Idle is the mechanical signal for "not already
 * handled" — decideConsent's own auto-continue (when it fires) starts
 * streaming almost immediately, so the button disappears the instant that
 * happens; it stays offered when the auto-continue never fired at all (this
 * card was decided while a DIFFERENT turn was mid-stream). It never claims
 * to know whether the action already ran — only that nothing is running now.
 */
export function ConsentCardRow({ card }: { card: ConsentCard }) {
  const { state, decideConsent, resumeApprovedCard } = useChatStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [goAheadBusy, setGoAheadBusy] = useState(false)

  const handle = async (decision: 'approve' | 'deny') => {
    setBusy(true)
    setError(null)
    try {
      await decideConsent(card, decision)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleGoAhead = async () => {
    setGoAheadBusy(true)
    setError(null)
    try {
      await resumeApprovedCard(card)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGoAheadBusy(false)
    }
  }

  return (
    <div className="max-w-[85%] md:max-w-[75%]">
      <ApprovalCard
        card={card}
        onDecide={handle}
        busy={busy}
        onGoAhead={card.status === 'approved' && !state.streaming ? handleGoAhead : undefined}
        goAheadBusy={goAheadBusy}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-danger">
          Could not record that decision: {error}
        </p>
      )}
    </div>
  )
}
