/**
 * Scenario 16 — Settings → Devices renders, grants, and decides REAL state.
 *
 * S5 DoD items 1, 2 and 4, the parts that do NOT depend on a live daemon. The
 * behaviour-changing halves — pair a REAL machine with the printed code, ask
 * Nova "read that file on <device>" / "open Firefox on <device>", deny/approve
 * and watch the daemon's own audit agree — need a novad holding an
 * authenticated socket, which is the OWNER's live gate (a real daemon on
 * Jeremy's laptop, walked after review; the exact build/enroll/run commands are
 * in task-5-report.md §"How to run the live walk"). What this scenario proves
 * deterministically is that the WEB surface reads and acts on real backend
 * state:
 *   - the pairing modal mints a real code and shows the enroll one-liner the
 *     owner runs on the device (DoD item 1);
 *   - a paired device's tile liveness is DERIVED from last_seen — a fresh
 *     heartbeat reads "online", a never-seen device reads "never connected",
 *     never a green dot (DoD items 1 & 5; the threshold logic is also pinned in
 *     T4's devicesFormat.test.ts);
 *   - the grants editor toggles a capability and the PUT lands in the database
 *     (DoD item 2 — grant it here and it flips live);
 *   - a device_run consent card renders on the Approvals page through the SAME
 *     ApprovalCard the inline chat card uses, and Deny / Approve drive the exact
 *     same consent path a text turn does (DoD item 4).
 *
 * Deterministic state is seeded straight into the project's postgres over the
 * docker socket (lib/devices.ts for the device rows, lib/policy.ts for the
 * pending consents) — the same place lib/evidence.ts READS the ledger, because
 * postgres is not published outside the compose network. So this needs NO live
 * daemon.
 *
 * **Authored in S5-T5 by reading the shipped components (DevicesSection.tsx,
 * devicesFormat.ts, ApprovalCard.tsx) for real selectors, NOT yet run** — the
 * real-stack policy forbids a throwaway isolated stack and there is no rebuilt
 * :3000 at authoring time. It runs for the first time, in file order alongside
 * 1-15, once the controller rebuilds the stack from this source. Treat a first
 * run the way scenario 6 was after S2-T4: read what actually happens before
 * trusting the selectors blind. Selectors reference the data-testids T4 shipped
 * on committed HEAD: `devices-skeleton`, the per-tile `device-<id>`, and the
 * shared `approval-card-<id>` (a rebuild serves committed source).
 */
import { expect, request, test } from '@playwright/test'
import { whoAmI } from '../lib/app'
import { config } from '../lib/env'
import { deviceCapabilities, deleteDevice, seedDevice } from '../lib/devices'
import { consentStatus, deleteConsent, seedPendingConsent } from '../lib/policy'

test.use({ storageState: config.storageStatePath })

const ONLINE_DEVICE = 'workstation'
const NEVER_DEVICE = 'spare-laptop'
// Exactly what policy._summary() computes for a device_run of these args, so the
// card the operator sees is the card the kernel would raise.
const RUN_ARGS = { device: ONLINE_DEVICE, argv: ['firefox'] }
const RUN_SUMMARY = `Run device_run with device=${ONLINE_DEVICE}, argv=["firefox"]`

