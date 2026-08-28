/**
 * Scenario 4 — the design system renders, dark and light.
 *
 * The gallery is the visual gate for the ported primitives: if a component
 * throws or renders to nothing, its section is missing and the count drops.
 * The screenshots are the diff surface — the first run writes the baselines,
 * every later run compares against them.
 */
import { expect, test } from '@playwright/test'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

const SPEC_TEAL_500 = '25 168 158' // #19A89E, DESIGN.md's accent

for (const mode of ['dark', 'light'] as const) {
  test(`gallery: every primitive renders in ${mode} mode`, async ({ page }) => {
    // The theme store reads this at first render, so it has to be in place
    // before the app boots — not toggled afterwards.
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      ['nova-appearance', JSON.stringify({ modePreference: mode })],
    )

    await page.goto('/dev/components')
    await expect(page.getByRole('heading', { name: 'Component Gallery' })).toBeVisible()

    const sections = page.locator('section > div > h2')
    const count = await sections.count()
    expect(count, `only ${count} primitive sections rendered`).toBeGreaterThanOrEqual(30)

    // The mode really is the one under test, and the spec accent is live.
    const applied = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      accent500: getComputedStyle(document.documentElement).getPropertyValue('--accent-500').trim(),
    }))
    expect(applied.dark).toBe(mode === 'dark')
    expect(applied.accent500).toBe(SPEC_TEAL_500)

    // Fonts and any lazy image work settle before the pixels are compared.
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot(`gallery-${mode}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    })

    console.log(`[scenario 4] ${mode}: ${count} primitive sections, accent ${applied.accent500}`)
  })
}

test('gallery: the model this instance serves is unaffected by the theme walk', async ({ page }) => {
  // Cheap guard against the theme scenario having navigated somewhere with
  // side effects: chat must still be the app's landing route.
  await page.goto('/')
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByTestId('chat-model')).toHaveText(config.model)
})
