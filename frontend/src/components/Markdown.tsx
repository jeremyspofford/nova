import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Shared markdown renderer for chat bubbles, the memory detail pane, the
 *  Files editor's preview, and the Vault.
 *
 * Raw HTML is deliberately NOT enabled — memory content originates from
 * ingested web pages; it renders as text, never as live markup. Images and
 * links are allowed (lazy-loaded / new-tab respectively).
 *
 * `[[wikilinks]]` are OPT-IN, via `onWikilink`. Without that prop this
 * renders `[[Foo]]` as the literal text it has always been — chat bubbles
 * quote note titles all the time and must not sprout links into a surface
 * the phone may not even have open.
 */

/** Nova's own link syntax, matched exactly as the backend matches it —
 *  `backend/app/memory/store.py:27`. `[[a|b]]` and `[[a#h]]` are deliberately
 *  NOT parsed: two live titles contain a literal `|`, and
 *  `backend/app/memory/links.py:26-30` records that teaching the regex about
 *  aliases would break links that resolve today. Do not "fix" this. */
const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/** A URL scheme no real href can collide with, so ONE anchor override can
 *  tell a wikilink from a link without a second components map per callsite. */
const WIKI = 'nova-wiki:';

/** The subset of mdast this walk touches. react-markdown's own node types are
 *  not exported in a form worth importing for six fields. */
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/** Turn `[[Title]]` inside text nodes into real mdast `link` nodes.
 *
 *  A remark plugin rather than a string pre-pass, because a pre-pass rewrites
 *  inside fenced blocks and inline code — a note documenting the link syntax
 *  would linkify itself — and because 50 of 97 live link targets contain regex
 *  metacharacters (one title starts `$5 VPS…`), so building markdown from
 *  `[$1](#wiki:$1)` produces broken output for any title holding `)` or `]`.
 *
 *  Hand-written rather than `unist-util-visit`: that package is only a
 *  transitive dependency of remark-gfm, and relying on hoisting IS a new
 *  dependency in practice — one that costs `docker compose build frontend`
 *  AND `build web` the day it stops hoisting. The walk is also what lets us
 *  skip `code`/`inlineCode`/`link` explicitly. */
function remarkWikilinks() {
  return (tree: MdNode) => {
    const walk = (parent: MdNode) => {
      if (!parent.children) return;
      const out: MdNode[] = [];
      for (const n of parent.children) {
        // never inside code, and never a link nested in a link
        if (n.type === 'code' || n.type === 'inlineCode' || n.type === 'link') {
          out.push(n);
          continue;
        }
        if (n.type !== 'text' || !n.value?.includes('[[')) {
          walk(n);
          out.push(n);
          continue;
        }
        let last = 0;
        WIKI_RE.lastIndex = 0;
        for (let m = WIKI_RE.exec(n.value); m; m = WIKI_RE.exec(n.value)) {
          if (m.index > last) out.push({ type: 'text', value: n.value.slice(last, m.index) });
          out.push({
            type: 'link',
            url: WIKI + encodeURIComponent(m[1]),
            children: [{ type: 'text', value: m[1] }],
          });
          last = m.index + m[0].length;
        }
        if (last < n.value.length) out.push({ type: 'text', value: n.value.slice(last) });
      }
      parent.children = out;
    };
    walk(tree);
  };
}

// Hoisted to module scope: this map is ~15 component overrides and it was
// rebuilt on EVERY render. During a reply that meant once per streamed
// token, for every message on screen — a new object identity each time,
// so react-markdown could never treat the config as stable.

/** What react-markdown hands an `a` override: the HTML anchor props plus the
 *  mdast node. Spelled out rather than reached through `Components['a']`,
 *  which is a union wide enough that spreading through it does not typecheck. */
type AnchorProps = React.ComponentPropsWithoutRef<'a'> & { node?: unknown };

/** Pulled out of the map so the wikilink-aware anchor can fall through to it
 *  for every href that is not one of ours. */
const ExternalLink = ({ href, children: kids }: AnchorProps) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-teal-400 hover:text-teal-300 underline decoration-teal-700 underline-offset-2 break-all"
  >
    {kids}
  </a>
);

