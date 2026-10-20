// Markdown for assistant replies (FR-018). react-markdown never renders raw HTML (no rehype-raw)
// and drops unsafe URL schemes; links open in a new tab without access to this window. While
// Find in chat is open, matches are marked during rendering (FR-025).
import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeFind } from './find.tsx';

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="md-pre" dir="ltr">
      {children}
    </pre>
  ),
  code: ({ className, children }) => <code className={className}>{children}</code>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text, find }: { text: string; find?: string }) {
  const rehypePlugins = useMemo<Options['rehypePlugins']>(
    () => (find?.trim() ? [rehypeFind(find) as NonNullable<Options['rehypePlugins']>[number]] : []),
    [find],
  );
  return (
    <div className="md" dir="auto">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
