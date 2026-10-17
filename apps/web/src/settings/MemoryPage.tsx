// Settings → Memory (FR-032, docs/04 §2.7): turn saved memories on or off, review what Nova
// remembers grouped by category, and pin, correct, dismiss or delete each item; add one by hand or
// import an export. Temporary chats never produce memories (the Hub enforces it), and each chat
// can opt out from its own menu. M3 adds the consolidated summary, "Consolidate now" and its
// history, "Remember more / less" per category and the "Reference past chats" switch (FR-204,
// FR-205; MemoryConsolidation.tsx).
import { useEffect, useId, useRef, useState } from 'react';
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
import { formatWhen, plural } from './common.ts';
import { SwitchField } from './controls.tsx';
import {
  ConsolidationSection,
  PastChatsSwitch,
  TopicControls,
  useMemoryTopics,
} from './MemoryConsolidation.tsx';
import '../workspace.css';

type Status = MemoryItemView['status'];

export const UNCATEGORIZED = 'Other';

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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load memories.')),
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
            ? { label: 'Undo', onClick: () => void update(next, { status: m.status }) }
            : undefined;
        toast.show(done, { tone: 'success', ...(undo ? { action: undo } : {}) });
      }
      return true;
    } catch (err) {
      toast.show(`Could not update the memory: ${errorMessage(err)}`, { tone: 'error' });
      return false;
    }
  };

  const remove = async (m: MemoryItemView) => {
    setDeleting(null);
    try {
      await api.deleteMemory(m.id);
      setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
      toast.show('Memory deleted.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not delete the memory: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (m) => !q || `${m.content} ${m.category ?? ''}`.toLowerCase().includes(q),
  );
  const groups = groupMemories(shown);

  return (
    <div className="settings-page">
      <h2>Memory</h2>
      <section className="settings-section">
        <SwitchField
          label="Use saved memories"
          description="Nova saves lasting facts from your chats here and uses them in replies. Temporary chats and chats you opt out of are never used."
          checked={enabled.value}
          locked={enabled.locked}
          onChange={(v) =>
            void settings
              .set('memory.enabled', v)
              .catch((err: unknown) =>
                toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
              )
          }
        />
        {!enabled.value ? (
          <p className="muted" role="status">
            Memory is off. Saved memories are kept for you to review, but they are not used and
            nothing new is saved.
          </p>
        ) : null}
        <PastChatsSwitch />
      </section>
      <ConsolidationSection />
      <section className="settings-section" aria-labelledby="memory-items">
        <h3 id="memory-items">Saved memories</h3>
        <div className="ws-toolbar">
          <TextField
            label="Filter memories"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <SelectField
            label="Show"
            value={status}
            onChange={(v) => {
              setStatus(v as Status);
              setEditing(null);
            }}
            options={[
              { value: 'active', label: 'In use' },
              { value: 'dismissed', label: 'Dismissed' },
            ]}
          />
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add memory
          </Button>
          <Button onClick={() => setImporting(true)}>Import</Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>Retry</Button>
          </div>
        ) : null}
        {items === null && !error ? <Spinner label="Loading memories" /> : null}
        {items?.length === 0 ? (
          <EmptyState
            level={3}
            title={status === 'active' ? 'No memories yet' : 'No dismissed memories'}
            description={
              status === 'active'
                ? 'When memory is on, lasting facts from your chats appear here. You can also add one yourself or import an export.'
                : 'Memories you dismiss are listed here so you can restore them.'
            }
          />
        ) : null}
        {items?.length && shown.length === 0 ? (
          <p className="muted">No memories match “{filter.trim()}”.</p>
        ) : null}
        {groups.map((g) => (
          <section
            key={g.category ?? '\u0000'}
            className="ws-memory-group"
            aria-label={g.category ?? UNCATEGORIZED}
          >
            <div className="ws-group-head">
              <h4>{g.category ?? UNCATEGORIZED}</h4>
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
          toast.show('Memory added.', { tone: 'success' });
        }}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={reload} />
      <Dialog
        open={deleting !== null}
        title="Delete this memory?"
        description="It is removed for good. To stop using it but keep it for later, dismiss it instead."
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
            </Button>
          </>
        }
      >
        {deleting ? <p className="ws-quote">{deleting.content}</p> : null}
      </Dialog>
    </div>
  );
}

