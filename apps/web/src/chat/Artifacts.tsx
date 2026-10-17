// Artifacts (FR-038): an `artifact` part renders as a card that opens the Inspector's Artifacts
// tab; the tab lists the chat's artifacts and shows one. Markdown uses the reply renderer, code the
// built-in highlighter, HTML runs in an iframe sandboxed to scripts only (never same-origin, so it
// cannot reach the app or its session), SVG and images load as images (no script runs in an
// <img>), PDFs open in the browser's viewer, and anything else is offered as a download. Live and
// edited artifacts re-render on `artifact.created|updated`.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ArtifactKind, ArtifactView, EventEnvelope } from '@nova/shared';
import { Button, CodeBlock, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatBytes } from './attachments.ts';
import { Markdown } from './Markdown.tsx';
import type { ArtifactPart } from './thread-state.ts';

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
  const kind = ARTIFACT_KIND_TEXT[part.kind];
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
                  {ARTIFACT_KIND_TEXT[a.kind]}
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
        <object className="artifact-frame" data={url} type="application/pdf" aria-label={title}>
          <p>
            This browser cannot show the PDF here.{' '}
            <a href={download} target="_blank" rel="noopener noreferrer">
              Open the PDF
            </a>
          </p>
        </object>
      );
      break;
    case 'file':
      body = <p className="muted">This file cannot be previewed. Download it to open it.</p>;
      break;
  }
  return (
    <article className="artifact-viewer" aria-labelledby={titleId} data-kind={a.kind}>
      <h3 id={titleId} className="artifact-viewer-title" tabIndex={-1}>
        {title}
      </h3>
      <p className="muted artifact-meta">
        {ARTIFACT_KIND_TEXT[a.kind]}
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
