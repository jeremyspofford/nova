/**
 * Scenario 2 — chat round trip, and the exchange reaching memory.
 *
 * Verifies that a message sent through the real UI produces a streamed
 * assistant reply (never an empty bubble), that the header names the model
 * actually serving, and that core's fire-and-forget ingest really landed the
 * exchange in the memory service — which is what scenario 3 will go looking
 * for after the restart.
 */
import { expect, test } from '@playwright/test'
import { assistantBubbles, sendMessage, settingsMap, whoAmI } from '../lib/app'
import { config, MEMORY_FACT } from '../lib/env'
import { recallUntil } from '../lib/evidence'

test.use({ storageState: config.storageStatePath })

test('chat: a streamed reply, the serving model named, the exchange remembered', async ({ page }) => {
  test.setTimeout(config.replyTimeoutMs + 3 * 60 * 1000)

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  // The header names what is serving, and it matches what setup stored.
  const settings = await settingsMap(page)
  expect(settings['chat.model'], 'chat.model is unset after the wizard').toBe(config.model)
  await expect(page.getByTestId('chat-model')).toHaveText(config.model)

  // The wizard's Ready step ran a real turn through the same conversation, so
  // its exchange is already on screen — the new reply is one more bubble, not
  // the only one.
  const before = await assistantBubbles(page).count()

  const outcome = await sendMessage(page, MEMORY_FACT)
  expect(outcome.kind, `the turn did not produce a reply: ${outcome.text}`).toBe('reply')
  expect(outcome.text.length).toBeGreaterThan(0)
  console.log(`[scenario 2] reply: ${outcome.text.replace(/\s+/g, ' ').slice(0, 200)}`)

  await expect(assistantBubbles(page)).toHaveCount(before + 1)

  // Ingest is fire-and-forget by design, so this polls rather than assuming.
  const person = await whoAmI(page)
  const hits = await recallUntil('favorite color teal-green', person.id, /teal/i, 60_000)
  console.log(`[scenario 2] memory holds: ${hits.map(h => h.path).join(', ')}`)
})
