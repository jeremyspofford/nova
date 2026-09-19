/**
 * The phone shell, measured in a real browser.
 *
 * Two invariants, both of which this app has broken in production, and
 * NEITHER of which jsdom can see — it does not lay out, so every unit test
 * stayed green through both:
 *
 *   1. THE SHELL IS THE VIEWPORT. Sized from `100dvh`, it came out shorter
 *      than the owner's installed iOS app and left a bare strip along the
 *      bottom, right where the old tab bar had been.
 *   2. THE DOCUMENT CANNOT SCROLL. The fix for (1) floored `body` at a
 *      measured `innerHeight`, which overshot iOS's layout viewport instead:
 *      the document became scrollable, so the whole app could slide up and
 *      off the top. "The entire PWA app is still shifted high."
 *
 * Both were found by the owner on his phone, a day apart, after four rounds
 * of guessing from the code. `position: fixed; inset: 0` plus a document
 * that cannot scroll makes both structurally impossible — and this asserts
 * it, because "structurally impossible" is a belief until something checks.
 *
 * It also pins the grip's geometry, which is a per-pixel claim about where a
 * touch target sits and therefore equally invisible to jsdom.
 *
 * NOT a screenshot comparison. Every assertion is a number with a reason.
 * Run it with e2e/phone-layout.sh, which supplies the browser.
 */
import { webkit, devices } from 'playwright'

const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const PANEL_W = 300

// A logged-in shell by intercepting the API, rather than with real
// credentials: this checks layout, and a fixture keeps it runnable against
// any deployment without touching that deployment's data.
const NOW = '2026-09-15T15:00:00+00:00'
const FIXTURES = [
  [/\/auth\/state/, { has_users: true }],
  [/\/auth\/me/, { person: { id: 'p1', name: 'Test', role: 'owner' } }],
  [/\/notices/, { notices: [], unseen_count: 4 }],
  [/\/settings/, { settings: [
    { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: true },
  ] }],
  // `threads` makes a stub render and `prompt_tokens` makes the gauge
  // render. Without both, the two assertions at the end of this file
  // measure nothing and report OK — which is the failure mode this repo
  // keeps finding, so their absence is a FAILURE below rather than a pass.
  [/\/conversations\/[^/]+\/messages/, {
    messages: [
      { id: 'm1', role: 'user', content: 'what is the gpu doing?', created_at: NOW },
      {
        id: 'm2',
        role: 'assistant',
        content: 'The card has 17.7 GB free of 24.0 GB.',
        created_at: NOW,
        prompt_tokens: 10240,
      },
    ],
    threads: { m2: 2 },
  }],
  [/\/models\/catalog/, { rows: [{ id: 'hub:qwen3:8b', model: 'qwen3:8b', facts: { context_length: { value: 40960 } } }] }],
  [/\/system\/resources/, {
    card: { free_gb: 21.1, total_gb: 24, used_gb: 2.9, util_pct: 4, non_ollama_gb: 0, resident: [], reason: null },
    machine: { memory: { total_mb: 32768, available_mb: 27000, reason: null }, cpu: { cores: 20, load_1m: 2.3, reason: null }, disk: { free_gb: 904, total_gb: 1007, reason: null } },
    throughput: null,
    model: 'qwen3:8b',
  }],
  [/\/conversations\/active/, { id: 'c1', title: 'Chat', created_at: NOW, pending_turn: false, pending_turn_id: null, queued: [] }],
]

const mock = route => {
  const url = route.request().url()
  for (const [re, body] of FIXTURES) {
    if (re.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    }
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
}

/** Stand in for the iPhone's insets, which a desktop WebKit reports as 0.
 *  The red bands make anything drawn under the status bar or the home
 *  indicator obvious in the saved screenshots. */
const INSETS = `
  :root { --nova-safe-top: 59px !important; --nova-safe-bottom: 34px !important; }
  body::before { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 59px;
                 background: rgba(255,0,0,.12); pointer-events: none; z-index: 9999; }
  body::after  { content: ''; position: fixed; bottom: 0; left: 0; right: 0; height: 34px;
                 background: rgba(255,0,0,.12); pointer-events: none; z-index: 9999; }
`

const failures = []
const out = process.env.NOVA_E2E_SHOTS

const browser = await webkit.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await ctx.route('**/api/**', mock)
const page = await ctx.newPage()
await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30_000 })
await page.addStyleTag({ content: INSETS })
await page.waitForTimeout(1000)
if (out) await page.screenshot({ path: `${out}/phone-chat.png` })

