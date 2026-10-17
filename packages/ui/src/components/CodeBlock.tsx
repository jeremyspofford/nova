// CodeBlock (docs/04 §4.2): preformatted code with the built-in highlighter (FR-038). Tokens are
// rendered as text inside spans, never as HTML, so untrusted code cannot inject markup. The block
// is focusable so keyboard users can scroll long lines.
import { memo, useMemo } from 'react';
import { highlight, normalizeLanguage } from '../highlight.ts';

export interface CodeBlockProps {
  code: string;
  /** A language name, alias or file extension; unknown languages render as plain text. */
  language?: string | null;
  /** Accessible name for the scrollable block. */
  label?: string;
  className?: string;
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  label,
  className,
}: CodeBlockProps) {
  const tokens = useMemo(() => highlight(code, language), [code, language]);
  const lang = normalizeLanguage(language);
  return (
    <pre
      className={className ? `nv-code ${className}` : 'nv-code'}
      data-language={lang ?? undefined}
      aria-label={label}
      tabIndex={0}
    >
      <code>
        {tokens.map((t, i) =>
          t.type === 'plain' ? (
            t.text
          ) : (
            <span key={i} className={`nv-tok nv-tok-${t.type}`}>
              {t.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
});
