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
 */
export function ConsentCardRow({ card }: { card: ConsentCard }) {
  const { decideConsent } = useChatStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="max-w-[85%] md:max-w-[75%]">
      <ApprovalCard card={card} onDecide={handle} busy={busy} />
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-danger">
          Could not record that decision: {error}
        </p>
      )}
    </div>
  )
}
