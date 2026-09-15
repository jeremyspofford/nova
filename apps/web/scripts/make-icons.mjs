/**
 * The home-screen icons, rasterised from the app's OWN orb.
 *
 * A manifest takes static PNGs, so these cannot follow the theme the way the
 * in-app mark does — index.html says so where somebody will read it. What
 * they can do is come from the same function, so the icon on a phone's home
 * screen and the icon in the Appearance picker cannot drift apart. That is
 * why this bundles src/lib/app-icon.ts rather than redrawing the gradient
 * here; a second copy of those stops being the same orb the first time
 * either is touched.
 *
 * The orb is deliberately transparent at its rim — the owner asked for that
 * — which is right for a tab and for Android's `any` purpose. It is wrong
 * for the two places a platform composites the icon itself: iOS flattens an
 * apple-touch-icon onto white, and a maskable icon is cropped to whatever
 * shape the launcher likes, so transparency there shows as a bare corner.
 * Those two get the app's own near-black baked in, which is also the ground
 * the v2 original glowed against.
 *
 *   node scripts/make-icons.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Playwright is deliberately NOT a dependency of this package: it drags
// browser binaries behind it and the only things here that need one are this
// script and e2e/, which installs its own. `NOVA_PLAYWRIGHT` points at that
// install (scripts/make-icons.sh sets it); a bare 'playwright' still works
// wherever one happens to be resolvable.
const { chromium } = await import(process.env.NOVA_PLAYWRIGHT || 'playwright')

const HERE = new URL('.', import.meta.url).pathname
const OUT = join(HERE, '..', 'public', 'icons')
/** The app's ground, from index.html's first-frame paint. */
const GROUND = '#0c0a09'

// One source of truth: bundle the real module and ask it for the orb.
const tmp = mkdtempSync(join(tmpdir(), 'nova-icons-'))
const bundle = join(tmp, 'app-icon.mjs')
execFileSync('npx', ['esbuild', join(HERE, '..', 'src', 'lib', 'app-icon.ts'),
  '--bundle', '--format=esm', `--outfile=${bundle}`, '--log-level=error'], { stdio: 'inherit' })
const { orbDataUri } = await import(bundle)

// 'ember'/'amber' is the pinned-amber orb — the one the owner asked for by
// name, twice, precisely so it does not depend on the theme in play.
const svg = decodeURIComponent(orbDataUri('dark', 'ember', 'amber').replace('data:image/svg+xml,', ''))

/** @type {{name: string, size: number, ground: string | null}[]} */
const TARGETS = [
  { name: 'icon-192.png', size: 192, ground: null },
  { name: 'icon-512.png', size: 512, ground: null },
  // Cropped by the launcher: the orb is inset into the 80% safe zone so a
  // circle mask cannot clip its glow, and the ground is baked in.
  { name: 'icon-512-maskable.png', size: 512, ground: GROUND, safeZone: 0.8 },
  // iOS composites onto white if this is transparent.
  { name: 'apple-touch-icon.png', size: 180, ground: GROUND },
]

const browser = await chromium.launch()
for (const t of TARGETS) {
  const inset = t.safeZone ? (1 - t.safeZone) / 2 * 100 : 0
  const page = await browser.newPage({
    viewport: { width: t.size, height: t.size },
    deviceScaleFactor: 1,
  })
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${t.size}px;height:${t.size}px;
      ${t.ground ? `background:${t.ground};` : ''}">
    <div style="position:absolute;inset:${inset}%;">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
  </body></html>`)
  await page.screenshot({ path: join(OUT, t.name), omitBackground: !t.ground })
  await page.close()
  const bytes = readFileSync(join(OUT, t.name)).length
  console.log(`${t.name.padEnd(24)} ${t.size}x${t.size}  ${t.ground ? 'on ' + t.ground : 'transparent'}  ${(bytes / 1024).toFixed(1)} KB`)
}
await browser.close()
writeFileSync(join(OUT, 'orb.svg'), svg)
console.log('orb.svg'.padEnd(24) + ' the vector these were rasterised from')