const COMPONENTS: Components = {
  a: ExternalLink,
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      className="max-w-full h-auto rounded-md border border-stone-700 my-2"
    />
  ),
  h1: ({ children: kids }) => <h1 className="text-base font-bold text-stone-100 mt-3 mb-1.5">{kids}</h1>,
  h2: ({ children: kids }) => <h2 className="text-[15px] font-bold text-stone-100 mt-3 mb-1.5">{kids}</h2>,
  h3: ({ children: kids }) => <h3 className="text-sm font-semibold text-stone-200 mt-2.5 mb-1">{kids}</h3>,
  p: ({ children: kids }) => <p className="my-1.5 leading-relaxed">{kids}</p>,
  ul: ({ children: kids }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{kids}</ul>,
  ol: ({ children: kids }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{kids}</ol>,
  blockquote: ({ children: kids }) => (
    <blockquote className="border-l-2 border-stone-600 pl-3 my-2 text-stone-400 italic">{kids}</blockquote>
  ),
  // Block chrome + horizontal scrolling live on <pre> so EVERY fenced
  // block is contained, language tag or not (untagged fences used to
  // fall into the inline style inside a bare pre and overflow the
  // bubble). The child selectors neutralize the inline-chip styling
  // when that code lands inside a pre.
  code: ({ className, children: kids }) => {
    const isBlock = /language-/.test(className ?? '');
    return isBlock ? (
      <code className={`${className} block text-xs font-mono`}>{kids}</code>
    ) : (
      <code className="bg-stone-950/70 border border-stone-700/60 rounded px-1 py-0.5 text-xs font-mono break-words">
        {kids}
      </code>
    );
  },
  pre: ({ children: kids }) => (
    <pre className="my-2 bg-stone-950/70 border border-stone-700 rounded-md p-2.5 text-xs font-mono overflow-x-auto nice-scroll max-w-full [&>code]:bg-transparent [&>code]:border-0 [&>code]:p-0 [&>code]:rounded-none [&>code]:block [&>code]:break-normal">
      {kids}
    </pre>
  ),
  table: ({ children: kids }) => (
    <div className="overflow-x-auto nice-scroll my-2">
      <table className="text-xs border-collapse">{kids}</table>
    </div>
  ),
  th: ({ children: kids }) => (
    <th className="border border-stone-700 bg-stone-800 px-2 py-1 text-left font-semibold">{kids}</th>
  ),
  td: ({ children: kids }) => <td className="border border-stone-700 px-2 py-1">{kids}</td>,
  hr: () => <hr className="border-stone-700 my-3" />,
};

// Both arrays are module constants so the opt-in never costs the three
// existing callers a new identity.
const REMARK_PLUGINS = [remarkGfm];
const REMARK_WIKI = [remarkGfm, remarkWikilinks];

/** The wikilink-aware map. Built per (onWikilink, resolveWikilink) pair rather
 *  than hoisted, because it has to close over the callbacks — which is exactly
 *  why the default map stays hoisted and untouched. */
function wikiComponents(
  onWikilink: (title: string) => void,
  resolveWikilink?: (title: string) => boolean,
): Components {
  return {
    ...COMPONENTS,
    a: (props: AnchorProps) => {
      const { href, children: kids } = props;
      if (!href?.startsWith(WIKI)) return <ExternalLink {...props} />;
      const title = decodeURIComponent(href.slice(WIKI.length));
      // Unresolvable links are shown, not hidden. A note whose target was
      // renamed still SAYS what it meant, and the amber says the corpus no
      // longer holds it — which is the repair cue.
      const live = resolveWikilink ? resolveWikilink(title) : true;
      return (
        // A <button> is phrasing content, so this stays valid inside a <p>.
        <button
          type="button"
          onClick={live ? () => onWikilink(title) : undefined}
          title={live ? `Open “${title}”` : `No note is titled “${title}”`}
          className={live
            ? 'text-teal-300 hover:text-teal-200 underline decoration-dotted decoration-teal-700 underline-offset-2 text-left'
            : 'text-amber-400/80 underline decoration-dotted decoration-amber-700/70 underline-offset-2 cursor-help text-left'}
        >
          {kids}
        </button>
      );
    },
  };
}

function MarkdownImpl({ children, onWikilink, resolveWikilink }: {
  children: string;
  /** Vault only. ABSENT ⇒ `[[Foo]]` renders as the literal text it is in chat
   *  bubbles, the memory card and the Files preview today.
   *  MUST be `useCallback`-stable: this component is memoised on props, and a
   *  fresh arrow every render re-parses the whole note on every keystroke —
   *  the ~11.6ms trap the memo below exists to avoid. */
  onWikilink?: (title: string) => void;
  /** Does a note with this title exist? Drives the dangling style. Same
   *  stability requirement. */
  resolveWikilink?: (title: string) => boolean;
}) {
  const components = useMemo(
    () => (onWikilink ? wikiComponents(onWikilink, resolveWikilink) : COMPONENTS),
    [onWikilink, resolveWikilink]);
  return (
    <ReactMarkdown
      remarkPlugins={onWikilink ? REMARK_WIKI : REMARK_PLUGINS}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}

/** Memoised on the text alone. Streaming re-renders the whole chat on every
 *  token, and without this each token re-parsed the markdown of EVERY
 *  message in the history — measured at ~11.6ms per parse, so a 40 tok/s
 *  reply into a 20-message conversation was asking the main thread for far
 *  more work per second than a second contains. Now only the message that
 *  actually changed re-parses. */
export const Markdown = memo(MarkdownImpl);