test('devices: the Settings section pairs, grants, and decides real device state', async ({
  page,
}) => {
  const person = await whoAmI(page)

  // Two paired devices, seeded deterministically: one heartbeating (online), one
  // never seen. The online one is granted system.info only (the roadmap default)
  // so the grants editor has a capability to newly grant.
  const onlineId = await seedDevice({
    name: ONLINE_DEVICE,
    ownerPerson: person.id,
    capabilities: ['system.info'],
    lastSeen: 'now',
  })
  const neverId = await seedDevice({
    name: NEVER_DEVICE,
    ownerPerson: person.id,
    capabilities: ['system.info'],
    lastSeen: 'never',
  })
  // Two pending device_run cards (consent-tier): one to deny, one to approve.
  const denyId = await seedPendingConsent({
    actionClass: 'device_run',
    personId: person.id,
    args: RUN_ARGS,
    summary: RUN_SUMMARY,
  })
  const approveId = await seedPendingConsent({
    actionClass: 'device_run',
    personId: person.id,
    args: RUN_ARGS,
    summary: RUN_SUMMARY,
  })

  try {
    // ── the tiles render REAL liveness, derived from last_seen ───────────────
    await page.goto('/settings')
    const onlineTile = page.getByTestId(`device-${onlineId}`)
    const neverTile = page.getByTestId(`device-${neverId}`)
    await expect(onlineTile).toBeVisible()
    await expect(neverTile).toBeVisible()

    // A fresh last_seen → online. A never-seen device → "never connected", and
    // crucially NOT online (a never-seen device must never show a green dot).
    await expect(onlineTile).toContainText('online')
    await expect(neverTile).toContainText('never connected')
    await expect(
      neverTile.getByText('online', { exact: true }),
      'a never-seen device must not render as online (DoD item 5)',
    ).toHaveCount(0)

    // ── the pairing modal mints a real code + the enroll one-liner (DoD 1) ───
    await onlineTile.scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Pair a device' }).click()
    const modal = page.getByRole('dialog', { name: 'Pair a device' })
    await expect(modal).toBeVisible()
    // The code arrives from the real POST /api/v1/devices/pairing-code (an
    // 8-char code from the no-lookalikes alphabet), and the one-liner names THIS
    // origin — what the owner runs on the machine being paired.
    const oneLiner = modal.locator('code')
    await expect(oneLiner).toContainText(`novad enroll --server ${config.baseUrl}`)
    await expect(oneLiner).toContainText('--code ')
    // Close the modal (its close refetches the list) before editing grants.
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()

    // ── the grants editor grants a capability, and the PUT lands (DoD 2) ─────
    await onlineTile.getByRole('button', { name: 'Grants' }).click()
    // The fs.read box starts unchecked (default grant is system.info only);
    // clicking its label (the input is sr-only) toggles it on for THIS tile.
    await onlineTile.getByText('Read files (fs.read)').click()
    // An fs.* grant needs a root — Save is refused (client-side, and by core)
    // without one, so add the root the grant will be scoped to first.
    await onlineTile.getByLabel('New filesystem root').fill('/tmp')
    await onlineTile.getByRole('button', { name: 'Add root' }).click()
    await onlineTile.getByRole('button', { name: 'Save' }).click()

    // The edit hit the database, not just the DOM — read the row back.
    await expect
      .poll(async () => await deviceCapabilities(onlineId), {
        message: 'granting fs.read in the editor did not reach the devices row',
      })
      .toContain('fs.read')
    // The API's own view agrees (the kernel and tools read this live per call).
    const afterGrant = await page.request.get('/api/v1/devices')
    expect(afterGrant.ok(), `GET /api/v1/devices -> ${afterGrant.status()}`).toBeTruthy()
    const granted = ((await afterGrant.json()).devices as Array<{ id: string; capabilities: string[] }>).find(
      d => d.id === onlineId,
    )
    expect(granted, 'the granted device vanished from GET /api/v1/devices').toBeDefined()
    expect(granted!.capabilities).toContain('fs.read')

    // ── the device_run consent card renders and decides (DoD 4) ──────────────
    await page.goto('/chat')
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
    await page.getByRole('link', { name: 'Approvals' }).first().click()
    await expect(page).toHaveURL(/\/approvals$/)
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()

    const denyCard = page.getByTestId(`approval-card-${denyId}`)
    await expect(denyCard).toBeVisible()
    // The card promises EXACTLY what will run — the summary and the action class,
    // read verbatim off the seeded card (which is what the kernel would raise).
    await expect(denyCard).toContainText(RUN_SUMMARY)
    await expect(denyCard).toContainText('device_run')
    await expect(denyCard.getByRole('button', { name: 'Approve' })).toBeVisible()
    await expect(denyCard.getByRole('button', { name: 'Deny' })).toBeVisible()

    // Deciding requires auth: no session cookie -> 401 (same route as text).
    const anon = await request.newContext({ baseURL: config.baseUrl })
    const unauth = await anon.post(`/api/v1/consents/${denyId}/decide`, {
      data: { decision: 'approve' },
    })
    expect(
      unauth.status(),
      `an unauthenticated decide returned ${unauth.status()}, not 401`,
    ).toBe(401)
    await anon.dispose()
    expect(await consentStatus(denyId)).toBe('pending') // the refused call changed nothing

    // Deny through the UI: the card leaves the pending list and the DB says so.
    await denyCard.getByRole('button', { name: 'Deny' }).click()
    await expect(
      page.getByTestId(`approval-card-${denyId}`),
      'a denied device_run card must leave the pending list',
    ).toHaveCount(0)
    expect(
      await consentStatus(denyId),
      'the card was denied in the UI but the stored consent is not "denied"',
    ).toBe('denied')

    // The deny is in the operator's governance audit — the same ledger a text
    // turn's deny lands in (DoD item 4 / item 6 audit).
    const gov = await page.request.get('/api/v1/governance?action_class=device_run&limit=20')
    expect(gov.ok(), `GET /api/v1/governance -> ${gov.status()}`).toBeTruthy()
    const denied = (await gov.json()).events.filter(
      (e: { kind: string; meta: Record<string, unknown> }) =>
        e.kind === 'consent.decided' && e.meta?.decision === 'denied',
    )
    expect(denied.length, 'the deny produced no consent.decided{denied} event').toBeGreaterThan(0)

    // Approve through the UI: flips to 'approved', stays with a "Go ahead"
    // (ruling S3-R4 — approving runs nothing; the re-attempt does, which for a
    // device is the daemon actually executing, the owner's live gate).
    await page.goto('/approvals')
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    const approveCard = page.getByTestId(`approval-card-${approveId}`)
    await expect(approveCard).toBeVisible()
    await approveCard.getByRole('button', { name: 'Approve' }).click()
    await expect(approveCard.getByText('approved', { exact: true })).toBeVisible()
    await expect(approveCard.getByRole('button', { name: 'Go ahead' })).toBeVisible()
    expect(
      await consentStatus(approveId),
      'the card was approved in the UI but the stored consent is not "approved"',
    ).toBe('approved')
    // "Go ahead" is deliberately NOT clicked: it re-attempts device_run, which
    // reaches a real daemon — the owner's live gate, not a deterministic assert.
  } finally {
    await deleteConsent(denyId).catch(() => {})
    await deleteConsent(approveId).catch(() => {})
    await deleteDevice(onlineId).catch(() => {})
    await deleteDevice(neverId).catch(() => {})
  }
})
