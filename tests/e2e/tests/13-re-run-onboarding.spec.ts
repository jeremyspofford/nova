/**
 * Scenario 13 — re-run setup from Settings, and finish the wizard again.
 *
 * AUTHORED IN S2e-T4, NOT YET RUN — see 11-change-model.spec.ts's header for
 * why (the running stack predates the Settings -> Models section this
 * exercises alongside the wizard). Runs last, deliberately: it is the one
 * new scenario that leaves onboarding.completed false for a window, and
 * nothing after it in file order should have to account for that.
 *
 * Proves the S2e DoD item 3 exactly as worded, plus the detail the brief
 * calls out by name: the wizard it lands on has to be the resume shape
 * (Hardware first), never CreateAccount — re-running setup must not read as
 * "mint a second owner." apps/web/src/pages/onboarding/steps.ts's
 * initialStep(hasUsers) is what decides that, and this scenario checks the
 * screen, not just the setting.
 *
 * It then walks the wizard through to a finished /chat, the same shape as
 * scenario 1's tail end — re-running setup is meant to be a real, repeatable
 * action, not a one-way door that leaves the instance mid-wizard for
 * whatever runs (or whoever looks) next. The model step re-selects whatever
 * chat.model already reads as at the point this scenario starts (NOT a
 * fixed NOVA_E2E_MODEL) — scenario 11 may have switched it to
 * NOVA_E2E_SECOND_MODEL by the time this runs, and either way the weights
 * are already on disk, so Downloading takes the same "already installed"
 * fast path scenario 1's comment describes.
 */
import { expect, test } from '@playwright/test'
import { settingsMap, whoAmI } from '../lib/app'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

test('re-run onboarding: Settings clears it, the wizard resumes (not CreateAccount), and finishes', async ({
  page,
}) => {
  test.setTimeout(config.pullTimeoutMs + config.replyTimeoutMs + 5 * 60 * 1000)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  const before = await whoAmI(page)
  const currentModel = (await settingsMap(page))['chat.model'] as string
  expect(currentModel, 'chat.model is unset going into the re-run — nothing to re-select').toBeTruthy()

  await page.getByRole('button', { name: 'Re-run setup' }).click()

  // ── lands on the wizard; the owner account is intact, not re-minted ─────
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: 'Create your owner account' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'What this machine has' })).toBeVisible()

  const after = await whoAmI(page)
  expect(after.id, 'the signed-in person changed across re-run setup — a new owner was minted').toBe(
    before.id,
  )

  const settingsNow = await settingsMap(page)
  expect(
    settingsNow['onboarding.completed'],
    'the Settings action navigated to the wizard but never actually flipped onboarding.completed',
  ).toBe(false)

  // ── walk it back to finished, same shape as scenario 1's tail ───────────
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose an engine' })).toBeVisible()
  await page.getByRole('button', { name: /Bundled Ollama/ }).click()
  await page.getByRole('button', { name: 'Test and continue' }).click()

  await expect(page.getByRole('heading', { name: 'Pick a model' })).toBeVisible()
  await page.getByRole('button', { name: currentModel, exact: false }).first().click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Downloading the model' })).toBeVisible()
  const installed = page.getByRole('heading', { name: 'Model installed' })
  const refused = page.getByRole('alert')
  await expect(installed.or(refused).first()).toBeVisible({ timeout: config.pullTimeoutMs })
  if (await refused.count()) {
    throw new Error(
      `re-run setup's download step refused for an already-installed model: ` +
        `${(await refused.first().innerText()).trim()}`,
    )
  }
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(
    page.getByRole('heading', { name: 'One real answer, then you are done' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Say hello' }).click()
  const answering = page.getByRole('heading', { name: 'Nova is answering' })
  const checkFailed = page.getByRole('alert')
  await expect(answering.or(checkFailed).first()).toBeVisible({ timeout: config.replyTimeoutMs })
  if (await checkFailed.count()) {
    throw new Error(`re-run setup's Ready check failed: ${(await checkFailed.first().innerText()).trim()}`)
  }
  await page.getByRole('button', { name: 'Meet Nova' }).click()

  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  // ── healthy again: the instance is not left mid-wizard for whatever the
  // walk (or a person) does next ────────────────────────────────────────
  const settingsAfter = await settingsMap(page)
  expect(settingsAfter['onboarding.completed'], 'finishing the re-run did not restore the flag').toBe(
    true,
  )
})
