/**
 * Scenario 11 — change the chat model from Models, mid-session, no restart.
 *
 * MOVED 2026-10-05 from Settings -> Models' own model cards, which are gone
 * (the Models page is the one model list; a pick there is the same pick
 * write the chat switcher and Settings -> Routing make). Still not run: the
 * e2e job is off in CI, see .github/workflows/rebuild-ci.yml.
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
import { modelRow, sendMessage } from '../lib/app'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

test('change model: a pick on Models reaches the next turn without a restart', async ({
  page,
}) => {
  test.setTimeout(config.pullTimeoutMs + config.replyTimeoutMs + 3 * 60 * 1000)

  const target = config.secondModel
  expect(
    target,
    'NOVA_E2E_SECOND_MODEL must differ from NOVA_E2E_MODEL — switching to the model already ' +
      'current would prove nothing about the switch.',
  ).not.toBe(config.model)
  const installed = `hub:${target}`
  const library = `library:${target}`

  await page.goto('/models')
  // Titled "Model catalog" since the page moved into Settings (2026-10-08).
  await expect(page.getByRole('heading', { name: 'Model catalog' })).toBeVisible()

  // ── get the target model installed, however it currently stands ─────────
  await page.getByRole('button', { name: /^All/ }).click()
  const pull = page.getByRole('button', { name: `pull ${library}` })
  if (await pull.count()) {
    await pull.click()
    const panel = page.getByTestId('pull-panel')
    await expect(panel.getByText(/installed|failed|refused|error/i).first()).toBeVisible({
      timeout: config.pullTimeoutMs,
    })
    const said = (await panel.innerText()).trim()
    if (!/installed/.test(said) || /failed|refused|error/i.test(said)) {
      throw new Error(`pulling ${target} from Models failed: ${said}`)
    }
  }

  // ── switch: Use on the installed row makes it chat's primary ─────────────
  await page.getByRole('button', { name: /^Installed/ }).click()
  await page.getByRole('button', { name: `use ${installed}` }).click()
  await expect(modelRow(page, installed).getByText('primary', { exact: true })).toBeVisible()

  // ── the point of the scenario: a turn sent AFTER the switch, same session,
  // no reload, no restart — the switcher must name the NEW model ──────────
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
