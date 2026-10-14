import { describe, it, expect } from 'vitest'

// T1 (verification 2-7, fix 4): the face's word spacing is set on `body`, and
// form controls do not inherit `word-spacing` by default, so buttons and inputs
// ran their words together ("Signin", "Plana weekend trip"). These read the
// stylesheet, like stackTable.test.ts.
const css = Object.values(
  import.meta.glob('/src/index.css', { query: '?raw', import: 'default', eager: true }),
)[0] as string

/** The body of the first `@layer base { … }` block, by brace matching. */
function baseLayer(src: string): string {
  const start = src.indexOf('@layer base {')
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return ''
}

/** Every `selector { … word-spacing: inherit … }` rule in `src`. */
function inheritRules(src: string): { selectors: string[]; body: string; index: number }[] {
  const out: { selectors: string[]; body: string; index: number }[] = []
  const re = /([^{}]+)\{([^{}]*word-spacing:\s*inherit[^{}]*)\}/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    out.push({ selectors, body: m[2], index: m.index })
  }
  return out
}

const CONTROLS = ['button', 'input', 'textarea', 'select']

function controlRule(src: string) {
  return inheritRules(src).find((r) => CONTROLS.every((c) => r.selectors.includes(c)))
}

describe('form controls keep the face word spacing (index.css)', () => {
  it('button, input, textarea and select inherit word-spacing', () => {
    const rule = controlRule(css)
    expect(rule, 'no rule sets word-spacing: inherit on all four controls').toBeDefined()
    for (const c of CONTROLS) expect(rule!.selectors).toContain(c)
  })

  it('the rule lives in @layer base, so a layered .font-mono reset still beats it', () => {
    // An unlayered element rule outranks every layered rule, class or not, so
    // an <input class="font-mono"> would lose its `word-spacing: normal`.
    expect(controlRule(baseLayer(css))).toBeDefined()
  })

  it('a monospace control keeps word-spacing: normal (the reset follows the control rule)', () => {
    const layer = baseLayer(css)
    const rule = controlRule(layer)
    expect(rule).toBeDefined()
    const reset = layer.search(/code,\s*pre,\s*kbd,\s*samp,\s*\.font-mono\s*\{\s*word-spacing:\s*normal/)
    expect(reset).toBeGreaterThan(-1)
    expect(rule!.index).toBeLessThan(reset)
  })

  it('is a plain declaration, not !important', () => {
    const rule = controlRule(css)
    expect(rule).toBeDefined()
    expect(rule!.body).not.toMatch(/!important/)
  })
})
