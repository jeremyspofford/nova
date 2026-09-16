/**
 * Every shape a household actually owns.
 *
 * Until 2026-09-16 this app was checked at exactly two widths: a 1280px
 * desktop and a 393px iPhone 14 Pro. Everything between and either side was
 * asserted by the fact that nobody had complained — which is not a test,
 * and which the owner named directly: "nova will need to look good on ALL
 * devices, not just desktop browser and iphone 14 pro."
 *
 * The widths here are not a wish list; each one is a real class of device
 * with a real reason to break this layout:
 *
 *  - 280px  a folded Galaxy Fold. Narrower than any assumption in the CSS.
 *  - 360px  the most common Android width there is.
 *  - 393px  iPhone 14 Pro, the one shape already covered.
 *  - 430px  iPhone Pro Max / large Android.
 *  - 507px  an iPad in Split View — the case `coversScreen()` guards.
 *  - 768px  iPad portrait, sitting exactly ON the `md` breakpoint, where
 *           the sidebar appears and the content column suddenly has to
 *           share 768px with it.
 *  - 882px  a Fold opened, portrait.
 *  - 1024px iPad landscape.
 *  - 852x393 a phone in LANDSCAPE: 393px of height for a header, a
 *           transcript, a composer and two safe areas.
 *
 * WHAT IS ASSERTED is the small set of things that make a layout usable at
 * all, rather than a screenshot nobody will diff: nothing may overflow
 * horizontally, nothing may be drawn off either edge, the composer must be
 * on screen and reachable, and there must be room left to read a message in.
 */
const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const TOKEN = process.env.NOVA_TOKEN ?? ''

const SHAPES = [
  { name: 'fold closed', width: 280, height: 653 },
  { name: 'android small', width: 360, height: 800 },
  { name: 'iphone 14 pro', width: 393, height: 852 },
  { name: 'phone large', width: 430, height: 932 },
  { name: 'ipad split view', width: 507, height: 1024 },
  { name: 'ipad portrait', width: 768, height: 1024 },
  { name: 'fold open', width: 882, height: 1104 },
  { name: 'ipad landscape', width: 1024, height: 768 },
  { name: 'phone landscape', width: 852, height: 393 },
  { name: 'desktop', width: 1280, height: 900 },
]

/** Below this, a transcript is a slot rather than a conversation. */
const MIN_READABLE_PX = 120

const { chromium } = await import(process.env.NOVA_PLAYWRIGHT ?? 'playwright')
const failures = []
const table = []

const browser = await chromium.launch()
for (const shape of SHAPES) {
  const ctx = await browser.newContext({
    viewport: { width: shape.width, height: shape.height },
    ...(TOKEN ? { extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } } : {}),
    hasTouch: shape.width < 768,
    isMobile: shape.width < 768,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).split('\n')[0]))
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(1200)

  const seen = await page.evaluate(() => {
    const vw = window.innerWidth
    // A `display:none` element still answers getBoundingClientRect, with
    // every field zero — so "the element is in the DOM" is not "the element
    // is on screen". The sidebar is `hidden md:flex`, which means the first
    // version of this check counted a hidden sidebar as a present one and
    // would have passed a desktop with no navigation at all.
    const rect = sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const scroller = document.querySelector('[data-testid="chat-page"] .overflow-y-auto')
    return {
      overflow: document.documentElement.scrollWidth - vw,
      composer: rect('textarea') ?? rect('[data-testid="chat-input"]'),
      controls: rect('[data-testid="chat-controls"]'),
      sidebar: rect('[data-testid="sidebar"]'),
      menu: rect('[data-testid="menu-button"]'),
      transcript: scroller ? Math.round(scroller.getBoundingClientRect().height) : null,
      vw,
      vh: window.innerHeight,
      header: rect('[data-testid="chat-header"]'),
    }
  })

  const say = msg => failures.push(`${shape.name} (${shape.width}x${shape.height}): ${msg}`)
  if (errors.length) say(`page error — ${errors[0]}`)
  if (seen.overflow > 0) say(`the page scrolls sideways by ${seen.overflow}px`)

  for (const [what, r] of [['composer', seen.composer], ['control row', seen.controls]]) {
    if (!r) {
      say(`no ${what} rendered at all`)
      continue
    }
    if (r.left < -1) say(`the ${what} starts at x=${r.left}, off the left edge`)
    if (r.right > seen.vw + 1) say(`the ${what} ends at x=${r.right}, past the ${seen.vw}px screen`)
    if (r.bottom > seen.vh + 1) say(`the ${what} bottom is at y=${r.bottom}, below the ${seen.vh}px viewport`)
  }

  // One nav surface, and the right one: a menu button below `md`, the
  // sidebar at and above it. Both or neither is a bug either way. (It was a
  // draggable edge grip until 2026-09-16 — the owner asked for a corner
  // button instead, "more like Claude".)
  const wide = shape.width >= 768
  if (wide && !seen.sidebar) say('no sidebar at a desktop width')
  if (!wide && !seen.menu) say('no menu button at a phone width')
  // And exactly one of them, so a shape cannot quietly grow both.
  if (seen.sidebar && seen.menu) say('both a sidebar AND a menu button')

  if (seen.transcript !== null && seen.transcript < MIN_READABLE_PX) {
    say(`only ${seen.transcript}px left to read messages in`)
  }

  // THE HEADER IS A HEIGHT DECISION, and getting it wrong is silent both
  // ways. A Tailwind arbitrary variant written without underscores emits
  // `(min-width:768px)and(min-height:600px)` — invalid CSS, because `and`
  // needs whitespace — so the query matched nothing and the header vanished
  // at EVERY size, desktop included. Nothing looked broken; there was just
  // less. Pinned in both directions.
  const roomy = shape.width >= 768 && shape.height >= 600
  if (roomy && !seen.header) say('no chat header where there is room for one')
  if (!roomy && seen.header) say(`a ${seen.header.h}px header on a ${shape.height}px-tall screen`)

  table.push({
    shape: shape.name,
    size: `${shape.width}x${shape.height}`,
    overflow: seen.overflow,
    transcript: seen.transcript,
    composerW: seen.composer?.w ?? null,
    nav: seen.sidebar ? `sidebar ${seen.sidebar.w}px` : seen.menu ? 'menu button' : 'NONE',
    header: seen.header ? `${seen.header.h}px` : 'hidden',
  })
  await ctx.close()
}
await browser.close()

console.table(table)
if (failures.length) {
  console.error('\nFAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\nOK: every shape fits, has its nav, and leaves room to read')
