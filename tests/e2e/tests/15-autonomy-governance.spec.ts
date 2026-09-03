/**
 * Scenario 15 — Settings -> Autonomy and the Governance audit render real state.
 *
 * S3 DoD items 3 and 4, the parts that do NOT depend on the model. Earning
 * autonomy for real needs N model-driven approve+run cycles (the small curated
 * model's fetch_url honesty is exactly what scenarios 9/10 show is unreliable),
 * so the full graduation is the OWNER's live walk after review. What this
 * proves deterministically is that the surfaces read and act on real backend
 * state:
 *   - Settings -> Autonomy shows each class's CURRENT disposition and, for a
 *     class still earning it, its REAL progress (consecutive_successes /
 *     graduation_runs straight off GET /api/v1/autonomy, never computed in the
 *     page);
 *   - an earned-auto class offers Revoke, and revoking calls the API and
 *     returns the class to consent (read back from GET /api/v1/autonomy, and
 *     the demotion is a governance event);
 *   - the Governance page lists decisions newest-first off GET
 *     /api/v1/governance, kind / action_class / actor / time per row.
 *
 * Two dedicated classes are seeded (lib/policy.ts) so the walk never mutates
 * the migration-seeded dispositions the kernel reads — the isolation rationale
 * test_policy_autonomy.py documents on the backend.
 *
 * **Authored in S3-T4 by reading the shipped components (AutonomySection.tsx,
 * GovernancePage.tsx) for real selectors, not yet run** — no rebuilt stack at
 * :3000 existed at authoring time; it runs for the first time, in file order,
 * once the controller rebuilds the stack. AutonomyRow carries no data-testid,
 * so its rows are located by the class name text they render (the shipped DOM),
 * per this suite's "read real selectors" precedent.
 *
 * Since 2026-09-03 the per-class rows sit behind a "Per-class (N)" disclosure
 * that is collapsed on every mount and absent from the DOM until opened (the
 * master control above it is what the owner sees first), so the walk expands
 * it before looking for a row.
 */
import { expect, test } from '@playwright/test'
import { config } from '../lib/env'
import { deleteActionClass, seedActionClass } from '../lib/policy'

test.use({ storageState: config.storageStatePath })

const EARNING = 'e2e_ui_progress' // consent-tier, part-way to graduation
const EARNED = 'e2e_ui_earned' // already promoted -> revocable
const PROGRESS = 2

interface AutonomyClass {
  action_class: string
  disposition: string
  earned: boolean
  consecutive_successes: number
  graduation_runs: number
}

test('autonomy + governance: the surfaces render and act on real policy state', async ({
  page,
}) => {
  await seedActionClass({
    actionClass: EARNING,
    disposition: 'consent',
    earned: false,
    consecutiveSuccesses: PROGRESS,
  })
  await seedActionClass({
    actionClass: EARNED,
    disposition: 'auto',
    earned: true,
    consecutiveSuccesses: 0,
  })

  try {
    // The real threshold, so the progress text is asserted against the API's
    // own number rather than a hardcoded 5.
    const state = await page.request.get('/api/v1/autonomy')
    expect(state.ok(), `GET /api/v1/autonomy -> ${state.status()}`).toBeTruthy()
    const classes = (await state.json()).classes as AutonomyClass[]
    const earning = classes.find(c => c.action_class === EARNING)
    expect(earning, `${EARNING} is missing from GET /api/v1/autonomy`).toBeDefined()
    expect(earning!.disposition).toBe('consent')
    const threshold = earning!.graduation_runs

    // ── Settings -> Autonomy renders both classes' real state ─────────────
    await page.goto('/settings')
    // The rows are collapsed (and unmounted) on every load — open them.
    const perClass = page.getByRole('button', { name: /^Per-class \(\d+\)$/ })
    await expect(perClass).toHaveAttribute('aria-expanded', 'false')
    await perClass.click()
    await expect(page.getByText(EARNED)).toBeVisible()

    // The earning class: consent, with its REAL progress toward graduation.
    const earningRow = page.locator('div.py-3', { hasText: EARNING })
    await expect(earningRow).toContainText('consent')
    await expect(
      earningRow,
      `the progress readout must be the stored counter over the real threshold ` +
        `(${PROGRESS} / ${threshold})`,
    ).toContainText(`${PROGRESS} / ${threshold} approved runs`)

    // The earned class: auto, badged earned, with a Revoke button. It is the
    // only earned-auto class the scenario seeds, so it is the row that offers
    // Revoke; a baseline-auto class (earned=false) offers none.
    const earnedRow = page.locator('div.py-3', { hasText: EARNED })
    await expect(earnedRow).toContainText('auto')
    await expect(earnedRow).toContainText('earned')
    const revoke = earnedRow.getByRole('button', { name: 'Revoke' })
    await expect(revoke).toBeVisible()

    // ── Revoke calls the API and returns the class to consent ─────────────
    await revoke.click()
    // The row re-renders off the API's new state: no longer auto, no Revoke.
    await expect(earnedRow).toContainText('consent')
    await expect(
      earnedRow.getByRole('button', { name: 'Revoke' }),
      'a revoked class must no longer offer Revoke — it is back to consent',
    ).toHaveCount(0)

    const after = await page.request.get('/api/v1/autonomy')
    const revoked = ((await after.json()).classes as AutonomyClass[]).find(
      c => c.action_class === EARNED,
    )
    expect(revoked!.disposition, 'the revoked class is not consent in GET /api/v1/autonomy').toBe(
      'consent',
    )
    expect(revoked!.earned).toBe(false)

    // ── the Governance audit page: newest-first, off the API ──────────────
    await page.goto('/chat')
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
    await page.getByRole('link', { name: 'Governance' }).first().click()
    await expect(page).toHaveURL(/\/governance$/)
    await expect(page.getByRole('heading', { name: 'Governance' })).toBeVisible()

    const gov = await page.request.get('/api/v1/governance?limit=50')
    expect(gov.ok(), `GET /api/v1/governance -> ${gov.status()}`).toBeTruthy()
    const events = (await gov.json()).events as Array<{
      id: string
      kind: string
      action_class: string | null
    }>
    expect(events.length, 'the ledger is empty after a revoke just happened').toBeGreaterThan(0)

    // Newest-first: the page's first row IS the API's newest event.
    await expect(
      page.locator('[data-testid^="governance-row-"]').first(),
      'the Governance page did not list the API\'s newest event first',
    ).toHaveAttribute('data-testid', `governance-row-${events[0].id}`)

    // The revoke we just made is in the audit, shown with its kind and class.
    const revokeEvent = events.find(
      e => e.kind === 'autonomy.revoked' && e.action_class === EARNED,
    )
    expect(revokeEvent, 'no autonomy.revoked event for the class just revoked').toBeDefined()
    const revokeRow = page.getByTestId(`governance-row-${revokeEvent!.id}`)
    await expect(revokeRow).toBeVisible()
    await expect(revokeRow).toContainText('autonomy.revoked')
    await expect(revokeRow).toContainText(EARNED)
  } finally {
    await deleteActionClass(EARNING).catch(() => {})
    await deleteActionClass(EARNED).catch(() => {})
  }
})
