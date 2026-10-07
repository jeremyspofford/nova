/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import resolveConfig from 'tailwindcss/resolveConfig'
// @ts-expect-error -- plain JS config, no declaration file
import config from '../../tailwind.config.js'
import { findUndefinedColorTokens, stripNonClassText } from './colorTokens'

// Every non-test .ts/.tsx under src/, as raw text, keyed by package-relative path.
const globbed = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SELF = 'src/lib/colorTokens.ts' // the scanner's own NON_COLOR table names `from-font`
const files: Record<string, string> = {}
for (const [k, v] of Object.entries(globbed)) {
  const rel = k.replace(/^\//, '')
  if (rel !== SELF) files[rel] = v
}

const theme = resolveConfig(config).theme as unknown as {
  colors: object
  fontSize: Record<string, unknown>
}
const colors = theme.colors
const nonColor = { text: Object.keys(theme.fontSize) }

function scan(sources: Record<string, string>): string[] {
  const out: string[] = []
  for (const [file, src] of Object.entries(sources)) {
    for (const tok of findUndefinedColorTokens(stripNonClassText(src), colors, nonColor)) {
      out.push(`${file}: ${tok}`)
    }
  }
  return out
}

describe('src-wide undefined colour tokens', () => {
  it('finds no undefined colour token in any non-test src file (resolved config colours)', () => {
    // The scan really covers src/ and the colours really come from resolveConfig.
    expect(Object.keys(files).length).toBeGreaterThan(50)
    expect(Object.keys(files)).toContain('src/components/layout/AppLayout.tsx')
    expect(Object.keys(files).some((f) => /\.test\.tsx?$/.test(f))).toBe(false)
    expect(colors).toHaveProperty('red') // a Tailwind default, absent from the hand-written config
    expect(colors).toHaveProperty('surface')
    // The self-exclusion is only needed while the table still names from-font.
    expect(globbed['/' + SELF]).toMatch(/from-font/)
    const found = scan(files)
    expect(found, `undefined colour tokens:\n${found.join('\n')}`).toEqual([])
  })

  it('does not report custom font sizes from the resolved theme, but still reports text-<undefined>', () => {
    expect(nonColor.text).toEqual(
      expect.arrayContaining(['h1', 'h2', 'h3', 'h4', 'body', 'caption', 'compact', 'display', 'micro', 'mono', 'mono-sm']),
    )
    const source = `<h1 className="text-h1 text-h2 text-h3 text-h4 text-body text-caption text-compact text-display text-micro text-mono text-mono-sm md:text-h1 text-content-bogus text-h1-bogus" />`
    // fontSize keys match whole: a suffix that only starts with one (text-h1-bogus) is still reported.
    expect(findUndefinedColorTokens(source, colors, nonColor)).toEqual(['text-content-bogus', 'text-h1-bogus'])
  })

  it('ignores non-class text but still reports tokens in classNames, templates, cn() args and class maps', () => {
    const source = `
      <div data-testid="from-notice" className="border-line p-2" />
      <text text-anchor="middle" x={1}>label</text>
      const cls = \`rounded \${active ? 'bg-surface-raised' : ''}\`
      cn('p-1', 'hover:border-border-strong')
      clsx({ 'text-content-bogus': on })
      const TONE = { warn: 'ring-line', ok: 'ring-accent' }
    `
    expect([...findUndefinedColorTokens(stripNonClassText(source), colors, nonColor)].sort()).toEqual([
      'bg-surface-raised',
      'border-line',
      'hover:border-border-strong',
      'ring-line',
      'text-content-bogus',
    ])
  })

  it('leaves no border-line, bg-surface-raised or border-border-strong in non-test src', () => {
    const left: string[] = []
    for (const [file, src] of Object.entries(files)) {
      for (const tok of ['border-line', 'bg-surface-raised', 'border-border-strong']) {
        if (new RegExp(`(?<![\\w-])(?:[\\w-]+:)*${tok}(?![\\w-])`).test(src)) left.push(`${file}: ${tok}`)
      }
    }
    expect(left).toEqual([])
  })

  it('turns red naming the file and token when border-line is planted in any non-test src file', () => {
    const misses: string[] = []
    for (const [file, src] of Object.entries(files)) {
      const planted = `${src}\nexport const __planted = 'rounded border border-line'\n`
      const got = scan({ [file]: planted })
      if (got.length !== 1 || got[0] !== `${file}: border-line`) misses.push(`${file} -> ${JSON.stringify(got)}`)
    }
    expect(misses).toEqual([])
  })
})
