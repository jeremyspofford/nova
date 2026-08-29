/**
 * Scenario 9 — a follow-up that only works if she really goes back to the
 * file.
 *
 * "Add X to that list" is the shape the whole tool loop exists for, and it
 * is also the shape that fakes most convincingly: the previous reply is in
 * the prompt, so a model can produce a perfectly plausible "added it" while
 * the file on disk never changes. The only check that means anything is the
 * one that reads the volume afterwards, so that is what this does.
 *
 * WHY "oat milk" AND NOT "milk". The Slice 2 DoD phrases this step as "add
 * milk to that list", and on the first walk the five items the model chose
 * for groceries.md already included Milk. A check for /milk/ would then have
 * passed against a file nothing had touched — a green that proves nothing,
 * which is worse than a red. The needle is therefore something the first
 * list will not already contain, and the scenario refuses to run if it does
 * anyway rather than quietly testing nothing.
 */
import { expect, test } from '@playwright/test'
import { sendMessage } from '../lib/app'
import { config, GROCERIES } from '../lib/env'
import {
  describeToolSpans,
  newestTurnId,
  readWorkspaceFile,
  spansForTool,
  turnAfter,
  turnDetail,
} from '../lib/activity'

test.use({ storageState: config.storageStatePath })

const NEEDLE = /oat\s*-?\s*milk/i

test('follow-up: "add oat milk to that list" really changes the file on disk', async ({ page }) => {
  test.setTimeout(config.replyTimeoutMs * 2 + 5 * 60 * 1000)

  const before = await readWorkspaceFile(GROCERIES)
  expect(
    before.length,
    `${GROCERIES} is missing or empty before the follow-up — scenario 7 is what creates it`,
  ).toBeGreaterThan(0)
  expect(
    NEEDLE.test(before),
    `${GROCERIES} already contains the thing this scenario asks her to add, so afterwards it ` +
      `would prove nothing. Pick a different item. File was:\n${before}`,
  ).toBe(false)

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  const previousTurn = await newestTurnId(page)
  const outcome = await sendMessage(page, 'add oat milk to that list', config.replyTimeoutMs * 2)
  expect(outcome.kind, `the follow-up did not produce a reply: ${outcome.text}`).toBe('reply')
  console.log(`[scenario 9] reply: ${outcome.text.replace(/\s+/g, ' ').slice(0, 300)}`)

  const turn = await turnAfter(page, previousTurn)
  const { spans } = await turnDetail(page, turn.id)
  console.log(
    `[scenario 9] turn ${turn.id} status=${turn.status} rounds=${turn.llm_round_count}\n    ` +
      describeToolSpans(spans),
  )

  // ── the volume is the verdict ───────────────────────────────────────────
  // Read before the span checks so a narrated update — the reply describing
  // a file it never touched — is reported with both halves of the proof in
  // one message: no tool ran, and the bytes on disk did not move.
  const after = await readWorkspaceFile(GROCERIES)
  console.log(`[scenario 9] ${GROCERIES} after:\n${after}`)

  const wrote = spansForTool(spans, 'workspace_write_file').some(s => s.meta.ok === true)
  expect(
    wrote,
    `the reply claims the list was updated but no workspace_write_file succeeded on this turn — ` +
      `this is the narration case, work reported that never happened.\n  spans: ` +
      `${describeToolSpans(spans)}\n  ${GROCERIES} on disk is ${after === before ? 'UNCHANGED' : 'changed'}:` +
      `\n${after}`,
  ).toBe(true)
  // Whether she re-read the file first is her strategy, not a requirement —
  // core deliberately does not replay tool results into the next turn, so a
  // re-read is the reliable way to do this, but a model that rewrites the
  // whole list from the transcript has still done what was asked. Reported,
  // not asserted.
  const reread = spansForTool(spans, 'workspace_read_file').some(s => s.meta.ok === true)
  console.log(`[scenario 9] re-read the file before writing: ${reread}`)

  expect(
    NEEDLE.test(after),
    `the reply said it was added, but ${GROCERIES} on the volume does not contain it.\n` +
      `before:\n${before}\nafter:\n${after}`,
  ).toBe(true)
  expect(after, `${GROCERIES} is byte-identical to before, so nothing was written`).not.toBe(before)

  // Whether the other items survived is REPORTED, not asserted, and the
  // distinction is deliberate. What this scenario is for is the loop: a
  // follow-up turn reaches the file she wrote earlier and changes it on
  // disk, proven by reading the volume. Whether the model chose to carry the
  // existing items across when it rewrote the file is the model's judgement
  // about the task, and on the first isolated walk qwen3:1.7b did not —
  // it re-read the list and then wrote a file containing only "oat milk".
  // That is a real and unwelcome quality result, and it is stated in the
  // walk's output every run rather than turned into a plumbing failure that
  // a larger model would silently make disappear.
  const priorItems = before
    .split('\n')
    .map(line => line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim())
    .filter(item => item.length > 2)
  const survivors = priorItems.filter(item => after.includes(item))
  console.log(
    `[scenario 9] ${survivors.length} of ${priorItems.length} earlier item(s) survived the ` +
      `rewrite` +
      (priorItems.length > 0 && survivors.length === 0
        ? ' — NOTE: adding one item REPLACED the whole list. The tool loop did what it was told; ' +
          'the model decided what to write.'
        : ''),
  )
})
