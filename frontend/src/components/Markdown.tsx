import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Shared markdown renderer for chat bubbles and the memory detail pane.
 *
 * Raw HTML is deliberately NOT enabled — memory content originates from
 * ingested web pages; it renders as text, never as live markup. Images and
 * links are allowed (lazy-loaded / new-tab respectively).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children: kids }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-400 hover:text-teal-300 underline decoration-teal-700 underline-offset-2 break-all"
          >
            {kids}
          </a>
        ),
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
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
