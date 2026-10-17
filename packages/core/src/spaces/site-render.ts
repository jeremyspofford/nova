// Static site generation (FR-037): a space's pages (or one artifact) become plain HTML files with
// inline CSS, connected data as `data/<name>.json`, and charts, diagrams and data tables drawn as
// static SVG and HTML (FR-076). The output has no script. The preview is the same pages in one
// document, switched with in-page links, so it works inside a sandboxed frame that cannot load
// other URLs with the user's session.
import {
  bindChartData,
  chartSpecSchema,
  diagramSpecSchema,
  escapeXml,
  layoutChart,
  layoutDiagram,
  parseDiagramText,
  sceneToSvg,
  tableToHtml,
  vizIssues,
  type VizScene,
} from '@nova/shared';
import type { DataRow } from './data.ts';
import { markdownToHtml, type MarkdownOptions } from './markdown.ts';

const esc = escapeXml;

export interface SitePageInput {
  slug: string;
  title: string;
  content: string;
}

export interface RenderedSite {
  /** Published files by path. */
  files: Map<string, Buffer>;
  /** The one-document preview. */
  preview: string;
  /** Whether the preview runs the source's own scripts (an HTML artifact). */
  scripts: boolean;
}

const TABLE_ROWS = 500;

const CSS = `
:root{color-scheme:light dark;--bg:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e1e0d9;--accent:#2a78d6;--code:#f0efec}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--muted:#c3c2b7;--line:#2c2c2a;--accent:#86b6ef;--code:#2c2c2a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.site-header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;padding:16px max(16px,calc(50% - 400px));border-bottom:1px solid var(--line)}
.site-name{font-weight:600;color:var(--fg);text-decoration:none}
nav ul{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;margin:0;padding:0}
nav a{color:var(--muted)}nav a[aria-current=page]{color:var(--fg);font-weight:600}
main{padding:24px max(16px,calc(50% - 400px)) 48px}
a{color:var(--accent)}
pre,code{font-family:ui-monospace,monospace;font-size:.9em;background:var(--code);border-radius:4px}
code{padding:.1em .3em}pre{padding:12px;overflow:auto}pre code{padding:0;background:none}
blockquote{margin:0;padding-left:16px;border-left:3px solid var(--line);color:var(--muted)}
img,svg{max-width:100%;height:auto}
.table{overflow-x:auto}table{border-collapse:collapse;margin:12px 0}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;font-variant-numeric:tabular-nums}
caption{text-align:left;color:var(--muted);font-size:.875em}
figure.viz{margin:16px 0}figure.viz details{margin-top:4px;font-size:.875em}
.note{color:var(--muted);font-size:.875em}
footer{padding:16px max(16px,calc(50% - 400px));color:var(--muted);border-top:1px solid var(--line);font-size:.875em}
`;

const PREVIEW_CSS = `
.page{display:none}.page:target,.page:has(:target){display:block}
main:not(:has(:target)) .page:first-of-type{display:block}
`;

function figure(scene: VizScene, title: string | null): string {
  const caption = title ?? scene.summary;
  const table = scene.table
    ? `<details><summary>Data</summary>${tableToHtml(
        { columns: scene.table.columns, rows: scene.table.rows.slice(0, TABLE_ROWS) },
        caption,
      )}</details>`
    : '';
  return `<figure class="viz">${sceneToSvg(scene, title)}${table}</figure>`;
}

function failed(what: string, message: string, body: string): string {
  return `<p class="note">The ${what} could not be drawn: ${esc(message)}</p><pre><code>${esc(body)}</code></pre>`;
}

function dataTable(name: string, rows: DataRow[] | undefined): string {
  if (!rows) return `<p class="note">No connected data is named ${esc(name)}.</p>`;
  const cols: string[] = [];
  for (const r of rows.slice(0, 50))
    for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const shown = rows.slice(0, TABLE_ROWS);
  const more =
    rows.length > shown.length
      ? `<p class="note">The first ${shown.length} of ${rows.length} rows; all of them are in data/${esc(name)}.json.</p>`
      : '';
  return `<div class="table">${tableToHtml(
    {
      columns: cols,
      rows: shown.map((r) =>
        cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))),
      ),
    },
    name,
  )}</div>${more}`;
}

/** Charts (`chart`), diagrams (`diagram`) and data tables (`nova-table <name>`) in pages. */
export function vizFence(
  data: Readonly<Record<string, DataRow[]>>,
): NonNullable<MarkdownOptions['fence']> {
  return (lang, info, body) => {
    if (lang === 'chart') {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return failed('chart', 'its spec is not valid JSON', body);
      }
      const spec = chartSpecSchema.safeParse(raw);
      if (!spec.success) return failed('chart', vizIssues(spec.error), body);
      try {
        return figure(layoutChart(bindChartData(spec.data, data)), spec.data.title ?? null);
      } catch (err) {
        return failed('chart', err instanceof Error ? err.message : 'unknown error', body);
      }
    }
    if (lang === 'diagram') {
      try {
        const trimmed = body.trim();
        const spec = trimmed.startsWith('{')
          ? diagramSpecSchema.parse(JSON.parse(trimmed))
          : parseDiagramText(trimmed);
        return figure(layoutDiagram(spec), null);
      } catch (err) {
        const message =
          err instanceof Error && 'issues' in err
            ? vizIssues(err as Parameters<typeof vizIssues>[0])
            : err instanceof Error
              ? err.message
              : 'unknown error';
        return failed('diagram', message, body);
      }
    }
    if (lang === 'nova-table') {
      const name = (info.split(/\s+/)[1] ?? body.trim()).trim();
      return dataTable(name, data[name]);
    }
    return null;
  };
}

