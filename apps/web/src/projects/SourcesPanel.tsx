// A project's sources (FR-040): upload files (button or drag and drop) or paste text; each source
// shows its indexing status and chunk count, and can be re-indexed or removed. While any source is
// waiting or indexing, the list refreshes every 2 s.
import { useEffect, useRef, useState } from 'react';
import type { SourceStatus, SourceView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { acceptedMime, formatBytes, readAsBase64 } from '../chat/attachments.ts';
import { useServices } from '../services.tsx';
import { plural, useInterval } from '../settings/common.ts';

/** docs/03 FR-040 and the M2 API: at most 20 MB per source. */
export const SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const SOURCE_POLL_MS = 2000;

const STATUS: Record<SourceStatus, { text: string; icon: IconName | null; tone: string }> = {
  pending: { text: 'Waiting to index', icon: null, tone: 'running' },
  indexing: { text: 'Indexing', icon: null, tone: 'running' },
  ready: { text: 'Ready', icon: 'check', tone: 'ready' },
  error: { text: 'Could not index', icon: 'alert', tone: 'blocked' },
};

function SourceStatusChip({ source }: { source: SourceView }) {
  const s = STATUS[source.status];
  return (
    <span className="nv-chip" data-status={s.tone}>
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      <span>{s.text}</span>
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load sources.')),
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
      tooBig.map(
        (f) =>
          `${f.name} is ${formatBytes(f.size)}; a source can be at most ${formatBytes(SOURCE_MAX_BYTES)}.`,
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
        toast.show(`Could not add ${file.name}: ${errorMessage(err)}`, { tone: 'error' });
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added) {
      toast.show(`${plural(added, 'source')} added. Indexing has started.`, { tone: 'success' });
      onChanged?.();
    }
  };

  const reindex = async (s: SourceView) => {
    try {
      upsert(await api.reindexSource(s.id));
    } catch (err) {
      toast.show(`Could not re-index ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = async (s: SourceView) => {
    setRemoving(null);
    try {
      await api.deleteSource(s.id);
      setSources((list) => list?.filter((x) => x.id !== s.id) ?? null);
      toast.show(`${s.name} removed.`, { tone: 'success' });
      onChanged?.();
    } catch (err) {
      toast.show(`Could not remove ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
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
      <h2 id="project-sources">Sources</h2>
      <p className="muted">
        Files and notes that chats in this project can search and cite. Text, Markdown, CSV, JSON
        and code files can be indexed now; other types are kept but not searched yet. Up to{' '}
        {formatBytes(SOURCE_MAX_BYTES)} each.
      </p>
      <div className="ws-dropzone">
        <span className="muted">Drop files here, or</span>
        <Button onClick={() => fileInput.current?.click()}>
          <Icon name="attach" /> Upload files
        </Button>
        <Button onClick={() => setPasting(true)} disabled={pasting}>
          <Icon name="file" /> Paste text
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Upload source files"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
        {uploading > 0 ? <Spinner label={`Uploading ${plural(uploading, 'file')}`} /> : null}
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
              toast.show(`${s.name} added. Indexing has started.`, { tone: 'success' });
              onChanged?.();
            }
          }}
        />
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {sources === null && !error ? <Spinner label="Loading sources" /> : null}
      {sources?.length === 0 ? <p className="muted">No sources yet.</p> : null}
      {sources?.length ? (
        <ul className="ws-list" aria-label="Sources">
          {sources.map((s) => (
            <li key={s.id} className="ws-list-row ws-source" aria-label={s.name}>
              <div className="ws-source-main">
                <strong className="ws-source-name">{s.name}</strong>
                <span className="muted ws-row-meta">
                  {formatBytes(s.size)}
                  {s.status === 'ready' ? ` · ${plural(s.chunkCount, 'chunk')}` : ''}
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
                  Re-index
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(s)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={removing !== null}
        title="Remove this source?"
        description={
          removing
            ? `${removing.name} is removed from the project. Chats stop using it right away.`
            : undefined
        }
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (removing) void remove(removing);
              }}
            >
              Remove
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
      setError(errorMessage(err, 'Could not add the text.'));
      setBusy(false);
    }
  };

  return (
    <form
      className="panel-inset"
      aria-label="Paste text as a source"
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
        label="Source name"
        value={name}
        maxLength={255}
        autoFocus
        placeholder="Meeting notes"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`paste-${projectId}`}>
          Text
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
          {busy ? <Spinner /> : null} Add source
        </Button>
        <Button onClick={() => onDone(null)}>Cancel</Button>
      </div>
    </form>
  );
}
