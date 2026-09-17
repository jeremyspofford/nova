import {
  createContext,
  memo,
  useContext,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { createLowlight, type LanguageFn } from 'lowlight'
import { visit } from 'unist-util-visit'
import type { Element, Root } from 'hast'
import clsx from 'clsx'
import { Check, Copy, X } from 'lucide-react'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import go from 'highlight.js/lib/languages/go'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import './highlight.css'

/**
 * Assistant reply text rendered as GitHub-flavoured markdown.
 *
 * What holds mechanically, and where:
 *
 * - Model-authored HTML is never rendered. react-markdown without
 *   `rehype-raw` turns every raw-HTML node into a TEXT node (its `post()`
 *   transform), so `<script>` or `<img onerror>` in a reply lands in the DOM
 *   as escaped characters, not elements. Nothing here uses
 *   `dangerouslySetInnerHTML`, and no plugin that could is installed. The
 *   highlighter below is not an exception: it builds hast `<span>` elements
 *   from the code's TEXT (lowlight's emitter escapes nothing and parses
 *   nothing as HTML — the text stays text nodes inside the spans), so a
 *   fence containing `<script>` renders those characters, highlighted as
 *   markup, and never a script element.
 * - URLs go through react-markdown's default `urlTransform`, whose
 *   `safeProtocol` is `https?|ircs?|mailto|xmpp` (lib/index.js): anything
 *   else with a scheme — `javascript:`, `vbscript:`, `data:`, `file:` — comes
 *   back as `''`. A dropped URL is not rendered as an empty `<a href="">`
 *   (a styled, clickable decoy that would open the current page in a new
 *   tab); the `a` and `img` overrides render plain text instead.
 * - A markdown image (`![alt](url)`) is rendered as a LINK, not an `<img>`:
 *   an image tag would make the browser fetch a URL the model chose the
 *   moment the reply is drawn — a tracking pixel by construction, and this
 *   app is privacy-first. The owner can click it if he wants to see it. An
 *   image that is itself inside a link (`[![badge](img)](url)`) renders as
 *   the link's text: `<a>` inside `<a>` is invalid HTML and two click targets.
 * - Links open in a new tab with `rel="noopener noreferrer"`. Same-document
 *   links (`#…`, which is what remark-gfm footnotes emit) stay in the page.
 * - Tables sit inside their own `overflow-x-auto` box and code blocks scroll
 *   horizontally, so a wide reply never scrolls the page.
 *
 * Syntax highlighting (`rehypeHighlightSubset` below): a fenced block tagged
 * with a registered language gets highlight.js token spans (`hljs-keyword`,
 * `hljs-string`, …; the palette is highlight.css). What is registered is the
 * set of languages her tools actually hand back and the workspace actually
 * holds — shell output (`device_run`), Python, TypeScript/JavaScript, JSON,
 * YAML, Go, SQL, HTML/XML, CSS, Markdown, diffs, Dockerfiles, INI/TOML — and
 * the grammars are imported one by one from `highlight.js/lib/languages/*`
 * so only those ship. `rehype-highlight` was not used for exactly that
 * reason: it imports lowlight's `common` (37 grammars) and references it as
 * the default for its `languages` option, so a bundler cannot shake it —
 * measured on this build at +54.5 KB gzip (even with `languages` set to
 * this same subset) against +23.7 KB for the subset alone. The plugin is
 * ~30 lines: a `language-*` class names the grammar; `text`/`plaintext`, an
 * unknown name, and NO tag all leave the block verbatim with no spans.
 *
 * Untagged blocks are deliberately not auto-detected. highlight.js's guess
 * is a relevance score, not a confidence, and it was measured here against
 * what her tools actually hand back: an `ls -la` listing scored YAML at
 * relevance 3 (42 token spans over a directory listing), a prose paragraph
 * scored Python at 2, a log excerpt YAML at 2 — and a real Python file
 * scored CSS at 6, so no floor separates code from listings, and a wrong
 * colouring is worse than none. The language tag is hers to write (her
 * prompt states the fencing rule); the renderer refuses to guess.
 *
 * Streaming: the bubble re-renders this on every delta with the whole text
 * so far, and the parse is linear in the text — so an unthrottled re-parse
 * per delta is O(n²) over a stream (measured with `renderToStaticMarkup`:
 * ~4 ms at 1 KB, ~25 ms at 10 KB, ~140 ms at 50 KB per parse). Two things
 * keep that cheap and flicker-free:
 *
 * 1. `Markdown` hands `MarkdownBody` a `useDeferredValue` of the text. The
 *    urgent render of a delta re-uses the previous parse (the memo boundary
 *    sees the same deferred text), and React parses the newest text in a
 *    deferred render afterwards; a burst of deltas arriving faster than one
 *    parse coalesces into one parse of the latest text instead of one per
 *    delta. Nothing is dropped — the final text always renders.
 * 2. `COMPONENTS`, `REMARK_PLUGINS` and `REHYPE_PLUGINS` are module-level
 *    constants. If the element overrides were created inside the render,
 *    every delta would hand React a NEW component type for every
 *    `<p>`/`<li>`/`<pre>`, which unmounts and remounts the whole tree each
 *    frame (the flicker). With stable types React reconciles in place: a
 *    paragraph that gained ten characters is the same DOM node with more
 *    text.
 *
 * An unclosed fence is a CommonMark code block that runs to the end of the
 * document, so a code block being streamed renders as a code block — and,
 * when tagged, a highlighted one — from its first line.
 *
 * `remark-breaks` is deliberate: a single newline is a line break, as it is
 * in a GitHub comment and as it was in the pre-wrap `<div>` this replaces.
 * Without it the `/help` listing (one command per line) collapses into a
 * single paragraph. The trade-off is that a model hard-wrapping prose at
 * ~80 columns shows ragged breaks — exactly what the pre-wrap div showed.
 */

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/**
 * The grammars that ship. Each grammar registers its own aliases (`sh`,
 * `zsh`, `py`, `ts`, `tsx`, `js`, `yml`, `html`, `svg`, `md`, `patch`,
 * `docker`, `toml`, `golang`, `console`, …), and names are matched
 * case-insensitively, so ```Python and ```TOML resolve too.
 */
const GRAMMARS: Record<string, LanguageFn> = {
  bash,
  shell,
  python,
  typescript,
  javascript,
  json,
  yaml,
  go,
  sql,
  xml,
  css,
  markdown,
  diff,
  dockerfile,
  ini,
}

const lowlight = createLowlight(GRAMMARS)

/** Fence tags that mean "this is not code": verbatim, no token spans. */
const PLAIN_TAGS = new Set(['text', 'plaintext', 'txt', 'nohighlight', 'no-highlight'])

function fenceLanguage(node: Element): string | undefined {
  const list = node.properties.className
  if (!Array.isArray(list)) return undefined
  for (const item of list) {
    const value = String(item)
    if (value.startsWith('language-')) return value.slice('language-'.length)
  }
  return undefined
}

/**
 * The rehype plugin. A `<pre><code>` from a fence has a single text child
 * (mdast-util-to-hast's `code` handler); that text is what gets highlighted,
 * and the result's spans replace it. Anything that is not a tagged fence —
 * an untagged one, inline code, or a `code` outside `pre` — is left alone.
 */
function rehypeHighlightSubset() {
  return function transform(tree: Root) {
    visit(tree, 'element', (node, _index, parent) => {
      if (
        node.tagName !== 'code' ||
        !parent ||
        parent.type !== 'element' ||
        parent.tagName !== 'pre'
      ) {
        return
      }
      const tag = fenceLanguage(node)
      if (tag === undefined || PLAIN_TAGS.has(tag.toLowerCase()) || !lowlight.registered(tag)) {
        return
      }
      const text = node.children.map(child => (child.type === 'text' ? child.value : '')).join('')
      const classes = Array.isArray(node.properties.className)
        ? node.properties.className.map(String)
        : []
      const result = lowlight.highlight(tag, text)
      node.properties.className = ['hljs', ...classes]
      if (result.children.length > 0) {
        node.children = result.children as Element['children']
      }
    })
  }
}

const REHYPE_PLUGINS = [rehypeHighlightSubset]

const HEADING = 'font-semibold mt-3 mb-1 first:mt-0 text-content-primary'

// accent-700 on the light ground / accent-400 on the dark one — the pairing
// the design system's own `.markdown-body a` rule chose (index.css), ~5.6:1.
// Bare `text-accent` (accent-500 on white) is ~2.9:1 and its hover shade
// near-invisible in light mode.
const LINK =
  'text-accent-700 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-300 underline underline-offset-2 break-all'

/** True while rendering the children of a rendered `<a>` — see `Image`. */
const InLink = createContext(false)

type AnchorProps = ComponentProps<'a'> & { node?: unknown }

function Anchor({ node: _node, href, className, children, ...props }: AnchorProps) {
  // `''` is what the default urlTransform returns for a dropped scheme, and
  // what `[x]()` produces: not a link, so not an anchor.
  if (!href) return <span>{children}</span>
  const inPage = href.startsWith('#')
  return (
    <a
      className={className ? `${LINK} ${className}` : LINK}
      href={href}
      target={inPage ? undefined : '_blank'}
      rel={inPage ? undefined : 'noopener noreferrer'}
      {...props}
    >
      <InLink.Provider value={true}>{children}</InLink.Provider>
    </a>
  )
}

type ImageProps = ComponentProps<'img'> & { node?: unknown }

// An image becomes a link to itself: no fetch happens until the owner
// chooses to follow it (see the header comment). Inside a link it is just
// the link's text; with a dropped URL it is just its alt.
function Image({ src, alt }: ImageProps) {
  const inLink = useContext(InLink)
  const href = typeof src === 'string' ? src : ''
  if (!href || inLink) return <span>{alt || href || 'image'}</span>
  return (
    <a className={LINK} href={href} target="_blank" rel="noopener noreferrer">
      {alt || href}
    </a>
  )
}

type PreProps = ComponentProps<'pre'> & { node?: unknown }

const PRE =
  'overflow-x-auto rounded-md bg-neutral-900 dark:bg-neutral-950 text-neutral-200 p-3 font-mono text-mono-sm leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none [&>code]:text-inherit'

const COPY_BUTTON =
  'absolute top-1.5 right-1.5 rounded-sm p-1 bg-neutral-900/80 dark:bg-neutral-950/80 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 dark:hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-400 transition-colors duration-fast'

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * A fenced block: the scrolling `<pre>` plus a copy button. The button only
 * exists where `navigator.clipboard` does (a secure context — localhost, the
 * tailnet URL, the tunnel; not a bare LAN `http://`), because a button that
 * cannot do the thing is a decoy. The copied/failed state comes from the
 * promise, not the click: `writeText` rejecting (permission denied, page not
 * focused) shows a cross, never a tick.
 */
function CodeBlock({ node: _node, className, children, ...props }: PreProps) {
  const ref = useRef<HTMLPreElement>(null)
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined

  const settle = (next: CopyState) => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }
  const copy = () => {
    if (!clipboard) return
    const text = ref.current?.textContent ?? ''
    clipboard.writeText(text).then(
      () => settle('copied'),
      () => settle('failed'),
    )
  }

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy
  return (
    <div className="relative my-2">
      <pre ref={ref} className={clsx(PRE, className)} {...props}>
        {children}
      </pre>
      {clipboard && (
        <button
          type="button"
          className={clsx(
            COPY_BUTTON,
            state === 'copied' && 'text-success hover:text-success',
            state === 'failed' && 'text-danger hover:text-danger',
          )}
          aria-label={
            state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy code'
          }
          title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
          data-state={state}
          onClick={copy}
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

const COMPONENTS: Components = {
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => <h1 className={`${HEADING} text-h2`} {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className={`${HEADING} text-h3`} {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className={`${HEADING} text-h4`} {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className={`${HEADING} text-h4`} {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className={`${HEADING} text-h4`} {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className={`${HEADING} text-h4`} {...props} />,
  ul: ({ node: _node, ...props }) => (
    <ul className="my-2 list-disc pl-5 space-y-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="my-2 list-decimal pl-5 space-y-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="[&>p]:my-0" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-border pl-3 text-content-secondary [&>p]:my-1"
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-border" {...props} />,
  a: Anchor,
  img: Image,
  // `code` renders for both inline code and the child of a fenced block. The
  // inline pill is the default; `pre` strips it back off its own child with
  // the `[&>code]` overrides in PRE, so block code is one style decision, not
  // a parent check inside the code component. The incoming className is the
  // fence's `language-*` (and the plugin's `hljs`); it is merged with the
  // pill classes rather than either replacing the other, so a block's
  // `<code>` carries both and the `pre` decides what shows.
  code: ({ node: _node, className, ...props }) => (
    <code
      className={clsx(
        'font-mono text-mono-sm bg-surface-elevated px-1 py-0.5 rounded-xs',
        className,
      )}
      {...props}
    />
  ),
  pre: CodeBlock,
  table: ({ node: _node, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="border-collapse text-compact" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-surface-elevated" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-border px-2 py-1 align-top" {...props} />
  ),
}

/** The parse. Memo'd so an urgent render with unchanged deferred text skips it. */
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  )
})

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const deferred = useDeferredValue(text)
  return <MarkdownBody text={deferred} />
})
