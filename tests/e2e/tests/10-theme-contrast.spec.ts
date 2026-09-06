/**
 * Scenario 10 — every theme is legible, measured, not eyeballed.
 *
 * The 2026-09 theme redesign shipped primary buttons with near-black text on
 * a dark teal in light mode. Nobody saw it because the screenshots were of
 * the chat and the top of Settings. This walks the pages that carry the
 * controls in every built-in theme and computes, for every element that
 * owns visible text, its colour against the background it actually sits on
 * (alpha composited up the tree), and fails on anything under WCAG AA.
 * Disabled controls (dimmed on purpose), gradients (unknowable from
 * computed style) and screen-reader-only text are reported, not failed.
 */
import { expect, test } from '@playwright/test'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

const THEMES: [string, 'dark' | 'light'][] = [
  ['nova', 'dark'], ['nova', 'light'], ['slate', 'dark'], ['slate', 'light'],
  ['nebula', 'dark'], ['nebula', 'light'], ['ember', 'dark'], ['daylight', 'light'],
  // two community palettes: their greys are their sources', the store's
  // tier derivation is what makes them read
  ['ctp-latte', 'light'], ['gruvbox', 'dark'],
]
const ROUTES = ['/dev/components', '/settings', '/chat', '/activity', '/governance']

type Row = { text: string; tag: string; cls: string; fg: string; bg: string; ratio: number; need: number; skip: string }

// Runs in the page. Keep it dependency-free: it is serialised into the browser.
function audit(): Row[] {
  type C = { r: number; g: number; b: number; a: number }
  const parse = (s: string): C | null => {
    const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const over = (t: C, u: C): C => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 })
  const lum = ({ r, g, b }: C) => { const ch = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b) }
  const contrast = (a: C, b: C) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 0, g: 0, b: 0, a: 1 }
  const htmlBg = parse(getComputedStyle(document.documentElement).backgroundColor)
  const ground = htmlBg && htmlBg.a > 0 ? (bodyBg.a < 1 ? over(bodyBg, htmlBg) : bodyBg) : bodyBg
  const effectiveBg = (el: Element) => {
    let acc: C | null = null; let node: Element | null = el; let image = false
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node)
      const bg = parse(cs.backgroundColor)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true
      if (bg && bg.a > 0) { acc = acc ? over(acc, bg) : bg; if (acc.a >= 0.999) return { bg: acc, image } }
      node = node.parentElement
    }
    return { bg: acc ? over(acc, ground) : ground, image }
  }
  const rows: Row[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set<Element>()
  while (walker.nextNode()) {
    const t = walker.currentNode
    const text = (t.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el)
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const rect = el.getBoundingClientRect(); if (rect.width < 2 || rect.height < 2) continue
    let opacity = 1; let disabled = false
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      opacity *= parseFloat(getComputedStyle(n).opacity || '1')
      if ((n as HTMLButtonElement).disabled || n.getAttribute('aria-disabled') === 'true') disabled = true
    }
    const fg = parse(cs.color); if (!fg) continue
    const { bg, image } = effectiveBg(el)
    const fgC = fg.a < 1 ? over(fg, bg) : fg
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
    const skip = disabled ? 'disabled' : opacity < 0.9 ? 'dimmed' : image ? 'gradient' : el.classList.contains('sr-only') ? 'sr-only' : ''
    rows.push({ text: text.slice(0, 50), tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
      fg: `${Math.round(fgC.r)} ${Math.round(fgC.g)} ${Math.round(fgC.b)}`, bg: `${Math.round(bg.r)} ${Math.round(bg.g)} ${Math.round(bg.b)}`,
      ratio: Math.round(contrast(fgC, bg) * 100) / 100, need, skip })
  }
  return rows
}

for (const [preset, mode] of THEMES) {
  test(`theme ${preset} (${mode}): every visible text meets WCAG AA on the ground it sits on`, async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      ['nova-appearance', JSON.stringify({ modePreference: mode, preset, presetChosen: true, customAccent: 'teal', fontScale: 1, timezone: 'UTC' })],
    )
    const failures: string[] = []
    let checked = 0
    for (const route of ROUTES) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready)
      const rows = await page.evaluate(audit)
      const applied = await page.evaluate(() => document.documentElement.classList.contains('dark'))
      expect(applied, `${route}: mode under test is ${mode}`).toBe(mode === 'dark')
      for (const r of rows) {
        if (r.skip) continue
        checked += 1
        if (r.ratio < r.need) failures.push(`${route} <${r.tag} class="${r.cls}"> "${r.text}" fg ${r.fg} on ${r.bg} = ${r.ratio}:1 (needs ${r.need})`)
      }
    }
    expect(checked, 'the audit saw text').toBeGreaterThan(200)
    // Distinct signatures, so one repeated table cell does not hide the rest.
    const distinct = [...new Set(failures.map(f => f.replace(/"[^"]*" fg/, '"…" fg')))]
    expect(distinct, `${distinct.length} contrast failures in ${preset}/${mode}:\n${distinct.slice(0, 40).join('\n')}`).toEqual([])
    console.log(`[scenario 10] ${preset}/${mode}: ${checked} text elements, 0 under AA`)
  })
}
