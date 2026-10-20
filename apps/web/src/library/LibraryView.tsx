// Library (FR-041): artifacts, attachments, project sources, images and files from every chat and
// project, filtered by kind, searched by title, and paged. Each item opens where it belongs (the
// chat, the project or the artifact), using the link the Hub gives it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryItemView, LibraryKind } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, TextField, rovingIndex, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatBytes } from '../chat/attachments.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';

export const LIBRARY_TEXT = defineMessages('library', {
  /** The kind filter's choices. */
  filter: {
    all: 'All',
    artifact: 'Artifacts',
    attachment: 'Attachments',
    source: 'Sources',
    image: 'Images',
    file: 'Files',
  },
  kind: {
    artifact: 'Artifact',
    attachment: 'Attachment',
    source: 'Source',
    image: 'Image',
    file: 'File',
  },
  loadFailed: 'Could not load the library.',
  moreFailed: 'Could not load more.',
  title: 'Library',
  intro: 'Artifacts, attachments, sources and images from all your chats and projects.',
  kindLabel: 'Kind',
  search: 'Search the library',
  searchPlaceholder: 'Title',
  retry: 'Retry',
  loading: 'Loading the library',
  loadingDots: 'Loading…',
  noMatchTitle: 'Nothing matches',
  noMatchBody: 'Try another kind or search.',
  emptyTitle: 'Nothing here yet',
  emptyBody: 'Artifacts, attachments and sources from your chats and projects appear here.',
  count:
    '{more, select, yes {{n, plural, one {# item, more available} other {# items, more available}}} other {{n, plural, one {# item} other {# items}}}}',
  list: 'Library items',
  /** An item's kind and size: "Attachment, 2 KB". */
  withSize: '{kind}, {size}',
  showMore: 'Show more',
});

/** The kind filter's choices, in order. */
export const LIBRARY_KINDS: readonly (LibraryKind | 'all')[] = [
  'all',
  'artifact',
  'attachment',
  'source',
  'image',
  'file',
];

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
          if (alive) setError(errorMessage(err, LIBRARY_TEXT.loadFailed));
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
        (err: unknown) => setError(errorMessage(err, LIBRARY_TEXT.moreFailed)),
      )
      .finally(() => setMore(false));
  }, [api, kind, more, page, q]);

  const current = page && page.key === key ? page : null;
  const choose = (i: number) => {
    const k = LIBRARY_KINDS[i];
    if (!k) return;
    setKind(k);
    radios.current?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
  };
  const at = LIBRARY_KINDS.indexOf(kind);

  return (
    <section className="library" aria-labelledby="library-title">
      <h1 id="library-title" className="library-title">
        {LIBRARY_TEXT.title}
      </h1>
      <p className="muted">{LIBRARY_TEXT.intro}</p>
      <div className="library-filters">
        <div
          ref={radios}
          role="radiogroup"
          aria-label={LIBRARY_TEXT.kindLabel}
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
              key={k}
              type="button"
              role="radio"
              aria-checked={k === kind}
              tabIndex={k === kind ? 0 : -1}
              className="library-kind"
              onClick={() => choose(i)}
            >
              {LIBRARY_TEXT.filter[k]}
            </button>
          ))}
        </div>
        <div className="library-search">
          <TextField
            label={LIBRARY_TEXT.search}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={LIBRARY_TEXT.searchPlaceholder}
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
            {LIBRARY_TEXT.retry}
          </Button>
        </div>
      ) : !current ? (
        <p className="muted">
          <Spinner label={LIBRARY_TEXT.loading} /> {LIBRARY_TEXT.loadingDots}
        </p>
      ) : current.items.length === 0 ? (
        <EmptyState
          title={q || kind !== 'all' ? LIBRARY_TEXT.noMatchTitle : LIBRARY_TEXT.emptyTitle}
          description={q || kind !== 'all' ? LIBRARY_TEXT.noMatchBody : LIBRARY_TEXT.emptyBody}
          icon="library"
          level={2}
        />
      ) : (
        <>
          <p className="nv-vh" role="status">
            {LIBRARY_TEXT.count({
              n: current.items.length,
              more: current.cursor ? 'yes' : 'no',
            })}
          </p>
          <ul className="library-list" aria-label={LIBRARY_TEXT.list}>
            {current.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="library-item">
                <Icon name={KIND_ICON[item.kind]} />
                {inApp(item.href) ? (
                  <a
                    className="library-item-title"
                    dir="auto"
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
                  <span className="library-item-title" dir="auto">
                    {item.title}
                  </span>
                )}
                <span className="library-item-meta">
                  {item.size !== null
                    ? LIBRARY_TEXT.withSize({
                        kind: LIBRARY_TEXT.kind[item.kind],
                        size: formatBytes(item.size),
                      })
                    : LIBRARY_TEXT.kind[item.kind]}
                </span>
                <time className="library-item-meta" dateTime={item.createdAt}>
                  {fmt.date(item.createdAt)}
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
              {more ? <Spinner /> : null} {LIBRARY_TEXT.showMore}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
