// Artifacts (FR-038): an `artifact` part renders as a card that opens the Inspector's Artifacts
// tab; the tab lists the chat's artifacts and shows one. Markdown uses the reply renderer, code the
// built-in highlighter, HTML runs in an iframe sandboxed to scripts only (never same-origin, so it
// cannot reach the app or its session), SVG and images load as images (no script runs in an
// <img>), PDFs open in the browser's viewer, and anything else is offered as a download. Live and
// edited artifacts re-render on `artifact.created|updated`.
//
// Documents (FR-219): DOCX, PPTX and XLSX files and PDFs show a text and table preview the Hub
// extracts (GET /artifacts/:id/preview), so a large file is never parsed in the browser.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ArtifactKind, ArtifactView, EventEnvelope } from '@nova/shared';
import { Button, CodeBlock, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatBytes } from './attachments.ts';
import { Markdown } from './Markdown.tsx';
import type { ArtifactPart } from './thread-state.ts';
import '../workspace.css';

export const ARTIFACT_KIND_TEXT: Record<ArtifactKind, string> = {
  markdown: 'Document',
  code: 'Code',
  html: 'Web page',
  image: 'Image',
  svg: 'Image',
  chart: 'Chart',
  pdf: 'PDF',
  file: 'File',
};

/** Text artifacts larger than this are offered as a download instead of a preview. */
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

export type DocumentFormat = 'docx' | 'pptx' | 'xlsx' | 'pdf';

const DOCUMENT_MIMES: Record<string, DocumentFormat> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

export const DOCUMENT_KIND_TEXT: Record<DocumentFormat, string> = {
  docx: 'Document (DOCX)',
  pptx: 'Presentation (PPTX)',
  xlsx: 'Spreadsheet (XLSX)',
  pdf: 'PDF',
};

