import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DocxView, safeHtmlToReact } from './DocxView'
import { fixtureBytes } from './docxFixture.test-data'

afterEach(() => vi.unstubAllGlobals())

function renderHtml(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return render(<div data-testid="out">{safeHtmlToReact(doc.body)}</div>)
}

describe('safeHtmlToReact — a document Nova wrote gets no more power than a reply', () => {
  it('keeps structure: headings, emphasis, lists, tables', () => {
    renderHtml('<h1>T</h1><p><strong>b</strong> <em>i</em></p><ul><li>x</li></ul><table><tr><td>c</td></tr></table>')
    expect(screen.getByRole('heading', { level: 1, name: 'T' })).toBeDefined()
    expect(screen.getByText('b').tagName).toBe('STRONG')
    expect(screen.getByText('x').tagName).toBe('LI')
    expect(screen.getByText('c').tagName).toBe('TD')
  })

  it('drops script, style and iframe with everything inside them', () => {
    renderHtml('<p>ok</p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>')
    const out = screen.getByTestId('out')
    expect(out.querySelector('script, style, iframe')).toBeNull()
    expect(out.textContent).toBe('ok')
  })

  it('carries no event handler or style attribute through', () => {
    renderHtml('<p onclick="alert(1)" style="color:red" class="x">p</p>')
    const p = screen.getByText('p')
    expect(p.getAttribute('onclick')).toBeNull()
    expect(p.getAttribute('style')).toBeNull()
    expect(p.getAttribute('class')).toBeNull()
  })

  it('links only http(s) and mailto, in a new tab; anything else is plain text', () => {
    renderHtml('<a href="https://example.com">good</a> <a href="javascript:alert(1)">bad</a> <a href="#x">anchor</a>')
    const good = screen.getByRole('link', { name: 'good' })
    expect(good.getAttribute('target')).toBe('_blank')
    expect(good.getAttribute('rel')).toContain('noopener')
    expect(screen.getByText('bad').tagName).toBe('SPAN')
    expect(screen.getByText('anchor').tagName).toBe('SPAN')
  })

  it('shows embedded raster images only — never an SVG, never a fetched URL', () => {
    renderHtml(
      '<img alt="png" src="data:image/png;base64,iVBORw0KGgo=">' +
        '<img alt="svg" src="data:image/svg+xml;base64,PHN2Zz4=">' +
        '<img alt="remote" src="https://tracker.example/pixel.gif">',
    )
    expect(screen.getByAltText('png').tagName).toBe('IMG')
    expect(screen.queryByAltText('svg')).toBeNull()
    expect(screen.queryByAltText('remote')).toBeNull()
  })
})

describe('DocxView', () => {
  it('reads the file and renders it as a document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => fixtureBytes() }) as Response))
    render(<DocxView url="/api/v1/workspace/raw?path=trip.docx" />)
    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Packing' })).toBeDefined()
    expect(screen.getByText('tent').tagName).toBe('LI')
    expect(screen.getByText('Ridge').closest('td')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'link' }).getAttribute('href')).toBe('https://example.com/plan')
  })

  it('says why when the file cannot be read, and never shows a blank page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Response))
    render(<DocxView url="/x" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not read this document/i))
    expect(screen.getByRole('alert').textContent).toMatch(/download/i)
  })

  it('states a failed fetch with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) as Response))
    render(<DocxView url="/x" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/404/))
  })
})
