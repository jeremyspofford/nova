/**
 * Scenario 11 — change the chat model from Settings, mid-session, no restart.
 *
 * AUTHORED IN S2e-T4, NOT YET RUN. The brief for this task is explicit that
 * the running stack (project `nova`) is the pre-T1 build — the Models
 * section this scenario drives is committed on rebuild/v4 but the running
 * `nova-web`/`nova-gateway` containers were built before it landed, so
 * there is nothing at :3000 for a browser to click yet. This task's own
 * mandate was API-level checks against the live gateway plus authoring —
 * driving a browser against a stack that cannot show the UI would not test
 * anything. The controller rebuilds the real stack (or `tests/e2e/
 * isolated.sh up`, which builds fresh from source) after review; that is
 * when this scenario runs for the first time, in file order alongside 1-10.
 *
 * Proves the S2e DoD item 1 exactly as worded: switch to another INSTALLED
 * model in Settings -> Models, and the NEXT chat turn's meta model is the
 * new one, without touching the wizard or restarting anything. Only one
 * model is installed at the point scenario 1 hands off (whatever
 * NOVA_E2E_MODEL was), so this scenario pulls a second, small curated slug
 * through the same Settings -> Models -> Pull control T1 added, which is
 * itself real coverage: the onboarding wizard's pull path (Downloading.tsx)
 * already runs in scenario 1, but Settings' own pull button
 * (ModelsSection.tsx's handlePull) had no browser coverage before this.
 */
import { expect, test } from '@playwright/test'
import { modelCard, sendMessage } from '../lib/app'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

test('change model: Settings switch reaches the next turn without a restart', async ({
  page,
}) => {
  test.setTimeout(config.pullTimeoutMs + config.replyTimeoutMs + 3 * 60 * 1000)

  const target = config.secondModel
  expect(
    target,
    'NOVA_E2E_SECOND_MODEL must differ from NOVA_E2E_MODEL — switching to the model already ' +
      'current would prove nothing about the switch.',
  ).not.toBe(config.model)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByTestId('current-chat-model')).toHaveText(config.model)

  // ── get the target model installed, however it currently stands ─────────
  const card = modelCard(page, target)
  await expect(
    card,
    `${target} is not offered in Settings -> Models — set NOVA_E2E_SECOND_MODEL to a slug ` +
      "this host's curated catalog actually lists",
  ).toBeVisible()

  const pullButton = card.getByRole('button', { name: 'Pull' })
  if (await pullButton.count()) {
    await pullButton.click()
    const done = card.getByText('Installed — pick "Use this model" above.')
    const failed = card.getByRole('alert')
    await expect(done.or(failed).first()).toBeVisible({ timeout: config.pullTimeoutMs })
    if (await failed.count()) {
      throw new Error(`pulling ${target} from Settings failed: ${(await failed.first().innerText()).trim()}`)
    }
  }

  // ── switch: the card offers "Use this model" only once installed ────────
  const useButton = card.getByRole('button', { name: 'Use this model' })
  await expect(useButton).toBeVisible()
  await useButton.click()

  // The switch is a plain settings write with no loading gate on the text
  // itself, so this is the write's own completion, not a guess at timing.
  await expect(page.getByTestId('current-chat-model')).toHaveText(target)
  await expect(card.getByText('Current', { exact: true })).toBeVisible()

  // ── the point of the scenario: a turn sent AFTER the switch, same session,
  // no reload, no restart — the header must name the NEW model ────────────
  //
  // Through the sidebar link, not page.goto(). A full navigation would
  // re-fetch everything from scratch, including the setting this scenario
  // just wrote — which would make the assertion below pass even if the
  // switch only ever took effect on reload. Clicking survives on the same
  // document, the same idiom 06-nav-survival.spec.ts uses and explains.
  await page.getByRole('link', { name: 'Chat' }).first().click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  const outcome = await sendMessage(page, 'Say your own name in one short sentence.')
  expect(outcome.kind, `the post-switch turn did not produce a reply: ${outcome.text}`).toBe(
    'reply',
  )
  console.log(`[scenario 11] ${target} replied: ${outcome.text.replace(/\s+/g, ' ').slice(0, 200)}`)

  await expect(page.getByTestId('chat-model')).toHaveText(target)
})