function sourceText(m: MemoryItemView): string {
  switch (m.sourceKind) {
    case 'manual':
      return 'Added by you';
    case 'import':
      return 'Imported';
    case 'consolidation':
      return 'Summarized from your chats';
    case 'ambient':
      return 'From ambient capture';
    case 'chat':
      return 'From a chat';
  }
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
            else void onUpdate(item, patch, 'Memory corrected.').then((ok) => ok && finish());
          }}
        />
      ) : (
        <div className="ws-memory-main">
          <p className="ws-memory-content">{item.content}</p>
          <span className="muted ws-row-meta">
            {item.pinned ? (
              <span className="ws-badge">
                <Icon name="pin" /> Pinned
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
                {source?.title ? `From “${source.title}”` : sourceText(item)}
              </a>
            ) : (
              <span>{sourceText(item)}</span>
            )}
            <span>Updated {formatWhen(item.updatedAt)}</span>
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
                item.pinned ? 'Memory unpinned.' : 'Memory pinned.',
              )
            }
          >
            {item.pinned ? 'Unpin' : 'Pin'}
          </Button>
          <Button ref={correct} variant="ghost" onClick={onEdit}>
            Correct
          </Button>
          {item.status === 'active' ? (
            <Button
              variant="ghost"
              onClick={() => void onUpdate(item, { status: 'dismissed' }, 'Memory dismissed.')}
            >
              Dismiss
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => void onUpdate(item, { status: 'active' }, 'Memory restored.')}
            >
              Restore
            </Button>
          )}
          <Button variant="ghost" onClick={onDelete}>
            Delete
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
      aria-label="Correct this memory"
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
          Memory
        </label>
        <textarea
          id={`${id}-content`}
          className="nv-input ws-textarea"
          rows={2}
          maxLength={2000}
          autoFocus
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <TextField
        label="Category"
        value={category}
        maxLength={60}
        hint="Optional, for example Work or Travel."
        onChange={(e) => setCategory(e.target.value)}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={!content.trim()}>
          Save
        </Button>
        <Button onClick={() => onDone(null)}>Cancel</Button>
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
      setError(errorMessage(err, 'Could not add the memory.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Add a memory"
      description="Something Nova should keep in mind in your chats."
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
            Memory
          </label>
          <textarea
            ref={contentRef}
            id={`${id}-content`}
            className="nv-input ws-textarea"
            rows={3}
            maxLength={2000}
            placeholder="I prefer metric units."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        <TextField
          label="Category"
          value={category}
          maxLength={60}
          hint="Optional, for example Work or Travel."
          onChange={(e) => setCategory(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !content.trim()}>
            {busy ? <Spinner /> : null} Add memory
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
    return 'This is not valid JSON. Check the pasted text, or choose “One per line”.';
  }
  if (!Array.isArray(parsed))
    return 'Expected a JSON array of memories, like ["I live in Lisbon"].';
  const ok = parsed.every(
    (x) =>
      typeof x === 'string' ||
      (typeof x === 'object' &&
        x !== null &&
        typeof (x as { content?: unknown }).content === 'string'),
  );
  return ok ? null : 'Each entry must be text or an object with a "content" field.';
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
      setError(errorMessage(err, 'Could not import.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Import memories"
      description="Paste an export from another assistant or your own list. Memories you already have are skipped."
      onClose={onClose}
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>Import more</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : undefined
      }
    >
      {result ? (
        <p role="status" className="ws-import-result">
          Imported {plural(result.imported, 'memory', 'memories')}. Skipped{' '}
          {plural(result.skipped, 'duplicate')}.
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
            legend="Format"
            name={`${id}-format`}
            value={format}
            onChange={(v) => {
              setFormat(v as 'text' | 'json');
              setError(null);
            }}
            options={[
              { value: 'text', label: 'One per line', description: 'Each line is one memory.' },
              {
                value: 'json',
                label: 'JSON',
                description: 'An array of text, or of objects with "content" and "category".',
              },
            ]}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-data`}>
              Export to import
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
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !data.trim()}>
              {busy ? <Spinner /> : null} Import
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
