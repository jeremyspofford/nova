/** The tree half of a file surface: roots, lazily-loaded children, expansion,
 *  selection and the arrow keys.
 *
 *  Lifted out of FilesTab when the Vault became a second consumer. It is the
 *  part of a file browser that is identical everywhere — what differs between
 *  the two surfaces is what OPENING a file does, and that stays with the
 *  caller. `ui.tsx` records the precedent: `fmtBytes` was shared precisely
 *  because two tabs had drifted into two byte-identical copies.
 *
 *  It owns no editor state and never reads a file. `onOpen` is the caller's.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Entry, Root, listDir, listRoots } from './api';
import { Row, nodeKey } from './Tree';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FileTree {
  roots: Root[] | null;
  rows: Row[];
  expanded: Set<string>;
  busy: Set<string>;
  selected: string | null;
  /** The selected row, resolved against the current rows. */
  sel: Row | null;
  /** The root the selection lives in — carries `writable` / `can_mkdir`. */
  selRoot: Root | null;
  /** The folder a New would land in: the selection, or its parent. */
  targetDir: string;
  /** Last error from a list call, as the backend's own sentence. */
  error: string;
  setError: (s: string) => void;
  setSelected: (k: string | null) => void;
  toggle: (r: Row) => Promise<void>;
  /** Re-read one folder — call after create/rename/delete/save. */
  refresh: (root: string, dir: string) => Promise<void>;
  /** Expand every ancestor of `path` and select it, loading as it goes.
   *  The Vault needs this: a deep link or a wikilink click arrives with a
   *  path whose folders were never opened. */
  reveal: (root: string, path: string) => Promise<void>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  treeRef: React.RefObject<HTMLDivElement>;
}

export function useFileTree(onOpen: (r: Row) => void): FileTree {
  const [roots, setRoots] = useState<Root[] | null>(null);
  const [kids, setKids] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);

  // `onOpen` is usually a fresh arrow each render; the ref keeps the keyboard
  // handler from re-creating on every parent render.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const loadKids = useCallback(async (root: string, path: string) => {
    const k = nodeKey(root, path);
    setBusy(s => new Set(s).add(k));
    try {
      const entries = await listDir(root, path);
      setKids(m => ({ ...m, [k]: entries }));
      return entries;
    } catch (e) {
      setError(msg(e));
      return [];
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
      } catch (e) { setError(msg(e)); setRoots([]); }
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

  // `isOpen` is read from the render closure, not from inside the updater:
  // StrictMode invokes updaters twice, so a side effect in there would flip a
  // captured variable back and the load would be skipped.
  const toggle = useCallback(async (r: Row) => {
    const k = nodeKey(r.root, r.path);
    setSelected(k);
    const isOpen = expanded.has(k);
    setExpanded(s => { const n = new Set(s); isOpen ? n.delete(k) : n.add(k); return n; });
    if (!isOpen) await loadKids(r.root, r.path);
  }, [expanded, loadKids]);

  const refresh = useCallback(
    async (root: string, dir: string) => { await loadKids(root, dir); },
    [loadKids]);

  const reveal = useCallback(async (root: string, path: string) => {
    // Walk down from the root so each level's children exist before the next
    // is asked for. `loadKids` returns the entries it fetched, so this does
    // not race the `kids` state it is also writing.
    const parts = path.split('/').filter(Boolean).slice(0, -1);
    const open = [nodeKey(root, '')];
    let dir = '';
    await loadKids(root, '');
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      open.push(nodeKey(root, dir));
      await loadKids(root, dir);
    }
    setExpanded(s => { const n = new Set(s); open.forEach(k => n.add(k)); return n; });
    setSelected(nodeKey(root, path));
  }, [loadKids]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const i = rows.findIndex(r => nodeKey(r.root, r.path) === selected);
    const cur = i >= 0 ? rows[i] : null;
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
        if (cur?.dir && !expanded.has(nodeKey(cur.root, cur.path))) void toggle(cur);
        else go(i + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (cur?.dir && expanded.has(nodeKey(cur.root, cur.path))) void toggle(cur);
        else if (cur) {
          const p = nodeKey(cur.root, parentOf(cur.path));
          if (rows.some(r => nodeKey(r.root, r.path) === p)) setSelected(p);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (cur) { if (cur.dir) void toggle(cur); else openRef.current(cur); }
        break;
    }
  }, [rows, selected, expanded, toggle]);

  return {
    roots, rows, expanded, busy, selected, sel, selRoot, targetDir,
    error, setError, setSelected, toggle, refresh, reveal, onKeyDown, treeRef,
  };
}
