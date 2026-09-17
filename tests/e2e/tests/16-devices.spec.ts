/**
 * Scenario 16 — Settings → Devices renders and acts on REAL device state.
 *
 * S5 DoD items 1, 2 and 5, the parts that do NOT depend on a live daemon. The
 * behaviour-changing halves — pair a REAL machine with the printed code, ask
 * Nova "read that file on <device>" / "open Firefox on <device>" and watch the
 * daemon's own audit agree — need a novad holding an authenticated socket,
 * which is the OWNER's live gate (a real daemon on Jeremy's laptop, walked after
 * review; the exact build/enroll/run commands are in task-5-report.md §"How to
 * run the live walk"). What this scenario proves deterministically is that the
 * WEB surface reads and acts on real backend state:
 *   - the pairing modal mints a real code and shows the enroll one-liner the
 *     owner runs on the device (DoD item 1);
 *   - a paired device's tile liveness is DERIVED from last_seen — a fresh
 *     heartbeat reads "online", a never-seen device reads "never connected",
 *     never a green dot (DoD items 1 & 5; the threshold logic is also pinned in
 *     T4's devicesFormat.test.ts);
 *   - a tile offers exactly rename and Revoke — there is NO grants editor,
 *     because there is no grant: pairing is the whole authorization (owner
 *     ruling 2026-09-03), and this is the line that reddens if one grows back;
 *   - Revoke through the UI stamps the row (read back from the database), the
 *     tile flips to "revoked" with its controls gone, and the Governance page
 *     lists the `device.revoked` event — a RECORD of what happened, never a
 *     decision (DoD item 2's surviving half).
 *
 * Deterministic state is seeded straight into the project's postgres over the
 * docker socket (lib/devices.ts) — the same place lib/evidence.ts READS the
 * ledger, because postgres is not published outside the compose network. So
 * this needs NO live daemon.
 *
 * **Authored in S5-T5 by reading the shipped components (DevicesSection.tsx,
 * devicesFormat.ts, GovernancePage.tsx) for real selectors, NOT yet run**; the
 * consent half it used to carry was removed 2026-09-03 with the approval
 * system, and the revoke walk was authored in its place the same way. It runs
 * for the first time, in file order alongside 1-13, once the controller
 * rebuilds the stack from this source. Treat a first run the way scenario 6 was
 * after S2-T4: read what actually happens before trusting the selectors blind.
 * Selectors reference the data-testids the shipped source carries:
 * `devices-skeleton`, the per-tile `device-<id>`, and `governance-row-<id>`.
 */
import { expect, request, test } from '@playwright/test'
import { whoAmI } from '../lib/app'
import { config } from '../lib/env'
import { deleteDevice, deviceRevokedAt, seedDevice } from '../lib/devices'

test.use({ storageState: config.storageStatePath })

const ONLINE_DEVICE = 'workstation'
const NEVER_DEVICE = 'spare-laptop'

test('devices: the Settings section pairs, shows, and revokes real device state', async ({
  page,
}) => {
  const person = await whoAmI(page)

  // Two paired devices, seeded deterministically: one heartbeating (online), one
  // never seen. Identity and liveness only — a device row carries no grant.
  const onlineId = await seedDevice({
    name: ONLINE_DEVICE,
    ownerPerson: person.id,
    lastSeen: 'now',
  })
  const neverId = await seedDevice({
    name: NEVER_DEVICE,
    ownerPerson: person.id,
    lastSeen: 'never',
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

    // ── no grants editor: pairing is the whole authorization ─────────────────
    await expect(onlineTile.getByRole('button', { name: 'Rename' })).toBeVisible()
    await expect(onlineTile.getByRole('button', { name: 'Revoke' })).toBeVisible()
    await expect(
      onlineTile.getByRole('button', { name: 'Grants' }),
      'a paired device must not carry a grants control — there is no grant (owner ruling 2026-09-03)',
    ).toHaveCount(0)
    await expect(onlineTile.getByRole('checkbox')).toHaveCount(0)
    // The API's own view agrees: the device carries identity + liveness, and no
    // capability or root column survives for a UI to edit.
    const listed = await page.request.get('/api/v1/devices')
    expect(listed.ok(), `GET /api/v1/devices -> ${listed.status()}`).toBeTruthy()
    const online = ((await listed.json()).devices as Array<Record<string, unknown>>).find(
      d => d.id === onlineId,
    )
    expect(online, 'the seeded device vanished from GET /api/v1/devices').toBeDefined()
    expect(Object.keys(online!).sort()).toEqual(
      ['connected', 'enrolled_at', 'hostname', 'id', 'last_seen', 'name', 'platform', 'revoked_at'],
    )

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
    // Close the modal (its close refetches the list) before revoking.
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()

    // ── revoke through the UI: the row is stamped, the tile flips, the ledger
    //    records it (a record of what happened, never a gate) ─────────────────
    // Revoking requires auth: no session cookie -> 401, and the row is untouched.
    const anon = await request.newContext({ baseURL: config.baseUrl })
    const unauth = await anon.post(`/api/v1/devices/${neverId}/revoke`)
    expect(
      unauth.status(),
      `an unauthenticated revoke returned ${unauth.status()}, not 401`,
    ).toBe(401)
    await anon.dispose()
    expect(await deviceRevokedAt(neverId), 'the refused revoke changed the row').toBe('')

    // One click asks for a confirm; the confirm is what calls the API.
    await neverTile.getByRole('button', { name: 'Revoke' }).click()
    expect(await deviceRevokedAt(neverId), 'a bare Revoke click must not revoke').toBe('')
    await neverTile.getByRole('button', { name: 'Confirm revoke' }).click()

    // The tile flips to the revoked rendering and loses its controls; the
    // database says so too (the edit hit the row, not just the DOM).
    await expect(neverTile).toContainText('revoked')
    await expect(neverTile.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
    await expect(neverTile.getByRole('button', { name: 'Rename' })).toHaveCount(0)
    await expect
      .poll(async () => await deviceRevokedAt(neverId), {
        message: 'revoking in the UI did not stamp devices.revoked_at',
      })
      .not.toBe('')

    // The revoke is in the operator's governance ledger — the same append-only
    // record enrol writes to — with the device as its subject.
    const gov = await page.request.get('/api/v1/governance?limit=20')
    expect(gov.ok(), `GET /api/v1/governance -> ${gov.status()}`).toBeTruthy()
    const revokedEvents = (
      (await gov.json()).events as Array<{ id: string; kind: string; subject_ref: string | null }>
    ).filter(e => e.kind === 'device.revoked' && e.subject_ref === neverId)
    expect(revokedEvents.length, 'the revoke produced no device.revoked event').toBe(1)

    // And the Governance page renders that row, verbatim, reachable by nav.
    await page.getByRole('link', { name: 'Governance' }).first().click()
    await expect(page).toHaveURL(/\/governance$/)
    await expect(page.getByRole('heading', { name: 'Governance' })).toBeVisible()
    const row = page.getByTestId(`governance-row-${revokedEvents[0].id}`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('device.revoked')
  } finally {
    await deleteDevice(onlineId).catch(() => {})
    await deleteDevice(neverId).catch(() => {})
  }
})