function page(
  site: string,
  title: string,
  nav: string,
  body: string,
  footer: string | null,
): string {
  const head = title === site ? esc(site) : `${esc(title)} · ${esc(site)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Nova"><title>${head}</title><style>${CSS}</style></head>
<body><header class="site-header"><a class="site-name" href="index.html">${esc(site)}</a>${nav}</header>
<main>${body}</main>${footer ? `<footer>${esc(footer)}</footer>` : ''}</body></html>
`;
}

function dataFiles(files: Map<string, Buffer>, data: Readonly<Record<string, DataRow[]>>): void {
  for (const [name, rows] of Object.entries(data))
    files.set(`data/${name}.json`, Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8'));
}

/** A space's pages as a site: the first page is index.html, the others `<slug>.html`. */
export function renderSpaceSite(input: {
  name: string;
  description: string | null;
  pages: SitePageInput[];
  data: Readonly<Record<string, DataRow[]>>;
}): RenderedSite {
  const pages = input.pages.length
    ? input.pages
    : [{ slug: 'index', title: input.name, content: '_This site has no pages yet._' }];
  // The first page is the home page; another page named "index" must not overwrite it.
  const fileOf = (p: SitePageInput, i: number) =>
    i === 0 ? 'index.html' : p.slug === 'index' ? 'index-page.html' : `${p.slug}.html`;
  const first = pages[0]!;
  const fence = vizFence(input.data);
  const files = new Map<string, Buffer>();
  // Links to the first page by its slug go to index.html, which is where it lives.
  const fileLink = (href: string) => (href === `${first.slug}.html` ? 'index.html' : href);
  pages.forEach((p, i) => {
    const nav = `<nav aria-label="Pages"><ul>${pages
      .map(
        (q, k) =>
          `<li><a href="${esc(fileOf(q, k))}"${k === i ? ' aria-current="page"' : ''}>${esc(q.title)}</a></li>`,
      )
      .join('')}</ul></nav>`;
    const html = markdownToHtml(p.content, { fence, link: fileLink });
    files.set(
      fileOf(p, i),
      Buffer.from(
        page(input.name, p.title, nav, `<article>${html}</article>`, input.description),
        'utf8',
      ),
    );
  });
  dataFiles(files, input.data);

  // The preview: every page in one document; links between pages become in-page links.
  const slugOf = new Map(pages.map((p, i) => [fileOf(p, i), p.slug]));
  slugOf.set(`${first.slug}.html`, first.slug);
  const previewLink = (prefix: string) => (href: string) => {
    if (href.startsWith('#')) return `#${prefix}${href.slice(1)}`;
    const slug = slugOf.get(href.split('#')[0] ?? '');
    return slug ? `#page-${slug}` : href;
  };
  const nav = `<nav aria-label="Pages"><ul>${pages
    .map((q) => `<li><a href="#page-${esc(q.slug)}">${esc(q.title)}</a></li>`)
    .join('')}</ul></nav>`;
  const sections = pages
    .map((p) => {
      const prefix = `p-${p.slug}--`;
      const html = markdownToHtml(p.content, {
        fence,
        link: previewLink(prefix),
        idPrefix: prefix,
      });
      return `<section class="page" id="page-${esc(p.slug)}" aria-label="${esc(p.title)}"><article>${html}</article></section>`;
    })
    .join('\n');
  const preview = page(input.name, input.name, nav, sections, input.description).replace(
    '</style>',
    `${PREVIEW_CSS}</style>`,
  );
  return { files, preview, scripts: false };
}

/** One artifact as a site: an HTML page as it is, or Markdown rendered like a page. */
export function renderArtifactSite(input: {
  name: string;
  description: string | null;
  kind: 'html' | 'markdown';
  content: string;
  data: Readonly<Record<string, DataRow[]>>;
}): RenderedSite {
  if (input.kind === 'markdown')
    return renderSpaceSite({
      name: input.name,
      description: input.description,
      pages: [{ slug: 'index', title: input.name, content: input.content }],
      data: input.data,
    });
  const files = new Map<string, Buffer>([['index.html', Buffer.from(input.content, 'utf8')]]);
  dataFiles(files, input.data);
  // An HTML artifact keeps its own scripts; the preview runs them only in an opaque origin.
  return { files, preview: input.content, scripts: /<script[\s>]/i.test(input.content) };
}
