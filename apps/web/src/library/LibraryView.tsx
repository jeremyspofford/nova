// Library (FR-041): artifacts, attachments, project sources, images and files from every chat and
// project, filtered by kind, searched by title, and paged. Each item opens where it belongs (the
// chat, the project or the artifact), using the link the Hub gives it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryItemView, LibraryKind } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, TextField, rovingIndex, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatBytes } from '../chat/attachments.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';

export const LIBRARY_KINDS: { value: LibraryKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'artifact', label: 'Artifacts' },
  { value: 'attachment', label: 'Attachments' },
  { value: 'source', label: 'Sources' },
  { value: 'image', label: 'Images' },
  { value: 'file', label: 'Files' },
];

const KIND_TEXT: Record<LibraryKind, string> = {
  artifact: 'Artifact',
  attachment: 'Attachment',
  source: 'Source',
  image: 'Image',
  file: 'File',
};

const KIND_ICON: Record<LibraryKind, IconName> = {
  artifact: 'artifact',
  attachment: 'attach',
  source: 'folder',
  image: 'image',
  file: 'file',
};

const PAGE = 50;

/** Only paths inside the app become links; anything else from the Hub is shown as text. */
export function inApp(href: string): boolean {
  return /^\/(?![/\\])/.test(href);
}

interface PageState {
  items: LibraryItemView[];
  cursor: string | null;
  /** The query these items answer, so a stale answer is dropped. */
  key: string;
}

export function LibraryView({ searchDelayMs = 250 }: { searchDelayMs?: number }) {
  const { api } = useServices();
  const [kind, setKind] = useState<LibraryKind | 'all'>('all');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<PageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const radios = useRef<HTMLDivElement>(null);
  const key = `${kind}\u0000${q}`;

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), searchDelayMs);
    return () => clearTimeout(t);
  }, [text, searchDelayMs]);

  useEffect(() => {
    let alive = true;
    api
      .library({
        ...(kind === 'all' ? {} : { kind }),
        ...(q ? { q } : {}),
        limit: PAGE,
      })
      .then(
        (p) => {
          if (!alive) return;
          setPage({ items: p.items, cursor: p.nextCursor, key });
          setError(null);
        },
        (err: unknown) => {
          if (alive) setError(errorMessage(err, 'Could not load the library.'));
        },
      );
    return () => {
      alive = false;
    };
  }, [api, kind, q, key, attempt]);

  const loadMore = useCallback(() => {
    if (!page?.cursor || more) return;
    setMore(true);
    const at = page.key;
    api
      .library({
        ...(kind === 'all' ? {} : { kind }),
        ...(q ? { q } : {}),
        cursor: page.cursor,
        limit: PAGE,
      })
      .then(
        (p) =>
          setPage((cur) =>
            cur && cur.key === at
              ? { ...cur, items: [...cur.items, ...p.items], cursor: p.nextCursor }
              : cur,
          ),
        (err: unknown) => setError(errorMessage(err, 'Could not load more.')),
      )
      .finally(() => setMore(false));
  }, [api, kind, more, page, q]);

  const current = page && page.key === key ? page : null;
  const choose = (i: number) => {
    const k = LIBRARY_KINDS[i];
    if (!k) return;
    setKind(k.value);
    radios.current?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
  };
  const at = LIBRARY_KINDS.findIndex((k) => k.value === kind);

  return (
    <section className="library" aria-labelledby="library-title">
      <h1 id="library-title" className="library-title">
        Library
      </h1>
      <p className="muted">
        Artifacts, attachments, sources and images from all your chats and projects.
      </p>
      <div className="library-filters">
        <div
          ref={radios}
          role="radiogroup"
          aria-label="Kind"
          className="library-kinds"
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, at, LIBRARY_KINDS.length, 'horizontal');
            if (next === null) return;
            e.preventDefault();
            choose(next);
          }}
        >
          {LIBRARY_KINDS.map((k, i) => (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={k.value === kind}
              tabIndex={k.value === kind ? 0 : -1}
              className="library-kind"
              onClick={() => choose(i)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="library-search">
          <TextField
            label="Search the library"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Title"
          />
        </div>
      </div>
      {error && !current ? (
        <div className="files-error" role="alert">
          <p>{error}</p>
          <Button
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : !current ? (
        <p className="muted">
          <Spinner label="Loading the library" /> Loading…
        </p>
      ) : current.items.length === 0 ? (
        <EmptyState
          title={q || kind !== 'all' ? 'Nothing matches' : 'Nothing here yet'}
          description={
            q || kind !== 'all'
              ? 'Try another kind or search.'
              : 'Artifacts, attachments and sources from your chats and projects appear here.'
          }
          icon="library"
          level={2}
        />
      ) : (
        <>
          <p className="nv-vh" role="status">
            {current.items.length} {current.items.length === 1 ? 'item' : 'items'}
            {current.cursor ? ', more available' : ''}
          </p>
          <ul className="library-list" aria-label="Library items">
            {current.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="library-item">
                <Icon name={KIND_ICON[item.kind]} />
                {inApp(item.href) ? (
                  <a
                    className="library-item-title"
                    href={item.href}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(item.href);
                    }}
                  >
                    {item.title}
                  </a>
                ) : (
                  <span className="library-item-title">{item.title}</span>
                )}
                <span className="library-item-meta">
                  {KIND_TEXT[item.kind]}
                  {item.size !== null ? `, ${formatBytes(item.size)}` : ''}
                </span>
                <time className="library-item-meta" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
          {error ? (
            <p className="muted" role="alert">
              {error}
            </p>
          ) : null}
          {current.cursor ? (
            <Button className="library-more" onClick={loadMore} disabled={more}>
              {more ? <Spinner /> : null} Show more
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
