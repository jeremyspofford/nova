import { useEffect, useState } from 'react';
import {
  AttachmentUsage, StoredAttachment, deleteAttachment, downloadAttachment,
  getAttachment, listAttachments,
} from '../../api';
import { CardsSkeleton } from '../ui';
import { fmtTime } from '../../time';

/** Documents the operator handed Nova, kept (roadmap #22b).
 *
 *  This tab is the answer to "what have I given you?", which was
 *  unanswerable while attachments lived for one turn. It is also where the
 *  bytes are reachable — a photographed letter exists nowhere else, so a
 *  store with no way to get the original back is not a store.
 */

const SOURCE_NOTE: Record<string, string> = {
  mechanical: "read from the document's own text layer — exact",
  ocr: 'read by OCR from a scan or photo — may contain recognition errors',
  vision: 'described by a vision model — a reading, not the document itself',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsTab() {
  const [rows, setRows] = useState<StoredAttachment[]>([]);
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<StoredAttachment | null>(null);

  async function load() {
    try {
      const r = await listAttachments();
      setRows(r.attachments);
      setUsage(r.usage);
    } catch (e) { setStatus(String(e)); }
    setLoaded(true);
  }
  useEffect(() => { void load(); }, []);

  async function remove(a: StoredAttachment) {
    // the bytes may be the only copy in existence — say so, and name it
    if (!window.confirm(
      `Delete "${a.display_name}"? If this is the only copy of the document, `
      + `it cannot be recovered.`)) return;
    try {
      await deleteAttachment(a.id);
      void load();
    } catch (e) { setStatus(String(e)); }
  }

  async function show(a: StoredAttachment) {
    try {
      setOpen(await getAttachment(a.id));   // the list omits text_content
    } catch (e) { setStatus(String(e)); }
  }

  if (!loaded) return <CardsSkeleton n={3} />;

  return (
    <div className="space-y-3">
      {status && <div className="text-xs text-red-400">{status}</div>}

      {usage && !usage.store_ok && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-300">
          Documents cannot be kept right now: {usage.store_error}
        </div>
      )}

      <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
        <div className="text-sm text-stone-300">Documents you have given Nova</div>
        <div className="mt-1 text-xs text-stone-500">
          Attach a file or photo in chat and the original is kept here — before
          the turn runs, so a failed answer can never destroy it. The text is
          extracted once, and how it was read is recorded, because a scan read
          by OCR is not the same claim as a document&apos;s own text layer.
        </div>
        {usage && (
          <div className="mt-2 text-[11px] font-mono text-stone-500">
            {usage.documents} stored · {fmtBytes(usage.bytes)} on disk
            {usage.missing > 0 && (
              <span className="text-amber-400"> · {usage.missing} missing from the store</span>
            )}
            {usage.orphans > 0 && (
              <span className="text-amber-400" title="Bytes on disk that no document row points at — usually the residue of an upload that failed partway.">
                {' '}· {usage.orphans} orphaned ({fmtBytes(usage.orphan_bytes)})
              </span>
            )}
          </div>
        )}
      </div>

      {!rows.length && (
        <div className="text-xs text-stone-500 px-1">
          Nothing yet. Anything you attach in chat from now on is kept.
        </div>
      )}

      {rows.map(a => (
        <div key={a.id} className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm text-stone-100 truncate">{a.display_name}</span>
              <span className="text-[10px] px-1 rounded bg-stone-700 text-stone-400 shrink-0">{a.kind}</span>
              {!a.present && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-red-900 bg-red-950/50 text-red-300 shrink-0"
                  title="The row exists but the bytes are not on disk.">
                  bytes missing
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {a.has_text && (
                <button onClick={() => void show(a)}
                  className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200">
                  text
                </button>
              )}
              <button onClick={() => void downloadAttachment(a)} disabled={!a.present}
                className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-400 hover:text-stone-200 disabled:opacity-40">
                original
              </button>
              <button onClick={() => void remove(a)}
                className="text-xs px-2 py-0.5 rounded border border-stone-600 text-stone-500 hover:text-red-400 hover:border-red-800">
                delete
              </button>
            </div>
          </div>
          <div className="mt-1 text-[11px] font-mono text-stone-500">
            {fmtBytes(a.bytes)} · {a.mime || 'unknown type'} · {fmtTime(a.created_at ?? '')}
            {' · '}<span title="Content hash. Identity is this and a row id — never the filename, because two documents routinely share a name.">
              {a.sha256.slice(0, 8)}
            </span>
          </div>
          {a.text_source && (
            <div className="mt-1 text-[11px] text-stone-500">
              {a.text_chars?.toLocaleString()} characters — {SOURCE_NOTE[a.text_source] ?? a.text_source}
            </div>
          )}
          {a.text_error && (
            <div className="mt-1 text-[11px] text-amber-400/90">
              No text could be read: {a.text_error}
            </div>
          )}
        </div>
      ))}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setOpen(null)}>
          <div className="w-[40rem] max-w-full max-h-[70vh] flex flex-col rounded-xl bg-stone-900 border border-stone-700"
            onClick={e => e.stopPropagation()}>
            <header className="px-4 py-2.5 border-b border-stone-700 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-sm text-stone-100 truncate">{open.display_name}</div>
                {open.text_source && (
                  <div className="text-[11px] text-stone-500">
                    {SOURCE_NOTE[open.text_source] ?? open.text_source}
                  </div>
                )}
              </div>
              <button onClick={() => setOpen(null)}
                className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
            </header>
            <div className="flex-1 overflow-y-auto nice-scroll p-4">
              <pre className="text-xs text-stone-300 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">
                {open.text_content}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
