/**
 * Scenario 1 — the fresh-install wizard walk.
 *
 * Verifies the S1 definition of done, item 1: a fresh instance goes Welcome →
 * owner account → hardware → engine → model → download → a REAL streamed
 * reply, and only then offers the door into the app.
 *
 * This scenario mints the instance's one and only owner, so it can only run
 * against a fresh instance. It refuses (loudly, with the reset command) on an
 * instance that already has one, rather than skipping — a walk that quietly
 * did not happen must not read as a green run.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, test } from '@playwright/test'
import { config } from '../lib/env'

test.describe.configure({ mode: 'serial' })

test('fresh install: wizard walk ends in a real streamed reply', async ({ page }) => {
  test.setTimeout(config.pullTimeoutMs + 10 * 60 * 1000)

  // ── a credential was chosen by a person, not by this repository ─────────
  // Whatever password is used here becomes the instance's permanent owner
  // credential, because core closes registration after the first account.
  // There is no default for that, so refuse rather than invent one.
  expect(
    config.ownerPassword,
    'NOVA_E2E_OWNER_PASSWORD is unset. This walk creates the instance\'s one and only owner ' +
      'account, and that password is the one it keeps — so it has to be yours, not a default ' +
      'committed to this repo. Set it and re-run, e.g. NOVA_E2E_OWNER_PASSWORD=... (see ' +
      'tests/e2e/README.md).',
  ).not.toBe('')

  // ── the instance really is fresh ────────────────────────────────────────
  const state = await page.request.get('/api/v1/auth/state')
  expect(state.ok(), `GET /api/v1/auth/state -> ${state.status()}`).toBeTruthy()
  const { has_users: hasUsers } = await state.json()
  expect(
    hasUsers,
    'this instance already has an owner, so the first-run wizard cannot be walked. ' +
      'Reset it first: tests/e2e/reset-fresh.sh (see tests/e2e/README.md).',
  ).toBe(false)

  // ── welcome ─────────────────────────────────────────────────────────────
  await page.goto('/')
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: 'Welcome to Nova' })).toBeVisible()
  await page.getByRole('button', { name: 'Get started' }).click()

  // ── owner account ───────────────────────────────────────────────────────
  await expect(page.getByRole('heading', { name: 'Create your owner account' })).toBeVisible()
  await page.getByLabel('Your name').fill(config.ownerName)
  await page.getByLabel('Password', { exact: true }).fill(config.ownerPassword)
  await page.getByLabel('Confirm password').fill(config.ownerPassword)
  await page.getByRole('button', { name: 'Create account and continue' }).click()

  // ── timezone (S9): the browser's zone is preselected; Continue writes it ──
  await expect(page.getByRole('heading', { name: 'Where does Nova keep time?' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // ── hardware: the cards must carry what hardware.json actually says ─────
  await expect(page.getByRole('heading', { name: 'What this machine has' })).toBeVisible()
  const hardwareResponse = await page.request.get('/api/v1/system/hardware')
  expect(
    hardwareResponse.ok(),
    `GET /api/v1/system/hardware -> ${hardwareResponse.status()}`,
  ).toBeTruthy()
  const hardware = await hardwareResponse.json()
  expect(
    hardware.note,
    `the gateway could not read hardware.json: ${hardware.note} — install.sh writes it`,
  ).toBeUndefined()

  for (const gpu of hardware.gpus ?? []) {
    await expect(page.getByText(gpu.name, { exact: false })).toBeVisible()
    const vramGb = Math.round((gpu.vram_mb / 1024) * 10) / 10
    await expect(page.getByText(`${vramGb} GB VRAM`)).toBeVisible()
  }
  const ramGb = Math.round((hardware.ram_mb / 1024) * 10) / 10
  await expect(page.getByText(`${ramGb} GB RAM`)).toBeVisible()
  await expect(page.getByText(`${hardware.disk_free_gb} GB free disk`)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // ── engine: bundled ollama must be offered, and must verify live ────────
  await expect(page.getByRole('heading', { name: 'Choose an engine' })).toBeVisible()
  const bundled = page.getByRole('button', { name: /Bundled Ollama/ })
  await expect(
    bundled,
    'the bundled engine was filtered out of the list, which means core refused it — ' +
      'the ollama container is not up or not reachable from the gateway',
  ).toBeVisible()
  await bundled.click()
  await page.getByRole('button', { name: 'Test and continue' }).click()

  // ── model: the tier's real suggestions, and the one this run wants ──────
  await expect(page.getByRole('heading', { name: 'Pick a model' })).toBeVisible()
  const suggestion = await (await page.request.get('/api/v1/models/suggest')).json()
  await expect(page.getByText(suggestion.rationale, { exact: false })).toBeVisible()
  const offered: string[] = suggestion.models.map((m: { slug: string }) => m.slug)
  expect(
    offered,
    `NOVA_E2E_MODEL=${config.model} is not offered at this host's ${suggestion.tier} tier ` +
      `(offered: ${offered.join(', ') || 'none'}) — set NOVA_E2E_MODEL to one the wizard lists`,
  ).toContain(config.model)
  await page.getByRole('button', { name: config.model, exact: false }).first().click()
  await page.getByRole('button', { name: 'Continue' }).click()

  // ── download: real progress, and a completion the UI saw ollama report ──
  await expect(page.getByRole('heading', { name: 'Downloading the model' })).toBeVisible()
  // Whichever comes first: bytes moving, or the step finishing. On a first
  // pull the byte counter is what shows up; on a host that already has the
  // weights ollama answers success almost immediately and there are no bytes
  // to count. Requiring the counter would fail the second case for being
  // fast, so the completion below is the assertion and this is an observation.
  const progress = page.getByText(/of .*(KB|MB|GB)/)
  const installed = page.getByRole('heading', { name: 'Model installed' })
  // A refused pull is stated on this step immediately. Racing it in means the
  // reason is quoted the second it appears instead of hidden behind a
  // five-minute wait that ends in "nothing became visible".
  const refused = page.getByRole('alert')
  await expect(progress.or(installed).or(refused).first()).toBeVisible({ timeout: 5 * 60 * 1000 })
  if (await refused.count()) {
    throw new Error(`the download step refused: ${(await refused.first().innerText()).trim()}`)
  }
  const downloadedBytes = await progress.count()
  console.log(
    `[scenario 1] ${downloadedBytes ? 'weights downloaded (byte progress seen)' : 'weights already present — no bytes to pull'}`,
  )
  await expect(installed).toBeVisible({ timeout: config.pullTimeoutMs })
  await expect(page.getByText('Installed and set as the chat model.')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // ── ready: the finish button cannot exist before the model speaks ───────
  await expect(
    page.getByRole('heading', { name: 'One real answer, then you are done' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Meet Nova' }),
    'the finish button was reachable before any inference happened',
  ).toHaveCount(0)

  await page.getByRole('button', { name: 'Say hello' }).click()
  const answering = page.getByRole('heading', { name: 'Nova is answering' })
  const checkFailed = page.getByRole('alert')
  await expect(answering.or(checkFailed).first()).toBeVisible({ timeout: config.replyTimeoutMs })
  if (await checkFailed.count()) {
    throw new Error(`the Ready check failed: ${(await checkFailed.first().innerText()).trim()}`)
  }
  await expect(answering).toBeVisible()
  const saysLabel = page.getByText(/says$/)
  await expect(saysLabel).toContainText(config.model)
  // The reply is the paragraph under that label, and it has to have words in it.
  const reply = (await saysLabel.locator('xpath=following-sibling::p[1]').innerText()).trim()
  expect(reply.length, `the Ready step showed an empty reply: ${JSON.stringify(reply)}`).toBeGreaterThan(0)
  console.log(`[scenario 1] ${config.model} said: ${reply.replace(/\s+/g, ' ').slice(0, 200)}`)

  await expect(page.getByRole('button', { name: 'Meet Nova' })).toBeVisible()
  await page.getByRole('button', { name: 'Meet Nova' }).click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  // The owner session the rest of the walk signs in with.
  mkdirSync(dirname(config.storageStatePath), { recursive: true })
  await page.context().storageState({ path: config.storageStatePath })
})
