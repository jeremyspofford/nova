/**
 * The approval card shape core's policy kernel raises — verbatim from
 * services/core/app/consents.py's card_spec(), carried by the {"consent":
 * ...} SSE frame (streamChat.ts) and by GET/POST /api/v1/consents (api.ts).
 *
 * Kept in its own file, importing nothing, so both of those modules can
 * describe the same shape without importing each other: api.ts already
 * imports from streamChat.ts (failureReason), so streamChat.ts importing
 * back from api.ts would be a cycle.
 */
export interface ConsentCard {
  consent_id: string
  action_class: string
  args_hash: string
  args: Record<string, unknown>
  summary: string
  status: 'pending' | 'approved' | 'denied'
  conversation_id: string | null
  requested_by: { person_id: string; agent: string }
  created_at: string
  expires_at: string
}

/**
 * The re-attempt message sent on a successful approve (ruling S3-R4 +
 * chat-store.tsx's decideConsent): the kernel never runs the action at
 * approval time, so this is what nudges the model to re-issue the SAME call
 * — a real, visible chat message, not a hidden tool invocation. Naming the
 * exact summary keeps it concrete rather than a vague "go ahead" the model
 * has nothing to act on.
 */
export function continuationMessage(card: ConsentCard): string {
  return `You're approved: ${card.summary}. Please go ahead now.`
}
