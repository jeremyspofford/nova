/**
 * The home-screen icons, rasterised from the app's OWN marks.
 *
 * A manifest and an apple-touch-icon take static PNGs, so these cannot be
 * painted live the way the tab icon is. What they can do is come from the
 * same functions, so the icon on a phone and the icon in the Appearance
 * picker cannot drift apart. That is why this bundles src/lib/app-icon.ts
 * rather than redrawing anything here; a second copy of those gradients
 * stops being the same picture the first time either is touched.
 *
 * Two sets come out:
 *
 *  - public/icons/icon-*.png — the manifest's icons (Android, Chromium):
 *    the pinned amber orb. Transparent at the rim for `any`; the maskable
 *    one gets the app's near-black baked in and is inset into the 80% safe
 *    zone, because a launcher crops it to whatever shape it likes.
 *
 *  - public/icons/touch/<name>.png — one apple-touch-icon per reachable
 *    (choice, palette), named by `touchName` in app-icon.ts and enumerated
 *    by `allTouchIcons()` (2026-09-17). iOS copies whichever of these the
 *    page's <link rel="apple-touch-icon"> names when Nova is added, and
 *    never fetches it again — so the store points that link at the file
 *    for the current choice, and the phone takes it on the next add. iOS
 *    flattens transparency onto WHITE, so every one of these carries its
 *    own ground: a filled mark's own fill, the app's near-black otherwise.
 *
 * The output is committed; app-icon.test.ts pins that the touch/ directory
 * holds exactly the enumerated set, so a new preset or accent turns it red
 * until this has been re-run.
 *
 *   scripts/make-icons.sh          (the container with the browser in it)
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Playwright is deliberately NOT a dependency of this package: it drags
// browser binaries behind it and nothing here needs one except this script.
// `NOVA_PLAYWRIGHT` points at an install (scripts/make-icons.sh makes one);
// a bare 'playwright' still works wherever one happens to be resolvable.
const { chromium } = await import(process.env.NOVA_PLAYWRIGHT || 'playwright')

const HERE = new URL('.', import.meta.url).pathname
const PUBLIC = join(HERE, '..', 'public')
const OUT = join(PUBLIC, 'icons')
/** The app's ground, from index.html's first-frame paint. */
const GROUND = '#0c0a09'
/** Apple's size for an apple-touch-icon. */
const TOUCH = 180

// One source of truth: bundle the real modules and ask them for the pictures.
const tmp = mkdtempSync(join(tmpdir(), 'nova-icons-'))
const entry = join(tmp, 'entry.ts')
writeFileSync(entry, `export * from '${join(HERE, '..', 'src', 'lib', 'app-icon.ts')}'\n`)
const bundle = join(tmp, 'app-icon.mjs')
execFileSync('npx', ['esbuild', entry, '--bundle', '--format=esm', `--outfile=${bundle}`, '--log-level=error'],
  { stdio: 'inherit' })
const { APP_ICONS, TOUCH_ICON_DIR, allTouchIcons, orbDataUri } = await import(bundle)

const svgOf = uri => decodeURIComponent(uri.replace('data:image/svg+xml,', ''))

/** An <img> for whatever an href names: an inline SVG for a data: URI, the
 *  file under public/ (as a data: URI, since the page has no server) for a
 *  path. Sized to fill its box either way. */
function imageHtml(href) {
  if (href.startsWith('data:image/svg+xml,')) {
    return svgOf(href).replace('<svg ', '<svg width="100%" height="100%" ')
  }
  const bytes = readFileSync(join(PUBLIC, href))
  return `<img src="data:image/png;base64,${bytes.toString('base64')}" style="width:100%;height:100%;display:block">`
}

/** The fill of the first <rect> in an SVG: what a FILLED mark's own ground
 *  is, so the tile behind it is the same colour and the mark's rounded
 *  corners (iOS rounds its own) never show a sliver of anything else. */
function rectFill(svg) {
  const m = svg.match(/<rect[^>]*\bfill="([^"]+)"/)
  if (!m) throw new Error('a filled icon has no <rect> to take its ground from')
  return m[1]
}

const browser = await chromium.launch()

async function raster({ path, size, ground, safeZone, html }) {
  const inset = safeZone ? (1 - safeZone) / 2 * 100 : 0
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;
      ${ground ? `background:${ground};` : ''}">
    <div style="position:absolute;inset:${inset}%;">${html}</div>
  </body></html>`)
  await page.screenshot({ path, omitBackground: !ground })
  await page.close()
  return readFileSync(path).length
}

const report = (name, size, ground, bytes) =>
  console.log(`${name.padEnd(40)} ${size}x${size}  ${(ground ? 'on ' + ground : 'transparent').padEnd(14)} ${(bytes / 1024).toFixed(1)} KB`)

// ── The manifest's icons: the pinned amber orb ──────────────────────────
// 'ember'/'amber' is the one the owner asked for by name, twice, precisely
// so it does not depend on the theme in play.
const orb = orbDataUri('dark', 'ember', 'amber')
for (const t of [
  { name: 'icon-192.png', size: 192, ground: null },
  { name: 'icon-512.png', size: 512, ground: null },
  { name: 'icon-512-maskable.png', size: 512, ground: GROUND, safeZone: 0.8 },
]) {
  const bytes = await raster({ path: join(OUT, t.name), size: t.size, ground: t.ground, safeZone: t.safeZone, html: imageHtml(orb) })
  report(t.name, t.size, t.ground, bytes)
}
writeFileSync(join(OUT, 'orb.svg'), svgOf(orb))
console.log('orb.svg'.padEnd(40) + ' the vector the manifest icons were rasterised from')

// ── The home-screen set: exactly what allTouchIcons() names ─────────────
const touchDir = join(PUBLIC, TOUCH_ICON_DIR)
mkdirSync(touchDir, { recursive: true })
const wanted = allTouchIcons()
// Stale output is a name the store can no longer produce; the test would
// flag it, but the script that owns the directory should not leave it.
for (const f of readdirSync(touchDir)) {
  if (!wanted.has(f.replace(/\.png$/, ''))) { unlinkSync(join(touchDir, f)); console.log(`removed stale ${f}`) }
}
let total = 0
for (const [name, src] of wanted) {
  const choice = APP_ICONS.find(i => i.key === src.key)
  const href = choice.href(src.mode, src.preset, src.customAccent)
  const ground = choice.filled ? rectFill(svgOf(href)) : GROUND
  const bytes = await raster({ path: join(touchDir, `${name}.png`), size: TOUCH, ground, html: imageHtml(href) })
  total += bytes
  report(`touch/${name}.png`, TOUCH, ground, bytes)
}
console.log(`${wanted.size} home-screen icons, ${(total / 1024).toFixed(0)} KB`)

await browser.close()
