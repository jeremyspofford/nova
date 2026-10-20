// A project's sources (FR-040): upload files (button or drag and drop) or paste text; each source
// shows its indexing status and chunk count, and can be re-indexed or removed. While any source is
// waiting or indexing, the list refreshes every 2 s.
import { useEffect, useRef, useState } from 'react';
import type { SourceStatus, SourceView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { acceptedMime, formatBytes, readAsBase64 } from '../chat/attachments.ts';
import { useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';

/** docs/03 FR-040 and the M2 API: at most 20 MB per source. */
export const SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const SOURCE_POLL_MS = 2000;

export const SOURCES_TEXT = defineMessages('projects.sources', {
  status: {
    pending: 'Waiting to index',
    indexing: 'Indexing',
    ready: 'Ready',
    error: 'Could not index',
  },
  loadFailed: 'Could not load sources.',
  tooLarge: '{name} is {size}; a source can be at most {limit}.',
  addFailed: 'Could not add {name}: {reason}',
  added:
    '{n, plural, one {# source added. Indexing has started.} other {# sources added. Indexing has started.}}',
  reindexFailed: 'Could not re-index {name}: {reason}',
  removed: '{name} removed.',
  removeFailed: 'Could not remove {name}: {reason}',
  title: 'Sources',
  intro:
    'Files and notes that chats in this project can search and cite. Text, Markdown, CSV, JSON and code files can be indexed now; other types are kept but not searched yet. Up to {limit} each.',
  dropHere: 'Drop files here, or',
  upload: 'Upload files',
  paste: 'Paste text',
  uploadLabel: 'Upload source files',
  uploading: '{n, plural, one {Uploading # file} other {Uploading # files}}',
  textAdded: '{name} added. Indexing has started.',
  retry: 'Retry',
  loading: 'Loading sources',
  none: 'No sources yet.',
  chunks: '{size} · {n, plural, one {# chunk} other {# chunks}}',
  reindex: 'Re-index',
  remove: 'Remove',
  removeTitle: 'Remove this source?',
  removeBody: '{name} is removed from the project. Chats stop using it right away.',
  cancel: 'Cancel',
  textFailed: 'Could not add the text.',
  pasteForm: 'Paste text as a source',
  name: 'Source name',
  namePlaceholder: 'Meeting notes',
  text: 'Text',
  add: 'Add source',
});

const STATUS: Record<SourceStatus, { icon: IconName | null; tone: string }> = {
  pending: { icon: null, tone: 'running' },
  indexing: { icon: null, tone: 'running' },
  ready: { icon: 'check', tone: 'ready' },
  error: { icon: 'alert', tone: 'blocked' },
};

function SourceStatusChip({ source }: { source: SourceView }) {
  const s = STATUS[source.status];
  return (
    <span className="nv-chip" data-status={s.tone}>
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      <span>{SOURCES_TEXT.status[source.status]}</span>
    </span>
  );
}

export function SourcesPanel({
  projectId,
  onChanged,
}: {
  projectId: string;
  /** Called after a source is added or removed (the project's source count changed). */
  onChanged?: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [uploading, setUploading] = useState(0);
  const [rejected, setRejected] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState<SourceView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api.listSources(projectId).then(
      ({ items }) => {
        if (!alive) return;
        setSources(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, SOURCES_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, version]);

  const busy = sources?.some((s) => s.status === 'pending' || s.status === 'indexing') ?? false;
  useInterval(() => setVersion((v) => v + 1), SOURCE_POLL_MS, busy);

  const upsert = (s: SourceView) =>
    setSources((list) => {
      const l = list ?? [];
      return l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s];
    });

  const addFiles = async (files: readonly File[]) => {
    const tooBig = files.filter((f) => f.size > SOURCE_MAX_BYTES);
    setRejected(
      tooBig.map((f) =>
        SOURCES_TEXT.tooLarge({
          name: f.name,
          size: formatBytes(f.size),
          limit: formatBytes(SOURCE_MAX_BYTES),
        }),
      ),
    );
    const ok = files.filter((f) => f.size <= SOURCE_MAX_BYTES);
    if (!ok.length) return;
    setUploading((n) => n + ok.length);
    let added = 0;
    for (const file of ok) {
      try {
        const data = await readAsBase64(file);
        const mime = acceptedMime(file) ?? (file.type || 'application/octet-stream');
        upsert(await api.addSource(projectId, { kind: 'file', name: file.name, mime, data }));
        added++;
      } catch (err) {
        toast.show(SOURCES_TEXT.addFailed({ name: file.name, reason: errorMessage(err) }), {
          tone: 'error',
        });
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added) {
      toast.show(SOURCES_TEXT.added({ n: added }), { tone: 'success' });
      onChanged?.();
    }
  };

  const reindex = async (s: SourceView) => {
    try {
      upsert(await api.reindexSource(s.id));
    } catch (err) {
      toast.show(SOURCES_TEXT.reindexFailed({ name: s.name, reason: errorMessage(err) }), {
        tone: 'error',
      });
    }
  };

  const remove = async (s: SourceView) => {
    setRemoving(null);
    try {
      await api.deleteSource(s.id);
      setSources((list) => list?.filter((x) => x.id !== s.id) ?? null);
      toast.show(SOURCES_TEXT.removed({ name: s.name }), { tone: 'success' });
      onChanged?.();
    } catch (err) {
      toast.show(SOURCES_TEXT.removeFailed({ name: s.name, reason: errorMessage(err) }), {
        tone: 'error',
      });
    }
  };

  return (
    <section
      className="ws-section ws-sources"
      aria-labelledby="project-sources"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void addFiles(files);
      }}
    >
      <h2 id="project-sources">{SOURCES_TEXT.title}</h2>
      <p className="muted">{SOURCES_TEXT.intro({ limit: formatBytes(SOURCE_MAX_BYTES) })}</p>
      <div className="ws-dropzone">
        <span className="muted">{SOURCES_TEXT.dropHere}</span>
        <Button onClick={() => fileInput.current?.click()}>
          <Icon name="attach" /> {SOURCES_TEXT.upload}
        </Button>
        <Button onClick={() => setPasting(true)} disabled={pasting}>
          <Icon name="file" /> {SOURCES_TEXT.paste}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label={SOURCES_TEXT.uploadLabel}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
        {uploading > 0 ? <Spinner label={SOURCES_TEXT.uploading({ n: uploading })} /> : null}
      </div>
      {rejected.length ? (
        <ul className="ws-rejections" role="alert">
          {rejected.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {pasting ? (
        <PasteSource
          projectId={projectId}
          onDone={(s) => {
            setPasting(false);
            if (s) {
              upsert(s);
              toast.show(SOURCES_TEXT.textAdded({ name: s.name }), { tone: 'success' });
              onChanged?.();
            }
          }}
        />
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{SOURCES_TEXT.retry}</Button>
        </div>
      ) : null}
      {sources === null && !error ? <Spinner label={SOURCES_TEXT.loading} /> : null}
      {sources?.length === 0 ? <p className="muted">{SOURCES_TEXT.none}</p> : null}
      {sources?.length ? (
        <ul className="ws-list" aria-label={SOURCES_TEXT.title}>
          {sources.map((s) => (
            <li key={s.id} className="ws-list-row ws-source" aria-label={s.name}>
              <div className="ws-source-main">
                <strong className="ws-source-name" dir="auto">
                  {s.name}
                </strong>
                <span className="muted ws-row-meta">
                  {s.status === 'ready'
                    ? SOURCES_TEXT.chunks({ size: formatBytes(s.size), n: s.chunkCount })
                    : formatBytes(s.size)}
                </span>
                <SourceStatusChip source={s} />
                {s.status === 'error' && s.error ? (
                  <span className="nv-field-error ws-source-error">{s.error}</span>
                ) : null}
              </div>
              <div className="row">
                <Button
                  variant="ghost"
                  onClick={() => void reindex(s)}
                  disabled={s.status === 'pending' || s.status === 'indexing'}
                >
                  {SOURCES_TEXT.reindex}
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(s)}>
                  {SOURCES_TEXT.remove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={removing !== null}
        title={SOURCES_TEXT.removeTitle}
        description={removing ? SOURCES_TEXT.removeBody({ name: removing.name }) : undefined}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{SOURCES_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (removing) void remove(removing);
              }}
            >
              {SOURCES_TEXT.remove}
            </Button>
          </>
        }
      />
    </section>
  );
}

function PasteSource({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (s: SourceView | null) => void;
}) {
  const { api } = useServices();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== '' && text.trim() !== '';

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.addSource(projectId, { kind: 'text', name: name.trim(), text }));
    } catch (err) {
      setError(errorMessage(err, SOURCES_TEXT.textFailed));
      setBusy(false);
    }
  };

  return (
    <form
      className="panel-inset"
      aria-label={SOURCES_TEXT.pasteForm}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
    >
      <TextField
        label={SOURCES_TEXT.name}
        value={name}
        maxLength={255}
        autoFocus
        placeholder={SOURCES_TEXT.namePlaceholder}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`paste-${projectId}`}>
          {SOURCES_TEXT.text}
        </label>
        <textarea
          id={`paste-${projectId}`}
          className="nv-input ws-textarea"
          rows={6}
          maxLength={2_000_000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? <Spinner /> : null} {SOURCES_TEXT.add}
        </Button>
        <Button onClick={() => onDone(null)}>{SOURCES_TEXT.cancel}</Button>
      </div>
    </form>
  );
}
