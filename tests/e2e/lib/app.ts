/**
 * The handful of page interactions more than one scenario needs.
 *
 * Locators go through the data-testid hooks the chat surface carries, not
 * through class names: a transcript row that is an error must be
 * distinguishable from one that is speech by something the app asserts about
 * itself, because "is this an error or did the model say it" is the exact
 * question scenario 5 exists to answer.
 */
import { expect, type Page } from '@playwright/test'
import { config } from './env'

export const userBubbles = (page: Page) => page.getByTestId('message-user')
export const assistantBubbles = (page: Page) => page.getByTestId('message-assistant')
export const errorRows = (page: Page) => page.getByTestId('message-error')

/** Who the browser is signed in as, straight from core. */
export async function whoAmI(page: Page): Promise<{ id: string; name: string; role: string }> {
  const res = await page.request.get('/api/v1/auth/me')
  expect(res.ok(), `GET /api/v1/auth/me -> ${res.status()}`).toBeTruthy()
  return (await res.json()).person
}

export async function settingsMap(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/v1/settings')
  expect(res.ok(), `GET /api/v1/settings -> ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { settings: Array<{ key: string; value: unknown }> }
  return Object.fromEntries(body.settings.map(s => [s.key, s.value]))
}

/**
 * Send a message and wait for the turn to settle.
 *
 * Settled means one of two visible outcomes: an assistant bubble that has
 * text, or a stated error row. It deliberately does NOT resolve on "the
 * bubble exists" — an empty bubble is the failure mode being tested for, so
 * waiting on presence alone would call it a pass.
 */
export async function sendMessage(page: Page, text: string, timeoutMs = config.replyTimeoutMs) {
  const before = await errorRows(page).count()
  const beforeUsers = await userBubbles(page).count()
  await page.getByLabel('Message Nova').fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
  // The reducer adds the user row and the pending assistant row in the same
  // dispatch, so waiting for the user row is waiting for the turn to have
  // started — without it the settle loop below could read the pre-click state
  // and call an unstarted turn finished.
  await expect(userBubbles(page)).toHaveCount(beforeUsers + 1)

  const surface = page.getByTestId('chat-page')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // data-streaming is the reducer's own `streaming` flag, so "the turn is
    // over" is the app's statement, not a guess from how the text looks.
    const streaming = (await surface.getAttribute('data-streaming')) === 'true'
    if (!streaming) {
      const errors = await errorRows(page).allInnerTexts()
      if (errors.length > before) {
        return { kind: 'error' as const, text: errors[errors.length - 1].trim() }
      }
      const replies = (await assistantBubbles(page).allInnerTexts()).map(t => t.trim())
      const last = replies[replies.length - 1] ?? ''
      // An empty bubble on a finished turn is exactly the defect scenario 5
      // looks for, so it is returned as itself rather than waited out.
      return { kind: last ? ('reply' as const) : ('empty' as const), text: last }
    }
    if (Date.now() > deadline) {
      const partial = (await assistantBubbles(page).allInnerTexts()).pop() ?? ''
      throw new Error(
        `the turn was still streaming after ${timeoutMs}ms — partial reply: ` +
          `${JSON.stringify(partial.slice(0, 200))}`,
      )
    }
    await page.waitForTimeout(500)
  }
}
