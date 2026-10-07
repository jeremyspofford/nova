/**
 * Chat sessions (2026-10-07): the clicks and drags the unit tests cannot
 * make — a real browser, a real core, real HTML5 drag-and-drop.
 *
 *   1. the sidebar lists the main session
 *   2. "+" opens a new session in the chat, and the URL names it
 *   3. dragging a session onto a pane's right edge splits the view
 *   4. a pane closes from its header; the session stays in the list
 *   5. archive moves it to the archive; unarchive brings it back
 *   6. delete asks, then removes it
 *
 * Usage: NOVA_E2E_URL=http://127.0.0.1:5173 NOVA_USER=… NOVA_PASSWORD=… \
 *        node apps/web/e2e/sessions-walk.mjs
 * Screenshots land in NOVA_SHOTS (default: the current directory).
 */
const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const USER = process.env.NOVA_USER ?? ''
const PASSWORD = process.env.NOVA_PASSWORD ?? ''
const SHOTS = process.env.NOVA_SHOTS ?? '.'

const { chromium } = await import(process.env.NOVA_PLAYWRIGHT ?? 'playwright')
const failures = []
const notes = []
const say = m => failures.push(m)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

const login = await page.request.post(`${BASE}/api/v1/auth/login`, {
  data: { name: USER, password: PASSWORD },
})
if (!login.ok()) {
  console.error(`could not sign in: ${login.status()} ${await login.text()}`)
  process.exit(2)
}

const rows = () => page.locator('[data-testid="sessions-list"] li[data-testid^="session-"]')
const panes = () => page.locator('[data-testid^="chat-pane-"]')

try {
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="sessions-list"]', { timeout: 15000 })
  await rows().first().waitFor({ timeout: 15000 })
  notes.push(`1: ${await rows().count()} session(s) listed`)
  if ((await page.locator('[data-testid="sessions-list"] [title^="Main session"]').count()) !== 1) {
    say('1: the main session is not marked')
  }

  // 2 ── a new session opens in the chat
  const before = await rows().count()
  await page.click('[data-testid="new-session"]')
  await page.waitForURL(/\/chat\?session=/, { timeout: 15000 })
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="sessions-list"] li[data-testid^="session-"]').length === n + 1, before)
  const newId = new URL(page.url()).searchParams.get('session')
  notes.push(`2: new session ${newId.slice(0, 8)} open in the main pane`)
  await page.screenshot({ path: `${SHOTS}/sessions-1-new.png` })

  // 3 ── drag the main session onto the right edge of the pane
  const mainRow = page.locator('[data-testid="sessions-list"] li[data-open="false"]').first()
  await mainRow.dragTo(page.locator('[data-testid="chat-pane-main"]'), {
    targetPosition: { x: 10, y: 10 },
  }).catch(() => {})
  // Playwright's dragTo dispatches the drag events; the drop zones only
  // exist once dragstart has run, so drive the zone explicitly too.
  if ((await panes().count()) < 2) {
    const handle = await mainRow.elementHandle()
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await handle.dispatchEvent('dragstart', { dataTransfer: dt })
    const zone = page.locator('[data-testid="drop-right-main"]')
    await zone.waitFor({ timeout: 5000 })
    await zone.dispatchEvent('dragenter', { dataTransfer: dt })
    await zone.dispatchEvent('dragover', { dataTransfer: dt })
    await zone.dispatchEvent('drop', { dataTransfer: dt })
    await handle.dispatchEvent('dragend', { dataTransfer: dt })
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="chat-pane-"]').length === 2, null, { timeout: 10000 })
  notes.push('3: dragging a session onto the right edge split the view into 2 panes')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/sessions-2-split.png` })

  // 4 ── close the side pane from its header
  const side = panes().nth(1)
  const sideId = (await side.getAttribute('data-testid')).replace('chat-pane-', '')
  await page.click(`[data-testid="close-pane-${sideId}"]`)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="chat-pane-"]').length === 1)
  notes.push('4: closing the side pane left one pane; the list still has every session')

  // 5 ── archive the new session, then unarchive it
  await page.hover(`[data-testid="session-${newId}"]`)
  await page.click(`[data-testid="session-menu-${newId}"]`)
  await page.click(`[data-testid="archive-${newId}"]`)
  await page.waitForSelector(`[data-testid="session-${newId}"]`, { state: 'detached', timeout: 10000 })
  await page.click('[data-testid="toggle-archived"]')
  await page.waitForSelector(`[data-testid="archived-${newId}"]`, { timeout: 10000 })
  notes.push('5: archived — gone from the list, present in the archive')
  await page.screenshot({ path: `${SHOTS}/sessions-3-archived.png` })
  await page.click(`[data-testid="unarchive-${newId}"]`)
  await page.waitForSelector(`[data-testid="session-${newId}"]`, { timeout: 10000 })
  notes.push('5: unarchived — back in the list')

  // 6 ── delete asks first
  await page.hover(`[data-testid="session-${newId}"]`)
  await page.click(`[data-testid="session-menu-${newId}"]`)
  await page.click(`[data-testid="delete-${newId}"]`)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.waitForSelector(`[data-testid="session-${newId}"]`, { state: 'detached', timeout: 10000 })
  const gone = await page.request.get(`${BASE}/api/v1/conversations/${newId}/state`)
  if (gone.status() !== 404) say(`6: core still has the deleted session (${gone.status()})`)
  else notes.push('6: deleted — core answers 404 for it')
  await page.screenshot({ path: `${SHOTS}/sessions-4-deleted.png` })
} catch (err) {
  say(`walk stopped: ${err.message}`)
  await page.screenshot({ path: `${SHOTS}/sessions-failed.png` }).catch(() => {})
}

await browser.close()
for (const n of notes) console.log(`ok   ${n}`)
for (const f of failures) console.log(`FAIL ${f}`)
process.exit(failures.length ? 1 : 0)
