import { createElement, useEffect, useState, type ReactNode } from 'react'
import { Banner, Skeleton } from '../../components/ui'

/**
 * A Word document (.docx) in the Files viewer (2026-10-11). mammoth turns
 * the file into HTML in the browser — loaded only when a .docx is opened —
 * and that HTML is NEVER inserted as markup: `safeHtmlToReact` walks it and
 * builds React elements from a whitelist, so a document Nova wrote gets no
 * more power in the page than a reply she sent (see Markdown.tsx):
 *
 * - structure only: headings, paragraphs, emphasis, lists, tables, quotes;
 *   any other element is unwrapped to its children, and script, style,
 *   iframe, object and embed are dropped with everything inside them;
 * - no attribute survives except a checked link target, an image's
 *   embedded source and alt, and a cell's colspan/rowspan — so no event
 *   handler, style or class reaches the DOM;
 * - links: http(s) and mailto only, in a new tab; anything else is text;
 * - images: embedded raster data only (png, jpeg, gif, webp). Never an SVG
 *   (markup), never a URL — a fetched image is a tracking pixel.
 *
 * The page shows Word's content, not its layout: fonts, page size and
 * spacing are not carried, and the viewer says so.
 */

const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's',
  'sub', 'sup', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'blockquote', 'pre', 'code', 'br', 'hr',
])
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'template', 'svg', 'math'])
const SAFE_HREF = /^(?:https?:|mailto:)/i
const SAFE_IMG = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i
const VOID = new Set(['br', 'hr'])

export function safeHtmlToReact(node: Node, key = 0): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (DROP.has(tag)) return null
  const kids = () => Array.from(el.childNodes).map((c, i) => safeHtmlToReact(c, i))

  if (tag === 'a') {
    const href = el.getAttribute('href') ?? ''
    if (!SAFE_HREF.test(href)) return createElement('span', { key }, ...kids())
    return createElement('a', { key, href, target: '_blank', rel: 'noopener noreferrer' }, ...kids())
  }
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? ''
    if (!SAFE_IMG.test(src)) return null
    return createElement('img', { key, src, alt: el.getAttribute('alt') ?? '' })
  }
  if (KEEP.has(tag)) {
    if (VOID.has(tag)) return createElement(tag, { key })
    const props: Record<string, unknown> = { key }
    if (tag === 'td' || tag === 'th') {
      for (const a of ['colspan', 'rowspan'] as const) {
        const n = Number(el.getAttribute(a))
        if (Number.isInteger(n) && n > 1 && n < 100) props[a === 'colspan' ? 'colSpan' : 'rowSpan'] = n
      }
    }
    return createElement(tag, props, ...kids())
  }
  // body, div, span, anything unknown: its children, without it.
  return createElement('span', { key }, ...kids())
}

// A .docx is a zip; past this the browser tab is the wrong place to unpack it.
const MAX_BYTES = 25 * 1024 * 1024

type State =
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; body: ReactNode }

export function DocxView({ url }: { url: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    ;(async () => {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`the server answered ${res.status}`)
      const bytes = await res.arrayBuffer()
      if (bytes.byteLength > MAX_BYTES) throw new Error(`it is ${Math.round(bytes.byteLength / 1048576)} MB, over the viewer's 25 MB`)
      const mammoth = await import('mammoth')
      const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes })
      const doc = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html')
      return Array.from(doc.body.childNodes).map((n, i) => safeHtmlToReact(n, i))
    })().then(
      body => live && setState({ status: 'ready', body }),
      err => live && setState({ status: 'error', reason: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [url])

  if (state.status === 'loading') return <Skeleton lines={8} />
  if (state.status === 'error') {
    return <Banner>Could not read this document: {state.reason}. Download it to open it in Word.</Banner>
  }
  return (
    <div className="space-y-3">
      <p className="text-caption text-content-tertiary">
        Word's text, headings, lists and tables — not its fonts or page layout. Download for the original.
      </p>
      <div
        data-testid="docx-body"
        className={[
          'sm:rounded-lg sm:border sm:border-border-subtle sm:p-6 text-body text-content-primary space-y-3',
          '[&_h1]:text-h1 [&_h2]:text-h2 [&_h3]:text-h3 [&_h4]:text-h4 [&_h1]:mt-6 [&_h2]:mt-5 [&_h3]:mt-4 [&_h1:first-child]:mt-0',
          '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5',
          '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2',
          '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-secondary',
          '[&_table]:border-collapse [&_table]:text-compact [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
          '[&_img]:max-w-full [&_img]:h-auto',
        ].join(' ')}
      >
        {state.body}
      </div>
    </div>
  )
}
