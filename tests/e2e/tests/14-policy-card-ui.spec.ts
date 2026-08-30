/**
 * Scenario 14 — the approval card renders and decides REAL state.
 *
 * S3 DoD items 1 and 4, the parts that do NOT depend on the model. The
 * behaviour-changing halves — "ask Nova to fetch a URL and a card appears
 * inline in chat", "approve it and the model re-attempts and it runs" — need
 * the serving model to emit a fetch_url tool call, which the small curated
 * model does unreliably (see this suite's README on scenarios 9/10). Those are
 * the OWNER's live walk against the rebuilt stack after review, documented in
 * the README's "S3 policy DoD walk" section, not faked here.
 *
 * What IS deterministic, and is what this scenario proves:
 *   - a pending consent (seeded straight into postgres, lib/policy.ts) shows on
 *     the Approvals page through the real authenticated GET /api/v1/consents,
 *     rendered by the SAME ApprovalCard component the inline chat card uses,
 *     with the EXACT args summary the kernel would compute and Approve/Deny;
 *   - deciding requires auth — POST .../decide with no session is 401;
 *   - Deny resolves it and it LEAVES the pending list, and the stored row is
 *     'denied' (read back from the DB, not inferred from the DOM), and the
 *     decision is in the governance audit;
 *   - Approve flips the card to 'approved' (stored 'approved' too) and it stays
 *     with a "Go ahead" — approving runs nothing at the kernel (ruling S3-R4);
 *     the re-attempt that actually runs it is the live gate.
 *
 * **Authored in S3-T4 by reading the shipped components (ConsentCardRow.tsx,
 * ApprovalCard.tsx, ApprovalsPage.tsx) for real selectors, not yet run** — at
 * authoring time there was no rebuilt stack at :3000 to exercise; it runs for
 * the first time, in file order, once the controller rebuilds the stack. See
 * the README's scenarios-11-13 note for this suite's "read before trusting
 * selectors blind" precedent.
 */
import { expect, request, test } from '@playwright/test'
import { whoAmI } from '../lib/app'
import { config } from '../lib/env'
import { consentStatus, deleteConsent, seedPendingConsent } from '../lib/policy'

test.use({ storageState: config.storageStatePath })

const URL = 'https://example.com/pricing'
// Exactly what policy._summary() computes from these args, so the card the
// operator sees is the card the kernel would have raised.
const SUMMARY = `Run fetch_url with url=${URL}`

test('policy cards: the Approvals page renders and decides real consent state', async ({ page }) => {
  const person = await whoAmI(page)

  // ── seed two pending cards: one to deny, one to approve ─────────────────
  const denyId = await seedPendingConsent({
    actionClass: 'fetch_url',
    personId: person.id,
    args: { url: URL },
    summary: SUMMARY,
  })
  const approveId = await seedPendingConsent({
    actionClass: 'fetch_url',
    personId: person.id,
    args: { url: URL },
    summary: SUMMARY,
  })

  try {
    // ── reachable by navigation, and rendering the real card ──────────────
    await page.goto('/chat')
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
    await page.getByRole('link', { name: 'Approvals' }).first().click()
    await expect(page).toHaveURL(/\/approvals$/)
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()

    const denyCard = page.getByTestId(`approval-card-${denyId}`)
    await expect(denyCard).toBeVisible()
    // The exact args summary, and the action-class badge — the card promises
    // exactly what will run, never more (ApprovalCard reads card.summary
    // verbatim from the kernel).
    await expect(denyCard).toContainText(SUMMARY)
    await expect(denyCard).toContainText('fetch_url')
    await expect(denyCard.getByRole('button', { name: 'Approve' })).toBeVisible()
    await expect(denyCard.getByRole('button', { name: 'Deny' })).toBeVisible()

    // ── deciding requires auth: no session cookie -> 401 ──────────────────
    const anon = await request.newContext({ baseURL: config.baseUrl })
    const unauth = await anon.post(`/api/v1/consents/${denyId}/decide`, {
      data: { decision: 'approve' },
    })
    expect(
      unauth.status(),
      `an unauthenticated decide returned ${unauth.status()}, not 401 — the decide route must ` +
        'refuse an anonymous caller (services/core/app/consents_api.py requires an identity)',
    ).toBe(401)
    await anon.dispose()
    // The refused call changed nothing: still pending in the DB.
    expect(await consentStatus(denyId)).toBe('pending')

    // ── Deny through the UI: leaves the list, and the DB says 'denied' ────
    await denyCard.getByRole('button', { name: 'Deny' }).click()
    await expect(
      page.getByTestId(`approval-card-${denyId}`),
      'a denied card must leave the pending list (ApprovalsPage filters it out) — it did not',
    ).toHaveCount(0)
    expect(
      await consentStatus(denyId),
      'the card was denied in the UI but the stored consent is not "denied" — the decision did ' +
        'not reach the database',
    ).toBe('denied')

    // The decision is in the operator's governance audit (DoD item 4).
    const gov = await page.request.get('/api/v1/governance?action_class=fetch_url&limit=20')
    expect(gov.ok(), `GET /api/v1/governance -> ${gov.status()}`).toBeTruthy()
    const decided = (await gov.json()).events.filter(
      (e: { kind: string; meta: Record<string, unknown> }) =>
        e.kind === 'consent.decided' && e.meta?.decision === 'denied',
    )
    expect(
      decided.length,
      'the deny produced no consent.decided{denied} governance event',
    ).toBeGreaterThan(0)

    // ── Approve through the UI: flips to 'approved', stays with Go ahead ───
    // A fresh load so the approve card is the only decision left to make.
    await page.goto('/approvals')
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    const approveCard = page.getByTestId(`approval-card-${approveId}`)
    await expect(approveCard).toBeVisible()
    await approveCard.getByRole('button', { name: 'Approve' }).click()

    // Approved cards are NOT terminal on this page — they stay, showing the
    // approved status and a "Go ahead" (ruling S3-R4: the decision runs
    // nothing; the re-attempt does, and that is the live gate).
    await expect(approveCard.getByText('approved', { exact: true })).toBeVisible()
    await expect(approveCard.getByRole('button', { name: 'Go ahead' })).toBeVisible()
    expect(
      await consentStatus(approveId),
      'the card was approved in the UI but the stored consent is not "approved"',
    ).toBe('approved')
    // NOT burned by the approval alone — used_at stays NULL until the funnel
    // re-checks on a re-attempt. Proven mechanically in test_policy_e2e.py; the
    // "Go ahead" button here is deliberately NOT clicked, because that launches
    // a real model turn — the owner's live gate.
  } finally {
    // Tidy the seeded rows; the walk does not depend on this running.
    await deleteConsent(denyId).catch(() => {})
    await deleteConsent(approveId).catch(() => {})
  }
})
