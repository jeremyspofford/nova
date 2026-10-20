// Settings → Memory (FR-032, docs/04 §2.7): turn saved memories on or off, review what Nova
// remembers grouped by category, and pin, correct, dismiss or delete each item; add one by hand or
// import an export. Temporary chats never produce memories (the Hub enforces it), and each chat
// can opt out from its own menu. M3 adds the consolidated summary, "Consolidate now" and its
// history, "Remember more / less" per category and the "Reference past chats" switch (FR-204,
// FR-205; MemoryConsolidation.tsx).
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { MemoryItemView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useThreads } from '../stores.tsx';
import { formatWhen } from './common.ts';
import { SwitchField } from './controls.tsx';
import {
  ConsolidationSection,
  PastChatsSwitch,
  TopicControls,
  useMemoryTopics,
} from './MemoryConsolidation.tsx';
import '../workspace.css';

type Status = MemoryItemView['status'];

export const MEMORY_TEXT = defineMessages('settings.memory', {
  /** The group of memories without a category. */
  uncategorized: 'Other',
  loadFailed: 'Could not load memories.',
  undo: 'Undo',
  updateFailed: 'Could not update the memory: {error}',
  deleted: 'Memory deleted.',
  deleteFailed: 'Could not delete the memory: {error}',
  title: 'Memory',
  enabled: 'Use saved memories',
  enabledHint:
    'Nova saves lasting facts from your chats here and uses them in replies. Temporary chats ' +
    'and chats you opt out of are never used.',
  saveFailed: 'Could not save: {error}',
  off:
    'Memory is off. Saved memories are kept for you to review, but they are not used and ' +
    'nothing new is saved.',
  saved: 'Saved memories',
  filter: 'Filter memories',
  show: 'Show',
  inUse: 'In use',
  dismissed: 'Dismissed',
  add: 'Add memory',
  import: 'Import',
  retry: 'Retry',
  loading: 'Loading memories',
  none: 'No memories yet',
  noneDismissed: 'No dismissed memories',
  noneHint:
    'When memory is on, lasting facts from your chats appear here. You can also add one ' +
    'yourself or import an export.',
  noneDismissedHint: 'Memories you dismiss are listed here so you can restore them.',
  noMatch: 'No memories match “{filter}”.',
  added: 'Memory added.',
  deleteTitle: 'Delete this memory?',
  deleteBody: 'It is removed for good. To stop using it but keep it for later, dismiss it instead.',
  cancel: 'Cancel',
  delete: 'Delete',
  source: {
    manual: 'Added by you',
    import: 'Imported',
    consolidation: 'Summarized from your chats',
    ambient: 'From ambient capture',
    chat: 'From a chat',
  },
  corrected: 'Memory corrected.',
  pinned: 'Pinned',
  fromChat: 'From “{title}”',
  updated: 'Updated {when}',
  wasUnpinned: 'Memory unpinned.',
  wasPinned: 'Memory pinned.',
  unpin: 'Unpin',
  pin: 'Pin',
  correct: 'Correct',
  wasDismissed: 'Memory dismissed.',
  dismiss: 'Dismiss',
  wasRestored: 'Memory restored.',
  restore: 'Restore',
  correctForm: 'Correct this memory',
  memory: 'Memory',
  category: 'Category',
  categoryHint: 'Optional, for example Work or Travel.',
  save: 'Save',
  addFailed: 'Could not add the memory.',
  addTitle: 'Add a memory',
  addBody: 'Something Nova should keep in mind in your chats.',
  addPlaceholder: 'I prefer metric units.',
  notJson: 'This is not valid JSON. Check the pasted text, or choose “One per line”.',
  notArray: 'Expected a JSON array of memories, like ["I live in Lisbon"].',
  badEntry: 'Each entry must be text or an object with a "content" field.',
  importFailed: 'Could not import.',
  importTitle: 'Import memories',
  importBody:
    'Paste an export from another assistant or your own list. Memories you already have are ' +
    'skipped.',
  importMore: 'Import more',
  done: 'Done',
  importResult:
    'Imported {imported, plural, one {# memory} other {# memories}}. Skipped {skipped, plural, one {# duplicate} other {# duplicates}}.',
  format: 'Format',
  perLine: 'One per line',
  perLineHint: 'Each line is one memory.',
  json: 'JSON',
  jsonHint: 'An array of text, or of objects with "content" and "category".',
  exportData: 'Export to import',
});
const S = MEMORY_TEXT;

