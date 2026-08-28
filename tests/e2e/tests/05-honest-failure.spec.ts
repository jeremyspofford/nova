/**
 * Scenario 5 — a failed turn looks like a failure.
 *
 * With the gateway stopped there is nothing that can answer. The one thing
 * the UI must never do is render an empty assistant bubble, because an empty
 * bubble is the model appearing to have said nothing rather than the system
 * saying it broke. The turn has to come back as a stated error row, and the
 * gateway has to be back up and answering by the time this file is done.
 */
import { expect, test } from '@playwright/test'
import { assistantBubbles, errorRows, sendMessage } from '../lib/app'
import { config } from '../lib/env'
import {
  containerFor,
  dockerAvailable,
  startContainer,
  stopContainer,
  waitForHealthy,
} from '../lib/docker'

test.use({ storageState: config.storageStatePath })

test('honest failure: a dead gateway renders a stated error, never an empty bubble', async ({
  page,
}) => {
  test.setTimeout(config.replyTimeoutMs + 5 * 60 * 1000)
  const canControlDocker = await dockerAvailable()
  test.skip(
    !canControlDocker,
    `no docker socket at ${config.dockerSocket} — this scenario has to stop a container, so run ` +
      'the suite from the host or mount the socket into the e2e service',
  )

  const gateway = await containerFor('gateway')
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  // Count only once the stored transcript has actually rendered. Counting the
  // moment the header appears counted an empty page, and then "no new bubble
  // was added" failed against the history arriving a beat later.
  await expect(assistantBubbles(page).first()).toBeVisible()
  const bubblesBefore = await assistantBubbles(page).count()

  await stopContainer(gateway)
  try {
    const outcome = await sendMessage(page, 'Are you there?', 90_000)
    expect(
      outcome.kind,
      `with the gateway stopped the UI produced ${outcome.kind} — an empty assistant bubble or a ` +
        'reply is exactly what must not happen here',
    ).toBe('error')
    expect(outcome.text.length, 'the error row had no stated reason in it').toBeGreaterThan(0)
    console.log(`[scenario 5] stated error: ${outcome.text.replace(/\s+/g, ' ').slice(0, 250)}`)

    // No new speech bubble was created for the failed turn.
    await expect(assistantBubbles(page)).toHaveCount(bubblesBefore)
    await expect(errorRows(page).last()).toBeVisible()
  } finally {
    await startContainer(gateway)
    await waitForHealthy(['gateway'], 120_000)
  }

  // Left as it was found: the stack answers again.
  await page.reload()
  const recovered = await sendMessage(page, 'Are you back?')
  expect(
    recovered.kind,
    `the gateway came back but the next turn still did not answer: ${recovered.text}`,
  ).toBe('reply')
  console.log(`[scenario 5] recovered: ${recovered.text.replace(/\s+/g, ' ').slice(0, 200)}`)
})
