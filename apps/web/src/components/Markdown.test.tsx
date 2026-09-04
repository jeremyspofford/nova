import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './Markdown'

// A wrapper around React's real `useDeferredValue` for the "parse is
// deferred" test below: it records the value it was handed and, when `tag`
// is set, appends it to the value it returns — so the test can prove the
// parse consumed the hook's RETURN, not the raw prop. The mock only applies
// to modules vitest transforms (this file's imports) — react-dom and
// testing-library keep the native module, and the spread shares React's
// internals by reference, so the wrapped hook still hits the live dispatcher.
const deferred = vi.hoisted(() => ({ calls: vi.fn<(value: unknown) => void>(), tag: '' }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useDeferredValue: <T,>(value: T): T => {
      deferred.calls(value)
      const out = actual.useDeferredValue(value)
      return typeof out === 'string' && deferred.tag ? ((out + deferred.tag) as T) : out
    },
  }
})

function md(text: string) {
  return render(<Markdown text={text} />).container
}

describe('Markdown — GitHub-flavoured structure renders as elements', () => {
  it('renders headings, lists, a table and a fenced block as real elements', () => {
    const c = md(
      [
        '# Title',
        '## Sub',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```',
        'code here',
        '```',
      ].join('\n'),
    )
    expect(c.querySelector('h1')?.textContent).toBe('Title')
    expect(c.querySelector('h2')?.textContent).toBe('Sub')
    expect(c.querySelectorAll('ul > li')).toHaveLength(2)
    expect(c.querySelectorAll('ol > li')).toHaveLength(2)
    expect(c.querySelector('table th')?.textContent).toBe('a')
    expect(c.querySelector('table td')?.textContent).toBe('1')
    expect(c.querySelector('pre > code')?.textContent).toBe('code here\n')
  })

  it('keeps a fenced block verbatim — markdown inside it is not interpreted', () => {
    const body = '**not bold** <b>not html</b> - not a list\n  indented   spaces'
    const c = md('```\n' + body + '\n```')
    const code = c.querySelector('pre > code')
    expect(code?.textContent).toBe(body + '\n')
    expect(c.querySelector('strong')).toBeNull()
    expect(c.querySelector('b')).toBeNull()
    expect(c.querySelector('ul')).toBeNull()
  })

  it('distinguishes inline code from block code (a pill vs a scrolling block)', () => {
    const c = md('call `foo()` then\n\n```\nbar()\n```')
    const inline = c.querySelector('p > code')
    const block = c.querySelector('pre')
    expect(inline?.className).toMatch(/bg-surface-elevated/)
    expect(block?.className).toMatch(/overflow-x-auto/)
  })

  it('renders blockquotes and real bullets', () => {
    const c = md('> quoted\n\n- a bullet')
    expect(c.querySelector('blockquote')?.textContent?.trim()).toBe('quoted')
    expect(c.querySelector('ul')?.className).toMatch(/list-disc/)
  })

  it('keeps a single newline as a line break, so a one-per-line listing stays one per line', () => {
    // The /help listing (lib/commands.ts) is "Available commands:\n\n/a — …\n/b — …".
    const c = md('Available commands:\n\n/clear — empty this chat\n/help — this listing')
    expect(c.querySelectorAll('br')).toHaveLength(1)
    expect(c.textContent).toContain('/clear — empty this chat')
    expect(c.textContent).toContain('/help — this listing')
  })
})

describe('Markdown — model-authored HTML is text, never markup', () => {
  it('shows a <script> block as escaped text and creates no script element', () => {
    const c = md('before\n\n<script>alert(1)</script>\n\nafter')
    expect(c.querySelector('script')).toBeNull()
    expect(c.textContent).toContain('<script>alert(1)</script>')
  })

  it('shows an inline <img onerror> as escaped text and creates no img element', () => {
    const c = md('look <img src=x onerror=alert(1)> here')
    expect(c.querySelector('img')).toBeNull()
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders a markdown image as a link, never an <img> that fetches on draw', () => {
    const c = md('![a cat](https://example.com/cat.png)')
    expect(c.querySelector('img')).toBeNull()
    const a = c.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/cat.png')
    expect(a?.textContent).toBe('a cat')
  })

  // react-markdown's default urlTransform returns '' for every scheme outside
  // https?/ircs?/mailto/xmpp. An `<a href="">` would still be a styled,
  // clickable target that opens the current page in a new tab — a decoy. So a
  // dropped destination is not an anchor at all: the label stays as text.
  it.each([
    ['inline javascript:', '[x](javascript:alert(1))'],
    ['vbscript:', '[x](vbscript:msgbox(1))'],
    ['file:', '[x](file:///etc/passwd)'],
    ['data: link', '[x](data:text/html,hi)'],
    ['reference-style javascript:', '[x][r]\n\n[r]: javascript:alert(1)'],
    ['empty destination', '[x]()'],
  ])('a dropped destination (%s) renders its label as text, not as an empty <a>', (_n, src) => {
    const c = md(src)
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('x')
    expect(c.innerHTML).not.toMatch(/javascript|vbscript|file:|data:/i)
  })

  it('an autolinked <javascript:…> is text, not an anchor', () => {
    const c = md('<javascript:alert(1)>')
    expect(c.querySelector('a')).toBeNull()
    expect(c.querySelector('script')).toBeNull()
  })

  it('an image with a dropped scheme renders its alt as text — no <a>, no <img>', () => {
    const c = md('![x](data:image/png;base64,AAAA)')
    expect(c.querySelector('a')).toBeNull()
    expect(c.querySelector('img')).toBeNull()
    expect(c.textContent).toContain('x')
  })

  it('a linked image (the badge shape) is ONE anchor to the link, never <a> inside <a>', () => {
    const c = md('[![badge](https://img.example/b.svg)](https://example.com/repo)')
    const anchors = c.querySelectorAll('a')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/repo')
    expect(anchors[0].textContent).toBe('badge')
    expect(c.querySelector('a a')).toBeNull()
    expect(c.querySelector('img')).toBeNull()
  })
})

