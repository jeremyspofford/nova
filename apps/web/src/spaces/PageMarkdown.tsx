// A page's preview (FR-036, FR-076): Markdown as in chat replies (no raw HTML, unsafe link schemes
// dropped, links open without access to this window), plus fenced blocks that draw: ```chart
// (a JSON chart spec), ```diagram (the text form, or a JSON diagram spec) and ```nova-table <name>
// (a table of connected data, filled in only when a site is built). A spec that does not parse
// shows its error next to the code; its text never becomes markup.
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  chartSpecSchema,
  diagramSpecSchema,
  parseDiagramText,
  vizIssues,
  type ChartSpec,
  type DiagramSpec,
} from '@nova/shared';
import { CodeBlock, Icon } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ChartView, DiagramView } from './Visualization.tsx';

type Element = NonNullable<ExtraProps['node']>;
type ElementContent = Element['children'][number];

type Parsed<T> = { spec: T; error?: undefined } | { spec?: undefined; error: string };

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** A ```chart block: a JSON chart spec. */
export function parseChartBlock(text: string): Parsed<ChartSpec> {
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch {
    return { error: 'The chart is not valid JSON.' };
  }
  const r = chartSpecSchema.safeParse(raw);
  return r.success ? { spec: r.data } : { error: vizIssues(r.error) };
}

/** A ```diagram block: JSON when it starts with a brace, else the text form. */
export function parseDiagramBlock(text: string): Parsed<DiagramSpec> {
  if (text.trimStart().startsWith('{')) {
    let raw: unknown;
    try {
      raw = parseJson(text);
    } catch {
      return { error: 'The diagram is not valid JSON.' };
    }
    const r = diagramSpecSchema.safeParse(raw);
    return r.success ? { spec: r.data } : { error: vizIssues(r.error) };
  }
  try {
    return { spec: parseDiagramText(text) };
  } catch (err) {
    return { error: errorMessage(err, 'The diagram could not be read.') };
  }
}

function textOf(nodes: ElementContent[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? n.value : n.type === 'element' ? textOf(n.children) : ''))
    .join('');
}

/** The language, info-string rest and text of a fenced block's <code> element. */
function fence(pre: Element | undefined): { lang: string; meta: string; text: string } | null {
  const code = pre?.children.find((c): c is Element => c.type === 'element');
  if (code?.tagName !== 'code') return null;
  const cls = code.properties.className;
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? [cls] : [];
  const lang = list.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
  // The fence's text ends with the newline before the closing fence.
  return {
    lang,
    meta: code.data?.meta?.trim() ?? '',
    text: textOf(code.children).replace(/\n$/, ''),
  };
}

function Invalid({
  what,
  error,
  code,
  lang,
}: {
  what: string;
  error: string;
  code: string;
  lang: string;
}) {
  return (
    <div className="viz-invalid">
      <p className="viz-note" role="note">
        <Icon name="alert" /> This {what} could not be drawn: {error}
      </p>
      <CodeBlock code={code} language={lang === 'chart' ? 'json' : null} label={`${what} source`} />
    </div>
  );
}

function Block({
  lang,
  meta,
  text,
  fallback,
}: {
  lang: string;
  meta: string;
  text: string;
  fallback: ReactNode;
}) {
  switch (lang) {
    case 'chart': {
      const p = parseChartBlock(text);
      return p.spec ? (
        <ChartView spec={p.spec} />
      ) : (
        <Invalid what="chart" error={p.error} code={text} lang={lang} />
      );
    }
    case 'diagram': {
      const p = parseDiagramBlock(text);
      return p.spec ? (
        <DiagramView spec={p.spec} />
      ) : (
        <Invalid what="diagram" error={p.error} code={text} lang={lang} />
      );
    }
    case 'nova-table': {
      const name = meta || text.trim().split(/\s+/)[0] || '';
      return (
        <p className="viz-note" role="note">
          <Icon name="file" />{' '}
          {name
            ? `Table from the connected data “${name}” (filled in when the site is built).`
            : 'A table of connected data needs a name, for example: nova-table sales.'}
        </p>
      );
    }
    default:
      return <>{fallback}</>;
  }
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ node, children }) => {
    const pre = <pre className="md-pre">{children}</pre>;
    const f = fence(node);
    if (!f) return pre;
    return <Block lang={f.lang} meta={f.meta} text={f.text} fallback={pre} />;
  },
  code: ({ className, children }) => <code className={className}>{children}</code>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins = [remarkGfm];

export const PageMarkdown = memo(function PageMarkdown({ text }: { text: string }) {
  return (
    <div className="md spaces-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
