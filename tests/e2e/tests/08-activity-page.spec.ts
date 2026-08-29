/**
 * Scenario 8 — the Activity page shows the turn that just ran.
 *
 * Two halves, and they prove different things.
 *
 * The DURABLE half: the tool turn scenario 7 took is reachable by clicking,
 * from the sidebar, without knowing a URL — and drilling into its row shows
 * the spans the API returned, with the same ok/error verdict the ledger
 * holds. This is the operator's answer to "what did she actually do", so it
 * is walked the way an operator would walk it rather than by navigating
 * straight to /activity.
 *
 * The LIVE half: the transient "using <tool>…" line on the streaming bubble.
 * It is deliberately checked with a MutationObserver rather than by looking
 * at the page, because a workspace tool answers in single-digit
 * milliseconds — by the time any poll could look, the reducer has already
 * cleared the marker. Recording the insertion answers the real question
 * (did the app ever render it) instead of the useless one (is it there
 * now).
 */
import { expect, test } from '@playwright/test'
import {
  activityLineSightings,
  recordActivityLine,
  recordStreamFrames,
  sendMessage,
  streamFrames,
  userBubbles,
} from '../lib/app'
import { config } from '../lib/env'
import {
  describeToolSpans,
  listTurns,
  newestTurnId,
  toolSpans,
  turnAfter,
  turnDetail,
  type ActivitySpan,
} from '../lib/activity'

test.use({ storageState: config.storageStatePath })