describe('Markdown — layout rules the bubble depends on', () => {
  it('opens links in a new tab with rel="noopener noreferrer"', () => {
    const c = md('see [nova](https://example.com/nova)')
    const a = c.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/nova')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('keeps a same-document link (a remark-gfm footnote) in the page — no new tab', () => {
    const c = md('A claim.[^1]\n\n[^1]: The source.')
    const anchors = Array.from(c.querySelectorAll('a'))
    expect(anchors.length).toBeGreaterThanOrEqual(2)
    for (const a of anchors) {
      expect(a.getAttribute('href')).toMatch(/^#/)
      expect(a.getAttribute('target')).toBeNull()
      expect(a.getAttribute('rel')).toBeNull()
    }
  })

  it('wraps a table in its own horizontally scrollable container', () => {
    const c = md('| a | b |\n|---|---|\n| 1 | 2 |')
    const table = c.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.parentElement?.className).toMatch(/overflow-x-auto/)
  })

  it('code blocks scroll horizontally instead of wrapping', () => {
    const c = md('```\n' + 'x'.repeat(400) + '\n```')
    expect(c.querySelector('pre')?.className).toMatch(/overflow-x-auto/)
  })
})

describe('Markdown — streaming', () => {
  it('renders an unclosed fence as a code block and does not throw', () => {
    const c = md('Here is the file:\n\n```python\nprint("hi")\nfor i in')
    const code = c.querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain('print("hi")')
    expect(code?.textContent).toContain('for i in')
  })

  it('reconciles a delta in place — the same DOM node grows, nothing remounts', () => {
    // If the element overrides were created per render, React would see a new
    // component type every frame and remount the whole tree (visible as
    // flicker while streaming). Pin the mechanism: after a delta, the
    // paragraph is the SAME node, with more text.
    const view = render(<Markdown text={'Hello, wor'} />)
    const before = view.container.querySelector('p')
    expect(before?.textContent).toBe('Hello, wor')
    view.rerender(<Markdown text={'Hello, world. Next:\n\n- item'} />)
    const after = view.container.querySelector('p')
    expect(after).toBe(before)
    expect(after?.textContent).toBe('Hello, world. Next:')
    expect(view.container.querySelector('ul > li')?.textContent).toBe('item')
  })

  it('renders an empty string without throwing', () => {
    expect(() => md('')).not.toThrow()
  })

  // The parse is linear in the text, so re-parsing the whole reply on every
  // delta is O(n²) over a stream and drops frames at the tail of a long code
  // dump. The parse must sit behind `useDeferredValue`: the urgent render of
  // a delta re-uses the previous parse and a burst coalesces into one parse
  // of the newest text. Pinned at the hook, because inside `act` React flushes
  // the deferred render before returning, so the lag is not observable in
  // the DOM here — only its presence is.
  describe('the parse is deferred', () => {
    beforeEach(() => {
      deferred.calls.mockClear()
      deferred.tag = ' [deferred]'
    })
    afterEach(() => {
      deferred.tag = ''
    })

    it('hands the text to useDeferredValue and parses what comes BACK, not the raw prop', () => {
      const view = render(<Markdown text={'one'} />)
      expect(deferred.calls).toHaveBeenCalledWith('one')
      expect(view.container.querySelector('p')?.textContent).toBe('one [deferred]')
      view.rerender(<Markdown text={'one two'} />)
      expect(deferred.calls).toHaveBeenLastCalledWith('one two')
      expect(view.container.querySelector('p')?.textContent).toBe('one two [deferred]')
    })
  })
})
