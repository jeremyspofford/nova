/**
 * Settings → Models → Machines, measured at phone widths (S40).
 *
 * jsdom does not lay out, so MachinesSection.test.tsx cannot see the ways
 * this tile fails on a phone: a compute id, a model name or a reason that
 * will not wrap and pushes past the screen, a switch too small to hit, and
 * the section not being first on the tab. Each check is a number with a
 * reason, and an element that is not found is a FAILURE, never a pass (the
 * phone-layout lesson). The API is intercepted, so no deployment's data is
 * touched. Run it with e2e/machines-layout.sh.
 *
 * Two machines, though S40 has one: `hub` as it is on the owner's box, and a
 * second that is not answering with a long reason, the case where a state
 * leaves its badge for a line of its own. Measuring only the happy tile
 * would leave the longest line on the page unmeasured.
 *
 * WHY "THE PAGE DOES NOT SCROLL SIDEWAYS" IS NOT ENOUGH HERE. Section wraps
 * its children in an overflow-hidden Card, so nothing in a tile can ever
 * make the page scroll: content that is too wide is CLIPPED instead, and
 * the `overflow` number stays 0 whatever the tile does. And a screen-edge
 * test alone misses the band between a tile's edge and the screen's (45px
 * at 393). So what is painted is measured against what it must fit in:
 *   - every element's box AND every run of text's own line boxes (a block
 *     keeps its column's width while an unbreakable run inside it spills,
 *     so element boxes alone never see a line that cannot wrap) against
 *     its tile's box;
 *   - each tile against every ancestor that clips or scrolls;
 *   - all of it against the screen.
 * Measured before these existed (S40 T8, fix round 1), the script said OK
 * with content cut off three ways: a reason line that cannot wrap (435px
 * past its tile at 393; element boxes alone still ended at 348), a line
 * 30px past its tile, and a tile 10px past the box that clips it. Those
 * three are CUTS below: every run applies each and fails unless it is
 * seen, so the `cuts` column reads 3/3 or the run is not OK. The
 * screenshots stay as a human cross-check, not as the test.
 */
import { webkit, devices } from 'playwright'

