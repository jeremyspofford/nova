/** Library → Files: the places Nova keeps things, as a tree.
 *
 *  Folders expand in place; they are never entered, so the path you are
 *  looking at is always the whole path. Double-clicking a FILE opens it on
 *  the right — single click only selects, which is what makes arrow-key
 *  browsing feel like an editor rather than a series of loads.
 *
 *  The three roots are not equivalent and the UI does not pretend they are:
 *  the backend answers every refusal in a sentence and this tab shows that
 *  sentence. Nothing here is a permission check — the buttons that stay
 *  enabled are a convenience, and the server refuses regardless.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardsSkeleton } from '../ui';
import { confirmDiscardFiles, setFilesDirty } from './files/dirty';
import { Row, Tree, nodeKey } from './files/Tree';
import {
  Entry, FileRead, Root, deleteEntry, listDir, listRoots, newFile, newFolder,
  readFile, renameEntry, writeFile,
} from './files/api';
import { Viewer } from './files/Viewer';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Does `path` name the open file, or a FOLDER containing it?
 *
 *  Equality alone was the bug: deleting or renaming an ancestor left the
 *  editor holding a file that no longer existed at that path, with Save
 *  still enabled — so the next save either errored confusingly or wrote the
 *  file back into existence under a folder the operator had just removed.
 *  The root has to be part of the comparison too, or a rename in one root
 *  re-points the editor at a same-named path in another. */
const hits = (open: { root: string; path: string } | null,
              root: string, path: string) =>
  !!open && open.root === root
  && (open.path === path || open.path.startsWith(path + '/'));