const fit = await page.evaluate(() => {
  const shell = document.querySelector('#root > div > div') ?? document.querySelector('#root > div')
  const r = shell.getBoundingClientRect()
  window.scrollTo(0, 500) // try to shift the app, the way a finger would
  const scrolledTo = window.scrollY
  window.scrollTo(0, 0)
  return {
    innerHeight: window.innerHeight,
    shellTop: Math.round(r.top),
    shellBottom: Math.round(r.bottom),
    gapBelowShell: Math.round(window.innerHeight - r.bottom),
    scrollableBy: document.documentElement.scrollHeight - window.innerHeight,
    scrolledTo,
  }
})
if (fit.shellTop !== 0) failures.push(`the shell starts at y=${fit.shellTop}, not 0 — content is off the top`)
if (fit.gapBelowShell !== 0) failures.push(`${fit.gapBelowShell}px of dead space below the shell`)
if (fit.scrollableBy > 0) failures.push(`the document is ${fit.scrollableBy}px taller than the viewport — the app can be scrolled`)
if (fit.scrolledTo !== 0) failures.push(`the document scrolled to ${fit.scrolledTo} — the whole app moves`)

await page.click('[data-testid="edge-handle"]')
await page.waitForTimeout(600)
if (out) await page.screenshot({ path: `${out}/phone-menu.png` })

const panel = await page.evaluate(() => {
  const drawer = document.querySelector('[data-testid="mobile-drawer"]')
  const grip = document.querySelector('[data-testid="edge-handle"]')
  const tab = document.querySelector('[data-testid="edge-handle-tab"]')
  const g = grip.getBoundingClientRect()
  const t = tab.getBoundingClientRect()
  return {
    links: [...drawer.querySelectorAll('a')].map(a => a.getAttribute('href')),
    expanded: grip.getAttribute('aria-expanded'),
    // What the browser will PAINT. Headless WebKit does not reliably
    // recompute a fixed element's rect here, so the declared transform is
    // the authoritative read and the rects below are corroboration.
    transform: grip.style.transform,
    gripLeft: Math.round(g.left),
    gripRight: Math.round(g.right),
    tabLeft: Math.round(t.left),
    tabWidth: Math.round(t.width),
    tabOffsetInButton: Math.round(t.left - g.left),
  }
})
// The touch target is wider than the drawn tab. That slack must extend
// AWAY from the panel — bleeding it back over the menu swallows taps on
// whichever nav row it covers.
if (panel.expanded !== 'true') failures.push('the menu did not open')
if (!panel.transform.includes(`translate(${PANEL_W}px`)) {
  failures.push(`the grip is at ${panel.transform}, not on the ${PANEL_W}px panel's edge`)
}
// The drawn tab must sit at the BUTTON's leading edge, so the wider touch
// target extends away from the panel rather than back over the nav rows.
if (panel.tabOffsetInButton !== 0) {
  failures.push(`the drawn tab is ${panel.tabOffsetInButton}px into its button — the touch target overhangs the menu`)
}
// Deleting the bottom tab bar once deleted the only route back to chat.
if (!panel.links.includes('/chat')) failures.push('no route back to chat in the menu')

// NOTHING MAY HANG OFF THE SIDE OF A PHONE (2026-09-16). The context panel
// is anchored to the gauge, which sits near the right of the control row —
// at 393px a 361px panel began at x=-102 and lost its left third off the
// edge. And the thread stub is the only way into a room, so it has to be a
// thumb-sized target: it was 25px tall against iOS's 44.
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
const thumbs = await page.evaluate(async () => {
  const out = { panel: null, stub: null }
  const stub = document.querySelector('[data-testid="thread-stub"]')
  if (stub) {
    const r = stub.getBoundingClientRect()
    out.stub = { height: Math.round(r.height) }
  }
  const gauge = document.querySelector('[data-testid="context-gauge"]')
  if (gauge) {
    gauge.click()
    await new Promise(r => setTimeout(r, 400))
    const el = document.querySelector('[data-testid="context-panel"]')
    if (el) {
      const r = el.getBoundingClientRect()
      out.panel = { left: Math.round(r.left), right: Math.round(r.right), viewport: window.innerWidth }
    }
  }
  return out
})
// Absence is a FAILURE, not a quiet pass: a check that cannot find the
// thing it measures is indistinguishable from one that measured it and
// found it fine.
if (!thumbs.stub) failures.push('no thread stub rendered — this check measured nothing')
if (!thumbs.panel) failures.push('the context panel did not open — this check measured nothing')
if (thumbs.panel) {
  if (thumbs.panel.left < 0) failures.push(`the context panel starts at x=${thumbs.panel.left}, off the left edge`)
  if (thumbs.panel.right > thumbs.panel.viewport) {
    failures.push(`the context panel ends at x=${thumbs.panel.right}, past the ${thumbs.panel.viewport}px screen`)
  }
}
// 44 is iOS's minimum; 40 leaves room for a rounding difference between
// engines without letting a 25px target through.
if (thumbs.stub && thumbs.stub.height < 40) {
  failures.push(`the thread stub is ${thumbs.stub.height}px tall — a thumb needs 44`)
}

console.log(JSON.stringify({ fit, panel, thumbs }, null, 1))
await browser.close()

if (failures.length) {
  console.error('\nFAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\nOK: the shell is the viewport, the document cannot scroll, the grip clears the menu')
