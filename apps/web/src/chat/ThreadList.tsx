// Chat list (FR-017): Pinned and Recent groups, with rename (inline), pin, archive and delete
// (confirmed) from each row's menu or its context menu. Rows use a roving tabindex so the list is
// one tab stop: arrows, Home and End move; F2 renames; Shift+F10 opens the row's menu.
import { useEffect, useRef, useState } from 'react';
import type { ThreadView } from '@nova/shared';
import { Button, Dialog, Menu, StatusChip, VisuallyHidden, rovingIndex, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useThreads } from '../stores.tsx';
import { threadStatus } from './status.ts';

export function threadTitle(t: Pick<ThreadView, 'title'>): string {
  return t.title?.trim() || 'Untitled chat';
}

export interface ThreadListProps {
  selectedId: string | null;
  /** Called after a row is opened (closes the phone menu). */
  onOpen?: () => void;
  /** The thread streaming in the open chat view, if any. */
  streamingId?: string | null;
}

export function ThreadList({ selectedId, onOpen, streamingId }: ThreadListProps) {
  const store = useThreads();
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ThreadView | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{
    id: string;
    at: { x: number; y: number } | null;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = showArchived ? (store.archived ?? []) : store.threads;
  const pinned = showArchived ? [] : rows.filter((t) => t.pinned);
  const recent = showArchived ? rows : rows.filter((t) => !t.pinned);
  const ordered = [...pinned, ...recent];
  const current =
    ordered.find((t) => t.id === focusId) ?? ordered.find((t) => t.id === selectedId) ?? ordered[0];

  const act = (label: string, p: Promise<unknown>) =>
    p.catch((err: unknown) => toast.show(`${label}: ${errorMessage(err)}`, { tone: 'error' }));

  const focusRow = (id: string) => {
    setFocusId(id);
    queueMicrotask(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [];
      for (const row of rows)
        if (row.dataset.rowId === id) row.querySelector<HTMLElement>('.thread-link')?.focus();
    });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!current || renaming) return;
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('thread-link')) return;
    const i = ordered.indexOf(current);
    const next = rovingIndex(e.key, i, ordered.length);
    if (next !== null) {
      e.preventDefault();
      focusRow(ordered[next]!.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      setRenaming(current.id);
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      setMenuFor({ id: current.id, at: null });
    }
  };

  const items = (t: ThreadView) => [
    { id: 'rename', label: 'Rename', onSelect: () => setRenaming(t.id) },
    ...(t.archived
      ? []
      : [
          {
            id: 'pin',
            label: t.pinned ? 'Unpin' : 'Pin',
            onSelect: () => void act('Could not pin', store.update(t.id, { pinned: !t.pinned })),
          },
        ]),
    {
      id: 'archive',
      label: t.archived ? 'Unarchive' : 'Archive',
      onSelect: () => {
        void act(
          t.archived ? 'Could not unarchive' : 'Could not archive',
          store.update(t.id, { archived: !t.archived }).then(() => {
            toast.show(t.archived ? 'Chat restored.' : 'Chat archived.', { tone: 'success' });
            if (!t.archived && t.id === selectedId) navigate(chatPath(null));
          }),
        );
      },
    },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: () => setConfirmDelete(t) },
  ];

  const renderRow = (t: ThreadView) => {
    const isCurrent = t.id === current?.id;
    const selected = t.id === selectedId;
    const status = threadStatus(t, t.id === streamingId);
    return (
      <li
        key={t.id}
        className="thread-row"
        data-row-id={t.id}
        data-selected={selected || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          setFocusId(t.id);
          setMenuFor({ id: t.id, at: { x: e.clientX, y: e.clientY } });
        }}
      >
        {renaming === t.id ? (
          <RenameField
            initial={t.title ?? ''}
            onDone={(title) => {
              setRenaming(null);
              focusRow(t.id);
              if (title !== null && title !== (t.title ?? ''))
                void act('Could not rename', store.update(t.id, { title: title || null }));
            }}
          />
        ) : (
          <a
            href={chatPath(t.id)}
            className="thread-link"
            tabIndex={isCurrent ? 0 : -1}
            aria-current={selected ? 'page' : undefined}
            onFocus={() => setFocusId(t.id)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(chatPath(t.id));
              onOpen?.();
            }}
          >
            {t.unread ? <span className="unread-dot" aria-hidden="true" /> : null}
            <span className="thread-title">{threadTitle(t)}</span>
            {t.unread ? <VisuallyHidden>, unread</VisuallyHidden> : null}
            {t.pinned ? <VisuallyHidden>, pinned</VisuallyHidden> : null}
            {status !== 'ready' ? <StatusChip status={status} compact /> : null}
          </a>
        )}
        <Menu
          label={`Actions for ${threadTitle(t)}`}
          trigger={<span aria-hidden="true">⋯</span>}
          items={items(t)}
          open={menuFor?.id === t.id}
          at={menuFor?.id === t.id ? menuFor.at : null}
          onOpenChange={(open) => setMenuFor(open ? { id: t.id, at: null } : null)}
          triggerProps={{ tabIndex: isCurrent ? 0 : -1, className: 'nv-btn thread-more' }}
        />
      </li>
    );
  };

  return (
    <div className="thread-list" ref={listRef} onKeyDown={onListKey}>
      {store.loading ? <p className="muted sidebar-note">Loading chats…</p> : null}
      {store.error ? (
        <p className="sidebar-note" role="alert">
          {store.error}{' '}
          <button type="button" className="link" onClick={() => void store.refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {pinned.length ? (
        <section aria-labelledby="threads-pinned">
          <h3 id="threads-pinned" className="sidebar-heading">
            Pinned
          </h3>
          <ul className="threads">{pinned.map(renderRow)}</ul>
        </section>
      ) : null}
      <section aria-labelledby="threads-recent">
        <h3 id="threads-recent" className="sidebar-heading">
          {showArchived ? 'Archived' : 'Recent'}
        </h3>
        {recent.length ? (
          <ul className="threads">{recent.map(renderRow)}</ul>
        ) : !store.loading ? (
          <p className="muted sidebar-note">
            {showArchived ? 'No archived chats.' : 'No chats yet.'}
          </p>
        ) : null}
      </section>
      <div className="thread-list-footer">
        {!showArchived && store.hasMore ? (
          <button type="button" className="link" onClick={() => void store.loadMore()}>
            Show more
          </button>
        ) : null}
        <button
          type="button"
          className="link"
          aria-pressed={showArchived}
          onClick={() => {
            if (!showArchived) void store.loadArchived();
            setShowArchived(!showArchived);
          }}
        >
          {showArchived ? 'Back to chats' : 'Archived chats'}
        </button>
      </div>
      <Dialog
        open={confirmDelete !== null}
        title="Delete this chat?"
        description={
          confirmDelete
            ? `“${threadTitle(confirmDelete)}” and its messages will be removed from every device. This cannot be undone.`
            : undefined
        }
        onClose={() => setConfirmDelete(null)}
        fallbackFocus={() => document.querySelector<HTMLElement>('.sidebar-new')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const t = confirmDelete;
                setConfirmDelete(null);
                if (!t) return;
                void act(
                  'Could not delete',
                  store.remove(t.id).then(() => {
                    toast.show('Chat deleted.', { tone: 'success' });
                    if (t.id === selectedId) navigate(chatPath(null));
                  }),
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function RenameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (title: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="nv-input thread-rename"
      aria-label="Chat name"
      value={value}
      maxLength={300}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