/** The document format of an artifact (FR-219): a PDF, or a file with an Office media type or name. */
export function documentFormatOf(a: {
  kind: ArtifactKind;
  mime?: string | null;
  title: string | null;
}): DocumentFormat | null {
  if (a.kind === 'pdf') return 'pdf';
  if (a.kind !== 'file') return null;
  const byMime = DOCUMENT_MIMES[a.mime?.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (byMime) return byMime;
  const ext = /\.(docx|pptx|xlsx)$/i.exec(a.title ?? '')?.[1]?.toLowerCase();
  return (ext as DocumentFormat | undefined) ?? null;
}

/** What kind of artifact this is, in words. */
export function artifactKindText(a: {
  kind: ArtifactKind;
  mime?: string | null;
  title: string | null;
}): string {
  const f = documentFormatOf(a);
  return f ? DOCUMENT_KIND_TEXT[f] : ARTIFACT_KIND_TEXT[a.kind];
}

const artifactTitle = (a: { title: string | null; kind: ArtifactKind }) =>
  a.title?.trim() || ARTIFACT_KIND_TEXT[a.kind];

/** The card an `artifact` part renders as inside a reply. */
export function ArtifactCard({
  part,
  onOpen,
}: {
  part: ArtifactPart;
  onOpen?: (artifactId: string) => void;
}) {
  const title = artifactTitle(part);
  const kind = artifactKindText(part);
  const body = (
    <>
      <Icon name="artifact" />
      <span className="artifact-card-title">{title}</span>
      <span className="muted artifact-card-kind">{kind}</span>
    </>
  );
  if (!onOpen)
    return (
      <div className="artifact-card" data-kind={part.kind}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      className="artifact-card"
      data-kind={part.kind}
      aria-label={`Open artifact: ${title} (${kind})`}
      onClick={() => onOpen(part.artifactId)}
    >
      {body}
      <span className="artifact-card-open">
        Open <Icon name="forward" />
      </span>
    </button>
  );
}

const ARTIFACT_EVENTS = new Set(['artifact.created', 'artifact.updated']);

function eventThread(env: EventEnvelope): string | null {
  const p = env.payload;
  return env.correlation?.threadId ?? (typeof p.threadId === 'string' ? p.threadId : null);
}

export interface ArtifactsPanelProps {
  threadId: string | null;
  selectedId: string | null;
  onSelect: (artifactId: string | null) => void;
}

export function ArtifactsPanel({ threadId, selectedId, onSelect }: ArtifactsPanelProps) {
  const { api, bus } = useServices();
  const [items, setItems] = useState<ArtifactView[] | null>(null);
  const [extra, setExtra] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Per-artifact update count, so a live artifact reloads even when its version stays. */
  const [revs, setRevs] = useState<Record<string, number>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!threadId) return;
    api.listArtifacts(threadId).then(
      ({ items: list }) => {
        setItems(list);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err, 'Could not load artifacts.')),
    );
  }, [api, threadId]);

  useEffect(() => {
    // The list arrives asynchronously; nothing is set synchronously here.
    load();
  }, [load]);

  useEffect(
    () =>
      bus.subscribe((env) => {
        if (!ARTIFACT_EVENTS.has(env.name) || !threadId || eventThread(env) !== threadId) return;
        const aid = env.payload.artifactId;
        if (env.name === 'artifact.updated' && typeof aid === 'string')
          setRevs((r) => ({ ...r, [aid]: (r[aid] ?? 0) + 1 }));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(load, 60);
      }),
    [bus, load, threadId],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // An artifact opened from a link may not be in this chat's list; fetch it by id.
  const listed = selectedId ? (items?.find((a) => a.id === selectedId) ?? null) : null;
  const missing = !!selectedId && items !== null && !listed && extra?.id !== selectedId;
  useEffect(() => {
    if (!missing || !selectedId) return;
    let alive = true;
    api.getArtifact(selectedId).then(
      (view) => {
        if (alive) setExtra(view);
      },
      (err: unknown) => {
        if (alive) setError(errorMessage(err, 'Could not open that artifact.'));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, missing, selectedId]);

  if (!threadId) return <p className="muted">Open a chat to see its artifacts.</p>;
  const selected = listed ?? (extra && extra.id === selectedId ? extra : null);

  if (selectedId) {
    return (
      <section className="artifacts" aria-label="Artifacts">
        <Button variant="ghost" className="artifacts-back" onClick={() => onSelect(null)}>
          <Icon name="back" /> All artifacts
        </Button>
        {selected ? (
          <ArtifactViewer artifact={selected} rev={revs[selected.id] ?? 0} />
        ) : error ? (
          <p className="artifacts-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">
            <Spinner label="Loading the artifact" /> Loading…
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="artifacts" aria-label="Artifacts">
      {error ? (
        <div className="artifacts-error" role="alert">
          <p>{error}</p>
          <Button onClick={load}>Retry</Button>
        </div>
      ) : items === null ? (
        <p className="muted">
          <Spinner label="Loading artifacts" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="muted">
          No artifacts in this chat yet. Documents, code and pages the assistant makes appear here.
        </p>
      ) : (
        <ul className="artifact-list" aria-label="Artifacts in this chat">
          {items.map((a) => (
            <li key={a.id}>
              <button type="button" className="artifact-row" onClick={() => onSelect(a.id)}>
                <Icon name="artifact" />
                <span className="artifact-row-title">{artifactTitle(a)}</span>
                <span className="muted">
                  {artifactKindText(a)}
                  {a.version > 1 ? `, version ${a.version}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One artifact, rendered by kind. `rev` changes when the Hub reports an update. */
export function ArtifactViewer({ artifact: a, rev = 0 }: { artifact: ArtifactView; rev?: number }) {
  const { api } = useServices();
  const titleId = useId();
  const title = artifactTitle(a);
  const url = `${api.artifactContentUrl(a.id)}?v=${a.version}.${rev}`;
  const download = api.artifactContentUrl(a.id);
  const format = documentFormatOf(a);
  // The preview route sits next to the content route (apps/hub tools.ts).
  const previewUrl = `${download.replace(/\/content$/, '/preview')}?v=${a.version}.${rev}`;
  let body: ReactNode;
  switch (a.kind) {
    case 'markdown':
      body = <TextContent url={url} size={a.size} render={(t) => <Markdown text={t} />} />;
      break;
    case 'code':
      body = (
        <TextContent
          url={url}
          size={a.size}
          render={(t) => (
            <CodeBlock
              code={t}
              language={a.language ?? extension(a.title)}
              label={`Code: ${title}`}
            />
          )}
        />
      );
      break;
    case 'html':
      body = (
        <iframe
          className="artifact-frame"
          title={`Artifact: ${title}`}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      );
      break;
    case 'image':
    case 'svg':
      body = <img className="artifact-image" src={url} alt={title} />;
      break;
    case 'chart':
      body = a.mime.startsWith('image/') ? (
        <img className="artifact-image" src={url} alt={title} />
      ) : (
        <TextContent
          url={url}
          size={a.size}
          render={(t) => <CodeBlock code={t} language="json" label={`Chart data: ${title}`} />}
        />
      );
      break;
    case 'pdf':
      body = (
        <>
          <object className="artifact-frame" data={url} type="application/pdf" aria-label={title}>
            <p>
              This browser cannot show the PDF here.{' '}
              <a href={download} target="_blank" rel="noopener noreferrer">
                Open the PDF
              </a>
            </p>
          </object>
          <PdfText url={previewUrl} title={title} />
        </>
      );
      break;
    case 'file':
      body = format ? (
        <DocumentPreview url={previewUrl} title={title} />
      ) : (
        <p className="muted">This file cannot be previewed. Download it to open it.</p>
      );
      break;
  }
  return (
    <article className="artifact-viewer" aria-labelledby={titleId} data-kind={a.kind}>
      <h3 id={titleId} className="artifact-viewer-title" tabIndex={-1}>
        {title}
      </h3>
      <p className="muted artifact-meta">
        {artifactKindText(a)}
        {a.language && a.kind === 'code' ? `, ${a.language}` : ''}, version {a.version},{' '}
        {formatBytes(a.size)}
        {a.live ? ', live' : ''}
      </p>
      {body}
      <p className="artifact-actions">
        <a href={download} download={a.title ?? `artifact-${a.id}`} className="link">
          <Icon name="download" /> Download
        </a>
      </p>
    </article>
  );
}

function extension(name: string | null): string | null {
  const m = name ? /\.([A-Za-z0-9+]+)$/.exec(name) : null;
  return m?.[1] ?? null;
}

/** Fetches a text artifact (with the session cookie) and renders it; reloads when `url` changes. */
function TextContent({
  url,
  size,
  render,
}: {
  url: string;
  size: number;
  render: (text: string) => ReactNode;
}) {
  const [state, setState] = useState<{ url: string; text?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const tooBig = size > TEXT_PREVIEW_LIMIT;
  useEffect(() => {
    if (tooBig) return;
    let alive = true;
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'The artifact is gone.' : res.statusText);
        return res.text();
      })
      .then(
        (text) => {
          if (alive) setState({ url, text });
        },
        (err: unknown) => {
          if (alive) setState({ url, error: errorMessage(err, 'Could not load the artifact.') });
        },
      );
    return () => {
      alive = false;
    };
  }, [url, attempt, tooBig]);

  if (tooBig) return <p className="muted">Too large to preview here. Download it to open it.</p>;
  // Until the new version arrives, the previous text stays on screen.
  if (state?.error && state.url === url)
    return (
      <div className="artifacts-error" role="alert">
        <p>{state.error}</p>
        <Button
          onClick={() => {
            setState(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (state?.text === undefined)
    return (
      <p className="muted">
        <Spinner label="Loading the artifact" /> Loading…
      </p>
    );
  return <>{render(state.text)}</>;
}

// ---- document previews (FR-219) ---------------------------------------------------------------

/** GET /artifacts/:id/preview: the text and tables the Hub extracted (core ExtractedDocument). */
export interface DocumentPreviewView {
  format: DocumentFormat;
  title: string | null;
  blocks?: (
    | { type: 'heading'; level: number; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'list'; ordered: boolean; items: string[] }
    | { type: 'table'; rows: string[][] }
  )[];
  slides?: {
    index: number;
    title: string | null;
    paragraphs: { text: string; level: number }[];
    notes: string | null;
  }[];
  sheets?: { name: string; rows: string[][]; truncated: boolean }[];
  pages?: { index: number; text: string }[];
  readable: boolean;
  note: string | null;
  truncated: boolean;
}

function Rows({ rows, label }: { rows: string[][]; label: string }) {
  const [head, ...rest] = rows;
  if (!head) return <p className="muted">Empty.</p>;
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
  return (
    // A wide table scrolls inside its own focusable region.
    <div className="md-table" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {cells(head).map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rest.map((r, i) => (
            <tr key={i}>
              {cells(r).map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentBody({ doc, title }: { doc: DocumentPreviewView; title: string }) {
  // Headings inside the preview sit below the viewer's own h3.
  const H = ({ level, children }: { level: number; children: ReactNode }) => {
    const n = Math.min(6, 3 + level);
    return n === 4 ? <h4>{children}</h4> : n === 5 ? <h5>{children}</h5> : <h6>{children}</h6>;
  };
  return (
    <div className="md artifact-document">
      {doc.note ? <p className="muted">{doc.note}</p> : null}
      {doc.blocks?.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return (
              <H key={i} level={b.level}>
                {b.text}
              </H>
            );
          case 'paragraph':
            return (
              <p key={i} className="ws-summary">
                {b.text}
              </p>
            );
          case 'list': {
            const items = b.items.map((t, j) => <li key={j}>{t}</li>);
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
          case 'table':
            return <Rows key={i} rows={b.rows} label={`Table ${i + 1} of ${title}`} />;
        }
      })}
      {doc.slides?.length ? (
        <ol aria-label="Slides">
          {doc.slides.map((sl) => (
            <li key={sl.index}>
              <strong>{sl.title ?? `Slide ${sl.index}`}</strong>
              {sl.paragraphs.length ? (
                <ul>
                  {sl.paragraphs.map((p, j) => (
                    <li key={j} data-level={p.level}>
                      {p.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              {sl.notes ? <p className="muted ws-summary">Notes: {sl.notes}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {doc.sheets?.map((sh) => (
        <section key={sh.name} aria-label={`Sheet ${sh.name}`}>
          <h4>{sh.name}</h4>
          <Rows rows={sh.rows} label={`Cells of ${sh.name}`} />
          {sh.truncated ? (
            <p className="muted">Only the first rows and columns are shown.</p>
          ) : null}
        </section>
      ))}
      {doc.pages?.map((pg) => (
        <section key={pg.index} aria-label={`Page ${pg.index}`}>
          <h4>Page {pg.index}</h4>
          <p className="ws-summary">{pg.text || '(no text)'}</p>
        </section>
      ))}
      {doc.truncated ? (
        <p className="muted">This preview shows the start only. Download the file for all of it.</p>
      ) : null}
    </div>
  );
}

/** Fetches the Hub's extracted preview of a document artifact and renders it. */
function DocumentPreview({ url, title }: { url: string; title: string }) {
  const [state, setState] = useState<{
    url: string;
    doc?: DocumentPreviewView;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        const text = await res.text();
        if (!res.ok) {
          let message = res.status === 404 ? 'The artifact is gone.' : res.statusText;
          try {
            const body = JSON.parse(text) as { error?: { message?: unknown } };
            if (res.status !== 404 && typeof body.error?.message === 'string')
              message = body.error.message;
          } catch {
            // not JSON: keep the status text
          }
          throw new Error(message || 'Could not load the preview.');
        }
        return JSON.parse(text) as DocumentPreviewView;
      })
      .then(
        (doc) => {
          if (alive) setState({ url, doc });
        },
        (err: unknown) => {
          if (alive) setState({ url, error: errorMessage(err, 'Could not load the preview.') });
        },
      );
    return () => {
      alive = false;
    };
  }, [url, attempt]);
  if (state?.error && state.url === url)
    return (
      <div className="artifacts-error" role="alert">
        <p>The preview could not be loaded: {state.error}</p>
        <Button
          onClick={() => {
            setState(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (!state?.doc)
    return (
      <p className="muted">
        <Spinner label="Loading the preview" /> Loading…
      </p>
    );
  return <DocumentBody doc={state.doc} title={title} />;
}

/** A PDF's extracted text, on request: for screen readers and browsers without a PDF viewer. */
function PdfText({ url, title }: { url: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="artifact-actions">
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide the text' : 'Show the text'}
        </Button>
      </p>
      {open ? <DocumentPreview url={url} title={title} /> : null}
    </>
  );
}
