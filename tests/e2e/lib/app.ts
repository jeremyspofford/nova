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

/**
 * Record every DOM insertion of the live tool-activity line, for the whole
 * life of the page. Must be called before the navigation it is to cover.
 *
 * A polling check cannot do this job. The line is shown on an {"activity"}
 * start frame and cleared on the matching ok frame, and a workspace tool
 * answers in single-digit milliseconds — so "is it visible right now" is a
 * question that is almost always answered after the fact. This reads the
 * MutationObserver's own records instead of the live DOM, capturing the node
 * and its text at the moment it was ADDED, which stays true evidence even
 * though the node was removed again before anything could look at it.
 *
 * It reports absence honestly: if React committed the add and the remove in
 * one render — batched into a single task — the line genuinely never
 * appeared, and this returns nothing rather than a comfortable guess.
 */
export async function recordActivityLine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __novaActivityLine: string[] }).__novaActivityLine = seen
    const capture = (node: Node) => {
      if (!(node instanceof Element)) return
      const hits = node.matches('[data-testid="activity-line"]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-testid="activity-line"]'))
      for (const el of hits) seen.push((el.textContent ?? '').trim())
    }
    new MutationObserver(records => {
      for (const record of records) record.addedNodes.forEach(capture)
    }).observe(document.documentElement, { subtree: true, childList: true })
  })
}

/** Every activity line this page ever rendered, in order. */
export const activityLineSightings = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window as unknown as { __novaActivityLine?: string[] }).__novaActivityLine ?? [],
  )

/**
 * Record every SSE frame the chat stream delivers to this page. Must be
 * called before the navigation it is to cover.
 *
 * Reading the frames matters because the DOM cannot answer the question on
 * its own: an {"activity"} start and its ok are milliseconds apart for a
 * filesystem tool, and React batches them, so "the line was never in the
 * DOM" is compatible both with a working stream and with a broken one. The
 * frames say which.
 *
 * The wire is teed rather than intercepted: the app's own fetch still gets a
 * live, unbuffered body (a route handler that fulfilled the request would
 * turn the stream into a single response and quietly delete the streaming
 * this is here to observe).
 */
export async function recordStreamFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: string[] = []
    ;(window as unknown as { __novaFrames: string[] }).__novaFrames = frames
    const original = window.fetch
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/api/v1/chat/stream') || !response.body) return response
      const [toApp, toUs] = response.body.tee()
      void (async () => {
        const reader = toUs.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut = buffer.indexOf('\n')
          while (cut >= 0) {
            const line = buffer.slice(0, cut).trim()
            buffer = buffer.slice(cut + 1)
            if (line.startsWith('data:')) frames.push(line.slice(5).trim())
            cut = buffer.indexOf('\n')
          }
        }
      })()
      return new Response(toApp, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
  })
}

/** Every SSE frame this page received, as raw JSON strings. */
export const streamFrames = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __novaFrames?: string[] }).__novaFrames ?? [])

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
  await page.getByLabel('Message Nova').fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
  // The reducer adds the user row and the pending assistant row in the same
  // dispatch, so waiting for the user row is waiting for the turn to have
  // started — without it the settle loop below could read the pre-click state
  // and call an unstarted turn finished.
  //
  // Waited for by its TEXT, not by a count going up. Counting first races the
  // stored transcript's own arrival: on a page that has just reloaded, the
  // count is taken while the history is still in flight, reads zero, and then
  // "one more than before" is a number the page passed through on its way to
  // rendering what was already there. That is not hypothetical — it is what
  // reddened scenario 5 on the first isolated walk, at the reload after the
  // gateway came back, on a stack slow enough for the gap to open.
  await expect(userBubbles(page).filter({ hasText: text }).last()).toBeVisible()

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
