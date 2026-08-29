/**
 * Scenario 3 — the Slice 1 definition of done: restart everything, then ask.
 *
 * Three separate claims, asserted separately, because only one of them is
 * about memory:
 *
 *   1. the transcript re-renders          → the postgres volume survived
 *   2. memory still recalls the exchange  → the memory volume survived AND
 *                                            the BM25 index was rebuilt from
 *                                            the files at startup
 *   3. the new reply references the fact  → the answer is grounded
 *
 * Claim 3 alone would not prove the memory path: the same conversation's
 * history is also in the prompt, so the model could read the fact back from
 * there. Claim 2 is the one that is specifically about memory, and where a
 * database is reachable this scenario also reads the turn's own
 * memory_recall span and requires that core really put snippets in the
 * prompt for the answering turn.
 */
import { expect, test } from '@playwright/test'
import { sendMessage, userBubbles, whoAmI } from '../lib/app'
import { config, MEMORY_FACT, MEMORY_NEEDLE } from '../lib/env'
import { healthTable, restartProject, waitForHealthy } from '../lib/docker'
import { newestTurnRecallSpan, recall } from '../lib/evidence'

test.use({ storageState: config.storageStatePath })

const STACK = ['postgres', 'core', 'gateway', 'memory', 'web', 'ollama']

test('restart persistence: the conversation and the memory both survive', async ({ page }) => {
  test.setTimeout(config.replyTimeoutMs + 10 * 60 * 1000)

  const restarted = await restartProject()
  console.log(`[scenario 3] restarted: ${restarted.join(', ')}`)
  const healthy = await waitForHealthy(STACK, 240_000)
  console.log(
    `[scenario 3] health after restart: ${healthy.map(r => `${r.service}=${r.health}`).join(' ')}`,
  )

  // ── 1. the transcript re-renders ────────────────────────────────────────
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(userBubbles(page).filter({ hasText: 'teal-green' })).toHaveCount(1)
  const rendered = await userBubbles(page).allInnerTexts()
  expect(
    rendered.some(t => t.includes(MEMORY_FACT)),
    `the transcript did not come back after the restart — user rows: ${JSON.stringify(rendered)}`,
  ).toBeTruthy()

  // ── 2. memory still holds it, read straight from the service ───────────
  const person = await whoAmI(page)
  const hits = await recall('favorite color teal-green', person.id)
  const remembered = hits.filter(h => /teal/i.test(h.snippet) || /teal/i.test(h.title))
  expect(
    remembered.length,
    `memory recalled nothing about teal after the restart — hits: ${JSON.stringify(hits).slice(0, 400)}`,
  ).toBeGreaterThan(0)
  console.log(`[scenario 3] memory still holds: ${remembered.map(h => h.path).join(', ')}`)

  // ── 3. the answer references the earlier exchange ──────────────────────
  //
  // A CLOSED question, and the change is deliberate. This used to ask "What
  // did we talk about earlier?", which is an invitation as much as a
  // question: a small model reads it as being asked whether it has memory
  // and answers "I don't have access to previous conversations" — while the
  // transcript naming teal-green is sitting in its prompt. Across five runs
  // of this file on the suite's default qwen3:1.7b it did that twice, so the
  // walk was red two runs in five for a reason that had nothing to do with
  // anything surviving the restart. Asked directly for the colour, the same
  // model on the same instance answers "Teal-green". Four runs of the
  // question below, four answers naming it.
  //
  // The claim is unchanged — the answer after a restart has to come back
  // grounded in the exchange from before it — and claims 1 and 2 above are
  // the mechanical ones either way. This only stops a coin flip about
  // conversational manner from standing in for the assertion.
  const outcome = await sendMessage(page, 'What colour did I tell you was my favourite?')
  expect(outcome.kind, `the turn did not produce a reply: ${outcome.text}`).toBe('reply')
  console.log(`[scenario 3] reply: ${outcome.text.replace(/\s+/g, ' ').slice(0, 300)}`)

  // ── the ledger's own account of that turn, where it can be read ─────────
  //
  // Read BEFORE claim 3 is asserted, deliberately. Claim 3 is the one
  // assertion in this file about what the MODEL did with what it was given,
  // and when it fails the first question is always "was the turn wired up at
  // all" — which is exactly what this span answers. Asserting first left
  // that answer unprinted on the only run where it mattered.
  const span = await newestTurnRecallSpan()
  let ledger = 'the turn ledger was not readable from this run shape'
  if (span.available) {
    ledger =
      `turn ${span.turnId} status=${span.status} model=${span.model} ` +
      `memory_recall span=${span.recallSpanFound} hits=${span.recallHits}`
    console.log(`[scenario 3] ${ledger}`)
    expect(span.status).toBe('ok')
    // Asserted: core really consulted memory on the turn that answered. How
    // many snippets came back is BM25's verdict on this particular question,
    // not a property of the wiring — it is reported, loudly when it is zero,
    // rather than turning a ranking outcome into a broken-plumbing failure.
    expect(
      span.recallSpanFound,
      'the answering turn has no memory_recall span at all — core did not consult memory',
    ).toBe(true)
    if (span.recallHits === 0) {
      console.log(
        '[scenario 3] NOTE: memory returned 0 snippets for this question, so the answer above ' +
          'came from the conversation history in the prompt, not from recall. The memory store ' +
          'itself is proven by the direct /recall check earlier in this test.',
      )
    }
  } else {
    console.log(`[scenario 3] turn-ledger check not run: ${span.reason}`)
  }

  expect(
    outcome.text,
    'the reply did not reference the earlier exchange at all. Claims 1 and 2 above already ' +
      'passed, so the transcript and the memory store both survived the restart and this is ' +
      'about what the serving model made of them — a small model asked an open question often ' +
      `answers it with a denial. Ledger for the answering turn: ${ledger}`,
  ).toMatch(MEMORY_NEEDLE)

  console.log(
    `[scenario 3] docker health table:\n` +
      (await healthTable()).map(r => `  ${r.service.padEnd(10)} ${r.state}/${r.health}`).join('\n'),
  )
})