const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const OUT = process.env.NOVA_E2E_SHOTS
const NOW = '2026-09-18T15:00:00+00:00'
const MACHINE = {
  name: 'hub', lifecycle: 'always_on', serving: true, state: 'ready', reason: null, observed_at: NOW,
  compute: 'cpu:amd-ryzen-9-7950x|16c|63g+gpu:cuda:GPU-6f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8',
  runtime: 'container',
  models: [
    { name: 'qwen3.8:27b', size_bytes: 17_400_000_000 },
    { name: 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M', size_bytes: 18_600_000_000 },
    { name: 'nomic-embed-text:latest', size_bytes: 274_302_450 },
  ],
}
const DOWN = {
  name: 'dell', lifecycle: 'wake_on_lan', serving: true, state: 'unreachable', observed_at: NOW,
  reason: 'could not reach dell at http://dell.tailba0abb.ts.net:11434/api/tags — ConnectError: [Errno 111] Connection refused',
  compute: null, runtime: null, models: [],
}
const TILES = [MACHINE.name, DOWN.name]
// First match wins, so the specific paths come before their prefixes. Every
// other section on the tab gets its own empty shape: left to the default
// '{}', a section can throw during render and take the whole tree down.
const FIXTURES = [
  [/\/api\/v1\/auth\/state/, { has_users: true }],
  [/\/api\/v1\/auth\/me/, { person: { id: 'p1', name: 'Test', role: 'owner' } }],
  [/\/api\/v1\/notices/, { notices: [], unseen_count: 0, muted_count: 0 }],
  [/\/api\/v1\/conversations\/active/, { id: 'c1', title: 'Chat', created_at: NOW, pending_turn: false, pending_turn_id: null, queued: [] }],
  [/\/api\/v1\/machines/, { machines: [MACHINE, DOWN] }],
  [/\/api\/v1\/settings/, { settings: [
    { key: 'onboarding.completed', type: 'bool', default: false, description: '', value: true },
    { key: 'chat.model', type: 'str', default: '', description: '', value: 'hub:qwen3.8:27b' },
  ] }],
  [/\/api\/v1\/models\/catalog/, { fetched_at: NOW, sources: [], rows: [] }],
  [/\/api\/v1\/models\/suggest/, { tier: '24GB', engine_suggestion: 'ollama', models: [], rationale: '' }],
  [/\/api\/v1\/models\/vision/, { models: [] }],
  [/\/api\/v1\/models(\?|$)/, { data: [] }],
  [/\/api\/v1\/inference\/backend/, { kind: 'ollama', url: null, provider: null, model: null, api_key: null }],
  [/\/api\/v1\/providers\/presets/, { presets: [] }],
  [/\/api\/v1\/providers/, { providers: [] }],
  [/\/api\/v1\/routes\/explain/, { role: 'chat', chain: [], would_serve: null, reason: 'no chain' }],
  [/\/api\/v1\/routes/, { roles: [], walls: [] }],
  [/\/api\/v1\/agents/, []],
]
const mock = route => {
  const url = route.request().url()
  for (const [re, body] of FIXTURES) {
    if (re.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
}

const SHAPES = [
  { name: 'iphone 14 pro', options: { ...devices['iPhone 14 Pro'] } },
  { name: 'fold closed', options: { ...devices['iPhone 14 Pro'], viewport: { width: 280, height: 653 } } },
]
// The checker, checked. Each cut hides tile content in a way the first
// version of this script called OK (S40 T8, fix round 1). Every run applies
// each one in turn to the real layout and fails unless the check that
// should see it fires, so an OK from this script cannot again mean "these
// checks could not have failed".
const CUTS = [
  { what: "a reason line that cannot wrap", css: '[data-testid="machine-dell-state"]{white-space:nowrap!important}', seenBy: 'spill' },
  { what: 'a line pushed 30px past its tile', css: '[data-testid="machine-hub-compute"]{margin-right:-30px!important}', seenBy: 'spill' },
  { what: 'a tile 30px wider than its column', css: '[data-testid="machine-hub"]{margin-right:-30px!important}', seenBy: 'clip' },
]
const failures = []
const table = []
const browser = await webkit.launch()
for (const shape of SHAPES) {
  const ctx = await browser.newContext(shape.options)
  await ctx.route('**/api/**', mock)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).split('\n')[0]))
  await page.goto(`${BASE}/settings/models`, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForSelector('[data-testid="machine-hub"]', { timeout: 10_000 }).catch(() => {})
  const w = shape.options.viewport.width
  if (OUT) await page.screenshot({ path: `${OUT}/machines-${w}.png` })
  const measure = () => page.evaluate(names => {
    const box = sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.width === 0 || r.height === 0 ? null : { left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }
    }
    const name = el => el.dataset?.testid ?? `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 48)}">`
    // Everything inside `root` with a box: each element's, and each run of
    // text by its own line boxes. Nothing is exempt: the switch's sr-only
    // checkbox sits 1px left of the tile (Tailwind's -1px margin), inside
    // the 1px allowed for subpixel rounding.
    const painted = root => {
      const out = [...root.querySelectorAll('*')].map(el => ({ what: name(el), r: el.getBoundingClientRect() }))
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const text = t.textContent.trim()
        if (!text) continue
        range.selectNodeContents(t)
        for (const r of range.getClientRects()) out.push({ what: `"${text.slice(0, 32)}" in ${name(t.parentElement)}`, r })
      }
      return out.filter(({ r }) => r.width > 0 && r.height > 0)
    }
    // How far `r` reaches past the [left, right] band (<= 0: inside it).
    const past = (r, left, right) => Math.max(r.right - right, left - r.left)
    let widest = null
    const spills = [] // painted past its own tile's edge
    const clips = [] // a tile past an ancestor that clips or scrolls it
    for (const n of names) {
      const tile = document.querySelector(`[data-testid="machine-${n}"]`)
      if (!tile) continue
      const t = tile.getBoundingClientRect()
      for (const { what, r } of painted(tile)) {
        widest = Math.max(widest ?? -Infinity, Math.round(r.right))
        const by = past(r, t.left, t.right)
        if (by > 1) spills.push({ tile: n, what, by: Math.round(by) })
      }
      for (let a = tile.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === 'visible') continue
        const left = a.getBoundingClientRect().left + a.clientLeft // its padding box: what it clips to
        const by = past(t, left, left + a.clientWidth)
        if (by > 1) clips.push({ tile: n, what: name(a), by: Math.round(by) })
      }
    }
    const worst = list => (list.length ? list.reduce((a, b) => (b.by > a.by ? b : a)) : null)
    return {
      vw: window.innerWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      first: document.querySelector('[data-testid="settings-panel"] h2')?.textContent ?? null,
      tiles: Object.fromEntries(names.map(n => [n, box(`[data-testid="machine-${n}"]`)])),
      compute: box('[data-testid="machine-hub-compute"]'),
      reasonLine: box('p[data-testid="machine-dell-state"]'),
      toggle: box('label[for="machine-serving-hub"]'),
      widest,
      spill: worst(spills),
      spills: spills.length,
      clip: worst(clips),
    }
  }, TILES)
  const seen = await measure()
  const say = msg => failures.push(`${shape.name} (${w}px): ${msg}`)
  if (errors.length) say(`page error — ${errors[0]}`)
  for (const n of TILES) if (!seen.tiles[n]) say(`no Machines tile for ${n} rendered at all`)
  if (!seen.compute) say('no compute line rendered')
  if (!seen.reasonLine) say("dell's reason is not on a line of its own")
  if (!seen.toggle) say('no serving switch rendered')
  if (seen.first !== 'Machines') say(`the first section on the Models tab is ${JSON.stringify(seen.first)}, not Machines`)
  if (seen.overflow > 0) say(`the page scrolls sideways by ${seen.overflow}px`)
  if (seen.widest !== null && seen.widest > seen.vw + 1) say(`something in a tile ends at x=${seen.widest}, past the ${seen.vw}px screen`)
  if (seen.spill) say(`${seen.spill.what} reaches ${seen.spill.by}px past the ${seen.spill.tile} tile (${seen.spills} painted boxes outside it): cut off, not wrapped`)
  if (seen.clip) say(`the ${seen.clip.tile} tile reaches ${seen.clip.by}px past ${seen.clip.what}, which clips it`)
  if (seen.toggle && seen.toggle.h < 44) say(`the switch is a ${seen.toggle.h}px tap target; iOS asks for 44`)
  let caught = 0
  for (const cut of CUTS) {
    const tag = await page.addStyleTag({ content: cut.css })
    const cutSeen = await measure()
    await tag.evaluate(el => el.remove())
    if (cutSeen[cut.seenBy]) caught++
    else say(`the ${cut.seenBy} check is blind: with ${cut.what} it saw nothing`)
  }
  table.push({ shape: shape.name, width: w, overflow: seen.overflow, widest: seen.widest, spill: seen.spill?.by ?? 0, clip: seen.clip?.by ?? 0, toggleH: seen.toggle?.h ?? null, first: seen.first, cuts: `${caught}/${CUTS.length}` })
  await ctx.close()
}
await browser.close()
console.table(table)
if (failures.length) {
  console.error('\nFAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('OK')
