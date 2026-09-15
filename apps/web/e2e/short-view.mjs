/**
 * The installed app whose web view is SHORTER than the screen.
 *
 * This is the shape iOS actually handed the owner's iPhone, and it took
 * three reports to find because no other environment produces it: a 393x852
 * screen, a 793-tall web view, and that view still drawn from the TOP edge.
 * So the status bar sits over the first 59px of the app, and a 59px strip at
 * the bottom is outside the web view entirely.
 *
 * `env(safe-area-inset-top)` reports 0 throughout, which is why safeArea.ts
 * substitutes a status bar at all. The bug this pins is that the
 * substitution was GUARDED by a screen-coverage test comparing LONG edges —
 * 793 against 852 — so it answered "nothing is drawn over us" in precisely
 * the case where something was, and the app drew its first line under the
 * clock. "I'm missing the top."
 *
 * What this CANNOT check is the strip below the view: it is outside the
 * document, no CSS reaches it, and the only cure is re-adding the app to the
 * home screen so iOS re-reads `apple-mobile-web-app-status-bar-style`. The
 * status-bar style is baked at ADD time — code ships to an installed app,
 * window chrome does not.
 *
 * Run with e2e/phone-layout.sh, which runs this too.
 */
import { webkit } from 'playwright'

const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const SCREEN = { width: 393, height: 852 }
const STATUS_BAR = 59

const NOW = '2026-09-15T15:00:00+00:00'
const FIXTURES = [
  [/\/auth\/state/, { has_users: true }],
  [/\/auth\/me/, { person: { id: 'p1', name: 'Test', role: 'owner' } }],
  [/\/notices/, { notices: [], unseen_count: 0 }],
  [/\/settings/, { settings: [
    { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: true },
  ] }],
  [/\/conversations\/[^/]+\/messages/, { messages: [{ id: 'm1', role: 'user', content: 'hello', created_at: NOW }] }],
  [/\/conversations\/active/, { id: 'c1', title: 'Chat', created_at: NOW, pending_turn: false, pending_turn_id: null, queued: [] }],
]
const mock = route => {
  const url = route.request().url()
  for (const [re, body] of FIXTURES) {
    if (re.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
}

const failures = []
const browser = await webkit.launch()

for (const [name, viewH] of [
  ['full-bleed view', SCREEN.height],
  ['short view (iOS gave us screen − status bar)', SCREEN.height - STATUS_BAR],
]) {
  const ctx = await browser.newContext({
    screen: SCREEN,
    viewport: { width: SCREEN.width, height: viewH },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  })
  // An INSTALLED app. `navigator.standalone` is the flag iOS sets and the
  // one installedApp() reads first; the display-mode media query cannot be
  // faked from here.
  await ctx.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { get: () => true }))
  await ctx.route('**/api/**', mock)
  const page = await ctx.newPage()
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForTimeout(800)

  const r = await page.evaluate(() => {
    const main = document.querySelector('main')
    const cs = getComputedStyle(document.documentElement)
    return {
      innerHeight: window.innerHeight,
      shortfall: window.screen.height - window.innerHeight,
      safeTop: cs.getPropertyValue('--nova-safe-top').trim(),
      firstContentY: Math.round(
        main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop)),
    }
  })
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(r, null, 1))

  // Headless WebKit resolves env() to 0 and reports no home-indicator inset,
  // so safeArea.ts substitutes the CLASSIC 20px bar rather than the 59px one
  // a notched phone gets. What is asserted is therefore that SOMETHING was
  // substituted — the bug was substituting nothing at all.
  if (parseFloat(r.safeTop) <= 0) {
    failures.push(`${name}: --nova-safe-top is ${r.safeTop} — the app draws under the status bar`)
  }
  if (r.firstContentY <= 0) {
    failures.push(`${name}: first content at y=${r.firstContentY}, flush with the top edge`)
  }
  await ctx.close()
}

await browser.close()
if (failures.length) {
  console.error('\nFAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\nOK: an installed app pads the status bar whether or not iOS shortened its view')
