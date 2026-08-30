/**
 * Deterministic policy-state seeding, for the card/autonomy/governance UI
 * scenarios (14, 15).
 *
 * The behaviour-changing halves of the S3 DoD — "ask Nova to fetch a URL and a
 * card appears", "approve it and the model re-attempts and it runs" — depend on
 * the serving model actually emitting a fetch_url tool call, which the small
 * curated model does unreliably (this README's scenarios 9/10 notes). Those
 * flows are the OWNER's live gate, walked against the rebuilt stack after
 * review. What these scenarios prove instead is that the UI renders and DECIDES
 * real backend state, and for that the state has to arrive deterministically,
 * not on a model's cooperation.
 *
 * So the rows are seeded where the database already is — inside the postgres
 * container over the docker socket, exactly as lib/evidence.ts READS the turn
 * ledger there (postgres is deliberately not published outside the compose
 * network). A raised consent, or an action class in a chosen disposition, is a
 * plain row; the UI then fetches it through the real authenticated API and the
 * scenario decides it through the real UI, so the assertion is on the app, not
 * on the seed. The values seeded are fixed test constants — no external input
 * reaches these statements.
 */
import { containerFor, execInContainer } from './docker'

/** Run one SQL statement inside the project's postgres container. `-t -A`
 * gives bare, unaligned output, so a RETURNING id comes back as just the id. */
async function sql(statement: string): Promise<string> {
  const postgres = await containerFor('postgres')
  const out = await execInContainer(postgres, [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nova_core',
    '-t',
    '-A',
    '-c',
    statement.replace(/\s+/g, ' ').trim(),
  ])
  return out.trim()
}

export interface SeedConsent {
  actionClass: string
  personId: string
  args: Record<string, unknown>
  summary: string
  /** Left NULL by default: the Approvals page shows every pending card
   * regardless of conversation, and a NULL conversation keeps decideConsent's
   * auto-continuation (which only fires for the open conversation) from
   * launching a model turn when the scenario clicks Approve. */
  conversationId?: string
}

/**
 * Insert one pending consent and return its id.
 *
 * args_hash is a fixed placeholder: nothing in the render-or-decide path this
 * scenario drives reads it (the burn that matches on args_hash is the
 * model-driven re-attempt, which is the live gate, not this). args and summary
 * are what the operator actually SEES on the card, so those are real.
 */
export async function seedPendingConsent(seed: SeedConsent): Promise<string> {
  const conv = seed.conversationId ? `'${seed.conversationId}'` : 'NULL'
  const argsJson = JSON.stringify(seed.args)
  return sql(`
    INSERT INTO consents
      (action_class, args_hash, requestor_person, requestor_agent,
       conversation_id, args, summary, expires_at)
    VALUES
      ('${seed.actionClass}', 'e2e-seed-hash', '${seed.personId}', 'chat',
       ${conv}, '${argsJson}'::jsonb, '${seed.summary}', now() + interval '1 hour')
    RETURNING id
  `)
}

/** The stored status of one consent — read after a UI decide to prove the
 * decision hit the database, not just the DOM. */
export async function consentStatus(id: string): Promise<string> {
  return sql(`SELECT status FROM consents WHERE id = '${id}'`)
}

export async function deleteConsent(id: string): Promise<void> {
  await sql(`DELETE FROM consents WHERE id = '${id}'`)
}

export interface SeedActionClass {
  actionClass: string
  disposition: 'auto' | 'consent' | 'deny'
  earned: boolean
  consecutiveSuccesses: number
  riskTier?: string
}

/**
 * Put an action class into a chosen disposition (idempotent). Dedicated test
 * classes are used so the walk's promotions/revokes never touch the migration
 * seed the kernel reads — the same isolation rationale test_policy_autonomy.py
 * documents on the backend.
 */
export async function seedActionClass(seed: SeedActionClass): Promise<void> {
  await sql(`
    INSERT INTO action_classes
      (action_class, risk_tier, disposition, earned, consecutive_successes)
    VALUES
      ('${seed.actionClass}', '${seed.riskTier ?? 'outward'}', '${seed.disposition}',
       ${seed.earned}, ${seed.consecutiveSuccesses})
    ON CONFLICT (action_class) DO UPDATE SET
      disposition = EXCLUDED.disposition,
      earned = EXCLUDED.earned,
      consecutive_successes = EXCLUDED.consecutive_successes,
      updated_at = now()
  `)
}

export async function deleteActionClass(actionClass: string): Promise<void> {
  await sql(`DELETE FROM action_classes WHERE action_class = '${actionClass}'`)
}