test('activity page: the tool turn is reachable by clicking, and its spans render', async ({
  page,
}) => {
  test.setTimeout(config.replyTimeoutMs + 5 * 60 * 1000)

  // The turn scenario 7 took: the newest one that actually called tools.
  // Found through the API rather than passed between files, so this
  // scenario states its own precondition instead of inheriting a variable.
  const turns = await listTurns(page, 20)
  const toolTurn = turns.find(t => t.tool_call_count > 0)
  expect(
    toolTurn,
    'no turn in the ledger called any tool, so there is nothing for this page to show — ' +
      'scenario 7 is the one that produces it and must have run first',
  ).toBeDefined()

  // ── reachable by navigation, not by knowing the URL ─────────────────────
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await page.getByRole('link', { name: 'Activity' }).first().click()
  await expect(page).toHaveURL(/\/activity$/)
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()

  // ── the row is there, and says a tool ran ───────────────────────────────
  const row = page.getByTestId(`activity-row-${toolTurn!.id}`)
  await expect(
    row,
    `turn ${toolTurn!.id} called ${toolTurn!.tool_call_count} tool(s) but has no row on the page`,
  ).toBeVisible()
  await expect(row.getByTestId('tool-count-badge')).toHaveText(String(toolTurn!.tool_call_count))
  await expect(row).toContainText('ok')

  // ── drill in: the spans the API returned, rendered ──────────────────────
  const { spans } = await turnDetail(page, toolTurn!.id)
  await row.click()
  const detail = page.getByTestId(`activity-detail-${toolTurn!.id}`)
  await expect(detail).toBeVisible()

  const tools = toolSpans(spans)
  expect(tools.length).toBeGreaterThan(0)
  for (const span of tools) {
    await expect(detail).toContainText(span.name!)
  }
  // Every llm_call round is named, so the page says how many times the model
  // was asked, not just that it was.
  const rounds = spans.filter(s => s.kind === 'llm_call')
  for (const span of rounds) {
    await expect(detail).toContainText(`Round ${span.meta.round}`)
  }

  // The object shape of args_redacted, as key: value lines — checked against
  // the actual argument the tool was called with rather than against a
  // fixture, so a renderer that dropped the value would not pass by printing
  // the key alone.
  const objectArgs = tools.find(
    s => s.meta.args_redacted !== null && typeof s.meta.args_redacted === 'object',
  )
  expect(
    objectArgs,
    `no tool span on this turn carried object-shaped args:\n    ${describeToolSpans(spans)}`,
  ).toBeDefined()
  for (const [key, value] of Object.entries(objectArgs!.meta.args_redacted as object)) {
    const rendered = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
    // First line only: a multi-line value (a file body) is rendered inside
    // one div, and asserting the whole thing would be asserting on the
    // model's prose rather than on the renderer.
    await expect(detail).toContainText(rendered.split('\n')[0])
  }

  // The clipped-STRING shape is the other half of the polymorphic contract
  // (chat.py's _bounded degrades an oversized argument record to a string).
  // It only exists if some turn on this instance actually produced one; a
  // 1.7B model asked for a grocery list does not. Reported either way rather
  // than fabricated — a row written into the ledger by hand would be
  // testing this suite, not the app.
  const stringArgs = await findStringArgsSpan(page)
  if (stringArgs) {
    const { turnId, span } = stringArgs
    console.log(`[scenario 8] clipped-string args found on turn ${turnId}: ${span.name}`)
    await page.getByTestId(`activity-row-${turnId}`).click()
    await expect(page.getByTestId(`activity-detail-${turnId}`)).toContainText(
      String(span.meta.args_redacted).slice(0, 60),
    )
  } else {
    console.log(
      '[scenario 8] NOTE: no span on this instance carries the clipped-string args shape, so ' +
        'only the object shape was exercised here. The string shape is covered by the ' +
        'activityFormat unit tests; producing one live needs a call with >2000 characters of ' +
        'arguments, which this walk did not provoke.',
    )
  }

  // ── the live line, during a real streamed tool turn ─────────────────────
  await recordActivityLine(page)
  await recordStreamFrames(page)
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(userBubbles(page).first()).toBeVisible()

  const before = await newestTurnId(page)
  const outcome = await sendMessage(page, 'List the files in your workspace.')
  console.log(`[scenario 8] reply: ${outcome.text.replace(/\s+/g, ' ').slice(0, 200)}`)

  const liveTurn = await turnAfter(page, before)
  const { spans: liveSpans } = await turnDetail(page, liveTurn.id)
  expect(
    toolSpans(liveSpans).length,
    `the live-line half needs a turn that actually called a tool; this one called none:\n    ` +
      describeToolSpans(liveSpans),
  ).toBeGreaterThan(0)

  // What the server actually sent this page. This is the assertion, because
  // it is the contract: a tool ran, so the stream owed the client a
  // {"activity"} start frame naming it and a matching status afterwards.
  const frames = (await streamFrames(page)).map(raw => {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  })
  const activityFrames = frames
    .map(f => f.activity)
    .filter((a): a is { tool: string; status: string } => !!a && typeof a === 'object')
  console.log(`[scenario 8] activity frames on the wire: ${JSON.stringify(activityFrames)}`)
  expect(
    activityFrames.length,
    `a tool ran on this turn (the ledger holds its span) but the stream carried no {"activity"} ` +
      `frame at all. Frames seen: ${JSON.stringify(frames.slice(0, 8))}`,
  ).toBeGreaterThan(0)
  expect(
    activityFrames.some(a => a.status === 'start'),
    `activity frames arrived but none had status "start": ${JSON.stringify(activityFrames)}`,
  ).toBe(true)
  for (const frame of activityFrames) {
    expect(toolSpans(liveSpans).some(s => s.name === frame.tool)).toBe(true)
  }

  // Whether the browser ever PAINTED it is a different question, and on this
  // stack the answer is usually no — which is a real thing to know rather
  // than a thing to assert. A workspace tool answers in about a millisecond,
  // so the start frame and its ok land in the same task; React batches the
  // two dispatches into one render, and the "using <tool>…" line goes
  // straight from never-rendered to cleared without ever being committed to
  // the DOM. The MutationObserver above would have caught it at any
  // duration, so a zero here is the app's behaviour and not a missed poll.
  // Reported, with the count, because a tool that takes real time (a web
  // fetch) does show the line and this same recorder proves it when it does.
  const sightings = await activityLineSightings(page)
  console.log(
    `[scenario 8] activity line committed to the DOM ${sightings.length} time(s): ` +
      `${JSON.stringify(sightings)}` +
      (sightings.length === 0
        ? ' — NOTE: the frames above did arrive; a sub-millisecond tool call is cleared in the ' +
          'same React batch that would have shown it, so the transient line is not observable ' +
          'for filesystem tools'
        : ''),
  )
  for (const text of sightings) {
    expect(
      /using .+…|did not finish/.test(text),
      `an activity line rendered text in neither shape MessageBubble defines: ${text}`,
    ).toBe(true)
  }
})

/**
 * The first span anywhere in the recent ledger whose args_redacted came
 * through as a clipped string, or null if this instance has never produced
 * one. Looks rather than assumes — and says which it was.
 */
async function findStringArgsSpan(
  page: import('@playwright/test').Page,
): Promise<{ turnId: string; span: ActivitySpan } | null> {
  for (const turn of await listTurns(page, 20)) {
    if (turn.tool_call_count === 0) continue
    const { spans } = await turnDetail(page, turn.id)
    const hit = toolSpans(spans).find(s => typeof s.meta.args_redacted === 'string')
    if (hit) return { turnId: turn.id, span: hit }
  }
  return null
}