/** Groups by category, named categories A–Z and uncategorized last; item order is kept. */
export function groupMemories(
  items: readonly MemoryItemView[],
): { category: string | null; items: MemoryItemView[] }[] {
  const map = new Map<string | null, MemoryItemView[]>();
  for (const m of items) {
    const key = m.category?.trim() ? m.category.trim() : null;
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return [...map.entries()]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
    .map(([category, list]) => ({ category, items: list }));
}

/** The Hub's order: pinned first, then most recently updated. */
function sortMemories(items: MemoryItemView[]): MemoryItemView[] {
  return [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function MemoryPage() {
  const { api } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const enabled = settings.get('memory.enabled');
  const [status, setStatus] = useState<Status>('active');
  const [items, setItems] = useState<MemoryItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MemoryItemView | null>(null);
  const topics = useMemoryTopics();

  useEffect(() => {
    let alive = true;
    api.listMemory({ status }).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(sortMemories(list));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, status, version]);

  const reload = () => setVersion((v) => v + 1);
  const replace = (m: MemoryItemView) =>
    setItems((list) => {
      const rest = (list ?? []).filter((x) => x.id !== m.id);
      return sortMemories(m.status === status ? [...rest, m] : rest);
    });

  const update = async (
    m: MemoryItemView,
    patch: Parameters<typeof api.updateMemory>[1],
    done?: string,
  ): Promise<boolean> => {
    try {
      const next = await api.updateMemory(m.id, patch);
      replace(next);
      if (done) {
        const undo =
          patch.status !== undefined
            ? { label: S.undo, onClick: () => void update(next, { status: m.status }) }
            : undefined;
        toast.show(done, { tone: 'success', ...(undo ? { action: undo } : {}) });
      }
      return true;
    } catch (err) {
      toast.show(S.updateFailed({ error: errorMessage(err) }), { tone: 'error' });
      return false;
    }
  };

  const remove = async (m: MemoryItemView) => {
    setDeleting(null);
    try {
      await api.deleteMemory(m.id);
      setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
      toast.show(S.deleted, { tone: 'success' });
    } catch (err) {
      toast.show(S.deleteFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (m) => !q || `${m.content} ${m.category ?? ''}`.toLowerCase().includes(q),
  );
  const groups = groupMemories(shown);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section">
        <SwitchField
          label={S.enabled}
          description={S.enabledHint}
          checked={enabled.value}
          locked={enabled.locked}
          onChange={(v) =>
            void settings
              .set('memory.enabled', v)
              .catch((err: unknown) =>
                toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
              )
          }
        />
        {!enabled.value ? (
          <p className="muted" role="status">
            {S.off}
          </p>
        ) : null}
        <PastChatsSwitch />
      </section>
      <ConsolidationSection />
      <section className="settings-section" aria-labelledby="memory-items">
        <h3 id="memory-items">{S.saved}</h3>
        <div className="ws-toolbar">
          <TextField
            label={S.filter}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <SelectField
            label={S.show}
            value={status}
            onChange={(v) => {
              setStatus(v as Status);
              setEditing(null);
            }}
            options={[
              { value: 'active', label: S.inUse },
              { value: 'dismissed', label: S.dismissed },
            ]}
          />
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> {S.add}
          </Button>
          <Button onClick={() => setImporting(true)}>{S.import}</Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>{S.retry}</Button>
          </div>
        ) : null}
        {items === null && !error ? <Spinner label={S.loading} /> : null}
        {items?.length === 0 ? (
          <EmptyState
            level={3}
            title={status === 'active' ? S.none : S.noneDismissed}
            description={status === 'active' ? S.noneHint : S.noneDismissedHint}
          />
        ) : null}
        {items?.length && shown.length === 0 ? (
          <p className="muted">{S.noMatch({ filter: filter.trim() })}</p>
        ) : null}
        {groups.map((g) => (
          <section
            key={g.category ?? '\u0000'}
            className="ws-memory-group"
            aria-label={g.category ?? S.uncategorized}
          >
            <div className="ws-group-head">
              <h4 dir="auto">{g.category ?? S.uncategorized}</h4>
              {g.category ? (
                <TopicControls
                  topic={g.category}
                  preference={topics.preference(g.category)}
                  onSet={(p) => g.category && topics.set(g.category, p)}
                />
              ) : null}
            </div>
            <ul className="ws-list">
              {g.items.map((m) => (
                <MemoryRow
                  key={m.id}
                  item={m}
                  editing={editing === m.id}
                  onEdit={() => setEditing(m.id)}
                  onEditDone={() => setEditing(null)}
                  onUpdate={update}
                  onDelete={() => setDeleting(m)}
                />
              ))}
            </ul>
          </section>
        ))}
      </section>

      <AddMemoryDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(m) => {
          setAdding(false);
          if (status === 'active') setItems((list) => sortMemories([m, ...(list ?? [])]));
          toast.show(S.added, { tone: 'success' });
        }}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={reload} />
      <Dialog
        open={deleting !== null}
        title={S.deleteTitle}
        description={S.deleteBody}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              {S.delete}
            </Button>
          </>
        }
      >
        {deleting ? (
          <p className="ws-quote" dir="auto">
            {deleting.content}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

function sourceText(m: MemoryItemView): string {
  return S.source[m.sourceKind];
}

function MemoryRow({
  item,
  editing,
  onEdit,
  onEditDone,
  onUpdate,
  onDelete,
}: {
  item: MemoryItemView;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onUpdate: (
    m: MemoryItemView,
    patch: { content?: string; pinned?: boolean; status?: Status; category?: string | null },
    done?: string,
  ) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { threads } = useThreads();
  const source = item.sourceThreadId ? threads.find((t) => t.id === item.sourceThreadId) : null;
  const correct = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // The Correct button is re-created when editing ends; focus it once it exists.
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    correct.current?.focus();
  }, [editing]);
  const label = item.content.length > 60 ? `${item.content.slice(0, 57)}…` : item.content;

  return (
    <li className="ws-list-row ws-memory" aria-label={label}>
      {editing ? (
        <CorrectForm
          item={item}
          onDone={(patch) => {
            const finish = () => {
              refocus.current = true;
              onEditDone();
            };
            if (!patch) finish();
            else void onUpdate(item, patch, S.corrected).then((ok) => ok && finish());
          }}
        />
      ) : (
        <div className="ws-memory-main">
          <p className="ws-memory-content" dir="auto">
            {item.content}
          </p>
          <span className="muted ws-row-meta">
            {item.pinned ? (
              <span className="ws-badge">
                <Icon name="pin" /> {S.pinned}
              </span>
            ) : null}
            {item.sourceThreadId ? (
              <a
                href={chatPath(item.sourceThreadId, item.sourceMessageId ?? undefined)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(chatPath(item.sourceThreadId, item.sourceMessageId ?? undefined));
                }}
              >
                {source?.title ? S.fromChat({ title: source.title }) : sourceText(item)}
              </a>
            ) : (
              <span>{sourceText(item)}</span>
            )}
            <span>{S.updated({ when: formatWhen(item.updatedAt) })}</span>
          </span>
        </div>
      )}
      {!editing ? (
        <div className="row ws-row-actions">
          <Button
            variant="ghost"
            onClick={() =>
              void onUpdate(
                item,
                { pinned: !item.pinned },
                item.pinned ? S.wasUnpinned : S.wasPinned,
              )
            }
          >
            {item.pinned ? S.unpin : S.pin}
          </Button>
          <Button ref={correct} variant="ghost" onClick={onEdit}>
            {S.correct}
          </Button>
          {item.status === 'active' ? (
            <Button
              variant="ghost"
              onClick={() => void onUpdate(item, { status: 'dismissed' }, S.wasDismissed)}
            >
              {S.dismiss}
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => void onUpdate(item, { status: 'active' }, S.wasRestored)}
            >
              {S.restore}
            </Button>
          )}
          <Button variant="ghost" onClick={onDelete}>
            {S.delete}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function CorrectForm({
  item,
  onDone,
}: {
  item: MemoryItemView;
  onDone: (patch: { content?: string; category?: string | null } | null) => void;
}) {
  const id = `mc${useId()}`;
  const [content, setContent] = useState(item.content);
  const [category, setCategory] = useState(item.category ?? '');
  const patch: { content?: string; category?: string | null } = {};
  if (content.trim() !== item.content) patch.content = content.trim();
  if ((category.trim() || null) !== (item.category ?? null))
    patch.category = category.trim() || null;
  const changed = Object.keys(patch).length > 0;

  return (
    <form
      className="stack ws-memory-edit"
      aria-label={S.correctForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (content.trim()) onDone(changed ? patch : null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone(null);
        }
      }}
    >
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`${id}-content`}>
          {S.memory}
        </label>
        <textarea
          id={`${id}-content`}
          className="nv-input ws-textarea"
          dir="auto"
          rows={2}
          maxLength={2000}
          autoFocus
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <TextField
        label={S.category}
        value={category}
        maxLength={60}
        hint={S.categoryHint}
        onChange={(e) => setCategory(e.target.value)}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={!content.trim()}>
          {S.save}
        </Button>
        <Button onClick={() => onDone(null)}>{S.cancel}</Button>
      </div>
    </form>
  );
}

function AddMemoryDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (m: MemoryItemView) => void;
}) {
  return open ? <AddMemoryForm onClose={onClose} onAdded={onAdded} /> : null;
}

function AddMemoryForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (m: MemoryItemView) => void;
}) {
  const { api } = useServices();
  const id = `ma${useId()}`;
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await api.createMemory({
          content: content.trim(),
          ...(category.trim() ? { category: category.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(errorMessage(err, S.addFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.addTitle}
      description={S.addBody}
      onClose={onClose}
      initialFocusRef={contentRef}
    >
      <form
        id={id}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${id}-content`}>
            {S.memory}
          </label>
          <textarea
            ref={contentRef}
            id={`${id}-content`}
            className="nv-input ws-textarea"
            dir="auto"
            rows={3}
            maxLength={2000}
            placeholder={S.addPlaceholder}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        <TextField
          label={S.category}
          value={category}
          maxLength={60}
          hint={S.categoryHint}
          onChange={(e) => setCategory(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !content.trim()}>
            {busy ? <Spinner /> : null} {S.add}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  return open ? <ImportForm onClose={onClose} onImported={onImported} /> : null;
}

/** Client-side check of a JSON export, so a typo is reported before anything is sent. */
export function checkMemoryJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return S.notJson;
  }
  if (!Array.isArray(parsed)) return S.notArray;
  const ok = parsed.every(
    (x) =>
      typeof x === 'string' ||
      (typeof x === 'object' &&
        x !== null &&
        typeof (x as { content?: unknown }).content === 'string'),
  );
  return ok ? null : S.badEntry;
}

function ImportForm({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { api } = useServices();
  const id = `mi${useId()}`;
  const [format, setFormat] = useState<'text' | 'json'>('text');
  const [data, setData] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  const submit = async () => {
    if (!data.trim() || busy) return;
    const invalid = format === 'json' ? checkMemoryJson(data) : null;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.importMemory({ format, data });
      setResult(r);
      setData('');
      onImported();
    } catch (err) {
      setError(errorMessage(err, S.importFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.importTitle}
      description={S.importBody}
      onClose={onClose}
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>{S.importMore}</Button>
            <Button variant="primary" onClick={onClose}>
              {S.done}
            </Button>
          </>
        ) : undefined
      }
    >
      {result ? (
        <p role="status" className="ws-import-result">
          {S.importResult({ imported: result.imported, skipped: result.skipped })}
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <RadioGroup
            legend={S.format}
            name={`${id}-format`}
            value={format}
            onChange={(v) => {
              setFormat(v as 'text' | 'json');
              setError(null);
            }}
            options={[
              { value: 'text', label: S.perLine, description: S.perLineHint },
              { value: 'json', label: S.json, description: S.jsonHint },
            ]}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-data`}>
              {S.exportData}
            </label>
            <textarea
              id={`${id}-data`}
              className="nv-input ws-textarea"
              rows={8}
              maxLength={1_000_000}
              value={data}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setData(e.target.value);
                setError(null);
              }}
            />
          </div>
          {error ? (
            <p className="nv-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{S.cancel}</Button>
            <Button type="submit" variant="primary" disabled={busy || !data.trim()}>
              {busy ? <Spinner /> : null} {S.import}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
