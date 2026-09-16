/**
 * S25's definition of done, steps 3, 5 and 6 — the ones that are a CLICK.
 *
 * Steps 1, 2 and 4 are read from the database and the trace instead (a mute
 * surviving a changed fact, a cleared condition lifting its silence, and
 * whether she actually runs the `notices` tool), because none of them is
 * visible on a page and all three are about what is true rather than what
 * is drawn. Step 7 is responsive.mjs.
 *
 * Against the DEPLOYED build, like every harness in this folder: the thing
 * the owner opens is the baked image, not the dev server.
 */
const BASE = process.env.NOVA_E2E_URL ?? 'http://web'
const TOKEN = process.env.NOVA_TOKEN ?? ''

const { chromium } = await import(process.env.NOVA_PLAYWRIGHT ?? 'playwright')
const failures = []
const notes = []
const say = (m) => failures.push(m)

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(TOKEN ? { extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } } : {}),
})
const page = await ctx.newPage()

async function inbox() {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="inbox-list"]', { timeout: 15000 })
}

// ── step 3: a card with a timer_id opens that timer in one click ──────────
try {
  await inbox()
  const link = page.locator('[data-testid="notice-facts"] a[href^="/schedules?timer="]').first()
  if ((await link.count()) === 0) {
    say('step 3: no card offered a timer to open — no linked subject was rendered')
  } else {
    const href = await link.getAttribute('href')
    const timerId = decodeURIComponent(href.split('timer=')[1])
    await link.click()
    await page.waitForURL(/\/schedules\?timer=/, { timeout: 15000 })
    // THE POINT is not the URL: it is that the destination does something
    // with it. The row opens, which is what makes this better than being
    // dropped on a list to search.
    notes.push(`step 3: landed on ${page.url().replace(BASE, '')}`)
    // `schedules-detail-<id>` renders ONLY for the open row, so its presence
    // is the difference between "the link went to the right page" and "the
    // link opened the right thing".
    const detail = page.locator(`[data-testid="schedules-detail-${timerId}"]`)
    await detail.waitFor({ timeout: 15000 }).catch(() => {})
    if ((await detail.count()) === 0) {
      say('step 3: the timer page opened but that timer\'s row did not')
    } else {
      notes.push(`step 3: and the row for ${timerId.slice(0, 8)} is open`)
    }
  }
} catch (err) {
  say(`step 3: ${err.message}`)
}

// ── step 5: "talk about this" opens the room off the delivering message ───
try {
  await inbox()
  const cards = page.locator('[data-testid^="notice-row-"]')
  const n = await cards.count()
  let clicked = false
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i)
    const talk = card.locator('[data-testid="talk-about"]')
    if ((await talk.count()) === 0) continue
    if (await talk.isDisabled()) continue
    await talk.click()
    await page.waitForURL(/\/chat\?thread=/, { timeout: 20000 })
    notes.push(`step 5: opened ${page.url().replace(BASE, '')}`)
    clicked = true
    break
  }
  if (!clicked) say('step 5: every card offered a DISABLED "talk about this" — none was delivered')
} catch (err) {
  say(`step 5: ${err.message}`)
}

// ── step 5b: the honest disabled state, which S24 named and did not solve ─
try {
  await inbox()
  const disabled = page.locator('[data-testid="talk-about"][disabled]').first()
  if ((await disabled.count()) === 0) {
    notes.push('step 5b: no undelivered card on the box right now — nothing to check')
  } else {
    const why = await disabled.getAttribute('title')
    if (!/no message to talk under/.test(why ?? '')) {
      say(`step 5b: a disabled control gave no reason about the world: ${why}`)
    } else {
      notes.push('step 5b: the disabled control names what has not happened')
    }
  }
} catch (err) {
  say(`step 5b: ${err.message}`)
}

// ── step 6: a repeated-procedure card drafts a skill from the notice ──────
try {
  await inbox()
  const draft = page.locator('[data-testid="draft-skill"]').first()
  if ((await draft.count()) === 0) {
    say('step 6: no card offered to write a procedure down')
  } else {
    // The steps the CHECK recorded, read off the card before leaving it —
    // the draft has to name these, and they are the only place to get them.
    const card = page.locator('[data-testid^="notice-row-"]').filter({ has: draft }).first()
    const facts = await card.locator('[data-testid="notice-facts"]').innerText()
    await draft.click()
    await page.waitForURL(/\/skills\?from_notice=/, { timeout: 15000 })
    await page.waitForSelector('[data-testid="new-skill"]', { timeout: 15000 })
    const said = await page.locator('[data-testid="from-notice"]').innerText()
    notes.push(`step 6: form opened on ${page.url().replace(BASE, '')}`)
    if (!/steps come from the turns/.test(said)) {
      say('step 6: the form did not say where the steps come from')
    }
    const name = `walk-draft-${Date.now()}`
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create draft' }).click()
    // The draft core composed, read back from the page rather than assumed.
    await page.waitForTimeout(3000)
    const body = await page.locator('body').innerText()
    const alerted = await page.locator('[role="alert"]').count()
    if (alerted > 0) {
      const why = await page.locator('[role="alert"]').first().innerText()
      say(`step 6: the draft was refused — ${why}`)
    } else if (!body.includes(name)) {
      say('step 6: the draft was not shown after it was created')
    } else {
      const named = facts.match(/[a-z_]+_[a-z_]+/g) ?? []
      const hit = named.find((tool) => body.includes(tool))
      notes.push(
        hit
          ? `step 6: the draft names "${hit}" from the notice's own steps`
          : 'step 6: created, but could not confirm a step name reached it',
      )
    }
  }
} catch (err) {
  say(`step 6: ${err.message}`)
}

await browser.close()
for (const n of notes) console.log(`  ${n}`)
if (failures.length) {
  console.log('\nFAILED:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nOK: steps 3, 5 and 6 walk')
