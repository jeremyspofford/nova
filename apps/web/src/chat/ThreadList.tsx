// Chat list (FR-017): Pinned and Recent groups, with rename (inline), pin, memory use (FR-032),
// archive and delete (confirmed) from each row's menu or its context menu, plus the items running
// extensions add (M8). Branches and temporary chats carry a marker (FR-027, FR-033). Rows use a
// roving tabindex so the list is one tab stop: arrows, Home and End move; F2 renames; Shift+F10
// opens the row's menu.
import { useEffect, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ThreadView } from '@nova/shared';
import {
  Button,
  Dialog,
  Icon,
  Menu,
  StatusChip,
  VisuallyHidden,
  rovingIndex,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { menuItemsFor, useRunContributed } from '../extensions/shell.tsx';
import { useExtensionContributions } from '../extensions/store.ts';
import { chatPath, navigate } from '../router.ts';
import { useThreads } from '../stores.tsx';
import { sortByThreadStatus, threadStatus, threadStatusReason } from './status.ts';
import { CHAT_TEXT } from './strings.ts';

export const THREADS_TEXT = defineMessages('chat.threads', {
  rename: 'Rename',
  renameFailed: 'Could not rename: {reason}',
  pin: 'Pin',
  unpin: 'Unpin',
  pinFailed: 'Could not pin: {reason}',
  noMemory: "Don't use for memory",
  memoryFailed: 'Could not change memory use: {reason}',
  archive: 'Archive',
  unarchive: 'Unarchive',
  archiveFailed: 'Could not archive: {reason}',
  unarchiveFailed: 'Could not unarchive: {reason}',
  restored: 'Chat restored.',
  archived: 'Chat archived.',
  delete: 'Delete…',
  branch: 'Branch',
  temporary: 'Temporary chat',
  /** Read after a row's title by screen readers. */
  unreadSuffix: ', unread',
  pinnedSuffix: ', pinned',
  branchSuffix: ', branch',
  temporarySuffix: ', temporary',
  actionsFor: 'Actions for {title}',
  loading: 'Loading chats…',
  retry: 'Retry',
  pinned: 'Pinned',
  recent: 'Recent',
  archivedHeading: 'Archived',
  noArchived: 'No archived chats.',
  none: 'No chats yet.',
  showMore: 'Show more',
  backToChats: 'Back to chats',
  archivedChats: 'Archived chats',
  deleteTitle: 'Delete this chat?',
  deleteBody:
    '“{title}” and its messages will be removed from every device. This cannot be undone.',
  cancel: 'Cancel',
  deleteButton: 'Delete',
  deleteFailed: 'Could not delete: {reason}',
  deleted: 'Chat deleted.',
  chatName: 'Chat name',
});

export function threadTitle(t: Pick<ThreadView, 'title'>): string {
  return t.title?.trim() || CHAT_TEXT.untitled;
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
  // M8: items running extensions add to a chat's menu (FR-117), before Delete.
  const extensions = useExtensionContributions();
  const runExtension = useRunContributed();

  const rows = showArchived ? (store.archived ?? []) : store.threads;
  // Needs input first, then Blocked, Running and Ready, within each group (FR-215).
  const pinned = showArchived
    ? []
    : sortByThreadStatus(
        rows.filter((t) => t.pinned),
        streamingId,
      );
  const recent = sortByThreadStatus(
    showArchived ? rows : rows.filter((t) => !t.pinned),
    streamingId,
  );
  const ordered = [...pinned, ...recent];
  const current =
    ordered.find((t) => t.id === focusId) ?? ordered.find((t) => t.id === selectedId) ?? ordered[0];

  const act = (failed: (p: { reason: string }) => string, p: Promise<unknown>) =>
    p.catch((err: unknown) => toast.show(failed({ reason: errorMessage(err) }), { tone: 'error' }));

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
    { id: 'rename', label: THREADS_TEXT.rename, onSelect: () => setRenaming(t.id) },
    ...(t.archived
      ? []
      : [
          {
            id: 'pin',
            label: t.pinned ? THREADS_TEXT.unpin : THREADS_TEXT.pin,
            onSelect: () =>
              void act(THREADS_TEXT.pinFailed, store.update(t.id, { pinned: !t.pinned })),
          },
        ]),
    ...(t.temporary
      ? []
      : [
          {
            id: 'memory',
            label: THREADS_TEXT.noMemory,
            checked: t.memoryOptOut,
            onSelect: () =>
              void act(
                THREADS_TEXT.memoryFailed,
                store.update(t.id, { memoryOptOut: !t.memoryOptOut }).then(() =>
                  toast.show(t.memoryOptOut ? CHAT_TEXT.memoryOn : CHAT_TEXT.memoryOff, {
                    tone: 'success',
                  }),
                ),
              ),
          },
        ]),
    {
      id: 'archive',
      label: t.archived ? THREADS_TEXT.unarchive : THREADS_TEXT.archive,
      onSelect: () => {
        void act(
          t.archived ? THREADS_TEXT.unarchiveFailed : THREADS_TEXT.archiveFailed,
          store.update(t.id, { archived: !t.archived }).then(() => {
            toast.show(t.archived ? THREADS_TEXT.restored : THREADS_TEXT.archived, {
              tone: 'success',
            });
            if (!t.archived && t.id === selectedId) navigate(chatPath(null));
          }),
        );
      },
    },
    ...menuItemsFor(extensions, 'thread', { threadId: t.id }, runExtension),
    { id: 'delete', label: THREADS_TEXT.delete, danger: true, onSelect: () => setConfirmDelete(t) },
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
                void act(THREADS_TEXT.renameFailed, store.update(t.id, { title: title || null }));
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
            {t.parentThreadId && !t.side ? (
              <span className="thread-mark" title={THREADS_TEXT.branch}>
                <Icon name="branch" />
              </span>
            ) : null}
            {t.temporary ? (
              <span className="thread-mark" data-kind="temporary" title={THREADS_TEXT.temporary}>
                <Icon name="clock" />
              </span>
            ) : null}
            <span className="thread-title" dir="auto">
              {threadTitle(t)}
            </span>
            {t.unread ? <VisuallyHidden>{THREADS_TEXT.unreadSuffix}</VisuallyHidden> : null}
            {t.pinned ? <VisuallyHidden>{THREADS_TEXT.pinnedSuffix}</VisuallyHidden> : null}
            {t.parentThreadId && !t.side ? (
              <VisuallyHidden>{THREADS_TEXT.branchSuffix}</VisuallyHidden>
            ) : null}
            {t.temporary ? <VisuallyHidden>{THREADS_TEXT.temporarySuffix}</VisuallyHidden> : null}
            {status !== 'ready' ? (
              <StatusChip status={status} reason={threadStatusReason(t)} compact />
            ) : null}
          </a>
        )}
        <Menu
          label={THREADS_TEXT.actionsFor({ title: threadTitle(t) })}
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
      {store.loading ? <p className="muted sidebar-note">{THREADS_TEXT.loading}</p> : null}
      {store.error ? (
        <p className="sidebar-note" role="alert">
          {store.error}{' '}
          <button type="button" className="link" onClick={() => void store.refresh()}>
            {THREADS_TEXT.retry}
          </button>
        </p>
      ) : null}
      {pinned.length ? (
        <section aria-labelledby="threads-pinned">
          <h3 id="threads-pinned" className="sidebar-heading">
            {THREADS_TEXT.pinned}
          </h3>
          <ul className="threads">{pinned.map(renderRow)}</ul>
        </section>
      ) : null}
      <section aria-labelledby="threads-recent">
        <h3 id="threads-recent" className="sidebar-heading">
          {showArchived ? THREADS_TEXT.archivedHeading : THREADS_TEXT.recent}
        </h3>
        {recent.length ? (
          <ul className="threads">{recent.map(renderRow)}</ul>
        ) : !store.loading ? (
          <p className="muted sidebar-note">
            {showArchived ? THREADS_TEXT.noArchived : THREADS_TEXT.none}
          </p>
        ) : null}
      </section>
      <div className="thread-list-footer">
        {!showArchived && store.hasMore ? (
          <button type="button" className="link" onClick={() => void store.loadMore()}>
            {THREADS_TEXT.showMore}
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
          {showArchived ? THREADS_TEXT.backToChats : THREADS_TEXT.archivedChats}
        </button>
      </div>
      <Dialog
        open={confirmDelete !== null}
        title={THREADS_TEXT.deleteTitle}
        description={
          confirmDelete ? THREADS_TEXT.deleteBody({ title: threadTitle(confirmDelete) }) : undefined
        }
        onClose={() => setConfirmDelete(null)}
        fallbackFocus={() => document.querySelector<HTMLElement>('.sidebar-new')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>{THREADS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const t = confirmDelete;
                setConfirmDelete(null);
                if (!t) return;
                void act(
                  THREADS_TEXT.deleteFailed,
                  store.remove(t.id).then(() => {
                    toast.show(THREADS_TEXT.deleted, { tone: 'success' });
                    if (t.id === selectedId) navigate(chatPath(null));
                  }),
                );
              }}
            >
              {THREADS_TEXT.deleteButton}
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
      aria-label={THREADS_TEXT.chatName}
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
