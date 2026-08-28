/**
 * Scenario 6 — a turn survives navigating away mid-stream.
 *
 * AUTHORED IN S2-T1, NOT YET RUN. The brief for this task is explicit that
 * the running stack holds the operator's real, daily-use account and data,
 * and this task's only permitted docker verbs are creating/removing a
 * throwaway test postgres — driving a real turn through the live stack is
 * out of scope here. S2-T4 is the task that actually executes this file
 * against the running app as part of the slice's e2e pass; until then it
 * only needs to be syntactically real and picked up by `playwright test
 * --list` (T1's verification), which the numbering (06, after 05) and this
 * file living in tests/e2e/tests/ both guarantee.
 *
 * The bug this proves fixed (S1 carries, owner hit it live, ruling S2-R4):
 * the SSE stream used to be owned by ChatPage, so navigating to Settings
 * unmounted it, aborted the fetch, and the server — correctly — read that as
 * a disconnect and cancelled generation. The fix lifts stream ownership into
 * a store mounted above the router (apps/web/src/stores/chat-store.tsx), so
 * the walk below — send, leave before the reply finishes, come back — must
 * end with the FULL reply on screen exactly once, never a partial, never
 * silence, and never two copies of it.
 */
import { expect, test } from '@playwright/test'
import { assistantBubbles, userBubbles } from '../lib/app'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

test('nav survival: send, navigate away before the reply finishes, return to the full reply', async ({
  page,
}) => {
  test.setTimeout(config.replyTimeoutMs + 3 * 60 * 1000)

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(assistantBubbles(page).first()).toBeVisible()

  const assistantBefore = await assistantBubbles(page).count()
  const userBefore = await userBubbles(page).count()

  // A prompt asking for some length, so there is a real window between
  // "the turn started" and "the reply finished" for the navigation below to
  // land inside.
  const prompt =
    'Count from one to twenty, one number per line, with no other words at all.'
  await page.getByLabel('Message Nova').fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()

  // The reducer adds the user row and the pending assistant row in the same
  // dispatch — waiting for it is waiting for the turn to have genuinely
  // started, the same convention lib/app.ts's sendMessage() uses.
  await expect(userBubbles(page)).toHaveCount(userBefore + 1)

  // Leave immediately — the earliest point a stream can still be in flight —
  // and confirm the page really changed before coming back. This is the
  // moment the old bug aborted the fetch.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // Stay away long enough that a fast model could easily have finished the
  // whole reply in the background — the fix must hold for both timings
  // (still streaming on return, and already finished while away), and this
  // scenario does not control which one it lands on.
  await page.waitForTimeout(3000)

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  // Settle the same way lib/app.ts's sendMessage() does: data-streaming is
  // the reducer's own flag, so "the turn is over" is the app's statement,
  // not a guess from how the text looks.
  const surface = page.getByTestId('chat-page')
  const deadline = Date.now() + config.replyTimeoutMs
  for (;;) {
    const streaming = (await surface.getAttribute('data-streaming')) === 'true'
    if (!streaming) break
    if (Date.now() > deadline) {
      throw new Error(`the turn was still streaming ${config.replyTimeoutMs}ms after returning`)
    }
    await page.waitForTimeout(500)
  }

  // Exactly one new assistant bubble — never zero (the old bug: the abort
  // cancelled generation and only a partial, or nothing, ever persisted) and
  // never two (a naive "re-fetch and blindly append" reconciliation would
  // double the row the store already had live).
  await expect(assistantBubbles(page)).toHaveCount(assistantBefore + 1)
  const replies = (await assistantBubbles(page).allInnerTexts()).map(t => t.trim())
  const reply = replies[replies.length - 1]
  expect(reply.length, `the reply was empty after returning: ${JSON.stringify(reply)}`).toBeGreaterThan(0)
  console.log(`[scenario 6] reply after nav-away: ${reply.replace(/\s+/g, ' ').slice(0, 200)}`)

  // The exchange this walk sent is really only there once, not duplicated —
  // stated separately from the bubble count above because a duplicate could
  // in principle carry different (garbled) text rather than an exact repeat.
  const occurrences = replies.filter(text => text === reply).length
  expect(occurrences, `the reply text appears ${occurrences} times, not once: ${reply}`).toBe(1)
})
