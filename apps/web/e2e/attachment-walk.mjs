/**
 * S28 — a file he sent, drawn on the message that carried it.
 *
 * Against the DEPLOYED build. The assertion that matters is the last one:
 * the <img> must actually LOAD. A broken image renders as alt text and a
 * page that "shows the attachment" while the bytes 404 looks fine in a DOM
 * assertion and is useless to him.
 */
const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const TOKEN = process.env.NOVA_TOKEN ?? ''

const { chromium } = await import(process.env.NOVA_PLAYWRIGHT ?? 'playwright')
const failures = []
const notes = []

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(TOKEN ? { extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } } : {}),
})
const page = await ctx.newPage()

try {
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="message-user"]', { timeout: 20000 })

  const images = page.locator('[data-testid="attached-image"]')
  const count = await images.count()
  if (count === 0) {
    failures.push('no attached image was drawn in the transcript')
  } else {
    notes.push(`${count} attached image(s) drawn on their messages`)
    const first = images.last()
    await first.scrollIntoViewIfNeeded()
    // THE POINT: it has to have actually loaded. naturalWidth is 0 for an
    // image that failed, and a failed image still satisfies "the element is
    // there" — which is how a broken attachment passes a DOM test.
    const loaded = await first.evaluate(
      img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
    )
    if (!loaded) failures.push('the image element is there but its bytes never loaded')
    else {
      const size = await first.evaluate(img => `${img.naturalWidth}x${img.naturalHeight}`)
      notes.push(`the newest one decoded at ${size}`)
    }
    const alt = await first.getAttribute('alt')
    if (!alt) failures.push('an attached image carries no alt text — its name is all a reader has')
    else notes.push(`alt text is its name: "${alt}"`)
  }

  // The composer's way in has to be findable, not only pasteable.
  const clip = page.locator('[aria-label="Attach a file"]')
  if ((await clip.count()) === 0) failures.push('no paperclip on the composer')
  else notes.push('the composer offers a paperclip')
} catch (err) {
  failures.push(err.message)
}

await browser.close()
for (const n of notes) console.log(`  ${n}`)
if (failures.length) {
  console.log('\nFAILED:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nOK: what he sent is drawn, and its bytes load')