export function FilesTab() {
  const [roots, setRoots] = useState<Root[] | null>(null);
  const [kids, setKids] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [openRef, setOpenRef] = useState<{ root: string; path: string } | null>(null);
  const [doc, setDoc] = useState<FileRead | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [status, setStatus] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);
  // A phone cannot show a tree beside an editor: at 390px the two-pane
  // layout left the editor a 102px slit. Below the breakpoint the panes
  // take turns, and a tap opens a file because touch has no double-click.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Publish for LibraryPage's tab buttons and close control, and for a
  // reload; clear on unmount so a stale flag cannot block a later close.
  useEffect(() => { setFilesDirty(dirty); }, [dirty]);
  useEffect(() => () => setFilesDirty(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const loadKids = useCallback(async (root: string, path: string) => {
    const k = nodeKey(root, path);
    setBusy(s => new Set(s).add(k));
    try {
      const entries = await listDir(root, path);
      setKids(m => ({ ...m, [k]: entries }));
    } catch (e) {
      setStatus(msg(e));
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(k); return n; });
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const rs = await listRoots();
        setRoots(rs);
        if (rs.length) {                     // memory open on arrival
          setExpanded(new Set([nodeKey(rs[0].key, '')]));
          await loadKids(rs[0].key, '');
        }
      } catch (e) { setStatus(msg(e)); setRoots([]); }
    })();
  }, [loadKids]);

  const rows = useMemo<Row[]>(() => {
    if (!roots) return [];
    const out: Row[] = [];
    const walk = (root: string, path: string, depth: number) => {
      for (const e of kids[nodeKey(root, path)] ?? []) {
        out.push({ root, path: e.path, name: e.name, dir: e.dir, depth, entry: e });
        if (e.dir && expanded.has(nodeKey(root, e.path))) walk(root, e.path, depth + 1);
      }
    };
    for (const r of roots) {
      out.push({ root: r.key, path: '', name: r.label, dir: true, depth: 0 });
      if (expanded.has(nodeKey(r.key, ''))) walk(r.key, '', 1);
    }
    return out;
  }, [roots, kids, expanded]);

  const sel = useMemo(
    () => rows.find(r => nodeKey(r.root, r.path) === selected) ?? null,
    [rows, selected]);
  const selRoot = useMemo(
    () => roots?.find(r => r.key === sel?.root) ?? null, [roots, sel]);
  const targetDir = sel ? (sel.dir ? sel.path : parentOf(sel.path)) : '';

  const guard = () => confirmDiscardFiles();

  async function toggle(r: Row) {
    const k = nodeKey(r.root, r.path);
    setSelected(k);
    const isOpen = expanded.has(k);
    setExpanded(s => { const n = new Set(s); isOpen ? n.delete(k) : n.add(k); return n; });
    if (!isOpen) await loadKids(r.root, r.path);
  }

  async function open(r: Row) {
    if (!guard()) return;
    setSelected(nodeKey(r.root, r.path));
    setStatus('');
    try {
      const d = await readFile(r.root, r.path);
      setDoc(d);
      setDraft(d.text);
      setDirty(false);
      setOpenRef({ root: r.root, path: r.path });
      setMode(d.editable ? 'edit' : 'preview');
    } catch (e) { setStatus(msg(e)); }
  }

  function closeDoc() {
    if (!guard()) return;
    setOpenRef(null); setDoc(null); setDraft(''); setDirty(false);
  }

  async function refresh(root: string, dir: string) {
    await loadKids(root, dir);
    // the documents root carries a per-kind count on the folder row, so a
    // delete has to recompute the level above it too
    if (root === 'documents') await loadKids(root, '');
  }

  async function save() {
    if (!openRef || !doc) return;
    setSaving(true);
    try {
      const res = await writeFile(openRef.root, openRef.path, draft);
      setDirty(false);
      setDoc({ ...doc, bytes: res.bytes, mtime: res.mtime });
      setStatus('');
      await refresh(openRef.root, parentOf(openRef.path));
    } catch (e) { setStatus(msg(e)); }
    finally { setSaving(false); }
  }

  async function create(kind: 'file' | 'folder') {
    if (!sel) return;
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name');
    if (!name?.trim()) return;
    const path = targetDir ? `${targetDir}/${name.trim()}` : name.trim();
    try {
      if (kind === 'file') await newFile(sel.root, path);
      else await newFolder(sel.root, path);
      setExpanded(s => new Set(s).add(nodeKey(sel.root, targetDir)));
      await loadKids(sel.root, targetDir);
      setSelected(nodeKey(sel.root, path));
      setStatus('');
      if (kind === 'file') {
        await open({ root: sel.root, path, name: name.trim(), dir: false, depth: 0 });
      }
    } catch (e) { setStatus(msg(e)); }
  }

  async function rename() {
    if (!sel || !sel.path) return;
    const to = window.prompt(`Rename "${sel.name}" to`, sel.name);
    if (!to?.trim() || to.trim() === sel.name) return;
    try {
      const res = await renameEntry(sel.root, sel.path, to.trim());
      await loadKids(sel.root, parentOf(sel.path));
      setSelected(nodeKey(sel.root, res.path));
      if (hits(openRef, sel.root, sel.path)) {
        // works for the file itself AND for a renamed folder above it
        const moved = res.path + openRef!.path.slice(sel.path.length);
        setOpenRef({ root: sel.root, path: moved });
        setDoc(d => (d ? { ...d, name: moved.split('/').pop() ?? d.name } : d));
      }
      setStatus('');
    } catch (e) { setStatus(msg(e)); }
  }

  async function remove() {
    if (!sel || !sel.path) return;
    if (!window.confirm(`Delete "${sel.name}"? This cannot be undone.`)) return;
    try {
      await del(false);
    } catch (e) {
      // The backend refuses a non-empty folder with the count in the
      // sentence, so the second ask can say how much is about to go.
      const m = msg(e);
      if (/holds \d+ item/.test(m) && window.confirm(`${m} Delete all of it?`)) {
        try { await del(true); } catch (e2) { setStatus(msg(e2)); }
      } else setStatus(m);
    }

    async function del(recursive: boolean) {
      await deleteEntry(sel!.root, sel!.path, recursive);
      await refresh(sel!.root, parentOf(sel!.path));
      if (hits(openRef, sel!.root, sel!.path)) {
        setOpenRef(null); setDoc(null); setDraft(''); setDirty(false);
      }
      setSelected(null);
      setStatus('');
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!rows.length) return;
    const i = rows.findIndex(r => nodeKey(r.root, r.path) === selected);
    const go = (j: number) => {
      const n = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!n) return;
      setSelected(nodeKey(n.root, n.path));
      treeRef.current
        ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(nodeKey(n.root, n.path))}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i + 1); break;
      case 'ArrowUp': e.preventDefault(); go(i < 0 ? 0 : i - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (sel?.dir && !expanded.has(nodeKey(sel.root, sel.path))) void toggle(sel);
        else go(i + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (sel?.dir && expanded.has(nodeKey(sel.root, sel.path))) void toggle(sel);
        else if (sel) {
          const p = nodeKey(sel.root, parentOf(sel.path));
          if (rows.some(r => nodeKey(r.root, r.path) === p)) setSelected(p);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (sel) void (sel.dir ? toggle(sel) : open(sel));
        break;
    }
  }

  if (!roots) return <CardsSkeleton n={4} />;

  const canWrite = !!selRoot?.writable;
  const btn = 'px-2 py-1 rounded text-[11px] border border-stone-700 text-stone-300 '
    + 'hover:bg-stone-800 disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="flex flex-col h-[62vh] min-h-0 gap-2">
      {status && <div className="text-xs text-red-400 shrink-0">{status}</div>}

      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
        <button className={btn} onClick={() => create('file')}
          disabled={!sel || !canWrite}>New file</button>
        <button className={btn} onClick={() => create('folder')}
          disabled={!sel || !selRoot?.can_mkdir}>New folder</button>
        <button className={btn} onClick={rename}
          disabled={!sel?.path || !canWrite}>Rename</button>
        <button className={btn} onClick={remove}
          disabled={!sel?.path || (!canWrite && selRoot?.key !== 'documents')}>Delete</button>
        {!narrow && (
          <span className="text-[11px] text-stone-500 truncate ml-1">
            {selRoot?.note}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex gap-2">
        {(!narrow || !doc) && (
          <div className={`${narrow ? 'flex-1' : 'w-[15rem] shrink-0'} min-h-0
                           rounded border border-stone-800 bg-stone-900/40`}>
            <Tree
              rows={rows} expanded={expanded} selected={selected} busy={busy}
              tapToOpen={narrow}
              onToggle={toggle} onSelect={r => setSelected(nodeKey(r.root, r.path))}
              onOpen={open} onKeyDown={onKeyDown} treeRef={treeRef}
            />
          </div>
        )}
        {(!narrow || doc) && (
          <div className="flex-1 min-w-0 min-h-0 rounded border border-stone-800
                          bg-stone-900/40 px-3 py-2">
            {doc && openRef ? (
              <Viewer
                root={openRef.root} path={openRef.path} doc={doc} draft={draft}
                dirty={dirty} saving={saving} mode={mode}
                onBack={narrow ? closeDoc : undefined}
                onDraft={s => { setDraft(s); setDirty(true); }}
                onMode={setMode} onSave={save}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-stone-500 px-6 text-center">
                {narrow ? 'Tap a file to open it.' : 'Double-click a file to open it.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
